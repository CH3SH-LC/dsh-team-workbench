/**
 * W10 — 存储键编码与"不再静默分叉"回归（批次 C 的 A 类数据完整性缺陷）。
 *
 * 真实缺陷（Lead 在真实进程上抓到）：
 *   `layout:'per-record'` 的 JSON 后端把键当**文件名**，只接受 `^[a-zA-Z0-9_-]+$`。
 *   `members` 表的键是 `${teamKey}/${name}`（含 `/`）→ 写入必然失败；而旧代码**忽略
 *   `put` 的返回值** → 成员只活在内存里 → 重启后成员消失、work 仍指向这些 ownerMemberId。
 *   连带：`idempotency` 表键含 `:`，**从未落盘**，幂等/去重保护在重启后失效。
 *
 * 本套件让假 storageDomain **模仿真实后端**（键不安全直接抛 `not path-safe`），
 * 从而把"域边界键编码"和"落盘失败必须上报"变成硬回归。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createFakeAdapter } from './helpers/fake-adapter.mjs';
import { createFakeContext } from './helpers/fake-ctx.mjs';
import { createFakeStorageDomain, createDomainBackend } from './helpers/fake-domain.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';
import { loadHostModule } from './helpers/host-loader.mjs';

export const meta = {
  id: 'w10-storage-key-encoding',
  title: '存储键编码：含 / 与 : 的键必须能落盘；落盘失败必须上报；孤儿 owner 对账',
  acceptance: ['W08', 'S07'],
  requires: ['storage', 'service', 'adapter'],
};

const PATH_SAFE = /^[a-zA-Z0-9_-]+$/;

async function storageRuntime(storageModule, adapterModule, { clock, facility }) {
  const native = createFakeAdapter({ clock, storageDomain: facility });
  const ctx = createFakeContext({ adapter: native, clock });
  const adapter = adapterModule.createAdapter(ctx, {});
  const storage = storageModule.createStorage(ctx, adapter, { clock });
  return { native, ctx, adapter, storage, facility };
}

export async function run() {
  const storageModule = await loadHostModule('storage');
  const adapterModule = await loadHostModule('adapter');
  if (!storageModule.real || !adapterModule.real) {
    return runSuite({ ...meta, pending: true, pendingReason: 'src/host/storage.js 或 adapter.js 不可加载' }, null);
  }
  const { DOMAIN_NAME } = storageModule.mod;

  return runSuite(meta, async (suite) => {
    // ---- 1. 含 `/` 与 `:` 的键必须能落盘，且调用方看到的键不被污染 ------------------
    {
      const clock = createFakeClock();
      const facility = createFakeStorageDomain({ backend: createDomainBackend() });
      const rt = await storageRuntime(storageModule.mod, adapterModule.mod, { clock, facility });
      const ready = await rt.storage.ready();
      suite.equal(ready.writerHeld, true, 'storage 就绪并拿到写权');

      const memberKey = 'team-x/member-y';
      const putMember = await rt.storage.put('members', memberKey, { memberId: 'member-y', teamKey: 'team-x' });
      suite.equal(putMember.ok, true, 'put(members, "team-x/member-y") 成功（假后端强制 path-safe）');
      suite.equal(rt.storage.get('members', memberKey)?.memberId, 'member-y', 'get 用原键取回同一对象（键未被编码污染）');
      const listed = rt.storage.list('members');
      suite.assert(
        listed.some(([key]) => key === memberKey),
        'list() 暴露的键逐字符等于调用方写入的键',
        listed.map(([key]) => key),
      );

      const domainKeys = [...facility.get(DOMAIN_NAME).table('members').keys()];
      suite.assert(
        domainKeys.length > 0 && domainKeys.every((key) => PATH_SAFE.test(key)),
        '域里的实际键全部落在安全字符集内（编码发生在域边界）',
        domainKeys,
      );
      suite.equal(domainKeys.includes(memberKey), false, '域里不存在未编码的 "team-x/member-y"');

      const putIdem = await rt.storage.put('idempotency', 'svc:work:1', { at: clock.now(), rev: 1 });
      suite.equal(putIdem.ok, true, 'put(idempotency, "svc:work:1") 成功（覆盖含 ":" 的键）');
      const idemKeys = [...facility.get(DOMAIN_NAME).table('idempotency').keys()];
      suite.assert(idemKeys.length > 0 && idemKeys.every((key) => PATH_SAFE.test(key)), 'idempotency 表在域里也是安全键', idemKeys);

      // ---- 3. 编码可逆：端到端往返（不必导出内部函数） --------------------------
      for (const key of ['a/b', 'c:d', 'e.f', 'g h', '中文键']) {
        const stored = await rt.storage.put('members', key, { key });
        const readBack = rt.storage.get('members', key);
        suite.assert(
          stored.ok === true && readBack?.key === key,
          `编码可逆：含特殊字符的键往返一致（${key}）`,
          { ok: stored.ok, readBack: readBack?.key ?? null },
        );
      }
      suite.assert(
        [...facility.get(DOMAIN_NAME).table('members').keys()].every((key) => PATH_SAFE.test(key)),
        '所有特殊键都经过编码后落盘',
      );
      await rt.storage.releaseWriter();
      await rt.storage.close();
    }

    // ---- 2. 向后兼容：预置未编码的旧键，hydrate 后逐字符读回 ----------------------
    {
      const clock = createFakeClock();
      const backend = createDomainBackend();
      const facility = createFakeStorageDomain({ backend });
      const spec = storageModule.mod.domainSpec();
      const seedDomain = await facility.open(spec);
      const legacy = [
        ['teams', 'wb-real-verify', { teamKey: 'wb-real-verify' }],
        ['works', 'nav-core', { workId: 'nav-core' }],
        ['attempts', 'attempt-abc123', { attemptId: 'attempt-abc123' }],
        ['layout', 'current', { mode: 1 }],
        ['meta', 'global', { schemaVersion: storageModule.mod.SCHEMA_VERSION, revision: 1, writerEpoch: null, updatedAt: 0 }],
      ];
      for (const [table, key, value] of legacy) await seedDomain.table(table).put(key, value);
      await seedDomain.close();

      const rt = await storageRuntime(storageModule.mod, adapterModule.mod, { clock, facility });
      await rt.storage.ready();
      for (const [table, key, value] of legacy) {
        const read = rt.storage.get(table, key);
        suite.assert(read !== undefined, `向后兼容：旧键 ${table}/${key} 在 hydrate 后仍可读`, { table, key });
        if (table !== 'meta') {
          suite.equal(read?.[Object.keys(value)[0]], value[Object.keys(value)[0]], `旧键 ${table}/${key} 的内容逐字段一致`);
        }
      }
      const listedKeys = rt.storage.list('teams').map(([key]) => key);
      suite.deepEqual(listedKeys, ['wb-real-verify'], '旧键没有被解析成 zz- 编码形式');
      suite.equal(rt.storage.get('teams', 'zz-00770062002d007200650061006c002d007600650072006900660079'), undefined, '按编码字符串去查旧键取不到（说明没有二次编码）');
      await rt.storage.releaseWriter();
      await rt.storage.close();
    }

    // ---- 4. 不再静默分叉：落盘失败必须上报 --------------------------------------
    {
      const clock = createFakeClock();
      const backend = createDomainBackend();
      const facility = createFakeStorageDomain({ backend });
      const workbench = await createWorkbench({ clock, domainFacility: facility, config: { capacity: { globalLeafLimit: 4 } } });
      if (workbench.mode !== 'real') {
        suite.fail('真实 Host 模块可用（第 4 组）', { mode: workbench.mode, pendingReason: workbench.pendingReason });
      } else {
        const lead = leadAgent(workbench);
        await workbench.service.defineTeam(lead, { teamKey: 'team-a' });
        // 让此后所有域写入失败
        backend.failNextWrites = 1_000_000;
        const created = await workbench.service.createMember(lead, {
          teamKey: 'team-a',
          name: 'doomed',
          description: '落盘必然失败的成员',
        });
        const codes = (workbench.service.diagnostics.list() ?? []).map((entry) => String(entry.code));
        suite.equal(created.ok, true, '落盘失败时 createMember 仍返回 ok:true（本次会话可用）');
        suite.equal(created.persisted, false, '同时明确返回 persisted:false（不再静默分叉）', created);
        suite.assert(typeof created.warning === 'string' && created.warning.length > 0, '带非空 warning 告知"重启会丢"', created.warning);
        suite.assert(
          codes.includes('service:createMember:not-persisted'),
          '留下 service:createMember:not-persisted 诊断',
          codes.slice(-6),
        );
        // 旧行为（ok:true 且无任何提示）必须被判失败：
        suite.assert(
          created.persisted === false || typeof created.warning === 'string',
          '不允许出现"ok:true 且无提示"的旧行为',
          { persisted: created.persisted, warning: created.warning },
        );
      }
    }

    // ---- 5. 孤儿 owner 对账：标记 blocked，不删除、不代跑 -------------------------
    {
      const clock = createFakeClock();
      const workbench = await createWorkbench({ clock, config: { capacity: { globalLeafLimit: 4 } } });
      if (workbench.mode !== 'real') {
        suite.fail('真实 Host 模块可用（第 5 组）', { mode: workbench.mode, pendingReason: workbench.pendingReason });
      } else {
        const { service } = workbench;
        const lead = leadAgent(workbench);
        await service.defineTeam(lead, { teamKey: 'team-a' });
        await service.createMember(lead, { teamKey: 'team-a', name: 'ghost', description: '即将消失的成员' });
        const submitted = await service.submitWork(lead, {
          teamKey: 'team-a',
          workId: 'orphan-1',
          title: '孤儿 owner 的交付',
          deliverable: '孤儿 owner 模块的完整实现',
          ownerMemberId: 'ghost',
          outputs: ['src/orphan/index.ts'],
          acceptance: ['可集成'],
        });
        suite.equal(submitted.ok, true, '工作项提交成功（owner 当时存在）');
        // 模拟"成员从未落盘 / 落盘丢失"：sidecar 内存与持久表里都不再有这个 owner。
        // ⚠️ service 用的键形是 `${teamKey}/${memberId}`（不是裸 memberId），
        //    且 teamKey 必须**从 work 记录取**、不能硬编码。
        const beforeWork = service.works.get('orphan-1');
        const ownerKey = `${beforeWork.teamKey}/${beforeWork.ownerMemberId}`;
        service.members.delete(ownerKey);
        await service.storage.remove('members', ownerKey);

        // ---- 第一步：显式断言前置条件（否则后面的红无法归因） ------------------
        const memberIds = [...service.members.values()].map((member) => member.memberId);
        suite.equal(memberIds.includes('ghost'), false, '前置：snapshot.members 里不存在 memberId === "ghost"', { memberIds, ownerKey });
        suite.equal(service.storage.get('members', ownerKey), undefined, '前置：storage.get("members", ownerKey) 为 undefined', { ownerKey });
        const memberKeys = service.storage.list('members').map(([key]) => key);
        suite.equal(memberKeys.includes(ownerKey), false, '前置：storage.list("members") 不含该键', { memberKeys, ownerKey });
        suite.equal(beforeWork.activeAttemptId ?? null, null, '前置：该 work 没有活跃 attempt（否则孤儿对账会被故意跳过）', beforeWork.activeAttemptId);

        const report = await service.reconcile();
        const work = service.works.get('orphan-1');
        suite.equal(work?.state, 'blocked', 'reconcile 后孤儿 owner 的工作项被标记 blocked', { state: work?.state, blockedReason: work?.blockedReason, activeAttemptId: work?.activeAttemptId, teamKey: work?.teamKey, ownerMemberId: work?.ownerMemberId });
        suite.equal(work?.blockedReason, 'OWNER_MEMBER_MISSING', 'blockedReason 为 OWNER_MEMBER_MISSING', work?.blockedReason);
        suite.assert(
          Array.isArray(report?.orphanOwner) && report.orphanOwner.some((entry) => (entry.workId ?? entry) === 'orphan-1'),
          'report.orphanOwner 含该 work',
          { orphanOwner: report?.orphanOwner, work: { state: work?.state, blockedReason: work?.blockedReason, activeAttemptId: work?.activeAttemptId, teamKey: work?.teamKey, ownerMemberId: work?.ownerMemberId } },
        );
        suite.equal(service.works.get('orphan-1') !== undefined, true, '工作项没有被自动删除');
        suite.equal(service.works.get('orphan-1')?.state !== 'ready', true, '工作项没有被自动改为 ready（不代跑）');
        const codes = (service.diagnostics.list() ?? []).map((entry) => String(entry.code));
        suite.assert(codes.includes('service:reconcile:orphan-owner'), '留下 service:reconcile:orphan-owner 诊断', codes.slice(-6));
        await workbench.dispose();
      }
    }

    // ---- 6. blockedReason 门控：只有 DEPENDENCIES_UNSATISFIED 允许自动放行 ----------
    // 根因（Lead 复盘）：`reconcileInLock` 末尾那个「依赖满足就放回 ready」的循环
    // **没有看 `blockedReason`**。孤儿 work 的 `blockedBy` 是空数组 → `every(...)` 恒真
    // → 刚写进去的 `blocked(OWNER_MEMBER_MISSING)` 被**同一个 reconcile** 立刻改回 ready
    //（实测 rev 2→3 写过盘、state 仍是 ready）。
    // 更严重：`REPEATED_IDENTICAL_FAILURE` / `ATTEMPT_BUDGET_EXHAUSTED` 同样会被每次
    // `reconcile()` 复活，而 `reconcile()` 在**每次 Host 启动**与 `team_recover` 都会跑
    // ⇒ **重启即重试风暴**，直接命中"重启/重复事件不造成重复工作"。
    // 修法：只有 `DEPENDENCIES_UNSATISFIED` 才允许自动放行，其他原因必须显式解除。
    // 构造要点（Lead 提示）：**用 owner 存在的 work**，别用孤儿 —— 孤儿会被孤儿对账
    // 永远重新标记，测不到依赖分支。
    {
      const workbench = await createWorkbench({ clock: createFakeClock(), config: { capacity: { globalLeafLimit: 4 } } });
      if (workbench.mode !== 'real') {
        suite.fail('真实 Host 模块可用（第 6 组）', { mode: workbench.mode, pendingReason: workbench.pendingReason });
      } else {
        const { service } = workbench;
        const lead = leadAgent(workbench);
        await service.defineTeam(lead, { teamKey: 'team-a' });
        // owner 必须真实存在（`submitWork` 对未知 owner 前置拒绝 `OWNER_NOT_MEMBER`）
        await service.createMember(lead, { teamKey: 'team-a', name: 'steady', description: '长期存在的 owner' });
        const requeuedIds = (report) => (report?.requeued ?? []).map((entry) => entry?.workId ?? entry);
        // P1-5 之后的身份规则：blocked 的返工必须沿用原 workId，同一 owner 的"同名同产物"新 id
        // 会被 `REWORK_REQUIRES_ORIGINAL_WORK_ID` 拒绝。本组要测的是 reconcile 的 blockedReason
        // 门控（不同原因是否被自动放行），因此每个种子必须是**真正不同的交付物**（独立产物/验收），
        // 不能用相同 outputs 改名——那样会被正确拒绝、取到 undefined。断言本身不变。
        const seedBlocked = async (workId, blockedReason) => {
          const submitted = await service.submitWork(lead, {
            teamKey: 'team-a',
            workId,
            title: `blockedReason 门控（${workId}）`,
            deliverable: `门控回归的完整实现（${workId}）`,
            ownerMemberId: 'steady',
            outputs: [`src/gate/${workId}/index.ts`],
            acceptance: [`可集成（${workId}）`],
          });
          suite.assert(submitted?.ok === true, `种入 blocked 门控样本 ${workId}（独立交付物）`, submitted);
          const record = service.works.get(workId);
          suite.assert(Boolean(record), `种入后能从 service.works 读到 ${workId}`, { workId });
          if (!record) return null;
          record.state = 'blocked';
          record.blockedReason = blockedReason;
          record.blockedBy = []; // 依赖"已满足"，确保抓住的是 blockedReason 门控而不是依赖未满足
          // ⚠️ 关键契约（Lead 定位）：`storage.put()` 会分配**新的 rev 并返回记录**；
          // 任何直接写 storage 的测试**必须采纳返回记录**（`service.works.set(id, stored.record)`），
          // 否则内存 rev 与 storage 不一致 → service 的 `expectRev` 必然 CAS 失败 →
          // reconcile 的自动放行**静默 no-op**（现在会带 `service:reconcile:revive-cas-miss` 诊断）。
          // service 自己的每条写路径都是 `const stored = await put(...); if (stored.ok) this.works.set(id, stored.record);`
          const stored = await service.storage.put('works', workId, { ...record });
          if (stored.ok) service.works.set(workId, stored.record);
          return record;
        };

        // 1. 永久失败：reconcile 不得复活
        await seedBlocked('perm-fail', 'REPEATED_IDENTICAL_FAILURE');
        const report1 = await service.reconcile();
        const afterFail = service.works.get('perm-fail');
        suite.assert(
          afterFail.state === 'blocked' && afterFail.blockedReason === 'REPEATED_IDENTICAL_FAILURE',
          'REPEATED_IDENTICAL_FAILURE：reconcile 后仍 blocked 且 blockedReason 不变',
          { state: afterFail.state, blockedReason: afterFail.blockedReason, rev: afterFail.rev },
        );
        suite.assert(
          requeuedIds(report1).includes('perm-fail') === false,
          'REPEATED_IDENTICAL_FAILURE：不出现在 report.requeued（不被自动放行）',
          { requeued: requeuedIds(report1) },
        );

        // 2. attempt 预算耗尽：同样不得复活
        await seedBlocked('budget-out', 'ATTEMPT_BUDGET_EXHAUSTED');
        const report2 = await service.reconcile();
        const afterBudget = service.works.get('budget-out');
        suite.assert(
          afterBudget.state === 'blocked' && afterBudget.blockedReason === 'ATTEMPT_BUDGET_EXHAUSTED',
          'ATTEMPT_BUDGET_EXHAUSTED：reconcile 后仍 blocked 且 blockedReason 不变',
          { state: afterBudget.state, blockedReason: afterBudget.blockedReason, rev: afterBudget.rev },
        );
        suite.assert(
          requeuedIds(report2).includes('budget-out') === false,
          'ATTEMPT_BUDGET_EXHAUSTED：不出现在 report.requeued',
          { requeued: requeuedIds(report2) },
        );

        // 3. 正向护栏：依赖未满足但依赖已满足时仍必须自动放行
        await seedBlocked('dep-wait', 'DEPENDENCIES_UNSATISFIED');
        const report3 = await service.reconcile();
        const afterDep = service.works.get('dep-wait');
        suite.assert(
          afterDep.state === 'ready' && afterDep.blockedReason == null,
          'DEPENDENCIES_UNSATISFIED 且依赖已满足 → 仍要变 ready（正向护栏，不把自动放行收死）',
          { state: afterDep.state, blockedReason: afterDep.blockedReason, rev: afterDep.rev },
        );
        suite.assert(
          requeuedIds(report3).includes('dep-wait'),
          'DEPENDENCIES_UNSATISFIED 且依赖已满足 → 出现在 report.requeued',
          { requeued: requeuedIds(report3) },
        );
        // 顺带：CВS 失败曾经是**静默 no-op**，现在有诊断。断言它不出现，
        // 用来区分"条件没满足"与"条件满足但写不进去"。
        const gateCodes = (service.diagnostics.list() ?? []).map((entry) => String(entry.code));
        suite.assert(
          gateCodes.includes('service:reconcile:revive-cas-miss') === false,
          '正向护栏：不出现 service:reconcile:revive-cas-miss（放行条件满足且写入成功）',
          gateCodes.slice(-6),
        );
        await workbench.dispose();
      }
    }

    // ---- 7. 「检测到」≠「真的改了」：写失败时诊断必须说实话 ----------------------
    // 价值：只读/写失败场景下（重启前最容易遇到只读态），若诊断说"已标记 blocked"
    // 而 state 仍是 ready，那**诊断撒谎比没有诊断更糟**。检测结果与写入结果必须可区分。
    {
      const backend = createDomainBackend();
      const facility = createFakeStorageDomain({ backend });
      const workbench = await createWorkbench({ clock: createFakeClock(), domainFacility: facility, config: { capacity: { globalLeafLimit: 4 } } });
      if (workbench.mode !== 'real') {
        suite.fail('真实 Host 模块可用（第 7 组）', { mode: workbench.mode, pendingReason: workbench.pendingReason });
      } else {
        const { service } = workbench;
        const lead = leadAgent(workbench);
        await service.defineTeam(lead, { teamKey: 'team-a' });
        await service.createMember(lead, { teamKey: 'team-a', name: 'ghost2', description: '将被删除的 owner' });
        await service.submitWork(lead, {
          teamKey: 'team-a',
          workId: 'orphan-unmarked',
          title: '写失败的孤儿',
          deliverable: '写失败场景的完整实现',
          ownerMemberId: 'ghost2',
          outputs: ['src/orphan-unmarked/index.ts'],
          acceptance: ['可集成'],
        });
        const beforeState = { state: service.works.get('orphan-unmarked').state, blockedReason: service.works.get('orphan-unmarked').blockedReason ?? null };
        const record = service.works.get('orphan-unmarked');
        const ownerKey = record.teamKey + '/' + record.ownerMemberId;
        service.members.delete(ownerKey);
        await service.storage.remove('members', ownerKey);
        backend.failNextWrites = 1_000_000;
        const report = await service.reconcile();
        const entries = service.diagnostics.list() ?? [];
        const codes = entries.map((entry) => String(entry.code));
        const after = service.works.get('orphan-unmarked');
        suite.assert(
          codes.includes('service:reconcile:orphan-owner-not-marked') && codes.includes('service:reconcile:orphan-owner') === false,
          '写失败：出现 orphan-owner-not-marked，且不出现 orphan-owner（不说"已标记"）',
          codes.slice(-6),
        );
        // 状态无关写法（§11 后非 owner 提交的初始态是 needs_plan，不再是 ready）：
        // 真意图是"**失败的标记写入不得改变 state**"，因此与 before 逐字段比对，而不硬编码某个初始态。
        suite.assert(
          after.state === beforeState.state && (after.blockedReason ?? null) === (beforeState.blockedReason ?? null),
          '写失败：work 的 state/blockedReason 与写入前**完全一致**（失败的标记写入不得改变状态）',
          { before: beforeState, after: { state: after.state, blockedReason: after.blockedReason ?? null } },
        );
        suite.assert(
          Array.isArray(report?.orphanOwner) && report.orphanOwner.some((entry) => (entry.workId ?? entry) === 'orphan-unmarked'),
          '写失败：report.orphanOwner 仍包含它（检测与标记分离）',
          report?.orphanOwner,
        );
        const notMarked = entries.filter((entry) => String(entry.code) === 'service:reconcile:orphan-owner-not-marked').slice(-1)[0];
        suite.assert(
          notMarked !== undefined && notMarked.detail !== undefined
            && Object.prototype.hasOwnProperty.call(notMarked.detail, 'code')
            && Object.prototype.hasOwnProperty.call(notMarked.detail, 'readOnly'),
          '写失败：诊断 detail 带 code 与 readOnly',
          notMarked?.detail,
        );
        backend.failNextWrites = 0;
        await workbench.dispose();
      }
    }
  });
}

if (isMain(import.meta.url)) await main(run, meta);
