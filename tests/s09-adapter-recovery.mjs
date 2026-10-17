/**
 * S09 — 接口/输入不足时能补适配器并继续（不伪造身份、不绕权限）。
 *
 * 覆盖 `adapter.ensureLiveAgent(sessionId)` 的冷唤醒阶梯，以及
 * `service.executeStart` 在 parent 不可用时**标记 attempt 失败**而不是拿
 * `{id}` 假身份去启动：
 *   1. 先试 `agents.resume`；失败再试 `agentLoop.resume`；都失败 →
 *      `PARENT_AGENT_UNAVAILABLE`，且**从不**返回构造出来的 `{id}` 对象；
 *   2. `agents.resume` 成功时不再调用 `agentLoop.resume`；
 *   3. 两条路都不通时 `executeStart`：attempt 标 `failed`、原生 `startContinuable`
 *      一次都没被调用（证明没有用假 agent 去启动）；
 *   4. 冷唤醒成功时 `resumed:true`、handle 记进 `service.resumedAgentHandles`，
 *      `service.dispose()` 时 handle 的 `dispose()` 恰好被调用一次。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';

export const meta = {
  id: 's09-adapter-recovery',
  title: 'S09：冷唤醒阶梯（agents.resume → agentLoop.resume）、不伪造身份、handle 释放',
  acceptance: ['S09', 'S07'],
  requires: ['adapter', 'service', 'scheduler', 'storage'],
};

/** 替换 ctx 上的原生服务，返回还原函数。 */
function overrideService(ctx, name, value) {
  const previous = ctx.get(name);
  ctx.set(name, value);
  return () => ctx.set(name, previous);
}

export async function run() {
  return runSuite(meta, async (suite) => {
    const workbench = await createWorkbench({ clock: createFakeClock(), config: { capacity: { globalLeafLimit: 4 } } });
    if (workbench.mode !== 'real') {
      suite.fail('真实 Host 模块可用', { mode: workbench.mode, pendingReason: workbench.pendingReason });
      return;
    }
    const { adapter, ctx } = workbench;

    // ---------------------------------------------------------------- 1. 都失败
    {
      const calls = [];
      const restoreAgents = overrideService(ctx, 'agents', {
        get: () => undefined,
        list: () => [],
        roots: () => [],
        resume: async (options) => {
          calls.push({ path: 'agents.resume', options });
          const error = new Error('agents.resume 不可用');
          error.code = 'AGENT_RESUME_FAILED';
          throw error;
        },
      });
      const restoreLoop = overrideService(ctx, 'agentLoop', {
        resume: async (loopCtx, options) => {
          calls.push({ path: 'agentLoop.resume', options });
          const error = new Error('agentLoop.resume 不可用');
          error.code = 'AGENT_RESUME_FAILED';
          throw error;
        },
      });

      const result = await adapter.ensureLiveAgent('session-ghost');
      suite.equal(result.ok, false, '两条 resume 都失败 → ensureLiveAgent 返回失败');
      suite.equal(result.code, 'PARENT_AGENT_UNAVAILABLE', '失败码为 PARENT_AGENT_UNAVAILABLE');
      suite.equal(result.value, undefined, '失败时没有返回任何值（尤其不是构造出来的 {id} 对象）');
      suite.deepEqual(
        calls.map((entry) => entry.path),
        ['agents.resume', 'agentLoop.resume'],
        '调用顺序：先 agents.resume，再 agentLoop.resume',
      );
      suite.deepEqual(
        calls.map((entry) => entry.options?.resumeSessionId),
        ['session-ghost', 'session-ghost'],
        '两条路径都拿真实的 sessionId 去 resume（不伪造）',
      );
      suite.equal('agent' in (result ?? {}), false, '失败结果里没有 agent 字段');

      restoreLoop();
      restoreAgents();
    }

    // ------------------------------------------------- 2. agents.resume 成功
    {
      const handle = { agent: { id: 'session-a' }, dispose: async () => {} };
      const calls = [];
      const restoreAgents = overrideService(ctx, 'agents', {
        get: () => undefined,
        list: () => [],
        roots: () => [],
        resume: async () => {
          calls.push('agents');
          return handle;
        },
      });
      const restoreLoop = overrideService(ctx, 'agentLoop', {
        resume: async () => {
          calls.push('agentLoop');
          return { agent: { id: 'session-b' }, dispose: async () => {} };
        },
      });

      const result = await adapter.ensureLiveAgent('session-a');
      suite.equal(result.ok, true, 'agents.resume 成功时 ensureLiveAgent 成功');
      suite.equal(result.value?.resumed, true, '冷唤醒标记 resumed=true');
      suite.equal(result.value?.agent?.id, 'session-a', '返回的是真实 resume 得到的 agent');
      suite.equal(result.value?.handle, handle, 'handle 一并返回（供退出时释放）');
      suite.deepEqual(calls, ['agents'], 'agents.resume 成功后不再调用 agentLoop.resume');

      restoreLoop();
      restoreAgents();
    }

    // --------------------------------------------- 3. 回退到 agentLoop.resume
    {
      const loopHandle = { agent: { id: 'session-b' }, dispose: async () => {} };
      const calls = [];
      const restoreAgents = overrideService(ctx, 'agents', {
        get: () => undefined,
        list: () => [],
        roots: () => [],
        resume: async () => {
          calls.push('agents');
          const error = new Error('no');
          error.code = 'AGENT_RESUME_FAILED';
          throw error;
        },
      });
      const restoreLoop = overrideService(ctx, 'agentLoop', {
        resume: async () => {
          calls.push('agentLoop');
          return loopHandle;
        },
      });

      const result = await adapter.ensureLiveAgent('session-b');
      suite.equal(result.ok, true, 'agents.resume 失败后回退到 agentLoop.resume 并成功');
      suite.equal(result.value?.handle, loopHandle, '回退路径同样返回 handle');
      suite.deepEqual(calls, ['agents', 'agentLoop'], '确实走了第二条路径');
      restoreLoop();
      restoreAgents();
    }

    // ------------------------------- 4. executeStart：parent 不可用 → attempt failed
    {
      const fresh = await createWorkbench({ clock: createFakeClock(), config: { capacity: { globalLeafLimit: 4 }, scheduler: { maxStartsPerTick: 4 } } });
      const freshLead = leadAgent(fresh);
      await fresh.service.defineTeam(freshLead, { teamKey: 'team-s' });
      await fresh.service.createMember(freshLead, { teamKey: 'team-s', name: 'm1', description: 'm1 模块完整交付' });
      await fresh.service.submitWork(freshLead, {
        teamKey: 'team-s',
        workId: 'w1',
        title: 'm1 的完整交付',
        deliverable: 'm1 模块的完整实现',
        ownerMemberId: 'm1',
        outputs: ['src/m1/index.ts'],
        acceptance: ['可集成'],
      });

      // 契约：dispatchAuthorize 是唯一授权入口（leader 提交的 work 不会自动启动）。
      const s4Member = fresh.service.members.get('team-s/m1');
      const s4Session = s4Member?.sessionId;
      const s4Agent = fresh.native.agentFor(s4Session) ?? fresh.native.registerAgent(s4Session, { name: 'm1' });
      fresh.native.registerMembership(s4Session, { id: 'team-s', role: 'teammate', name: 'm1', root: freshLead });
      const s4Revision = fresh.service.works.get('w1')?.planRevision ?? 0;
      const s4Authorized = await fresh.service.dispatchAuthorize(s4Agent, { teamKey: 'team-s', planRevision: s4Revision, workIds: ['w1'] });
      if (!s4Authorized.ok) suite.fail('dispatchAuthorize m1', s4Authorized);

      const originalEnsure = fresh.adapter.ensureLiveAgent;
      fresh.adapter.ensureLiveAgent = async () => ({ ok: false, code: 'PARENT_AGENT_UNAVAILABLE', message: '替身：所有 resume 路径都失败' });
      const startsBefore = fresh.native.counters.startContinuable;
      const tick1 = await fresh.scheduler.tick();
      fresh.adapter.ensureLiveAgent = originalEnsure;

      suite.equal(tick1.started.length, 0, 'parent 不可用时没有工作项被报告为已启动');
      suite.equal(fresh.native.counters.startContinuable, startsBefore, '原生 startContinuable 一次都没被调用（没有用假 agent 启动）');
      suite.equal(fresh.native.childrenSnapshot().length, 0, '原生侧没有创建任何 child');
      const attempt = [...fresh.service.attempts.values()][0];
      suite.assert(attempt !== undefined, '预留出来的 attempt 仍然存在（被标记而不是被丢弃）', fresh.service.attempts.size);
      suite.equal(attempt?.state, 'failed', 'parent 不可用时 attempt 被标记为 failed');
      suite.includes(String(attempt?.error ?? ''), 'PARENT_AGENT_UNAVAILABLE', 'attempt.error 记录确切失败原因');
      const schedulerCodes = (fresh.scheduler.diagnostics?.() ?? []).map((entry) => String(entry.code));
      suite.assert(
        schedulerCodes.includes('scheduler:start-failed'),
        '调度器留下 scheduler:start-failed 诊断（不静默）',
        schedulerCodes.slice(-6),
      );
      const failedWork = fresh.service.works.get('w1');
      suite.assert(
        failedWork?.activeAttemptId === null || failedWork?.state === 'ready',
        'parent 不可用后工作项被释放回 ready（可再次派发）',
        { state: failedWork?.state, activeAttemptId: failedWork?.activeAttemptId },
      );
      await fresh.dispose();
    }

    // --------------------------- 5. 冷唤醒成功 → handle 记入 → dispose 释放一次
    {
      const fresh = await createWorkbench({ clock: createFakeClock(), config: { capacity: { globalLeafLimit: 4 }, scheduler: { maxStartsPerTick: 4 } } });
      const freshLead = leadAgent(fresh);
      await fresh.service.defineTeam(freshLead, { teamKey: 'team-r' });
      const created = await fresh.service.createMember(freshLead, { teamKey: 'team-r', name: 'm1', description: 'm1 模块完整交付' });
      suite.equal(created.ok, true, '成员创建成功');
      const memberSessionId = created.member.sessionId;
      // member 在两次回合之间从原生注册表里消失 → agentFor 返回 undefined。
      suite.equal(fresh.native.unregisterAgent(memberSessionId), true, '把 member 从原生注册表移除（模拟回合之间被回收）');
      suite.equal(fresh.ctx.get('agents').get(memberSessionId), undefined, 'agentFor 现在取不到该 member');

      let disposeCalls = 0;
      const resumeCalls = [];
      const handle = {
        agent: { id: memberSessionId },
        dispose: async () => {
          disposeCalls += 1;
        },
      };
      fresh.ctx.set('agents', {
        get: (id) => (String(id) === memberSessionId ? undefined : fresh.native.agentFor(id)),
        list: () => fresh.native.roster,
        roots: () => fresh.native.roster,
        resume: async (options) => {
          resumeCalls.push(options?.resumeSessionId);
          return handle;
        },
      });

      await fresh.service.submitWork(freshLead, {
        teamKey: 'team-r',
        workId: 'w2',
        title: '冷唤醒后的交付',
        deliverable: '冷唤醒模块的完整实现',
        ownerMemberId: 'm1',
        outputs: ['src/m2/index.ts'],
        acceptance: ['可集成'],
      });
      // 契约：dispatchAuthorize 是唯一授权入口（leader 提交的 work 不会自动启动）。
      // 此时 agents.get 被模拟成"member 冷掉了"，授权需要临时让 actor 解析到成员本身；
      // 授权后立即恢复冷现场，再 tick 触发真实冷唤醒。
      // 授权需要 native 注册 + membership 可解析；授权后再次移除，保持"冷"现场。
      fresh.native.registerAgent(memberSessionId, { name: 'm1' });
      const coldAgents = fresh.ctx.get('agents');
      const coldGet = coldAgents.get;
      coldAgents.get = (id) => (String(id) === memberSessionId ? fresh.native.agentFor(memberSessionId) : coldGet(id));
      fresh.native.registerMembership(memberSessionId, { id: 'team-r', role: 'teammate', name: 'm1', root: freshLead });
      const coldRevision = fresh.service.works.get('w2')?.planRevision ?? 0;
      const coldAuthorized = await fresh.service.dispatchAuthorize({ id: memberSessionId }, { teamKey: 'team-r', planRevision: coldRevision, workIds: ['w2'] });
      coldAgents.get = coldGet;
      fresh.native.unregisterAgent(memberSessionId);
      if (!coldAuthorized.ok) suite.fail('dispatchAuthorize w2', coldAuthorized);
      const tick = await fresh.scheduler.tick();
      suite.equal(tick.started.length, 1, '冷唤醒 parent 后 leaf 成功启动');
      suite.deepEqual(resumeCalls, [memberSessionId], '只用真实 sessionId 调用了一次 agents.resume');
      suite.equal(fresh.service.resumedAgentHandles?.size, 1, '冷唤醒得到的 handle 被记进 resumedAgentHandles');
      suite.equal(fresh.service.resumedAgentHandles?.get(memberSessionId), handle, 'handle 与 sessionId 对应');
      const resumedCodes = (fresh.service.diagnostics.list() ?? []).map((entry) => String(entry.code));
      suite.assert(resumedCodes.includes('service:parent-cold-resumed'), '留下 service:parent-cold-resumed 诊断', resumedCodes.slice(-6));

      await fresh.service.dispose();
      suite.equal(disposeCalls, 1, 'service.dispose() 恰好释放冷唤醒 handle 一次');
      suite.equal(fresh.service.resumedAgentHandles?.size, 0, 'dispose 后 handle 表被清空');
    }

    await workbench.dispose();
  });
}

if (isMain(import.meta.url)) await main(run, meta);
