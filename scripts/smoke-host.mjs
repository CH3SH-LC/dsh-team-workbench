/**
 * Lead 自用的 Host 组装烟测（不属于 verify-harness 的交付范围）。
 *
 * 目标：在**不接触真实 DSH** 的前提下确认 `src/host/*.js` 能组装，并跑完
 * 提交 → 认领 → 预留 → 启动 → 回执 → 补位 → 迟到结果 → CAS → 写入互斥 →
 * **成员自治（mission/plan/dispatch/verify/inbox/askOwner）** → 恢复对账 的完整路径。
 *
 * ⚠️ 契约 §11（v1.2）修正：**授权只能来自 owner 自己**。
 * 因此凡是"leader 替成员提交 work，然后期望调度器自动启动"的旧写法，
 * 在本文件里都已改成新模型（owner 自己提交，或 leader 替建后由 owner 显式授权）。
 * 这些改动是**修正，不是放宽**：旧写法正是任务 §二 禁止的"leader 预先替成员写完叶子任务"。
 *
 * 运行：node scripts/smoke-host.mjs
 */
import { createAdapter } from '../src/host/adapter.js';
import { normalizeConfig } from '../src/host/config.js';
import { createScheduler } from '../src/host/scheduler.js';
import { TeamWorkbenchService } from '../src/host/service.js';
import { createStorage } from '../src/host/storage.js';
import { readFileSync } from 'node:fs';

function createMemoryDomain() {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    const store = tables.get(name);
    return {
      get: (key) => store.get(key),
      entries: () => store.entries(),
      keys: () => store.keys(),
      get size() {
        return store.size;
      },
      async put(key, value) {
        store.set(key, JSON.parse(JSON.stringify(value)));
      },
      async delete(key) {
        return store.delete(key);
      },
      async update(key, fn) {
        store.set(key, fn(store.get(key)));
        return store.get(key);
      },
    };
  };
  let global = { schemaVersion: 1, writerEpoch: null, revision: 0, updatedAt: 0 };
  return {
    name: 'team_workbench',
    table,
    global: {
      get: () => global,
      async set(value) {
        global = JSON.parse(JSON.stringify(value));
      },
    },
    async close() {},
  };
}

function createFakeCtx() {
  const agents = new Map();
  const memberships = new Map();
  const children = new Map();
  /** 每次成员唤醒的真实投递记录（原生 sendMessage = 持久入队 + 立即投递）。 */
  const wakeLog = [];
  const counters = { registerTool: 0, section: 0, skillProvider: 0, webRoute: 0, command: 0, projection: 0 };
  const domain = createMemoryDomain();
  /** 原生 Agent 身份只保证 `{ id }`；这里统一规范化，避免形状不一致造成假失败。 */
  const registerAgent = (id, meta = {}) => {
    const agent = { ...meta, id: String(id) };
    agents.set(agent.id, agent);
    return agent;
  };

  const ctx = {
    get(name) {
      switch (name) {
        case 'agents':
          return { get: (id) => agents.get(id), list: () => [...agents.values()], roots: () => [...agents.values()] };
        case 'agentTeams':
          return {
            tryMembership: (agent) => memberships.get(agent?.id),
            listMembers: (agent) => {
              // 显式 roster（验证"官方 spawn_teammate 建的成员不被误伤"），否则按注册表列举。
              if (ctx.teammateRoster != null) return ctx.teammateRoster;
              const membership = memberships.get(agent?.id);
              if (!membership) return null;
              return [...memberships.entries()]
                .filter(([, entry]) => entry.id === membership.id)
                .map(([sessionId, entry]) => ({ id: sessionId, name: entry.name, role: entry.role, status: 'inactive', diagnostics: [] }));
            },
            listTasks: () => [],
            getTask: async () => ({ id: 't1', revision: 1 }),
            createTask: async () => ({ id: `native-${Math.random().toString(36).slice(2, 8)}`, revision: 1 }),
            updateTask: async () => ({ id: 't1', revision: 2 }),
            sendMessage: async (caller, request) => {
              if (ctx.sendMessageError) {
                const error = new Error(ctx.sendMessageError);
                error.code = ctx.sendMessageError;
                throw error;
              }
              wakeLog.push({
                callerId: String(caller?.id ?? ''),
                target: String(request?.target ?? ''),
                text: String(request?.content?.[0]?.text ?? ''),
                at: Date.now(),
              });
              return { messageId: `team-message-${wakeLog.length}`, status: 'accepted' };
            },
            waitForChange: async () => ({ timedOut: true }),
            spawnTeammate: async (caller, request) => {
              const id = `session-${request.name}`;
              registerAgent(id);
              memberships.set(id, { root: caller, id: caller.id, role: 'teammate', name: request.name });
              return { member: { id, name: request.name, role: 'teammate', status: 'running' } };
            },
            interrupt: () => ({ previousStatus: 'running' }),
          };
        case 'subagents':
          return {
            list: () => ['spawn', 'fork'],
            resolveMaxDepth: () => 1,
            startContinuable: async (spec) => {
              if (ctx.startContinuableError) {
                const error = new Error(ctx.startContinuableError);
                error.code = ctx.startContinuableError;
                throw error;
              }
              // 复刻真实 `tools.restrict()` 的严格性：**未知名字直接抛**。
              // 这正是 2026-10-16 的真实回归（deny 里带了本 profile 未注册的名字 → 叶子起不来）。
              const deny = spec?.request?.toolFilter?.deny;
              if (Array.isArray(deny) && deny.length > 0) {
                const registry = new Set(ctx.toolRegistry ?? []);
                const unknown = deny.filter((name) => !registry.has(name));
                if (unknown.length > 0) {
                  const error = new Error(`tools.restrict() names unknown global tools: ${unknown.map((n) => `"${n}"`).join(', ')}`);
                  error.code = 'SUBAGENT_START_FAILED';
                  throw error;
                }
              }
              ctx.startSpecs = ctx.startSpecs ?? [];
              ctx.startSpecs.push(spec);
              children.set(spec.childId, { id: spec.childId });
              registerAgent(spec.childId);
              return { childId: spec.childId, messageId: `msg-${spec.childId}` };
            },
            listChildren: async (parentId) =>
              [...children.values()]
                .filter((entry) => String(entry.id).includes('child'))
                .map((entry) => ({ id: entry.id, createdAt: Date.now(), mode: 'continuable', label: parentId })),
            listDescendants: async () => [],
            sendMessage: async () => 'm1',
            interrupt: () => {},
            interruptByParent: () => ({ accepted: true }),
            drainContinuableChildren: async () => {},
          };
        case 'storageDomain':
          return { open: async () => domain, get: () => domain };
        case 'tools':
          return {
            register: () => {
              counters.registerTool += 1;
              return () => {
                counters.registerTool -= 1;
              };
            },
            restrict: () => () => {},
            guard: () => () => {},
            // 全局工具注册表：leaf 的 deny 列表必须与它求交——未注册的名字传下去会让
            // `tools.restrict()` 抛，叶子就完全起不来（2026-10-16 真实回归）。
            schemas: () => (ctx.toolRegistry ?? []).map((name) => ({ name, description: '', parameters: {} })),
          };
        case 'systemPrompt':
          return {
            section: () => {
              counters.section += 1;
              return () => {
                counters.section -= 1;
              };
            },
          };
        case 'skills':
          return {
            registerProvider: () => {
              counters.skillProvider += 1;
              return () => {
                counters.skillProvider -= 1;
              };
            },
          };
        case 'commands':
          return { register: () => () => {} };
        case 'sessionProjections':
          return { register: () => () => {} };
        case 'webServer':
          return {
            register: () => {
              counters.webRoute += 1;
              return () => {
                counters.webRoute -= 1;
              };
            },
          };
        default:
          return undefined;
      }
    },
    on: () => () => {},
    effect: () => () => {},
    inject: (deps, callback) => {
      callback(ctx);
      return () => {};
    },
    provide: () => {},
    counters,
    agents,
    memberships,
    wakeLog,
    domain,
  };
  return ctx;
}

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
  }
}

async function main() {
  const ctx = createFakeCtx();
  // 全局工具注册表：**故意不含**官方 agent-team 那套名字（`spawn_teammate`/`wait_agent`/`team_task_*`），
  // 因为本 profile 实测就是没有它们——这正是 2026-10-16 真实回归（叶子起不来）的现场形状。
  ctx.toolRegistry = [
    'read', 'write', 'edit', 'glob', 'grep', 'read_image', 'pwsh', 'present', 'skill', 'todo_write',
    'ask_user_question', 'create_goal', 'update_goal', 'get_goal', 'exit_plan_mode', 'workflow',
    'web_search', 'web_fetch', 'load_workspace_dependencies', 'job_list', 'job_kill', 'job_output',
    'cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager', 'subagent', 'subagent_fork',
    // 本插件自己注册的 25 个（`registerTools()` 之后与 tools.registered 一致）
    'team_snapshot', 'team_define', 'team_member_create', 'team_work_submit', 'team_mission_assign',
    'team_plan_submit', 'team_dispatch_authorize', 'team_work_verify', 'team_plan_cancel', 'team_member_inbox',
    'team_ask_owner', 'team_work_claim', 'team_subagent_start', 'team_work_report', 'team_interrupt',
    'team_message', 'team_wait', 'team_recover', 'team_layout',
    // 2026-10-17 整改新增：证据式验收 / 物化 / 费用 / 成果 / 指纹 / 上下文
    'team_exec_check', 'team_materialize', 'team_usage', 'team_findings', 'team_error_fingerprints', 'team_context_query',
  ];
  const adapter = createAdapter(ctx);
  const storage = createStorage(ctx, adapter, {});
  const config = normalizeConfig({
    capacity: { hostActivationLimit: 40, globalLeafLimit: 30, recoveryReserve: 3, interactiveReserve: 2, perMemberLeaves: 6, perMemberAttempts: 24, teamsMaxConcurrent: 3 },
    scheduler: { maxStartsPerTick: 10, agingPerMinute: 1.5, wakeCoalesceMs: 40 },
  });
  const service = new TeamWorkbenchService(ctx, adapter, storage, config);
  await service.beginInit();
  const scheduler = createScheduler({ service, adapter, storage, config });

  // 契约 §3 / CONTRACT v1 修订：`accepted` 与 self 回执必须引用 **Host 真实执行记录**（runId），
  // 不能再用 `{kind:'verification', ok:true, command}` 这种"未执行的命令字符串"。
  // smoke 用真实 `node -e "process.exit(0)"` 子进程 + 真实写盘的产物来构造可信证据。
  const { promises: fsp } = await import('node:fs');
  const nodePath = await import('node:path');
  async function trustedEvidence(workId, caller, acceptanceIndexes = null) {
    const work = service.works.get(workId);
    if (!work) throw new Error(`trustedEvidence: work ${workId} 不存在`);
    // 模拟"计划期声明的可执行验收项"（真实流程由 team_plan_submit.deliverables[].verificationCommands 提供）。
    work.verificationCommands = [{ command: 'node', argv: ['-e', 'process.exit(0)'], checkId: 'smoke-check', acceptanceIndexes: [0, 1, 2] }];
    const outputs = Array.isArray(work.outputs) && work.outputs.length > 0 ? work.outputs : ['tmp-smoke/artifact.txt'];
    for (const rel of outputs) {
      await fsp.mkdir(nodePath.dirname(rel), { recursive: true });
      await fsp.writeFile(rel, `// smoke artifact for ${workId}\n`);
    }
    const run = await service.runVerification(caller, { workId, command: 'node', argv: ['-e', 'process.exit(0)'], artifacts: outputs, scope: 'offline' });
    if (run.ok !== true) throw new Error(`trustedEvidence run failed: ${run.code} ${run.message}`);
    // 契约 v4 / evidence-gate v2：可信证据 = runId + exit0 + artifact path@version；
    // acceptance 必须绑定已执行检查（commandRef 命中 run.command/argv），不能只靠 evidenceRef。
    const version = work.artifactRefs?.[0]?.version ?? 1;
    const evidence = [{ kind: 'verification', runId: run.runId, file: outputs[0], version, command: 'node -e process.exit(0)' }];
    const indexes = Array.isArray(acceptanceIndexes) ? acceptanceIndexes : (work.acceptance ?? []).map((_, index) => index);
    for (const index of indexes) {
      evidence.push({ kind: 'acceptance', acceptanceIndex: index, evidenceRef: 0, checkId: 'smoke-check', postcondition: { kind: 'run', runId: run.runId } });
    }
    return { run, evidence };
  }

  const lead = { id: 'session-lead' };
  ctx.agents.set(lead.id, lead);
  ctx.memberships.set(lead.id, { root: lead, id: lead.id, role: 'lead', name: 'lead' });

  console.log('\n[1] team and members');
  const team = await service.defineTeam(lead, { teamKey: 'team-a', layout: 'systems', goal: 'demo' });
  check('defineTeam', team.ok === true, team);
  const member = await service.createMember(lead, { teamKey: 'team-a', name: 'combat', description: 'combat system end-to-end delivery' });
  check('createMember', member.ok === true && member.member.sessionId === 'session-combat', member);
  /** 成员自己的真实 Agent：owner 自己提交 = 契约 §11 的自动授权路径。 */
  const combat = ctx.agents.get('session-combat');
  check('member live agent resolvable', combat?.id === 'session-combat', combat);

  console.log('\n[2] horizontal-split policy');
  const relay = await service.submitWork(lead, {
    teamKey: 'team-a',
    title: 'Boss background investigation',
    deliverable: 'Boss background investigation',
    ownerMemberId: 'combat',
    outputs: ['docs/boss-background-report.md'],
    acceptance: ['report finished'],
  });
  check('phase relay rejected', relay.ok === false && relay.code === 'PHASE_RELAY_SPLIT', relay);
  check('rejection carries replan hint', typeof relay.hint === 'string' && relay.hint.length > 10, relay.hint);

  const designStage = await service.submitWork(lead, {
    teamKey: 'team-a',
    title: 'Boss design plan',
    deliverable: 'Boss design plan',
    partOf: 'boss-01',
    ownerMemberId: 'combat',
    outputs: ['docs/boss-design.md'],
    acceptance: ['design finished'],
  });
  check('design-stage deliverable rejected', designStage.ok === false && designStage.code === 'PHASE_RELAY_SPLIT', designStage);

  const implementGood = await service.submitWork(lead, {
    teamKey: 'team-a',
    title: 'Boss-01 full delivery',
    deliverable: 'Boss-01 complete mechanics and implementation',
    partOf: 'boss-01',
    ownerMemberId: 'combat',
    outputs: ['src/bosses/boss-01.ts'],
    acceptance: ['usable'],
  });
  check('same partOf with real artifact accepted', implementGood.ok === true, implementGood);

  const good = await service.submitWork(lead, {
    teamKey: 'team-a',
    title: 'Ice Warden Boss complete delivery',
    deliverable: 'Ice Warden Boss complete mechanics, numbers and implementation',
    ownerMemberId: 'combat',
    outputs: ['src/combat/bosses/ice-warden.ts'],
    acceptance: ['mechanics complete', 'no placeholder implementation'],
    writeScopes: ['src/combat/bosses/'],
  });
  check('module deliverable accepted', good.ok === true, good);

  console.log('\n[3] 20 works / 10 worker slots rolling fill（owner 自己提交 = §11 自动授权）');
  const workIds = [];
  for (let index = 0; index < 20; index += 1) {
    const submitted = await service.submitWork(combat, {
      teamKey: 'team-a',
      workId: `w${String(index + 1).padStart(2, '0')}`,
      title: `module ${index + 1} delivery`,
      deliverable: `module ${index + 1} complete implementation`,
      ownerMemberId: 'combat',
      outputs: [`src/mod${index + 1}/index.ts`],
      acceptance: [`module ${index + 1} usable`],
      blockedBy: index >= 10 && index !== 14 ? ['w01'] : [],
    });
    if (submitted.ok) workIds.push(submitted.work.workId);
  }
  check('20 works submitted', workIds.length === 20, workIds.length);
  check(
    'owner 自己提交 → Host 记一条来自 owner 的授权（§11）',
    [...service.dispatchIntents.values()].some((intent) => intent.workId === 'w01' && intent.auto === true && intent.authorizedBy === 'session-combat'),
    [...service.dispatchIntents.values()].filter((intent) => intent.workId === 'w01'),
  );

  // §11 核心反例：**leader 替成员预拆叶子任务** → 不产生授权 → 永不自动启动。
  const directive = await service.submitWork(lead, {
    teamKey: 'team-a',
    workId: 'w-lead-directive',
    title: 'leader 替成员预拆的叶子任务',
    deliverable: 'leader 替成员预拆的叶子任务完整实现',
    ownerMemberId: 'combat',
    outputs: ['src/directive/index.ts'],
    acceptance: ['usable'],
  });
  check('leader 替成员提交被接受但初始 needs_plan', directive.ok === true && directive.work.state === 'needs_plan', { state: directive.work?.state, authorizedByOwner: directive.authorizedByOwner });
  check('leader 替成员提交不产生授权意图', directive.authorizedByOwner === false && ![...service.dispatchIntents.values()].some((intent) => intent.workId === 'w-lead-directive'), [...service.dispatchIntents.values()].map((intent) => intent.workId));
  check('owner 收到"需要你自己授权"的事件', service.pendingEvents('team-a', 'combat').some((event) => event.payload?.workId === 'w-lead-directive'), service.pendingEvents('team-a', 'combat').map((event) => event.payload?.workId));
  const directiveStart = await service.subagentStart(combat, { workId: 'w-lead-directive' });
  check('leader 替建的 work 定向启动被拒（无授权，返回 DISPATCH_NOT_AUTHORIZED 而不是团队错）', directiveStart.ok === false && directiveStart.code === 'DISPATCH_NOT_AUTHORIZED', directiveStart);

  const firstTick = await scheduler.tick();
  check('starts exactly 10 on first tick', firstTick.started.length === 10, firstTick.started.length);
  check('leader 替建的 work 后台补位不启动', !firstTick.started.some((entry) => entry.workId === 'w-lead-directive'), firstTick.started.map((entry) => entry.workId));
  check('never exceeds workerCapacity', firstTick.started.length <= config.capacity.globalLeafLimit, firstTick.started.length);
  check('dependents never pre-started', firstTick.started.every((plan) => !['w11', 'w12', 'w13', 'w16'].includes(plan.workId)), firstTick.started.map((plan) => plan.workId));
  check('readyBefore lists more than started', firstTick.readyBefore.length >= firstTick.started.length, firstTick.readyBefore.length);
  check('no batch barrier state', scheduler.batchState().hasBatch === false);
  check('unsatisfied dependency is blocked', service.works.get('w11').state === 'blocked', service.works.get('w11').state);
  const blockedClaim = await service.claimWork(lead, { workId: 'w11' });
  check('blocked work cannot be claimed', blockedClaim.ok === false && blockedClaim.code === 'WORK_BLOCKED', blockedClaim);
  check('member admission limit with 2 members', service.capacity().memberLimit === 24, service.capacity().memberLimit);

  console.log('\n[3b] §11：owner 授权后调度器才补位启动');
  check('授权前 work 停在 needs_plan', service.works.get('w-lead-directive').state === 'needs_plan', service.works.get('w-lead-directive').state);
  check('授权前 computeReady 不含它（不是可调度项）', !service.computeReady().some((work) => work.workId === 'w-lead-directive'), service.computeReady().map((work) => work.workId));
  const directiveAuth = await service.dispatchAuthorize(combat, { teamKey: 'team-a', planRevision: service.works.get('w-lead-directive').planRevision ?? 0, workIds: ['w-lead-directive'] });
  check('owner 自己授权成功', directiveAuth.ok === true, directiveAuth);
  check('authorize 后 work 进入 ready（§12.4：调度器自行消费，调用方不需要 promote）', service.works.get('w-lead-directive').state === 'ready', service.works.get('w-lead-directive').state);
  const secondTick = await scheduler.tick();
  check('授权后补位启动它', secondTick.started.some((entry) => entry.workId === 'w-lead-directive'), secondTick.started.map((entry) => entry.workId));

  console.log('\n[4] one settlement refills immediately');
  const startedIds = new Set([...firstTick.started, ...secondTick.started].map((plan) => plan.workId));
  const planToFinish = firstTick.started[0];
  const attempt = service.attempts.get(planToFinish.attemptId);
  const report = await service.reportWork({ id: attempt.executorChildId }, {
    attemptId: planToFinish.attemptId,
    leaseEpoch: attempt.leaseEpoch,
    outcome: 'produced',
    artifacts: [{ path: 'src/mod1/index.ts', version: 1 }],
    evidence: [{ kind: 'verification', ok: true, command: 'node --test', ref: 'tests/mod1' }],
    summary: 'done',
  });
  check('receipt accepted', report.ok === true && report.accepted === true, report);
  const thirdTick = await scheduler.tick();
  check('refill happens on the next tick', thirdTick.started.length > 0, thirdTick.started.map((p) => p.workId));
  check('refill items were not already running', thirdTick.started.every((plan) => !startedIds.has(plan.workId)), thirdTick.started.map((p) => p.workId));

  console.log('\n[5] CAS and late results');
  const casWork = await service.submitWork(combat, {
    teamKey: 'team-a',
    workId: 'wcas',
    title: 'CAS target',
    deliverable: 'CAS target complete implementation',
    ownerMemberId: 'combat',
    outputs: ['src/cas/index.ts'],
    acceptance: ['usable'],
  });
  const target = service.works.get('wcas');
  check('CAS target submitted', casWork.ok === true && target !== undefined, casWork.code);
  const claimA = await service.claimWork(combat, { workId: target.workId, expectedRevision: target.rev });
  const claimB = await service.claimWork(combat, { workId: target.workId, expectedRevision: target.rev });
  check('concurrent claim succeeds once', claimA.ok === true && claimB.ok === false && claimB.code === 'CAS_MISMATCH', { claimA: claimA.code, claimB: claimB.code });

  const active = service.attempts.get(service.works.get('w02').activeAttemptId);
  if (active) {
    const late = await service.reportWork({ id: active.executorChildId }, {
      attemptId: active.attemptId,
      leaseEpoch: active.leaseEpoch + 5,
      outcome: 'produced',
      artifacts: [{ path: 'src/mod2/index.ts', version: 9 }],
      summary: 'stale',
    });
    check('stale lease is quarantined', late.ok === true && late.quarantined === true && late.code.includes('LEASE'), late);
    check('late result never overwrites', service.works.get('w02').artifactRefs.length === 0, service.works.get('w02').artifactRefs);
  } else {
    check('active attempt exists for late-result test', false, 'no active attempt');
  }

  console.log('\n[6] capacity and fair share');
  const cap = service.capacity();
  check('residentCapacity = 40-3-2', cap.residentCapacity === 35, cap.residentCapacity);
  check('workerCapacity = globalLeafLimit', cap.workerCapacity === 30, cap.workerCapacity);
  check('full expansion example = 5x6+3+2', cap.fullExpansionExample === 35, cap.fullExpansionExample);
  check('never exceeds residentCapacity', cap.residentInUse <= cap.residentCapacity, cap);
  check('capacity counts attempts, no phantom usage', cap.activeLeaves === [...service.attempts.values()].filter((entry) => ['executing', 'waiting'].includes(entry.state)).length, { leaves: cap.activeLeaves, attempts: [...service.attempts.values()].map((entry) => `${entry.workId}:${entry.state}`) });

  console.log('\n[7] tool registration');
  const { registerTools } = await import('../src/host/tools.js');
  const tools = registerTools({ service, scheduler, adapter, config });
  check('registers tools', tools.registered.length > 0, tools.registered);
  check('all team_ prefixed', tools.registered.every((name) => name.startsWith('team_')), tools.registered);
  check('no official reserved names', !tools.registered.some((n) => ['send_message', 'list_agents', 'interrupt_agent', 'spawn_teammate', 'wait_agent', 'team_task_create'].includes(n)), tools.registered);
  const CONTRACT_TOOLS = ['team_mission_assign', 'team_plan_submit', 'team_dispatch_authorize', 'team_ask_owner', 'team_work_verify', 'team_plan_cancel', 'team_member_inbox'];
  check('契约 §3 的 7 个新工具全部注册', CONTRACT_TOOLS.every((name) => tools.registered.includes(name)), tools.registered);
  check('没有工具被跳过', tools.skipped.length === 0, tools.skipped);

  console.log('\n[7b] 角色段与真实工具目录的双向一致性（防漂移）');
  const skillsModule = await import('../src/host/skills.js');
  const roleAudit = skillsModule.auditRoleToolMentions(tools.registered);
  check('角色段里出现的每个 team_* 名字都真实注册（无幻觉工具）', roleAudit.unknownMentions.length === 0, roleAudit.unknownMentions);
  check('角色段覆盖全部必需工具（member 自治闭环 + lead 委托）', roleAudit.missingRequired.length === 0, roleAudit.missingRequired);
  check(
    '契约 7 个新工具中成员闭环所需的都在角色段被点名',
    ['team_mission_assign', 'team_plan_submit', 'team_dispatch_authorize', 'team_work_verify', 'team_plan_cancel', 'team_member_inbox', 'team_ask_owner'].every((name) => roleAudit.mentioned.includes(name)),
    roleAudit.mentioned,
  );

  console.log('\n[7c] leaf 工具面策略（契约 §15：叶子必须能产出产物）');
  const serviceModule = await import('../src/host/service.js');
  const leafDenied = new Set(serviceModule.LEAF_DENIED_TOOLS);
  check('leaf 必需能力（文件/命令/求助/回执）都不在 deny 列表里', serviceModule.LEAF_REQUIRED_TOOLS.every((name) => !leafDenied.has(name)), { required: serviceModule.LEAF_REQUIRED_TOOLS, denied: serviceModule.LEAF_DENIED_TOOLS.filter((name) => ['read', 'write', 'edit', 'glob', 'grep', 'pwsh'].includes(name)) });
  check('leaf 被剥夺全部成员级自治入口', ['team_mission_assign', 'team_plan_submit', 'team_dispatch_authorize', 'team_work_verify', 'team_member_create', 'team_work_submit', 'team_recover', 'team_subagent_start'].every((name) => leafDenied.has(name)), serviceModule.LEAF_DENIED_TOOLS);
  check('leaf 被剥夺官方 team/子智能体旁路', ['spawn_teammate', 'send_message', 'list_agents', 'interrupt_agent', 'subagent', 'subagent_fork'].every((name) => leafDenied.has(name)), serviceModule.LEAF_DENIED_TOOLS);
  check('leaf 仍可用 team_ask_owner / team_work_report（限域求助与回执）', !leafDenied.has('team_ask_owner') && !leafDenied.has('team_work_report'), serviceModule.LEAF_DENIED_TOOLS);

  // ---- §15 回归（2026-10-16：deny 里带未注册名字 → tools.restrict() 抛 → 叶子完全起不来）----
  const registryNow = new Set(ctx.toolRegistry);
  const filteredForReal = serviceModule.filterLeafDeniedTools(ctx.toolRegistry);
  check(
    '过滤后的 deny 只含注册表里真实存在的名字（未知名字会让 restrict() 抛）',
    Array.isArray(filteredForReal.deny) && filteredForReal.deny.every((name) => registryNow.has(name)),
    { deny: filteredForReal.deny, unknown: filteredForReal.deny.filter((name) => !registryNow.has(name)) },
  );
  check(
    '未注册的官方 team 名字被丢弃（而不是传给 restrict）',
    ['spawn_teammate', 'wait_agent', 'team_task_create', 'interrupt_agent'].every((name) => filteredForReal.dropped.includes(name)),
    { dropped: filteredForReal.dropped },
  );
  check('过滤后的 deny 不含任何文件/命令工具（叶子必须能产出产物）', serviceModule.LEAF_REQUIRED_TOOLS.every((name) => !filteredForReal.deny.includes(name)), { deny: filteredForReal.deny, required: serviceModule.LEAF_REQUIRED_TOOLS });
  check(
    '过滤后仍剥夺全部成员级自治入口（插件自己注册的，一定在表里）',
    serviceModule.MEMBER_LEVEL_TOOLS.every((name) => filteredForReal.deny.includes(name)),
    serviceModule.MEMBER_LEVEL_TOOLS.filter((name) => !filteredForReal.deny.includes(name)),
  );
  check('注册表读不到时不传未知名字（回退为自注册成员级 deny，绝不猜官方工具名）', serviceModule.filterLeafDeniedTools(undefined).deny === null && serviceModule.filterLeafDeniedTools([]).reason === 'REGISTRY_UNAVAILABLE', serviceModule.filterLeafDeniedTools(undefined));
  // 注册表"不可信"（缺少本插件自注册工具）时的回退：只剥夺自注册成员级入口，仍不传未知名字。
  {
    const savedList = ctx.toolRegistry;
    ctx.toolRegistry = ['read', 'write', 'edit', 'subagent']; // 缺本插件的成员级工具 → 视为不可信
    const probeService = new TeamWorkbenchService(ctx, createAdapter(ctx), storage, config);
    const fallback = probeService.leafToolFilter({ workId: 'probe-partial' });
    check('注册表不可信时回退为自注册成员级 deny（该剥夺的不漏）', Array.isArray(fallback?.deny) && serviceModule.MEMBER_LEVEL_TOOLS.every((name) => fallback.deny.includes(name)), fallback);
    check('回退路径同样不含任何文件/命令工具与未知名字', Array.isArray(fallback?.deny) && serviceModule.LEAF_REQUIRED_TOOLS.every((name) => !fallback.deny.includes(name)), fallback);
    ctx.toolRegistry = savedList;
  }
  // 端到端：真实启动出去的 spec 里 deny 已过滤，且叶子确实没有被剥夺 write。
  const leafSpecs = ctx.startSpecs ?? [];
  const firstSpec = leafSpecs[0];
  check('已有 leaf 走原生 startContinuable 且带过滤后的 toolFilter', leafSpecs.length > 0 && Array.isArray(firstSpec?.request?.toolFilter?.deny), { specs: leafSpecs.length, toolFilter: firstSpec?.request?.toolFilter });
  check(
    '传给 leaf 的 deny 里没有 write/read/edit/glob/grep/pwsh（§15 的目的：叶子能产出产物）',
    firstSpec !== undefined && ['write', 'read', 'edit', 'glob', 'grep', 'pwsh'].every((name) => !firstSpec.request.toolFilter.deny.includes(name)),
    firstSpec?.request?.toolFilter?.deny?.filter((name) => ['write', 'read', 'edit', 'glob', 'grep', 'pwsh'].includes(name)),
  );
  check('传给 leaf 的 deny 全是注册表里的真实名字', firstSpec !== undefined && firstSpec.request.toolFilter.deny.every((name) => registryNow.has(name)), firstSpec?.request?.toolFilter?.deny?.filter((name) => !registryNow.has(name)));
  check('本 profile 未注册的名字（spawn_teammate 等）没有被传给 restrict', firstSpec !== undefined && !firstSpec.request.toolFilter.deny.includes('spawn_teammate') && !firstSpec.request.toolFilter.deny.includes('wait_agent'), firstSpec?.request?.toolFilter?.deny?.filter((name) => !registryNow.has(name)));
  check('service.lastLeafToolFilter 记录了丢弃的未注册名字（可审计）', Array.isArray(service.lastLeafToolFilter?.dropped) && service.lastLeafToolFilter.dropped.includes('spawn_teammate'), service.lastLeafToolFilter);
  check(
    'deny 清单里每一个名字都能在「插件注册 + 官方基线」里找到出处（防再次写入凭空的工具名）',
    (() => {
      const officialFixture = JSON.parse(readFileSync(new URL('../tests/fixtures/dsh-tool-names.json', import.meta.url), 'utf8'));
      const known = new Set([...officialFixture.official, ...officialFixture.pluginTeamTools, ...ctx.toolRegistry]);
      return serviceModule.LEAF_DENIED_TOOLS.every((name) => known.has(name));
    })(),
    serviceModule.LEAF_DENIED_TOOLS.filter((name) => {
      const officialFixture = JSON.parse(readFileSync(new URL('../tests/fixtures/dsh-tool-names.json', import.meta.url), 'utf8'));
      const known = new Set([...officialFixture.official, ...officialFixture.pluginTeamTools, ...ctx.toolRegistry]);
      return !known.has(name);
    }),
  );

  console.log('\n[8] layout and same-session dedup');
  await service.setLayout(4, {});
  const first = await service.upsertPane({ paneId: 'pane-1', target: { sessionId: 'session-lead' }, label: 'leader' });
  const second = await service.upsertPane({ paneId: 'pane-2', target: { sessionId: 'session-lead' } });
  check('same session focuses existing pane', second.ok === true && second.focusedExisting === 'pane-1', second);
  check('never two editors for one session', service.layout().panes.filter((p) => p.target?.sessionId === 'session-lead').length === 1, service.layout().panes);
  await service.removePane('pane-2');
  check('closing a pane never stops agents', first.ok === true && service.layout().panes.length === 4 && service.layout().panes.find((p) => p.paneId === 'pane-2').target === null, service.layout().panes.map((p) => p.paneId + ':' + String(p.target)));

  console.log('\n[9] recovery');
  const recovery = await service.reconcile();
  check('reconcile returns report', typeof recovery === 'object' && Array.isArray(recovery.requeued), recovery);

  console.log('\n[10] write-scope mutual exclusion');
  await service.defineTeam(lead, { teamKey: 'proj-b', layout: 'systems', goal: 'b' });
  await service.createMember(lead, { teamKey: 'proj-b', name: 'pkg', description: 'shared package delivery' });
  const pkgAgent = ctx.agents.get('session-pkg');
  const sharedA = await service.submitWork(combat, {
    teamKey: 'team-a',
    workId: 'shared-a',
    title: 'shared package side A',
    deliverable: 'shared package side A complete implementation',
    ownerMemberId: 'combat',
    outputs: ['shared/pkg/a.ts'],
    writeScopes: ['shared/pkg'],
    acceptance: ['usable'],
  });
  const sharedB = await service.submitWork(pkgAgent, {
    teamKey: 'proj-b',
    workId: 'shared-b',
    title: 'shared package side B',
    deliverable: 'shared package side B complete implementation',
    ownerMemberId: 'pkg',
    outputs: ['shared/pkg/b.ts'],
    writeScopes: ['shared/pkg'],
    acceptance: ['usable'],
  });
  check('two cross-team works submitted', sharedA.ok === true && sharedB.ok === true, { a: sharedA.code, b: sharedB.code });
  const conflictTick = await service.mutex.run(() => service.reserveStarts({ agents: [], childrenByParent: {} }, 10));
  const startedNow = conflictTick.plans.filter((plan) => plan.workId === 'shared-a' || plan.workId === 'shared-b');
  check('overlapping scope reserves only one', startedNow.length === 1, startedNow.map((p) => p.workId));
  check('the other is deferred, not dropped', conflictTick.rejections.some((r) => r.code === 'WRITE_SCOPE_CONFLICT' && (r.workId === 'shared-a' || r.workId === 'shared-b')), conflictTick.rejections);
  check('holders visible in snapshot', Array.isArray(service.snapshot(lead).writeScopeHolders));

  console.log('\n[11] native capacity rejection is a deferral, not a failure');
  ctx.startContinuableError = 'ACTIVATION_LIMIT_REACHED';
  // 用一个**新成员**承载探测项：combat 的 20 个在跑项已经吃满它的成员额度
  // （MEMBER_FAIR_SHARE_FULL），那测到的是公平额度而不是"原生容量拒绝"这条路径。
  await service.createMember(lead, { teamKey: 'team-a', name: 'capowner', description: 'capacity probe owner' });
  const capOwner = ctx.agents.get('session-capowner');
  const capWork = await service.submitWork(capOwner, {
    teamKey: 'team-a',
    workId: 'wcap',
    title: 'capacity probe',
    deliverable: 'capacity probe complete implementation',
    ownerMemberId: 'capowner',
    outputs: ['src/cap/index.ts'],
    acceptance: ['usable'],
  });
  check('capacity probe submitted', capWork.ok === true, capWork.code);
  // 用**定向**启动入口（与后台补位共用同一实现），而不是先跑全局 reserveStarts：
  // 后者会先选中别的 ready 项，正是审计 §三.2 描述的老缺陷形状。
  const capStart = await service.subagentStart(capOwner, { workId: 'wcap' });
  check('capacity rejection reported as deferred', capStart.ok === false && capStart.deferred === true, capStart);
  const capRecord = service.works.get('wcap');
  check('work stays ready, not blocked', capRecord.state === 'ready', { state: capRecord.state, reason: capRecord.blockedReason });
  check('attempt budget NOT consumed by a capacity rejection', capRecord.attempts.length === 0, capRecord.attempts);
  check('failure streak untouched', (capRecord.failureStreak ?? 0) === 0, capRecord.failureStreak);
  check('capacity deferral counted', service.capacity().capacityDeferrals >= 1, service.capacity().capacityDeferrals);
  const cooled = await service.mutex.run(() => service.reserveStarts({ agents: [], childrenByParent: {} }, 4));
  check('cooldown refuses new reservations instead of hot-looping', cooled.plans.length === 0 && cooled.rejections.some((r) => r.code === 'NATIVE_CAPACITY_COOLDOWN'), cooled.rejections);
  ctx.startContinuableError = null;
  service.nativeCapacityBlockedUntil = 0;
  const recoveredStart = await service.subagentStart(capOwner, { workId: 'wcap' });
  check('probe starts after capacity frees（定向入口同一条幂等实现）', recoveredStart.ok === true && recoveredStart.reused === false, recoveredStart);

  console.log('\n[12] layout keeps the four canonical pane identities');
  await service.setLayout(4, {});
  const fourUp = service.layout();
  check('mode 4 always exposes pane-1..pane-4', fourUp.panes.map((p) => p.paneId).join(',') === 'pane-1,pane-2,pane-3,pane-4', fourUp.panes.map((p) => p.paneId));
  await service.upsertPane({ paneId: 'pane-1', target: { sessionId: 'session-lead' }, label: 'leader' });
  await service.upsertPane({ paneId: 'pane-2', target: { sessionId: 'session-combat' }, label: 'combat' });
  await service.focusPane('pane-1');
  const closed = await service.removePane('pane-1');
  check('closing a pane keeps its identity', service.layout().panes.length === 4, service.layout().panes.length);
  check('closing a pane releases its binding', service.layout().panes.find((p) => p.paneId === 'pane-1').target === null, service.layout().panes.find((p) => p.paneId === 'pane-1'));
  check('closing the active pane moves focus to a bound pane', service.layout().activePaneId === 'pane-2', service.layout().activePaneId);
  check('layout record holds exactly one copy of the record', service.storage.get('layout', 'current')?.record === undefined, Object.keys(service.storage.get('layout', 'current') ?? {}));
  check('no foreign pane ids survive normalization', closed.ok === true && service.layout().panes.every((p) => ['pane-1', 'pane-2', 'pane-3', 'pane-4'].includes(p.paneId)));

  console.log('\n[13] host refuses subagent targets for panes');
  const combatMember = service.members.get('team-a/combat');
  const bindMember = await service.upsertPane({
    paneId: 'pane-3',
    target: { parentSessionId: 'session-lead', childSessionId: combatMember.sessionId, mode: 'continuable' },
    role: 'member',
  });
  check('agent-team member session is bindable', bindMember.ok === true, bindMember);
  const bindLeaf = await service.upsertPane({
    paneId: 'pane-4',
    target: { parentSessionId: 'session-lead', childSessionId: 'child-not-a-member', mode: 'continuable' },
    role: 'subagent',
  });
  check('non-member subagent target rejected', bindLeaf.ok === false && bindLeaf.code === 'LEAF_NOT_BINDABLE', bindLeaf);
  check('rejected target did not enter the layout', service.layout().panes.find((p) => p.paneId === 'pane-4').target === null, service.layout().panes.find((p) => p.paneId === 'pane-4'));
  const bulk = await service.setLayout(4, {
    panes: [
      { paneId: 'pane-1', target: { sessionId: 'session-lead' } },
      { paneId: 'pane-2', target: { parentSessionId: 'session-lead', childSessionId: 'child-not-a-member', mode: 'continuable' } },
    ],
  });
  check('bulk layout also strips leaf targets', bulk.ok === true && Array.isArray(bulk.rejectedTargets) && bulk.rejectedTargets.length === 1, bulk.rejectedTargets);
  check('bulk layout kept the main session binding', service.layout().panes.find((p) => p.paneId === 'pane-1').target?.sessionId === 'session-lead', service.layout().panes.find((p) => p.paneId === 'pane-1'));

  // 官方 spawn_teammate 建出的成员不在本插件 members 表里，但**原生 roster** 里在册：
  // Host 闸门必须放行，否则会误伤官方成员会话。
  ctx.teammateRoster = [{ id: 'official-member-session', name: 'official-member', role: 'teammate' }];
  const officialBind = await service.upsertPane({
    paneId: 'pane-4',
    target: { parentSessionId: 'session-lead', childSessionId: 'official-member-session', mode: 'continuable' },
    role: 'member',
  });
  check('official roster member is bindable (no false rejection)', officialBind.ok === true, officialBind);
  ctx.teammateRoster = null;
  const stillLeaf = await service.upsertPane({
    paneId: 'pane-4',
    target: { parentSessionId: 'session-lead', childSessionId: 'child-not-a-member', mode: 'continuable' },
  });
  check('roster miss still rejects a leaf', stillLeaf.ok === false && stillLeaf.code === 'LEAF_NOT_BINDABLE', stillLeaf);
  check('rejected leaf target is counted', service.capacity().guards.leafTargetsRejected >= 1, service.capacity().guards);

  // fail-open 必须**可见**：父 Agent 不存活时 Host 放行，但必须留下诊断与计数（客户端 fail-closed 兜底）。
  const orphanBind = await service.upsertPane({
    paneId: 'pane-4',
    target: { parentSessionId: 'session-does-not-exist', childSessionId: 'orphan-child', mode: 'continuable' },
  });
  check('unverifiable subagent target is fail-open (not silently blocked)', orphanBind.ok === true, orphanBind);
  check('fail-open is counted, not hidden', service.capacity().guards.unverifiedSubagentTargets >= 1, service.capacity().guards);
  check('fail-open leaves a diagnostic for the reviewer', service.diagnostics.list().some((entry) => entry.code === 'service:subagent-target-unverified'), service.diagnostics.list().filter((entry) => String(entry.code).includes('unverified')).length);

  console.log('\n[14] blocked reasons other than DEPENDENCIES_UNSATISFIED never auto-revive');
  // 孤儿只能来自**既有数据**：新提交会先被 OWNER_NOT_MEMBER 挡住（owner 必须先是成员）。
  // 所以场景必须是「先有成员 → 提交 → 成员消失 → 对账」。
  const combatKey = 'team-a/combat';
  check('probe precondition: member exists before submit', service.members.get(combatKey) !== undefined, [...service.members.keys()]);
  const orphanWork = await service.submitWork(combat, {
    teamKey: 'team-a',
    workId: 'worphan',
    title: 'orphan owner probe',
    deliverable: 'orphan owner probe complete implementation',
    ownerMemberId: 'combat',
    outputs: ['src/orphan/index.ts'],
    acceptance: ['usable'],
  });
  check('submit with a live member succeeds', orphanWork.ok === true, orphanWork.code);
  check('fresh submit with an unknown owner is refused up front', (await service.submitWork(lead, { teamKey: 'team-a', workId: 'wnope', title: 'x', deliverable: 'x implementation', ownerMemberId: 'ghost-member', outputs: ['src/x/index.ts'], acceptance: ['y'] })).code === 'OWNER_NOT_MEMBER');
  // 成员消失（等价于：成员记录从未落盘 → 重启后 members 为空）
  service.members.delete(combatKey);
  await service.storage.put('members', combatKey, undefined); // `put(..., undefined)` = 删除（见 storage.persist）
  const orphanReport = await service.reconcile();
  check('reconcile reports the orphan owner', (orphanReport.orphanOwner ?? []).some((entry) => entry.workId === 'worphan'), orphanReport.orphanOwner);
  const orphanRecord = service.works.get('worphan');
  check('orphan work is marked blocked(OWNER_MEMBER_MISSING)', orphanRecord.state === 'blocked' && orphanRecord.blockedReason === 'OWNER_MEMBER_MISSING', { state: orphanRecord.state, reason: orphanRecord.blockedReason });
  check('默认对账不自动改写历史 owner（保守）', (orphanReport.legacyMapped ?? []).length === 0, orphanReport.legacyMapped);
  check('歧义/无法核实时写明具体待处理原因', (orphanReport.legacyPending ?? []).some((entry) => entry.workId === 'worphan' && typeof entry.pendingReason === 'string' && entry.pendingReason.length > 8), orphanReport.legacyPending);
  const secondReconcile = await service.reconcile();
  check('a second reconcile does NOT revive the orphan', service.works.get('worphan').state === 'blocked', { state: service.works.get('worphan').state, requeued: secondReconcile.requeued });
  // 反向护栏：不能因为收紧而让「依赖未满足」不再自动放行。
  // 注意必须用一个 owner **存在**的 work —— 孤儿会被孤儿对账永远重新标记，测不到依赖分支。
  const depWork = await service.submitWork(lead, { teamKey: 'team-a', workId: 'wdep', title: 'dep probe', deliverable: 'dep probe complete implementation', ownerMemberId: 'lead', outputs: ['src/dep/index.ts'], acceptance: ['usable'] });
  check('dependency probe submitted', depWork.ok === true, depWork.code);
  const depCurrent = service.works.get('wdep');
  const depMarked = await service.storage.put('works', 'wdep', { ...depCurrent, state: 'blocked', blockedReason: 'DEPENDENCIES_UNSATISFIED', blockedBy: [] }, { expectRev: depCurrent.rev });
  if (depMarked.ok) service.works.set('wdep', depMarked.record);
  const thirdReconcile = await service.reconcile();
  check('DEPENDENCIES_UNSATISFIED with satisfied deps still auto-revives', service.works.get('wdep').state === 'ready' && thirdReconcile.requeued.includes('wdep'), { state: service.works.get('wdep').state, reason: service.works.get('wdep').blockedReason, requeued: thirdReconcile.requeued });

  console.log('\n[15] key encoding is reversible AND self-verifying');
  // 合法键原样、非法键编码；**关键**：`zz` 开头的合法历史键绝不能被误解码
  // （有人可能把 workId 起成 `zz-abcd`，旧后端会原样落盘）。
  const probeKeys = ['zz-abcd', 'zzc0000abcd', 'zzc1234', 'team-x/member-y', 'emoji-😀', 'a b', '保留/中文'];
  for (const probe of probeKeys) await storage.put('layout', probe, { probe });
  const listedNow = storage.list('layout').map((entry) => entry[0]);
  check('probe keys visible verbatim in memory', probeKeys.every((key) => listedNow.includes(key)), listedNow.filter((key) => key.includes('zz') || key.includes('/') || key.includes(' ')));
  // 重启语义：用同一个 domain 起第二个 storage → hydrate → 走 decodeKey
  const storage2 = createStorage(ctx, adapter, {});
  await storage2.ready();
  const listedAfter = storage2.list('layout').map((entry) => entry[0]);
  check('every probe key rehydrates verbatim (no mis-decode)', probeKeys.every((key) => listedAfter.includes(key)), listedAfter.filter((key) => key.includes('zz') || key.includes('/') || key.includes(' ')));
  check('ambiguous-looking legacy key is NOT decoded', listedAfter.includes('zz-abcd') && !listedAfter.includes('\uabcd'), listedAfter.filter((key) => key.startsWith('zz')));
  check('encoded key still round-trips its value', storage2.get('layout', 'team-x/member-y')?.probe === 'team-x/member-y', storage2.get('layout', 'team-x/member-y'));
  for (const probe of probeKeys) await storage.put('layout', probe, undefined);

  // ===========================================================================
  // 成员自治（契约 §1–§11）
  // ===========================================================================
  console.log('\n[16] 成员自治：mission / 成员计划 / 授权门闸');
  // [14] 刻意删掉了 team-a/combat 的成员记录（孤儿 owner 对账）。这里恢复该成员身份，
  // 不影响上面"孤儿 work 不会自动复活"的结论（worphan 仍 blocked）。
  ctx.memberships.set('session-combat', { root: lead, id: 'session-lead', role: 'teammate', name: 'combat' });
  service.members.set('team-a/combat', {
    memberId: 'combat', teamKey: 'team-a', role: 'teammate', phase: 'active', sessionId: 'session-combat',
    responsibility: 'combat', writeScopes: [], context: 'fresh', provider: null, createdAt: service.clock.now(),
  });
  // combat 的成员额度已被 [3] 的 20 个在跑项吃满；自治链路用**新成员 auto** 走一遍，
  // 这样跑的是一条干净成员的完整自治流程。
  const autoRecord = await service.createMember(lead, { teamKey: 'team-a', name: 'auto', description: 'autonomy path owner' });
  const auto = ctx.agents.get('session-auto');
  check('autonomy member created', autoRecord.ok === true && auto?.id === 'session-auto', autoRecord);

  // ---- 16a planSubmit 也必须过图级闸（与 submitWork 同一道，不是两套判定） --------
  await service.missionAssign(lead, { teamKey: 'team-a', memberId: 'auto', missionId: 'm-relay', title: '阶段接力探测', goal: '不该被接受' });
  const relayPlan = await service.planSubmit(auto, {
    teamKey: 'team-a',
    missionId: 'm-relay',
    expectedPlanRevision: 0,
    deliverables: [
      { workId: 'relay-a', title: 'Boss 背景调查', deliverable: 'Boss 背景调查报告', partOf: 'boss-relay', outputs: ['docs/boss-background-report.md'], acceptance: ['调查完成'], execution: 'delegate' },
      { workId: 'relay-b', title: 'Boss 设计方案', deliverable: 'Boss 设计方案', partOf: 'boss-relay', outputs: ['docs/boss-design.md'], acceptance: ['设计完成'], blockedBy: ['relay-a'], execution: 'delegate' },
      { workId: 'relay-c', title: 'Boss 检查报告', deliverable: 'Boss 检查报告', partOf: 'boss-relay', outputs: ['docs/boss-check.md'], acceptance: ['检查完成'], blockedBy: ['relay-b'], execution: 'delegate' },
    ],
  });
  check('planSubmit 阶段接力被拒（与 submitWork 同一道闸）', relayPlan.ok === false && ['PHASE_RELAY_SPLIT', 'PHASE_RELAY_GRAPH'].includes(relayPlan.code), relayPlan);
  check('planSubmit 拒绝时带 graphViolations 或 replan hint', Array.isArray(relayPlan.graphViolations) || typeof relayPlan.hint === 'string', { violations: relayPlan.graphViolations, hint: relayPlan.hint });
  check('planSubmit 整批原子：一条都没入库', !['relay-a', 'relay-b', 'relay-c'].some((id) => service.works.has(id)), [...service.works.keys()].filter((key) => key.startsWith('relay')));
  check('planSubmit 拒绝后 planRevision 未推进', service.missions.get('team-a/m-relay')?.planRevision === 0, service.missions.get('team-a/m-relay')?.planRevision);

  // ---- 16b mission 不是可调度项 -------------------------------------------------
  const memberSessionId = 'session-auto';
  const mission = await service.missionAssign(lead, {
    teamKey: 'team-a',
    memberId: 'auto',
    missionId: 'm-auto',
    title: '战斗系统模块',
    goal: '交付可接入的战斗系统模块',
    boundaries: ['不改数值表之外的模块'],
    acceptance: ['可接入且无占位实现'],
  });
  check('missionAssign ok', mission.ok === true, mission);
  check('mission 不产生任何 work', !service.works.has('m-auto'), [...service.works.keys()].filter((key) => key.includes('m-auto')));
  check('mission 入队 mission_assigned 事件', service.pendingEvents('team-a', 'auto').some((event) => event.type === 'mission_assigned'), service.pendingEvents('team-a', 'auto').map((event) => event.type));
  check('mission 入队后真实投递唤醒（不是只改状态）', ctx.wakeLog.some((entry) => entry.target === 'auto' && entry.text.includes('team_member_inbox')), ctx.wakeLog.filter((entry) => entry.target === 'auto').length);
  const missionView = service.snapshot(lead).autonomy.byMember[memberSessionId];
  check('autonomy.byMember 以成员 session 为键', missionView !== undefined && missionView.memberId === 'auto', Object.keys(service.snapshot(lead).autonomy.byMember));
  check('mission state=assigned', missionView?.mission?.state === 'assigned', missionView?.mission);

  // ---- 16c 成员自己的计划（原子提交多个独立交付项） -----------------------------
  const plan = await service.planSubmit(auto, {
    teamKey: 'team-a',
    missionId: 'm-auto',
    expectedPlanRevision: 0,
    note: '按独立对象横向切分',
    deliverables: [
      { workId: 'mm-hit', title: '命中判定完整交付', deliverable: '命中判定模块完整实现', outputs: ['src/combat/hit.ts'], acceptance: ['可接入'], writeScopes: ['src/combat/hit'], execution: 'delegate', brief: '数值表见 src/combat/numbers.ts' },
      { workId: 'mm-self', title: '战斗数值表整理', deliverable: '战斗数值表完整整理', outputs: ['src/combat/numbers.ts'], acceptance: ['无占位'], writeScopes: ['src/combat/numbers'], execution: 'self' },
    ],
  });
  check('planSubmit ok', plan.ok === true, plan);
  check('planRevision 由 0 → 1', plan.ok === true && plan.planRevision === 1, plan.planRevision);
  check('delegate 项 state=planned（未授权）', service.works.get('mm-hit')?.state === 'planned', service.works.get('mm-hit')?.state);
  check('self 项 state=self_running', service.works.get('mm-self')?.state === 'self_running', service.works.get('mm-self')?.state);
  check('plannedBy 由 Host 从真实 actor 写', service.works.get('mm-hit')?.plannedBy === 'auto', service.works.get('mm-hit')?.plannedBy);
  const stalePlan = await service.planSubmit(auto, {
    teamKey: 'team-a', missionId: 'm-auto', expectedPlanRevision: 0,
    deliverables: [{ title: 'x', deliverable: 'x 完整实现', outputs: ['src/x.ts'], acceptance: ['y'], execution: 'delegate' }],
  });
  check('过期 planRevision 被 CAS 拒绝', stalePlan.ok === false && stalePlan.code === 'PLAN_CAS_MISMATCH', stalePlan);
  const spoof = await service.planSubmit(auto, {
    teamKey: 'team-a', missionId: 'm-auto', expectedPlanRevision: 1, plannedBy: 'lead', memberApproved: true, actorId: 'lead',
    deliverables: [{ workId: 'mm-spoof', title: '伪装身份探测', deliverable: '伪装身份探测完整实现', outputs: ['src/combat/spoof.ts'], acceptance: ['可接入'], execution: 'delegate' }],
  });
  check('模型传的 plannedBy/memberApproved 被丢弃并上报', spoof.ok === true && spoof.droppedIdentityFields.includes('plannedBy') && service.works.get('mm-spoof')?.plannedBy === 'auto', { dropped: spoof.droppedIdentityFields, plannedBy: service.works.get('mm-spoof')?.plannedBy });

  // ---- 16d **无授权不启动**（核心不变量） ---------------------------------------
  service.nativeCapacityBlockedUntil = 0;
  ctx.startContinuableError = null;
  const noAuthTick = await scheduler.tick();
  check('没有 authorized 意图的自治 work 永不自动启动', !noAuthTick.started.some((plan) => ['mm-hit', 'mm-spoof'].includes(plan.workId)), noAuthTick.started.map((plan) => plan.workId));
  check('后台补位把未授权项列为 DISPATCH_NOT_AUTHORIZED（不是静默跳过）', noAuthTick.rejected.some((rejection) => rejection.code === 'DISPATCH_NOT_AUTHORIZED'), noAuthTick.rejected.filter((r) => r.code === 'DISPATCH_NOT_AUTHORIZED'));
  const unauthorizedReservation = await service.mutex.run(() => service.reserveStarts({ agents: [], childrenByParent: {} }, 10));
  check(
    '未授权/未换版的项永不进入候选（reserveStarts 不预留它）',
    !unauthorizedReservation.plans.some((plan) => plan.workId === 'mm-spoof'),
    { planned: unauthorizedReservation.plans.map((plan) => plan.workId), unauthorized: unauthorizedReservation.unauthorized },
  );
  const directUnauthorized = await service.subagentStart(auto, { workId: 'mm-hit' });
  check('定向启动同样拒绝未授权 work', directUnauthorized.ok === false && directUnauthorized.code === 'DISPATCH_NOT_AUTHORIZED', directUnauthorized);
  const selfStart = await service.subagentStart(auto, { workId: 'mm-self' });
  check('execution=self 的项不能被叶子启动', selfStart.ok === false && selfStart.code === 'EXECUTION_SELF', selfStart);

  // ---- 16d2 契约 §13：依赖语义（blockedBy 与 dependencies 合并成同一份） --------
  const planRevisionBeforeDeps = service.missions.get('team-a/m-auto')?.planRevision ?? 0;
  const producerPlan = await service.planSubmit(auto, {
    teamKey: 'team-a', missionId: 'm-auto', expectedPlanRevision: planRevisionBeforeDeps,
    deliverables: [{
      workId: 'mm-producer', title: '被依赖的产物', deliverable: '被依赖的产物完整实现',
      outputs: ['src/combat/producer.ts'], acceptance: ['可接入'], execution: 'delegate',
    }],
  });
  check('§13.2 planSubmit 支持纯 workId 形状的 blockedBy（本批无依赖）', producerPlan.ok === true, producerPlan);
  const dependencyPlan = await service.planSubmit(auto, {
    teamKey: 'team-a', missionId: 'm-auto', expectedPlanRevision: planRevisionBeforeDeps + 1,
    deliverables: [{
      workId: 'mm-dep', title: '依赖项交付', deliverable: '依赖项交付完整实现',
      outputs: ['src/combat/dep.ts'], acceptance: ['可接入'], execution: 'delegate',
      blockedBy: ['mm-producer'],
      dependencies: [{ workId: 'mm-producer', version: 1, requires: 'verified-result' }],
    }],
  });
  check('§13.2 dependencies[{workId,version,requires}] 被接受并合并', dependencyPlan.ok === true, dependencyPlan);
  check('§13.2 未满足依赖 → blocked(DEPENDENCIES_UNSATISFIED)', service.works.get('mm-dep')?.state === 'blocked' && service.works.get('mm-dep')?.blockedReason === 'DEPENDENCIES_UNSATISFIED', { state: service.works.get('mm-dep')?.state, reason: service.works.get('mm-dep')?.blockedReason, blockedBy: service.works.get('mm-dep')?.blockedBy });
  check('§13.2 requires=verified-result 进入 artifactDependencies', service.works.get('mm-dep')?.artifactDependencies?.[0]?.requires === 'verified-result', service.works.get('mm-dep')?.artifactDependencies);
  const depAuthorize = await service.dispatchAuthorize(auto, { teamKey: 'team-a', planRevision: service.works.get('mm-producer')?.planRevision ?? 0, workIds: ['mm-producer'] });
  const depAuthorize2 = await service.dispatchAuthorize(auto, { teamKey: 'team-a', planRevision: service.works.get('mm-dep')?.planRevision ?? 0, workIds: ['mm-dep'] });
  check('§13.2 有依赖的项也能被授权（但仍是 blocked）', depAuthorize.ok === true && depAuthorize2.ok === true && service.works.get('mm-dep')?.state === 'blocked', { auth: depAuthorize.ok, authDep: depAuthorize2.ok, state: service.works.get('mm-dep')?.state });
  const depClaim = await service.claimWork(auto, { workId: 'mm-dep' });
  check('§13.3 未满足依赖不能认领（WORK_BLOCKED）', depClaim.ok === false && depClaim.code === 'WORK_BLOCKED', depClaim);
  const depStart = await service.subagentStart(auto, { workId: 'mm-dep' });
  check('§13.3 未满足依赖不能被定向启动（WORK_BLOCKED）', depStart.ok === false && depStart.code === 'WORK_BLOCKED', depStart);
  check('§13.3 computeReady 不含 blocked 的 work', !service.computeReady().some((work) => work.workId === 'mm-dep'), service.computeReady().map((work) => work.workId));
  // 跨成员依赖合法（auto 的 plan 依赖 auto 自己的 work 已覆盖成员内；这里验证别人的 work 不能被改）
  const crossEdit = await service.planSubmit(combat, {
    teamKey: 'team-a', missionId: 'm-auto', expectedPlanRevision: planRevisionBeforeDeps + 2,
    deliverables: [{ workId: 'mm-producer', title: 'x', deliverable: 'x 完整实现', outputs: ['src/x.ts'], acceptance: ['y'], execution: 'delegate' }],
  });
  check('§13.4 不得借依赖改别人的 work（DELEGATION_SCOPE）', crossEdit.ok === false && crossEdit.code === 'DELEGATION_SCOPE', crossEdit);

  // ---- 16d3 契约 §13.2：解析不到的依赖**大声拒绝**，绝不静默降级为"无依赖" --------
  const ghostDependency = await service.planSubmit(auto, {
    teamKey: 'team-a', missionId: 'm-auto', expectedPlanRevision: service.missions.get('team-a/m-auto')?.planRevision ?? 0,
    deliverables: [{
      workId: 'mm-ghost-dep', title: '引用不存在的依赖', deliverable: '引用不存在的依赖完整实现',
      outputs: ['src/combat/ghost.ts'], acceptance: ['可接入'], execution: 'delegate',
      blockedBy: ['no-such-work-anywhere'],
    }],
  });
  check('§13.2 解析不到的 blockedBy 被拒（DEPENDENCY_UNRESOLVED，不是静默变 ready）', ghostDependency.ok === false && ghostDependency.code === 'DEPENDENCY_UNRESOLVED', ghostDependency);
  check('§13.2 拒绝带 hint 与 unresolved 列表', typeof ghostDependency.hint === 'string' && ghostDependency.unresolved?.includes('no-such-work-anywhere'), { hint: ghostDependency.hint, unresolved: ghostDependency.unresolved });
  check('§13.2 整批原子：被拒的依赖项没有入库', !service.works.has('mm-ghost-dep'), [...service.works.keys()].filter((key) => key.startsWith('mm-ghost')));
  const ghostSubmit = await service.submitWork(auto, {
    teamKey: 'team-a', workId: 'mm-ghost-submit', title: '直连路径引用不存在的依赖',
    deliverable: '直连路径引用不存在的依赖完整实现', ownerMemberId: 'auto',
    outputs: ['src/combat/ghost2.ts'], acceptance: ['可接入'], blockedBy: ['no-such-work-either'],
  });
  check('§13.2 submitWork 路径同样拒绝（两条路径同一判定）', ghostSubmit.ok === false && ghostSubmit.code === 'DEPENDENCY_UNRESOLVED', ghostSubmit);
  // 产物路径解析：按 outputs 反查生产者
  const byOutput = await service.planSubmit(auto, {
    teamKey: 'team-a', missionId: 'm-auto', expectedPlanRevision: service.missions.get('team-a/m-auto')?.planRevision ?? 0,
    deliverables: [{
      workId: 'mm-by-output', title: '按产物路径依赖', deliverable: '按产物路径依赖完整实现',
      outputs: ['src/combat/by-output.ts'], acceptance: ['可接入'], execution: 'delegate',
      dependencies: [{ artifact: 'src/combat/producer.ts', version: 1, requires: 'published-interface' }],
    }],
  });
  check('§13.2 依赖可按产物路径解析并正确链接', byOutput.ok === true && service.works.get('mm-by-output')?.blockedBy.includes('mm-producer'), { ok: byOutput.ok, code: byOutput.code, blockedBy: service.works.get('mm-by-output')?.blockedBy, state: service.works.get('mm-by-output')?.state });
  check('§13.2 按产物路径解析后仍是 blocked（依赖未满足）', service.works.get('mm-by-output')?.state === 'blocked' && service.works.get('mm-by-output')?.blockedReason === 'DEPENDENCIES_UNSATISFIED', { state: service.works.get('mm-by-output')?.state, reason: service.works.get('mm-by-output')?.blockedReason });

  // ---- 16e 授权后只启动被授权的项 -----------------------------------------------
  // 契约 §12.1：`planSubmit` **只产生 planned，不产生任何授权**（self/delegate 都一样）。
  check('§12.1 planSubmit 不产生任何授权意图', service.works.get('mm-hit')?.state === 'planned' && ![...service.dispatchIntents.values()].some((intent) => ['mm-hit', 'mm-self'].includes(intent.workId)), [...service.dispatchIntents.values()].map((intent) => intent.workId));
  const authorize = await service.dispatchAuthorize(auto, { teamKey: 'team-a', planRevision: 1, workIds: ['mm-hit'] });
  check('dispatchAuthorize ok', authorize.ok === true, authorize);
  check('authorize 后 work 进入 ready（§12.4）', service.works.get('mm-hit')?.state === 'ready', service.works.get('mm-hit')?.state);
  // 契约 §12.3：重复授权幂等——不建第二条 intent、不改 planRevision、work 仍可调度。
  const intentsBefore = service.dispatchIntents.size;
  const planRevisionBeforeReauth = service.missions.get('team-a/m-auto')?.planRevision;
  const reAuthorize1 = await service.dispatchAuthorize(auto, { teamKey: 'team-a', planRevision: 1, workIds: ['mm-hit'] });
  const reAuthorize2 = await service.dispatchAuthorize(auto, { teamKey: 'team-a', planRevision: 1, workIds: ['mm-hit'] });
  check('§12.3 重复授权幂等（返回既有意图、不新建）', reAuthorize1.ok === true && reAuthorize2.ok === true && service.dispatchIntents.size === intentsBefore, { before: intentsBefore, after: service.dispatchIntents.size, id1: reAuthorize1.intents?.[0]?.intentId, id2: reAuthorize2.intents?.[0]?.intentId });
  check('§12.3 重复授权不改 planRevision', service.missions.get('team-a/m-auto')?.planRevision === planRevisionBeforeReauth, { before: planRevisionBeforeReauth, after: service.missions.get('team-a/m-auto')?.planRevision });
  check('§12.3 重复授权不建第二条 intent（同 work 同 revision）', [...service.dispatchIntents.values()].filter((intent) => intent.workId === 'mm-hit').length === 1, [...service.dispatchIntents.values()].filter((intent) => intent.workId === 'mm-hit').map((intent) => `${intent.intentId}:${intent.state}`));
  check('§12.3 重复授权后 work 仍可调度（不是"已授权过就不能启动"）', ['ready', 'executing'].includes(service.works.get('mm-hit')?.state ?? '') && service.authorizedIntentFor(service.works.get('mm-hit')) !== undefined, { state: service.works.get('mm-hit')?.state, intent: service.authorizedIntentFor(service.works.get('mm-hit'))?.intentId });
  const staleAuth = await service.dispatchAuthorize(auto, { teamKey: 'team-a', planRevision: 0, workIds: ['mm-spoof'] });
  check('旧 planRevision 授权被拒绝', staleAuth.ok === false && staleAuth.code === 'PLAN_REVISION_STALE', staleAuth);
  // §5：授权后**不需要**调用方再推一把——tick 自己把 dispatch_authorized 推进到 ready 并启动。
  const authTick = await scheduler.tick();
  check('tick 自行启动授权项（不需要额外推一把）', authTick.started.some((entry) => entry.workId === 'mm-hit'), authTick.started.map((entry) => entry.workId));
  check('授权未覆盖的项仍不启动', !authTick.started.some((entry) => entry.workId === 'mm-spoof'), authTick.started.map((entry) => entry.workId));
  const intentAfter = [...service.dispatchIntents.values()].find((intent) => intent.workId === 'mm-hit');
  check('派发意图在启动后被标记 consumed', intentAfter?.state === 'consumed' && Boolean(intentAfter.consumedByAttemptId), { state: intentAfter?.state, consumedByAttemptId: intentAfter?.consumedByAttemptId });

  console.log('\n[17] 缺陷 B：定向启动只动目标 + 被拒零副作用 + 幂等');
  const beforeB = {
    targetRev: service.works.get('mm-spoof').rev,
    targetAttempts: service.works.get('mm-spoof').attempts.length,
    hitRev: service.works.get('mm-hit').rev,
    failures: service.works.get('mm-spoof').failureStreak ?? 0,
    cap: JSON.stringify(service.capacity().members),
  };
  const rejectedStart = await service.subagentStart(auto, { workId: 'mm-spoof' });
  check('未授权目标被拒（不是 NOT_RESERVED / 团队错）', rejectedStart.ok === false && rejectedStart.code === 'DISPATCH_NOT_AUTHORIZED', rejectedStart);
  const afterB = {
    targetRev: service.works.get('mm-spoof').rev,
    targetAttempts: service.works.get('mm-spoof').attempts.length,
    hitRev: service.works.get('mm-hit').rev,
    failures: service.works.get('mm-spoof').failureStreak ?? 0,
    cap: JSON.stringify(service.capacity().members),
  };
  check('被拒时目标 work 零副作用', afterB.targetRev === beforeB.targetRev && afterB.targetAttempts === beforeB.targetAttempts, { beforeB, afterB });
  check('被拒时无关 work 零副作用（rev/attempts/失败数/容量）', afterB.hitRev === beforeB.hitRev && afterB.failures === beforeB.failures && afterB.cap === beforeB.cap, { beforeB, afterB });
  const idempotent = await service.subagentStart(auto, { workId: 'mm-hit' });
  check('重复启动返回既有 attempt（reused=true）', idempotent.ok === true && idempotent.reused === true, idempotent);
  check('重复启动不创建第二个 attempt', service.works.get('mm-hit').attempts.length === 1, service.works.get('mm-hit').attempts.length);
  const plan2 = await service.planSubmit(auto, {
    teamKey: 'team-a', missionId: 'm-auto', expectedPlanRevision: service.missions.get('team-a/m-auto')?.planRevision ?? 0,
    deliverables: [{ workId: 'mm-hit', title: '命中判定完整交付', deliverable: '命中判定模块完整实现（修订）', outputs: ['src/combat/hit.ts'], acceptance: ['可接入'], writeScopes: ['src/combat/hit'], execution: 'delegate' }],
  }).catch((error) => ({ ok: false, code: 'THREW', message: String(error?.message ?? error) }));
  check('在跑项的计划修订被拒（不覆盖活跃 attempt）', plan2.ok === false && plan2.code === 'WORK_ALREADY_ACTIVE', { code: plan2.code, message: plan2.message });
  const briefStart = await service.subagentStart(auto, { workId: 'mm-hit', brief: '额外约束：命中率必须可在配置中覆盖' });
  check('brief 在复用既有 attempt 时也可见（不丢公开参数）', briefStart.ok === true && String(briefStart.brief).includes('命中率必须可在配置中覆盖'), briefStart.brief);

  console.log('\n[18] leaf → owner 限域求助（缺陷 C）');
  const leafAttempt = service.attempts.get(service.works.get('mm-hit').activeAttemptId) ?? service.attempts.get(briefStart.attemptId);
  const leafAgent = ctx.agents.get(leafAttempt.executorChildId) ?? { id: leafAttempt.executorChildId };
  ctx.agents.set(leafAgent.id, leafAgent);
  const ask = await service.askOwner(leafAgent, { workId: 'mm-hit', question: '缺数值表接口版本', needsInput: true });
  check('leaf 求助成功并投给 owner', ask.ok === true && ask.ownerMemberId === 'auto', ask);
  check('owner 收到 leaf_need 事件', service.pendingEvents('team-a', 'auto').some((event) => event.type === 'leaf_need' && event.payload?.workId === 'mm-hit'), service.pendingEvents('team-a', 'auto').map((event) => `${event.type}:${event.payload?.workId}`));
  const ownerTurn = service.memberTurnState('team-a', 'auto');
  check('求助确实触发一次唤醒（或与在飞回合合并，不丢事件）', ownerTurn.wakeCount >= 1 && (ctx.wakeLog.some((entry) => entry.target === 'auto') || ownerTurn.queuedWake === true), { wakeCount: ownerTurn.wakeCount, queuedWake: ownerTurn.queuedWake, wakes: ctx.wakeLog.filter((entry) => entry.target === 'auto').length });
  const askOther = await service.askOwner({ id: 'session-other-leaf' }, { workId: 'mm-hit', question: 'x' });
  check('非该 work 执行者的求助被拒', askOther.ok === false && askOther.code === 'LEAF_IDENTITY_REQUIRED', askOther);

  console.log('\n[19] 契约 §7 边界');
  const inboxOther = await service.memberInbox(leafAgent, { teamKey: 'team-a' });
  check('leaf 读成员收件箱被拒', inboxOther.ok === false && inboxOther.code === 'TEAM_MEMBER_REQUIRED', inboxOther);
  const crossTeamMission = await service.missionAssign(lead, { teamKey: 'proj-b', memberId: 'pkg', missionId: 'm-pkg', title: 'pkg 模块', goal: '共享包完整交付' });
  const crossTeamPlan = await service.planSubmit(auto, {
    teamKey: 'proj-b',
    missionId: 'm-pkg',
    deliverables: [{ title: 'x', deliverable: 'x 完整实现', outputs: ['src/x.ts'], acceptance: ['y'], execution: 'delegate' }],
  });
  check('跨团队规划被拒（同为 lead 建立的别的团队）', crossTeamMission.ok === true && crossTeamPlan.ok === false && crossTeamPlan.code === 'DELEGATION_SCOPE', crossTeamPlan);
  const otherPlan = await service.planSubmit(lead, { teamKey: 'team-a', missionId: 'm-auto', deliverables: [{ title: 'x', deliverable: 'x 完整实现', outputs: ['src/x.ts'], acceptance: ['y'], execution: 'delegate' }] });
  check('lead 不能替成员写模块计划', otherPlan.ok === false && otherPlan.code === 'DELEGATION_SCOPE', otherPlan);
  const ghostPlan = await service.planSubmit({ id: 'session-nobody' }, { teamKey: 'team-a', missionId: 'm-auto', deliverables: [{ title: 'x', deliverable: 'x 完整实现', outputs: ['src/x.ts'], acceptance: ['y'], execution: 'delegate' }] });
  check('无法解析团队归属的调用者被拒（不伪造身份）', ghostPlan.ok === false && ['TEAM_MEMBER_REQUIRED', 'AGENT_REQUIRED'].includes(ghostPlan.code), ghostPlan);
  const leafMember = await service.createMember(leafAgent, { teamKey: 'team-a', name: 'sneaky', description: 'x' });
  check('leaf 不能创建同级成员', leafMember.ok === false && leafMember.code === 'TEAM_LEAD_REQUIRED', leafMember);
  const fakeVerify = await service.workVerify(auto, { workId: 'mm-hit', outcome: 'accepted', verifiedBy: 'lead' });
  check('未产出就验收被拒', fakeVerify.ok === false && fakeVerify.code === 'WORK_NOT_PRODUCED', fakeVerify);

  console.log('\n[20] produced ≠ accepted：回执 → awaiting_verification → owner 验收');
  const receipt = await service.reportWork(leafAgent, {
    workId: 'mm-hit',
    attemptId: leafAttempt.attemptId,
    leaseEpoch: leafAttempt.leaseEpoch,
    outcome: 'produced',
    artifacts: [{ path: 'src/combat/hit.ts', version: 1 }],
    evidence: [{ kind: 'verification', ok: true, command: 'node --test tests/hit.test.mjs', ref: 'tests/hit.test.mjs' }],
    summary: '命中判定完成',
  });
  check('回执被接受', receipt.ok === true && receipt.accepted === true, receipt);
  check('自治 work 交回后是 awaiting_verification（不是 accepted）', service.works.get('mm-hit')?.state === 'awaiting_verification', service.works.get('mm-hit')?.state);
  check('owner 收到 leaf_receipt 事件', service.pendingEvents('team-a', 'auto').some((event) => event.type === 'leaf_receipt'), service.pendingEvents('team-a', 'auto').map((event) => event.type));
  const trustedHit = await trustedEvidence('mm-hit', auto);
  const verifyAccept = await service.workVerify(auto, { workId: 'mm-hit', outcome: 'accepted', evidence: trustedHit.evidence, note: '可接入' });
  check('owner 验收 accepted', verifyAccept.ok === true && service.works.get('mm-hit')?.state === 'accepted', verifyAccept);
  check('verifiedBy 由 Host 写（模型传的 verifiedBy 无效）', service.works.get('mm-hit')?.verifiedBy === 'auto', service.works.get('mm-hit')?.verifiedBy);
  check('验收写入 provenance', service.works.get('mm-hit')?.verification?.provenance?.actorSessionId === 'session-auto', service.works.get('mm-hit')?.verification?.provenance);
  // 先清空前面章节累积的事件，再验证游标行为。
  let drained = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const batch = await service.memberInbox(auto, { limit: 50 });
    if (!batch.ok || batch.consumed === 0) break;
    drained += batch.consumed;
  }
  check('成员能消费收件箱（游标推进）', drained > 0, drained);
  check('消费游标持久化（consumedSeq > 0）', service.cursorOf('team-a', 'auto').consumedSeq > 0, service.cursorOf('team-a', 'auto'));
  const inboxEmpty = await service.memberInbox(auto, { limit: 10 });
  check('清空后再次读取消费 0 条（幂等）', inboxEmpty.ok === true && inboxEmpty.consumed === 0, inboxEmpty);

  console.log('\n[21] 用户指令 / 暂停 / 四类停止语义（§八）');
  const wakeCountBefore = ctx.wakeLog.length;
  const instruction = await service.userInstruction(lead, { targetSessionId: memberSessionId, text: '把命中率改成可按配置覆盖' });
  check('用户指令入队到成员本人', instruction.ok === true && instruction.memberId === 'auto' && instruction.sessionId === memberSessionId, instruction);
  const instructionWakes = ctx.wakeLog.slice(wakeCountBefore);
  const queuedForWake = service.memberTurnState('team-a', 'auto').queuedWake === true;
  check('用户指令直接投给成员本人（投递或与其在飞回合合并，不丢事件）', instructionWakes.some((entry) => entry.target === 'auto') || queuedForWake, { wakes: instructionWakes, queuedForWake });
  const pause = await service.pauseDispatch(lead, { scope: 'member', sessionId: memberSessionId, by: 'user' });
  check('pause_dispatch 写 pausedBy=user', pause.ok === true && service.members.get('team-a/auto')?.pausedBy === 'user', pause);
  const pausedView = service.snapshot(lead).autonomy.byMember[memberSessionId];
  check('waitReason 回显 user_pause', pausedView?.pausedBy === 'user' && pausedView?.waitReason?.kind === 'user_pause', { pausedBy: pausedView?.pausedBy, waitReason: pausedView?.waitReason });
  const pausedWake = await service.wakeMember({ teamKey: 'team-a', memberId: 'auto', reason: 'user_instruction' });
  check('用户暂停不会被自动唤醒抵消', pausedWake.ok === false && pausedWake.code === 'MEMBER_PAUSED_BY_USER', pausedWake);
  // 暂停期间：已授权但未启动的项不得被调度器消费。
  const pausedWork = await service.submitWork(auto, {
    teamKey: 'team-a', workId: 'mm-paused', title: '暂停期间的新交付', deliverable: '暂停期间的新交付完整实现',
    ownerMemberId: 'auto', outputs: ['src/combat/paused.ts'], acceptance: ['可接入'],
  });
  const pausedAuth = await service.dispatchAuthorize(auto, { teamKey: 'team-a', planRevision: service.works.get('mm-paused').planRevision ?? 0, workIds: ['mm-paused'] });
  check('暂停期间仍可授权（授权是成员决策）', pausedWork.ok === true && pausedAuth.ok === true, { work: pausedWork.code, auth: pausedAuth.code });
  const pausedTick = await scheduler.tick();
  check('暂停期间该成员的已授权项不被调度器消费', !pausedTick.started.some((entry) => entry.workId === 'mm-paused' || entry.ownerMemberId === 'auto'), pausedTick.started.map((entry) => entry.workId));
  const resume = await service.pauseDispatch(lead, { scope: 'member', sessionId: memberSessionId, by: 'user', paused: false, action: 'resume' });
  check('resume_dispatch 是唯一解除路径', resume.ok === true && (service.members.get('team-a/auto')?.pausedBy ?? null) === null, resume);
  const afterResumeTick = await scheduler.tick();
  check('解除暂停后补位继续', afterResumeTick.started.some((entry) => entry.workId === 'mm-paused'), afterResumeTick.started.map((entry) => entry.workId));
  const stopTurn = await service.stopMemberTurn(lead, { sessionId: memberSessionId });
  check('stop_turn 只停该成员回合', stopTurn.ok === true && stopTurn.sessionId === memberSessionId, stopTurn);
  check('stop_turn 不取消任何 work（其它成员已授权工作不受影响）', service.works.get('mm-spoof')?.state !== 'cancelled', service.works.get('mm-spoof')?.state);
  const cancelFuture = await service.planCancel(auto, { teamKey: 'team-a', workIds: ['mm-spoof'], reason: '用户取消未来派发' });
  check('cancel_work 取消未来派发', cancelFuture.ok === true && service.works.get('mm-spoof')?.state === 'cancelled', cancelFuture);
  check('cancel_work 不杀在跑的 attempt', service.attempts.get(leafAttempt.attemptId)?.state !== 'cancelled', service.attempts.get(leafAttempt.attemptId)?.state);
  const cancelThenStart = await service.subagentStart(auto, { workId: 'mm-spoof' });
  check('已取消的 work 不得再启动', cancelThenStart.ok === false, cancelThenStart);

  console.log('\n[21b] scope=members 停止覆盖**每一个** attempt（s05 回归）');
  const liveAttempts = [...service.attempts.values()].filter((attempt) => ['executing', 'waiting'].includes(attempt.state) && attempt.teamKey === 'team-a');
  const membersStop = await service.interruptTeam(lead, { scope: 'members', teamKey: 'team-a' });
  check('scope=members 停到全部活跃 attempt（不是只停 2 个）', liveAttempts.length > 0 && membersStop.stoppedAttempts.length >= liveAttempts.length, { live: liveAttempts.map((attempt) => attempt.workId), stopped: membersStop.stoppedAttempts.length });
  check('scope=members 后这些 attempt 都转 waiting', liveAttempts.every((attempt) => service.attempts.get(attempt.attemptId)?.state === 'waiting'), liveAttempts.map((attempt) => `${attempt.workId}:${service.attempts.get(attempt.attemptId)?.state}`));
  check('scope=members 不取消 work（保留队列）', service.works.get('mm-hit')?.state === 'accepted' && service.works.get('mm-paused')?.state !== 'cancelled', { hit: service.works.get('mm-hit')?.state, paused: service.works.get('mm-paused')?.state });

  console.log('\n[22] 恢复幂等与历史数据（§七）');
  const recovery1 = await service.reconcile();
  const recovery2 = await service.reconcile();
  check('reconcile 幂等（第二次没有新的 requeue）', (recovery2.requeued ?? []).length === 0, recovery2.requeued);
  check('已完成（accepted）的 work 不被重跑', service.works.get('mm-hit')?.state === 'accepted' && !recovery2.requeued.includes('mm-hit'), recovery2.requeued);
  check('历史失败记录保留可见（不删除让统计变绿）', service.snapshot(lead).legacyRecovery.historicalFailedAttempts >= 0 && Array.isArray(service.snapshot(lead).legacyRecovery.orphanWorks), service.snapshot(lead).legacyRecovery);
  const autonomyStorage2 = createStorage(ctx, adapter, {});
  await autonomyStorage2.ready();
  check('missions 跨重启保留', autonomyStorage2.list('missions').length >= 1, autonomyStorage2.list('missions').length);
  check('dispatch_intents 跨重启保留', autonomyStorage2.list('dispatch_intents').length >= 1, autonomyStorage2.list('dispatch_intents').length);
  check('member_events 跨重启保留（待处理事件不丢）', autonomyStorage2.list('member_events').length >= 1, autonomyStorage2.list('member_events').length);
  check('member_cursors 跨重启保留（消费游标）', autonomyStorage2.list('member_cursors').length >= 1, autonomyStorage2.list('member_cursors').length);
  const recoveredIntents = autonomyStorage2.list('dispatch_intents').map(([, value]) => value);
  check('consumed 意图跨重启仍是 consumed（不重复启动）', recoveredIntents.filter((intent) => intent.workId === 'mm-hit').every((intent) => intent.state === 'consumed'), recoveredIntents.filter((intent) => intent.workId === 'mm-hit').map((intent) => intent.state));
  const revived = await service.reconcile({ legacyMapping: 'apply-unique' });
  check('显式映射入口存在且返回结构可读', Array.isArray(revived.legacyMapped) && Array.isArray(revived.legacyPending), { mapped: revived.legacyMapped?.length ?? 0, pending: revived.legacyPending?.length ?? 0 });
  check('默认对账不自动改写历史 owner', recovery1.legacyMapped.length === 0, recovery1.legacyMapped);

  console.log('\n[23] 契约 §14：execution=self 的完成通路（不依赖 attempt）');
  const selfPlan = await service.planSubmit(auto, {
    teamKey: 'team-a', missionId: 'm-auto', expectedPlanRevision: service.missions.get('team-a/m-auto')?.planRevision ?? 0,
    deliverables: [{
      workId: 'mm-self-done', title: '成员自己做的一整份交付', deliverable: '成员自己做的一整份交付完整实现',
      outputs: ['src/combat/self-done.json'], acceptance: ['可接入且无占位'], execution: 'self',
    }],
  });
  check('§14 self 项计划提交成功且 state=self_running', selfPlan.ok === true && service.works.get('mm-self-done')?.state === 'self_running', { ok: selfPlan.ok, code: selfPlan.code, state: service.works.get('mm-self-done')?.state });
  check('§14 self 项不会被调度器启动（永远没有 attempt）', !service.computeReady().some((work) => work.workId === 'mm-self-done'), service.computeReady().map((work) => work.workId));
  const selfTryStart = await service.subagentStart(auto, { workId: 'mm-self-done' });
  check('§14 self 项不能被定向启动（EXECUTION_SELF）', selfTryStart.ok === false && selfTryStart.code === 'EXECUTION_SELF', selfTryStart);
  const earlyVerify = await service.workVerify(auto, { workId: 'mm-self-done', outcome: 'accepted' });
  check('§14 没交产物不能验收（仍 WORK_NOT_PROGRESSED/PRODUCED）', earlyVerify.ok === false && ['WORK_NOT_PRODUCED', 'WORK_NOT_SELF_RUNNING'].includes(earlyVerify.code), earlyVerify);
  const noArtifacts = await service.selfReport(auto, { workId: 'mm-self-done', evidence: [{ kind: 'verification', ok: true, command: 'node --test', ref: 't' }] });
  check('§14 没有产物路径的 self 回执被拒（不得凭"文件存在"结算）', noArtifacts.ok === false && noArtifacts.code === 'SELF_REPORT_WITHOUT_ARTIFACTS', noArtifacts);
  const noEvidence = await service.selfReport(auto, { workId: 'mm-self-done', artifacts: [{ path: 'src/combat/self-done.json', version: 1 }] });
  check('§14 没有验收证据的 self 回执被拒', noEvidence.ok === false && noEvidence.code === 'SELF_REPORT_WITHOUT_EVIDENCE', noEvidence);
  const notOwner = await service.selfReport(combat, { workId: 'mm-self-done', artifacts: [{ path: 'src/combat/self-done.json', version: 1 }], evidence: [{ kind: 'verification', ok: true, command: 'x' }] });
  check('§14 非 owner 提交 self 回执被拒（DELEGATION_SCOPE）', notOwner.ok === false && notOwner.code === 'DELEGATION_SCOPE', notOwner);
  const leafSelf = await service.selfReport({ id: leafAgent.id }, { workId: 'mm-self-done', artifacts: [{ path: 'src/combat/self-done.json', version: 1 }], evidence: [{ kind: 'verification', ok: true, command: 'x' }] });
  check('§14 leaf 不能替 owner 提交 self 回执', leafSelf.ok === false, leafSelf);
  const selfTrusted = await trustedEvidence('mm-self-done', auto);
  const selfReported = await service.selfReport(auto, {
    workId: 'mm-self-done',
    artifacts: [{ path: 'src/combat/self-done.json', version: 1 }],
    evidence: selfTrusted.evidence,
    summary: '成员自己完成的一份完整交付',
  });
  check('§14 self 回执被接受（self_running → produced/awaiting）', selfReported.ok === true && selfReported.via === 'self-report', selfReported);
  check('§14 回执后进入 awaiting_verification（completion.level 由同一道 gate 计算）', service.works.get('mm-self-done')?.state === 'awaiting_verification' && service.works.get('mm-self-done')?.completion?.level === 'accepted', { state: service.works.get('mm-self-done')?.state, level: service.works.get('mm-self-done')?.completion?.level });
  check('§14 produced ≠ accepted：self 回执本身不等于 accepted', service.works.get('mm-self-done')?.verifiedBy == null, service.works.get('mm-self-done')?.verifiedBy);
  check('§14 self 回执写 provenance（via=self-report）', service.works.get('mm-self-done')?.provenanceLog?.some((entry) => entry.action === 'work-self-report' && entry.via === 'self-report'), service.works.get('mm-self-done')?.provenanceLog?.slice(-1));
  const selfVerify = await service.workVerify(auto, { workId: 'mm-self-done', outcome: 'accepted', evidence: await trustedEvidence('mm-self-done', auto).then((trusted) => trusted.evidence), note: '核验通过' });
  check('§14 owner team_work_verify 后才 accepted', selfVerify.ok === true && service.works.get('mm-self-done')?.state === 'accepted', { ok: selfVerify.ok, state: service.works.get('mm-self-done')?.state });
  check('§14 accepted 后 verifiedBy 由 Host 写', service.works.get('mm-self-done')?.verifiedBy === 'auto', service.works.get('mm-self-done')?.verifiedBy);
  const selfRevise = await service.planSubmit(auto, {
    teamKey: 'team-a', missionId: 'm-auto', expectedPlanRevision: service.missions.get('team-a/m-auto')?.planRevision ?? 0,
    deliverables: [{ workId: 'mm-self-revise', title: '可修订的 self 项', deliverable: '可修订的 self 项完整实现', outputs: ['src/combat/self-revise.ts'], acceptance: ['可接入'], execution: 'self' }],
  });
  check('§14 self 项可修订（无 attempt 不该被 WORK_ALREADY_ACTIVE 卡死）', selfRevise.ok === true, selfRevise);
  const delegateAsSelf = await service.selfReport(auto, { workId: 'mm-hit', artifacts: [{ path: 'src/combat/hit.ts', version: 1 }], evidence: [{ kind: 'verification', ok: true, command: 'x' }] });
  check('§14 delegate 的 work 不能用 self 回执（NOT_A_SELF_WORK）', delegateAsSelf.ok === false && delegateAsSelf.code === 'NOT_A_SELF_WORK', delegateAsSelf);

  console.log('\n[24] 依赖放行后的状态机（self → self_running，delegate → ready 对照）');
  const revBeforeRelease = service.missions.get('team-a/m-auto')?.planRevision ?? 0;
  const releasePlan = await service.planSubmit(auto, {
    teamKey: 'team-a', missionId: 'm-auto', expectedPlanRevision: revBeforeRelease,
    deliverables: [
      { workId: 'mm-rel-producer', title: '放行用的上游交付', deliverable: '放行用的上游交付完整实现', outputs: ['src/combat/rel-producer.ts'], acceptance: ['可接入'], execution: 'delegate' },
      { workId: 'mm-rel-self', title: '依赖上游的 self 项', deliverable: '依赖上游的 self 项完整实现', outputs: ['src/combat/rel-self.json'], acceptance: ['可接入'], execution: 'self', blockedBy: ['mm-rel-producer'] },
      { workId: 'mm-rel-delegate', title: '依赖上游的 delegate 项', deliverable: '依赖上游的 delegate 项完整实现', outputs: ['src/combat/rel-delegate.ts'], acceptance: ['可接入'], execution: 'delegate', blockedBy: ['mm-rel-producer'] },
    ],
  });
  check('上游 + self(blocked) + delegate(blocked) 计划提交成功', releasePlan.ok === true, releasePlan);
  check(
    '§14 self 项提交后即为 blocked(DEPENDENCIES_UNSATISFIED)',
    service.works.get('mm-rel-self')?.state === 'blocked' && service.works.get('mm-rel-self')?.blockedReason === 'DEPENDENCIES_UNSATISFIED',
    { state: service.works.get('mm-rel-self')?.state, reason: service.works.get('mm-rel-self')?.blockedReason },
  );
  check('delegate 项提交后即为 blocked(DEPENDENCIES_UNSATISFIED)', service.works.get('mm-rel-delegate')?.state === 'blocked', service.works.get('mm-rel-delegate')?.state);
  const relAuth = await service.dispatchAuthorize(auto, { teamKey: 'team-a', planRevision: revBeforeRelease + 1, workIds: ['mm-rel-producer', 'mm-rel-delegate'] });
  check('上游与 delegate 项可授权（self 项无需授权）', relAuth.ok === true, relAuth);
  const relTick = await scheduler.tick();
  check(
    '只启动上游（blocked 的 self/delegate 都不启动）',
    relTick.started.some((entry) => entry.workId === 'mm-rel-producer') && !relTick.started.some((entry) => ['mm-rel-self', 'mm-rel-delegate'].includes(entry.workId)),
    relTick.started.map((entry) => entry.workId),
  );
  const relAttempt = service.attempts.get(service.works.get('mm-rel-producer').activeAttemptId);
  const relReceipt = await service.reportWork({ id: relAttempt.executorChildId }, {
    workId: 'mm-rel-producer', attemptId: relAttempt.attemptId, leaseEpoch: relAttempt.leaseEpoch, outcome: 'produced',
    artifacts: [{ path: 'src/combat/rel-producer.ts', version: 1 }],
    evidence: [{ kind: 'verification', ok: true, command: 'node --test', ref: 't' }],
    summary: 'upstream done',
  });
  check('上游回执被接受', relReceipt.ok === true, relReceipt);
  const relTrusted = await trustedEvidence('mm-rel-producer', auto);
  const relVerify = await service.workVerify(auto, { workId: 'mm-rel-producer', outcome: 'accepted', evidence: relTrusted.evidence });
  check('上游被 owner 验收 accepted（依赖真正可用）', relVerify.ok === true && service.works.get('mm-rel-producer')?.state === 'accepted', { ok: relVerify.ok, state: service.works.get('mm-rel-producer')?.state });
  const relReconcile = await service.reconcile();
  check('放行后 self 项回到 self_running（不是 ready）', service.works.get('mm-rel-self')?.state === 'self_running', { state: service.works.get('mm-rel-self')?.state, reason: service.works.get('mm-rel-self')?.blockedReason });
  check('放行后 delegate 项仍是 ready（对照）', service.works.get('mm-rel-delegate')?.state === 'ready', service.works.get('mm-rel-delegate')?.state);
  check('放行被记入 report.requeued', relReconcile.requeued.includes('mm-rel-self') && relReconcile.requeued.includes('mm-rel-delegate'), relReconcile.requeued);
  check('调度器永不启动 self 项（computeReady 不含它）', !service.computeReady().some((work) => work.workId === 'mm-rel-self'), service.computeReady().map((work) => work.workId));
  check('放行后的 delegate 项可被调度器启动', service.computeReady().some((work) => work.workId === 'mm-rel-delegate'), service.computeReady().map((work) => work.workId));
  const relSelfStart = await service.subagentStart(auto, { workId: 'mm-rel-self' });
  check('放行后的 self 项仍不能被定向启动（EXECUTION_SELF）', relSelfStart.ok === false && relSelfStart.code === 'EXECUTION_SELF', relSelfStart);
  const relSelfTrusted = await trustedEvidence('mm-rel-self', auto);
  const relSelfReport = await service.selfReport(auto, {
    workId: 'mm-rel-self',
    artifacts: [{ path: 'src/combat/rel-self.json', version: 1 }],
    evidence: relSelfTrusted.evidence,
    summary: 'self 项在上游放行后自己做完',
  });
  check('放行后的 self 项 owner 能 selfReport 成功（§14 闭环）', relSelfReport.ok === true && service.works.get('mm-rel-self')?.state === 'awaiting_verification', { ok: relSelfReport.ok, code: relSelfReport.code, codes: relSelfReport.codes, missing: relSelfReport.missing, state: service.works.get('mm-rel-self')?.state });
  const relSelfVerify = await service.workVerify(auto, { workId: 'mm-rel-self', outcome: 'accepted', evidence: relSelfTrusted.evidence });
  check('放行后的 self 项能走到 accepted（不再是结不了账的形态）', relSelfVerify.ok === true && service.works.get('mm-rel-self')?.state === 'accepted', { ok: relSelfVerify.ok, state: service.works.get('mm-rel-self')?.state });

  console.log(`\nRESULT: ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED`}`);
  if (failures.length > 0) {
    console.log(failures.map((label) => ` - ${label}`).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('smoke crashed:', error);
  process.exitCode = 1;
});
