/**
 * `tools.js` — 模型工具层（统一 `team_` 前缀）。
 *
 * 命名纪律：官方 `tool-agent-team` 已经占用了
 *   send_message / list_agents / interrupt_agent / spawn_teammate / wait_agent /
 *   team_task_create / team_task_get / team_task_list / team_task_update，
 * 本插件**不重复注册**这些名字，也不整体解禁被官方 profile 关掉的普通 subagent 工具。
 * 需要的能力由本文件用新名字暴露，并调用同一个 Host service 方法。
 *
 * 安全纪律：每个工具都在 Host 侧校验真实 Agent 身份、Team 归属、角色、taskId、
 * attemptId、leaseEpoch 与委托范围。leaf（continuable 子智能体）没有 Team member 身份，
 * 因此不能创建同级成员、不能改别人的任务。审批、扩权、用户决策仍只属于用户入口，
 * 这里**没有**任何模型可调用的越权等价物。
 */
import { withTimeout } from './util.js';

/** 已被官方占用的名字：注册前再挡一层，防止将来改错前缀时静默冲突。 */
export const RESERVED_TOOL_NAMES = Object.freeze([
  'send_message',
  'list_agents',
  'interrupt_agent',
  'spawn_teammate',
  'wait_agent',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  'run_code',
]);

const TEXT_RENDER = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

/**
 * **schema 与运行时限额一致性**（契约 v1 §7 修订 / 整改要求 7）。
 *
 * 真实反例（不归本模块修，只报告）：蒙德 checkpoint 工具的 schema 写的是 400 字符/12 条，
 * 实现却是另一套阈值——模型按 schema 写就被拒，且错误信息无法指出改哪里。
 *
 * 本插件的做法：`parameters` 里**声明**的限额（`maxLength`/`minLength`/`minimum`/`maximum`/
 * `pattern`/`enum`/`required`）由这里在调用入口统一强制执行，错误信息带**精确字段路径**
 * 与"改成什么才合法"，因此 schema 与运行时**不可能**各说一套。
 *
 * 刻意**宽松**的地方（避免破坏既有调用习惯）：
 * - `additionalProperties:false` 只在显式声明时才拦（当前所有 schema 都声明了，但这里对
 *   未知字段只记 `warn` 不回绝——模型多传一个字段不该让整次调用失败）。
 * - 类型不匹配只在字段**显式声明了 type** 且差值明显（对象 vs 字符串等）时回绝。
 */
export const SCHEMA_LIMITS = Object.freeze({
  workId: 200,
  teamKey: 120,
  memberId: 120,
  missionId: 160,
  intentId: 160,
  title: 400,
  note: 4000,
  text: 8000,
  question: 8000,
  report: 8000,
  command: 2000,
  path: 500,
  runId: 200,
  cursor: 120,
  limitMax: 200,
  evidenceItems: 100,
});

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/**
 * 校验参数是否符合声明 schema 中**可执行**的约束。
 * @returns {{ ok:boolean, violations:object[], warnings:object[] }}
 */
export function validateArgs(schema, args) {
  const violations = [];
  const warnings = [];
  const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const walk = (node, value, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.required && Array.isArray(node.required)) {
      for (const key of node.required) {
        const field = value && typeof value === 'object' ? value[key] : undefined;
        if (field === undefined || field === null) {
          violations.push({
            path: `${path}.${key}`,
            code: 'REQUIRED_MISSING',
            message: `缺少必填字段 ${path}.${key}。`,
            hint: `补上 ${key}（见该工具 schema 的 properties.${key} 说明）。`,
          });
        }
      }
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const item = value[key];
      const childPath = `${path}.${key}`;
      if (item === undefined || item === null) continue;
      const declared = child && typeof child === 'object' ? child.type : undefined;
      const actual = typeOf(item);
      const typeOk = !declared
        || declared === actual
        || (declared === 'number' && (actual === 'integer' || actual === 'number'))
        || (declared === 'integer' && actual === 'integer')
        || (declared === 'array' && actual === 'array')
        || (declared === 'object' && actual === 'object');
      if (!typeOk) {
        violations.push({
          path: childPath,
          code: 'TYPE_MISMATCH',
          message: `${childPath} 声明为 ${declared}，实际是 ${actual}。`,
          expected: declared,
          got: actual,
          hint: `把 ${key} 改成 ${declared} 类型（当前值：${JSON.stringify(item).slice(0, 120)}）。`,
        });
        continue;
      }
      if (child.enum && !child.enum.includes(item)) {
        violations.push({
          path: childPath,
          code: 'ENUM_MISMATCH',
          message: `${childPath} 只接受 ${child.enum.join(' / ')}，收到 ${JSON.stringify(item)}。`,
          expected: child.enum,
          got: item,
          hint: `把 ${key} 改成 ${child.enum.join('、')} 之一。`,
        });
      }
      if (typeof item === 'string') {
        if (Number.isInteger(child.maxLength) && item.length > child.maxLength) {
          violations.push({
            path: childPath,
            code: 'MAX_LENGTH_EXCEEDED',
            message: `${childPath} 超过 ${child.maxLength} 字符（当前 ${item.length}）。`,
            expected: `<= ${child.maxLength}`,
            got: item.length,
            hint: `把 ${key} 截短到 ${child.maxLength} 字符以内：把长内容写进文件（用产物路径 + 摘要代替正文）。`,
          });
        }
        if (Number.isInteger(child.minLength) && item.length < child.minLength) {
          violations.push({
            path: childPath,
            code: 'MIN_LENGTH_NOT_MET',
            message: `${childPath} 少于 ${child.minLength} 字符（当前 ${item.length}）。`,
            expected: `>= ${child.minLength}`,
            got: item.length,
            hint: `补充 ${key} 的内容到至少 ${child.minLength} 字符。`,
          });
        }
        if (typeof child.pattern === 'string') {
          let matched = true;
          try {
            matched = new RegExp(child.pattern).test(item);
          } catch {
            matched = true;
          }
          if (!matched) {
            violations.push({
              path: childPath,
              code: 'PATTERN_MISMATCH',
              message: `${childPath} 不匹配 ${child.pattern}。`,
              hint: `让 ${key} 符合正则 ${child.pattern}。`,
            });
          }
        }
      }
      if (typeof item === 'number') {
        if (Number.isFinite(child.minimum) && item < child.minimum) {
          violations.push({ path: childPath, code: 'BELOW_MINIMUM', message: `${childPath} 小于下限 ${child.minimum}（当前 ${item}）。`, defect: 'range', hint: `把 ${key} 提高到 >= ${child.minimum}。` });
        }
        if (Number.isFinite(child.maximum) && item > child.maximum) {
          violations.push({ path: childPath, code: 'ABOVE_MAXIMUM', message: `${childPath} 大于上限 ${child.maximum}（当前 ${item}）。`, hint: `把 ${key} 降到 <= ${child.maximum}。` });
        }
      }
      if (child.type === 'array' && Array.isArray(item)) {
        if (Number.isInteger(child.maxItems) && item.length > child.maxItems) {
          violations.push({ path: childPath, code: 'MAX_ITEMS_EXCEEDED', message: `${childPath} 最多 ${child.maxItems} 项（当前 ${item.length}）。`, hint: `把 ${key} 分批提交，每批 <= ${child.maxItems} 项。` });
        }
        if (child.items) {
          item.forEach((entry, index) => walk(child.items, entry, `${childPath}[${index}]`));
        }
      }
      if (child.type === 'object' && item && typeof item === 'object') walk(child, item, childPath);
    }
    if (node.additionalProperties === false) {
      const known = new Set(Object.keys(node.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) warnings.push({ path: `${path}.${key}`, code: 'UNKNOWN_FIELD', message: `未声明的字段 ${path}.${key}（会被忽略）。` });
      }
    }
  };
  walk(schema, source, 'args');
  return { ok: violations.length === 0, violations, warnings };
}

/** 统一的工具定义构造：输入 schema + 输出 schema + handler。 */
export function defineTool({ name, description, parameters, run }) {
  const schema = parameters ?? { type: 'object', properties: {}, additionalProperties: false };
  return {
    name,
    description,
    parameters: schema,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => TEXT_RENDER(value),
    },
    async execute(args, exec) {
      const source = args && typeof args === 'object' ? args : {};
      // 契约 §7：schema 与运行时限额一致——在**唯一入口**强制执行，错误信息精确到字段。
      const checked = validateArgs(schema, source);
      if (!checked.ok) {
        return {
          ok: false,
          code: 'SCHEMA_VIOLATION',
          message: `参数不符合 ${name} 的 schema：${checked.violations.map((item) => item.code).join(', ')}。`,
          violations: checked.violations,
          hint: checked.violations[0]?.hint ?? '按该工具 schema 修正参数后重试。',
          note: 'schema 与实际执行使用同一套限额（不存在 schema 写一套、实现用另一套）。',
        };
      }
      const result = await run(source, exec);
      if (result !== undefined && checked.warnings.length > 0 && result && typeof result === 'object' && !Array.isArray(result)) {
        return { ...result, schemaWarnings: checked.warnings };
      }
      return result === undefined ? { ok: true } : result;
    },
    isConcurrencySafe: () => false,
  };
}

function failure(code, message, extra) {
  return { ok: false, code, message, ...(extra ?? {}) };
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * 注册全部 `team_*` 工具。返回已注册名字与 disposer 列表（HMR 后可完整撤销）。
 *
 * @param {{ service: object, scheduler: object, adapter: object, config: object }} deps
 */
export function registerTools(deps) {
  const { service, scheduler, adapter, config } = deps;
  const disposers = [];
  const registered = [];
  const skipped = [];

  const base = config.web.basePath;

  const definitions = [
    defineTool({
      name: 'team_snapshot',
      description:
        '读取并行工作台的真实状态：团队、成员、工作项、attempt/lease、三层容量、迟到结果与诊断。不确定当前进度、容量或谁负责什么时先调用它。',
      parameters: objectSchema({ teamKey: { type: 'string', description: '可选，只看这个团队' } }),
      async run(args, exec) {
        const snapshot = service.snapshot(exec?.agent);
        if (args.teamKey) {
          snapshot.teams = snapshot.teams.filter((team) => team.teamKey === args.teamKey);
          snapshot.members = snapshot.members.filter((member) => member.teamKey === args.teamKey);
          snapshot.works = snapshot.works.filter((work) => work.teamKey === args.teamKey);
          snapshot.attempts = snapshot.attempts.filter((attempt) => attempt.teamKey === args.teamKey);
        }
        snapshot.workbench = { basePath: base, scheduler: scheduler?.stats?.() ?? null };
        return { ok: true, snapshot };
      },
    }),

    defineTool({
      name: 'team_define',
      description:
        '把当前会话登记为一个受管团队（只有 Team lead 能做）。登记后 team_work_submit / team_member_create 才能使用。teamKey 省略时取调用者自己的团队 id。',
      parameters: objectSchema(
        {
          teamKey: { type: 'string', description: '团队 key；省略则用调用者所属团队（root session id）' },
          layout: { type: 'string', enum: ['systems', 'domains'], description: 'systems=系统团队（各系统端到端）；domains=领域团队（各领域端到端）' },
          goal: { type: 'string', description: '这次团队要达成的目标' },
        },
        [],
      ),
      async run(args, exec) {
        return service.defineTeam(exec?.agent, args);
      },
    }),

    defineTool({
      name: 'team_member_create',
      description:
        '创建一个持续存在的模块负责人（Team member），它有自己的 Session、任务队列、模块知识与验收责任。只有 Team lead 能调用；member 与 leaf 不能创建同级成员。',
      parameters: objectSchema(
        {
          teamKey: { type: 'string', description: '团队 key；默认取调用者所属团队' },
          name: { type: 'string', description: 'kebab-case 成员名，例如 combat-system' },
          description: { type: 'string', description: '这个成员负责的模块与交付边界' },
          responsibility: { type: 'string', description: '可选，更详细的模块责任说明' },
          writeScopes: { type: 'array', items: { type: 'string' }, description: '该模块的写入范围（提醒，不是文件锁）' },
          context: { type: 'string', enum: ['fresh', 'fork'], description: '默认 fresh；只有确实需要继承父上下文才用 fork' },
          provider: { type: 'string', description: '可选，continuable provider 名；默认自动选择' },
          prompt: { type: 'string', description: '可选，给该成员的初始任务包' },
        },
        ['name', 'description'],
      ),
      async run(args, exec) {
        const subagentList = adapter.listSubagentProviders();
        const result = await service.createMember(exec?.agent, {
          ...args,
          prompt: args.prompt ? [{ type: 'text', text: args.prompt }] : undefined,
        });
        return { ...result, availableSubagentProviders: subagentList.ok ? subagentList.value : null };
      },
    }),

    defineTool({
      name: 'team_work_submit',
      description:
        '提交一个**独立完整交付**的工作项（不是同一交付物的一个阶段）。必须给出真实产物位置与验收条件。阶段接力拆法（背景调查→设计→检查、计划→编码→审查）会被拒绝并返回横向重排建议。',
      parameters: objectSchema(
        {
          teamKey: { type: 'string', description: '团队 key' },
          workId: { type: 'string', description: '可选，稳定 id；重复提交同 id 不产生第二份' },
          title: { type: 'string', description: '工作项标题' },
          deliverable: { type: 'string', description: '这一份独立交付最终要交出的东西' },
          ownerMemberId: { type: 'string', description: '责任人 member 名（不是执行者）' },
          kind: { type: 'string', enum: ['module', 'object', 'evidence-package'], description: '横向切法' },
          partOf: { type: 'string', description: '可选，同一交付物主体名；用于检测阶段接力' },
          inputs: { type: 'array', items: { type: 'string' }, description: '输入/证据路径' },
          outputs: { type: 'array', items: { type: 'string' }, description: '必须真实产出的产物位置' },
          acceptance: { type: 'array', items: { type: 'string' }, description: '验收条件' },
          artifactDependencies: {
            type: 'array',
            description: '不同交付物之间的真实依赖，必须带 version 与 requires',
            items: objectSchema(
              {
                artifact: { type: 'string' },
                version: { type: 'integer' },
                requires: { type: 'string', enum: ['published-interface', 'verified-result'] },
              },
              ['artifact', 'version', 'requires'],
            ),
          },
          writeScopes: { type: 'array', items: { type: 'string' } },
          blockedBy: { type: 'array', items: { type: 'string' }, description: '前置工作项 id' },
          priority: { type: 'number' },
          contextPolicy: { type: 'string', enum: ['fresh-with-evidence-references', 'fork-parent-context'] },
          delegationBudget: objectSchema({ maxConcurrentLeaves: { type: 'integer' }, maxAttempts: { type: 'integer' } }),
        },
        ['title', 'deliverable', 'ownerMemberId', 'outputs', 'acceptance'],
      ),
      async run(args, exec) {
        return service.submitWork(exec?.agent, args);
      },
    }),

    defineTool({
      name: 'team_mission_assign',
      description:
        'leader 把一个**模块委托**（目标、边界、输入、预算、验收条件）交给某个持续成员。委托本身**不可被叶子调度器直接消费**：它只向该成员入队事件并唤醒其自己的模型回合，由成员自己规划、提交独立交付项、授权派发。leader 不能替成员写 work。',
      parameters: objectSchema(
        {
          teamKey: { type: 'string', description: '团队 key；默认取调用者所属团队' },
          memberId: { type: 'string', description: '责任人 member 名（必须是该团队已存在的成员）' },
          missionId: { type: 'string', description: '可选稳定 id；重复提交同 id 不产生第二份委托' },
          title: { type: 'string', description: '模块标题' },
          goal: { type: 'string', description: '模块目标' },
          boundaries: { type: 'array', items: { type: 'string' }, description: '边界（不做什么、不能碰什么）' },
          inputs: { type: 'array', items: { type: 'string' }, description: '输入材料/证据路径' },
          budget: objectSchema({ maxConcurrentLeaves: { type: 'integer' }, maxAttempts: { type: 'integer' } }),
          acceptance: { type: 'array', items: { type: 'string' }, description: '模块验收条件' },
        },
        ['memberId', 'title', 'goal'],
      ),
      async run(args, exec) {
        return service.missionAssign(exec?.agent, { ...args, toolCallId: exec?.callId ?? null });
      },
    }),

    defineTool({
      name: 'team_plan_submit',
      description:
        'member 原子提交/修订**自己模块**的计划：一次给出多个独立交付项（execution=self 自己做／delegate 交子智能体），每项含产物位置与验收条件。planRevision 用 CAS（expectedPlanRevision 不匹配即拒绝）；plannedBy 由 Host 从真实调用上下文写入，模型传的 plannedBy/memberApproved/actorId 一律不作为身份或自治证明。阶段接力拆法整批拒绝。',
      parameters: objectSchema(
        {
          teamKey: { type: 'string', description: '团队 key；默认取调用者所属团队' },
          missionId: { type: 'string', description: '模块委托 id（leader 先 team_mission_assign）' },
          expectedPlanRevision: { type: 'integer', description: '当前计划版本（CAS）；省略按最新版本尝试' },
          deliverables: {
            type: 'array',
            description: '独立交付项（横向切法：每项都是可独立使用的完整成果，不是同一交付物的一个阶段）',
            items: objectSchema(
              {
                workId: { type: 'string', description: '可选稳定 id；带上则修订既有交付项' },
                title: { type: 'string' },
                deliverable: { type: 'string' },
                kind: { type: 'string', enum: ['module', 'object', 'evidence-package'] },
                outputs: { type: 'array', items: { type: 'string' } },
                acceptance: { type: 'array', items: { type: 'string' } },
                writeScopes: { type: 'array', items: { type: 'string' } },
                inputs: { type: 'array', items: { type: 'string' } },
                blockedBy: { type: 'array', items: { type: 'string' } },
                artifactDependencies: {
                  type: 'array',
                  items: objectSchema({ artifact: { type: 'string' }, version: { type: 'integer' }, requires: { type: 'string', enum: ['published-interface', 'verified-result'] } }, ['artifact', 'version', 'requires']),
                },
                delegationBudget: objectSchema({ maxConcurrentLeaves: { type: 'integer' }, maxAttempts: { type: 'integer' } }),
                execution: { type: 'string', enum: ['self', 'delegate'], description: 'self=成员自己做（不产生叶子）；delegate=成员授权给子智能体' },
                verificationCommands: {
                  type: 'array',
                  maxItems: 20,
                  description: '**可执行验收项**（契约 §3/审阅 E）：team_exec_check 只允许执行这里声明的命令；accepted 的证据必须引用它们的真实 run。P1-1：每项在计划期冻结 checkId / 精确 argv / 覆盖的 acceptanceIndexes，执行时写进 run 记录。',
                  items: objectSchema(
                    {
                      // P1-1 公开 schema 必须声明运行时已支持的字段（否则调用方会被 UNKNOWN_FIELD 警告误导）。
                      checkId: { type: 'string', minLength: 1, maxLength: 120, description: '稳定检查身份（计划期冻结；省略时按 command+argv 派生）' },
                      command: { type: 'string', minLength: 1, maxLength: 200, description: '可执行文件名（不经 shell），例如 node / npm / pwsh' },
                      argv: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 500 }, description: '精确参数数组（执行时必须完全相等）' },
                      argvPrefix: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 }, description: '旧式前缀（等价于精确 argv；不建议新用）' },
                      acceptanceIndex: { type: 'integer', minimum: 0, description: '对应单条 acceptance 下标' },
                      acceptanceIndexes: { type: 'array', maxItems: 50, items: { type: 'integer', minimum: 0 }, description: '该集成检查覆盖的多条 acceptance 下标（一次真实执行可证明多项）' },
                      note: { type: 'string', maxLength: 300 },
                    },
                    ['command'],
                  ),
                },
                brief: { type: 'string', description: '给执行者的任务包说明（delegate 项会真的进入 leaf 的 brief）' },
              },
              ['title', 'deliverable', 'outputs', 'acceptance'],
            ),
          },
          note: { type: 'string', description: '简短计划说明（业务摘要，不是思维链）' },
        },
        ['missionId', 'deliverables'],
      ),
      async run(args, exec) {
        return service.planSubmit(exec?.agent, { ...args, toolCallId: exec?.callId ?? null });
      },
    }),

    defineTool({
      name: 'team_dispatch_authorize',
      description:
        'member 为自己 **planRevision 匹配**的 work 建立派发意图（authorized）。Host 调度器只启动有 authorized 意图的 work：没有授权意图的 work 永不自动启动。旧版本授权不得启动已换版的 work。',
      parameters: objectSchema(
        {
          teamKey: { type: 'string', description: '团队 key；默认取调用者所属团队' },
          planRevision: { type: 'integer', description: '计划版本；必须与该 work 的 planRevision 一致' },
          workIds: { type: 'array', items: { type: 'string' }, description: '要授权派发的交付项（必须是自己的 work）' },
          intentId: { type: 'string', description: '可选稳定意图 id（仅单 work 授权时使用）' },
          note: { type: 'string' },
        },
        ['planRevision', 'workIds'],
      ),
      async run(args, exec) {
        const result = await service.dispatchAuthorize(exec?.agent, { ...args, toolCallId: exec?.callId ?? null });
        if (result?.ok) scheduler?.notify('tool:dispatch-authorized', { workIds: args.workIds });
        return result;
      },
    }),

    defineTool({
      name: 'team_work_verify',
      description:
        'owner member 对自己模块的产物做**真实验收**（accepted/rejected）。`produced ≠ accepted`；accepted 必须给出**可复核证据**：`{kind:"verification", runId:"run-…"}`（runId 来自 `team_exec_check` 的真实执行，含 exitCode 与产物 sha256）+ `{kind:"acceptance", acceptanceIndex:0, evidenceRef:0}`（每条验收条件都要映射）。**空证据、裸 ok:true、命令字符串、路径字符串、failed/cancelled 的 attempt 一律拒绝**（EVIDENCE_INSUFFICIENT）；weak 证据（只有文件存在）只能支撑 produced。verifiedBy/verifiedAt 由 Host 从真实调用上下文写入。',
      parameters: objectSchema(
        {
          workId: { type: 'string', maxLength: SCHEMA_LIMITS.workId },
          outcome: { type: 'string', enum: ['accepted', 'rejected'] },
          evidence: {
            type: 'array',
            maxItems: SCHEMA_LIMITS.evidenceItems,
            description: '可核查的验收证据。accepted 至少一条 {kind:"verification",runId}（Host 真实执行记录）与每条验收条件一条 {kind:"acceptance",acceptanceIndex,evidenceRef}。',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['execution', 'verification', 'acceptance', 'diagnostic'] },
                scope: { type: 'string', enum: ['offline', 'batch', 'live'], description: '证据范围：offline=本机 Host 执行；batch=批量验收；live=实机（本 Host 不伪造，需外部捕获记录）' },
                runId: { type: 'string', maxLength: SCHEMA_LIMITS.runId, description: 'Host 记录的真实执行 runId（team_exec_check 返回）；这是 accepted 的必要条件' },
                attemptId: { type: 'string', maxLength: SCHEMA_LIMITS.workId, description: 'execution 证据用：必须是 state=produced 的 attempt' },
                file: { type: 'string', maxLength: SCHEMA_LIMITS.path, description: '产物路径（必须在该 run 的 artifactsAfter 里且 sha256 一致）' },
                command: { type: 'string', maxLength: SCHEMA_LIMITS.command, description: '仅供参考；与 run 实际 argv 不一致会被拒（命令字符串不能替代 runId）' },
                acceptanceIndex: { type: 'integer', minimum: 0, description: '对应 work.acceptance 的下标' },
                acceptanceText: { type: 'string', maxLength: SCHEMA_LIMITS.title },
                evidenceRef: { type: 'integer', minimum: 0, description: '指向同批 evidence 里那条 verification 的下标' },
                postcondition: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['run', 'artifact'] },
                    runId: { type: 'string', maxLength: SCHEMA_LIMITS.runId },
                    path: { type: 'string', maxLength: SCHEMA_LIMITS.path },
                    sha256: { type: 'string', maxLength: 128 },
                  },
                },
                sha256: { type: 'string', maxLength: 128 },
                bytes: { type: 'integer', minimum: 0 },
                ref: { type: 'string', maxLength: SCHEMA_LIMITS.path },
                code: { type: 'string', maxLength: 120 },
                ok: { type: 'boolean' },
                note: { type: 'string', maxLength: SCHEMA_LIMITS.note },
              },
              required: ['kind'],
            },
          },
          note: { type: 'string', maxLength: SCHEMA_LIMITS.note, description: 'rejected 时必须说明缺什么、怎么补' },
        },
        ['workId', 'outcome'],
      ),
      async run(args, exec) {
        return service.workVerify(exec?.agent, args);
      },
    }),

    defineTool({
      name: 'team_exec_check',
      description:
        '在 **Host 进程里真实执行**一条验证命令并记录 runId（证据式验收的唯一可信来源）。命令以 `spawn(argv,{shell:false})` 执行，记录 exitCode / status / 产物 sha256 / 耗时；返回的 runId 要放进 `team_work_verify` 的 evidence。**不经过模型**、不接受 shell 拼接、`scope:"live"` 一律拒绝（不伪造实机证据）。失败/超时的执行不能作为验收证据。',
      parameters: objectSchema(
        {
          workId: { type: 'string', maxLength: SCHEMA_LIMITS.workId, description: '该验证属于哪个 work（run 记录要能追溯到交付物）' },
          command: { type: 'string', minLength: 1, maxLength: SCHEMA_LIMITS.command, description: '可执行文件，例如 node / npm / pwsh；不要带 shell 管道' },
          argv: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 1000 }, description: '参数数组（不经 shell，因此不用引号转义）' },
          cwd: { type: 'string', maxLength: SCHEMA_LIMITS.path, description: '工作目录（必须在允许根内，默认工作区根）' },
          artifacts: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: SCHEMA_LIMITS.path }, description: '执行后必须存在的产物路径（默认取 work.outputs）；会记录前后 sha256' },
          scope: { type: 'string', enum: ['offline', 'batch'], description: 'offline=本机验证；batch=批量验收（只能 Lead 产生）。live 不支持（需外部实机捕获，本 Host 不伪造）' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000 },
          force: { type: 'boolean', description: '受控重跑：必须同时给 forceReason；同一条件最多 2 次（记录审计）' },
          forceReason: { type: 'string', maxLength: SCHEMA_LIMITS.note, description: 'force 的理由（≥8 字符）：说明改了什么条件/为什么这次会不同' },
        },
        ['workId', 'command'],
      ),
      async run(args, exec) {
        const result = await service.runVerification(exec?.agent, args);
        if (result?.ok) scheduler?.notify('tool:exec-checked', { workId: args.workId, runId: result.runId });
        return result;
      },
    }),

    defineTool({
      name: 'team_materialize',
      description:
        '**机械复制/哈希**（零 LLM 转抄）：`op:"copy"` 程序化 copyFile + sha256 校验（幂等，默认不覆盖）；`op:"hash"` 返回文件 sha256/字节；`op:"verify"` 校验 sha256。文件内容不读进模型上下文。目标必须在允许根与该 work 的写范围内，权限失败返回 MATERIALIZE_PERMISSION_DENIED（找原 owner 定位，不要绕过）。',
      parameters: objectSchema(
        {
          op: { type: 'string', enum: ['copy', 'hash', 'verify'] },
          from: { type: 'string', minLength: 1, maxLength: SCHEMA_LIMITS.path, description: '源文件路径' },
          to: { type: 'string', maxLength: SCHEMA_LIMITS.path, description: 'op=copy 的目标路径' },
          workId: { type: 'string', maxLength: SCHEMA_LIMITS.workId, description: '可选：用该 work 的 writeScopes/outputs 作为目标范围授权' },
          overwrite: { type: 'boolean', description: '默认 false：不静默覆盖已有不同内容的文件' },
          expectSha256: { type: 'string', maxLength: 128 },
          scopes: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: SCHEMA_LIMITS.path } },
        },
        ['op', 'from'],
      ),
      async run(args, exec) {
        return service.materialize(exec?.agent, args);
      },
    }),

    defineTool({
      name: 'team_usage',
      description:
        '读取费用/用量**聚合**投影（`snapshot.usage` 同源）：按 team/owner/provider-model 汇总，标出价目版本、未知费用条数、去重/重试/summary 计数。`op:"records"` 时按键分页读取明细（明细不进 /state）。费用是**估算**，与服务商账单分开；价目未配置时一律 unknown（不是 0）。',
      parameters: objectSchema(
        {
          op: { type: 'string', enum: ['summary', 'records', 'pricing'], description: 'summary=聚合；records=明细分页；pricing=当前价目表' },
          teamKey: { type: 'string', maxLength: SCHEMA_LIMITS.teamKey },
          cursor: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: SCHEMA_LIMITS.limitMax },
          provider: { type: 'string', maxLength: 120 },
          model: { type: 'string', maxLength: 120 },
        },
        [],
      ),
      async run(args) {
        if (args.op === 'records') return service.usageRecords({ cursor: args.cursor, limit: args.limit, provider: args.provider, model: args.model });
        if (args.op === 'pricing') return service.usagePricing();
        return { ok: true, usage: service.usageSnapshot({ teamKey: args.teamKey ?? null }) };
      },
    }),

    defineTool({
      name: 'team_findings',
      description:
        '读取**证据式成果投影**（`snapshot.findings` 同源）：verified 只含 Host 能复核的成果（accepted + 通过校验的证据 + 产物版本）；旧 accepted/证据过期出现在 invalidated（owner 历史声明，不改历史）；另有 inProgress/unfinished/rejected 与 lastEffectiveProgress（只来自状态迁移，不把文件字节变化当进展）。',
      parameters: objectSchema(
        { teamKey: { type: 'string', maxLength: SCHEMA_LIMITS.teamKey }, force: { type: 'boolean' } },
        [],
      ),
      async run(args) {
        return { ok: true, findings: service.findingsSnapshot({ teamKey: args.teamKey ?? null, force: args.force === true }) };
      },
    }),

    defineTool({
      name: 'team_error_fingerprints',
      description:
        '读取错误指纹聚合（`snapshot.errorFingerprints` 同源）：同工具+同规范化输入+同版本+同读取 epoch 的确定性失败只记一次，并给出"改什么条件才会重试"。平台不会重复执行同一确定性失败。',
      parameters: objectSchema(
        { teamKey: { type: 'string', maxLength: SCHEMA_LIMITS.teamKey }, limit: { type: 'integer', minimum: 1, maximum: SCHEMA_LIMITS.limitMax } },
        [],
      ),
      async run(args) {
        return { ok: true, errorFingerprints: service.errorFingerprintSnapshot({ teamKey: args.teamKey ?? null, limit: args.limit }) };
      },
    }),

    defineTool({
      name: 'team_context_query',
      description:
        '受管任务的**紧凑上下文分页查询**（只读）：每页只给 work 的指针对（state/missing/产物/依赖/错误码/被否决方法）与事实摘要，原件留在磁盘按需取。默认 limit=10、字符预算 4000；用 nextCursor 续页（稳定，不会因截断重复调查）。不触发模型调用、不改状态、不放大续工额度。',
      parameters: objectSchema(
        {
          teamKey: { type: 'string', maxLength: SCHEMA_LIMITS.teamKey },
          cursor: { type: 'string', maxLength: SCHEMA_LIMITS.cursor, description: '上一页返回的 nextCursor' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          budgetChars: { type: 'integer', minimum: 200, maximum: 200000 },
          includeDetail: { type: 'boolean', description: 'true 时才返回原文摘要（仍受预算限制）' },
        },
        [],
      ),
      async run(args, exec) {
        return service.contextQuery(exec?.agent, args);
      },
    }),

    defineTool({
      name: 'team_plan_cancel',
      description:
        'member 取消**未来**派发（撤销 authorized 意图 / 取消未启动的交付项）。正在跑的 attempt 不受影响（停止在跑的执行请用 team_interrupt）。已取消的意图不得再启动。',
      parameters: objectSchema(
        {
          teamKey: { type: 'string', description: '团队 key；默认取调用者所属团队' },
          workIds: { type: 'array', items: { type: 'string' } },
          intentIds: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string', description: '取消原因（会记入 provenance）' },
        },
        ['reason'],
      ),
      async run(args, exec) {
        const result = await service.planCancel(exec?.agent, { ...args, toolCallId: exec?.callId ?? null });
        if (result?.ok) scheduler?.notify('tool:plan-cancelled', { workIds: args.workIds ?? [] });
        return result;
      },
    }),

    defineTool({
      name: 'team_member_inbox',
      description:
        'member 读取并消费**自己**的待处理事件（模块委托、用户指令、邻接成员消息、leaf 回执/求助、依赖变化、恢复事件）。消费游标持久化，重启后继续；被唤醒后应调用它。',
      parameters: objectSchema(
        { teamKey: { type: 'string' }, limit: { type: 'integer', description: '本次最多读取多少条（默认 20，最大 50）' }, cursor: { type: 'string', description: '可选：上次返回的游标（仅作核对）' } },
        [],
      ),
      async run(args, exec) {
        return service.memberInbox(exec?.agent, args);
      },
    }),

    defineTool({
      name: 'team_ask_owner',
      description:
        'leaf **限域求助/回报**：只能投向自己这个 work 的 owner member（按真实 child session 身份校验），入队并唤醒 owner。缺输入、跨模块接口问题、需要 owner 决策时用它；leaf 不能直接改同级任务，也不能用 team_message。',
      parameters: objectSchema(
        {
          workId: { type: 'string', description: '你正在执行的 workId' },
          question: { type: 'string', description: '要什么、缺什么（相对问题描述）' },
          report: { type: 'string', description: '进度/结论摘要（原始材料留在产物里）' },
          needsInput: { type: 'boolean', description: 'true=阻塞等待 owner 输入；false=只是想回报' },
        },
        ['workId'],
      ),
      async run(args, exec) {
        return service.askOwner(exec?.agent, args);
      },
    }),


    defineTool({
      name: 'team_work_claim',
      description:
        '用乐观并发（expectedRevision）认领一个 ready 工作项。并发认领只允许一个成功；过期 revision 会被拒绝而不是覆盖新状态。',
      parameters: objectSchema(
        {
          workId: { type: 'string' },
          expectedRevision: { type: 'integer', description: '从 team_snapshot 读到的当前 revision；省略则用最新' },
        },
        ['workId'],
      ),
      async run(args, exec) {
        return service.claimWork(exec?.agent, args);
      },
    }),

    defineTool({
      name: 'team_subagent_start',
      description:
        '为**指定的一个**工作项启动 continuable 子智能体执行这一份完整交付（定向原子预留，修缺陷 B）：先校验 team+actor+owner+workId+planRevision+派发授权+readiness，只预留该 work；已有活跃 attempt 或与后台补位竞争时返回既有 attempt（reused=true），不双重创建。容量不足/未授权/被拒时零副作用：无关工作项的 revision、attempt 数、容量与失败计数一律不变。',
      parameters: objectSchema(
        {
          teamKey: { type: 'string' },
          workId: { type: 'string' },
          planRevision: { type: 'integer', description: '可选：要求该 work 的 planRevision 与之匹配（旧调用不得启动已换版的 work）' },
          brief: { type: 'string', description: '可选：owner 追加给执行者的任务包说明（会真的进入 leaf 的 brief）' },
        },
        ['workId'],
      ),
      async run(args, exec) {
        const actor = service.actor(exec?.agent);
        if (!actor.ok) return actor;
        const result = await service.subagentStart(actor, args);
        if (result?.ok && !result.reused) scheduler?.notify('tool:subagent-started', { workId: result.workId, attemptId: result.attemptId });
        return result;
      },
    }),

    defineTool({
      name: 'team_work_report',
      description:
        '提交回执。**delegate 形态**：带 `attemptId`（leaf 启动时拿到）+ 产物路径/版本 + 可核查证据 + 摘要 + 未解决事项；lease 过期或 epoch 不匹配的回执只会被归档，不覆盖新版本。**self 形态**：`execution:self` 的 work 由成员自己的回合完成、永远没有 attempt，owner 用 `{workId, artifacts, evidence}`（不带 attemptId）提交自己的真实产物与验收证据——不得仅凭"文件存在"结算，之后仍要 `team_work_verify` 才算 accepted。idle、超时、非空 completion 文件都不是完成。',
      parameters: objectSchema(
        {
          workId: { type: 'string', description: 'self 形态必填；delegate 形态可省略（从 attemptId 取）' },
          attemptId: { type: 'string', description: 'delegate 形态必填：leaf 启动时拿到的 attemptId' },
          leaseEpoch: { type: 'integer' },
          outcome: { type: 'string', enum: ['produced', 'failed', 'cancelled'], description: 'delegate 回执的结局；self 形态省略（等价 produced）' },
          artifacts: {
            type: 'array',
            items: objectSchema({ path: { type: 'string' }, version: { type: 'integer' }, kind: { type: 'string' } }, ['path']),
          },
          evidence: {
            type: 'array',
            description: '证据项。真实验证要 kind=verification 且 ok=true 并带上 command；逐条验收要 kind=acceptance 且 ok=true。',
            items: objectSchema({ kind: { type: 'string' }, ok: { type: 'boolean' }, ref: { type: 'string' }, command: { type: 'string' }, note: { type: 'string' } }),
          },
          summary: { type: 'string' },
          unresolved: { type: 'array', items: { type: 'string' } },
          userConfirmed: { type: 'boolean', description: '只有用户明确确认过才能为 true' },
          signals: objectSchema({
            idle: { type: 'boolean' },
            timedOut: { type: 'boolean' },
            nonEmptyCompletionFile: { type: 'boolean' },
            promiseAllBarrierSatisfied: { type: 'boolean' },
          }),
          idempotencyKey: { type: 'string' },
        },
        [],
      ),
      async run(args, exec) {
        const result = await service.reportWork(exec?.agent, args);
        if (result?.ok) scheduler?.notify('tool:work-reported', { workId: args.workId, attemptId: args.attemptId, via: result.via ?? 'attempt' });
        return result;
      },
    }),

    defineTool({
      name: 'team_interrupt',
      description:
        '按**明确范围**停止执行：scope=turn 只停该执行者当前模型回合（工作项回到 ready），scope=attempt 停止并释放本次执行，scope=work 显式取消整项，scope=members 停每个成员当前回合但保留队列，scope=team 取消整队。停止 leader 自己的 turn 不会影响成员。',
      parameters: objectSchema(
        {
          scope: { type: 'string', enum: ['turn', 'attempt', 'work', 'members', 'team'] },
          workId: { type: 'string', description: 'scope=turn|attempt|work 时必填' },
          teamKey: { type: 'string', description: 'scope=members|team 时使用' },
        },
        ['scope'],
      ),
      async run(args, exec) {
        const scope = String(args.scope);
        if (scope === 'members' || scope === 'team') {
          const result = await service.interruptTeam(exec?.agent, { scope, teamKey: args.teamKey });
          scheduler?.notify('tool:team-interrupted', { scope });
          return result;
        }
        const result = await service.interruptWork(exec?.agent, { workId: args.workId, scope });
        scheduler?.notify('tool:work-interrupted', { workId: args.workId, scope });
        return result;
      },
    }),

    defineTool({
      name: 'team_message',
      description: '在团队内给另一个成员发一条消息。只有 Team 成员能使用；leaf 通过 team_work_report 交回结果，不能代表 member 发消息。',
      parameters: objectSchema({ target: { type: 'string' }, text: { type: 'string' } }, ['target', 'text']),
      async run(args, exec) {
        const actor = service.actor(exec?.agent);
        if (!actor.ok) return actor;
        if (actor.role !== 'lead' && actor.role !== 'member') {
          return failure('DELEGATION_SCOPE', 'leaf 与普通根会话不能代表 Team 成员发消息；请用 team_work_report 交回结果。');
        }
        const controller = new AbortController();
        const result = await adapter.sendTeamMessage(actor.agent, {
          target: String(args.target),
          content: [{ type: 'text', text: String(args.text) }],
          signal: controller.signal,
        });
        return result.ok ? { ok: true, messageId: String(result.value?.messageId ?? ''), status: result.value?.status ?? 'accepted' } : result;
      },
    }),

    defineTool({
      name: 'team_wait',
      description:
        '等待团队状态发生变化。先登记等待再核对最新 revision，避免检查与订阅之间漏事件；超时只表示这段时间没有变化，不代表任务失败或完成。',
      parameters: objectSchema({ timeoutMs: { type: 'integer' }, cursor: { type: 'string' } }, []),
      async run(args, exec) {
        const cursor = args.cursor ?? fingerprint(service);
        const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 30_000, 1000), 600_000);
        let resolveChange;
        const changed = new Promise((resolve) => {
          resolveChange = resolve;
        });
        const unsubscribe = service.subscribe(() => resolveChange('change'));
        try {
          // 先订阅、后核对：两者之间发生的变化不会丢。
          if (fingerprint(service) !== cursor) {
            return { ok: true, timedOut: false, changed: true, cursor: fingerprint(service), note: '在登记等待前状态已变化。' };
          }
          const outcome = await withTimeout(changed, timeoutMs);
          const current = fingerprint(service);
          return {
            ok: true,
            timedOut: outcome.timedOut === true,
            changed: current !== cursor,
            cursor: current,
            note: outcome.timedOut ? '等待超时：这段时间没有变化；超时不等于任务失败或完成。' : '状态发生变化。',
          };
        } finally {
          unsubscribe();
        }
      },
    }),

    defineTool({
      name: 'team_recover',
      description:
        '重启/冷恢复对账：核对原生会话与 catalog、重建 ready 队列、恢复 parent→child、隔离过期 lease 与迟到结果。不会重跑已完成的任务。',
      parameters: objectSchema({}),
      async run(_args, exec) {
        const actor = service.actor(exec?.agent);
        if (!actor.ok) return actor;
        if (actor.role !== 'lead' && actor.role !== 'member') return failure('TEAM_LEAD_REQUIRED', '只有团队成员能触发对账。');
        const report = await service.reconcile();
        scheduler?.notify('tool:reconciled', report);
        return { ok: true, report };
      },
    }),

    defineTool({
      name: 'team_layout',
      description:
        '读取或修改并行工作台的布局：1/2/4 窗、每窗固定的会话或子智能体、焦点窗。与界面上的操作是同一份 Host 状态。关窗与切布局不会停止任何 Agent。',
      parameters: objectSchema(
        {
          action: { type: 'string', enum: ['get', 'set-mode', 'bind-pane', 'remove-pane', 'focus-pane', 'set-layout'] },
          mode: { type: 'integer', enum: [1, 2, 4] },
          paneId: { type: 'string' },
          sessionId: { type: 'string' },
          parentSessionId: { type: 'string' },
          childSessionId: { type: 'string' },
          targetMode: { type: 'string', enum: ['continuable', 'one-shot'] },
          role: { type: 'string' },
          label: { type: 'string' },
          panes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          activePaneId: { type: 'string' },
        },
        ['action'],
      ),
      async run(args) {
        switch (args.action) {
          case 'get':
            return { ok: true, layout: service.layout() };
          case 'set-mode':
            return service.setLayout(args.mode, {});
          case 'bind-pane':
            return service.upsertPane({
              paneId: args.paneId,
              role: args.role,
              label: args.label,
              target: args.childSessionId
                ? { parentSessionId: args.parentSessionId, childSessionId: args.childSessionId, mode: args.targetMode ?? 'continuable' }
                : { sessionId: args.sessionId },
            });
          case 'remove-pane':
            return service.removePane(String(args.paneId));
          case 'focus-pane':
            return service.focusPane(String(args.paneId));
          case 'set-layout':
            return service.setLayout(args.mode, { panes: args.panes, activePaneId: args.activePaneId });
          default:
            return failure('UNKNOWN_ACTION', `未知 action ${args.action}`);
        }
      },
    }),
    defineTool({
      name: 'team_maintenance',
      description:
        '上下文维护入口（lead/root 专用，可发现、权限明确）：op=inspect 只读检查目标成员的原生 idle/inbox/未结束 turn/seq/compaction 服务可用性；op=compact 在 **expectedSeq 必填 + requestKey 持久 once** 下经目标 agent 的官方 preset 压缩服务执行一次维护压缩（不嵌套 runMaintenance、不在 owner 自己回合压缩、不改全局压缩配置）。',
      parameters: objectSchema(
        {
          op: { type: 'string', enum: ['inspect', 'compact'], description: 'inspect=只读检查；compact=执行一次维护压缩' },
          teamKey: { type: 'string', description: '团队 key；默认取调用者所属团队' },
          memberId: { type: 'string', description: '目标成员 id（与 sessionId 二选一）' },
          sessionId: { type: 'string', description: '目标会话 id（与 memberId 二选一）' },
          expectedSeq: { type: 'integer', minimum: 0, description: 'op=compact 必填：目标 session 当前 seq（CAS，不匹配即拒绝）' },
          requestKey: { type: 'string', minLength: 8, maxLength: 200, description: 'op=compact 必填/建议：稳定幂等键；同 key 成功后只回放原 receipt，不重复压缩' },
          reason: { type: 'string', maxLength: 300, description: '可选：为什么现在做维护（记入诊断）' },
        },
        ['op'],
      ),
      async run(args, exec) {
        if (args.op === 'inspect') return service.maintenanceInspect(exec?.agent, args);
        return service.requestMaintenance(exec?.agent, { ...args, via: 'team_maintenance' });
      },
    }),
  ];

  for (const definition of definitions) {
    if (RESERVED_TOOL_NAMES.includes(definition.name)) {
      skipped.push({ name: definition.name, reason: 'RESERVED_BY_OFFICIAL_TOOL_AGENT_TEAM' });
      continue;
    }
    // 启动 hydration 在插件 apply 的同步段之后异步进行；工具调用先等它完成。
    const gated = {
      ...definition,
      async execute(args, exec) {
        await service.whenReady();
        return definition.execute(args, exec);
      },
    };
    const result = adapter.registerTool(gated);
    if (result.ok && typeof result.value === 'function') {
      disposers.push(result.value);
      registered.push(definition.name);
    } else if (result.ok) {
      registered.push(definition.name);
    } else {
      skipped.push({ name: definition.name, reason: `${result.code}: ${result.message}` });
    }
  }

  return {
    registered,
    skipped,
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

/** 轻量状态指纹，用于 team_wait 的 cursor。 */
function fingerprint(service) {
  const capacity = service.capacity();
  const workStates = [...service.works.values()].map((work) => `${work.workId}:${work.state}:${work.rev}`).sort();
  return [
    `works=${service.works.size}`,
    `attempts=${service.attempts.size}`,
    `leaves=${capacity.activeLeaves}`,
    `resident=${capacity.residentInUse}`,
    `late=${service.lateResults.length}`,
    workStates.join('|'),
  ].join(';');
}
