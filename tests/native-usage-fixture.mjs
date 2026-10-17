#!/usr/bin/env node
/**
 * 隔离 fixture：nativeUsage 4 项修复验证（不依赖真实 DSH）。
 * - nested stream usage=null → 能深入 chat.completion.chunk 提取 usage
 * - header provider/model 跨事件/跨页继承
 * - live 读后 coverage 非 0（sessions/from/to）
 * - 账本 ingestRecords 失败 → cursor 不推进
 *
 * 运行：node tests/native-usage-fixture.mjs
 */

import { recordFromSessionEvent, recordsFromSessionEvents, createNativeUsageCollector } from '../src/host/nativeUsage.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail = null) {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name} :: ${JSON.stringify(detail)}`); }
}

const usageEvent = (seq, stream, extra = {}) => ({
  seq,
  time: 1000 + seq,
  type: 'assistant/message',
  data: { turn: 1, step: 1, ...extra, stream },
});

// 1) nested stream usage：usage 藏在 chat.completion.chunk 的 usage 里
{
  const nested = usageEvent(1, { chunks: [{ type: 'chat.completion.chunk', usage: { input_tokens: 11, output_tokens: 7 } }] });
  const record = recordFromSessionEvent('s1', nested);
  check('nested stream usage 提取（input=11 output=7）', record?.usage?.input_tokens === 11 && record?.usage?.output_tokens === 7, record?.usage ?? null);
  const deep = usageEvent(2, { object: 'chat.completion', choices: [{ message: { usage: { prompt_tokens: 3, completion_tokens: 4 } } }] });
  const deepRecord = recordFromSessionEvent('s1', deep);
  check('深层嵌套 usage 提取（prompt=3）', deepRecord?.usage?.prompt_tokens === 3, deepRecord?.usage ?? null);
}

// 2) header provider/model 跨事件继承
{
  const events = [
    usageEvent(1, { chunks: [{ usage: { input_tokens: 1 } }] }, { provider: 'deepseek-account', model: 'deepseek-flash' }),
    usageEvent(2, { chunks: [{ usage: { input_tokens: 2 } }] }, {}),
  ];
  const records = recordsFromSessionEvents('s2', events);
  check('header provider/model 跨事件保留', records[1]?.provider === 'deepseek-account' && records[1]?.model === 'deepseek-flash', records[1]);
  const viaHeader = recordsFromSessionEvents('s2', [usageEvent(1, { chunks: [{ usage: { input_tokens: 1 } }] }, {})], { header: { provider: 'p', model: 'm' } });
  check('header 参数作为初始继承值', viaHeader[0]?.provider === 'p' && viaHeader[0]?.model === 'm', viaHeader[0]);
}

// 3) live 读后 coverage 非 0 + 4) 失败不推进 cursor
async function collectorCase(ingestOk) {
  const saved = [];
  const session = {
    id: 'session-x',
    seq: 10,
    header: { provider: 'deepseek-account', model: 'deepseek-flash' },
    snapshotEvents: (from) => [
      usageEvent(10 + from, { chunks: [{ usage: { input_tokens: 5, output_tokens: 2 } }] }),
    ],
  };
  const ledger = {
    ingestRecords: async () => (ingestOk ? { ok: true, appendedUnits: 1 } : { ok: false, code: 'SIDECAR_FLUSH_FAILED' }),
  };
  const collector = createNativeUsageCollector({
    adapter: { listAgents: () => [{ id: 'session-x' }] },
    ledger,
    clock: { now: () => 5000 },
    sessionOf: () => session,
    saveCursor: async (sessionId, seq) => saved.push({ sessionId, seq }),
    loadCursor: () => 0,
  });
  await collector.collect();
  return { collector, saved };
}
{
  const ok = await collectorCase(true);
  const coverage = ok.collector.coverageSnapshot();
  check('live 读后 coverage.sessions>0 且有窗口', coverage.sessions > 0 && coverage.from !== null && coverage.to !== null, coverage);
  check('成功时 cursor 推进', ok.saved.length === 1 && ok.saved[0].seq === 11, ok.saved);
  const bad = await collectorCase(false);
  check('账本失败时 cursor 不推进（不丢账）', bad.saved.length === 0, bad.saved);
  const badCoverage = bad.collector.coverageSnapshot();
  check('账本失败进入 gaps 可见', badCoverage.gaps.some((gap) => gap.reason === 'SIDECAR_FLUSH_FAILED'), badCoverage.gaps);
}

console.log(`\nnative-usage fixture: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
