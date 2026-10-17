/**
 * `contextControl.js` — 受管团队的**请求前紧凑状态注入** + **原生工具守卫**（Codex 审阅要求 2）。
 *
 * 两件事都用**正式宿主挂钩**，不是 helper 空转：
 *
 * 1. `agent/pre-step`（waterfall，官方合同见 `cordis_inspect_query(Event, agent/pre-step)`）：
 *    payload `{agent, messages, turn, step, signal}`，返回
 *    `{kind:'enter', messages, startsRequestSeries?}`。我们在 `next()` 之后给**受管成员/leaf**
 *    追加一条**紧凑状态消息**（指针 + 未完成项 + 错误指纹指导 + 来源统计），受字符预算约束；
 *    消息对象通过**克隆现有 user message** 得到（保持 MessageBase 形状，不自己拼字段）。
 *    - 只覆盖受管团队；不吞队列、不换 owner、不做全局压缩、不改别人的消息序列。
 *    - 失败安全：任何异常都返回原 decision 并记诊断（不阻断 turn）。
 *
 * 2. `tools.guard`（官方合同 `ToolGuard = (execution) => string | undefined`）：
 *    对**原生工具**（read/edit/pwsh/…）在受管成员/leaf 上做**确定性失败预检**：
 *    同一「操作 + 规范化输入 + 产物/依赖版本 + 读取 epoch」已经确定性失败过，就直接拒绝并
 *    给出"改什么条件才重试"，而不是让模型再撞一次（不烧 attempt / 不刷模型）。
 *    非受管 agent、无活跃 work、无历史确定性失败时一律放行。
 */

import { buildOperationDescriptor, CLASSIFY_ERROR_FALLBACK, retryGuidance } from './fingerprints.js';

/** 通用派生工具（model 直接调用，绕过受管 team_subagent_start 的路径）。 */


/**
 * 派生守卫的**纯决策**（可单测）：受管团队 agent 调通用派生工具时，必须能证明 work/attempt 关联；
 * 否则拒绝（`SUBAGENT_DERIVATION_UNMANAGED`）。受管路径 `team_subagent_start` 不在此限制内。
 */
/**
 * 派生守卫的**纯决策**（Lead 第 20/21 回合最小正确策略）
 *
 * - 受管 agent 的**新通用派生一律拒绝**（`SUBAGENT_DERIVATION_USE_MANAGED`）：即使拥有 work，
 *   也不能证明本次新子任务经过了身份/重叠/容量/阶段/禁止转抄校验 → 必须转 `team_subagent_start`；
 * - 唯一例外是 **Host 生成的一次性授权**（绑定真实 workId/owner/epcoh，消费即失效）；
 *   不接受 `execution.arguments`/prompt 里的 `missionAuthorized:true` 自报；
 * - 正在跑的 children 不受影响（guard 只约束新创建调用）。
 */
export const DERIVATION_TOOLS = Object.freeze(['subagent', 'subagent_fork', 'spawn_teammate', 'subagent_start']);

/** 真实"读取基准"工具：成功后更新读取 epoch（失败重试的前置条件才算真正变化）。 */
export const READ_TOOL_NAMES = Object.freeze(['read', 'glob', 'grep', 'read_image']);

export function derivationGuardDecision({ tool, actor, authorization = null }) {
  const name = String(tool ?? '');
  if (!DERIVATION_TOOLS.includes(name)) return { apply: false };
  if (!actor) return { apply: false };
  const granted = authorization
    && authorization.ok === true
    && typeof authorization.workId === 'string' && authorization.workId
    && String(authorization.ownerMemberId ?? '') === String(actor.memberId ?? '');
  if (granted) return { apply: true, allow: true, code: null, authorization };
  return {
    apply: true,
    allow: false,
    code: 'SUBAGENT_DERIVATION_USE_MANAGED',
    reason: `受管团队 agent 直接调用 ${name} 不能证明本次新子任务经过身份/重叠/容量/阶段/禁止转抄校验。`,
    guidance: '改用 team_subagent_start（受管路径：绑定 workId → attempt → child，Host 校验全部前置）；确需官方管理器时，请由 Host 先生成绑定本次 workId/owner 的一次性授权，不接受自报 missionAuthorized。',
  };
}
export function extractToolError(result) {
  if (!result || result.isError !== true) return null;
  const explicitCode = result?.error?.code ?? result?.code ?? null;
  const explicitMessage = result?.error?.message ?? result?.message ?? null;
  const blocks = Array.isArray(result?.content)
    ? result.content
    : (typeof result?.content === 'string' ? [{ type: 'text', text: result.content }] : []);
  const texts = blocks.map((block) => (typeof block === 'string' ? block : String(block?.text ?? ''))).filter(Boolean);
  const text = texts.join('\n');
  const exitMatch = text.match(/\[exit code:\s*(-?\d+)\]/i);
  const codeMatch = text.match(/\b([A-Z][A-Z0-9_]{2,})\b/);
  const code = typeof explicitCode === 'string' && explicitCode
    ? explicitCode
    : (exitMatch ? `EXIT_${exitMatch[1]}` : (codeMatch ? codeMatch[1] : 'TOOL_RESULT_ERROR'));
  const message = typeof explicitMessage === 'string' && explicitMessage ? explicitMessage : text.slice(0, 300);
  return { code, message, exitCode: exitMatch ? Number(exitMatch[1]) : null, source: explicitCode ? 'result.error' : (exitMatch ? 'content:exit-code' : (codeMatch ? 'content:error-code' : 'content:text')) };
}

export const CONTEXT_CONTROL_DEFAULTS = Object.freeze({
  /** 注入开关：'inject' | 'stats-only' | 'off'。默认 inject；可被配置降级。 */
  mode: 'inject',
  /** 每次注入的字符预算（硬上限，超出只截断尾巴并标记）。 */
  maxChars: 1200,
  /** 最多列多少个未完成 work 指针。 */
  maxItems: 5,
  /** 原生工具守卫开关（确定性失败预检）。 */
  guardNativeTools: true,
});

function truncate(text, maxChars) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: `${value.slice(0, Math.max(0, maxChars - 20))}\n…（已截断，原件在 Host）`, truncated: true };
}

/**
 * 构造注入文本（纯函数，便于测试）。
 *
 * P2-9：**关键事实优先于长路径**。错误/被否决方案/接口版本/下一步原件入口先占预算；
 * 每个产物指针都缩成有界字符串（原件在磁盘按需取），因此注入既不会超出字符预算，
 * 也不会因为前面几条超长产物路径把已知失败事实挤掉。
 *
 * @param {object} state `{ memberId, teamKey, works: [...], fingerprints: [...], inbox: {pending, byType}, lastProgress }`
 */
export function buildCompactContextText(state, options = {}) {
  const config = { ...CONTEXT_CONTROL_DEFAULTS, ...(options ?? {}) };
  const budget = Math.max(200, Number(config.maxChars) || 1200);
  const clip = (value, max) => {
    const text = String(value ?? '');
    return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 14))}…（原件在 Host）`;
  };
  const header = `[受管任务紧凑状态] member=${state?.memberId ?? '?'} team=${state?.teamKey ?? '?'}（Host 注入；只含指针，原件在磁盘）`;
  const inbox = state?.inbox ?? { pending: 0, byType: {} };
  const inboxLine = `- 待处理事件：${inbox.pending ?? 0} 条${Object.keys(inbox.byType ?? {}).length > 0 ? `（${Object.entries(inbox.byType ?? {}).map(([type, count]) => `${type}×${count}`).join('、')}）` : ''}`;
  const works = Array.isArray(state?.works) ? state.works : [];
  const prints = Array.isArray(state?.fingerprints) ? state.fingerprints : [];

  // ---- 优先级 1：关键事实（已知失败 / 被否决方案 / 接口版本 / 原件查询入口）----
  const factLines = [];
  for (const group of prints.slice(0, 3)) {
    factLines.push(`- 已知失败 ${group.code ?? 'ERROR'}（×${group.count ?? 1}）：${clip(group.guidance ?? group.message ?? '已在 Host 记录，勿原样重试', 150)}`);
  }
  const knownFailures = works
    .filter((work) => typeof work?.lastFailureMessage === 'string' && work.lastFailureMessage.trim())
    .slice(0, 3);
  for (const work of knownFailures) {
    factLines.push(`- ${clip(work.workId, 60)} 已知失败：${clip(work.lastFailureMessage, 150)}`);
  }
  const interfaceFacts = [];
  for (const work of works) {
    for (const dep of (Array.isArray(work?.artifactDependencies) ? work.artifactDependencies : []).slice(0, 2)) {
      if (!dep?.artifact) continue;
      interfaceFacts.push(`${clip(dep.artifact, 60)}@v${dep.version ?? '?'}(${dep.requires ?? '?'})`);
      if (interfaceFacts.length >= 3) break;
    }
    if (interfaceFacts.length >= 3) break;
  }
  if (interfaceFacts.length > 0) factLines.push(`- 接口版本：${interfaceFacts.join('、')}`);
  factLines.push('- 完整事实/被否决方案/原件：team_context_query（分页取，不会把原件塞进上下文）。');

  // ---- 优先级 2：work 指针（长路径缩成有界指针）----
  const workLines = [];
  if (works.length === 0) workLines.push('- 当前没有你负责的受管 work。');
  for (const work of works.slice(0, config.maxItems)) {
    const bits = [`${clip(work.workId, 80)}[${work.state}]`];
    if (Array.isArray(work.missing) && work.missing.length > 0) bits.push(`缺：${clip(work.missing.slice(0, 3).join('/'), 60)}`);
    if (work.blockedReason) bits.push(`阻塞：${clip(work.blockedReason, 60)}`);
    if (Array.isArray(work.outputs) && work.outputs.length > 0) bits.push(`产物：${work.outputs.slice(0, 2).map((item) => clip(item, 110)).join(',')}`);
    workLines.push(`- ${bits.join('；')}`);
  }
  if (works.length > config.maxItems) workLines.push(`- …另有 ${works.length - config.maxItems} 个 work（用 team_context_query 分页看）。`);

  // ---- 按预算装配：先事实，再指针；放不下的行明确记为已截断 ----
  const lines = [header, inboxLine];
  let used = header.length + inboxLine.length + 2;
  let truncated = false;
  const tailReserve = 30; // 截断提示的预算
  for (const line of factLines) {
    if (used + line.length + 1 > budget - tailReserve) { truncated = true; break; }
    lines.push(line);
    used += line.length + 1;
  }
  for (const line of workLines) {
    if (used + line.length + 1 > budget - tailReserve) { truncated = true; break; }
    lines.push(line);
    used += line.length + 1;
  }
  const progressLine = state?.lastProgress?.text ? `- 最近有效进展：${clip(state.lastProgress.text, 160)}` : null;
  if (progressLine && used + progressLine.length + 1 <= budget - tailReserve) {
    lines.push(progressLine);
    used += progressLine.length + 1;
  } else if (progressLine) {
    truncated = true;
  }
  const hint = '- 验收必须用 team_exec_check 拿 runId 再 team_work_verify；空证据/命令字符串不算证据。';
  if (used + hint.length + 1 <= budget) {
    lines.push(hint);
    used += hint.length + 1;
  } else {
    truncated = true;
  }
  if (truncated) lines.push('…（已截断，原件在 Host：用 team_context_query 按需取）');
  let text = lines.join('\n');
  if (text.length > budget) text = truncate(text, budget).text;
  return { text, truncated: truncated || text.length >= budget, lines: lines.length, chars: text.length };
}

/**
 * 创建受管团队的上下文控制器。
 *
 * @param {{
 *   service: object, config: object, clock?: {now:()=>number}, diagnostics?: object,
 *   compactStateFor?: (agent:object)=>object|null,
 * }} deps
 */
export function createContextControl(deps = {}) {
  const service = deps.service;
  const clock = deps.clock ?? { now: () => Date.now() };
  const diagnostics = deps.diagnostics ?? null;
  const options = {
    ...CONTEXT_CONTROL_DEFAULTS,
    ...(deps.config?.context && typeof deps.config.context === 'object' ? deps.config.context : {}),
  };
  const stats = {
    preStepCalls: 0,
    injected: 0,
    skipped: 0,
    errors: 0,
    charsInjected: 0,
    truncated: 0,
    guardChecks: 0,
    guardDenied: 0,
    lastInjectedAt: 0,
    lastGuardAt: 0,
    // ---- 真实请求输入测量（Lead 第 12 回合 B）：只测量，不自造压缩 ----
    inputChars: 0,
    inputTokensEst: 0,
    injectedChars: 0,
    budgetChars: 0,
    budgetRemaining: 0,
    contextWindow: null,
    source: 'unavailable',
    measuredSteps: 0,
    // ---- tools/result 真实失败生产者（第 12 回合 A）----
    toolResults: 0,
    toolFailuresRecorded: 0,
    // ---- 可观察计数（Lead 最后一批 A）：供 hooks-wired postcondition 读回 ----
    toolResultCalls: 0,
    toolFailureRecords: 0,
    guardEvaluated: 0,
    lastGuardBlock: null,
  };

  function note(code, message) {
    if (diagnostics && typeof diagnostics.push === 'function') diagnostics.push(code, message);
  }

  /** 解析受管身份（member/lead/leaf-of-managed-team），拿不到就返回 null。 */
  function managedActor(agent) {
    if (!agent) return null;
    if (typeof service?.actor !== 'function') return null;
    const actor = service.actor(agent);
    if (!actor || actor.ok !== true) return null;
    // 只看受管团队：member 一定在 members 表里；leaf 需要用 attempt 归属确认。
    if (actor.role === 'member' || actor.role === 'lead') return actor;
    if (typeof service?.findExecutorAttempt === 'function') {
      const attempt = service.findExecutorAttempt(String(agent.id), null);
      if (attempt) return { ...actor, role: 'leaf', memberId: attempt.ownerMemberId, teamKey: attempt.teamKey, workId: attempt.workId };
    }
    return null;
  }

  /**
   * `agent/pre-step` 监听器。
   * @param {{agent:object, messages:object[], turn:number, step:number}} payload
   * @param {() => Promise<{kind:string, messages?:object[]}>} next
   */
  async function onPreStep(payload, next) {
    stats.preStepCalls += 1;
    const decision = await next();
    try {
      if (options.mode === 'off') return decision;
      if (!decision || decision.kind !== 'enter') return decision;
      const messages = Array.isArray(decision.messages) ? decision.messages : [];
      // ---- 真实请求输入测量（只测量；不自造压缩、不改全局压缩）----
      const contextWindow = Number.isFinite(Number(payload?.preparedCall?.context?.contextWindow))
        ? Number(payload.preparedCall.context.contextWindow)
        : (Number.isFinite(Number(payload?.contextWindow)) ? Number(payload.contextWindow)
          : (Number.isFinite(Number(payload?.agent?.contextWindow)) ? Number(payload.agent.contextWindow) : null));
      const inputChars = messages.reduce((sum, message) => sum + JSON.stringify(message?.content ?? message ?? '').length, 0);
      // 保守估算：约 2 字符/token（中文为主）+ 每条消息固定开销；不把估算当精确值。
      const inputTokensEst = Math.ceil(inputChars / 2) + messages.length * 8;
      stats.inputChars = inputChars;
      stats.inputTokensEst = inputTokensEst;
      stats.contextWindow = contextWindow;
      stats.measuredSteps += 1;
      stats.source = contextWindow === null ? 'unavailable' : 'pre-step:contextWindow';
      const budgetChars = options.maxChars;
      const injectableChars = contextWindow === null
        ? budgetChars // 窗口未知：只用插件自己的字符预算
        : Math.max(0, Math.min(budgetChars, (contextWindow - inputTokensEst) * 2));
      stats.budgetChars = injectableChars;
      const actor = managedActor(payload?.agent);
      if (!actor) {
        stats.skipped += 1;
        stats.budgetRemaining = injectableChars;
        return decision;
      }
      const state = typeof deps.compactStateFor === 'function' ? deps.compactStateFor(payload.agent) : null;
      if (!state) {
        stats.skipped += 1;
        stats.budgetRemaining = injectableChars;
        return decision;
      }
      const built = buildCompactContextText(state, options);
      if (!built.text) {
        stats.skipped += 1;
        stats.budgetRemaining = injectableChars;
        return decision;
      }
      if (options.mode === 'stats-only') {
        stats.skipped += 1;
        stats.budgetRemaining = injectableChars;
        note('context:pre-step:stats-only', `member=${actor.memberId} 本可注入 ${built.chars} 字符（mode=stats-only）。`);
        return decision;
      }
      // **预算内注入**：注入量不得超出预算剩余（窗口未知时用插件预算）。
      // P2-9：budgetChars 与实际注入必须一致——超预算时截断到真实预算内（保留“原件在 Host”指针），
      // 不再用另一套字符数注入后把 budgetChars 记成更小的值。
      const budgetFloor = 200;
      const capped = built.chars > injectableChars ? truncate(built.text, Math.max(budgetFloor, injectableChars)) : null;
      const finalText = capped ? capped.text : built.text;
      const finalChars = finalText.length;
      if (finalChars > injectableChars) {
        stats.skipped += 1;
        stats.budgetRemaining = 0;
        note('context:pre-step:over-budget', `member=${actor.memberId}: 需要 ${built.chars} 字符，预算剩余 ${injectableChars}，跳过注入（不压缩历史）。`);
        return decision;
      }
      // 克隆现有 user message 保持 MessageBase 形状；没有模板就不注入（不自己拼字段）。
      const template = [...messages].reverse().find((message) => message && message.role === 'user');
      if (!template) {
        stats.skipped += 1;
        stats.budgetRemaining = injectableChars;
        note('context:pre-step:no-template', `member=${actor.memberId}: 没有可克隆的 user message，跳过注入。`);
        return decision;
      }
      const injected = {
        ...template,
        content: [{ type: 'text', text: finalText }],
      };
      stats.injected += 1;
      stats.charsInjected += finalChars;
      stats.injectedChars = stats.charsInjected;
      stats.budgetRemaining = Math.max(0, injectableChars - finalChars);
      if (built.truncated || capped?.truncated) stats.truncated += 1;
      stats.lastInjectedAt = clock.now();
      return { ...decision, messages: [...messages, injected] };
    } catch (error) {
      stats.errors += 1;
      note('context:pre-step:error', String(error?.message ?? error));
      return decision;
    }
  }

  /** 该 agent 的活跃 work（用于确定"真实环境版本"）。 */
  function activeWorkOf(actor) {
    if (!actor || !service?.works) return null;
    const works = [...service.works.values()];
    if (actor.workId) return works.find((work) => work.workId === actor.workId) ?? null;
    // 原生 team id → sidecar teamKey：统一走 service.resolveTeamKey/isSameTeam（不能字符串直比较）。
    return works.find((work) => {
      const sameTeam = typeof service?.isSameTeam === 'function'
        ? service.isSameTeam(actor, work.teamKey)
        : work.teamKey === actor.teamKey;
      return sameTeam && work.ownerMemberId === actor.memberId && ['executing', 'self_running', 'ready', 'dispatch_authorized', 'planned'].includes(work.state);
    }) ?? null;
  }

  /**
   * 原生工具守卫：只对受管成员/leaf 的**确定性失败**做预检。
   * @param {Readonly<{name:string, arguments:unknown, agent?:object}>} execution
   * @returns {string|undefined} 返回字符串 = 拒绝
   */
  function guardNativeTool(execution) {
    if (options.guardNativeTools === false) return undefined;
    stats.guardChecks += 1;
    stats.guardEvaluated += 1;
    try {
      const name = String(execution?.name ?? '');
      // 受管 team_* 工具自己已经有权威校验；这里只管**原生工具**（read/edit/pwsh/…）。
      if (!name || name.startsWith('team_')) return undefined;
      const actor = managedActor(execution?.agent);
      if (!actor) return undefined;
      const work = activeWorkOf(actor);
      // A. 通用 subagent 绕过拦截（Lead 第 20 回合）：受管 agent 直接调 subagent/subagent_fork/
      //    spawn_teammate 必须能证明 work/attempt 关联；受管 leaf 路径（team_subagent_start）不在此列。
      if (DERIVATION_TOOLS.includes(name)) {
        const attempt = typeof service?.findExecutorAttempt === 'function'
          ? service.findExecutorAttempt(String(execution?.agent?.id ?? ''), null)
          : null;
        // 只接受 **Host 生成、绑定本次 work/owner、一次性消费** 的授权；不接受 arguments/prompt 自报。
        const authorization = typeof service?.consumeDerivationAuthorization === 'function'
          ? service.consumeDerivationAuthorization({ tool: name, agent: execution?.agent })
          : null;
        const decision = derivationGuardDecision({ tool: name, actor, authorization });
        if (decision.apply === true && decision.allow === false) {
          stats.guardDenied += 1;
          stats.lastGuardBlock = { tool: name, agentId: String(execution?.agent?.id ?? ''), code: decision.code, at: clock.now() };
          stats.lastGuardAt = clock.now();
          note('context:guard:unmanaged-derivation', `${actor.memberId}: ${name} → ${decision.code}`);
          if (typeof service?.recordToolFailure === 'function') {
            void service.recordToolFailure(buildOperationDescriptor({
              tool: name,
              input: execution?.arguments ?? null,
              versions: (work?.artifactRefs ?? []).map((item) => `${item.path}@${item.version ?? 1}`),
              readEpoch: work ? { planRevision: work.planRevision ?? null, rev: work.rev } : null,
              code: decision.code,
              message: decision.reason,
              memberId: actor.memberId ?? null,
              workId: work?.workId ?? actor.workId ?? null,
            }), { isError: true });
          }
          return `${decision.code}：${decision.reason}\n${decision.guidance}`;
        }
        return undefined;
      }
      if (work === null) return undefined; // 没有受管 context 时不拦普通原生工具
      // P1-2：失败记录与前置 guard 共用**同一个读取 epoch**（service.toolReadEpoch：固定形状 +
      // 真实文件 epoch + 成功 read 的 readSeq）。字段缺省/None 差异不再造成漏拦。
      const environment = {
        workId: work.workId,
        planRevision: work.planRevision ?? null,
        versions: (work.artifactRefs ?? []).map((item) => `${item.path}@${item.version ?? 1}`),
        rev: work.rev,
        readEpoch: typeof service.toolReadEpoch === 'function' ? service.toolReadEpoch(work) : null,
      };
      const matched = typeof service?.findRepeatedFailure === 'function'
        ? service.findRepeatedFailure({ tool: name, input: execution?.arguments, environment })
        : null;
      if (!matched || matched.skip !== true) return undefined;
      stats.guardDenied += 1;
          stats.lastGuardBlock = { tool: name, agentId: String(execution?.agent?.id ?? ''), code: matched?.code ?? "REPEATED_DETERMINISTIC_FAILURE", at: clock.now() };
      stats.lastGuardAt = clock.now();
      return [
        `受管任务守卫：${name} 在相同输入/版本上已经确定性失败过（${matched.code ?? 'UNKNOWN'} × ${matched.count ?? 1}），平台不会重复执行同一失败。`,
        retryGuidance({ errorClass: matched.errorClass ?? 'deterministic', code: matched.code, tool: name }) || CLASSIFY_ERROR_FALLBACK,
        '改一个条件（参数/产物版本/依赖版本/换等价合法工具）后再试；`force:true` 不是无条件绕过，需说明理由且同一条件最多一次。',
      ].join('\n');
    } catch (error) {
      stats.errors += 1;
      note('context:guard:error', String(error?.message ?? error));
      return undefined; // fail-open：守卫失败不能阻断正常工具
    }
  }

  /**
   * `tools/result` 真实失败生产者（Lead 第 12 回合 A）。
   *
   * 官方签名（`dsh-tools/lib/index.js:3408-3424`）：emit 的 callback 收到 `(exec, result)`；
   * `result.isError === true` 才是失败。用**同一个** `buildOperationDescriptor` 生成指纹
   * （与 guard 预检共用），写进 sidecar 错误指纹表供后续拦截与展示。
   * 成功结果不记失败；非受管 agent 一律忽略（不污染其他团队）。
   */
  async function onToolResult(execution, result) {
    stats.toolResults += 1;
    stats.toolResultCalls += 1;
    try {
      const actor = managedActor(execution?.agent);
      if (!actor) return null;
      const work = activeWorkOf(actor);
      if (!work) return null;
      const name = String(execution?.name ?? 'unknown');
      const extracted = extractToolError(result);
      if (!extracted) {
        // P1-2 / 审计 F：**真实成功的 read/grep/glob 更新读取 epoch**，之后同一 edit 失败可以合理重试；
        // 没有重新读取就原样重试仍会被 guard 拦住（不是"全放行"）。
        if (READ_TOOL_NAMES.includes(name) && typeof service.noteToolReadSuccess === 'function') {
          service.noteToolReadSuccess(work);
          stats.readEpochResets = (stats.readEpochResets ?? 0) + 1;
          if (typeof service.captureFileEpoch === 'function') {
            try { await service.captureFileEpoch(work); } catch { /* epoch 读取失败不阻断 */ }
          }
        }
        return null;
      }
      const descriptor = buildOperationDescriptor({
        tool: name,
        input: execution?.arguments ?? null,
        versions: (work?.artifactRefs ?? []).map((item) => `${item.path}@${item.version ?? 1}`),
        // 与 guard 预检同一形状（含 files/readSeq）；失败记录时把当时的读取基准固化下来。
        readEpoch: typeof service.toolReadEpoch === 'function' ? service.toolReadEpoch(work) : null,
        code: extracted.code,
        message: extracted.message,
        memberId: actor.memberId ?? null,
        workId: work?.workId ?? actor.workId ?? null,
        attemptId: work?.lastAttemptId ?? work?.activeAttemptId ?? null,
      });
      stats.toolFailuresRecorded += 1;
      stats.toolFailureRecords += 1;
      if (typeof service?.recordToolFailure === 'function') return await service.recordToolFailure(descriptor, result);
      return null;
    } catch (error) {
      stats.errors += 1;
      note('context:tool-result:error', String(error?.message ?? error));
      return null;
    }
  }

  function snapshot() {
    return {
      mode: options.mode,
      guardNativeTools: options.guardNativeTools,
      maxChars: options.maxChars,
      maxItems: options.maxItems,
      stats: { ...stats },
      note: 'pre-step 只对受管团队注入紧凑指针（不吞队列/不换 owner/不做全局压缩）；原生工具守卫只拦"同输入同版本的确定性失败"。',
    };
  }

  return { onPreStep, guardNativeTool, onToolResult, managedActor, snapshot, options };
}

export const CONTEXT_CONTROL_MODE = Object.freeze(['inject', 'stats-only', 'off']);
