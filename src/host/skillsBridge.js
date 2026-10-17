/**
 * `skillsBridge.js` — 可选外部技能包的事务升级桥。
 *
 * ## 配置
 * - 默认关闭；只有 `config.remediation.skillsMigrate === true` 才执行外部技能升级。
 * - 启用时必须提供 `skillsUpgradeEntry`（绝对路径或 `file://` URL）和 `skillsSourceRoot`。
 * - `skillsPatchPath` 默认使用 sourceRoot/cordis.patch.yml；不包含任何内置外部技能包。
 * - 动态加载用 `import(pathToFileURL(entry) + '?twb-skills=' + Date.now())`。
 * 入口不存在/无导出/加载抛错 → 明确失败码（不静默跳过、不当成功）。
 *
 * ## 顺序（由技能侧 API 完成）
 * `copyVersion → describeVersion → planRestoreRows（禁用行由 readPatchFile/disabledRowIdsFromRows 派生）
 *  → createPluginRowApplier(getRowContext=原行 ctx, moduleUrl=copy.skillEntryUrl, entry=await import(skillEntryUrl))
 *  → runUpgrade(readback = readbackLive({skills, expected})) → 失败用上一版本入口重放`。
 *
 * ## 边界
 * 不整棵重载、不 dispose workbench/ui-recovery、不新 owner；应用行期间只记 `in-progress`，
 * 全部应用 + readback 通过才记成功；失败返回 `ok:false` 由 upgradeBundle 触发整体回滚。
 */

import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';

function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // …/src/host
const PACKAGE_ROOT = path.resolve(HERE, '..', '..'); // …/<workbench 包根>

const REQUIRED_EXPORTS = ['copyVersion', 'describeVersion', 'planRestoreRows', 'createPluginRowApplier', 'runUpgrade', 'readbackLive', 'readPatchFile', 'disabledRowIdsFromRows'];

/** 解析技能升级入口路径（绝对路径）。 */
/**
 * **路线 B（回退）：用升级入口自己的 ctx 建立 18 个受控子 scope**（Lead 第 22 回合）。
 *
 * 为什么选 B 而不是 A：路线 A 需要 Loader/fiber registry 按行 id 取原行 ctx，安装包内
 * 该 API 未在本仓被使用、签名未核实；盲取会把"取不到 ctx"变成静默半套迁移。B 用
 * 官方 `ctx.plugin(moduleUrl, config)` 每行一个独立 scope，disposer 精确可回滚，
 * 且旧 provider 由技能侧 `shared.js`「新 INSTANCE 首注册清旧」机制清掉，语义与正常装载一致。
 *
 * 每行预检：必须有 `ctx.plugin` 或 `entry.apply`；两者都无 → 抛 `APPLY_NO_PLUGIN_API`，
 * 由 runUpgrade 作为**预检失败**处理（不 apply 任何行）。
 */
export function createControlledRowApplier({ ctx, moduleUrl = null, entry = null, plugin = null, log = () => {} }) {
  // 合同（cordis/lib/index.js:1533-1537/1619-1621）：ctx.plugin 只接受 function/class/{apply} 插件对象，
  // **file:// 字符串会抛 invalid plugin**。因此必须传已 import 的模块（或其中的插件对象）。
  const pluginObject = plugin ?? entry ?? null;
  const hasPlugin = Boolean(ctx && typeof ctx.plugin === 'function');
  if (!hasPlugin) {
    const error = new Error('技能行装载入口不可用：ctx.plugin 不存在（不 apply，整体失败）');
    error.code = 'APPLY_NO_PLUGIN_API';
    throw error;
  }
  if (!pluginObject && !moduleUrl) {
    const error = new Error('技能行装载缺少已 import 的插件对象（不允许直接传 file:// 字符串）');
    error.code = 'APPLY_MODULE_URL_MISSING';
    throw error;
  }
  return async function applyRow(row, index = 0) {
    // 保留完整 row.config；skill 保持 parsePatchRows 的输出（字符串/对象均原样），summary 仅在缺省时补。
    const baseConfig = row?.config && typeof row.config === 'object' ? row.config : {};
    const config = { ...baseConfig };
    if (config.skill === undefined) config.skill = row?.skill ?? null;
    if (config.summary === undefined) config.summary = row?.summary ?? null;
    // Loader 语义：先 import → unwrapExports → registry.plugin；返回可能是 thenable Fiber（await 后取 fiber.dispose）。
    const returned = ctx.plugin(pluginObject ?? moduleUrl, config);
    const fiberLike = await Promise.resolve(returned);
    const fiber = fiberLike && typeof fiberLike === 'object' ? fiberLike : null;
    const dispose = typeof fiber?.dispose === 'function'
      ? () => fiber.dispose()
      : (typeof fiberLike === 'function' ? fiberLike : (typeof returned === 'function' ? returned : null));
    if (!dispose) throw Object.assign(new Error('ctx.plugin 返回不可释放句柄（既非 Fiber.dispose 也非 disposer 函数）'), { code: 'APPLY_DISPOSE_UNSUPPORTED' });
    let disposed = false;
    log('skills:row-applied', { index, rowId: row?.rowId ?? row?.id ?? null, form: 'plugin', fiber: Boolean(fiber) });
    return () => {
      if (disposed) return;
      disposed = true;
      try {
        dispose();
      } catch (error) {
        throw Object.assign(new Error(`技能行 dispose 失败：${String(error?.message ?? error)}`), { code: 'APPLY_DISPOSE_FAILED' });
      }
    };
  };
}
export function resolveSkillsUpgradeEntry(config = {}) {
  const override = config?.remediation?.skillsUpgradeEntry;
  if (typeof override === 'string' && override.trim()) {
    const value = override.trim();
    if (value.startsWith('file:')) return fileURLToPath(value);
    if (!path.isAbsolute(value)) throw Object.assign(new Error('skillsUpgradeEntry must be an absolute path or file URL'), { code: 'SKILLS_UPGRADE_ENTRY_INVALID' });
    return value;
  }
  return null;
}

/** 动态加载技能升级模块（带 query 避免 ESM 缓存复用旧 URL）。 */
export async function loadSkillsUpgradeModule(config = {}) {
  let entryPath;
  try {
    entryPath = resolveSkillsUpgradeEntry(config);
  } catch (error) {
    return { ok: false, code: 'SKILLS_UPGRADE_ENTRY_INVALID', message: String(error?.message ?? error) };
  }
  if (!entryPath) return { ok: false, code: 'SKILLS_UPGRADE_ENTRY_REQUIRED', entryPath: null };
  try {
    const stat = await fsp.stat(entryPath);
    if (!stat.isFile()) return { ok: false, code: 'SKILLS_UPGRADE_ENTRY_MISSING', entryPath };
  } catch (error) {
    return { ok: false, code: 'SKILLS_UPGRADE_ENTRY_MISSING', entryPath, message: String(error?.message ?? error) };
  }
  try {
    const mod = await import(`${pathToFileURL(entryPath).href}?twb-skills=${Date.now()}`);
    const missing = REQUIRED_EXPORTS.filter((name) => typeof mod?.[name] !== 'function');
    if (missing.length > 0) return { ok: false, code: 'SKILLS_UPGRADE_NO_EXPORTS', entryPath, missing };
    return { ok: true, entryPath, module: mod };
  } catch (error) {
    return { ok: false, code: 'SKILLS_UPGRADE_LOAD_FAILED', entryPath, message: String(error?.message ?? error) };
  }
}

/** 只读 providers 计数证据（`ctx.get('skills')` 的 list/get；不整棵重载）。 */
export async function collectProviders(service) {
  const skills = typeof service?.ctx?.get === 'function' ? service.ctx.get('skills') : undefined;
  if (!skills || typeof skills.list !== 'function') return { count: 0, names: [], hooks: null, available: false };
  try {
    const listed = await skills.list();
    const rows = Array.isArray(listed) ? listed : (Array.isArray(listed?.providers) ? listed.providers : []);
    const names = rows.map((row) => String(row?.name ?? row?.id ?? '')).filter(Boolean);
    return { count: names.length, names, hooks: rows.length, available: true };
  } catch (error) {
    return { count: 0, names: [], hooks: null, available: false, error: String(error?.message ?? error) };
  }
}

/**
 * 执行技能迁移（独立阶段）。返回 `{ok, code?, ...证据}`；**不抛到调用方**。
 *
 * @param {{
 *   service: object, config: object, diagnostics?: object,
 *   log?: (step:string, detail?:object)=>void,
 * }} deps
 */
/**
 * **迁移前旧行快照**（真回滚唯一依据，Lead 批准清单 1/3）：
 * 用官方 Loader `entries()` / `resolve('skill-<name>')` 取原行 `entry.fiber` / 父 ctx /
 * 完整 plugin 对象 / config / 启用状态；并用 `skills.list()/get()` 采集旧正文 hash。
 * 任一行取不到 → `SKILLS_ROWS_FIBER_UNAVAILABLE`（不半套迁移）。
 */
export async function captureLegacyRows(service, rows) {
  const loader = typeof service?.ctx?.get === 'function' ? service.ctx.get('loader') : undefined;
  const skills = typeof service?.ctx?.get === 'function' ? service.ctx.get('skills') : undefined;
  if (!loader || typeof loader.entries !== 'function') {
    return { ok: false, code: 'SKILLS_ROWS_FIBER_UNAVAILABLE', reason: 'ctx.get(loader) 不可用' };
  }
  const captured = [];
  const problems = [];
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const rowId = String(row?.rowId ?? row?.id ?? '');
    const name = String(row?.skill?.name ?? row?.name ?? '');
    let entry = null;
    try {
      entry = typeof loader.resolve === 'function' ? await loader.resolve(rowId) : null;
    } catch {
      entry = null;
    }
    if (!entry) {
      const entries = [];
      try {
        for (const candidate of loader.entries()) entries.push(candidate);
      } catch {
        /* entries 不可迭代 */
      }
      entry = entries.find((candidate) => String(candidate?.id ?? candidate?.options?.id ?? '') === rowId) ?? null;
    }
    const fiber = entry?.fiber ?? entry?.fiberRef ?? null;
    // 官方 Loader：真实回调在 fiber.runtime.callback，Config 在 fiber.runtime.Config；fiber.inject 是注入集。
    // 父 ctx 不能用将被卸载的 fiber.ctx 冒充；用**活的** service.ctx 作为重建父 scope。
    const parentCtx = service?.ctx ?? null;
    const runtime = fiber?.runtime ?? null;
    const callback = runtime?.callback ?? entry?.callback ?? null;
    const plugin = callback ?? null; // function/class 保持原语义；需 {apply} 形态时由 applier 包装
    const config = runtime?.Config ?? runtime?.config ?? entry?.options?.config ?? row?.config ?? null;
    const inject = Array.isArray(fiber?.inject) ? fiber.inject.slice() : null;
    if (plugin && typeof plugin === 'object' && typeof plugin.apply !== 'function') {
      problems.push({ rowId, reason: 'CALLBACK_NOT_PLUGIN', callbackType: typeof plugin });
      continue;
    }
    if (!fiber || !parentCtx || !plugin) {
      problems.push({ rowId, hasFiber: Boolean(fiber), hasCtx: Boolean(parentCtx), hasPlugin: Boolean(plugin) });
      continue;
    }
    const fiberAlive = fiberActive(fiber);
    captured.push({ rowId, name, fiber, parentCtx, plugin, config, inject, enabled: fiberAlive });
  }
  if (problems.length > 0) return { ok: false, code: 'SKILLS_ROWS_FIBER_UNAVAILABLE', problems, captured: captured.length };
  const hashes = [];
  if (skills && typeof skills.list === 'function') {
    try {
      const listed = await skills.list();
      const providerRows = Array.isArray(listed) ? listed : (Array.isArray(listed?.providers) ? listed.providers : []);
      for (const provider of providerRows) {
        const providerName = String(provider?.name ?? provider?.id ?? '');
        let content = provider?.content ?? null;
        if (typeof skills.get === 'function' && providerName) {
          try { content = (await skills.get(providerName))?.content ?? content; } catch { /* 保持 list 内容 */ }
        }
        hashes.push({ provider: providerName, sha256: content === null ? null : hashText(String(content)), chars: content === null ? 0 : String(content).length });
      }
    } catch {
      /* 读不到正文 hash：恢复时以 hashesMatched:false 表述，不伪造 */
    }
  }
  return { ok: true, captured, hashes, providers: hashes.length };
}

/** 直接读 provider 正文 hash（skills.list/get），用于回滚后比对；读不到返回空数组（不伪造）。 */
async function readProviderHashes(service) {
  const skills = typeof service?.ctx?.get === 'function' ? service.ctx.get('skills') : undefined;
  if (!skills || typeof skills.list !== 'function') return [];
  const hashes = [];
  try {
    const listed = await skills.list();
    const rows = Array.isArray(listed) ? listed : (Array.isArray(listed?.providers) ? listed.providers : []);
    for (const provider of rows) {
      const providerName = String(provider?.name ?? provider?.id ?? '');
      let content = provider?.content ?? null;
      if (typeof skills.get === 'function' && providerName) {
        try { content = (await skills.get(providerName))?.content ?? content; } catch { /* 保持 list 内容 */ }
      }
      if (content === null || content === undefined) continue;
      hashes.push({ provider: providerName, sha256: hashText(String(content)), chars: String(content).length });
    }
  } catch {
    return [];
  }
  return hashes;
}

function fiberActive(fiber) {
  if (!fiber) return false;
  const uid = fiber.uid ?? null;
  const state = Number(fiber.state ?? -1);
  return uid !== null && state !== 5;
}

/** **失败回滚**（Lead 批准清单 2）：先 dispose 新 fiber；再用快照 plugin+parentCtx+config 重建，或对仍有效旧 fiber restart；最后读回旧正文 hash。 */
export async function restoreLegacyRows(service, snapshot, log = () => {}) {
  if (!snapshot?.ok) return { ok: false, code: snapshot?.code ?? 'SKILLS_SNAPSHOT_MISSING', hashesMatched: false };
  const restarted = [];
  const rebuilt = [];
  const failed = [];
  for (const row of snapshot.captured) {
    try {
      if (fiberActive(row.fiber) && typeof row.fiber.restart === 'function') {
        await row.fiber.restart();
        restarted.push(row.rowId);
        log('skills:row-restarted', { rowId: row.rowId, uidPresent: (row.fiber.uid ?? null) !== null });
        continue;
      }
      const returned = row.parentCtx.plugin(row.plugin, row.config ?? {});
      const fiber = await Promise.resolve(returned);
      rebuilt.push({ rowId: row.rowId, fiberUidPresent: Boolean(fiber && fiber.uid !== null), pluginObject: Boolean(row.plugin) });
      log('skills:row-rebuilt', { rowId: row.rowId });
    } catch (error) {
      failed.push({ rowId: row.rowId, message: String(error?.message ?? error) });
    }
  }
  // 读回旧正文 hash（用 skills.list()/get() 直接读，不依赖 Loader 是否仍解析得到）。
  const afterHashes = await readProviderHashes(service);
  const beforeByProvider = new Map((snapshot.hashes ?? []).map((item) => [item.provider, item.sha256]));
  const hashesMatched = afterHashes.length > 0
    && (snapshot.hashes ?? []).length > 0
    && afterHashes.length >= snapshot.hashes.length
    && snapshot.hashes.every((item) => afterHashes.some((candidate) => candidate.provider === item.provider && candidate.sha256 === item.sha256));
  return {
    ok: failed.length === 0 && hashesMatched,
    code: failed.length > 0 ? 'SKILLS_ROLLBACK_REBUILD_FAILED' : (hashesMatched ? null : 'SKILLS_ROLLBACK_HASH_MISMATCH'),
    restoredFrom: restarted.length > 0 ? 'fiber-restart' : 'snapshot',
    hashesMatched,
    restarted,
    rebuilt,
    failed,
    providersAfter: afterHashes.length > 0 ? afterHashes.length : null,
  };
}

export async function runSkillsMigration(deps = {}) {
  const service = deps.service;
  const config = deps.config ?? {};
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const remediation = config?.remediation && typeof config.remediation === 'object' ? config.remediation : {};
  if (remediation.skillsMigrate !== true) {
    return { ok: true, skipped: true, reason: 'EXTERNAL_SKILLS_NOT_ENABLED', markers: ['skipped'], readback: null, rollback: null };
  }
  const markers = ['started'];
  const providersBefore = await collectProviders(service);
  const loaded = await loadSkillsUpgradeModule(config);
  if (!loaded.ok) return { ok: false, code: loaded.code, entryPath: loaded.entryPath, providersBefore, providersAfter: providersBefore, applicationForm: null, rollback: null, readback: null, markers };
  const api = loaded.module;
  log('skills:loaded', { entryPath: loaded.entryPath });

  // Source ownership is explicit: never guess or copy an unrelated sibling package.
  const sourceRoot = typeof remediation.skillsSourceRoot === 'string' && remediation.skillsSourceRoot.trim()
    ? remediation.skillsSourceRoot.trim()
    : null;
  if (!sourceRoot || !path.isAbsolute(sourceRoot)) {
    return { ok: false, code: 'SKILLS_SOURCE_ROOT_REQUIRED', message: 'skillsSourceRoot must be an absolute directory path', providersBefore, providersAfter: providersBefore, applicationForm: null, rollback: null, readback: null, markers };
  }

  // patch / 行 / 禁用行（禁用行由技能侧派生；Host 不读 profile）
  const patchPath = typeof remediation.skillsPatchPath === 'string' && remediation.skillsPatchPath
    ? path.resolve(remediation.skillsPatchPath)
    : path.join(sourceRoot, 'cordis.patch.yml');
  let rowsSource = null;
  try {
    rowsSource = await api.readPatchFile(patchPath);
  } catch (error) {
    return { ok: false, code: 'SKILLS_PATCH_UNREADABLE', patchPath, message: String(error?.message ?? error), providersBefore, providersAfter: providersBefore, applicationForm: null, rollback: null, readback: null, markers: [...markers, 'patch-unreadable'] };
  }
  const rows = Array.isArray(rowsSource) ? rowsSource : (Array.isArray(rowsSource?.rows) ? rowsSource.rows : []);
  const disabledRowIds = typeof api.disabledRowIdsFromRows === 'function' ? api.disabledRowIdsFromRows(rows) : [];
  markers.push('patch-parsed');

  // 版本目录：复制成新目录（file:// 入口同 URL 空间）
  const targetRoot = typeof remediation.skillsVersionTarget === 'string' && remediation.skillsVersionTarget
    ? path.resolve(remediation.skillsVersionTarget)
    : path.join(PACKAGE_ROOT, '.runtime', `twb-skills-version-${Date.now()}`);
  let copy = null;
  try {
    copy = await fsp.stat(sourceRoot).then(() => api.copyVersion({ sourceRoot, targetRoot, label: 'twb-hot-upgrade' }));
  } catch (error) {
    return { ok: false, code: 'SKILLS_VERSION_COPY_FAILED', sourceRoot, targetRoot, message: String(error?.message ?? error), providersBefore, providersAfter: providersBefore, applicationForm: null, rollback: null, readback: null, markers: [...markers, 'copy-failed'] };
  }
  markers.push('copied');
  const newRoot = copy?.root ?? copy?.targetRoot ?? targetRoot;
  const skillEntryPath = copy?.entryPath ?? copy?.skillEntryPath ?? path.join(newRoot, 'src', 'entry.js');
  const skillEntryUrl = copy?.skillEntryUrl ?? copy?.entryUrl ?? pathToFileURL(skillEntryPath).href;
  const previousEntryPath = copy?.previousEntryPath ?? path.join(sourceRoot, 'src', 'entry.js');
  const previousEntryUrl = pathToFileURL(previousEntryPath).href;

  let newVersion = null;
  let previousVersion = null;
  try {
    // 无副作用预检：新版本技能集 + 注入哈希对账
    newVersion = await api.describeVersion(newRoot);
    previousVersion = await api.describeVersion(sourceRoot);
    markers.push('described');
  } catch (error) {
    return { ok: false, code: 'SKILLS_VERSION_DESCRIBE_FAILED', message: String(error?.message ?? error), copy: { newRoot, skillEntryUrl }, providersBefore, providersAfter: providersBefore, applicationForm: null, rollback: null, readback: null, markers: [...markers, 'describe-failed'] };
  }
  // 迁移前**旧行快照**（真回滚唯一依据）：Loader entries/resolve 取 fiber/父 ctx/plugin 对象/config + 旧正文 hash。
  const legacySnapshot = await captureLegacyRows(service, rows);
  if (legacySnapshot.ok !== true) {
    return { ok: false, code: legacySnapshot.code ?? 'SKILLS_ROWS_FIBER_UNAVAILABLE', reason: legacySnapshot.reason ?? 'Loader 取不到旧行 fiber/ctx/plugin', problems: legacySnapshot.problems ?? null, providersBefore, providersAfter: providersBefore, applicationForm: null, rollback: null, readback: null, markers: [...markers, 'fiber-unavailable'] };
  }
  markers.push('legacy-snapshot');
  // 禁用行以**实际 Loader 当前行状态**为准（fiber 非 active 视为禁用），并与 patch 派生合并；
  // 不得把已禁用行强行补成 18。
  const disabledRowIdsEffective = [...new Set([
    ...disabledRowIds,
    ...legacySnapshot.captured.filter((row) => row.enabled === false).map((row) => row.rowId),
  ])];
  const versionSkills = newVersion?.skills ?? newVersion?.versionSkills ?? [];
  const plan = api.planRestoreRows({
    rows,
    disabledRowIds: disabledRowIdsEffective,
    versionSkills,
    expectedCount: Number.isInteger(remediation.skillsExpectedCount) ? remediation.skillsExpectedCount : undefined,
  });
  if (!plan || (Array.isArray(plan.problems) && plan.problems.length > 0) || !Array.isArray(plan.rows)) {
    return { ok: false, code: 'SKILLS_PLAN_REJECTED', plan, versionSkills: versionSkills.length, disabledRowIds: disabledRowIds.length, providersBefore, providersAfter: providersBefore, applicationForm: null, rollback: null, readback: null, markers: [...markers, 'plan-rejected'] };
  }
  markers.push('planned');

  let skillEntryModule = null;
  try {
    skillEntryModule = await import(`${skillEntryUrl}?twb-skills-entry=${Date.now()}`);
  } catch (error) {
    return { ok: false, code: 'SKILLS_ENTRY_LOAD_FAILED', skillEntryUrl, message: String(error?.message ?? error), providersBefore, providersAfter: providersBefore, applicationForm: null, rollback: null, readback: null, markers: [...markers, 'entry-load-failed'] };
  }
  // 路线 B：每行独立受控 scope（ctx.plugin 优先；entry.apply 回退）；预检不过 → 不 apply 任何行。
  if (!service?.ctx || (typeof service.ctx.plugin !== 'function' && !(skillEntryModule && typeof skillEntryModule.apply === 'function'))) {
    return { ok: false, code: 'SKILLS_ROWS_CTX_UNAVAILABLE', reason: '升级入口 ctx 不支持 plugin，且 entry.apply 不可用：拒绝半套迁移。', providersBefore, providersAfter: providersBefore, applicationForm: null, rollback: null, readback: null, markers: [...markers, 'rows-ctx-unavailable'] };
  }
  const createdHandles = [];
  let baseApplyRow = null;
  try {
    baseApplyRow = createControlledRowApplier({ ctx: service.ctx, moduleUrl: skillEntryUrl, plugin: skillEntryModule, log });
  } catch (error) {
    return { ok: false, code: error?.code ?? 'APPLY_NO_PLUGIN_API', message: String(error?.message ?? error), providersBefore, providersAfter: providersBefore, applicationForm: null, rollback: null, readback: null, markers: [...markers, 'applier-unavailable'] };
  }
  const applyRow = async (row, index) => {
    const handle = await baseApplyRow(row, index);
    if (typeof handle === 'function') createdHandles.push(handle);
    return handle;
  };
  const readback = async () => {
    const skills = typeof service?.ctx?.get === 'function' ? service.ctx.get('skills') : undefined;
    return api.readbackLive({ skills, expected: versionSkills });
  };
  // skills 侧真回滚接口（Lead 最后接线）：迁移前 capturePrevious + runUpgrade(previousSnapshot/replayRow)。
  let previousSnapshot = null;
  let replayRow = null;
  if (typeof api.capturePrevious === 'function' && legacySnapshot.ok === true) {
    try {
      const skillsService = typeof service?.ctx?.get === 'function' ? service.ctx.get('skills') : undefined;
      previousSnapshot = await api.capturePrevious({
        skills: skillsService,
        rows,
        disabledRowIds: disabledRowIdsEffective,
        plugins: legacySnapshot.captured.map((row) => ({ rowId: row.rowId, skill: { name: row.name }, plugin: row.plugin, config: row.config, enabled: row.enabled })),
      });
      markers.push('previous-snapshot');
    } catch (error) {
      previousSnapshot = { problems: [`[CAPTURE_THROWN] ${String(error?.message ?? error)}`] };
    }
  }
  replayRow = async (row, index) => {
    const rowId = String(row?.rowId ?? row?.id ?? '');
    const name = String(row?.skill?.name ?? row?.name ?? '');
    const savedRow = legacySnapshot.captured.find((candidate) => candidate.rowId === rowId || candidate.name === name) ?? legacySnapshot.captured[index];
    if (!savedRow) throw Object.assign(new Error('回滚快照缺少该行'), { code: 'ROLLBACK_SNAPSHOT_EMPTY' });
    // 用**旧 plugin 对象 + 完整 config** 重建（不重新 import 已被改写的新路径）。
    const returned = savedRow.parentCtx.plugin(savedRow.plugin, savedRow.config ?? {});
    const fiber = await Promise.resolve(returned);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      try { if (typeof fiber?.dispose === 'function') fiber.dispose(); } catch { /* dispose 失败由调用方记录 */ }
    };
  };
  markers.push('in-progress');
  let report = null;
  try {
    report = await api.runUpgrade({ newVersion: newVersion?.generation ? newVersion : { ...(newVersion ?? {}), root: newRoot, skills: versionSkills }, previousVersion, plan, applyRow, readback, previousSnapshot, replayRow, log });
  } catch (error) {
    report = { ok: false, phase: 'apply', problems: [`[THROWN] ${String(error?.message ?? error)}`], rollback: { needed: true, attempted: false, ok: false } };
  }
  markers.push(report?.ok === true ? 'readback-ok' : 'failed');
  const providersAfter = await collectProviders(service);
  const readbackResult = report?.readback ?? null;
  const readbackOk = readbackResult?.ok === true || (report?.ok === true && Array.isArray(readbackResult?.skills) && readbackResult.skills.length === versionSkills.length && readbackResult.skills.every((item) => item.shaMatch === true && item.charsMatch === true));

  // 失败：用**上一版本入口**重放 plan.rows 恢复（技能侧 runUpgrade 已尽力撤销本次；这里做上一版本重放）
  let rollback = report?.rollback ?? null;
  if (report?.ok !== true || !readbackOk) {
    // 先撤掉本次已 apply 的受控 scope（避免半套），再用上一版本入口重放旧 18 行。
    let disposedCreated = 0;
    for (const handle of createdHandles.reverse()) {
      try { handle(); disposedCreated += 1; } catch { /* dispose 失败继续回滚 */ }
    }
    const legacyRestore = await restoreLegacyRows(service, legacySnapshot, log).catch((error) => ({ ok: false, code: 'SKILLS_ROLLBACK_FAILED', message: String(error?.message ?? error), hashesMatched: false }));
    rollback = { ...(rollback ?? {}), restoredFrom: legacyRestore.restoredFrom ?? null, hashesMatched: legacyRestore.hashesMatched === true, restoredOk: legacyRestore.ok === true, restoreCode: legacyRestore.code ?? null, restarted: legacyRestore.restarted ?? [], rebuiltRows: legacyRestore.rebuilt ?? [], restoreFailed: legacyRestore.failed ?? [], disposedCreated };
    log('skills:legacy-restore', { ok: legacyRestore.ok, restoredFrom: legacyRestore.restoredFrom, hashesMatched: legacyRestore.hashesMatched });
    // 旧版恢复已由 skills 侧 runUpgrade（previousSnapshot + replayRow）完成；
    // **禁止**再用 previousEntryUrl 重放（旧路径已被改写，会装回新目录）。
    rollback = { ...(rollback ?? {}), restoredFrom: legacyRestore.restoredFrom ?? rollback?.restoredFrom ?? null };
  }

  const ok = report?.ok === true && readbackOk;
  /**
   * **成功后的整体回滚 handle**（guidance38 事务）：迁移成功后若后续 web/hook/postcondition
   * 失败，upgradeBundle 必须能恢复原 18 providers + 角色段。这里返回可调用的关闭：
   * 撤本次受控行 scope → 用迁移前快照重建旧行（正文 hash 读回比对）→ 刷新角色段。
   */
  let rollbackTask = null;
  const rollbackUpgrade = () => {
    if (rollbackTask) return rollbackTask;
    rollbackTask = (async () => {
    let disposedCreated = 0;
    for (const handle of createdHandles.reverse()) {
      try { handle(); disposedCreated += 1; } catch { /* dispose 失败继续回滚 */ }
    }
    const legacyRestore = await restoreLegacyRows(service, legacySnapshot, log).catch((error) => ({ ok: false, code: 'SKILLS_ROLLBACK_FAILED', message: String(error?.message ?? error), hashesMatched: false }));
    let promptRefresh = null;
    try {
      promptRefresh = typeof service.refreshSkillSections === 'function' ? await service.refreshSkillSections() : null;
    } catch (error) {
      promptRefresh = { ok: false, code: 'SKILL_SECTIONS_REFRESH_FAILED', message: String(error?.message ?? error) };
    }
    const providersAfterRollback = await collectProviders(service);
    const rollbackOk = legacyRestore.ok === true && legacyRestore.hashesMatched === true && promptRefresh?.ok !== false;
    log('skills:transaction-rollback', { ok: rollbackOk, hashesMatched: legacyRestore.hashesMatched === true, disposedCreated });
    return {
      ok: rollbackOk,
      code: rollbackOk ? null : (legacyRestore.code ?? promptRefresh?.code ?? 'SKILLS_TRANSACTION_ROLLBACK_INCOMPLETE'),
      hashesMatched: legacyRestore.hashesMatched === true,
      restoredFrom: legacyRestore.restoredFrom ?? null,
      disposedCreated,
      promptRefresh,
      providersAfter: providersAfterRollback,
    };
    })();
    return rollbackTask;
  };
  return {
    ok,
    code: ok ? null : (report?.applyErrorCode ?? 'SKILLS_MIGRATION_FAILED'),
    applicationForm: report?.applicationForm ?? (Array.isArray(report?.applicationForm) ? report.applicationForm : null),
    rollback,
    rollbackUpgrade,
    readback: readbackResult,
    providersBefore,
    providersAfter,
    plan: { rows: plan.rows.length, disabledRowIds: disabledRowIds.length, versionSkills: versionSkills.length },
    copy: { sourceRoot, newRoot, skillEntryUrl, previousEntryUrl },
    inProgress: markers.includes('in-progress') && !ok,
    markers,
  };
}
