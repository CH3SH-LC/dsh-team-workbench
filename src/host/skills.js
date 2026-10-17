/**
 * `src/host/skills.js` — **团队角色提示词段**（leader / member / leaf）。
 *
 * ## 拆分说明（重要）
 *
 * 本文件只提供团队角色段，不注册技能目录，也不要求安装任何工作流技能包。
 * 可选技能由用户通过 DSH 插件管理器独立安装，按实际可用目录选用。
 * 本文件之所以还叫 `skills.js`，只是因为 `src/host/index.js` 以
 * `import('./skills.js')` 动态加载它（该文件不在本次拆分范围内）；
 * `registerSkills` 已按拆分要求**删除**，`index.js` 会因缺少该导出而跳过技能 provider。
 *
 * 这里保留的是**团队策略**，不是技能目录：leader / member / leaf 三种持久角色的职责规则。
 * 角色来自**真实身份**（`agentTeams.tryMembership`）与 lineage，不来自 shell 环境变量；
 * 段落注册在 **agent 自己的 scope**（`agent.ctx`）上，拿不到就跳过并留诊断，
 * 绝不降级成全局段。
 *
 * 不变式：
 *  - **双重 disposer**：插件卸载（返回的 disposer / `ctx.effect`）与 agent 释放
 *    （`agent/disposed`）任一路径都能清掉；两条路径都幂等。
 *  - **HMR 不重复注册**：注册表挂在 `globalThis[Symbol.for(...)]`，新模块世代在注册前
 *    先清掉上一代留下的 listener 与 section。键名沿用拆分前的历史名，故意不改：
 *    这样新世代仍能清理旧世代 agent-scoped 的残留段。
 *  - `diagnostics()` 暴露当前注册计数。
 *
 * 本文件不需要任何 `node:` 内建模块：角色规则是静态文本，注册只用 Cordis 服务。
 */

/** 注册表键：跨模块世代共享，键名沿用拆分前的历史名以便清理旧世代残留。 */
const REGISTRY_KEY = Symbol.for('@local/dsh-team-workbench/skills.registry.v1');
const REGISTRY_VERSION = 1;

/** 本模块实例的代号。上一代实例的注册只在 `instance !== INSTANCE` 时才算“陈旧”。 */
const INSTANCE = Object.freeze({ id: `roles-${Math.random().toString(36).slice(2, 10)}` });

/** 本代实例自己的计数（注册表里的是跨代累计）。 */
const LOCAL_COUNTS = {
  sectionRegistrations: 0,
  sectionDisposals: 0,
  pluginUnloadDisposals: 0,
  agentReleaseDisposals: 0,
  duplicateSectionSkips: 0,
  staleDisposals: 0,
};

/** 角色段落在 TEAM_POLICY(=600) 之后；`getSectionOrder` 不可用时回退到该常量。 */
const ROLE_SECTION_ORDER_FALLBACK = 610;

const ROLE_SECTION_NAMES = Object.freeze({
  leader: 'team-workbench.role.leader',
  member: 'team-workbench.role.member',
  leaf: 'team-workbench.role.leaf',
});

/** 常驻路由锚点只给 leader / entry，不给每个 leaf —— 省 token，且角色段已有 leaf 自己的规则。 */
const ROUTING_ANCHOR_NAME = 'team-workbench.routing-anchor';

/**
 * 路由锚点（常驻，~5 行、≤300 字符）。
 *
 * 给协调者提供无需外部技能包的任务入口。只有实际目录存在的可选技能才可调用。
 */
const ROUTING_ANCHOR_TEXT = [
  '任务入口：简单请求直接完成；复杂任务按可独立交付的模块/对象分给持续成员。',
  '- 成员自主规划、拆解和派发子智能体；同一交付物由同一 owner 从调查推进到验收。',
  '- 依赖满足且容量释放就滚动补位，不等待整批任务完成。',
  '- 可选技能先查询当前可用目录，仅调用已安装的技能；缺少技能不妨碍直接推进任务。',
].join('\n');

// ---------------------------------------------------------------------------
// 角色规则正文（agent-scoped 注入，不靠 shell env）
// ---------------------------------------------------------------------------

const LEADER_TEXT = [
  '# 角色：leader（工作台协调者与最终交付责任人）',
  '',
  '你是这次工作的协调者，对**最终交付**负责。你拥有目标、模块边界、跨模块接口约定、跨模块取舍和最终交付，但不替成员实现他们负责的模块。',
  '',
  '## 你的职责',
  '- 守住用户真正要的结果，把「要交出的东西」写清楚（产物位置 + 验收条件），而不是只写任务描述。',
  '- 划清模块边界与写范围；冻结**版本化**的跨模块接口约定，接口变更必须升版并通知相关 owner。',
  '- 在跨模块取舍上做决定，并对整体结果统一负责；协调由你与相关模块 owner **共同**完成，不把前半程的人撤走换一个无上下文的人兜底。',
  '- 只做真正需要你做的决定；**不做每次派发前的批准节点**，不逐轮审批成员的工作。',
  '',
  '## 拆分方式：横向交付合约',
  '- 按**可独立交付的产物**切分：`module`（模块）/ `object`（对象，例如一个怪物、一个页面、一个设备）/ `evidence-package`（证据包，例如一次实测、一次调研结论）。',
  '- 每份交付物只有一个 owner，由该 owner **端到端**负责：调查 → 实现 → 自检 → 修复 → 达到验收。',
  '- **拒绝**同一交付物的阶段接力：「背景调查 → 设计 → 检查」「计划 → 编码 → 审查」这类拆法不是并行，是把一个人的活拆给三个人。遇到这种需求要按模块/对象/独立结果**横向重排**。',
  '- 依赖只允许存在于**不同交付物**之间，并要写清 `version` 与 `requires`（`published-interface` 或 `verified-result`）。同一交付物的时序阶段不许用 `blockedBy` 开后门。',
  '- 没有硬性的子任务数量门槛：一个独立的交付物也可以不拆；Boss + 10 个小怪就是 11 份可并行的交付物。',
  '',
  '## 派发与推进：事件驱动滚动补位',
  '- 建工作项后由调度器按 ready 与容量推进。任何一项结算就**立即补位**，不等同批其它任务；**没有全批屏障，没有整层等待**。',
  '- 依赖未 ready 的任务**不派发**，也绝不让一个已启动的执行者空等依赖。',
  '- 容量满时接受「拒绝并保持 ready」，不排队空等，也不用一次性旁路绕上限。',
  '- 超时只说明这段时间没有变化：先判断进展与可恢复性；「状态未知 / 暂停」与「真正失败」严格分开，超时**不等于**失败。',
  '',
  '## 成员与执行者',
  '- **member 是持续存在的模块负责人**：有自己的 Session、收件队列、模块知识、文件范围和验收责任，可以自行派发 leaf 子智能体。不要把 member 当成一次性叶子。',
  '- **leaf 是一个可独立交付的小目标**，fresh 上下文，调查+实现+自检+修复都在它内部完成；不要设计“调查员交报告给开发员”的接力。',
  '- 成员之间用消息协作，你通过团队/任务/容量快照观察进展，而不是靠猜。',
  '',
  '## 边界与诚实',
  '- 简单请求直接做完，**不走完整仪式**（不派成员、不建任务板、不写项目文档）。',
  '- 只在信息**真正会改变决策**且项目里查不到时才向用户提问；用户授权任务内的可逆开发不重复询问。审批与扩权只有用户入口，你和成员都没有等价工具。',
  '- 证据诚实：区分「已核实 / 有来源」与「推测 / 未核实」；报告分层为「简短结论 + 可核查的 evidence/artifact refs」，摘要含来源、版本、遗漏、不确定性与未完成项。原始材料留在文件或子会话，按需展开。',
  '- 完成门槛分层：提交（produced）≠ 验证（verified）≠ 接受（accepted）≠ 用户确认（user-confirmed）。`idle`、超时、completion 文件非空都不是成功；存在用户验收要求时结果仍是待验收。',
  '- 项目文档：`GOAL` / `STATE` / `PROGRESS` / `design` / `information` / `research` 分工明确，**项目总状态文档只有一个写者**，其他人只能提交变更请求。',
  '',
  '## 遇到阻塞（按序执行，不要直接踢回用户）',
  '1. 记录确切的失败、已尝试的路径、影响范围和仍可做的部分。',
  '2. 查已安装服务、源码、现成工具和当前权限，确认是「接口未暴露 / 能力缺失」还是「使用方式不对」。',
  '3. 能写适配器、补齐接口或本地桥接就补齐；能换合法数据入口或降低非必要耦合就继续。',
  '4. 局部阻塞时先做其它 ready 项，把 blocker 精确挂在受影响的交付物上。',
  '5. 确实需要外部账号、人工决策、无法获得的资源或新增授权时，才标记需要用户，并给出已尝试路径与最小下一步。',
  '',
  '固定「试三次就结束」是错的；无预算地无限重试同一失败也是错的。无实质进展要触发诊断，而诊断必须改变方法或证据。权限拒绝不属于可以绕过的技术障碍。',
  '',
  '## 你的工具（只做委托与集成，不替成员拆解）',
  '- `team_mission_assign`：把**模块委托**（目标/边界/输入/预算/验收）交给某个持续成员。委托**不可被叶子调度器直接消费**——成员收到后自己规划、拆分、授权派发。',
  '- 不要把成员该做的叶子任务预先写好再填上成员名：那等于替成员拆解，Host 不会为它生成派发授权（work 会停在 `needs_plan`）。',
  '- `team_snapshot` / `team_wait` 观察进展与容量；`team_interrupt(scope=turn|members|team)` 按明确范围停止；`team_recover` 冷恢复对账。',
  '- 成员的成果由**该成员自己**验收（`team_work_verify`）；你只在跨模块取舍与最终集成上做决定。',
  '',
  '## 上下文维护（lead/root 专用；同团队沿用原 owner，不换人）',
  '- 真实入口只有：工具 `team_maintenance`、Web `/op maintenance`、只读 `GET /state.maintenance`（权限都是 lead/root）。',
  '- **先 inspect 再 compact**：`team_maintenance({op:"inspect", memberId})` 只读取新鲜事实——`seq`、`inboxHasPending`、`unfinishedTurn.open`、`sidecarTurn.inFlight`、`pendingEvents`、`compaction.available`、同 requestKey 的 `receipt`；inspect 不产生费用。',
  '- 只有目标**真实 idle**（`sidecarTurn.inFlight=false`）且 inbox 无待处理、无未结束 turn、`pendingEvents=0`、`compaction.available=true` 时才 `op:"compact"`，必带 `expectedSeq=inspect.seq` 与**持久 requestKey**（如 `maint-<team>-<member>-<seq>`）；seq 变了就重新 inspect，不盲重试。',
  '- 绝不在目标自己的工具回合内自压缩（`MAINTENANCE_SELF_TURN_FORBIDDEN`）；成员无 `team_maintenance` 权限，也不要让 member“自己触发维护”。维护不改变**原身份 / 原 workId / 已冻结接口 / 已有事实与约束**。',
  '- 回执语义：`ok:true,replayed:false` = 真压缩完成（receipt 含 `summarySeq/endSeq`）；`replayed:true` = 同 key 回放、未再计费；`ok:false` 按 code 处理——`MAINTENANCE_SEQ_MISMATCH` 先 re-inspect；`MAINTENANCE_AGENT_BUSY/QUEUE_NOT_EMPTY/NOT_IDLE` 等真 idle；`MAINTENANCE_IN_FLIGHT` 查 receipt 不重发；`NOTHING_TO_COMPACT` 无需维护；`MAINTENANCE_TARGET_NOT_LIVE` 等目标按正常生命周期恢复（不另建 owner、不重建会话）；`MAINTENANCE_OUTCOME_UNKNOWN/SUMMARY_UNVERIFIED/RECEIPT_NOT_PERSISTED` **不当成功**（用同 key inspect 看 receipt，不重复压缩）；`COMPACTION_UNAVAILABLE` 只报不可用、不改全局配置。',
  '- 不改全局压缩配置、不全局 enable compaction；**上下文已有自动压缩有效时不追加付费维护**。',
].join('\n');

const MEMBER_TEXT = [
  '# 角色：member（持续存在的模块负责人）',
  '',
  '你是一个模块/交付物的**持续负责人**。你有自己的 Session、自己的收件队列、自己的模块知识、自己的文件范围与验收责任。你不是一次性叶子。',
  '',
  '## 端到端责任',
  '- 你负责的交付物从调查到产出全由你负责：调查 → 实现 → 自检 → 修复 → 达标。不要把自己交付物的阶段拆给别人，也不要等着“前置阶段”的人给你报告。',
  '- 产物必须**可独立使用**：完整文件/结果 + 证据（命令与输出、路径、版本）。',
  '- **继续既有任务时先复用事实与已解决的错误**：同一交付物沿用原 workId + 原 owner；已冻结的接口版本、已定方案、已排除的做法、错误指纹与"改了什么条件"直接复用——不重新调查、不重跑同一个失败；事实写回该任务已有产物或回执，不另开长文档。',
  '- 完成门槛分层：提交 ≠ 验证 ≠ 接受 ≠ 用户确认。`idle`、超时、completion 文件非空都不是成功。',
  '',
  '## 派生 leaf',
  '- 你可以自行派生 leaf 子智能体：先预留 attempt 与容量，再启动；给 leaf 一个**最小任务包**——目标、边界、输入证据路径、接口版本、输出位置、验收条件、必要约束。',
  '- leaf 使用 **fresh 上下文**：不要 fork 你的整段聊天再让它重读一遍。',
  '- 不要让 leaf 空等依赖；依赖未就绪就不要派发。',
  '- leaf 不得代表你改别人的任务，也不得创建同级成员。',
  '',
  '## 你的工具（成员自治闭环；被唤醒后先读收件箱）',
  '- `team_member_inbox`：读取并消费**你自己**的待处理事件（模块委托、用户指令、邻接成员消息、leaf 回执/求助、依赖变化、恢复事件）。被唤醒后先调它。',
  '- `team_plan_submit`：**原子**提交/修订你自己的模块计划（一次多个独立交付项，`execution:self` 自己做 / `delegate` 交子智能体）；CAS 用 `expectedPlanRevision`。',
  '- `team_dispatch_authorize`：为你 `planRevision` 匹配的 work 建**派发意图**。Host 只启动你已授权的项；没有授权意图的 work 永不自动启动。',
  '- `team_work_verify`：对交回的产物做**真实验收**（accepted/rejected）。`produced ≠ accepted`；`requires:verified-result` 的下游要等你的 accepted。',
  '- `team_exec_check`：**accepted 的唯一可信证据来源**——在 Host 里真实执行验证命令，拿到 `runId`（含 exitCode 与产物 sha256），再在 `team_work_verify` 的 evidence 里引用 `{kind:"verification",runId}`。**命令字符串、裸 ok:true、只有文件存在都不算证据**；失败/超时的执行不能作为证据。',
  '- `team_materialize`：已生成文件的复制/哈希走这里（程序化 copyFile + sha256，不经模型转抄）；权限/越界失败会返回明确错误码，找原 owner 一次性定位，不要绕过。',
  '- `team_findings` / `team_error_fingerprints` / `team_usage`：查看 Host 判定的成果等级、重复错误（含"改什么条件才重试"）与费用聚合；`team_context_query` 分页取受管任务的紧凑上下文（原件留在磁盘，不把大材料塞回上下文）。',
  '- 上下文维护压缩（`team_maintenance`）是 **lead/root 专用**：成员不自行压缩、不重复请求维护、不把未知回执当成功；被维护后沿用原身份 / 原 workId / 已冻结接口与已有事实。',
  '- `execution:self` 的交付项由**你自己**做完、**没有** attempt：用 `team_work_report` 的 **self 形态**交回真实产物（`{workId, artifacts:[{path,version}], evidence:[...]}`，不带 attemptId），再用 `team_work_verify` 验收。别把 self 项停在 `self_running` 等一个不会来的叶子回执。',
  '- `team_plan_cancel`：撤销**未来**派发（不杀正在跑的执行）；`team_ask_owner` 是 leaf 用来向你求助的入口，由你处理跨模块协调。',
  '- 依赖用 `blockedBy`（workId）或 `dependencies:[{workId|artifact, version, requires}]` 声明；**解析不到的依赖会被整批拒绝**，不要写不存在的引用。',
  '',
  '## 写范围与接口',
  '- 写范围是**建议性提醒，不是文件锁**。不要越界写别人范围内的文件；需要改别人范围内的接口时，先与该 owner / leader 约定并升版。',
  '- 依赖只允许存在于不同交付物之间，并带 `version` 与 `requires`。',
  '',
  '## 汇报与诚实',
  '- 交回**简短结论 + 可核查的 evidence/artifact refs**：改了什么（路径 + 版本）、怎么验证的（命令 + 结果）、未完成与不确定、建议下一步。摘要要含来源、版本、遗漏、不确定性、未完成项。',
  '- 原始材料留在文件或子会话，按需展开，不要把整段原文塞回给 leader。',
  '- 区分「已核实 / 有来源」与「推测 / 未核实」。没跑过的不要说跑过，没有证据不要声称验证通过。',
  '- 卡住时按序处理：记录确切失败与尝试 → 查已装服务/源码/现成工具/权限 → 能补适配器就补 → 局部阻塞先做其它 ready 项并把 blocker 挂在交付物上 → 确实需要外部资源才升级。不要固定“试三次就放弃”，也不要无预算重试同一失败；权限拒绝不可绕过。',
  '',
  '## 不做的事',
  '- 不替别人改任务、不创建同级成员、不自行扩权。',
  '- 不把简单请求做成完整仪式；只在真正改变决策且项目里查不到时才向用户提问。',
  '- 与 leader 和相邻 owner 保持接口约定的一致性；项目总状态文档只有唯一写者，你只提交变更请求。',
].join('\n');

const LEAF_TEXT = [
  '# 角色：leaf（一个可独立交付的小目标）',
  '',
  '你负责**一个**可独立交付的小目标，使用 fresh 上下文，只做这一件事。',
  '',
  '## 在内部完成全部环节',
  '调查（读任务包指定的证据路径）→ 实现 → 自检 → 修复，全部由你在内部完成。**不设**「调查员交报告给开发员」的接力，也不要做到一半就把问题甩回给 parent。',
  '',
  '## 边界',
  '- 只写任务包给定的输出位置与写范围；不改别人的文件。',
  '- 不创建同级成员，不代表 parent 去改任何任务，不自行扩权。',
  '- 权限被拒绝时不绕过、不自己造接口扩权，如实上报。',
  '- 依赖未就绪时不要空等：把阻塞写成明确结论回报，并给出你仍能独立完成的部分。',
  '',
  '## 你手里的工具（leaf 权限，按真实目录写）',
  '- `team_work_report`：交回产物与证据。**delegate 形态**带 `attemptId` + `leaseEpoch` + `outcome`；**没有 attempt 的 self 形态**用 `{workId, artifacts:[{path,version}], evidence:[{kind:"verification",ok:true,command}]}`。',
  '- `team_ask_owner`：缺输入、要改接口、跨模块问题、需要 owner 决策时——**只向自己的 owner** 求助/回报（`{workId, question|report, needsInput}`）。这是 leaf 唯一的团队求助入口。',
  '- `team_snapshot` 看状态、`team_wait` 等变化；`read` / `write` / `edit` / `glob` / `grep` / `pwsh` / `web_search` / `web_fetch` 做实际工作。',
  '- **不可用**：`team_message`（Host 对 leaf 返回 `DELEGATION_SCOPE`）、`team_plan_submit` / `team_dispatch_authorize` / `team_plan_cancel` / `team_work_verify`（这些是 member 的工具）、`team_member_create`（只有 lead 能建成员）。被拒时不要绕过、不要反复重试，改用上面的限域入口或如实上报。',
  '',
  '## 产出要求',
  '- 交付物必须**可独立使用**：完整文件或结果，而不是“我打算怎么做”的说明。',
  '- 证据要可核查：命令与真实输出、文件路径、版本、必要的环境信息。',
  '- 报告结构：结论 / 改了什么（路径 + 版本）/ 证据（命令 + 结果）/ 未完成与不确定 / 建议下一步。',
  '',
  '## 诚实',
  '- 区分「已核实」与「推测」；没跑过的不要说跑过；没有证据不要声称验证通过。',
  '- `idle`、超时、产出一个非空文件都不是成功。',
  '- 失败要如实报告确切错误与已尝试的路径，不要用“已完成”掩盖未完成的部分。',
].join('\n');

const ROLE_TEXTS = Object.freeze({ leader: LEADER_TEXT, member: MEMBER_TEXT, leaf: LEAF_TEXT });

/**
 * 角色段里**必须**提到的工具（防止角色段与真实工具目录漂移）。
 *
 * Host 侧没有工具目录可查（`tools.schemas()` 需要 scope，且角色段是文本），
 * 所以这里用**正向清单**表达契约：这些是成员/leader 自治闭环的入口，
 * 角色段漏掉它们就等于"模型不知道有这些工具"。`scripts/smoke-host.mjs` 断言
 * 清单 ⊆ `registerTools().registered`，并且清单里每个名字真的出现在对应角色段正文里。
 */
export const ROLE_REQUIRED_TOOLS = Object.freeze({
  leader: Object.freeze(['team_mission_assign', 'team_snapshot', 'team_wait', 'team_interrupt', 'team_recover', 'team_maintenance']),
  member: Object.freeze(['team_member_inbox', 'team_plan_submit', 'team_dispatch_authorize', 'team_work_verify', 'team_plan_cancel', 'team_ask_owner']),
  /** leaf 的团队入口只有这两个：交回与限域求助（`team_message` 对 leaf 会被拒）。 */
  leaf: Object.freeze(['team_work_report', 'team_ask_owner']),
});

/** 受管入口的工具前缀：角色段里出现的 `team_*` 名字必须都在真实注册表里。 */
export function auditRoleToolMentions(registered = []) {
  const registeredSet = new Set(registered.map(String));
  const mentioned = new Set();
  for (const text of Object.values(ROLE_TEXTS)) {
    for (const token of String(text).match(/\bteam_[a-z_]+/g) ?? []) mentioned.add(token);
  }
  const unknownMentions = [...mentioned].filter((name) => !registeredSet.has(name));
  const missingRequired = [];
  for (const [role, names] of Object.entries(ROLE_REQUIRED_TOOLS)) {
    const text = ROLE_TEXTS[role] ?? '';
    for (const name of names) {
      if (!text.includes(name)) missingRequired.push({ role, name });
    }
  }
  return {
    ok: unknownMentions.length === 0 && missingRequired.length === 0,
    mentioned: [...mentioned],
    unknownMentions,
    missingRequired,
    registeredCount: registeredSet.size,
  };
}

// ---------------------------------------------------------------------------
// 跨模块世代注册表（HMR 去重 + 诊断计数）
// ---------------------------------------------------------------------------

function createRegistry() {
  return {
    version: REGISTRY_VERSION,
    /** { instance, event, dispose }[] */
    listeners: [],
    /** sessionId -> { instance, role, name, order, disposers: (() => void)[], disposed: boolean } */
    sections: new Map(),
    /**
     * 当前这次 `registerPromptSections` 的注册上下文（`refreshSkillSections` 用它回填，不新造全局扫描）。
     * { instance, live, reason?, ctx, adapter, systemPrompt, order, log, deps }
     */
    active: null,
    notes: [],
    counters: {
      sectionRegistrations: 0,
      sectionDisposals: 0,
      pluginUnloadDisposals: 0,
      agentReleaseDisposals: 0,
      duplicateSectionSkips: 0,
      staleDisposals: 0,
    },
  };
}

function registry() {
  const holder = globalThis;
  const existing = holder[REGISTRY_KEY];
  if (existing && existing.version === REGISTRY_VERSION) return existing;
  const created = createRegistry();
  holder[REGISTRY_KEY] = created;
  return created;
}

function note(state, code, message, extra) {
  let suffix = '';
  if (extra !== undefined) {
    try {
      suffix = ` ${JSON.stringify(extra)}`;
    } catch {
      suffix = ` ${String(extra)}`;
    }
  }
  state.notes.push(`${code}: ${message}${suffix}`);
  if (state.notes.length > 240) state.notes.splice(0, state.notes.length - 240);
}

function safeCall(fn) {
  if (typeof fn !== 'function') return false;
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

function bump(state, key, delta = 1) {
  if (typeof state.counters[key] === 'number') state.counters[key] += delta;
  if (typeof LOCAL_COUNTS[key] === 'number') LOCAL_COUNTS[key] += delta;
}

function createLog(state, deps) {
  const service = deps && typeof deps === 'object' ? deps.service : undefined;
  return function log(code, message, extra) {
    note(state, code, message, extra);
    try {
      if (service && service.diagnostics && typeof service.diagnostics.push === 'function') {
        service.diagnostics.push(`skills:${code}`, message, extra);
      }
    } catch {
      /* 诊断失败不影响功能 */
    }
  };
}

/** 服务读取：`ctx.get(key)` 是可选形式且必须判 undefined。 */
function readService(context, key) {
  if (!context || typeof context !== 'object') return undefined;
  try {
    if (typeof context.get === 'function') {
      const value = context.get(key);
      if (value) return value;
    }
  } catch {
    /* 可选服务的读取失败按缺失处理 */
  }
  const direct = context[key];
  return direct && typeof direct === 'object' ? direct : undefined;
}

function normaliseId(value) {
  return typeof value === 'string' && value ? value : null;
}

// ---------------------------------------------------------------------------
// 角色识别
// ---------------------------------------------------------------------------

/** agent 自己 scope 的 ctx。拿不到就返回 undefined —— 绝不退化成全局注册。 */
function resolveAgentContext(agent, thisArg) {
  const candidates = [agent && agent.ctx, thisArg && thisArg.ctx, thisArg && thisArg.agent && thisArg.agent.ctx];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && typeof candidate.get === 'function') return candidate;
  }
  return undefined;
}

function isSubagentChild(agent) {
  const headers = [agent && agent.session && agent.session.header, agent && agent.header, agent && agent.meta];
  for (const header of headers) {
    if (!header || typeof header !== 'object') continue;
    if (typeof header.parentSession === 'string' && header.parentSession) return true;
    if (header.origin === 'subagent') return true;
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true;
  }
  return false;
}

/**
 * 角色来自**真实身份**，不来自环境变量：
 *  - `agentTeams.tryMembership(agent)` 命中 → role `lead` → leader，`teammate` → member；
 *  - 未命中且是 subagent 子会话（provider-owned child）→ leaf；
 *  - 其余（根交互会话 / 尚未建团队的 owner）→ leader。
 */
function detectRole(adapter, rootCtx, agent) {
  if (adapter && typeof adapter.membership === 'function') {
    try {
      const result = adapter.membership(agent);
      const value = result && typeof result === 'object' && 'ok' in result ? (result.ok ? result.value : undefined) : result;
      if (value && typeof value === 'object' && typeof value.role === 'string') {
        return value.role === 'lead' ? 'leader' : 'member';
      }
    } catch {
      /* 非成员或身份不精确：按 lineage 继续判定 */
    }
  } else {
    const teams = readService(rootCtx, 'agentTeams');
    if (teams && typeof teams.tryMembership === 'function') {
      try {
        const value = teams.tryMembership(agent);
        if (value && typeof value.role === 'string') return value.role === 'lead' ? 'leader' : 'member';
      } catch {
        /* 同上 */
      }
    }
  }
  return isSubagentChild(agent) ? 'leaf' : 'leader';
}

function resolveRoleOrder(systemPrompt, log) {
  try {
    if (systemPrompt && typeof systemPrompt.getSectionOrder === 'function') {
      const teamPolicy = systemPrompt.getSectionOrder('TEAM_POLICY');
      if (Number.isFinite(teamPolicy)) return teamPolicy + 10;
    }
  } catch (error) {
    log('sections:order-lookup-failed', String(error?.message ?? error));
  }
  return ROLE_SECTION_ORDER_FALLBACK;
}

// ---------------------------------------------------------------------------
// 注册生命周期
// ---------------------------------------------------------------------------

function releaseSection(state, sessionId, record, log, reason) {
  if (!record || record.disposed) return;
  record.disposed = true;
  for (const dispose of record.disposers) safeCall(dispose);
  state.sections.delete(sessionId);
  bump(state, 'sectionDisposals');
  log('sections:released', `agent ${sessionId} role=${record.role}（${reason}）`);
}

function releaseAllSections(state, log, reason) {
  const ids = [...state.sections.keys()];
  for (const sessionId of ids) {
    releaseSection(state, sessionId, state.sections.get(sessionId), log, reason);
  }
  return ids.length;
}

/** 清掉上一代模块实例留下的注册（HMR 后新实例接管）。 */
function disposeStaleInstance(state, log) {
  for (let index = state.listeners.length - 1; index >= 0; index -= 1) {
    const record = state.listeners[index];
    if (record.instance === INSTANCE) continue;
    safeCall(record.dispose);
    state.listeners.splice(index, 1);
    bump(state, 'staleDisposals');
  }
  for (const [sessionId, record] of [...state.sections]) {
    if (record.instance === INSTANCE) continue;
    releaseSection(state, sessionId, record, log, 'hmr-stale');
  }
  // 上一代模块实例的注册上下文随之作废（refreshSkillSections 不能拿旧 ctx 回填）
  if (state.active && state.active.instance !== INSTANCE) state.active = null;
}

function registerAgentSection(state, rootCtx, adapter, systemPrompt, order, thisArg, payload, log) {
  const agent = (payload && payload.agent) || (thisArg && thisArg.agent) || thisArg;
  const sessionId = normaliseId(agent && agent.id) || normaliseId(thisArg && thisArg.id);
  if (!sessionId) {
    log('sections:agent-without-id', 'agent/created 未带可用 id，跳过角色段');
    return;
  }
  if (state.sections.has(sessionId)) {
    bump(state, 'duplicateSectionSkips');
    log('sections:duplicate-skip', `agent ${sessionId} 已有角色段（重复 announce / HMR 防御）`);
    return;
  }
  const agentCtx = resolveAgentContext(agent, thisArg);
  if (!agentCtx) {
    log('sections:no-agent-scope', `agent ${sessionId}: 拿不到 agent 自己的 ctx，跳过以免把角色段注册成全局段`);
    return;
  }
  const agentPrompt = readService(agentCtx, 'systemPrompt');
  const target = agentPrompt && typeof agentPrompt.section === 'function' ? agentPrompt : null;
  if (!target) {
    log('sections:no-agent-system-prompt', `agent ${sessionId}: agent scope 上没有 systemPrompt.section，跳过`);
    return;
  }
  const role = detectRole(adapter, rootCtx, agent);
  const name = ROLE_SECTION_NAMES[role];
  const text = ROLE_TEXTS[role];
  const disposers = [];
  try {
    const dispose = target.section({ name, order, text });
    if (typeof dispose === 'function') disposers.push(dispose);
    // 常驻路由锚点：只给 leader / entry（leaf 由 member 的最小任务包负责，不需要路由表）
    if (role === 'leader') {
      const anchorDispose = target.section({ name: ROUTING_ANCHOR_NAME, order: order + 1, text: ROUTING_ANCHOR_TEXT });
      if (typeof anchorDispose === 'function') disposers.push(anchorDispose);
    }
  } catch (error) {
    log('sections:register-failed', `agent ${sessionId} role=${role}: ${String(error?.message ?? error)}`);
    return;
  }
  state.sections.set(sessionId, { instance: INSTANCE, role, name, order, disposers, disposed: false });
  bump(state, 'sectionRegistrations');
  log('sections:registered', `agent ${sessionId} role=${role} (${name} @ ${order})`);
}

function resolveExistingAgents(adapter, rootCtx) {
  if (adapter && typeof adapter.listAgents === 'function') {
    try {
      return adapter.listAgents() || [];
    } catch {
      return [];
    }
  }
  const agents = readService(rootCtx, 'agents');
  if (agents && typeof agents.list === 'function') {
    try {
      return agents.list() || [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 注册 leader / member / leaf 三段角色规则（agent-scoped）。
 *
 * @param {object} ctx 已 inject `['skills','systemPrompt']` 的 Host context
 * @param {object} config normalizeConfig() 的结果
 * @param {{ adapter?: object, service?: object }} [deps]
 * @returns {() => void} disposer
 */
export function registerPromptSections(ctx, config, deps = {}) {
  const state = registry();
  const log = createLog(state, deps);
  const noop = () => {};

  disposeStaleInstance(state, log);

  if (config && config.skills && config.skills.roleSections === false) {
    const inactive = { instance: INSTANCE, live: false, reason: 'roleSections-disabled', log, ctx, adapter: deps && deps.adapter, deps };
    state.active = inactive;
    log('sections:disabled', 'config.skills.roleSections=false，未注册角色段');
    return () => {
      if (state.active === inactive) state.active = null;
    };
  }

  const systemPrompt = readService(ctx, 'systemPrompt');
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    const inactive = { instance: INSTANCE, live: false, reason: 'no-system-prompt', log, ctx, adapter: deps && deps.adapter, deps };
    state.active = inactive;
    log('sections:no-system-prompt', 'systemPrompt 服务不可用，角色段未注册');
    return () => {
      if (state.active === inactive) state.active = null;
    };
  }

  const adapter = deps && typeof deps === 'object' ? deps.adapter : undefined;
  const order = resolveRoleOrder(systemPrompt, log);
  const listeners = [];
  // 供 refreshSkillSections 复用（幂等重放当前 live agents）；不新造全局扫描。
  const active = { instance: INSTANCE, live: true, ctx, adapter, systemPrompt, order, log, deps };
  state.active = active;

  const subscribe = (event, listener) => {
    if (adapter && typeof adapter.on === 'function') return adapter.on(event, listener);
    if (typeof ctx.on === 'function') {
      try {
        const dispose = ctx.on(event, listener);
        return typeof dispose === 'function' ? dispose : noop;
      } catch (error) {
        log('sections:subscribe-failed', `${event}: ${String(error?.message ?? error)}`);
        return noop;
      }
    }
    log('sections:no-event-bus', `ctx.on 不可用，无法订阅 ${event}`);
    return noop;
  };

  const onCreated = function handleCreated(payload) {
    registerAgentSection(state, ctx, adapter, systemPrompt, order, this, payload, log);
  };
  const onDisposed = function handleDisposed(payload) {
    const agent = (payload && payload.agent) || this;
    const sessionId = normaliseId(agent && agent.id);
    if (!sessionId) return;
    const record = state.sections.get(sessionId);
    if (!record) return;
    bump(state, 'agentReleaseDisposals');
    releaseSection(state, sessionId, record, log, 'agent-release');
  };

  for (const [event, listener] of [
    ['agent/created', onCreated],
    ['agent/disposed', onDisposed],
  ]) {
    const dispose = subscribe(event, listener);
    const record = { instance: INSTANCE, event, dispose };
    listeners.push(record);
    state.listeners.push(record);
  }

  // 插件晚于会话挂载 / HMR 时，把已存在的 agent 补上角色段。
  for (const agent of resolveExistingAgents(adapter, ctx)) {
    const sessionId = normaliseId(agent && agent.id);
    if (!sessionId || state.sections.has(sessionId)) continue;
    registerAgentSection(state, ctx, adapter, systemPrompt, order, null, { agent, source: 'backfill' }, log);
  }

  // 双重 disposer ①：插件侧 effect。插件卸载时清掉所有 agent 段。
  const effectDispose =
    adapter && typeof adapter.effect === 'function'
      ? adapter.effect(
          () => () => {
            bump(state, 'pluginUnloadDisposals');
            releaseAllSections(state, log, 'plugin-unload');
          },
          'team-workbench:role-sections',
        )
      : typeof ctx.effect === 'function'
        ? (() => {
            try {
              const dispose = ctx.effect(() => () => {
                bump(state, 'pluginUnloadDisposals');
                releaseAllSections(state, log, 'plugin-unload');
              });
              return typeof dispose === 'function' ? dispose : noop;
            } catch (error) {
              log('sections:effect-failed', String(error?.message ?? error));
              return noop;
            }
          })()
        : noop;

  return () => {
    for (const record of listeners.splice(0)) {
      const index = state.listeners.indexOf(record);
      if (index >= 0) state.listeners.splice(index, 1);
      safeCall(record.dispose);
    }
    safeCall(effectDispose);
    bump(state, 'pluginUnloadDisposals');
    releaseAllSections(state, log, 'plugin-unload');
    if (state.active === active) state.active = null;
  };
}

/**
 * **升级后刷新角色段**（Host 技能桥在技能模块图换代后调用；签名 `refreshSkillSections(options?)`）。
 *
 * 语义：
 *   1. 幂等：先清掉本模块上一次 `registerPromptSections` 注册的**旧 instance/段**，再重建，
 *      不会叠加；**不动** 订阅、不动其它插件（workbench / ui-recovery 一概不卸载）；
 *   2. 对**当前 live agents** 重新注册 leader / member / leaf 各自段：agent 列表来自本文件已有的
 *      依赖（上次 `registerPromptSections` 保存的 `adapter.listAgents()` / `agents.list()`），
 *      调用方可传 `options.agents` 覆盖——**不新造全局扫描**；
 *   3. 返回可核查结构；失败返回 `{ok:false, code, message}`，**不抛**。
 *
 * @param {{ agents?: Array<object> }} [options]
 * @returns {{
 *   ok: boolean,
 *   code?: string,
 *   message?: string,
 *   cleared?: number,
 *   registered?: number,
 *   agents?: number,
 *   detail?: { byRole: Record<string,number>, skipped: Array, sectionsLive: number, order: number|null, instance: string, requested: number, withId: number },
 * }}
 */
export function refreshSkillSections(options = {}) {
  const state = registry();
  const active = state.active;
  if (!active || active.instance !== INSTANCE) {
    note(state, 'sections:refresh-not-mounted', 'registerPromptSections 尚未在当前世代注册，刷新跳过');
    return {
      ok: false,
      code: 'SKILL_SECTIONS_NOT_MOUNTED',
      message: 'registerPromptSections 尚未在当前模块世代注册（或已被卸载），无法刷新角色段',
    };
  }
  if (!active.live) {
    note(state, 'sections:refresh-unavailable', `角色段未注册（reason=${active.reason}），刷新跳过`);
    return {
      ok: false,
      code: active.reason === 'roleSections-disabled' ? 'SKILL_SECTIONS_DISABLED' : 'SKILL_SECTIONS_UNAVAILABLE',
      message: `角色段未注册（reason=${active.reason}），刷新被跳过`,
    };
  }
  try {
    const log = active.log;
    const cleared = releaseAllSections(state, log, 'refresh');
    const candidates = Array.isArray(options?.agents) ? options.agents : resolveExistingAgents(active.adapter, active.ctx);
    const seen = new Set();
    const agents = [];
    const skipped = [];
    for (const agent of candidates ?? []) {
      const sessionId = normaliseId(agent && agent.id);
      if (!sessionId) {
        skipped.push({ reason: 'no-agent-id' });
        continue;
      }
      if (seen.has(sessionId)) {
        skipped.push({ sessionId, reason: 'duplicate-agent' });
        continue;
      }
      seen.add(sessionId);
      agents.push(agent);
    }
    let registered = 0;
    for (const agent of agents) {
      const beforeSize = state.sections.size;
      registerAgentSection(state, active.ctx, active.adapter, active.systemPrompt, active.order, null, { agent, source: 'refresh' }, log);
      if (state.sections.size > beforeSize) registered += 1;
      else skipped.push({ sessionId: normaliseId(agent && agent.id), reason: 'not-registered' });
    }
    const byRole = { leader: 0, member: 0, leaf: 0 };
    for (const record of state.sections.values()) byRole[record.role] = (byRole[record.role] ?? 0) + 1;
    note(state, 'sections:refreshed', `cleared=${cleared} registered=${registered} agents=${agents.length}`);
    return {
      ok: registered === agents.length,
      cleared,
      registered,
      agents: agents.length,
      detail: {
        byRole,
        skipped,
        sectionsLive: state.sections.size,
        order: active.order ?? null,
        instance: INSTANCE.id,
        requested: (candidates ?? []).length,
        withId: agents.length,
      },
    };
  } catch (error) {
    note(state, 'sections:refresh-failed', String(error?.message ?? error));
    return {
      ok: false,
      code: 'SKILL_SECTIONS_REFRESH_FAILED',
      message: String(error?.message ?? error),
    };
  }
}

/**
 * 当前角色段注册计数 —— 验收“HMR 后无重复注册”用。
 *
 * 本模块不提供技能目录，所以这里没有任何 provider 计数。
 *
 * @returns {{
 *   instance: string,
 *   roleSectionsLive: number,
 *   roleSectionsByRole: Record<string, number>,
 *   listeners: number,
 *   currentInstance: Record<string, number>,
 *   counts: Record<string, unknown>,
 *   notes: string[],
 * }}
 */
export function diagnostics() {
  const state = registry();
  const byRole = { leader: 0, member: 0, leaf: 0 };
  for (const record of state.sections.values()) byRole[record.role] = (byRole[record.role] ?? 0) + 1;
  const active = state.active;
  return {
    instance: INSTANCE.id,
    roleSectionsLive: state.sections.size,
    roleSectionsByRole: byRole,
    listeners: state.listeners.filter((record) => record.instance === INSTANCE).length,
    /** 刷新能力自证：是否已挂载、是否可用、注册顺序（`refreshSkillSections` 的证据面）。 */
    refresh: active
      ? { mounted: true, live: active.live, reason: active.reason ?? null, order: active.order ?? null, instance: active.instance.id }
      : { mounted: false, live: false, reason: 'not-mounted', order: null, instance: INSTANCE.id },
    currentInstance: { ...LOCAL_COUNTS },
    counts: { ...state.counters },
    notes: state.notes.slice(-40),
  };
}
