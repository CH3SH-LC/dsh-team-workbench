/**
 * `web.js` — 客户端 ↔ Host 线路，全部通过公开的 `ctx.webServer.register`。
 *
 * 为什么用 HTTP 线路而不是 `@Remote`：本机 rc.2 的 `@Remote` 服务需要
 * typert 的生成式装饰器（`@deepseek-ai/dsh-typert-protocol` + `__esDecorate`），
 * 而 profile 安装的插件不能可靠地 import 该包。`webServer.register` 是公开服务，
 * 且客户端与 Host 同源，因此用同源 `fetch` 是这里最窄、最可停用的通道。
 *
 * 线路只做三件事：鉴权形状检查、读 JSON 体、把请求交给**同一个** service 方法。
 * 不复制业务逻辑，也不提供任何模型可调用的越权等价物（审批与扩权不在这里）。
 */

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }
  if (res) {
    res.statusCode = status;
    if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(body);
  }
}

async function readJsonBody(req, maxBytes) {
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return { ok: true, value: {} };
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: `请求体超过 ${maxBytes} 字节` };
    chunks.push(chunk);
  }
  if (chunks.length === 0) return { ok: true, value: {} };
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'INVALID_BODY', message: '请求体必须是 JSON 对象' };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, code: 'INVALID_JSON', message: String(error?.message ?? error) };
  }
}

/** 简单同源/自定义头检查，挡掉跨站简单请求。审批与权限仍沿用 Host 既有判定。 */
function admit(req) {
  const headers = req?.headers ?? {};
  const marker = headers['x-team-workbench'];
  if (marker === undefined) return { ok: false, code: 'MISSING_CLIENT_MARKER', message: '缺少 x-team-workbench 头' };
  const origin = headers.origin;
  const host = headers.host;
  if (typeof origin === 'string' && origin !== 'null' && typeof host === 'string') {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) return { ok: false, code: 'CROSS_ORIGIN_REJECTED', message: `origin ${originHost} 与 host ${host} 不同源` };
    } catch {
      return { ok: false, code: 'CROSS_ORIGIN_REJECTED', message: '无法解析 origin' };
    }
  }
  return { ok: true };
}

/**
 * 注册工作台线路。
 *
 * @param {{ service: object, scheduler: object, adapter: object, config: object }} deps
 */
export function registerWebRoutes(deps) {
  const { service, scheduler, adapter, config } = deps;
  const base = config.web.basePath;
  const maxBytes = config.web.maxBodyBytes;
  const disposers = [];
  const routes = [];

  const handleState = async (_req, res) => {
    await service.whenReady();
    // 契约 §1：`snapshot.usage` / `snapshot.findings` / `snapshot.errorFingerprints`
    // 已由 `service.snapshot()` 产出（纯只读投影：不触发模型调用、不重扫日志、不改状态）。
    const snapshot = service.snapshot(undefined);
    json(res, 200, {
      ok: true,
      version: 1,
      basePath: base,
      snapshot,
      scheduler: scheduler?.stats?.() ?? null,
      constraints: scheduler?.constraints?.describe?.() ?? null,
      adapter: { availability: adapter.availability(), counts: adapter.counts() },
      // 客户端据此决定是否启用限定 rc.2 的右栏/焦点桥（可停用回滚）。
      // 客户端自己拿不到 Host 行配置，所以由这条公开线路下发。
      compat: config.compat,
      // 工作台只提供角色段；外部技能是否安装必须查询其实际 provider。
      skills: {
        providerName: null,
        enabled: false,
        source: null,
        note: '本插件只提供团队角色提示词段；工作流技能可单独安装。',
      },
      // 兼容旧读法：部分前端把三项直接挂在根上。
      usage: snapshot.usage,
      findings: snapshot.findings,
      errorFingerprints: snapshot.errorFingerprints,
      // 无模型/无写入自证：这条线路在 CORS/字段层面就是只读投影。
      readOnlyProjection: { modelCalls: 0, writes: 0, note: 'GET /state 只读投影：不派发、不唤醒成员、不改状态。' },
    });
  };

  /**
   * CONTRACT v2 §7.2：`GET /state/detail?section=…&kind=…&page=…&pageSize=…`（只读、分页）。
   * 与 `/state` 同级读取面：不派发、不唤醒、不改状态；全量明细不再从 `/state` 下发。
   */
  const handleStateDetail = async (req, res) => {
    await service.whenReady();
    let query = {};
    try {
      const parsed = new URL(String(req?.url ?? ''), 'http://localhost');
      query = Object.fromEntries(parsed.searchParams.entries());
    } catch {
      query = {};
    }
    const result = service.stateDetail(query);
    json(res, result?.ok === false ? 400 : 200, result);
  };
  const handleLayout = async (req, res) => {
    await service.whenReady();
    const admitted = admit(req);
    if (!admitted.ok) {
      json(res, 403, { ok: false, ...admitted });
      return;
    }
    const body = await readJsonBody(req, maxBytes);
    if (!body.ok) {
      json(res, 400, { ok: false, ...body });
      return;
    }
    const payload = body.value;
    const op = String(payload.op ?? 'get');
    let result;
    switch (op) {
      case 'get':
        result = { ok: true, layout: service.layout() };
        break;
      case 'set-mode':
        result = await service.setLayout(payload.mode, { panes: payload.panes, activePaneId: payload.activePaneId, ratios: payload.ratios, teamView: payload.teamView });
        break;
      case 'set-layout':
        result = await service.setLayout(payload.mode, payload);
        break;
      case 'upsert-pane':
        result = await service.upsertPane(payload.pane ?? payload);
        break;
      case 'remove-pane':
        result = await service.removePane(String(payload.paneId));
        break;
      case 'focus-pane':
        result = await service.focusPane(String(payload.paneId));
        break;
      default:
        result = { ok: false, code: 'UNKNOWN_OP', message: `未知布局操作 ${op}` };
    }
    json(res, result?.ok === false ? 409 : 200, { ...result, layout: service.layout() });
  };

  const handleOp = async (req, res) => {
    await service.whenReady();
    const admitted = admit(req);
    if (!admitted.ok) {
      json(res, 403, { ok: false, ...admitted });
      return;
    }
    const body = await readJsonBody(req, maxBytes);
    if (!body.ok) {
      json(res, 400, { ok: false, ...body });
      return;
    }
    const { op, args = {}, callerSessionId } = body.value;
    const caller = callerSessionId ? { id: String(callerSessionId) } : undefined;
    // 前端激活回执（`client-ack`）：纯元数据、幂等；不属于团队 dispatch 操作面。
    if (String(op) === 'client-ack') {
      const ackResult = await service.recordFrontendAck(caller, body.value);
      json(res, ackResult?.ok === false ? 400 : 200, ackResult);
      return;
    }
    const result = await dispatchOperation({ service, scheduler, op, args, caller });
    json(res, result?.ok === false ? 409 : 200, result);
  };

  const handleHealth = async (_req, res) => {
    json(res, 200, {
      ok: true,
      basePath: base,
      durable: service.storage.durable,
      readOnly: service.readOnly,
      readOnlyReason: service.readOnlyReason,
      migrationRequired: service.storage.migrationRequired,
      writerEpoch: service.storage.writerEpoch,
      adapterAvailability: adapter.availability(),
      registeredToolNames: (scheduler?.toolNames ?? null),
    });
  };

  for (const route of [
    { kind: 'exact', path: `${base}/state`, handler: handleState },
    // CONTRACT v2 §7.2：冻结的只读明细分页路由（client 已按此实现）。
    { kind: 'exact', path: `${base}/state/detail`, handler: handleStateDetail },
    { kind: 'exact', path: `${base}/layout`, handler: handleLayout },
    { kind: 'exact', path: `${base}/op`, handler: handleOp },
    { kind: 'exact', path: `${base}/health`, handler: handleHealth },
  ]) {
    const registered = adapter.registerWebRoute(route);
    if (registered.ok) {
      routes.push(route.path);
      if (typeof registered.value === 'function') disposers.push(registered.value);
    }
  }

  return {
    routes,
    basePath: base,
    dispose() {
      for (const disposer of disposers.splice(0)) {
        try {
          disposer();
        } catch {
          /* 卸载路径 */
        }
      }
    },
  };
}

/**
 * UI 与工具共用的操作分发。`caller` 由线路从会话 id 还原为真实 Agent
 * （`service.actor` 内部只用 `adapter.agentFor` 取 live Agent，绝不伪造）。
 */
export async function dispatchOperation({ service, scheduler, op, args, caller }) {
  await service.whenReady();
  switch (op) {
    case 'snapshot':
      return { ok: true, snapshot: service.snapshot(caller) };
    case 'define-team':
      return service.defineTeam(caller, args);
    case 'create-member':
      return service.createMember(caller, { ...args, prompt: args.prompt ? [{ type: 'text', text: args.prompt }] : undefined });
    case 'submit-work':
      return service.submitWork(caller, args);
    case 'claim-work':
      return service.claimWork(caller, args);
    case 'report-work':
      return service.reportWork(caller, args);
    case 'start-subagent': {
      // 与工具层共用同一个**幂等定向启动入口**（修缺陷 B，避免逻辑分叉）。
      const actor = service.actor(caller);
      if (!actor.ok) return actor;
      const result = await service.subagentStart(actor, args);
      if (result?.ok && !result.reused) scheduler?.notify('ui:subagent-started', { workId: result.workId, attemptId: result.attemptId });
      return result;
    }
    case 'mission-assign':
      return service.missionAssign(caller, args);
    case 'plan-submit':
      return service.planSubmit(caller, args);
    case 'dispatch-authorize':
      return service.dispatchAuthorize(caller, args);
    case 'plan-cancel':
    case 'cancel_work':
      // 取消**未来**派发：不杀在跑 attempt。接受 `workId`（单个，UI 用法）与 `workIds`（批量）。
      return service.planCancel(caller, {
        ...args,
        workIds: Array.isArray(args.workIds) ? args.workIds : (args.workId ? [String(args.workId)] : []),
      });
    case 'work-verify':
      return service.workVerify(caller, args);
    case 'self-report':
    case 'work-self-report':
      // 契约 §14：`execution:self` 的完成通路（不依赖 attempt）。走同一幂等入口。
      return service.selfReport(caller, args);
    case 'work-report':
      return service.reportWork(caller, args);
    case 'member-inbox':
      return service.memberInbox(caller, args);
    case 'ask-owner':
      return service.askOwner(caller, args);
    case 'user_instruction':
      return service.userInstruction(caller, args);
    case 'pause_dispatch':
      return service.pauseDispatch(caller, { ...args, paused: true, action: 'pause' });
    case 'resume_dispatch':
      return service.pauseDispatch(caller, { ...args, paused: false, action: 'resume' });
    case 'stop_turn':
      return service.stopMemberTurn(caller, args);
    case 'stop_team':
      return service.interruptTeam(caller, { ...args, scope: args.scope ?? 'team' });
    case 'interrupt':
      if (args.scope === 'members' || args.scope === 'team') return service.interruptTeam(caller, args);
      return service.interruptWork(caller, args);
    case 'reconcile':
      return { ok: true, report: await service.reconcile() };
    case 'layout':
      return { ok: true, layout: service.layout() };
    // ---- 2026-10-17 整改：契约 §1 的后台接口（前端只读消费；明细分页）----------
    case 'usage':
    case 'usage-summary':
      return { ok: true, usage: service.usageSnapshot({ teamKey: args.teamKey ?? null }) };
    case 'usage-records':
      return service.usageRecords({ cursor: args.cursor, limit: args.limit, provider: args.provider, model: args.model });
    case 'usage-pricing':
      return service.usagePricing();
    case 'usage-refresh':
      // 原生 session 事件增量归账（幂等）。不触发任何模型调用。
      return service.refreshUsage({ mode: args.mode === 'baseline' ? 'baseline' : 'native', maxBytes: args.maxBytes });
    case 'usage-backfill':
      // 首次历史补录（程序化折账，不喂模型；只进 cumulative，不计入本阶段）。
      return service.backfillUsage();
    // ---- 生产维护入口（lead/root）：只读检查 + expectedSeq/requestKey 的持久 once 压缩 -----
    case 'maintenance':
    case 'maintenance-inspect':
      // 默认只读检查；显式 args.op==='compact' 才触发压缩（避免误触）。
      if (args.op === 'compact') return service.requestMaintenance(caller, { ...args, via: '/op maintenance' });
      return service.maintenanceInspect(caller, args);
    case 'maintenance-compact':
      return service.requestMaintenance(caller, { ...args, via: '/op maintenance' });
    case 'upgrade-plan':
      return service.upgradePlan(caller);
    case 'upgrade-activate':
      // 有界热升级：必须显式 confirm:'activate'；未确认只返回计划。
      return service.upgradeActivate(caller, { confirm: args.confirm });
    case 'context-stats':
      return { ok: true, contextControl: service.contextControl.snapshot() };
    case 'findings':
      return { ok: true, findings: service.findingsSnapshot({ teamKey: args.teamKey ?? null, force: args.force === true }) };
    case 'error-fingerprints':
    case 'errorFingerprints':
      return { ok: true, errorFingerprints: service.errorFingerprintSnapshot({ teamKey: args.teamKey ?? null, limit: args.limit }) };
    case 'exec-check':
    case 'exec_check':
      return service.runVerification(caller, args);
    case 'exec-runs':
      return { ok: true, runs: service.runsForWork(args.workId) };
    case 'materialize':
      return service.materialize(caller, args);
    case 'context-query':
    case 'context_query':
      return service.contextQuery(caller, args);
    default:
      return { ok: false, code: 'UNKNOWN_OP', message: `未知操作 ${op}` };
  }
}
