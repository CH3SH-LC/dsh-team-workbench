/**
 * `policy.js` — 横向拆分语义检查与完成门槛。
 *
 * 这里的目标不是关键词黑名单，而是回答两个业务问题：
 *   1. 这个工作项的交付物是不是“可以独立使用的结果”，还是同一交付物的一个时序阶段？
 *   2. 一组工作项之间，是被真正不同的交付物分开的，还是把同一个交付物的
 *      调查→设计→实现→检查拆给了不同人？
 *
 * 关键词只用来**收集证据**，最终判定看结构：subject 是否相同、输出物是否被下游当作输入、
 * 是否只有中间产物、是否有独立验收。
 *
 * 完成门槛区分 six 个层级；`idle`、超时、非空 completion 文件都不是成功。
 */
import { containsAny, countHits, scopeConflict, sha256Hex, toStringArray } from './util.js';

/** 阶段词：出现在“交付物”里但不带独立对象时，说明这是时序阶段而不是完整交付。 */
export const STAGE_LEXICON = Object.freeze({
  research: ['调查', '调研', '背景', '研究', '分析', '勘察', '摸底', '盘点', 'research', 'investigate', 'survey', 'recon', 'background'],
  design: ['设计', '方案', '规划', '策划', '架构设计', 'design', 'blueprint', 'plan', 'roadmap'],
  implement: ['实现', '编码', '开发', '制作', '编写', '落地', 'implement', 'coding', 'code', 'build', 'develop'],
  verify: ['检查', '审查', '评审', '复核', '验收', '测试', '校验', '审计', 'review', 'verify', 'test', 'audit', 'qa', 'inspection'],
  release: ['部署', '发布', '上线', '运维', 'deploy', 'release', 'ship', 'rollout'],
});

/** 对象/模块词：出现时说明工作项指向一个可独立交付的对象或模块。 */
export const OBJECT_LEXICON = Object.freeze([
  '系统', '模块', '组件', '功能', '接口', '类', '函数', '文件', '服务', '页面', '面板',
  '怪物', 'boss', '首领', '角色', '技能', '关卡', '场景', '数值', '道具', '背包', '商店',
  '战斗', '合成', '任务', '地图', '音效', '美术', '资源', '数据集', '资料包',
  'system', 'module', 'component', 'feature', 'interface', 'service', 'page', 'panel',
  'monster', 'character', 'skill', 'level', 'inventory', 'shop', 'combat', 'crafting',
  'dataset', 'artifact', 'package',
]);

/**
 * 中间产物词：只产出这些的输出物不算独立交付，除非同时给出可引用的完整证据包。
 *
 * 注意「设计/方案/规划/架构」既是 `STAGE_LEXICON.design` 的阶段词，也是典型的
 * **中间产物**名（`docs/boss-design.md`、`feature-x-plan.md`）。早先这里漏掉了它们，
 * 导致「Boss 设计方案 + docs/boss-design.md」逃过阶段接力判定。
 */
export const INTERMEDIATE_ARTIFACT_LEXICON = Object.freeze([
  '报告', '纪要', '结论', '方案', '草案', '大纲', '清单', '摘要', '笔记', '设计', '规划', '架构', '白皮书',
  'report', 'summary', 'memo', 'outline', 'draft', 'checklist', 'notes',
  'design', 'plan', 'roadmap', 'blueprint', 'architecture', 'whitepaper', 'proposal',
]);

/** 完成层级，由低到高。 */
export const COMPLETION_LEVELS = Object.freeze(['none', 'produced', 'verified', 'accepted', 'user-confirmed']);

const STAGE_ROLE_ORDER = Object.freeze(['research', 'design', 'implement', 'verify', 'release']);

function textOf(spec) {
  return [
    spec?.title,
    spec?.deliverable,
    spec?.subject,
    spec?.note,
    ...(toStringArray(spec?.outputs)),
    ...(toStringArray(spec?.acceptance)),
  ]
    .filter((part) => typeof part === 'string')
    .join(' \n ');
}

/** 收集证据，不直接判定。 */
export function collectEvidence(spec) {
  const text = textOf(spec);
  const stageHits = {};
  for (const [role, needles] of Object.entries(STAGE_LEXICON)) {
    const hits = countHits(text, needles);
    if (Object.keys(hits).length > 0) stageHits[role] = hits;
  }
  const outputs = toStringArray(spec?.outputs);
  const deliverableText = [spec?.title, spec?.deliverable, spec?.subject].filter((part) => typeof part === 'string').join(' \n ');
  return {
    text,
    stageHits,
    stageRoles: Object.keys(stageHits),
    hasImplementRole: stageHits.implement !== undefined,
    objectHits: countHits(text, OBJECT_LEXICON),
    // 「只产出中间产物」必须同时看 outputs；只要有一个真实产物（代码/资源/数据）就不算。
    intermediateOutputHits: countHits(outputs.join(' \n '), INTERMEDIATE_ARTIFACT_LEXICON),
    // 「这个交付物自身就是一个中间产物」（例如 deliverable = "Boss 设计方案"）。
    intermediateDeliverableHits: countHits(deliverableText, INTERMEDIATE_ARTIFACT_LEXICON),
  };
}

/**
 * 工作项主体：同一个 `partOf` 或同一个去掉阶段词后的交付物描述。
 * relay 检测依赖它把“同一个东西的几个阶段”聚到一起。
 */
export function subjectOf(spec) {
  if (typeof spec?.partOf === 'string' && spec.partOf.trim()) return spec.partOf.trim();
  if (typeof spec?.subject === 'string' && spec.subject.trim()) return spec.subject.trim();
  let text = String(spec?.deliverable ?? spec?.title ?? '').trim();
  for (const needles of Object.values(STAGE_LEXICON)) {
    for (const needle of needles) {
      text = text.split(needle).join('');
    }
  }
  return text.replace(/[\s\-—_/、,，。.:：()（）\[\]]+/g, '').toLowerCase() || sha256Hex(String(spec?.deliverable ?? '')).slice(0, 12);
}

/** `module` | `object` | `evidence-package` | `stage` */
export function classifySplit(spec) {
  const evidence = collectEvidence(spec);
  const declared = typeof spec?.kind === 'string' ? spec.kind : undefined;
  const outputs = toStringArray(spec?.outputs);
  const objectCount = Object.keys(evidence.objectHits).length;
  const stageCount = evidence.stageRoles.length;
  const onlyIntermediateOutputs =
    outputs.length > 0 && outputs.every((output) => containsAny(output, INTERMEDIATE_ARTIFACT_LEXICON));
  const hasRealArtifact = outputs.some((output) => !containsAny(output, INTERMEDIATE_ARTIFACT_LEXICON));
  const deliverableIsIntermediate = Object.keys(evidence.intermediateDeliverableHits).length > 0 && !hasRealArtifact;
  const looksIntermediate = onlyIntermediateOutputs || deliverableIsIntermediate;
  const verdict = (kind) => ({
    kind,
    objectCount,
    stageCount,
    onlyIntermediateOutputs,
    deliverableIsIntermediate,
    hasRealArtifact,
    evidence,
  });

  // 显式声明优先，但仍要结构支撑。
  if (declared === 'evidence-package') return verdict('evidence-package');
  if (declared === 'object' || declared === 'module') return verdict(declared);

  // 结构优先。判定为「时序阶段」需要**正向证据**，不能只因为交付物里出现了一个阶段动词
  // （"X 的完整实现"是合法交付物）：
  //   (1) 交付物/产物都是中间产物（报告/方案/设计/规划/清单/摘要…）且带阶段词；
  //   (2) 一个工作项里同时堆了 ≥2 个阶段角色，且没有任何独立对象词；
  //   (3) 调用方显式声明 kind='stage'。
  // 注意 (1) 必须在 objectCount 之前：`Boss 设计方案` 里的 "Boss" 是对象词，
  // 但这份交付自身就是设计阶段产物，不能被对象词救回来。
  if (declared === 'stage') return verdict('stage');
  if (stageCount > 0 && looksIntermediate) return verdict('stage');
  if (objectCount > 0) {
    const modular = containsAny(evidence.text, ['模块', '系统', 'module', 'system', 'service', '服务']);
    return verdict(modular ? 'module' : 'object');
  }
  if (stageCount >= 2) return verdict('stage');
  return verdict('module');
}

/** 是否是“只做一个时序阶段、把结果交给别人继续”的半成品。 */
export function isStageOnly(spec) {
  const declared = spec?.kind;
  if (declared === 'evidence-package') return false;
  const classified = classifySplit(spec);
  if (classified.kind !== 'stage') return false;
  // 有独立、可引用的完整证据包能力的，允许作为 evidence-package。
  return true;
}

/** 生成可执行的横向重排建议。 */
export function replanHint(spec) {
  const subject = subjectOf(spec) || '该交付物';
  const evidence = collectEvidence(spec);
  const roles = evidence.stageRoles.filter((role) => role !== 'release');
  const parts = [];
  parts.push(`把「${subject}」的完整交付（${roles.length > 0 ? roles.join('→') : '调查、实现、自检'}）交给同一个 owner 一次做完。`);
  parts.push('若要并行，按独立对象/模块切开：例如同一 Boss 拆成 11 个怪物各自完整交付，或按系统（主系统/战斗/背包/商店/合成）各一份贯穿式交付。');
  parts.push('阶段之间只保留真实的不同交付物依赖（接口版本、已验证成果），不要用 depends_on 表达同一交付物的时序。');
  return parts.join('');
}

function failure(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/**
 * P1-7：**机械 LLM 转抄**识别（纯函数）。
 *
 * 禁止的是"已经生成的内容让模型逐字抄一遍"；**开发复制工具/转换算法是合法任务**。
 * 判定只看结构（不靠单一关键词，也不靠换标题绕过）：
 *  - 有**已存在输入文件**（`inputs` 非空）；
 *  - 交付描述是"读取现有内容并原样复现"（逐字/逐字节/照抄/verbatim/reproduce every byte…）；
 *  - 验收**全部**是"与源文件相同/hash 相等"，没有任何行为/测试/转换语义。
 * 任一条件不满足（例如验收要求算法行为、断点恢复、转换正确性）就**不是**机械转抄。
 *
 * @returns {{ mechanical:boolean, code?:string, reason?:string, hint?:object }}
 */
export function detectMechanicalTranscription(spec = {}) {
  const source = spec && typeof spec === 'object' ? spec : {};
  const inputs = toStringArray(source.inputs);
  const outputs = toStringArray(source.outputs);
  if (inputs.length === 0 || outputs.length === 0) return { mechanical: false };
  const acceptance = toStringArray(source.acceptance).map((item) => String(item).toLowerCase());
  if (acceptance.length === 0) return { mechanical: false };
  const text = [source.title, source.deliverable, source.subject, ...acceptance].filter((part) => typeof part === 'string').join('\n').toLowerCase();
  const transcribeIntent = /(逐字|逐字节|逐行原样|原样抄|照抄|抄写|转抄|复刻|重新输入|reproduce every (byte|character|line)|reproduce the (file|content|json)|transcribe|transcription|verbatim|byte[- ]?exact|character[- ]for[- ]character|copy the existing|read the existing|strip line numbers|do not alter)/.test(text);
  if (!transcribeIntent) return { mechanical: false };
  // 验收全部是"与源相同/hash 相等"，没有任何行为/测试/错误处理语义 → 机械转抄。
  const identityOnly = acceptance.every((item) => /(sha-?256|hash|checksum|校验和|逐字节|byte|identical|equals? (the )?source|same as source|与原文件|与源|完全一致)/.test(item));
  const behaviorWords = /(test|assert|reject|convert|transform|resume|recover|interrupt|duplicate|invalid|error|corrupt|behavior|behaviour|survive|preserve|validate|测试|断言|拒绝|转换|恢复|中断|重复|错误|损坏|行为|保留|校验可|识别)/;
  const behaviorFree = !acceptance.some((item) => behaviorWords.test(item));
  if (!identityOnly || !behaviorFree) return { mechanical: false };
  return {
    mechanical: true,
    code: 'MECHANICAL_TRANSCRIPTION',
    reason: '这是对**已经生成内容**的逐字复现（输入已存在、验收仅要求与源文件相同）：不能用模型转抄派发。',
    hint: {
      route: 'team_materialize',
      example: { op: 'copy', from: inputs[0], to: outputs[0] },
      note: 'Host 可以程序化 copyFile + sha256 给出确定性 receipt（零模型调用、幂等）；若确实需要新设计/算法，请把验收改成可测试的行为条件并删除"逐字复现"要求。',
    },
  };
}

/**
 * 单条工作项校验。
 *
 * @param {object} spec
 * @param {{ requireArtifactVersion?: boolean, phaseRelay?: 'reject'|'warn', existingWorks?: object[] }} [options]
 */
export function validateWorkSpec(spec, options = {}) {
  const phaseRelay = options.phaseRelay === 'warn' ? 'warn' : 'reject';
  const requireArtifactVersion = options.requireArtifactVersion !== false;
  const source = spec && typeof spec === 'object' ? spec : {};

  for (const field of ['teamKey', 'title', 'deliverable', 'ownerMemberId']) {
    if (typeof source[field] !== 'string' || !source[field].trim()) {
      return failure('WORK_SPEC_INCOMPLETE', `工作项缺少必填字段 ${field}`, { field });
    }
  }
  const outputs = toStringArray(source.outputs);
  if (outputs.length === 0) {
    return failure('DELIVERABLE_WITHOUT_OUTPUT', '工作项必须声明至少一个真实产物位置（outputs），否则无法判断是否交付。', { field: 'outputs' });
  }
  const acceptance = toStringArray(source.acceptance);
  if (acceptance.length === 0) {
    return failure('DELIVERABLE_WITHOUT_ACCEPTANCE', '工作项必须声明验收条件（acceptance）；「产出非空文件」不算验收。', { field: 'acceptance' });
  }

  if (isStageOnly(source)) {
    if (phaseRelay === 'reject') {
      const classified = classifySplit(source);
      return failure(
        'PHASE_RELAY_SPLIT',
        `「${source.title}」看起来是同一交付物的时序阶段（证据：${classified.stageCount} 个阶段词、${Object.keys(classified.evidence.objectHits).length} 个独立对象词），不是可独立使用的交付物。`,
        { hint: replanHint(source), stageRoles: classified.evidence.stageRoles, field: 'deliverable' },
      );
    }
  }

  const deps = Array.isArray(source.artifactDependencies) ? source.artifactDependencies : [];
  for (const dep of deps) {
    if (!dep || typeof dep !== 'object') return failure('DEPENDENCY_INVALID', 'artifactDependencies 项必须是对象。', { field: 'artifactDependencies' });
    if (requireArtifactVersion) {
      if (!Number.isInteger(dep.version) || dep.version < 1) {
        return failure('DEPENDENCY_WITHOUT_VERSION', `依赖 "${dep.artifact ?? '?'}" 必须声明具体 version（不能只写一个名字）。`, { field: 'artifactDependencies' });
      }
      if (dep.requires !== 'published-interface' && dep.requires !== 'verified-result') {
        return failure('DEPENDENCY_WITHOUT_REQUIREMENT', `依赖 "${dep.artifact ?? '?'}" 必须声明 requires 是 published-interface 还是 verified-result。`, { field: 'artifactDependencies' });
      }
    }
  }

  const writeScopes = toStringArray(source.writeScopes);
  const warnings = [];
  const existing = Array.isArray(options.existingWorks) ? options.existingWorks : [];
  for (const other of existing) {
    if (!other || other.workId === source.workId) continue;
    if (other.state !== 'executing' && other.state !== 'claimed' && other.state !== 'ready') continue;
    const overlap = intersectScopes(writeScopes, toStringArray(other.writeScopes));
    if (overlap.length > 0) {
      warnings.push({
        code: 'WRITE_SCOPE_OVERLAP',
        otherWorkId: other.workId,
        overlap,
        advisoryOnly: true,
        message: `writeScopes 与 ${other.workId} 重叠：${overlap.join(', ')}。writeScopes 只是提醒，不是文件锁；重叠写入需要显式资源锁或集中执行。`,
      });
    }
  }

  return {
    ok: true,
    normalized: normalizeWorkSpec(source, { outputs, acceptance, writeScopes, deps }),
    warnings,
    classified: classifySplit(source),
  };
}

/** 补齐默认值，保证 sidecar 记录形状稳定。 */
export function normalizeWorkSpec(source, prepared) {
  const deps = prepared.deps ?? (Array.isArray(source.artifactDependencies) ? source.artifactDependencies : []);
  return {
    teamKey: String(source.teamKey),
    title: String(source.title).trim(),
    deliverable: String(source.deliverable).trim(),
    subject: subjectOf(source),
    partOf: typeof source.partOf === 'string' && source.partOf.trim() ? source.partOf.trim() : null,
    ownerMemberId: String(source.ownerMemberId).trim(),
    kind: typeof source.kind === 'string' ? source.kind : classifySplit(source).kind,
    splitKind: 'independent-deliverable',
    inputs: toStringArray(source.inputs),
    outputs: prepared.outputs,
    acceptance: prepared.acceptance,
    artifactDependencies: deps.map((dep) => ({
      artifact: String(dep.artifact ?? ''),
      version: Number.isInteger(dep.version) ? dep.version : null,
      requires: dep.requires === 'verified-result' ? 'verified-result' : 'published-interface',
    })),
    writeScopes: prepared.writeScopes,
    contextPolicy: source.contextPolicy === 'fork-parent-context' ? 'fork-parent-context' : 'fresh-with-evidence-references',
    delegationBudget: {
      maxConcurrentLeaves: Number.isInteger(source?.delegationBudget?.maxConcurrentLeaves) ? source.delegationBudget.maxConcurrentLeaves : 2,
      maxAttempts: Number.isInteger(source?.delegationBudget?.maxAttempts) ? source.delegationBudget.maxAttempts : 6,
    },
    priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : 0,
    blockedBy: toStringArray(source.blockedBy),
    /**
     * 契约 §3 修订 / Codex 审阅 E：**可执行验收项**必须在计划里预先声明，
     * `team_exec_check` 只允许执行与这里匹配的命令（不是任意命令执行）。
     * 形如 `[{command:'node', argvPrefix:['--test','tests/…'], acceptanceIndex:0}]`。
     */
    // P1-1：计划期冻结检查身份——checkId（稳定、唯一）+ 覆盖的 acceptanceIndexes + 精确 argv。
    // 兼容旧 argvPrefix：没有 argv 时用 argvPrefix 作为精确前缀并要求 run 精确复现。
    verificationCommands: (Array.isArray(source.verificationCommands) ? source.verificationCommands : [])
      .filter((item) => item && typeof item === 'object' && typeof item.command === 'string' && item.command.trim())
      .map((item) => ({
        command: item.command.trim(),
        argvPrefix: toStringArray(item.argvPrefix).map((value) => String(value)),
        acceptanceIndex: Number.isInteger(item.acceptanceIndex) ? item.acceptanceIndex : null,
        // 冻结检查 ID：显式 checkId 优先，否则稳定派生（同 work 内唯一）。
        checkId: typeof item.checkId === 'string' && item.checkId.trim()
          ? item.checkId.trim()
          : null,
        // 覆盖的验收条件（可多条；缺省回退 acceptanceIndex）。
        acceptanceIndexes: Array.isArray(item.acceptanceIndexes)
          ? item.acceptanceIndexes.filter((value) => Number.isInteger(value))
          : (Number.isInteger(item.acceptanceIndex) ? [item.acceptanceIndex] : []),
        // 精确 argv（服务端冻结；旧 argvPrefix 作为精确前缀，不允许调用者追加 argv 扩大）。
        argv: Array.isArray(item.argv) ? item.argv.map((value) => String(value)) : null,
        note: typeof item.note === 'string' ? item.note.slice(0, 300) : null,
      }))
      .slice(0, 20),
  };
}

/**
 * 图级校验：识别“同一个 subject 被拆成多个阶段”以及“同一交付物内部依赖”。
 *
 * @param {object[]} works
 * @param {{ phaseRelay?: 'reject'|'warn' }} [options]
 */
export function validateWorkGraph(works, options = {}) {
  const phaseRelay = options.phaseRelay === 'warn' ? 'warn' : 'reject';
  const list = (Array.isArray(works) ? works : []).filter(Boolean);
  const violations = [];

  const byId = new Map(list.map((work) => [work.workId, work]));
  const bySubject = new Map();
  for (const work of list) {
    const subject = work.subject ?? subjectOf(work);
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject).push(work);
  }

  for (const [subject, group] of bySubject) {
    if (group.length < 2) continue;
    const roles = new Set();
    for (const work of group) {
      const classified = classifySplit(work);
      for (const role of classified.evidence.stageRoles) roles.add(role);
    }
    const orderedRoles = STAGE_ROLE_ORDER.filter((role) => roles.has(role));
    const chained = group.some((work) =>
      (work.artifactDependencies ?? []).some((dep) => {
        const target = [...byId.values()].find((candidate) => (candidate.outputs ?? []).some((output) => String(output).includes(String(dep.artifact ?? ''))));
        return target && (target.subject ?? subjectOf(target)) === subject;
      }),
    );
    if (orderedRoles.length >= 2 && (chained || group.length >= 3)) {
      violations.push({
        code: 'PHASE_RELAY_GRAPH',
        subject,
        workIds: group.map((work) => work.workId),
        stageRoles: orderedRoles,
        hint: replanHint(group[0]),
        message: `同一交付物「${subject}」被拆成 ${orderedRoles.join('→')} 等阶段并接力（${group.map((w) => w.workId).join(', ')}）。`,
      });
    }
  }

  for (const work of list) {
    for (const dep of work.artifactDependencies ?? []) {
      const producers = list.filter((candidate) =>
        (candidate.outputs ?? []).some((output) => String(output).includes(String(dep.artifact ?? ''))),
      );
      for (const producer of producers) {
        const sameSubject = (producer.subject ?? subjectOf(producer)) === (work.subject ?? subjectOf(work));
        if (sameSubject) {
          violations.push({
            code: 'SAME_DELIVERABLE_DEPENDENCY',
            subject: work.subject ?? subjectOf(work),
            workId: work.workId,
            producerWorkId: producer.workId,
            artifact: dep.artifact,
            hint: replanHint(work),
            message: `${work.workId} 依赖同一交付物 ${producer.workId} 的产物「${dep.artifact}」：这是时序阶段，不是不同交付物之间的依赖。`,
          });
        }
      }
    }
  }

  const accepted = phaseRelay === 'warn';
  return {
    ok: violations.length === 0,
    accepted,
    violations,
  };
}

/**
 * 完成门槛。
 *
 * @param {{ work: object, attempt?: object|null, evidence?: object[], userConfirmed?: boolean }} input
 * @returns {{ level: string, ok: boolean, missing: string[], reasons: string[] }}
 */
export function completionGate(input) {
  const work = input?.work ?? {};
  const attempt = input?.attempt ?? null;
  const evidence = Array.isArray(input?.evidence) ? input.evidence : [];
  const missing = [];
  const reasons = [];

  if (!attempt) {
    return { level: 'none', ok: false, missing: ['no-attempt'], reasons: ['没有执行 attempt，无法判断完成。'] };
  }
  if (attempt.state === 'failed' || attempt.state === 'cancelled') {
    return { level: 'none', ok: false, missing: [], reasons: [`attempt 状态是 ${attempt.state}，不是完成。`] };
  }

  const artifacts = Array.isArray(attempt.artifactRefs) ? attempt.artifactRefs : [];
  if (attempt.state !== 'produced') {
    reasons.push(`attempt.state=${attempt.state}，尚未提交产物。`);
    return { level: 'none', ok: false, missing: ['attempt-not-produced'], reasons };
  }
  if (artifacts.length === 0) {
    missing.push('artifactRefs');
    reasons.push('produced 但没有产物引用；非空文件或 completion.md 存在都不算产物。');
  }

  // 明确排除的伪成功信号。
  const pseudoSignals = [];
  if (attempt.signals?.idle) pseudoSignals.push('idle');
  if (attempt.signals?.timedOut) pseudoSignals.push('timeout');
  if (attempt.signals?.nonEmptyCompletionFile) pseudoSignals.push('non-empty-completion-file');
  if (attempt.signals?.promiseAllBarrierSatisfied) pseudoSignals.push('batch-barrier');
  if (pseudoSignals.length > 0) {
    reasons.push(`忽略伪成功信号：${pseudoSignals.join(', ')}。`);
  }

  if (missing.length > 0 || pseudoSignals.length > 0) {
    return { level: pseudoSignals.length > 0 && missing.length === 0 ? 'none' : 'none', ok: false, missing, reasons };
  }

  let level = 'produced';
  const verifications = evidence.filter((item) => item && item.kind === 'verification');
  // 契约 v4/evidence-gate v2：真实 verification 必须引用 Host runId（不再接受 ok+command 文本）。
  const realVerification = verifications.some((item) => typeof item?.runId === 'string' && item.runId.length > 0);
  if (realVerification) level = 'verified';
  else missing.push('verification-evidence');

  const acceptance = toStringArray(work.acceptance);
  // 验收证据必须绑定已执行检查（checkId/commandRef/postcondition 至少一个）；自由文本/纯 evidenceRef 不算。
  const acceptedEvidence = evidence.filter((item) => item && item.kind === 'acceptance' && Boolean(item.checkId || item.commandRef || item.postcondition));
  if (acceptance.length > 0 && acceptedEvidence.length >= acceptance.length) level = 'accepted';
  else if (acceptance.length > 0) missing.push('acceptance-evidence');

  if (input?.userConfirmed === true) level = 'user-confirmed';

  return {
    level,
    ok: level !== 'none',
    missing,
    reasons,
    pendingUserAcceptance: level !== 'user-confirmed',
  };
}

function intersectScopes(left, right) {
  return scopeConflict(left, right);
}
