/**
 * `usage.js` — 费用归账后端 v3（契约 v1 §1；Codex 两轮只读审阅后修订）
 *
 * ## 第二轮修掉的真实缺陷（B/C）
 *
 * | 缺陷 | 修法 |
 * |---|---|
 * | attempt 序号按"本批数组"算 → 跨批同 step 的重试都变 `attempt:0` | 计费键改用 **事件 seq**（`seq:<n>`），并由持久化的 `usage_step_cursors` 记录每个 `(session,turn,step)` 的最后 attempt seq；message 复用它。跨分页/重启稳定。 |
 * | 先落盘"缺 usage"记录后，后续带 usage 的 final 因 storage.get 已有而 `continue`，永远补不齐 | 命中既有记录时若**新单元信息更全**（usage/cost 从未知变已知）→ **合并升级并做增量修正**（先撤旧贡献再加新贡献）。 |
 * | summary 的键与普通请求混用，且假定只有 attempt/message 两种 type | summary 用独立的 `compaction:<id>` 键；其它 type 有 usage 也按普通请求计。 |
 * | 总量/unknown/summary 按原始重复事件累加，重放会漂移 | 统计**按折算后的计费单元**计算（requests/missing/summaries/retries 全部来自 units）；记录级幂等。 |
 * | JSONL 用 `join('\n')` 重算消耗字节（CRLF/跨块半行会错位） | 按**原文最后一个换行符的真实字节偏移**推进游标；跨块半行留到下次。 |
 * | `Number(null)=0` 把缺价变成 0 费率；缺 cache 价默认 0 | 价目只接受**显式数字/数字字符串**；缺 cache 价 → 该请求 cost **unknown**（不是 0）。 |
 * | 混币直接相加 | 按币种分桶 `costByCurrency`；`costEstimate` 只在单一币种时给数，否则 0 + `mixedCurrency:true`。 |
 * | 首次历史补录全算本阶段 | 阶段统计只累计 `time >= phaseStartedAt` 的单元；补录只进 cumulative。 |
 * | byOwner 不过滤团队 | `snapshot({teamKey, ownerIds})` 按团队成员过滤 byOwner。 |
 * | 原生 session 的祖先/未登记原生 team 丢失 | `attributeSession` 支持 `parentSession` 链追溯真实原 owner；未登记 workbench 的原生 team 记为 `native:<teamId>`（协调/原生），不再丢弃成 unattributed。 |
 */

import { sha256Hex, stableStringify } from './util.js';

export const USAGE_TABLE = 'usage_requests';
export const USAGE_CURSOR_TABLE = 'usage_cursors';
export const USAGE_TOTALS_TABLE = 'usage_totals';
export const USAGE_STEP_CURSOR_TABLE = 'usage_step_cursors';

export const USAGE_SOURCE = 'requests.jsonl';
export const AUDIT_BASELINE_SOURCE = 'audit-baseline';
export const NATIVE_SOURCE = 'native-session-events';
export const USAGE_VERSION = 3;
export const PRICING_VERSION = 'pricing-v1';

/** 空价目表：**没有默认货币、没有默认费率**（unknown 不等于 0）。 */
export function emptyPriceBook() {
  return { version: PRICING_VERSION, currency: null, source: 'not-configured', entries: [] };
}

/** 只接受显式数字/数字字符串；null/undefined/'' → null（**绝不 Number(null)=0**）。 */
function explicitNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

/**
 * 规范化价目表（按 provider/model/生效时段）。
 *
 * 硬规则：
 * - `inputPerMillion`/`outputPerMillion` **必须显式**，否则该条目丢弃（宁可 unknown 也不猜）。
 * - `cacheReadPerMillion` 允许缺省，但缺省时该条目记为 `cacheReadKnown:false`：
 *   **当请求真的有 cacheRead token 时，这条请求计费 unknown**（不是 0）。
 */
export function normalizePriceBook(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const book = {
    version: typeof source.version === 'string' && source.version ? source.version : PRICING_VERSION,
    currency: typeof source.currency === 'string' && source.currency ? source.currency : null,
    source: typeof source.source === 'string' && source.source ? source.source : 'config',
    entries: [],
  };
  const entries = Array.isArray(source.entries) ? source.entries : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const inputPerMillion = explicitNumber(entry.inputPerMillion);
    const outputPerMillion = explicitNumber(entry.outputPerMillion);
    if (inputPerMillion === null || outputPerMillion === null) continue;
    const cacheReadPerMillion = explicitNumber(entry.cacheReadPerMillion);
    const from = Date.parse(entry.effectiveFrom);
    const to = Date.parse(entry.effectiveTo);
    book.entries.push({
      provider: typeof entry.provider === 'string' && entry.provider ? entry.provider : '*',
      model: typeof entry.model === 'string' && entry.model ? entry.model : '*',
      effectiveFrom: Number.isFinite(from) ? from : 0,
      effectiveTo: Number.isFinite(to) ? to : null,
      currency: typeof entry.currency === 'string' && entry.currency ? entry.currency : book.currency,
      inputPerMillion,
      outputPerMillion,
      cacheReadPerMillion,
      cacheReadKnown: cacheReadPerMillion !== null,
      // 归一化来源：DSH 的 usage 列是 input/output/cacheRead **分列**（input 不含 cacheRead）。
      tokenNormalization: {
        inputExcludesCacheRead: true,
        cacheReadSeparate: true,
        source: typeof entry.tokenNormalization === 'string' ? entry.tokenNormalization : 'dsh-usage-columns',
      },
      // 谷时/时段生效范围 + 条目来源（审计原件可追溯；未配置 = 全时段生效）。
      effective: entry.effective && typeof entry.effective === 'object' ? { ...entry.effective } : null,
      source: typeof entry.source === 'string' && entry.source ? entry.source : book.source,
      cacheWritePerMillion: explicitNumber(entry.cacheWritePerMillion),
    });
  }
  if (book.entries.length > 0 && !book.currency) book.currency = book.entries.find((entry) => entry.currency)?.currency ?? null;
  return book;
}

/** 按 provider/model/时间解析费率条目；解析不到 → null（费用 unknown，不是 0）。 */
export function resolvePrice(book, { provider, model, time } = {}) {
  const entries = Array.isArray(book?.entries) ? book.entries : [];
  const at = Number.isFinite(Number(time)) && Number(time) > 0 ? Number(time) : Date.now();
  const candidates = entries.filter((entry) => {
    if (entry.effectiveFrom && at < entry.effectiveFrom) return false;
    if (entry.effectiveTo && at >= entry.effectiveTo) return false;
    return true;
  });
  const score = (entry) => (entry.provider === provider ? 2 : 0) + (entry.model === model ? 2 : 0) + (entry.effectiveFrom ?? 0) / 1e15;
  return candidates
    .filter((entry) => (entry.provider === '*' || entry.provider === provider) && (entry.model === '*' || entry.model === model))
    .sort((left, right) => score(right) - score(left))[0] ?? null;
}

/** 单条记录的 token 用量（缺 usage → null）。 */
export function usageOf(record) {
  const usage = record && typeof record === 'object' ? record.usage : null;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = num(usage.inputTokens);
  const outputTokens = num(usage.outputTokens);
  const cacheReadTokens = num(usage.cacheReadTokens);
  const cacheWriteTokens = num(usage.cacheWriteTokens);
  const reasoningTokens = num(usage.reasoningTokens);
  const totalTokens = num(usage.totalTokens);
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && totalTokens === 0) return null;
  const reasoningIncludedInOutput = reasoningTokens > 0 && totalTokens > 0 && totalTokens <= inputTokens + outputTokens + cacheReadTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    reasoningIncludedInOutput,
    // 归一化来源：DSH 分列口径（input 不含 cacheRead）
    normalization: { inputExcludesCacheRead: true, cacheReadSeparate: true, source: 'dsh-usage-columns' },
  };
}

/**
 * 计价：**只有解析到价目条目、且该条目覆盖实际用到的列**时才 known。
 * 缺 cache 价 + 实际有 cacheRead token → unknown（不是 0）。reasoning 已在 output 内，不重复相加。
 */
/**
 * 谷时窗口判定（审计原件：erify_ledger.py:17 价格适用于 **非工作日高峰外**）。
 * effective = {weekday:'Mon-Fri', excludedWindows:['09:00-12:00','14:00-18:00'], timezone:'Asia/Shanghai'}。
 * 不在谷时窗口内 → 该请求**不得套用谷价**（cost unknown，reason PEAK_PRICE_UNVERIFIED）。
 */
export function isValleyTime(time, effective) {
  if (!effective || typeof effective !== 'object') return true;
  const at = Number.isFinite(Number(time)) && Number(time) > 0 ? Number(time) : Date.now();
  const timezone = typeof effective.timezone === 'string' && effective.timezone ? effective.timezone : 'Asia/Shanghai';
  let weekday;
  let clock;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(at));
    weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
    clock = hour * 60 + minute;
  } catch {
    return false; // 时区无法解析 → 不得假装在谷时
  }
  const workingDays = String(effective.weekday ?? 'Mon-Fri').split('-');
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  const range = (name) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  const from = range(workingDays[0]);
  const to = range(workingDays[1] ?? workingDays[0]);
  if (dayIndex < 0 || from < 0 || to < 0 || dayIndex < from || dayIndex > to) return true; // 周末/非工作日：谷时
  const windows = Array.isArray(effective.excludedWindows) ? effective.excludedWindows : [];
  for (const window of windows) {
    const [startText, endText] = String(window).split('-');
    const toMinutes = (text) => {
      const [h, m] = String(text ?? '').split(':');
      return (Number(h) || 0) * 60 + (Number(m) || 0);
    };
    const start = toMinutes(startText);
    const end = toMinutes(endText);
    if (clock >= start && clock < end) return false; // 工作日高峰 → 谷价不适用
  }
  return true;
}

export function costOf(usage, price, context = {}) {
  if (!usage) return { known: false, cost: null, reason: 'NO_USAGE' };
  if (!price) return { known: false, cost: null, reason: 'NO_PRICE_ENTRY' };
  if (price.effective && !isValleyTime(context?.time, price.effective)) {
    return { known: false, cost: null, reason: 'PEAK_PRICE_UNVERIFIED' };
  }
  let total = (usage.inputTokens / 1e6) * price.inputPerMillion;
  total += (usage.outputTokens / 1e6) * price.outputPerMillion;
  if (usage.cacheReadTokens > 0) {
    if (!Number.isFinite(price.cacheReadPerMillion)) {
      return { known: false, cost: null, reason: 'CACHE_PRICE_UNKNOWN' };
    }
    total += (usage.cacheReadTokens / 1e6) * price.cacheReadPerMillion;
  }
  return { known: true, cost: Number(total.toFixed(10)), currency: price.currency ?? null };
}

/** 所有计数为非负整数的 BUDGET（契约冻结形状 + 分币扩展）。 */
export function emptyBudget() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costEstimate: 0,
    costUnknownRequests: 0,
    duplicatesSuppressed: 0,
    retries: 0,
    sessions: 0,
    // 分币种（混币不相加）
    costByCurrency: {},
  };
}

function emptyProviderModelBudget() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costEstimate: 0, costUnknownRequests: 0, costByCurrency: {}, currency: null };
}

function addCostByCurrency(target, cost, currency) {
  if (!Number.isFinite(cost)) return target ?? {};
  const key = currency || 'unknown';
  const next = { ...(target ?? {}) };
  next[key] = Number(((next[key] ?? 0) + cost).toFixed(10));
  return next;
}

function currencyCount(map) {
  return Object.keys(map ?? {}).filter((key) => key !== 'unknown').length;
}

function soleCurrency(map) {
  const keys = Object.keys(map ?? {}).filter((key) => key !== 'unknown' && (map[key] ?? 0) !== 0);
  return keys.length === 1 ? keys[0] : null;
}

/** 把计费单元累加进 BUDGET（cost 只有在**已知**时才累加；分币种）。 */
export function addUnitToBudget(budget, unit) {
  const next = { ...emptyBudget(), ...(budget ?? {}) };
  next.costByCurrency = { ...(next.costByCurrency ?? {}) };
  next.requests += 1;
  if (unit.usage) {
    next.inputTokens += unit.usage.inputTokens;
    next.outputTokens += unit.usage.outputTokens;
    next.cacheReadTokens += unit.usage.cacheReadTokens;
    next.reasoningTokens += unit.usage.reasoningTokens;
  }
  if (unit.usage && unit.costKnown && typeof unit.cost === 'number') {
    next.costByCurrency = addCostByCurrency(next.costByCurrency, unit.cost, unit.currency);
  } else {
    next.costUnknownRequests += 1;
  }
  const sole = soleCurrency(next.costByCurrency);
  next.costEstimate = currencyCount(next.costByCurrency) > 1 ? 0 : Number((sole ? next.costByCurrency[sole] : 0).toFixed(10));
  return next;
}

/** 撤掉一个单元的贡献（合并升级时用，保证总量不漂移）。 */
export function subtractUnitFromBudget(budget, unit) {
  const next = { ...emptyBudget(), ...(budget ?? {}) };
  next.costByCurrency = { ...(next.costByCurrency ?? {}) };
  next.requests = Math.max(0, next.requests - 1);
  if (unit.usage) {
    next.inputTokens = Math.max(0, next.inputTokens - unit.usage.inputTokens);
    next.outputTokens = Math.max(0, next.outputTokens - unit.usage.outputTokens);
    next.cacheReadTokens = Math.max(0, next.cacheReadTokens - unit.usage.cacheReadTokens);
    next.reasoningTokens = Math.max(0, next.reasoningTokens - unit.usage.reasoningTokens);
  }
  if (unit.usage && unit.costKnown && typeof unit.cost === 'number') {
    const key = unit.currency || 'unknown';
    next.costByCurrency[key] = Number(Math.max(0, (next.costByCurrency[key] ?? 0) - unit.cost).toFixed(10));
    if (next.costByCurrency[key] === 0) delete next.costByCurrency[key];
  } else {
    next.costUnknownRequests = Math.max(0, next.costUnknownRequests - 1);
  }
  const sole = soleCurrency(next.costByCurrency);
  next.costEstimate = currencyCount(next.costByCurrency) > 1 ? 0 : Number((sole ? next.costByCurrency[sole] : 0).toFixed(10));
  return next;
}

export function addBudget(left, right) {
  const out = { ...emptyBudget(), ...(left ?? {}) };
  const add = right ?? {};
  for (const key of ['requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens', 'costUnknownRequests', 'duplicatesSuppressed', 'retries', 'sessions']) {
    out[key] = (Number(out[key]) || 0) + (Number(add[key]) || 0);
  }
  out.costEstimate = Number(((Number(out.costEstimate) || 0) + (Number(add.costEstimate) || 0)).toFixed(10));
  for (const [currency, cost] of Object.entries(add.costByCurrency ?? {})) {
    out.costByCurrency = addCostByCurrency(out.costByCurrency, Number(cost) || 0, currency);
  }
  return out;
}

/** 解析一行 JSONL。 */
export function parseUsageLine(line, lineNo = 0) {
  const text = String(line ?? '').trim();
  if (!text) return { ok: false, code: 'EMPTY_LINE', lineNo };
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    return { ok: false, code: 'MALFORMED_JSON', lineNo, message: String(error?.message ?? error) };
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, code: 'MALFORMED_RECORD', lineNo };
  if (typeof record.sessionId !== 'string' || !record.sessionId) return { ok: false, code: 'MISSING_SESSION_ID', lineNo };
  if (!Number.isInteger(record.seq)) return { ok: false, code: 'MISSING_SEQ', lineNo };
  return { ok: true, record, lineNo };
}

/**
 * 计费键：**跨批/跨重启稳定**，默认主键 = `sessionId + seq`（审计结论，Lead 第 8 回合纠正）。
 *
 * - `assistant/attempt` 是**失败/重试/取消/stream-error** 事件，不是同请求的 stream 副本，
 *   因此**绝不**按 `(turn,step)` 把 attempt 与 message 合并成一笔（否则吞掉真实重试费用）。
 * - summary/compaction 是**独立事件类型**，用独立 `cmp:<id>` 键。
 * - 只有能证明"同一请求的重复 stream/final 来源"（同 session+seq 重放）才去重；
 *   重复入账由持久记录幂等保证，不做跨类型假设。
 */
export function billingKeyOf(record, _context = {}) {
  const sessionId = String(record?.sessionId ?? 'unknown');
  const compactionId = record?.compactionId;
  if (compactionId) return `${sessionId}|cmp:${compactionId}`;
  const seq = Number.isInteger(record?.seq) ? record.seq : null;
  return `${sessionId}|seq:${seq ?? 'unknown'}`;
}

export function stepKeyOf(record) {
  return `${record?.sessionId ?? 'unknown'}|${record?.turn ?? 0}|${record?.step ?? 0}`;
}

/**
 * 归账核心：把一批已解析记录折算成计费单元（纯函数）。
 *
 * @param {object[]} records
 * @param {{priceBook?:object, stepState?:Map<string,{lastAttemptSeq:number,attemptCount:number}>}} [options]
 *   `stepState` 是**跨批共享**的可变映射（调用方持久化），保证跨分页 attempt 序号/最终键稳定。
 */
export function foldBillingUnits(records, options = {}) {
  const book = options.priceBook ?? emptyPriceBook();
  const stepState = options.stepState instanceof Map ? options.stepState : new Map();
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  const units = new Map();
  const attemptOrdinal = options.attemptOrdinal instanceof Map ? options.attemptOrdinal : new Map(); // sessionId → 已见 attempt 数（retryIndex 来源，跨批共享）
  const seenSource = { records: list.length, duplicatesSuppressed: 0 };

  for (const record of list) {
    const usage = usageOf(record);
    const type = String(record.type ?? '');
    // 结算请求事件：message（成功）/ attempt（失败/重试/取消/stream-error）/ summary（独立类型）。
    // 缺 usage 的结算事件也计入（unknown ≠ 0），但无关事件（tool/生命周期）不进入账单。
    if (usage === null && !record.compactionId && !record.isSummary && type !== 'assistant/message' && type !== 'assistant/attempt') continue;
    // retryIndex 按 **sessionId + 事件 seq 顺序** 计（Lead 第 9 回合：不再按 turn/step 分桶；
    // `assistant/attempt` 本身就是失败/重试/取消/stream-error 事件，seq 单调即可定位第几次尝试）。
    const sessionId = String(record.sessionId ?? 'unknown');
    let retryIndex = 0;
    if (type === 'assistant/attempt') {
      const seen = attemptOrdinal.get(sessionId) ?? 0;
      retryIndex = seen;
      attemptOrdinal.set(sessionId, seen + 1);
    }
    const seq = Number.isInteger(record.seq) ? record.seq : null;
    const key = billingKeyOf(record);
    const provider = typeof record.provider === 'string' ? record.provider : null;
    const model = typeof record.model === 'string' ? record.model : null;
    const at = Number.isFinite(record.time) ? record.time : 0;
    const price = resolvePrice(book, { provider, model, time: at });
    const cost = costOf(usage, price, { time: at });
    const isSummary = record.isSummary === true || Boolean(record.compactionId);

    const prior = units.get(key);
    if (!prior) {
      units.set(key, {
        billingKey: key,
        sessionId: String(record.sessionId ?? 'unknown'),
        seq,
        turn: record.turn ?? 0,
        step: record.step ?? 0,
        type,
        provider,
        model,
        ownerHint: typeof record.owner === 'string' ? record.owner : null,
        usage,
        cost: cost.known ? cost.cost : null,
        costKnown: Boolean(cost.known),
        costUnknownReason: cost.known ? null : (cost.reason === 'NO_PRICE_ENTRY'
          ? ((typeof provider === 'string' && provider) || (typeof model === 'string' && model) ? 'PROVIDER_MODEL_UNPRICED' : 'PRICE_UNKNOWN')
          : cost.reason),
        currency: cost.known ? (cost.currency ?? null) : null,
        priceVersion: price ? book.version : null,
        isSummary,
        retryIndex,
        time: at,
        sources: [type || 'event'],
        source: record.source ?? null,
      });
      continue;
    }
    // 同一键的第二次出现：final/stream 去重；若新记录信息更全则升级。
    prior.sources.push(type || 'event');
    seenSource.duplicatesSuppressed += 1;
    if (!prior.usage && usage) {
      const upgraded = costOf(usage, price);
      prior.usage = usage;
      prior.cost = upgraded.known ? upgraded.cost : null;
      prior.costKnown = Boolean(upgraded.known);
      prior.costUnknownReason = upgraded.known ? null : upgraded.reason;
      prior.currency = upgraded.known ? (upgraded.currency ?? null) : null;
      prior.upgraded = true;
    }
  }

  // 统计**按折算后的单元**（不按原始重复事件）。
  const unitList = [...units.values()];
  const stats = {
    records: seenSource.records,
    units: unitList.length,
    duplicatesSuppressed: seenSource.duplicatesSuppressed,
    retries: unitList.filter((unit) => unit.retryIndex > 0).length,
    summaries: unitList.filter((unit) => unit.isSummary).length,
    missingUsage: unitList.filter((unit) => !unit.usage).length,
    costUnknown: unitList.filter((unit) => unit.costKnown !== true).length,
  };
  return { units: unitList, stats, book, stepState, attemptOrdinal };
}

/** 归属：session → owner/role（只用 Host 既有事实 + 原生 session 祖先链）。 */
export function attributeSession(sessionId, facts = {}) {
  const toList = (value) => (value instanceof Map ? [...value.values()] : (Array.isArray(value) ? value : []));
  const members = toList(facts.members);
  const attempts = toList(facts.attempts);
  const teams = toList(facts.teams);
  const sessions = toList(facts.sessions);
  const nativeTeams = toList(facts.nativeTeams);
  let id = String(sessionId ?? '');
  const attemptByChild = attempts.find((entry) => String(entry?.executorChildId ?? '') === id);
  if (attemptByChild) {
    return { attributed: true, role: 'leaf-descendant', memberId: String(attemptByChild.ownerMemberId ?? ''), teamKey: attemptByChild.teamKey ?? null, workId: attemptByChild.workId ?? null, attemptId: attemptByChild.attemptId ?? null, kind: 'descendants' };
  }
  const member = members.find((entry) => String(entry?.sessionId ?? '') === id);
  if (member) {
    return { attributed: true, role: 'member-self', memberId: String(member.memberId ?? ''), teamKey: member.teamKey ?? null, workId: null, attemptId: null, kind: 'self' };
  }
  const team = teams.find((entry) => String(entry?.rootSessionId ?? '') === id);
  if (team) {
    return { attributed: true, role: 'lead-self', memberId: 'lead', teamKey: team.teamKey ?? null, workId: null, attemptId: null, kind: 'self' };
  }
  // 祖先链追溯：子会话的费用归到真实原 owner（原生 parentSession 链）。
  let cursor = sessions.find((entry) => String(entry?.id ?? '') === id) ?? null;
  let hops = 0;
  while (cursor && hops < 8) {
    const parentId = cursor?.header?.parentSession ? String(cursor.header.parentSession) : null;
    if (!parentId) break;
    const parentAttempt = attempts.find((entry) => String(entry?.executorChildId ?? '') === parentId);
    if (parentAttempt) {
      return { attributed: true, role: 'leaf-descendant', memberId: String(parentAttempt.ownerMemberId ?? ''), teamKey: parentAttempt.teamKey ?? null, workId: parentAttempt.workId ?? null, attemptId: parentAttempt.attemptId ?? null, kind: 'descendants', via: 'parent-session' };
    }
    const parentMember = members.find((entry) => String(entry?.sessionId ?? '') === parentId);
    if (parentMember) {
      // owner 的**子会话**（原生 parentSession 指向 owner 自己的 session）属于 descendants，
      // 不是 owner self。self 只按 owner 自身 sessionId 精确匹配（修复 child 归 self）。
      const parentTeam = parentMember.teamKey ?? null;
      const parentAttempt = attempts.find((entry) => String(entry?.executorChildId ?? '') === parentId);
      return {
        attributed: true,
        role: 'leaf-descendant',
        memberId: String(parentMember.memberId ?? ''),
        teamKey: parentTeam,
        workId: parentAttempt?.workId ?? null,
        attemptId: parentAttempt?.attemptId ?? null,
        kind: 'descendants',
        via: 'parent-session',
      };
    }
    cursor = sessions.find((entry) => String(entry?.id ?? '') === parentId) ?? null;
    hops += 1;
  }
  // 未登记 workbench 的原生 team：**不能丢**，记成原生/协调归属（不并进 self/descendants 成本）。
  const native = nativeTeams.find((entry) => String(entry?.sessionId ?? '') === id || String(entry?.id ?? '') === id);
  if (native) {
    const nativeTeamId = String(native.teamKey ?? native.team ?? 'native');
    return { attributed: true, role: 'native-team', memberId: `native:${nativeTeamId}`, teamKey: `native:${nativeTeamId}`, workId: null, attemptId: null, kind: 'native', note: '未在本插件登记的维护团队：显示为协调/原生归属，不丢账。' };
  }
  return { attributed: false, role: 'unattributed', memberId: null, teamKey: null, workId: null, attemptId: null, kind: 'unattributed' };
}

/**
 * 增量账本。
 *
 * @param {{
 *   storage: object, clock: {now:()=>number}, priceBook?: object, sourcePath?: string|null,
 *   readRange?: (path:string, offset:number, length:number)=>Promise<{ok:boolean,text?:string,size?:number,error?:string}>,
 *   facts?: ()=>object,
 * }} deps
 */
export function createUsageLedger(deps = {}) {
  const storage = deps.storage;
  const clock = deps.clock ?? { now: () => Date.now() };
  const priceBook = normalizePriceBook(deps.priceBook ?? null);
  const sourcePath = deps.sourcePath ?? null;
  const readRange = deps.readRange ?? null;
  const facts = typeof deps.facts === 'function' ? deps.facts : () => ({});
  const stepState = new Map();
  /** ingest 串行链：live/history 同事件并发时严格幂等（先持久化、再提交内存累计）。 */
  let ingestChain = Promise.resolve();

  const state = {
    totals: emptyBudget(),
    byOwner: new Map(),
    byOwnerSelf: new Map(),
    byOwnerDescendants: new Map(),
    byTeam: new Map(),
    byProviderModel: new Map(),
    /** 归账维度（契约 v4 §11.1）：phase（current/historical）+ workId。 */
    byPhase: new Map(),
    byWork: new Map(),
    unattributed: emptyBudget(),
    sessions: new Set(),
    requestsSeen: 0,
    missingUsageRequests: 0,
    unattributedRequests: 0,
    duplicatesSuppressed: 0,
    retries: 0,
    summaries: 0,
    /** 已计数的 summary billingKey（防止每次 ingest 重复累加）。 */
    summariesSeenCounted: new Set(),
    /** 含 missing-usage 的 billingKey：跨批累积、重放不增长、重启不丢（修复 10≠37）。 */
    missingUsageKeys: new Set(),
    /** 已结算 summary 的 billingKey（持久；重启重放不重复计数，修复 1→2）。 */
    summaryKeys: new Set(),
    /** unattributed 的分桶（按归属原因，unknown 不硬摊）。 */
    unattributedByReason: new Map(),
    /** sessionId → 已见 attempt 数（跨批 retryIndex 来源）；hydrate 会回填。 */
    attemptOrdinal: new Map(),
    malformedLines: 0,
    windowFrom: null,
    windowTo: null,
    readAt: 0,
    phaseStartedAt: clock.now(),
    phaseTotals: emptyBudget(),
    lastIngest: null,
    sources: {},
    priceBook,
  };

  function hydrate() {
    const stored = storage.get(USAGE_TOTALS_TABLE, 'main');
    if (stored && typeof stored === 'object') {
      state.totals = { ...emptyBudget(), ...(stored.totals ?? {}) };
      state.byOwner = new Map(Object.entries(stored.byOwner ?? {}));
      state.byOwnerSelf = new Map(Object.entries(stored.byOwnerSelf ?? {}));
      state.byOwnerDescendants = new Map(Object.entries(stored.byOwnerDescendants ?? {}));
      state.byTeam = new Map(Object.entries(stored.byTeam ?? {}));
      state.byProviderModel = new Map(Object.entries(stored.byProviderModel ?? {}));
      state.byPhase = new Map(Object.entries(stored.byPhase ?? {}));
      state.byWork = new Map(Object.entries(stored.byWork ?? {}));
      state.unattributed = { ...emptyBudget(), ...(stored.unattributed ?? {}) };
      state.sessions = new Set(Array.isArray(stored.sessions) ? stored.sessions : []);
      state.requestsSeen = Number(stored.requestsSeen) || 0;
      state.missingUsageRequests = Number(stored.missingUsageRequests) || 0;
      state.unattributedRequests = Number(stored.unattributedRequests) || 0;
      state.duplicatesSuppressed = Number(stored.duplicatesSuppressed) || 0;
      state.retries = Number(stored.retries) || 0;
      state.summaries = Number(stored.summaries) || 0;
      state.missingUsageKeys = new Set(Array.isArray(stored.missingUsageKeys) ? stored.missingUsageKeys : []);
      state.summaryKeys = new Set(Array.isArray(stored.summaryKeys) ? stored.summaryKeys : []);
      state.summariesSeenCounted = new Set(state.summaryKeys);
      if (state.missingUsageKeys.size > 0) state.missingUsageRequests = state.missingUsageKeys.size;
      if (state.summaryKeys.size > 0) state.summaries = state.summaryKeys.size;
      state.unattributedByReason = new Map(Object.entries(stored.unattributedByReason ?? {}));
      state.windowFrom = stored.windowFrom ?? null;
      state.windowTo = stored.windowTo ?? null;
      state.readAt = Number(stored.readAt) || 0;
      state.sources = stored.sources ?? {};
    }
    for (const [key, value] of storage.list(USAGE_STEP_CURSOR_TABLE)) {
      stepState.set(key, value);
      if (String(key).startsWith('attempt:') && Number.isInteger(value?.count)) state.attemptOrdinal.set(String(key).slice(8), value.count);
    }
    // ---- **一致性重建**（费用审计真实缺口）----
    // 记录表是权威账本：一次 append 落盘即视为提交。totals 表只是缓存；
    // 若 totals 写入失败/崩溃/旧实现少计，重启后必须从已提交单元（counted===true）重建，
    // 否则"记录已计费、总计却少计"会永久不一致（实测 100 条记录 → totals 8）。
    const committedUnits = storage.list(USAGE_TABLE)
      .map(([, value]) => value)
      .filter((unit) => unit && unit.counted === true);
    if (committedUnits.length > 0) {
      const keep = {
        duplicatesSuppressed: state.duplicatesSuppressed,
        retries: state.retries,
        readAt: state.readAt,
        sources: state.sources,
        pricing: state.priceBook,
      };
      state.totals = emptyBudget();
      state.byOwner = new Map();
      state.byOwnerSelf = new Map();
      state.byOwnerDescendants = new Map();
      state.byTeam = new Map();
      state.byProviderModel = new Map();
      state.byPhase = new Map();
      state.byWork = new Map();
      state.unattributed = emptyBudget();
      state.unattributedByReason = new Map();
      state.sessions = new Set();
      state.missingUsageKeys = new Set();
      state.summaryKeys = new Set();
      state.summariesSeenCounted = new Set();
      state.unattributedRequests = 0;
      state.windowFrom = null;
      state.windowTo = null;
      for (const unit of committedUnits) {
        const billingKey = String(unit.billingKey ?? '');
        if (billingKey && !unit.usage) state.missingUsageKeys.add(billingKey);
        if (billingKey && unit.isSummary === true) state.summaryKeys.add(billingKey);
        applyUnit(unit, 1);
      }
      state.summariesSeenCounted = new Set(state.summaryKeys);
      state.missingUsageRequests = state.missingUsageKeys.size;
      state.summaries = state.summaryKeys.size;
      state.requestsSeen = state.totals.requests;
      state.duplicatesSuppressed = keep.duplicatesSuppressed;
      state.retries = keep.retries;
      state.readAt = keep.readAt ?? state.readAt;
      state.sources = keep.sources ?? {};
      state.priceBook = keep.pricing ?? state.priceBook;
    }
    return { requestsSeen: state.requestsSeen, totals: { ...state.totals }, stepCursors: stepState.size, rebuiltFromRecords: committedUnits.length };
  }

  function cursorOf(source = USAGE_SOURCE) {
    const stored = storage.get(USAGE_CURSOR_TABLE, source);
    return stored && typeof stored === 'object'
      ? { source, byteOffset: Number(stored.byteOffset) || 0, lineNo: Number(stored.lineNo) || 0, lastSeq: Number(stored.lastSeq) || 0, fileSize: Number(stored.fileSize) || 0, updatedAt: Number(stored.updatedAt) || 0 }
      : { source, byteOffset: 0, lineNo: 0, lastSeq: 0, fileSize: 0, updatedAt: 0 };
  }

  async function persistTotals() {
    const payload = {
      version: USAGE_VERSION,
      totals: state.totals,
      byOwner: Object.fromEntries(state.byOwner),
      byOwnerSelf: Object.fromEntries(state.byOwnerSelf),
      byOwnerDescendants: Object.fromEntries(state.byOwnerDescendants),
      byTeam: Object.fromEntries(state.byTeam),
      byProviderModel: Object.fromEntries(state.byProviderModel),
      byPhase: Object.fromEntries(state.byPhase),
      byWork: Object.fromEntries(state.byWork),
      unattributed: state.unattributed,
      sessions: [...state.sessions].slice(-4000),
      requestsSeen: state.requestsSeen,
      missingUsageRequests: state.missingUsageRequests,
      unattributedRequests: state.unattributedRequests,
      duplicatesSuppressed: state.duplicatesSuppressed,
      retries: state.retries,
      summaries: state.summaries,
      missingUsageKeys: [...state.missingUsageKeys].slice(-4000),
      summaryKeys: [...state.summaryKeys].slice(-4000),
      unattributedByReason: Object.fromEntries(state.unattributedByReason ?? new Map()),
      windowFrom: state.windowFrom,
      windowTo: state.windowTo,
      readAt: state.readAt,
      sources: state.sources,
      pricing: { version: state.priceBook.version, source: state.priceBook.source, currency: state.priceBook.currency, entries: state.priceBook.entries.length },
      updatedAt: clock.now(),
    };
    await storage.put(USAGE_TOTALS_TABLE, 'main', payload, { idempotencyKey: `usage-totals:${state.requestsSeen}:${state.totals.requests}` });
  }

  async function persistStepState(stepKeys) {
    for (const key of stepKeys) {
      const value = stepState.get(key);
      if (!value) continue;
      await storage.put(USAGE_STEP_CURSOR_TABLE, key, { ...value, updatedAt: clock.now() });
    }
  }

  function bumpTotals(bucketMap, key, unit, sign) {
    const current = bucketMap.get(key) ?? emptyBudget();
    bucketMap.set(key, sign > 0 ? addUnitToBudget(current, unit) : subtractUnitFromBudget(current, unit));
  }

  function applyUnit(unit, sign = 1) {
    const attribution = unit.attribution ?? attributeSession(unit.sessionId, facts());
    unit.attribution = attribution;
    if (attribution.attributed !== true) {
      // 无法证明归属：计入 unattributed（不硬摊给 owner/team），同时按**原因分桶**保留可见性。
      state.unattributed = sign > 0 ? addUnitToBudget(state.unattributed, unit) : subtractUnitFromBudget(state.unattributed, unit);
      state.unattributedRequests = Math.max(0, state.unattributedRequests + sign);
      const reason = String(attribution.role ?? 'unattributed');
      const bucket = state.unattributedByReason.get(reason) ?? emptyBudget();
      state.unattributedByReason.set(reason, sign > 0 ? addUnitToBudget(bucket, unit) : subtractUnitFromBudget(bucket, unit));
    } else {
      const ownerKey = attribution.memberId || 'unknown';
      bumpTotals(state.byOwner, ownerKey, unit, sign);
      const bucket = attribution.kind === 'descendants' ? state.byOwnerDescendants : state.byOwnerSelf;
      bumpTotals(bucket, ownerKey, unit, sign);
      if (attribution.teamKey) bumpTotals(state.byTeam, attribution.teamKey, unit, sign);
    }
    const pmKey = `${unit.provider ?? 'unknown'}::${unit.model ?? 'unknown'}`;
    const current = state.byProviderModel.get(pmKey) ?? emptyProviderModelBudget();
    const known = unit.costKnown === true && typeof unit.cost === 'number';
    const signMul = sign;
    const phaseKey = Number.isFinite(unit.time) && unit.time >= state.phaseStartedAt ? 'current' : 'historical';
    bumpTotals(state.byPhase, phaseKey, unit, sign);
    if (attribution?.workId) bumpTotals(state.byWork, String(attribution.workId), unit, sign);
    state.byProviderModel.set(pmKey, {
      ...current,
      requests: current.requests + signMul,
      inputTokens: current.inputTokens + signMul * (unit.usage?.inputTokens ?? 0),
      outputTokens: current.outputTokens + signMul * (unit.usage?.outputTokens ?? 0),
      cacheReadTokens: current.cacheReadTokens + signMul * (unit.usage?.cacheReadTokens ?? 0),
      costByCurrency: known ? addCostByCurrency(current.costByCurrency, signMul * unit.cost, unit.currency) : { ...(current.costByCurrency ?? {}) },
      costEstimate: known ? Number(((current.costEstimate ?? 0) + signMul * unit.cost).toFixed(10)) : current.costEstimate,
      costUnknownRequests: Math.max(0, (current.costUnknownRequests ?? 0) + (known ? 0 : signMul)),
      currency: current.currency ?? (known ? unit.currency : null) ?? null,
    });
    state.totals = sign > 0 ? addUnitToBudget(state.totals, unit) : subtractUnitFromBudget(state.totals, unit);
    // **阶段统计只算本阶段的新调用**（首次历史补录不进 phase）。
    const unitTime = Number.isFinite(unit.time) && unit.time > 0 ? unit.time : clock.now();
    if (sign > 0 && unitTime >= state.phaseStartedAt) {
      state.phaseTotals = addUnitToBudget(state.phaseTotals, unit);
      unit.phaseCounted = true;
    } else if (sign < 0 && unit.phaseCounted === true) {
      state.phaseTotals = subtractUnitFromBudget(state.phaseTotals, unit);
    }
    if (sign > 0) state.sessions.add(unit.sessionId);
    void attribution;
    return unit;
  }

  /**
   * **核心入口**：把已解析记录增量入账（原生 session 事件 / 审计基线都走这里）。
   *
   * 幂等 + 串行（费用审计 14:27 失败项 22/23/25）：
   * - 同一 `billingKey` 只计一次；usage 从无到有/费用从 unknown 到 known 时**合并升级**。
   * - live/history 并发调用走同一串行链：后一个批次能看到前一个已持久化的记录，不会重复计数。
   * - **先持久化、后提交内存累计**：写失败时内存累计不变（不先减旧累计），并返回 `ok:false`；
   *   采集方据此**不推进 native cursor**（失败可重新采到，不假成功）。
   * - missingUsage/summary 用**持久集合**去重：跨批累积、重放不增长、重启不丢。
   */
  async function ingestRecords(records, context = {}) {
    const list = Array.isArray(records) ? records.filter(Boolean) : [];
    const source = context.source ?? 'unknown';
    if (list.length === 0) return { ok: true, appendedUnits: 0, upgradedUnits: 0, duplicates: 0, source };
    const run = ingestChain.then(
      () => ingestRecordsInLock(list, { source, context }),
      () => ingestRecordsInLock(list, { source, context }),
    );
    ingestChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function ingestRecordsInLock(list, { source }) {
    const stepKeysBefore = new Set(stepState.keys());
    const folded = foldBillingUnits(list, { priceBook: state.priceBook, stepState, attemptOrdinal: state.attemptOrdinal });
    let appended = 0;
    let upgraded = 0;
    let duplicates = 0;
    const persistFailures = [];
    for (const unit of folded.units) {
      const key = sha256Hex(unit.billingKey).slice(0, 40);
      const existing = storage.get(USAGE_TABLE, key);
      if (!existing) {
        const storedUnit = { ...unit, source, ingestedAt: clock.now(), counted: true, phaseCounted: false };
        const stored = await storage.put(USAGE_TABLE, key, storedUnit, { idempotencyKey: `usage-unit:${key}` });
        if (stored?.ok !== true) {
          persistFailures.push({ key, code: stored?.code ?? 'USAGE_LEDGER_WRITE_FAILED', message: stored?.message ?? null });
          continue;
        }
        // 只提交**持久化成功**的单元。
        const committed = stored.record ?? storedUnit;
        applyUnit(committed, 1);
        const withPhase = { ...committed, phaseCounted: committed.phaseCounted === true || (Number.isFinite(committed.time) && committed.time >= state.phaseStartedAt) };
        const phaseStored = await storage.put(USAGE_TABLE, key, withPhase, { expectRev: committed.rev });
        if (phaseStored?.ok === true && phaseStored.record) state.phaseMarked = true;
        appended += 1;
        continue;
      }
      duplicates += 1;
      const richer = (!existing.usage && unit.usage) || (existing.costKnown !== true && unit.costKnown === true);
      if (!richer) continue;
      // 合并升级：**先写成功**，再撤旧/加新（写失败时内存累计保持原值，修复 requests 变 0）。
      const merged = {
        ...existing,
        usage: unit.usage ?? existing.usage,
        cost: unit.costKnown ? unit.cost : existing.cost,
        costKnown: unit.costKnown === true ? true : existing.costKnown === true,
        costUnknownReason: unit.costKnown ? null : existing.costUnknownReason,
        currency: unit.costKnown ? (unit.currency ?? null) : (existing.currency ?? null),
        priceVersion: unit.costKnown ? unit.priceVersion : existing.priceVersion,
        provider: existing.provider ?? unit.provider,
        model: existing.model ?? unit.model,
        sources: [...new Set([...(existing.sources ?? []), ...(unit.sources ?? [])])],
        upgradedAt: clock.now(),
      };
      const stored = await storage.put(USAGE_TABLE, key, merged, { expectRev: existing.rev });
      if (stored?.ok !== true) {
        persistFailures.push({ key, code: stored?.code ?? 'USAGE_LEDGER_WRITE_FAILED', message: stored?.message ?? null });
        continue;
      }
      const committed = stored.record ?? merged;
      if (existing.counted === true) applyUnit(existing, -1);
      applyUnit(committed, 1);
      upgraded += 1;
    }
    // 失败：保留可重试语义，不更新 totals/cursor（成功项已各自持久化，重放是幂等 no-op）。
    if (persistFailures.length > 0) {
      return {
        ok: false,
        code: 'USAGE_LEDGER_WRITE_FAILED',
        message: `${persistFailures.length} 条计费记录未能持久化：不提交累计、不推进采集 cursor。`,
        failures: persistFailures.slice(0, 5),
        appendedUnits: appended,
        upgradedUnits: upgraded,
        duplicates,
        source,
      };
    }
    // 只持久化**变化过的** step 记录（不再每条事件重写整批 step 游标：28K 表写放大来源之一）。
    const changedStepKeys = [...stepState.keys()].filter((key) => !stepKeysBefore.has(key));
    if (changedStepKeys.length > 0) await persistStepState(changedStepKeys);
    for (const [sessionId, count] of state.attemptOrdinal) {
      await storage.put(USAGE_STEP_CURSOR_TABLE, `attempt:${sessionId}`, { count, updatedAt: clock.now() });
    }
    // 统计**按折算后的单元**更新（重复事件不直接累加）。
    state.duplicatesSuppressed += duplicates;
    state.requestsSeen = state.totals.requests;
    // missingUsage：按 billingKey 持久集合累积（跨批不覆盖、重放不增长；usage 补齐后移出）。
    for (const unit of folded.units) {
      const key = String(unit.billingKey ?? '');
      if (!key) continue;
      if (!unit.usage) state.missingUsageKeys.add(key);
      else state.missingUsageKeys.delete(key);
      if (unit.isSummary === true) state.summaryKeys.add(key);
    }
    state.missingUsageRequests = state.missingUsageKeys.size;
    state.summaries = state.summaryKeys.size;
    state.summariesSeenCounted = new Set(state.summaryKeys);
    state.retries = [...stepState.values()].reduce((sum, value) => sum + Math.max(0, (value.attemptCount ?? 0) - 1), 0);
    state.sources[source] = (state.sources[source] ?? 0) + appended + upgraded;
    const times = list.map((record) => Number(record.time)).filter((value) => Number.isFinite(value) && value > 0);
    if (times.length > 0) {
      state.windowFrom = state.windowFrom === null ? Math.min(...times) : Math.min(state.windowFrom, ...times);
      state.windowTo = state.windowTo === null ? Math.max(...times) : Math.max(state.windowTo, ...times);
    }
    // totals 持久化失败同样是"没有提交"：明确返回失败，调用方不得推进 cursor。
    try {
      await persistTotals();
    } catch (error) {
      return { ok: false, code: 'USAGE_TOTALS_NOT_PERSISTED', message: String(error?.message ?? error), appendedUnits: appended, upgradedUnits: upgraded, duplicates, source };
    }
    const totalsStored = storage.get(USAGE_TOTALS_TABLE, 'main');
    if (!totalsStored || typeof totalsStored !== 'object') {
      return { ok: false, code: 'USAGE_TOTALS_NOT_PERSISTED', appendedUnits: appended, upgradedUnits: upgraded, duplicates, source };
    }
    state.lastIngest = { at: clock.now(), source, appended, upgraded, duplicates };
    return { ok: true, appendedUnits: appended, upgradedUnits: upgraded, duplicates, source, units: folded.units.length, missingUsage: state.missingUsageRequests, summaries: state.summaries };
  }

  /**
   * 审计 JSONL 导入（**只用于验收基线重放**，不是生产归账入口）。
   * 字节游标按原文最后一个换行符的真实偏移推进（CRLF/跨块半行都安全）。
   */
  async function ingestAuditBaseline(options = {}) {
    if (!sourcePath || typeof readRange !== 'function') {
      return { ok: false, code: 'USAGE_SOURCE_UNAVAILABLE', message: '没有配置审计基线路径或读取接口。' };
    }
    const cursor = cursorOf(AUDIT_BASELINE_SOURCE);
    const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1, Math.trunc(options.maxBytes)) : 8 * 1024 * 1024;
    const range = await readRange(sourcePath, cursor.byteOffset, maxBytes);
    if (!range || range.ok !== true) return { ok: false, code: 'USAGE_READ_FAILED', message: range?.error ?? 'read failed' };
    const text = String(range.text ?? '');
    const size = Number(range.size) || 0;
    const reset = cursor.byteOffset > 0 && size < cursor.byteOffset;
    const lastNewline = text.lastIndexOf('\n');
    const consumable = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
    const lines = consumable.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim().length > 0);
    const records = [];
    let malformed = 0;
    for (const line of lines) {
      const parsed = parseUsageLine(line, cursor.lineNo + records.length + 1);
      if (parsed.ok) records.push({ ...parsed.record, source: AUDIT_BASELINE_SOURCE });
      else malformed += 1;
    }
    state.malformedLines += malformed;
    const applied = await ingestRecords(records, { source: AUDIT_BASELINE_SOURCE });
    // **只有账本持久化成功才推进游标**（失败可重读同一段，不假成功）。
    if (applied?.ok !== true) {
      return { ...applied, ok: false, malformed, reset, cursor, source: AUDIT_BASELINE_SOURCE, note: '账本写入失败：游标未推进，下次从同一偏移重读。' };
    }
    const consumedBytes = Buffer.byteLength(consumable, 'utf8');
    const nextCursor = {
      source: AUDIT_BASELINE_SOURCE,
      byteOffset: reset ? consumedBytes : cursor.byteOffset + consumedBytes,
      lineNo: (reset ? 0 : cursor.lineNo) + lines.length,
      fileSize: size,
      lastSeq: records.length > 0 ? Number(records[records.length - 1].seq) || cursor.lastSeq : cursor.lastSeq,
      updatedAt: clock.now(),
    };
    await storage.put(USAGE_CURSOR_TABLE, AUDIT_BASELINE_SOURCE, nextCursor);
    state.readAt = clock.now();
    return { ...applied, malformed, reset, cursor: nextCursor, source: AUDIT_BASELINE_SOURCE, note: '审计基线只用于验收重放，不计入生产归账来源。' };
  }

  /** 只读投影（契约冻结形状 + 分币/阶段/来源扩展）。**不含明细**：明细走 `usageRecords()`。 */
  function snapshot({ teamKey = null, ownerIds = null } = {}) {
    const team = teamKey ? (state.byTeam.get(teamKey) ?? emptyBudget()) : state.totals;
    const allowedOwners = Array.isArray(ownerIds) && ownerIds.length > 0 ? new Set(ownerIds.map(String)) : null;
    const byOwner = {};
    for (const [owner, budget] of state.byOwner) {
      if (allowedOwners && !allowedOwners.has(String(owner))) continue;
      byOwner[owner] = { ...budget };
    }
    const byProviderModel = {};
    for (const [key, value] of state.byProviderModel) byProviderModel[key] = { ...value };
    const byOwnerSelf = {};
    for (const [owner, budget] of state.byOwnerSelf) byOwnerSelf[owner] = { ...budget };
    const byOwnerDescendants = {};
    for (const [owner, budget] of state.byOwnerDescendants) byOwnerDescendants[owner] = { ...budget };
    const estimatedRatio = state.totals.requests > 0 ? Number((state.totals.costUnknownRequests / state.totals.requests).toFixed(4)) : null;
    const mixedCurrency = currencyCount(state.totals.costByCurrency) > 1;
    const book = state.priceBook;
    const single = book.entries.length === 1 && book.entries[0].provider === '*' ? book.entries[0] : null;
    return {
      version: USAGE_VERSION,
      generatedAt: clock.now(),
      currency: book.currency ?? null,
      pricing: {
        version: book.version,
        inputPerMillion: single ? single.inputPerMillion : null,
        outputPerMillion: single ? single.outputPerMillion : null,
        cacheReadPerMillion: single && single.cacheReadKnown ? single.cacheReadPerMillion : null,
        source: book.source,
        entries: book.entries.length,
        tokenNormalization: { inputExcludesCacheRead: true, cacheReadSeparate: true, source: 'dsh-usage-columns' },
        book: book.entries.map((entry) => ({
          provider: entry.provider,
          model: entry.model,
          effectiveFrom: entry.effectiveFrom,
          effectiveTo: entry.effectiveTo,
          // 谷时/时段生效范围（审计原件声明；高峰时段不套用谷价 → cost unknown）。
          effective: entry.effective ?? null,
          source: entry.source ?? book.source,
          currency: entry.currency,
          inputPerMillion: entry.inputPerMillion,
          outputPerMillion: entry.outputPerMillion,
          cacheReadPerMillion: entry.cacheReadKnown ? entry.cacheReadPerMillion : null,
          cacheWritePerMillion: entry.cacheWritePerMillion ?? null,
          cacheReadKnown: entry.cacheReadKnown,
        })),
        estimateOnly: true,
        verified: false,
        note: '价目来源可追溯：审计原件 verify_ledger.py:17（CNY 谷价，工作日高峰外/周末）。高峰时段一律 PEAK_PRICE_UNVERIFIED（unknown≠0）；金额为估算，与服务商账单分开。',
      },
      scopes: {
        team: {
          teamKey: teamKey ?? null,
          cumulative: { ...team },
          phase: {
            id: `host-${state.phaseStartedAt}`,
            label: 'Host 启动至今（仅本阶段新调用，不含历史补录）',
            startedAt: state.phaseStartedAt,
            cumulative: { ...state.phaseTotals },
          },
          attribution: { self: state.phaseTotals, byOwnerSelf, byOwnerDescendants },
        },
        byOwner,
        byProviderModel,
        // 归账维度（契约 v4 §11.1）：阶段 + work；金额仍只按命中价目计，unknown 不填 0。
        byPhase: Object.fromEntries(state.byPhase),
        byWork: Object.fromEntries(state.byWork),
      },
      totals: { ...state.totals },
      unattributed: { ...state.unattributed },
      uncertainty: {
        missingUsageRequests: state.missingUsageRequests,
        unattributedRequests: state.unattributedRequests,
        /** unattributed 分桶（按归属原因；未证明归属不硬摊给 owner/team）。 */
        unattributedBreakdown: Object.fromEntries([...state.unattributedByReason].map(([reason, budget]) => [reason, { requests: budget.requests ?? 0, tokens: (budget.inputTokens ?? 0) + (budget.cacheReadTokens ?? 0) + (budget.outputTokens ?? 0), costUnknownRequests: budget.costUnknownRequests ?? 0, costByCurrency: budget.costByCurrency ?? {} }])),
        estimatedCostRatio: estimatedRatio,
        mixedCurrency,
        notes: [
          'costEstimate 是**估算**（显式价目 × token 数），与服务商账单分开表述；价目未配置/缺列时一律 costUnknownRequests，不按 0 计。',
          state.totals.costUnknownRequests > 0 ? `${state.totals.costUnknownRequests} 条请求的费用未知（缺 usage / 缺 provider-model 价目 / 缺 cache 价）：unknown ≠ 0。` : null,
          state.missingUsageRequests > 0 ? `${state.missingUsageRequests} 条请求缺 usage：不猜 token。` : null,
          state.unattributedRequests > 0 ? `${state.unattributedRequests} 条请求无法证明归属：计入 unattributed，不强行分摊。` : null,
          mixedCurrency ? '存在多种币种：costByCurrency 分币种列出，**不相加**；单一 costEstimate 置 0 并标记 mixedCurrency。' : null,
          state.malformedLines > 0 ? `${state.malformedLines} 行无法解析：保留计数，不静默丢弃。` : null,
        ].filter(Boolean),
      },
      raw: {
        source: NATIVE_SOURCE,
        auditBaselinePath: sourcePath,
        readAt: state.readAt,
        windowFrom: state.windowFrom,
        windowTo: state.windowTo,
        requestsSeen: state.requestsSeen,
        cursor: cursorOf(AUDIT_BASELINE_SOURCE),
        sources: { ...state.sources },
        duplicatesSuppressed: state.duplicatesSuppressed,
        retries: state.retries,
        summaries: state.summaries,
        stepCursors: stepState.size,
        detailEndpoint: '/plugin/team-workbench/op op=usage-records（分页；明细不进 /state）',
        note: '生产归账来自当前宿主 live session 的原生事件游标；审计 JSONL 只做验收基线重放。',
      },
    };
  }

  /** 明细分页（后台读；不进 `/state`、不进模型上下文）。 */
  function usageRecords(options = {}) {
    const limit = Math.min(Math.max(Number.isInteger(options.limit) ? options.limit : 50, 1), 200);
    const offset = Math.min(Math.max(Number.isInteger(options.cursor) ? options.cursor : 0, 0), 1e9);
    const all = storage.list(USAGE_TABLE)
      .map(([, value]) => value)
      .filter((unit) => unit && typeof unit.billingKey === 'string')
      .filter((unit) => !options.provider || unit.provider === options.provider)
      .filter((unit) => !options.model || unit.model === options.model)
      .sort((left, right) => Number(right.time ?? 0) - Number(left.time ?? 0));
    const page = all.slice(offset, offset + limit);
    return {
      ok: true,
      total: all.length,
      cursor: offset,
      limit,
      hasMore: offset + page.length < all.length,
      nextCursor: offset + page.length < all.length ? offset + page.length : null,
      rows: page.map((unit) => ({
        billingKey: unit.billingKey,
        sessionId: unit.sessionId,
        seq: unit.seq,
        turn: unit.turn,
        step: unit.step,
        provider: unit.provider ?? null,
        model: unit.model ?? null,
        time: unit.time ?? 0,
        isSummary: unit.isSummary === true,
        retryIndex: unit.retryIndex ?? 0,
        usage: unit.usage ?? null,
        cost: unit.costKnown ? unit.cost : null,
        costKnown: unit.costKnown === true,
        costUnknownReason: unit.costKnown ? null : (unit.costUnknownReason ?? null),
        currency: unit.costKnown ? (unit.currency ?? null) : null,
        source: unit.source ?? null,
        attribution: unit.attribution ?? null,
        workId: unit.attribution?.workId ?? null,
        phase: Number.isFinite(unit.time) && unit.time >= state.phaseStartedAt ? 'current' : 'historical',
      })),
      note: '费用明细分页读取；/state 只给聚合。costKnown=false 表示费用未知（不是 0）。',
    };
  }

  function markPhaseStart() {
    state.phaseStartedAt = clock.now();
    state.phaseTotals = emptyBudget();
  }

  function priceBookView() {
    return {
      version: state.priceBook.version,
      currency: state.priceBook.currency,
      source: state.priceBook.source,
      verified: false,
      tokenNormalization: { inputExcludesCacheRead: true, cacheReadSeparate: true, source: 'dsh-usage-columns' },
      entries: state.priceBook.entries.map((entry) => ({ ...entry })),
      note: '价目按 provider/model/生效时段；缺省列（如 cache）未配置时相关请求计 unknown。',
    };
  }

  return { hydrate, ingestRecords, ingestAuditBaseline, snapshot, usageRecords, cursorOf, markPhaseStart, priceBookView, state, priceBook: () => state.priceBook, stepState };
}

export const USAGE_TABLES = Object.freeze([USAGE_TABLE, USAGE_CURSOR_TABLE, USAGE_TOTALS_TABLE, USAGE_STEP_CURSOR_TABLE]);
