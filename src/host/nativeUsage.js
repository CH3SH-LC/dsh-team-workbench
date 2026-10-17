/**
 * `nativeUsage.js` — **当前宿主的真实增量计费**（Codex 审阅要求 1）。
 *
 * ## 为什么不能只轮询审计 JSONL
 *
 * 离线冻结的 requests.jsonl 只能做验收重放，不能代表当前会话的新增费用。
 * 生产归账必须来自**当前宿主运行中的原生会话事件**：
 * `Session.snapshotEvents(fromSeq)`（`sessionProjections` 合同里同一套 `SessionEvent` 形状），
 * 其中 `assistant/message` 事件带 `usage: TokenUsage`、`assistant/attempt` 事件是同一
 * `(turn,step)` 的流式/重试尝试。
 *
 * ## 归账语义（与 `usage.js` 的 foldBillingUnits 对齐）
 *
 * - 每个 live Agent 的 `agent.session` 作为游标源：`snapshotEvents(cursorSeq)` 只取新增事件。
 * - `assistant/message` → 计费单元（带 usage / provider / model）。
 * - `assistant/attempt` → 同一请求的流式/重试；由 `usage.js` 的 billingKey 规则去重，
 *   第 2 个及以后按**真实 retry** 独立计数。
 * - 缺 usage → unknown（不猜 token）；真实嵌套流项 `{type:'chunk',chunk:{type:'usage',usage}}` 必须解析。
 * - 页内 `request/header` 的 provider/model **页内继承并跨页保留**（collector 内存 + 游标 meta）。
 * - **只有账本持久化成功才推进游标**：失败可重新采到，不假成功。
 * - `maxSessions` 采用**公平轮换**：稳定的前 N 个会话不能饿死其后会话。
 * - live 与 history 走同一串行链（single-flight 等价）：同一事件只结算一次。
 *
 * ## 边界
 *
 * - 只读 `session.snapshotEvents` / `session.header`；绝不 mutate、不 append、不触发模型。
 * - 每次收集有 `maxEventsPerSession` / `maxSessions` 上限，避免长时间占用事件循环。
 */

import { emptyBudget } from './usage.js';

export const NATIVE_USAGE_SOURCE = 'native-session-events';

/** 从**嵌套** stream/对象里找 TokenUsage（nested stream usage=null 修复）。 */
function deepUsage(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return null;
  const tokens = value.input_tokens ?? value.prompt_tokens ?? value.inputTokens;
  if (Number.isFinite(tokens)) {
    return value.usage && typeof value.usage === 'object' ? value.usage : value;
  }
  for (const key of ['usage', 'message', 'delta', 'stream', 'chunks', 'chunk', 'choices', 'response', 'body']) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      for (let index = nested.length - 1; index >= 0; index -= 1) {
        const found = deepUsage(nested[index], depth + 1);
        if (found) return found;
      }
      continue;
    }
    const found = deepUsage(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

/** 从 `data.stream` 的 usage chunk 提取 TokenUsage（真实形状 `{type:'chunk',chunk:{type:'usage',usage}}`）。 */
function usageFromStream(stream) {
  const chunks = Array.isArray(stream) ? stream : (Array.isArray(stream?.chunks) ? stream.chunks : []);
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    if (!chunk || typeof chunk !== 'object') continue;
    const inner = chunk.chunk && typeof chunk.chunk === 'object' ? chunk.chunk : null;
    if (inner && (inner.type === 'usage' || inner.usage !== undefined)) {
      const usage = inner.usage ?? inner;
      if (usage && typeof usage === 'object') return usage;
    }
    if (chunk.type === 'usage' && chunk.usage !== undefined) {
      const usage = chunk.usage ?? chunk;
      if (usage && typeof usage === 'object') return usage;
    }
    if (chunk.usage !== undefined && typeof chunk.usage === 'object') return chunk.usage;
  }
  return deepUsage(stream);
}

/** 结算请求相关的事件 type（assistant/attempt = 失败/重试/取消/stream-error；summary 独立类型）。 */
const USAGE_EVENT_TYPES = new Set(['assistant/message', 'assistant/attempt', 'compaction/summary', 'compaction/message', 'session/compaction']);

/** 从 request/header 事件提取路由（页内继承 + 跨页由 collector 持久保留）。 */
function routeFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type ?? '');
  if (type !== 'request/header' && type !== 'request/start' && type !== 'session/header') return null;
  const data = event.data ?? {};
  const header = data.header ?? data;
  const config = header?.config ?? header?.providerConfig ?? null;
  const provider = config?.provider ?? header?.provider ?? data.provider ?? null;
  const model = config?.model ?? header?.model ?? data.model ?? null;
  if (typeof provider !== 'string' && typeof model !== 'string') return null;
  return {
    provider: typeof provider === 'string' ? provider : null,
    model: typeof model === 'string' ? model : null,
  };
}

/** 从一条 `session/event` 提取计费相关字段；与 `assistant/message` / `assistant/attempt` / summary 对齐。 */
export function recordFromSessionEvent(sessionId, event, context = {}) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type ?? '');
  if (!USAGE_EVENT_TYPES.has(type)) return null;
  const data = event.data ?? {};
  const message = data.message ?? null;
  const provider = message?.source?.provider ?? data.provider ?? data.source?.provider
    ?? context.header?.provider ?? context.inheritedProvider ?? null;
  const model = message?.source?.model ?? data.model ?? data.source?.model
    ?? context.header?.model ?? context.inheritedModel ?? null;
  const isSummary = type.startsWith('compaction/') || type === 'session/compaction' || Boolean(data.compactionId ?? data.compaction);
  const compactionId = isSummary ? (data.compactionId ?? data.compaction?.id ?? data.compaction ?? `seq-${event.seq}`) : null;
  const usage = data.usage ?? message?.usage ?? usageFromStream(data.stream) ?? deepUsage(data) ?? deepUsage(message);
  return {
    sessionId: String(sessionId ?? event.sessionId ?? 'unknown'),
    seq: Number(event.seq),
    type,
    turn: Number.isInteger(data.turn) ? data.turn : 0,
    step: Number.isInteger(data.step) ? data.step : 0,
    time: Number.isFinite(event.time) ? event.time : 0,
    provider: typeof provider === 'string' ? provider : null,
    model: typeof model === 'string' ? model : null,
    // TokenUsage 形状与 usage.js:usageOf 一致；**attempt 也保留 usage**（重试/失败可能带 usage）。
    usage: usage && typeof usage === 'object' ? usage : null,
    compactionId: compactionId ? String(compactionId) : null,
    isSummary,
    ownerHint: context.ownerHint ?? null,
    interrupted: data.interrupted === true,
    source: NATIVE_USAGE_SOURCE,
  };
}

/** 把一段 session 事件折算成 usage 记录（保留事件顺序，供 foldBillingUnits 去重/重试判定）。 */
export function recordsFromSessionEvents(sessionId, events, context = {}) {
  const list = Array.isArray(events) ? events : [];
  const out = [];
  // header provider/model 在事件间继承（header 跨页丢失修复）；显式值优先。
  let inheritedProvider = context.header?.provider ?? context.inheritedProvider ?? null;
  let inheritedModel = context.header?.model ?? context.inheritedModel ?? null;
  for (const event of list) {
    // 页内 request/header 也要更新继承路由（旧实现只处理计费事件，header 被完全忽略）。
    const route = routeFromEvent(event);
    if (route) {
      if (route.provider) inheritedProvider = route.provider;
      if (route.model) inheritedModel = route.model;
      continue;
    }
    const record = recordFromSessionEvent(sessionId, event, { ...context, inheritedProvider, inheritedModel });
    if (record) {
      if (record.provider) inheritedProvider = record.provider;
      if (record.model) inheritedModel = record.model;
      out.push(record);
    }
  }
  return out;
}

/** 从一段事件中解析最新路由（供 collector 跨页保留 provider/model）。 */
export function routeFromSessionEvents(events, inherited = {}) {
  let provider = inherited.provider ?? null;
  let model = inherited.model ?? null;
  for (const event of Array.isArray(events) ? events : []) {
    const route = routeFromEvent(event);
    if (route?.provider) provider = route.provider;
    if (route?.model) model = route.model;
    const record = recordFromSessionEvent('__route__', event, { inheritedProvider: provider, inheritedModel: model });
    if (record?.provider) provider = record.provider;
    if (record?.model) model = record.model;
  }
  return { provider, model };
}

/**
 * 原生会话事件收集器。
 *
 * @param {{
 *   adapter: object,
 *   ledger: object,
 *   clock?: {now:()=>number},
 *   maxSessions?: number,
 *   maxEventsPerSession?: number,
 *   sessionOf?: (agent:object)=>object|undefined,
 *   diagnostics?: object,
 * }} deps
 */
export function createNativeUsageCollector(deps = {}) {
  const adapter = deps.adapter;
  const ledger = deps.ledger;
  const clock = deps.clock ?? { now: () => Date.now() };
  const maxSessions = Math.max(1, Number(deps.maxSessions) || 200);
  const maxEventsPerSession = Math.max(1, Number(deps.maxEventsPerSession) || 20000);
  const diagnostics = deps.diagnostics ?? null;
  const sessionOf = typeof deps.sessionOf === 'function'
    ? deps.sessionOf
    : (agent) => (agent && typeof agent === 'object' ? agent.session : undefined);

  /** sessionId → { seq, provider, model }（已读到的事件 seq + 1；可持久化）。 */
  const cursors = new Map();
  const loadCursor = typeof deps.loadCursor === 'function' ? deps.loadCursor : null;
  const saveCursor = typeof deps.saveCursor === 'function' ? deps.saveCursor : null;
  /** 公平轮换偏移：每一轮从不同会话开始，稳定的前 maxSessions 个不会饿死其后会话。 */
  let rotationOffset = 0;
  /** live/history/下一 tick 的串行链：同一事件并发只结算一次。 */
  let readChain = Promise.resolve();
  const stats = { collects: 0, sessionsSeen: 0, eventsRead: 0, records: 0, skippedNoSession: 0, cappedSessions: 0, lastAt: 0, cursorMapSize: 0, restored: 0, historicalSessions: 0, historicalRecords: 0, serialized: 0 };
  /** 覆盖窗口：只记录**实际回读**的 session/时间范围；gap 明确列原因。 */
  const coverage = { from: null, to: null, sessions: new Set(), gaps: [] };
  const trackCoverage = (sessionId, records, gap) => {
    if (gap) { coverage.gaps.push(gap); if (coverage.gaps.length > 200) coverage.gaps.shift(); return; }
    if (sessionId) coverage.sessions.add(String(sessionId));
    for (const record of records ?? []) {
      const time = Number(record?.time);
      if (!Number.isFinite(time) || time <= 0) continue;
      coverage.from = coverage.from === null ? time : Math.min(coverage.from, time);
      coverage.to = coverage.to === null ? time : Math.max(coverage.to, time);
    }
  };

  function gateDiagnostic(code, message) {
    if (diagnostics && typeof diagnostics.push === 'function') diagnostics.push(code, message);
  }

  /** loadCursor 兼容数字与 {seq,provider,model}（旧数据只有数字）。 */
  function cursorFor(sessionId) {
    const id = String(sessionId);
    if (cursors.has(id)) return cursors.get(id);
    let restored = { seq: 0, provider: null, model: null };
    try {
      const stored = loadCursor && loadCursor(id);
      if (Number.isInteger(stored)) restored = { seq: stored, provider: null, model: null };
      else if (stored && typeof stored === 'object') restored = { seq: Number.isInteger(stored.seq) ? stored.seq : 0, provider: stored.provider ?? null, model: stored.model ?? null };
    } catch {
      restored = { seq: 0, provider: null, model: null };
    }
    if (restored.seq > 0) stats.restored += 1;
    cursors.set(id, restored);
    return restored;
  }

  function setCursor(sessionId, seq, route = {}) {
    const current = cursorFor(sessionId);
    const next = { seq: Number.isInteger(seq) ? seq : current.seq, provider: route.provider ?? current.provider ?? null, model: route.model ?? current.model ?? null };
    cursors.set(String(sessionId), next);
    return next;
  }

  function serialize(task) {
    const run = readChain.then(
      () => task(),
      () => task(),
    );
    readChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 处理一个会话的一页事件；返回 { applied, records, nextSeq, ok }。 */
  async function consumePage(sessionId, bounded, routeIn, context = {}) {
    const records = recordsFromSessionEvents(sessionId, bounded, { ...context, inheritedProvider: routeIn.provider, inheritedModel: routeIn.model });
    const route = routeFromSessionEvents(bounded, routeIn);
    let applied = null;
    if (records.length > 0) {
      applied = await ledger.ingestRecords(records, { source: NATIVE_USAGE_SOURCE, sessionId });
      if (applied && applied.ok === false) {
        gateDiagnostic('usage:native:ingest-failed', `${sessionId}: ${applied?.code ?? 'INGEST_FAILED'}（cursor 不推进）`);
        trackCoverage(sessionId, records, { sessionId, reason: applied?.code ?? 'INGEST_FAILED' });
        return { ok: false, applied, records, route, nextSeq: null };
      }
    }
    trackCoverage(sessionId, records, null);
    const last = bounded[bounded.length - 1];
    const nextSeq = Number.isInteger(Number(last?.seq)) ? Number(last.seq) + 1 : null;
    setCursor(sessionId, nextSeq, route);
    if (saveCursor && nextSeq !== null) {
      try {
        await saveCursor(sessionId, nextSeq, { source: NATIVE_USAGE_SOURCE, events: bounded.length, provider: route.provider ?? null, model: route.model ?? null, at: clock.now() });
      } catch (error) {
        gateDiagnostic('usage:native:cursor-save-failed', `${sessionId}: ${String(error?.message ?? error)}`);
      }
    }
    return { ok: true, applied, records, route, nextSeq };
  }

  async function collectNow(options = {}) {
    stats.collects += 1;
    stats.lastAt = clock.now();
    const listResult = adapter && typeof adapter.listAgents === 'function' ? adapter.listAgents() : [];
    const agents = Array.isArray(listResult) ? listResult : (listResult?.ok && Array.isArray(listResult.value) ? listResult.value : []);
    // 只保留有真实 session 的 agent（稳定排序 → 公平轮换可复现）。
    const candidates = [];
    for (const agent of agents) {
      const session = sessionOf(agent);
      if (!session || typeof session.snapshotEvents !== 'function') {
        stats.skippedNoSession += 1;
        continue;
      }
      const sessionId = String(session.id ?? agent?.id ?? '');
      if (!sessionId) continue;
      candidates.push({ agent, session, sessionId });
    }
    candidates.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    let window;
    if (candidates.length <= maxSessions) {
      window = candidates;
      rotationOffset = 0;
    } else {
      window = [];
      for (let index = 0; index < maxSessions; index += 1) window.push(candidates[(rotationOffset + index) % candidates.length]);
      rotationOffset = (rotationOffset + maxSessions) % candidates.length;
      stats.cappedSessions += 1;
    }
    let sessions = 0;
    let recordsWritten = 0;
    let eventsRead = 0;
    const ingestFailures = [];
    const perSession = [];
    for (const { session, sessionId } of window) {
      sessions += 1;
      const cursor = cursorFor(sessionId);
      const from = Number.isInteger(options.resetFromSeq) ? options.resetFromSeq : cursor.seq;
      let events;
      try {
        const upto = typeof session.seq === 'number' ? session.seq : undefined;
        events = session.snapshotEvents(from, upto);
      } catch (error) {
        gateDiagnostic('usage:native:read-failed', `${sessionId}: ${String(error?.message ?? error)}`);
        continue;
      }
      if (!Array.isArray(events) || events.length === 0) {
        trackCoverage(sessionId, [], { sessionId, reason: 'NO_NEW_EVENTS' });
        continue;
      }
      const bounded = events.slice(0, maxEventsPerSession);
      eventsRead += bounded.length;
      const result = await consumePage(sessionId, bounded, cursor, { header: session.header ?? session.meta ?? null });
      if (result.ok !== true) {
        // **账本持久化失败必须对外披露**（cursor 未推进，可重试；不能返回整体 ok）。
        ingestFailures.push({ sessionId, code: result.applied?.code ?? 'INGEST_FAILED' });
        continue;
      }
      recordsWritten += Number(result.applied?.appendedUnits ?? 0);
      perSession.push({ sessionId, events: bounded.length, records: result.records.length });
    }
    stats.sessionsSeen += sessions;
    stats.eventsRead += eventsRead;
    stats.records += recordsWritten;
    stats.cursorMapSize = cursors.size;
    return {
      ok: ingestFailures.length === 0,
      ...(ingestFailures.length > 0 ? { code: 'NATIVE_INGEST_FAILED', failures: ingestFailures.slice(0, 10), note: '账本持久化失败：cursor 未推进，下一轮会重新采集同一批事件。' } : {}),
      source: NATIVE_USAGE_SOURCE,
      sessions,
      eventsRead,
      appendedUnits: recordsWritten,
      perSession,
      cursors: stats.cursorMapSize,
      rotation: { total: candidates.length, window: sessions, offset: rotationOffset, capped: candidates.length > maxSessions },
      at: clock.now(),
    };
  }

  function collect(options = {}) {
    stats.serialized += 1;
    return serialize(() => collectNow(options));
  }

  /** 首次历史补录：把每个 live session 从 seq 0 折一遍（程序化；不喂模型）。 */
  async function backfill() {
    cursors.clear();
    const result = await collect({ resetFromSeq: 0 });
    return { ...result, mode: 'backfill' };
  }

  /**
   * **历史非 live 会话补账**（Lead 第 16 回合 A）：
   * 后台分批（`batchSize` 有上限，不阻塞 turn），按给定 session 列表/祖先链逐段回读，
   * 持久 cursor（`saveCursor`，可续）；读不到的区间记进 `coverage.gaps`（原因明确），
   * 失败记 `usage:native:read-failed` 并保持 unknown（不猜 token、不做全量扫描）。
   *
   * sessions 元素：`{ id, readEvents?: (fromSeq)=>events[], events?: events[], parentSession?: string }`
   */
  async function backfillHistoricalNow(sessions = [], options = {}) {
    const list = Array.isArray(sessions) ? sessions : [];
    const batchSize = Math.max(1, Math.min(Number(options.batchSize) || 20, 100));
    const perSession = [];
    const gaps = [];
    let recordsTotal = 0;
    for (let offset = 0; offset < list.length; offset += batchSize) {
      const batch = list.slice(offset, offset + batchSize);
      for (const session of batch) {
        const sessionId = String(session?.id ?? session?.sessionId ?? '');
        if (!sessionId) { gaps.push({ sessionId: null, reason: 'MISSING_SESSION_ID' }); continue; }
        const cursor = cursorFor(sessionId);
        const from = Number.isInteger(options.resetFromSeq) ? options.resetFromSeq : cursor.seq;
        let events = null;
        try {
          if (typeof session.readEvents === 'function') events = await session.readEvents(from);
          else if (Array.isArray(session.events)) events = session.events.filter((event) => Number(event?.seq) >= from);
        } catch (error) {
          gaps.push({ sessionId, from, reason: 'READ_FAILED', message: String(error?.message ?? error) });
          gateDiagnostic('usage:native:read-failed', `${sessionId}: ${String(error?.message ?? error)}`);
          continue;
        }
        if (!Array.isArray(events)) { gaps.push({ sessionId, from, reason: 'NO_READER' }); continue; }
        const bounded = events.slice(0, maxEventsPerSession);
        if (bounded.length === 0) {
          trackCoverage(sessionId, [], { sessionId, reason: 'NO_NEW_EVENTS' });
          perSession.push({ sessionId, events: 0, records: 0 });
          continue;
        }
        const result = await consumePage(sessionId, bounded, cursor, {});
        if (result.ok !== true) {
          gaps.push({ sessionId, from, reason: result.applied?.code ?? 'INGEST_FAILED' });
          continue;
        }
        recordsTotal += Number(result.applied?.appendedUnits ?? 0);
        perSession.push({ sessionId, events: bounded.length, records: result.records.length });
      }
      if (typeof options.onBatch === 'function') await options.onBatch({ offset, batch: batch.length, recordsTotal });
    }
    stats.historicalSessions += perSession.length;
    stats.historicalRecords += recordsTotal;
    for (const gap of gaps) trackCoverage(gap.sessionId ?? null, null, gap);
    return { ok: gaps.length === 0, mode: 'backfill-historical', batchSize, sessions: perSession.length, appendedUnits: recordsTotal, perSession, gaps, coverage: coverageSnapshot() };
  }

  function backfillHistorical(sessions = [], options = {}) {
    stats.serialized += 1;
    return serialize(() => backfillHistoricalNow(sessions, options));
  }

  function coverageSnapshot() {
    return { from: coverage.from, to: coverage.to, sessions: coverage.sessions.size, gaps: coverage.gaps.slice(-50) };
  }

  function snapshotCursor() {
    return Object.fromEntries([...cursors].map(([id, value]) => [id, value?.seq ?? value]));
  }

  return { collect, backfill, backfillHistorical, coverageSnapshot, snapshotCursor, stats: () => ({ ...stats }), cursors };
}

/** 供 `/state` 的 uncertainty 文案使用：原生来源是否真的在跑。 */
export function nativeSourceSummary(stats) {
  return {
    source: NATIVE_USAGE_SOURCE,
    collects: Number(stats?.collects ?? 0),
    sessionsSeen: Number(stats?.sessionsSeen ?? 0),
    eventsRead: Number(stats?.eventsRead ?? 0),
    recordsApplied: Number(stats?.records ?? 0),
    lastAt: Number(stats?.lastAt ?? 0),
    note: '账单来自当前宿主 live session 的原生事件游标（snapshotEvents）；审计 JSONL 只用于验收重放，不作为生产归账。',
  };
}

export const NATIVE_USAGE_EMPTY_BUDGET = emptyBudget();
