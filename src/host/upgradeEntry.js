/**
 * `upgradeEntry.js` — **独立可安装的升级入口插件**（Lead 第 21 回合 item 5）。
 *
 * ## 为什么需要它
 *
 * `upgradeBundle.js` 只在源码里；运行中的旧进程没有加载它。要让**已运行的旧进程**
 * 在不重启、不整棵重载 workbench 的前提下被触发一次有界热升级，需要在 profile 的
 * `cordis.patch.yml` 增加**一个独立插件行**指向本文件。它：
 *
 * - 通过 `inject: ['teamWorkbench','tools','webServer']` 拿到**已存在的旧 service**；
 * - 动态 `import('./upgradeBundle.js')` 构造 controller（复用旧 service 对象/队列/identity）；
 * - 注册**自身路由**（`/plan` 只读、`/activate` 需 confirm）：旧 `/op` 不认识 upgrade，故独立路由；
 * - 返回 disposer 解绑路由（不 dispose 原 service/scheduler，不整棵 HMR 重载）；
 * - `config.autoActivate` 默认 **false**（绝不自动激活）。
 *
 * 安全边界：只操作已存在 service 实例与 sidecar；不 push 冻结 `storage.tables`；
 * 不 dispose 原 service/scheduler；不改 `app.asar`、不改 profile。
 */

import { prepareVersionGraph, verifyVersionMarker } from './versionGraph.js';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'team-workbench-upgrade-entry';

/** 缺任一服务都不静默：apply 内明确诊断并降级为只读不可用。 */
export const inject = ['teamWorkbench', 'tools', 'webServer'];

const BASE = '/plugin/team-workbench-upgrade';
/** 版本化生产路由（routeMode='versioned' 时热升级后由本入口挂载；客户端可发现/可达 client-ack）。 */
const VERSIONED_BASE = '/plugin/team-workbench-v2';
const VERSIONED_ROUTES = [`${VERSIONED_BASE}/state`, `${VERSIONED_BASE}/state/detail`, `${VERSIONED_BASE}/layout`, `${VERSIONED_BASE}/op`, `${VERSIONED_BASE}/health`];
const MARKER = 'x-team-workbench';

function json(res, status, payload) {
  try {
    res.statusCode = status;
    if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  } catch {
    /* 宿主连接已关闭 */
  }
}

function admitted(req) {
  const headers = req?.headers ?? {};
  if (headers[MARKER] === undefined) return { ok: false, code: 'MISSING_CLIENT_MARKER' };
  const origin = headers.origin;
  const host = headers.host;
  if (typeof origin === 'string' && origin !== 'null' && typeof host === 'string') {
    try {
      if (new URL(origin).host !== host) return { ok: false, code: 'CROSS_ORIGIN_REJECTED' };
    } catch {
      return { ok: false, code: 'CROSS_ORIGIN_REJECTED' };
    }
  }
  return { ok: true };
}

async function readBody(req, maxBytes = 64 * 1024) {
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return { ok: true, value: {} };
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) return { ok: false, code: 'PAYLOAD_TOO_LARGE' };
    chunks.push(chunk);
  }
  if (chunks.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true, value } : { ok: false, code: 'INVALID_BODY' };
  } catch {
    return { ok: false, code: 'INVALID_JSON' };
  }
}

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文
 * @param {{ autoActivate?: boolean, installableEntry?: string, skillsUpgradeEntry?: string, skillsMigrate?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  const disposers = [];
  const diagnostics = [];
  const record = (code, message) => {
    diagnostics.push({ at: Date.now(), code, message });
    try {
      ctx.logger?.info?.(`[${name}] ${code}: ${message}`);
    } catch {
      /* 日志不可用 */
    }
  };

  // 依赖缺失：明确诊断，路由仍注册但一律返回 503（不静默成功）。
  const services = {
    teamWorkbench: typeof ctx.get === 'function' ? ctx.get('teamWorkbench') : undefined,
    tools: typeof ctx.get === 'function' ? ctx.get('tools') : undefined,
    webServer: typeof ctx.get === 'function' ? ctx.get('webServer') : undefined,
  };
  const missing = Object.entries(services).filter(([, value]) => value === undefined).map(([key]) => key);
  for (const key of missing) record('UPGRADE_ENTRY_SERVICE_MISSING', `缺少服务 ${key}：入口只注册诊断，不会激活。`);

  const runtime = {
    controller: null,
    loading: null,
    plan: null,
    lastResult: null,
    activateCount: 0,
  };

  async function ensureController(options = {}) {
    const forActivate = options.forActivate === true;
    const slot = forActivate ? 'controller' : 'planController';
    if (runtime[slot]) return runtime[slot];
    const loadingKey = forActivate ? 'loadingActivate' : 'loadingPlan';
    if (runtime[loadingKey]) return runtime[loadingKey];
    runtime[loadingKey] = (async () => {
      const service = services.teamWorkbench;
      if (!service) return null;
      // 1) **独立版本化模块图**：程序化复制最新源码 → versions/<hash>/，从副本加载（避免旧 ESM cache）。
      const graph = await prepareVersionGraph();
      if (!graph.ok) throw Object.assign(new Error(`版本模块图准备失败：${graph.code}`), { code: graph.code ?? 'VERSION_GRAPH_FAILED' });
      const marker = await verifyVersionMarker(graph.versionDir, graph.hash);
      if (!marker.ok) throw Object.assign(new Error(`版本标记校验失败：${marker.code}`), { code: marker.code ?? 'VERSION_MARKER_FAILED' });
      runtime.graph = { versionDir: graph.versionDir, hash: graph.hash, reuse: graph.reused === true, files: graph.files ?? 0, marker: marker.marker };
      // 副本目录的 ESM URL（带 query 防缓存）
      const copyBundleUrl = `${graph.upgradeBundleUrl}?twb-bundle=${Date.now()}`;
      const copyIndexUrl = `${graph.indexUrl}?twb-index=${Date.now()}`;
      const module = await import(copyBundleUrl);
      const graphIndex = await import(copyIndexUrl);
      // index.js 只是 import 了 tools/web 的注册函数、未作为 export 暴露；直接从副本模块取真实注册函数。
      const graphToolsUrl = `${pathToFileURL(path.join(graph.versionDir, 'src', 'host', 'tools.js')).href}?twb-tools=${Date.now()}`;
      const graphWebUrl = `${pathToFileURL(path.join(graph.versionDir, 'src', 'host', 'web.js')).href}?twb-web=${Date.now()}`;
      const graphTools = await import(graphToolsUrl);
      const graphWeb = await import(graphWebUrl);
      const registerToolsFn = typeof graphTools.registerTools === 'function' ? graphTools.registerTools : (typeof graphIndex.registerTools === 'function' ? graphIndex.registerTools : null);
      const registerWebRoutesFn = typeof graphWeb.registerWebRoutes === 'function' ? graphWeb.registerWebRoutes : (typeof graphIndex.registerWebRoutes === 'function' ? graphIndex.registerWebRoutes : null);
      if (typeof registerToolsFn !== 'function' || typeof registerWebRoutesFn !== 'function') {
        throw Object.assign(new Error('副本模块图缺少 registerTools/registerWebRoutes 真实导出'), { code: 'UPGRADE_DEPENDENCIES_MISSING' });
      }
      // 2) **真实 adapter + 真实 registrars 全部来自副本模块图**（新代码，避免旧 ESM cache）。
      const adapterUrl = `${pathToFileURL(path.join(graph.versionDir, 'src', 'host', 'adapter.js')).href}?twb-adapter=${Date.now()}`;
      const graphAdapterModule = await import(adapterUrl);
      const freshAdapter = typeof graphAdapterModule.createAdapter === 'function' ? graphAdapterModule.createAdapter(ctx) : null;
      if (!freshAdapter) throw Object.assign(new Error('副本模块图缺少 createAdapter'), { code: 'VERSION_GRAPH_ADAPTER_MISSING' });
      // 旧 adapter 身份/引用保留（其他代码持有它），但**补齐新能力**（executeTool/nativeExecuteAvailable/readFile* 等）；
      // 注意：/plan 不得触发增强（只读）；只有 activate 路径才执行一次。
      // 新增方法从新 adapter 取，旧方法保持旧引用；记录来源与补齐清单供 postcondition/回读。
      // **/plan 只读**：不增强旧 adapter、不改任何对象；只有 activate 路径才执行补齐。
      const oldAdapter = service.adapter ?? null;
      const augmented = [];
      const realAdapter = oldAdapter || freshAdapter;
      if (forActivate && oldAdapter) {
        for (const key of Object.keys(freshAdapter)) {
          if (typeof freshAdapter[key] !== 'function') continue;
          if (typeof oldAdapter[key] === 'function') continue;
          try { oldAdapter[key] = freshAdapter[key].bind(freshAdapter); augmented.push(key); } catch { /* 只读属性跳过 */ }
        }
        // 适配器增强属于升级事务：控制器失败/后置条件失败 → 删除补齐的方法，恢复原 adapter 能力面。
        runtime.adapterRollback = async () => {
          let removed = 0;
          for (const key of augmented) {
            try { delete oldAdapter[key]; removed += 1; } catch { /* 只读属性 */ }
          }
          return { ok: removed === augmented.length, removed, augmented };
        };
      }
      runtime.adapter = forActivate
        ? { source: oldAdapter ? 'service.adapter+augmented' : 'graph.createAdapter', augmented, verified: ['executeTool', 'nativeExecuteAvailable', 'readFileInfo', 'readFileRange', 'hasTool', 'listToolNames', 'registerWebRoute', 'on'].every((key) => typeof realAdapter?.[key] === 'function') }
        : { source: oldAdapter ? 'service.adapter' : 'graph.createAdapter', augmented: [], verified: true, readOnly: true };
      if (forActivate && !runtime.adapter.verified) throw Object.assign(new Error('adapter 新能力未装载完整（executeTool/nativeExecuteAvailable/readFile*/hasTool 等）'), { code: 'ADAPTER_CAPABILITIES_MISSING', detail: runtime.adapter });
      runtime.registrars = {
        source: service.adapter ? 'service.adapter' : 'createAdapter(ctx)',
        registerTools: typeof registerToolsFn === 'function',
        registerWebRoutes: typeof registerWebRoutesFn === 'function',
        startContextHooks: typeof graphIndex.startContextHooks === 'function',
        startUsageIngest: typeof graphIndex.startUsageIngest === 'function',
      };
      // 版本化生产路由（routeMode='versioned'）：激活成功后由本入口挂载 state/detail/op/health，
      // 否则旧 /state、/op 已被旧 bundle 占用、新 detail/client-ack 路由不可达。
      runtime.registerWebRoutesFn = registerWebRoutesFn;
      runtime.realAdapter = realAdapter;
      const remediation = { ...(service.config?.remediation ?? {}), ...(config.remediation ?? {}), routeMode: 'versioned' };
      // Only provided fields override the running service configuration. A missing
      // optional integration never enables migration or erases an explicit path.
      for (const key of ['skillsMigrate', 'skillsUpgradeEntry', 'skillsSourceRoot', 'skillsPatchPath', 'skillsVersionTarget', 'skillsExpectedCount', 'installableEntry']) {
        if (config[key] !== undefined) remediation[key] = config[key];
        if (options[key] !== undefined) remediation[key] = options[key];
      }
      remediation.skillsMigrate = remediation.skillsMigrate === true;
      remediation.installableEntry ||= graph.indexUrl;
      runtime[slot] = module.createUpgradeBundle({
        ctx,
        adapter: realAdapter,
        storage: service.storage,
        config: { ...(service.config ?? {}), remediation },
        service,
        scheduler: service.__scheduler ?? null,
        clock: service.clock,
        // 真实 registrar 全部来自**副本模块图**（新代码），不传桩。
        registerTools: (deps) => registerToolsFn(deps),
        registerWebRoutes: (deps) => registerWebRoutesFn(deps),
        startContextHooks: graphIndex.startContextHooks,
        startUsageIngest: graphIndex.startUsageIngest,
        rollbackAdapter: forActivate ? runtime.adapterRollback : null,
        // 版本化路由属于激活事务：由控制器在 mount 阶段调用本入口的真实注册器；失败即整体回滚。
        registerVersionedRoutes: forActivate ? mountVersionedRoutes : null,
        mountSkills: null,
        versionGraph: runtime.graph,
      });
      return runtime[slot];
    })().finally(() => { runtime[loadingKey] = null; });
    return runtime[loadingKey];
  }

  /**
   * 挂载**版本化生产路由**（routeMode='versioned'）：使用副本模块图里的真实 registerWebRoutes，
   * 只把 basePath 换成版本化前缀，其余（/state、/state/detail、/layout、/op、/health）与正常启动一致。
   *
   * **由 upgradeBundle 在激活事务内调用**（deps.registerVersionedRoutes）：挂载失败直接返回 ok:false，
   * 控制器抛错并完整回滚——不允许"先宣布成功、事后才发现 client-ack/detail 不可达"。
   */
  async function mountVersionedRoutes() {
    if (runtime.versionedInfo?.ok === true) return runtime.versionedInfo;
    const service = services.teamWorkbench;
    const web = services.webServer;
    if (!service || !web || typeof runtime.registerWebRoutesFn !== 'function') {
      return { ok: false, code: 'VERSIONED_ROUTES_UNAVAILABLE', routes: VERSIONED_ROUTES, basePath: VERSIONED_BASE };
    }
    try {
      const config = {
        ...(service.config ?? {}),
        web: { ...(service.config?.web ?? {}), basePath: VERSIONED_BASE },
      };
      const result = runtime.registerWebRoutesFn({ service, scheduler: service.__scheduler ?? null, adapter: runtime.realAdapter ?? service.adapter, config });
      const disposers = [];
      if (typeof result?.dispose === 'function') disposers.push(result.dispose);
      runtime.versionedDisposers = disposers;
      const routes = Array.isArray(result?.routes) && result.routes.length > 0 ? result.routes : VERSIONED_ROUTES;
      // 真实核验：注册器声明的路径必须覆盖 state/state-detail/op（不是"调用没抛"就算挂上）。
      const hasPath = (suffix) => routes.some((entry) => String(entry?.path ?? entry).endsWith(suffix));
      const verified = hasPath('/state') && hasPath('/state/detail') && hasPath('/op');
      if (!verified) {
        for (const dispose of disposers.splice(0)) { try { dispose(); } catch { /* rollback */ } }
        runtime.versionedInfo = { ok: false, code: 'VERSIONED_ROUTES_INCOMPLETE', basePath: VERSIONED_BASE, routes, required: ['state', 'state/detail', 'op'] };
        record('UPGRADE_ENTRY_VERSIONED_ROUTES_INCOMPLETE', `routes=${routes.join(',')}`);
        return runtime.versionedInfo;
      }
      runtime.versionedInfo = {
        ok: true,
        verified: true,
        basePath: VERSIONED_BASE,
        routes,
        clientAckEndpoint: `${VERSIONED_BASE}/op`,
        dispose: () => { for (const dispose of disposers.splice(0)) { try { dispose(); } catch { /* rollback */ } } },
        note: '版本化生产路由（/state 只读投影、/state/detail 分页、/op 含 client-ack、/health）；与正常启动同一套 handler；挂载失败会随激活事务回滚。',
      };
      record('UPGRADE_ENTRY_VERSIONED_ROUTES', `mounted ${routes.length} routes at ${VERSIONED_BASE}`);
      return runtime.versionedInfo;
    } catch (error) {
      runtime.versionedInfo = { ok: false, code: 'VERSIONED_ROUTES_FAILED', message: String(error?.message ?? error), basePath: VERSIONED_BASE, routes: VERSIONED_ROUTES };
      record('UPGRADE_ENTRY_VERSIONED_ROUTES_FAILED', String(error?.message ?? error));
      return runtime.versionedInfo;
    }
  }

  const handlePlan = async (_req, res) => {
    const gate = admitted(_req);
    if (!gate.ok) return json(res, 403, { ok: false, ...gate });
    try {
      const controller = await ensureController();
      if (!controller) return json(res, 503, { ok: false, code: 'UPGRADE_ENTRY_SERVICE_MISSING', missing, diagnostics });
      const plan = controller.plan();
      runtime.plan = plan;
      return json(res, 200, {
        ok: plan?.ok !== false,
        mode: 'dry-run',
        plan,
        // 可发现的版本化生产入口（尚未挂载：激活成功后挂载；client-ack 在版本化 /op 上可达）。
        versionedRoutes: { basePath: VERSIONED_BASE, routes: VERSIONED_ROUTES, clientAckEndpoint: `${VERSIONED_BASE}/op`, mounted: Boolean(runtime.versionedInfo?.ok) },
        autoActivate: config.autoActivate === true,
        diagnostics,
      });
    } catch (error) {
      record('UPGRADE_ENTRY_PLAN_FAILED', String(error?.message ?? error));
      return json(res, 500, { ok: false, code: 'UPGRADE_ENTRY_PLAN_FAILED', message: String(error?.message ?? error), diagnostics });
    }
  };

  async function resetFailedActivation() {
    let adapter = null;
    try {
      if (typeof runtime.adapterRollback === 'function') adapter = await runtime.adapterRollback();
    } catch (error) {
      adapter = { ok: false, code: 'ADAPTER_ROLLBACK_FAILED', message: String(error?.message ?? error) };
    }
    runtime.controller = null;
    runtime.adapterRollback = null;
    runtime.versionedInfo = null;
    return adapter;
  }

  const handleActivate = async (req, res) => {
    const gate = admitted(req);
    if (!gate.ok) return json(res, 403, { ok: false, ...gate });
    const body = await readBody(req);
    if (!body.ok) return json(res, 400, { ok: false, ...body });
    const payload = body.value ?? {};
    if (payload.confirm !== 'activate') {
      return json(res, 409, { ok: false, code: 'UPGRADE_CONFIRMATION_REQUIRED', message: 'activate 需要 body {confirm:"activate"}；在此之前不会改动运行中的 service。' });
    }
    try {
      const controller = await ensureController({
        installableEntry: payload.installableEntry,
        skillsMigrate: payload.skillsMigrate,
        skillsUpgradeEntry: payload.skillsUpgradeEntry,
        skillsSourceRoot: payload.skillsSourceRoot,
        skillsPatchPath: payload.skillsPatchPath,
        skillsVersionTarget: payload.skillsVersionTarget,
        skillsExpectedCount: payload.skillsExpectedCount,
        forActivate: true,
      });
      if (!controller) return json(res, 503, { ok: false, code: 'UPGRADE_ENTRY_SERVICE_MISSING', missing, diagnostics });
      runtime.activateCount += 1;
      const result = await controller.activate({ installableEntry: payload.installableEntry });
      runtime.lastResult = result;
      const ok = result?.ok === true && result?.postcondition?.ok === true;
      // The entry augments the adapter before the controller transaction starts.
      // Early probe failures and thrown exceptions must undo that work as well.
      const adapterRollback = ok ? null : await resetFailedActivation();
      // 版本化路由已在**激活事务内**挂载（registerVersionedRoutes）；成功即真实可达（含 client-ack）。
      // 失败时控制器已回滚并返回 OK=false，入口不会出现"200 但 routes 不可用"。
      const versioned = ok
        ? (runtime.versionedInfo?.ok === true
          ? runtime.versionedInfo
          : { ok: false, code: 'VERSIONED_ROUTES_NOT_MOUNTED', basePath: VERSIONED_BASE, routes: result?.mounted?.routes?.paths ?? VERSIONED_ROUTES })
        : { ok: false, code: result?.code ?? 'NOT_ACTIVATED', basePath: VERSIONED_BASE, routes: [], rolledBack: Boolean(result?.code) };
      if (!ok) runtime.versionedInfo = null;
      return json(res, ok ? 200 : 409, {
        ok,
        code: ok ? (versioned.ok === true ? null : (versioned.code ?? 'VERSIONED_ROUTES_INCOMPLETE')) : (result?.code ?? 'UPGRADE_POSTCONDITION_FAILED'),
        idempotent: Boolean(result?.alreadyUpgraded),
        postconditions: result?.postcondition ?? null,
        mounted: result?.mounted ?? null,
        versionedRoutes: versioned,
        rollback: ok ? null : { ...(result?.rollback ?? {}), attempted: true, adapter: adapterRollback ?? result?.rollback?.adapter ?? null },
        sidecarProbe: result?.sidecarProbe ?? null,
        diagnostics,
      });
    } catch (error) {
      const adapterRollback = await resetFailedActivation();
      record('UPGRADE_ENTRY_ACTIVATE_FAILED', String(error?.message ?? error));
      return json(res, 500, { ok: false, code: 'UPGRADE_ENTRY_ACTIVATE_FAILED', message: String(error?.message ?? error), rollback: { adapter: adapterRollback }, diagnostics });
    }
  };

  // 自身路由（旧 /op 不认识 upgrade，故独立路径 + marker 校验）。
  for (const route of [
    { kind: 'exact', path: `${BASE}/plan`, handler: handlePlan },
    { kind: 'exact', path: `${BASE}/activate`, handler: handleActivate },
  ]) {
    try {
      const disposer = services.webServer?.register?.(route);
      if (typeof disposer === 'function') disposers.push(disposer);
    } catch (error) {
      record('UPGRADE_ENTRY_ROUTE_FAILED', `${route.path}: ${String(error?.message ?? error)}`);
    }
  }

  // 默认不自动激活；显式 autoActivate=true 才激活刚生成的独立版本图。
  if (config.autoActivate === true && services.teamWorkbench) {
    void (async () => {
      const controller = await ensureController({ forActivate: true });
      if (!controller) {
        record('UPGRADE_ENTRY_AUTOSTART_ABORTED', '缺少 teamWorkbench 服务，autoActivate 中止。');
        return;
      }
      const result = await controller.activate({ installableEntry: config.installableEntry });
      runtime.lastResult = result;
      if (result?.ok !== true) await resetFailedActivation();
      record('UPGRADE_ENTRY_AUTOSTART', `autoActivate ok=${result?.ok === true} code=${result?.code ?? 'none'}`);
    })().catch(async (error) => {
      await resetFailedActivation();
      record('UPGRADE_ENTRY_AUTOSTART_FAILED', String(error?.message ?? error));
    });
  }

  record('UPGRADE_ENTRY_READY', `routes=${BASE}/plan|activate autoActivate=${config.autoActivate === true} missing=${missing.join(',') || 'none'}`);

  return () => {
    for (const dispose of (runtime.versionedDisposers ?? []).splice(0)) {
      try { dispose(); } catch { /* disposer 失效不阻塞 */ }
    }
    for (const dispose of disposers.splice(0)) {
      try { dispose(); } catch { /* disposer 失效不阻塞 */ }
    }
  };
}

/** 供测试/宿主探测：entry 暴露的诊断与运行时状态（不触发激活）。 */
export function describe(config = {}) {
  return { name, inject: inject.slice(), basePath: BASE, autoActivate: config.autoActivate === true, marker: MARKER };
}

export default { name, inject, apply, describe };
