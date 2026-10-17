/**
 * W08 — 存储 schema 升级 / 停用回滚 的确定性回归。
 *
 *   1. `MIGRATIONS` 缺路径时，`schemaVersion` 不匹配必须**保留原数据**、
 *      置 `migrationRequired=true`、留 `storage:migration-missing` 诊断，不得静默丢弃；
 *   2. `assertTableNames()` 对不匹配 `^[a-z][a-z0-9_]*$` 的表名必须 throw
 *      —— 这是 `lateResults`（驼峰）那个真实缺陷的回归锁；
 *   3. `storage:writer-takeover`：writer 记录的 `pid` 指向已死进程时必须接管并删除该记录；
 *      `pid` 存活（或不可判定）时必须拒绝写入。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createFakeAdapter } from './helpers/fake-adapter.mjs';
import { createFakeContext } from './helpers/fake-ctx.mjs';
import { createFakeStorageDomain, createDomainBackend } from './helpers/fake-domain.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { loadHostModule } from './helpers/host-loader.mjs';

export const meta = {
  id: 'w08-storage-migration',
  title: 'W08：schema 不匹配保数据、表名校验锁、writer 接管/拒绝',
  acceptance: ['W08', 'S07'],
  requires: ['storage', 'adapter'],
};

/** 组装一个只针对存储的运行时（不启动 service/scheduler）。 */
async function storageRuntime(storageModule, adapterModule, { clock, backend, facility }) {
  const domainFacility = facility ?? createFakeStorageDomain({ backend: backend ?? createDomainBackend() });
  const native = createFakeAdapter({ clock, storageDomain: domainFacility });
  const ctx = createFakeContext({ adapter: native, clock });
  const adapter = adapterModule.createAdapter(ctx, {});
  const storage = storageModule.createStorage(ctx, adapter, { clock });
  return { domainFacility, native, ctx, adapter, storage };
}

/** 在 domain 里预置记录，然后关闭，让 storage.open() 能重新打开。 */
async function seedDomain(storageModule, facility, seed) {
  const spec = storageModule.domainSpec();
  const domain = await facility.open(spec);
  if (seed.global) await domain.table('meta').put('global', seed.global);
  for (const [table, rows] of Object.entries(seed.tables ?? {})) {
    for (const [key, value] of Object.entries(rows)) await domain.table(table).put(key, value);
  }
  await domain.close();
  return domain;
}

export async function run() {
  const storageModule = await loadHostModule('storage');
  const adapterModule = await loadHostModule('adapter');
  if (!storageModule.real || !adapterModule.real) {
    return runSuite({ ...meta, pending: true, pendingReason: 'src/host/storage.js 或 adapter.js 不可加载' }, null);
  }
  const { TABLES, assertTableNames, processAlive, DOMAIN_NAME, SCHEMA_VERSION, MIGRATIONS, LATE_RESULTS_TABLE } = storageModule.mod;

  return runSuite(meta, async (suite) => {
    // ------------------------------------------------ 1. schemaVersion 不匹配
    {
      const clock = createFakeClock();
      const backend = createDomainBackend();
      const facility = createFakeStorageDomain({ backend });

      // 先在同一个 backend 里正常写入一些记录。
      const first = await storageRuntime(storageModule.mod, adapterModule.mod, { clock, facility });
      const readyFirst = await first.storage.ready();
      suite.equal(readyFirst.writerHeld, true, '第一个 storage 拿到写权');
      await first.storage.put('teams', 'team-a', { teamKey: 'team-a', status: 'active' });
      await first.storage.put('works', 'w1', { workId: 'w1', state: 'ready' });
      await first.storage.put('works', 'w2', { workId: 'w2', state: 'produced' });
      await first.storage.put('late_results', 'late-1', { lateResultId: 'late-1', reason: 'LEASE_EPOCH_STALE' });
      const worksBefore = first.storage.size('works');
      const teamsBefore = first.storage.size('teams');
      const lateBefore = first.storage.size(LATE_RESULTS_TABLE);
      suite.equal(worksBefore, 2, '预置了 2 条 works 记录');
      await first.storage.releaseWriter();
      await first.storage.close();

      // 把 global 的 schemaVersion 改成没有迁移路径的值。
      const domain = await facility.open(storageModule.mod.domainSpec());
      const global = domain.table('meta').get('global') ?? {};
      await domain.table('meta').put('global', { ...global, schemaVersion: 999 });
      await domain.close();

      const second = await storageRuntime(storageModule.mod, adapterModule.mod, { clock, facility });
      const readySecond = await second.storage.ready();
      suite.equal(readySecond.migrationRequired, true, 'schemaVersion 不匹配且无迁移路径 → migrationRequired=true');
      const storageCodes = (second.storage.diagnostics() ?? []).map((entry) => String(entry.code));
      suite.assert(
        storageCodes.includes('storage:migration-missing'),
        '留下 storage:migration-missing 诊断（不静默）',
        storageCodes,
      );
      suite.equal(second.storage.size('works'), worksBefore, '原 works 记录条数不变（数据被保留）');
      suite.equal(second.storage.size('teams'), teamsBefore, '原 teams 记录条数不变');
      suite.equal(second.storage.size(LATE_RESULTS_TABLE), lateBefore, '原 late_results 记录条数不变');
      const preserved = second.storage.get('works', 'w1');
      suite.equal(preserved?.workId, 'w1', '单条记录内容原样保留（workId 未被改写）');
      suite.equal(preserved?.state, 'ready', '单条记录状态原样保留');
      suite.equal(preserved?.rev, 1, '单条记录的 revision 没有被迁移逻辑重置');
      suite.equal(second.storage.get('works', 'w2').state, 'produced', '已完成状态没有被冲掉');
      await second.storage.releaseWriter();
      await second.storage.close();

      suite.equal(SCHEMA_VERSION, 1, '当前 SCHEMA_VERSION = 1');
      suite.assert(!MIGRATIONS[999], 'MIGRATIONS 里确实没有 999 的路径（复现的是"缺迁移"分支）');
    }

    // ------------------------------------------------ 2. 表名校验（回归锁）
    {
      suite.equal(assertTableNames(), true, '默认 TABLES 全部通过表名校验');
      suite.equal(assertTableNames([...TABLES]), true, '显式传入 TABLES 也通过');
      suite.assert(TABLES.includes(LATE_RESULTS_TABLE), `TABLES 使用 snake_case 的 ${LATE_RESULTS_TABLE}`, TABLES);
      suite.equal(TABLES.includes('lateResults'), false, 'TABLES 不含驼峰 lateResults（真实缺陷的回归锁）');

      let threw = null;
      try {
        assertTableNames([...TABLES.filter((name) => name !== LATE_RESULTS_TABLE), 'lateResults']);
      } catch (error) {
        threw = error;
      }
      suite.assert(threw !== null, '驼峰表名 lateResults 必须 throw（否则 storageDomain 会拒绝整个域）', threw?.message ?? 'no throw');
      suite.includes(String(threw?.message ?? ''), 'lateResults', '错误信息里点名了非法表名');

      let threwBad = null;
      try {
        assertTableNames(['ok_table', 'Bad-Name']);
      } catch (error) {
        threwBad = error;
      }
      suite.assert(threwBad !== null, '其它不匹配 ^[a-z][a-z0-9_]*$ 的名字同样 throw');
      suite.equal(DOMAIN_NAME.match(/^[a-z][a-z0-9_]*$/) !== null, true, `domain 名 ${DOMAIN_NAME} 合法`);
    }

    // ------------------------------------------------ 3. processAlive / writer
    {
      const clock = createFakeClock();
      suite.equal(processAlive(process.pid), true, 'processAlive 对本进程 pid 返回 true');
      suite.equal(processAlive(999_999_999), false, 'processAlive 对不存在的 pid 返回 false');
      suite.equal(processAlive(null), null, 'processAlive 对非法 pid 返回 null（不可判定）');
      suite.equal(processAlive(-1), null, 'processAlive 对负数返回 null');
    }

    // ---- 3a. 死进程的 writer 记录 → 接管 ----
    {
      const clock = createFakeClock();
      const backend = createDomainBackend();
      const facility = createFakeStorageDomain({ backend });
      await seedDomain(storageModule.mod, facility, {
        tables: {
          writer: {
            'dead-epoch': { epoch: 'dead-epoch', replicaId: 'ghost', pid: 999_999_999, claimedAt: clock.now() - 1000, heartbeatAt: clock.now() },
          },
        },
      });

      const runtime = await storageRuntime(storageModule.mod, adapterModule.mod, { clock, facility });
      const ready = await runtime.storage.ready();
      suite.equal(ready.writerHeld, true, 'writer 记录指向已死进程时，新进程接管写权');
      suite.equal(ready.secondWriter, null, '接管后没有第二个写者冲突');
      const codes = (runtime.storage.diagnostics() ?? []).map((entry) => String(entry.code));
      suite.assert(codes.includes('storage:writer-takeover'), '留下 storage:writer-takeover 诊断', codes);
      const table = runtime.domainFacility.get(DOMAIN_NAME)?.table('writer');
      suite.equal(table?.get('dead-epoch'), undefined, '已死写者的记录被删除（不再阻塞后续进程）');
      suite.equal(table?.get(runtime.storage.writerEpoch) !== undefined, true, '本进程的 writer 记录已写入');
      await runtime.storage.releaseWriter();
      await runtime.storage.close();
    }

    // ---- 3b. 外部存活进程的 writer 记录 → 拒绝（pid ≠ 本进程） ----
    {
      const clock = createFakeClock();
      const backend = createDomainBackend();
      const facility = createFakeStorageDomain({ backend });
      // 必须用**别的**存活 pid：同 pid 会被判为"上一个世代"而接管（见 3c）。
      const externalPid = processAlive(process.ppid) === true ? process.ppid : null;
      await seedDomain(storageModule.mod, facility, {
        tables: {
          writer: {
            'alive-epoch': externalPid === null
              // 取不到别的活 pid 时退到"不可判定 + 心跳新鲜"分支（同样是冲突）。
              ? { epoch: 'alive-epoch', replicaId: 'other-host', pid: null, claimedAt: clock.now() - 1000, heartbeatAt: clock.now() }
              : { epoch: 'alive-epoch', replicaId: 'other-host', pid: externalPid, claimedAt: clock.now() - 1000, heartbeatAt: clock.now() },
          },
        },
      });

      const runtime = await storageRuntime(storageModule.mod, adapterModule.mod, { clock, facility });
      const ready = await runtime.storage.ready();
      suite.equal(ready.writerHeld, false, '外部存活进程持锁时，本进程不拿写权');
      suite.assert(Array.isArray(ready.secondWriter) && ready.secondWriter.length === 1, 'secondWriter 记录冲突写者', ready.secondWriter);
      suite.equal(ready.secondWriter?.[0]?.epoch, 'alive-epoch', '冲突写者 epoch 准确');
      const codes = (runtime.storage.diagnostics() ?? []).map((entry) => String(entry.code));
      suite.assert(codes.includes('storage:second-writer'), '留下 storage:second-writer 诊断', codes);
      const write = await runtime.storage.put('teams', 'team-x', { teamKey: 'team-x' });
      suite.equal(write.ok, false, '只读诊断态下所有写入被拒绝');
      suite.equal(write.code, 'SECOND_WRITER', '写入拒绝码为 SECOND_WRITER');
      const table = runtime.domainFacility.get(DOMAIN_NAME)?.table('writer');
      suite.equal(table?.get('alive-epoch') !== undefined, true, '存活写者的记录没有被删除（不抢写）');
      suite.note(`3b 使用的外部存活 pid=${externalPid ?? 'null(心跳新鲜分支)'}`);
      await runtime.storage.close();
    }

    // ---- 3c. 同一 pid 的 writer 记录 = 上一个插件世代 → 接管 ----
    // 判据是**裸 pid**：操作系统不会把同一个 pid 分配给两个进程，
    // 所以 `pid === process.pid` 在真实世界里只可能是本进程的历史世代（热重载）。
    // 不引入 replicaId 形状之类的二级判据。
    {
      const clock = createFakeClock();
      const backend = createDomainBackend();
      const facility = createFakeStorageDomain({ backend });
      await seedDomain(storageModule.mod, facility, {
        tables: {
          writer: {
            'previous-generation': { epoch: 'previous-generation', replicaId: `${process.pid}-oldgen`, pid: process.pid, claimedAt: clock.now() - 1000, heartbeatAt: clock.now() },
          },
        },
      });

      const runtime = await storageRuntime(storageModule.mod, adapterModule.mod, { clock, facility });
      const ready = await runtime.storage.ready();
      suite.equal(ready.writerHeld, true, '同 pid 的旧世代 writer 记录不阻塞本世代（热重载后可写）');
      suite.equal(ready.secondWriter, null, '同 pid 的旧世代不被判为 SECOND_WRITER');
      const codes = (runtime.storage.diagnostics() ?? []).map((entry) => String(entry.code));
      suite.assert(codes.includes('storage:writer-takeover'), '留下 storage:writer-takeover 诊断', codes);
      const takeover = (runtime.storage.diagnostics() ?? []).find((entry) => entry.code === 'storage:writer-takeover');
      const details = Array.isArray(takeover?.detail) ? takeover.detail : [];
      suite.assert(
        details.some((entry) => entry.reason === 'SAME_PROCESS_PREVIOUS_GENERATION'),
        '接管原因标记为 SAME_PROCESS_PREVIOUS_GENERATION',
        details,
      );
      const table = runtime.domainFacility.get(DOMAIN_NAME)?.table('writer');
      suite.equal(table?.get('previous-generation'), undefined, '旧世代 writer 记录被清理');
      const ours = table?.get(runtime.storage.writerEpoch);
      suite.assert(ours !== undefined, '本世代的 writer 记录已写入', ours);
      suite.equal(ours?.pid, process.pid, '本世代 writer 记录的 pid === process.pid');
      const write = await runtime.storage.put('teams', 'team-y', { teamKey: 'team-y' });
      suite.equal(write.ok, true, '接管后本世代可写（不进入只读态）');
      await runtime.storage.releaseWriter();
      await runtime.storage.close();
    }

    // ---- 4. already-open（上一世代仍持有 handle）→ 接管而不是降级 ----
    {
      const clock = createFakeClock();
      const backend = createDomainBackend();
      const facility = createFakeStorageDomain({ backend });

      // 先把 domain 打开并灌入数据，**保持打开**（模拟上一世代还没 dispose）。
      const heldDomain = await facility.open(storageModule.mod.domainSpec());
      await heldDomain.table('teams').put('team-held', { teamKey: 'team-held', status: 'active' });
      await heldDomain.table('works').put('w-held-1', { workId: 'w-held-1', state: 'producing' });
      await heldDomain.table('works').put('w-held-2', { workId: 'w-held-2', state: 'ready' });
      await heldDomain.table('attempts').put('a-held-1', { attemptId: 'a-held-1', workId: 'w-held-1', state: 'executing' });
      await heldDomain.table('meta').put('global', { schemaVersion: SCHEMA_VERSION, revision: 7, writerEpoch: null, updatedAt: clock.now() });
      let heldCloseCalls = 0;
      const heldClose = heldDomain.close.bind(heldDomain);
      heldDomain.close = async () => {
        heldCloseCalls += 1;
        return heldClose();
      };
      suite.equal(facility.isOpen(DOMAIN_NAME), true, '预置 domain 处于已打开状态（open 会抛 already-open）');

      const runtime = await storageRuntime(storageModule.mod, adapterModule.mod, { clock, facility });
      const ready = await runtime.storage.ready();
      suite.equal(ready.backend, 'storageDomain', 'already-open 时接管同一个 handle，不退 fallback');
      suite.equal(ready.degraded, false, '接管路径不是降级（degraded=false）');
      suite.equal(ready.openedByUs, false, 'openedByUs=false（handle 不是本世代开的）');
      suite.equal(ready.migrationRequired, false, 'schemaVersion 匹配时不置 migrationRequired');
      suite.equal(ready.durable, true, '接管后仍是持久的');
      suite.equal(ready.writerHeld, true, '接管后拿到写权');

      const codes = (runtime.storage.diagnostics() ?? []).map((entry) => String(entry.code));
      suite.assert(codes.includes('storage:adopted-open-domain'), '留下 storage:adopted-open-domain 诊断', codes);
      suite.equal(codes.includes('storage:domain-unavailable'), false, '没有误判成 storageDomain 不可用');
      suite.equal(codes.includes('storage:fallback-active'), false, '没有切到插件自有的空 JSON 库（避免 split-brain）');

      const loaded = runtime.storage.loadAll();
      suite.equal(runtime.storage.size('teams'), 1, '接管后读得到预置 team（不是 0）');
      suite.equal(runtime.storage.size('works'), 2, '接管后读得到预置 work（不是 0）');
      suite.equal(runtime.storage.size('attempts'), 1, '接管后读得到预置 attempt（不是 0）');
      suite.equal(Object.keys(loaded.tables?.works ?? {}).length, 2, 'loadAll() 返回预置的 works 记录');
      suite.equal(runtime.storage.get('works', 'w-held-1')?.state, 'producing', '单条记录内容原样可读');
      suite.equal(loaded.revision >= 7, true, '接管后沿用了原 global revision', loaded.revision);

      await runtime.storage.close();
      suite.equal(heldCloseCalls, 0, 'close() 没有关闭接管来的 handle（留给它的属主）');
      suite.equal(facility.isOpen(DOMAIN_NAME), true, '接管来的 domain 仍处于打开状态');
      await heldDomain.close();
    }
  });
}

if (isMain(import.meta.url)) await main(run, meta);
