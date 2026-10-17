/**
 * `src/host/index.js` — Host 半边的组装点。
 *
 * 这里只做装配：归一化配置 → 建适配层 → 建 sidecar → 建 service → 建调度器 →
 * 注册工具 / 提示词 / 技能 / 命令 / web 线路 / 事件订阅，全部带 disposer。
 *
 * 设计约束：
 *  - 不 import 任何非 `node:` 模块（profile 安装的插件不能可靠解析 `@deepseek-ai/*`）。
 *  - 每个可选服务用 `ctx.inject([...], cb)` 组装，缺少时本插件仍能加载并给出准确诊断。
 *  - 所有注册都返回 disposer 并挂在同一个 effect 上，HMR 后不重复注册。
 */
import { createAdapter } from './adapter.js';
import { normalizeConfig } from './config.js';
import { createScheduler } from './scheduler.js';
import { TeamWorkbenchService } from './service.js';
import { createStorage } from './storage.js';
import { createRemediationStorage, createSidecarStore, sidecarDirFor } from './remediationStorage.js';
import { resolveDataDir } from './storage-fallback.js';
import { registerTools } from './tools.js';
import { registerWebRoutes } from './web.js';
import { containsAny } from './util.js';
import { createUpgradeBundle } from './upgradeBundle.js';

export const name = 'team-workbench';

/**
 * 硬依赖为空：本插件在没有 team/subagent/storage 的组合里也必须加载成功，
 * 只是把缺失能力报告成诊断，而不是让整行 fiber 失败。
 */
export const inject = [];

const HEARTBEAT_MS = 30_000;

/**
 * @param {object} ctx
 * @param {object} rawConfig 行配置（`cordis.patch.yml` 合并结果）
 *
 * ⚠️ 本函数**必须是同步的**：Cordis 只允许在插件 fiber 处于 active 时创建
 * effect / inject，而 `apply` 一旦 `await`，随后的 `ctx.inject` / `ctx.effect` /
 * `ctx.on` 会抛 `INACTIVE_EFFECT`（已在独立 profile 进程中实测复现）。
 * 因此注册全部在同步段完成，异步的 hydration / 对账 / 心跳在同步段之后启动。
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const renderers = [];

  const adapter = createAdapter(ctx, { diagnosticsLimit: 240 });
  const storage = createStorage(ctx, adapter, { singleWriter: config.singleWriter });
  // 正常启动与 hot 共用同一 storage factory：旧核心表走 base，新表(sidecar)统一在 <dataDir>/remediation-sidecar；
  // storageDomain 没有 dataDir 时退到**同一个显式稳定根**（DSH_TEAM_WORKBENCH_DIR / DSH_HOME），
  // 不用 process.cwd() 漂移；base.ready 之后会把真实 sidecarDir 记进诊断，供 cold/hot 对账。
  const sidecarDir = config.remediation?.sidecarDir || sidecarDirFor(storage);
  const remediationSidecar = createSidecarStore({ dir: sidecarDir });
  const storageFacade = createRemediationStorage({ base: storage, sidecar: remediationSidecar });
  const service = new TeamWorkbenchService(ctx, adapter, storageFacade, config);
  const scheduler = createScheduler({ service, adapter, storage, config });
  /**
   * 有界热升级 controller（Lead 第 8 回合要求）：持有 ctx/注册入口/disposer。
   * 保留原 service/scheduler/队列/identity；sidecar+facade 先探针再切换；postcondition 不通过即回滚。
   */
  service.__upgradeController = createUpgradeBundle({
    ctx, adapter, storage, config, service, scheduler,
    registerTools, registerWebRoutes,
    startContextHooks, startUsageIngest,
    mountSkills: null,
    clock: service.clock,
  });
  try {
    const upgradePlan = service.__upgradeController.plan();
    service.diagnostics.push('host:upgrade-controller', 'ready sidecarDir=' + String(upgradePlan?.storage?.sidecarDir ?? 'unknown'));
  } catch (error) {
    service.diagnostics.push('host:upgrade-controller:failed', String(error?.message ?? error));
  }

  // ---- 同步段：服务对象、工具、技能、线路、命令、事件订阅 --------------------
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('teamWorkbench', service);
    } catch (error) {
      service.diagnostics.push('host:provide-failed', `ctx.provide('teamWorkbench') 失败：${String(error?.message ?? error)}`);
    }
  }

  const tools = { registered: [], skipped: [], dispose() {} };
  const toolDisposer = injectInto(ctx, ['tools'], (toolCtx) => {
    const result = registerTools({ service, scheduler, adapter, config });
    tools.registered = result.registered;
    tools.skipped = result.skipped;
    tools.dispose = result.dispose;
    scheduler.toolNames = result.registered;
    service.diagnostics.push('host:tools', `registered ${result.registered.length} team_* tools`, {
      registered: result.registered,
      skipped: result.skipped,
    });
    return () => result.dispose();
  });

  let skillsApi = null;
  let skillsInnerDispose = () => {};
  const skillsDisposer = injectInto(ctx, ['systemPrompt'], (skillCtx) => {
    let disposed = false;
    // 动态导入：skills.js 缺失或加载失败时降级为诊断，而不是让整行 fiber 失败。
    // 这里只登记意图；实际 import 发生在同步段之后，解析失败也会被 catch。
    Promise.resolve()
      .then(() => import('./skills.js'))
      .then((module) => {
        if (disposed) return;
        let dispose = () => {};
        if (typeof module.registerSkills === 'function') dispose = module.registerSkills(skillCtx, config, { adapter, service }) ?? (() => {});
        if (config.skills.roleSections && typeof module.registerPromptSections === 'function') {
          const promptDispose = module.registerPromptSections(skillCtx, config, { adapter, service }) ?? (() => {});
          const previous = dispose;
          dispose = () => {
            previous();
            promptDispose();
          };
        }
        skillsInnerDispose = dispose;
        skillsApi = module;
        service.diagnostics.push('host:skills', 'team role sections registered');
      })
      .catch((error) => {
        service.diagnostics.push('host:skills:unavailable', `src/host/skills.js 尚未就绪或加载失败：${String(error?.message ?? error)}`);
      });
    return () => {
      disposed = true;
      try {
        skillsInnerDispose();
      } catch {
        /* 卸载路径 */
      }
    };
  });

  const web = { routes: [], basePath: config.web.basePath, dispose() {} };
  const webDisposer = injectInto(ctx, ['webServer'], (webCtx) => {
    const result = registerWebRoutes({ service, scheduler, adapter, config });
    web.routes = result.routes;
    web.dispose = result.dispose;
    service.diagnostics.push('host:web', `routes: ${result.routes.join(', ')}`);
    return () => result.dispose();
  });

  const commandDisposer = injectInto(ctx, ['commands'], (commandCtx) => {
    const registered = adapter.registerCommand(buildStatusCommand(service));
    return () => {
      if (registered.ok && typeof registered.value === 'function') registered.value();
    };
  });

  const eventDisposers = [
    adapter.on('agent/created', (payload) => {
      service.diagnostics.push('host:agent-created', `agent ${payload?.agent?.id ?? '?'} (${payload?.source ?? 'unknown'})`);
      scheduler.notify('agent/created', payload?.agent?.id ?? null);
    }),
    // 成员**回合结束**的原生信号：`agent/status` 的 idle 解除"在飞回合"标记，
    // 让被合并的唤醒请求在下一个真实事件到达时能再次投递（不靠轮询生成空回合）。
    adapter.on('agent/status', (payload) => {
      const agentId = payload?.agent?.id;
      if (!agentId) return;
      service.noteMemberStatus(agentId, payload?.status ?? null);
    }),
    adapter.on('tools/change', () => scheduler.notify('tools/change', null)),
    adapter.on('skills/change', () => service.diagnostics.push('host:skills-change', 'skill catalog changed')),
  ];

  let heartbeatDisposer = () => {};
  let usageIngestDisposer = () => {};
  let contextHooksDisposer = () => {};

  // `storageDomain` 由 @deepseek-ai/dsh-storage-domain 通过 ctx.inject(backends) 挂载，
  // 时机晚于本行 activate。一次性探测会永远看到 SERVICE_UNAVAILABLE，因此这里用
  // 「服务出现即初始化 + 有界兜底」的门闸：storageDomain 一到就用它，
  // 迟迟不到才退到插件自有的持久 JSON 后端（并留下明确诊断）。
  const storageGate = createServiceGate(ctx, ['storageDomain'], config.storageGraceMs);

  // ---- 异步段：等到 storageDomain（或有界兜底）→ hydration → 心跳 → 调度 → 对账 ----
  const ready = storageGate
    .then(async (how) => {
      service.diagnostics.push('host:storage-gate', `storage gate settled by ${how}`);
      return service.beginInit();
    })
    .then(async (boot) => {
      // 正常启动也把**真实 sidecar 地址**记进诊断：hot 写 → normal apply 冷读必须落在同一路径。
      const bootSidecarDir = typeof storageFacade?.ready === 'function'
        ? (config.remediation?.sidecarDir || sidecarDirFor(storage))
        : sidecarDir;
      service.diagnostics.push('host:sidecar-dir', `sidecar=${bootSidecarDir}`, {
        sidecarDir: bootSidecarDir,
        baseDataDir: typeof storage?.dataDir === 'function' ? (storage.dataDir() ?? null) : null,
        explicitRoot: Boolean(process.env.DSH_TEAM_WORKBENCH_DIR || process.env.DSH_HOME || config.remediation?.sidecarDir),
        baseReady: Boolean(boot?.durable ?? true),
      });
      heartbeatDisposer = startHeartbeat(ctx, storage, service);
      scheduler.start();
      // 契约 §1/§8：费用归账是**后台增量**任务（原生 session 事件游标，不触发模型调用）。
      usageIngestDisposer = startUsageIngest(ctx, service, config);
      // 契约 §2/§6：受管团队的正式挂钩（pre-step 注入 + 原生工具守卫）。
      contextHooksDisposer = startContextHooks(adapter, service);
      const bootReconcile = await service.reconcile();
      service.diagnostics.push('host:boot', 'workbench host half ready', {
        durable: boot.durable,
        backend: boot.backend,
        backendError: boot.backendError,
        readOnly: boot.readOnly,
        reconcile: {
          adopted: bootReconcile.adopted.length,
          released: bootReconcile.released.length,
          requeued: bootReconcile.requeued.length,
          evidenceStale: bootReconcile.evidenceRefresh?.stale ?? 0,
        },
      });
      return boot;
    })
    .catch((error) => {
      service.diagnostics.push('host:boot-failed', `启动阶段失败（插件仍加载，能力降级）：${String(error?.message ?? error)}`);
      return null;
    });

  const disposeAll = async () => {
    try {
      await ready;
    } catch {
      /* 启动失败也要能干净卸载 */
    }
    scheduler.dispose();
    heartbeatDisposer();
    usageIngestDisposer();
    contextHooksDisposer();
    commandDisposer();
    webDisposer();
    skillsDisposer();
    toolDisposer();
    for (const disposer of eventDisposers.splice(0)) {
      try {
        disposer();
      } catch {
        /* 卸载路径 */
      }
    }
    for (const renderer of renderers.splice(0)) {
      try {
        renderer();
      } catch {
        /* 卸载路径 */
      }
    }
    tools.dispose();
    web.dispose();
    await service.dispose();
  };

  return disposeAll;
}

/**
 * 「服务可用或超时」门闸。用 `ctx.inject` 等待依赖服务挂载（本插件的行先于
 * storage-domain 激活），并用一个有界兜底避免服务永远不来时卡死启动。
 * 兜底定时器只用于**启动**，不参与调度/存储的关键路径。
 */
function createServiceGate(ctx, deps, graceMs) {
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  let timer = null;
  const finish = (how) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    settle(how);
  };
  injectInto(ctx, deps, () => {
    finish(`available:${deps.join('+')}`);
    return () => {};
  });
  const ms = Number.isFinite(graceMs) ? graceMs : 2500;
  if (ms > 0) {
    timer = setTimeout(() => finish('grace-timeout'), ms);
    if (typeof timer.unref === 'function') timer.unref();
  }
  return promise;
}

/**
 * `ctx.inject(deps, cb)` 的安全包装：服务缺失时整块功能跳过并留诊断，
 * 而不是让插件 fiber 失败。回调返回的 disposer 会被透传。
 */
function injectInto(ctx, deps, callback) {
  if (typeof ctx.inject !== 'function') {
    const missing = deps.filter((name) => typeof ctx.get !== 'function' || ctx.get(name) === undefined);
    if (missing.length > 0) return () => {};
    const disposer = callback(ctx);
    return typeof disposer === 'function' ? disposer : () => {};
  }
  const disposer = ctx.inject(deps, (childCtx) => callback(childCtx));
  return typeof disposer === 'function' ? disposer : () => {};
}

/** `team-workbench` 人类命令：不依赖 fetch 的同源入口，与工具共用同一 service。 */
function buildStatusCommand(service) {
  return {
    name: 'team-workbench',
    description: '并行工作台：查看团队/任务/容量快照，或按明确范围停止执行。',
    input: { hint: '[status|stop turn|stop members|stop team|recover]' },
    handler: (invocation) => {
      const text = String(invocation?.rawInput ?? '').trim();
      if (!text || text === 'status') {
        const snapshot = service.snapshot(invocation?.agent);
        const lines = [
          `团队 ${snapshot.teams.length} / 成员 ${snapshot.members.length} / 工作项 ${snapshot.works.length} / attempt ${snapshot.attempts.length}`,
          `容量：resident ${snapshot.capacity.residentInUse}/${snapshot.capacity.residentCapacity}，叶子 ${snapshot.capacity.activeLeaves}/${snapshot.capacity.workerCapacity}，迟到结果 ${snapshot.stats.lateResults}`,
          snapshot.readOnly ? `只读诊断态：${snapshot.readOnlyReason}` : `存储：${snapshot.storage?.backend ?? 'unknown'}（durable=${String(snapshot.storage?.durable)}）`,
          ...snapshot.works.slice(0, 12).map((work) => `- ${work.workId} [${work.state}] owner=${work.ownerMemberId} ${work.title}`),
        ];
        return { kind: 'success', text: lines.join('\n') };
      }
      if (containsAny(text, ['stop members', 'stop team', 'stop turn'])) {
        const scope = containsAny(text, ['stop team']) ? 'team' : containsAny(text, ['stop members']) ? 'members' : 'turn';
        return service.interruptTeam(invocation?.agent, { scope }).then((result) => ({
          kind: result.ok ? 'success' : 'error',
          text: JSON.stringify(result, null, 2),
        }));
      }
      if (containsAny(text, ['recover', 'reconcile'])) {
        return service.reconcile().then((report) => ({ kind: 'success', text: JSON.stringify(report, null, 2) }));
      }
      return { kind: 'error', text: `未知子命令：${text}` };
    },
  };
}

/** writer 心跳：让第二个 Host 进程能判断"已有写者且仍然活着"。 */
function startHeartbeat(ctx, storage, service) {
  const timerService = typeof ctx.get === 'function' ? ctx.get('timer') : undefined;
  const beat = () => {
    void storage.heartbeat().catch((error) => {
      service.diagnostics.push('host:heartbeat-failed', String(error?.message ?? error));
    });
  };
  if (timerService && typeof timerService.interval === 'function') {
    const disposer = timerService.interval(beat, HEARTBEAT_MS);
    return () => {
      try {
        disposer();
      } catch {
        /* 卸载路径 */
      }
    };
  }
  const handle = setInterval(beat, HEARTBEAT_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}

/**
 * 费用归账的后台增量任务（契约 §1；Codex 审阅 1 修订）。
 *
 * **生产入口**：`service.refreshUsage()` → `nativeUsage.collect()`，
 * 从 live Agent 的原生 session 事件游标（`session.snapshotEvents`）折账——
 * 含 final/stream 去重、真实 retry、summary、缺 usage、祖先归属。
 *
 * `usage.sourcePath`（审计 JSONL）**只做验收基线重放**（`mode:'baseline'`），
 * 不再作为生产归账来源；配置了才会额外导入一次（幂等）。
 *
 * - 不触发模型调用、不把账本读进上下文、`/state` 只拿聚合投影。
 * - 定时器 unref + disposer。
 */
export function startUsageIngest(ctx, service, config) {
  const usage = config?.usage ?? {};
  if (usage.enabled === false) {
    service.diagnostics.push('host:usage-ingest:disabled', 'usage.enabled=false：不启动费用归账后台任务。');
    return () => {};
  }
  const timerService = typeof ctx.get === 'function' ? ctx.get('timer') : undefined;
  const intervalMs = Number.isFinite(usage.ingestIntervalMs) ? usage.ingestIntervalMs : 60000;
  const tick = () => {
    // 1) 生产：原生 session 事件增量归账
    void service.refreshUsage({ mode: 'native' })
      .then((result) => {
        if (result && result.ok !== false && ((result.appendedUnits ?? 0) > 0 || (result.upgradedUnits ?? 0) > 0 || (result.duplicates ?? 0) > 0)) {
          service.diagnostics.push('host:usage-native', `+${result.appendedUnits ?? 0} units（upgrade ${result.upgradedUnits ?? 0}，dup ${result.duplicates ?? 0}，sessions ${result.sessions ?? 0}）`);
        }
      })
      .catch((error) => service.diagnostics.push('host:usage-native:failed', String(error?.message ?? error)));
    // 1b) 历史非 live 会话补账（已知 team/member/attempt session；官方只读句柄；分批 + 持久 cursor）；
    //     默认每 tick 补一批（bounded batchSize），已结束子任务不会漏账。
    if (usage.historicalBackfill !== false) {
      void (typeof service.backfillHistoricalFromKnownSessions === 'function'
        ? service.backfillHistoricalFromKnownSessions({ batchSize: Number.isInteger(usage.historicalBatchSize) ? usage.historicalBatchSize : 10 })
        : Promise.resolve(null))
        .then((result) => {
          if (result && (result.appendedUnits ?? 0) > 0) {
            service.diagnostics.push('host:usage-history', `历史补账 +${result.appendedUnits} units（targets ${result.targets ?? 0}，gaps ${result.gaps?.length ?? 0}）`);
          }
        })
        .catch((error) => service.diagnostics.push('host:usage-history:failed', String(error?.message ?? error)));
    }
    // 2) 审计基线只做验收重放（配置了才导入；幂等、不计入本阶段）
    if (usage.sourcePath) {
      void service.refreshUsage({ mode: 'baseline' })
        .then((result) => {
          if (result && result.ok !== false && (result.appendedUnits ?? 0) > 0) {
            service.diagnostics.push('host:usage-baseline', `审计基线导入 +${result.appendedUnits} units（仅验收重放，不计入本阶段）`);
          }
        })
        .catch((error) => service.diagnostics.push('host:usage-baseline:failed', String(error?.message ?? error)));
    }
  };
  tick();
  if (timerService && typeof timerService.interval === 'function') {
    const disposer = timerService.interval(tick, intervalMs);
    return () => {
      try {
        disposer();
      } catch {
        /* 卸载路径 */
      }
    };
  }
  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}

/**
 * 受管团队的**正式宿主挂钩**（Codex 审阅 2）：
 *
 * - `agent/pre-step`（waterfall）：受管成员/leaf 请求前注入紧凑状态（预算受限、失败安全）。
 * - `tools.guard`：受管 agent 的原生工具「同输入同版本确定性失败」预检。
 *
 * 两者都只覆盖受管团队，不吞队列、不换 owner、不做全局压缩。
 */
export function startContextHooks(adapter, service) {
  const disposers = [];
  const preStep = adapter.on('agent/pre-step', (payload, next) => service.contextControl.onPreStep(payload, next));
  if (typeof preStep === 'function') disposers.push(preStep);
  // tools/result 真实失败生产者（官方 emit 签名：callback(exec, result)；result.isError 才算失败）。
  // 与 guard 共用 buildOperationDescriptor 生成的指纹，写进 sidecar 错误指纹表。
  const toolResult = adapter.on('tools/result', (exec, result) => service.contextControl.onToolResult(exec, result));
  if (typeof toolResult === 'function') disposers.push(toolResult);
  const guard = adapter.registerToolGuard((execution) => service.contextControl.guardNativeTool(execution));
  if (guard && guard.ok === true && typeof guard.value === 'function') disposers.push(guard.value);
  service.diagnostics.push(
    'host:context-hooks',
    `pre-step ${typeof preStep === 'function' ? '已注册' : '未注册（服务缺失）'}；tools/result ${typeof toolResult === 'function' ? '已注册' : '未注册'}；工具守卫 ${guard?.ok ? '已注册' : `未注册（${guard?.code ?? 'unknown'}）`}`,
  );
  return () => {
    for (const disposer of disposers.splice(0)) {
      try {
        disposer();
      } catch {
        /* 卸载路径 */
      }
    }
  };
}
