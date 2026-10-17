/**
 * `upgrade.js` — **有界热升级入口**（Codex 审阅 5）。
 *
 * ## 目标
 *
 * 当前 DSH 进程里已有旧的 `TeamWorkbenchService` 实例（持有 teams/members/works/attempts/
 * 队列/lease/身份）。本次整改的新模块（identity/evidence/execution/fingerprints/usage/
 * findings/materialize/contextControl/nativeUsage）**不应该要求卸载插件或重启进程**才能生效：
 *
 * - 先 `planHotUpgrade(service)` 做**只读**检查与差异报告（dry-run，不改任何状态）；
 * - 再 `applyHotUpgrade(service, {confirm})` 在**保留原有对象/身份/队列**的前提下，
 *   把新组件挂到现有 service 上并把新表纳入 hydration。
 *
 * ## 有界（bounded）约束
 *
 * - 只允许一次；重复调用返回 `ALREADY_UPGRADED`（幂等，不叠加监听器/定时器）。
 * - 不卸载 `ui-recovery`、不替换现有 workbench wrapper、不改 `app.asar`、不创建新进程。
 * - 不删除任何 teams/members/works/attempts/queue/lease 记录；只新增 sidecar 表与组件。
 * - 每个步骤都有上限与失败回滚点（失败时保留旧组件引用，不让 service 处于半升级状态）。
 * - act 必须显式 `confirm:'activate'`；没有确认只返回计划。
 *
 * ⚠️ 本模块**不会自己调用**；入口由 Lead/Codex 在审阅后通过 web op
 * `op=upgrade-plan`（dry-run）与 `op=upgrade-activate`（confirm）触发，或由外部集成代码调用。
 */

export const UPGRADE_STEPS = Object.freeze([
  'verify-service-shape',
  'detect-existing-components',
  'plan-new-tables',
  'ensure-hydration',
  'attach-components',
  'register-hooks',
  'report',
]);

export const UPGRADE_MAX_TABLES = 8;

function hasMethod(target, name) {
  return Boolean(target && typeof target[name] === 'function');
}

/**
 * 只读规划：返回本次升级会做什么、缺什么、风险点。**不改任何状态**。
 */
export function planHotUpgrade(service, options = {}) {
  const problems = [];
  const existing = [];
  const missing = [];
  if (!service || typeof service !== 'object') problems.push({ code: 'SERVICE_INVALID', message: 'service 不是对象。' });
  if (service && !hasMethod(service, 'snapshot')) problems.push({ code: 'SERVICE_SHAPE', message: 'service.snapshot 不存在：不是本插件的 service。' });
  if (service && !(service.works instanceof Map)) problems.push({ code: 'SERVICE_SHAPE', message: 'service.works 不是 Map：身份/队列不会被保留，需要人工核对。' });
  if (service && !(service.members instanceof Map)) problems.push({ code: 'SERVICE_SHAPE', message: 'service.members 不是 Map。' });
  for (const component of ['identityRecords', 'evidenceRecords', 'fingerprints', 'usageLedger', 'executionRunner', 'nativeUsage', 'contextControl', 'materializer']) {
    if (service && service[component] !== undefined && service[component] !== null) existing.push(component);
    else missing.push(component);
  }
  const preserve = {
    teams: service?.teams instanceof Map ? service.teams.size : null,
    members: service?.members instanceof Map ? service.members.size : null,
    works: service?.works instanceof Map ? service.works.size : null,
    attempts: service?.attempts instanceof Map ? service.attempts.size : null,
    dispatchIntents: service?.dispatchIntents instanceof Map ? service.dispatchIntents.size : null,
  };
  const tables = Array.isArray(service?.storage?.tables) ? service.storage.tables : [];
  const requiredTables = ['identity_records', 'evidence_records', 'error_fingerprints', 'execution_runs', 'usage_requests', 'usage_cursors', 'usage_totals', 'usage_step_cursors'];
  const newTables = requiredTables.filter((table) => !tables.includes(table));
  return {
    ok: problems.length === 0,
    alreadyUpgraded: missing.length === 0 && newTables.length === 0,
    mode: 'dry-run',
    steps: UPGRADE_STEPS,
    problems,
    existing,
    missing,
    preserve,
    newTables: newTables.slice(0, UPGRADE_MAX_TABLES),
    hooks: [
      'agent/pre-step → 受管团队请求前紧凑状态注入（只覆盖受管团队）',
      'tools.guard → 受管 agent 的原生工具确定性失败预检',
      'usage 后台增量：live session 原生事件游标（不喂模型）',
    ],
    constraints: [
      '不卸载 ui-recovery、不覆盖既有 workbench wrapper、不改 app.asar、不新建进程',
      '不删除/改写 teams/members/works/attempts/queue/lease',
      '只新增 sidecar 表与组件；act 必须显式 confirm',
    ],
    note: 'dry-run 只读：确认后由 upgrade-activate 在现有 service 上挂新组件。',
  };
}

/**
 * 执行有界热升级。失败时回滚已挂组件引用。
 *
 * @param {object} service 现有 TeamWorkbenchService
 * @param {{ confirm?: string, deps?: {registerHooks?: Function, hydrate?: Function} }} options

/**
 * 执行有界热升级。
 *
 * **真实实现**在 `upgradeBundle.js` 创建的 controller 上（由 `index.js` 在 boot 段挂到
 * `service.__upgradeController`，因为它持有 ctx/注册入口/disposer）。本函数只做转交：
 * - 没有 controller → `UPGRADE_CONTROLLER_MISSING`（**明确失败**，不伪造"已挂上"）；
 * - controller 存在 → 调它的 `activate`，并要求返回 `postcondition.ok === true` 才算成功。
 *
 * @param {object} service 现有 TeamWorkbenchService
 * @param {{ confirm?: string }} options
 */
export async function applyHotUpgrade(service, options = {}) {
  const plan = planHotUpgrade(service, options);
  if (options.confirm !== 'activate') {
    return { ok: false, code: 'UPGRADE_CONFIRMATION_REQUIRED', plan, message: '需要显式 confirm:"activate"；在此之前不会改动运行中的 service。' };
  }
  const controller = service?.__upgradeController;
  if (!controller || typeof controller.activate !== 'function') {
    return {
      ok: false,
      code: 'UPGRADE_CONTROLLER_MISSING',
      plan,
      message: '热升级 controller 未挂载（缺 ctx/注册入口/disposer）：拒绝假装完成。需由插件 boot 段创建 upgradeBundle 并挂到 service.__upgradeController。',
    };
  }
  const result = await controller.activate({ triggeredBy: 'manual-activate', installableEntry: options.installableEntry });
  if (result?.ok !== true) return { ...result, plan };
  if (result.postcondition?.ok !== true) {
    return { ok: false, code: 'UPGRADE_POSTCONDITION_FAILED', plan, postcondition: result.postcondition, message: 'postcondition 未通过：不写"新组件已挂上"。' };
  }
  return { ...result, plan, upgraded: true };
}
