/**
 * Reference (simulated) implementation of docs/ARCHITECTURE.md；历史检查 2.6 semantics.
 *
 * This exists ONLY so the verification harness can be proven correct before the
 * real `src/host/policy.js` lands. It is a simulation, never a deliverable, and
 * every suite that runs against it is marked `simulated: true`.
 */

export const RELAY_CODES = {
  PHASE_RELAY_REJECTED: 'PHASE_RELAY_REJECTED',
  ARTIFACT_VERSION_REQUIRED: 'ARTIFACT_VERSION_REQUIRED',
  MISSING_DELIVERABLE: 'MISSING_DELIVERABLE',
  MISSING_OWNER: 'MISSING_OWNER',
  SAME_DELIVERABLE_DEPENDENCY: 'SAME_DELIVERABLE_DEPENDENCY',
};

/** Stage vocabulary. Real policy must combine this with a deliverable subject. */
const PHASE_WORDS = [
  'background', 'investigation', 'design', 'check', 'review', 'plan', 'planning', 'code', 'coding', 'implement', 'implementation',
  '背景调查', '背景', '设计', '数值检查', '检查', '审查', '计划', '规划', '编码', '实现', '开发',
];

const INDEPENDENT_MARKERS = ['完整交付', '独立交付', '完整产物', '独立产物'];

export function classifySplit(spec) {
  const text = `${spec?.kind ?? ''} ${spec?.title ?? ''} ${spec?.deliverable ?? ''}`;
  if (/evidence|证据|资料|research|调研/i.test(text)) return 'evidence-package';
  if (/object|对象|怪物|boss|monster|npc|item|道具/i.test(text)) return 'object';
  return 'module';
}

function hintFor() {
  return '请按横向独立交付重排：以模块/对象/证据包为单位，每个交付物由同一责任人贯穿调查→实现→收尾；'
    + '例如 Boss 方案应拆成“Boss-01 完整交付”“Boss-02 完整交付”，而不是背景调查/设计/数值检查三段接力。';
}

function hasPhaseWord(text) {
  const lowered = String(text ?? '').toLowerCase();
  return PHASE_WORDS.some((word) => lowered.includes(word.toLowerCase()));
}

function hasIndependentMarker(text) {
  const lowered = String(text ?? '').toLowerCase();
  return INDEPENDENT_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()));
}

/** True when the spec declares itself as one time stage of a larger deliverable. */
export function isStageRelay(spec) {
  if (!spec) return false;
  if (spec.phaseRelay === true) return true;
  if (typeof spec.phase === 'string' && hasPhaseWord(spec.phase)) return true;
  const declared = `${spec.title ?? ''} ${Array.isArray(spec.outputs) ? spec.outputs.join(' ') : ''}`;
  if (hasIndependentMarker(declared)) return false;
  // A title that is "<subject> 的 <stage>" with only stage-shaped outputs.
  if (hasPhaseWord(spec.title)) {
    const outputs = Array.isArray(spec.outputs) ? spec.outputs : [];
    const stageOutputs = outputs.length > 0 && outputs.every((output) => hasPhaseWord(output) || /报告|方案|结论|评审|计划|清单/i.test(String(output)));
    if (stageOutputs || outputs.length === 0) return true;
  }
  return false;
}

export function validateWorkSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    return { ok: false, code: 'INVALID_SPEC', message: 'work spec must be an object', hint: '传入 { deliverable, title, owner? }' };
  }
  if (!spec.deliverable || typeof spec.deliverable !== 'string') {
    return { ok: false, code: RELAY_CODES.MISSING_DELIVERABLE, message: 'deliverable is required', hint: '每个工作项必须声明它交付什么。' };
  }
  if (!spec.title || typeof spec.title !== 'string') {
    return { ok: false, code: 'MISSING_TITLE', message: 'title is required', hint: '标题描述这份独立交付物。' };
  }
  if (spec.splitKind && spec.splitKind !== 'independent-deliverable') {
    return { ok: false, code: RELAY_CODES.PHASE_RELAY_REJECTED, message: `splitKind ${spec.splitKind} is not a horizontal split`, hint: hintFor() };
  }
  if (spec.phaseRelay !== false && isStageRelay(spec)) {
    return {
      ok: false,
      code: RELAY_CODES.PHASE_RELAY_REJECTED,
      message: `${spec.deliverable} 的“${spec.title}”是同一交付物的时序阶段，不是独立交付`,
      hint: hintFor(),
    };
  }
  const dependencies = Array.isArray(spec.artifactDependencies) ? spec.artifactDependencies : [];
  for (const dependency of dependencies) {
    const artifact = String(dependency?.artifact ?? '');
    if (!artifact) {
      return { ok: false, code: 'MISSING_ARTIFACT', message: 'artifactDependencies entries need an artifact', hint: '写明依赖的交付物名称。' };
    }
    const deliverable = String(spec.deliverable);
    if (artifact === deliverable || artifact.startsWith(`${deliverable}/`) || artifact.startsWith(`${deliverable}.`)) {
      return {
        ok: false,
        code: RELAY_CODES.PHASE_RELAY_REJECTED,
        message: `${artifact} 属于同一交付物 ${deliverable}，不能用 depends_on/artifactDependencies 伪装时序阶段`,
        hint: hintFor(),
      };
    }
    if (!Number.isFinite(dependency?.version) || !dependency?.requires) {
      return {
        ok: false,
        code: RELAY_CODES.ARTIFACT_VERSION_REQUIRED,
        message: `依赖 ${artifact} 必须注明 version 与 requires`,
        hint: 'artifactDependencies: [{ artifact, version, requires: "published-interface" | "verified-result" }]',
      };
    }
  }
  const normalized = {
    workId: spec.workId ?? null,
    teamKey: spec.teamKey ?? 'default',
    title: spec.title,
    deliverable: spec.deliverable,
    kind: spec.kind ?? classifySplit(spec),
    ownerMemberId: spec.ownerMemberId ?? null,
    inputs: normalizeList(spec.inputs),
    outputs: normalizeList(spec.outputs),
    acceptance: normalizeList(spec.acceptance),
    artifactDependencies: dependencies.map((dependency) => ({
      artifact: String(dependency.artifact),
      version: Number(dependency.version),
      requires: dependency.requires,
    })),
    writeScopes: normalizeList(spec.writeScopes),
    contextPolicy: spec.contextPolicy ?? 'fresh-with-evidence-references',
    delegationBudget: {
      maxConcurrentLeaves: Number(spec.delegationBudget?.maxConcurrentLeaves ?? 6),
      maxAttempts: Number(spec.delegationBudget?.maxAttempts ?? 24),
    },
    blockedBy: normalizeList(spec.blockedBy ?? spec.dependsOn),
    priority: Number(spec.priority ?? 0),
    splitKind: 'independent-deliverable',
    idempotencyKey: spec.idempotencyKey ?? null,
  };
  return { ok: true, normalized };
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.length > 0);
}

/**
 * produced (submitted) is not completion. `verified` / `accepted` /
 * `user-confirmed` are strictly stronger levels.
 */
export function completionGate(work, attempt, evidence = {}) {
  const missing = [];
  if (!attempt || !['produced', 'verifying', 'completed'].includes(attempt.state)) missing.push('attempt-submitted');
  const artifacts = Array.isArray(attempt?.artifacts) ? attempt.artifacts : [];
  if (artifacts.length === 0) missing.push('artifacts');
  const refs = Array.isArray(evidence?.evidenceRefs) ? evidence.evidenceRefs : Array.isArray(attempt?.evidence) ? attempt.evidence : [];
  if (refs.length === 0) missing.push('evidence');
  if (work?.acceptance?.length && !evidence?.acceptanceSatisfied) missing.push('acceptance');
  const level = missing.length === 0
    ? (evidence?.userConfirmed ? 'user-confirmed' : evidence?.acceptanceSatisfied ? 'accepted' : 'verified')
    : (attempt?.state === 'produced' ? 'produced' : 'produced');
  return { level, ok: missing.length === 0, missing };
}

export function createReferencePolicy(overrides = {}) {
  return {
    rejectPhaseRelay: overrides.phaseRelay !== 'accept',
    validateWorkSpec,
    classifySplit,
    isStageRelay,
    completionGate,
  };
}

export default createReferencePolicy;
