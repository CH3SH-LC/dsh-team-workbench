/**
 * `identity.js` — 稳定交付物身份 + 反改名接力（契约 v1 §2 / 验收 §5.1）。
 *
 * ## 为什么要换掉"相信 kind + 标题词表"
 *
 * 旧实现（`policy.js` 的 `classifySplit`/`isStageOnly`）把 `kind=module|object|evidence-package`
 * 当**声明**直接相信，并用标题/deliverable 的词表做图级判断。真实缺陷是：
 * 同一交付物只要**改标题 / 改 kind / 改 subject**，就能作为"新流程"再开一个 workId，
 * 于是「同一消费者迁移 / 补传播 / verify / hash」这类返工被拆成两个"独立交付物"，
 * 既绕过 owner 端到端责任，也让完成判定和费用归账分叉。
 *
 * ## 现在的身份规则（程序化，可复核，不依赖另一个 LLM）
 *
 * **权威身份 = 原 `workId` + 原 `ownerMemberId`**。返工/续执行**沿用同一身份**；
 * 新 workId 只有在**结构上确实是另一份交付**时才允许创建。判据全部来自
 * 声明输入/输出范围 + 已有 work 的程序化结构，不读标题词表做最终裁决：
 *
 *   1. 同 workId + 不同 owner            → `IDENTITY_OWNER_MISMATCH`（拒绝）
 *   2. 显式 `continuationOf`/`supersedes`/`reworkOf` 指向既有 work
 *      - 目标存在且同 owner               → `IDENTITY_REUSE_REQUIRED`（必须复用原 workId 修订计划）
 *      - 目标存在但不同 owner             → `IDENTITY_OWNER_MISMATCH`
 *      - 目标不存在                       → `IDENTITY_CONTINUATION_UNKNOWN`
 *   3. 新 workId，但**产出范围与同 owner 既有 work 重叠**（Jaccard ≥ 阈值）
 *                                       → `IDENTITY_RENAME_RELAY`（同一交付物改名）
 *   4. 新 workId，产出范围与**别人**的既有 work 重叠
 *                                       → `IDENTITY_SCOPE_OWNER_CONFLICT`（写范围归属冲突）
 *   5. 新 workId，输入**覆盖**同 owner 既有 work 的产物，且本身是 verify/hash/检查类
 *      （输出全为中间产物 + 标题含校验/检查/hash 词）
 *                                       → `IDENTITY_HANDOFF_RELAY`（verify/hash 接力换名）
 *   6. 其余                              → 允许创建（独立对象/模块正常并行、合法独立研究不受影响）
 *
 * 规则 3/5 只看**结构**（路径集合与集合关系）。标题词表只在规则 5 做**窄化**用途
 * （把"消费别人产物做独立研究"与"对同一产物再做一次校验"分开），不承担主裁决。
 */
import { sha256Hex, stableStringify } from './util.js';

const VERIFY_WORDS = [  '检查', '校验', '审查', '复核', '验证', '核对', '审计', '复验', '重测',
  'verify', 'validate', 'check', 'audit', 'inspect', 'hash', 'checksum', 'digest',
];

/** 中间产物/派生结果词：用于规则 5 判"这份新 work 只是对既有产物再做一遍"。 */
const DERIVED_WORDS = [
  '报告', '清单', '摘要', '结论', '记录', '校验和', '哈希', '对照表',
  'report', 'list', 'summary', 'digest', 'hash', 'checksum', 'manifest',
];

const DEFAULT_POLICY = Object.freeze({
  /** 产出范围 Jaccard 阈值：达到即认为"同一份交付物的产出"。 */
  overlapThreshold: 0.5,
  /** 规则 5 的输入覆盖阈值（新 inputs 里有多少比例是既有产物）。 */
  handoffInputCoverage: 0.5,
  /** 'reject' 拒绝新流程；'warn' 只标记。默认 reject（契约 §2 不允许靠改名开新流程）。 */
  relayPolicy: 'reject',
  /** 独立研究豁免：显式 `kind:'evidence-package'` 且声明了独立验收条件时不判 handoff。 */
  exemptEvidencePackages: true,
});

/** 路径归一化：统一分隔符、去 `./`、Windows 大小写不敏感、去尾部斜杠。 */
export function normalizePath(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim().replace(/\\/g, '/');
  if (!text) return null;
  text = text.replace(/\/+/g, '/');
  if (text.startsWith('./')) text = text.slice(2);
  if (text.endsWith('/')) text = text.slice(0, -1);
  if (!text) return null;
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function pathList(value) {
  return (Array.isArray(value) ? value : []).map(normalizePath).filter(Boolean);
}

/** 产出位置 → 声明的**产出范围**（路径本身；目录形式由尾部 `/` 语义在归一化后保留为前缀匹配）。 */
export function outputScopesOf(spec) {
  return pathList(spec?.outputs);
}

/** 输入/证据范围。 */
export function inputScopesOf(spec) {
  return [...new Set([...pathList(spec?.inputs), ...pathList(spec?.artifactRefs)])];
}

/** 两个路径是否属于同一范围：相等，或一方是另一方的目录前缀。 */
export function sameScope(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** 两个范围集合的 Jaccard（按"任一元素命中即算交集元素"计数）。 */
export function scopeOverlap(leftList, rightList) {
  const left = Array.isArray(leftList) ? leftList : [];
  const right = Array.isArray(rightList) ? rightList : [];
  if (left.length === 0 || right.length === 0) return { ratio: 0, hits: [] };
  const hits = [];
  for (const a of left) {
    for (const b of right) {
      if (sameScope(a, b)) {
        hits.push(a === b ? a : `${a} ↔ ${b}`);
        break;
      }
    }
  }
  const union = new Set([...left, ...right]).size;
  const ratio = union === 0 ? 0 : new Set(hits).size / union;
  return { ratio, hits: [...new Set(hits)] };
}

/** 权威身份键：原 workId + 原 ownerMemberId（契约 §2）。 */
export function deliverableIdentityKey({ workId, ownerMemberId, teamKey }) {
  return `${teamKey ?? '?'}::${workId ?? '?'}::${ownerMemberId ?? '?'}`;
}

/**
 * 结构指纹：owner + 产出范围 + 输入范围 + 验收条件的稳定摘要。
 * **不含 title / kind / subject / deliverable** —— 改这些不能改变身份，这正是本模块的目的。
 */
export function structuralFingerprint(spec) {
  const outputs = [...new Set(outputScopesOf(spec))].sort();
  const inputs = [...new Set(inputScopesOf(spec))].sort();
  const acceptance = (Array.isArray(spec?.acceptance) ? spec.acceptance : [])
    .map((item) => String(item ?? '').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .sort();
  return sha256Hex(stableStringify({ owner: spec?.ownerMemberId ?? null, outputs, inputs, acceptance })).slice(0, 32);
}

function textOf(spec) {
  return [spec?.title, spec?.deliverable, spec?.subject, spec?.note]
    .filter((part) => typeof part === 'string')
    .join(' \n ')
    .toLowerCase();
}

function hitWords(text, words) {
  return words.filter((word) => text.includes(String(word).toLowerCase()));
}

/** 宽松提取字符串列表（blockedBy 是 workId 数组；dependencies 可能是对象数组）。 */
function toStringListLoose(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object') {
      for (const key of ['workId', 'artifact', 'title', 'id']) {
        if (typeof item[key] === 'string') out.push(item[key]);
      }
    }
  }
  return out;
}

/** 两条 work 的验收条件是否有明显重合（结构判定，不靠词表主裁决）。 */
function otherAcceptanceOverlaps(candidateAcceptance, work) {
  const other = (Array.isArray(work?.acceptance) ? work.acceptance : []).map((item) => String(item).trim()).filter(Boolean);
  if (other.length === 0 || candidateAcceptance.length === 0) return false;
  return candidateAcceptance.some((left) => other.some((right) => left === right || (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left)))));
}

/**
 * 判定一个候选 work 的身份动作。
 *
 * @param {object} input
 * @param {object} input.candidate 规范化的候选 spec（含 outputs/inputs/acceptance/ownerMemberId/kind/title）
 * @param {string} [input.teamKey]
 * @param {object[]} [input.existingWorks] 既有 work（调用方传入**本团队**的 work 列表）
 * @param {string} [input.selfWorkId] 修订已有 work 时传入（跳过"和自己重叠"）
 * @param {object} [input.policy] 覆盖 DEFAULT_POLICY
 * @returns {{
 *   ok: boolean, action: 'create'|'reuse'|'continue',
 *   identityKey: string, fingerprint: string,
 *   code: string|null, message: string|null, hint: string|null,
 *   matchedWorkId: string|null, relatedWorkIds: string[], violations: object[]
 * }}
 */
export function judgeIdentity(input = {}) {
  const policy = { ...DEFAULT_POLICY, ...(input.policy && typeof input.policy === 'object' ? input.policy : {}) };
  const candidate = input.candidate ?? {};
  const teamKey = input.teamKey ?? candidate.teamKey ?? null;
  const selfWorkId = typeof input.selfWorkId === 'string' ? input.selfWorkId : null;
  /**
   * **权威全集**：本团队、未取消的全部 work（**不排除 selfWorkId**）。
   *
   * 缺陷（Codex 审阅 A）：旧代码先把 selfWorkId 过滤掉，再 `existing.find(selfWorkId)`
   * —— 永远找不到，规则 1（换 owner）完全失效。现在：权威查找只看全集；
   * 只有"产出范围重叠"的比较集才排除自己（否则一个 work 会和自己重叠）。
   */
  const allTeamWorks = (Array.isArray(input.existingWorks) ? input.existingWorks : []).filter(
    (work) => work && work.workId && work.state !== 'cancelled' && (!teamKey || work.teamKey === teamKey),
  );
  // 返工判定要能看到**已取消**的历史交付物：否则"取消后换名重开"会绕开原 work 的检查/凭据。
  // 取消件不占用产出位置（不参与改名/owner 冲突），只参与"必须沿用原 workId"的返工判定。
  const cancelledWorks = (Array.isArray(input.existingWorks) ? input.existingWorks : []).filter(
    (work) => work && work.workId && work.state === 'cancelled' && (!teamKey || work.teamKey === teamKey) && (!selfWorkId || work.workId !== selfWorkId),
  );
  const existing = allTeamWorks.filter((work) => !selfWorkId || work.workId !== selfWorkId);
  const fingerprint = structuralFingerprint(candidate);
  const identityKey = deliverableIdentityKey({
    workId: candidate.workId ?? selfWorkId ?? null,
    ownerMemberId: candidate.ownerMemberId ?? null,
    teamKey,
  });
  const base = {
    ok: true,
    action: 'create',
    identityKey,
    fingerprint,
    code: null,
    message: null,
    hint: null,
    matchedWorkId: null,
    relatedWorkIds: [],
    violations: [],
  };

  // ---- 规则 1：同 workId + 不同 owner ---------------------------------------
  if (selfWorkId) {
    const selfWork = allTeamWorks.find((work) => work.workId === selfWorkId);
    if (selfWork && selfWork.ownerMemberId !== candidate.ownerMemberId) {
      return {
        ...base,
        ok: false,
        action: 'reuse',
        code: 'IDENTITY_OWNER_MISMATCH',
        message: `workId ${selfWorkId} 的身份已绑定 owner「${selfWork.ownerMemberId}」，不能由「${candidate.ownerMemberId}」继承。`,
        hint: '同一交付物身份 = 原 workId + 原 ownerMemberId；换 owner 就是换责任链，必须先由原 owner 结账或显式迁移。',
        matchedWorkId: selfWorkId,
        violations: [{ code: 'IDENTITY_OWNER_MISMATCH', workId: selfWorkId, boundOwner: selfWork.ownerMemberId, attemptedOwner: candidate.ownerMemberId }],
      };
    }
    // 修订自己：身份不变，不需要再判改名。
    return { ...base, action: 'reuse', matchedWorkId: selfWorkId };
  }

  // ---- 规则 1b：候选自带一个已存在的 workId，但 owner 不同 ----------------
  // submitWork 直接带 workId 时也必须校验身份归属，否则同一 workId 可被换 owner 重写。
  if (!selfWorkId && typeof candidate.workId === 'string' && candidate.workId) {
    const sameId = allTeamWorks.find((work) => work.workId === candidate.workId);
    if (sameId && sameId.ownerMemberId !== candidate.ownerMemberId) {
      return {
        ...base,
        ok: false,
        action: 'reuse',
        code: 'IDENTITY_OWNER_MISMATCH',
        message: `workId ${candidate.workId} 的身份已绑定 owner「${sameId.ownerMemberId}」，不能由「${candidate.ownerMemberId}」重写。`,
        hint: '同一交付物身份 = 原 workId + 原 ownerMemberId；换 owner 必须先由原 owner 结账或显式迁移。',
        matchedWorkId: candidate.workId,
        violations: [{ code: 'IDENTITY_OWNER_MISMATCH', workId: candidate.workId, boundOwner: sameId.ownerMemberId, attemptedOwner: candidate.ownerMemberId }],
      };
    }
  }

  // ---- 规则 2：显式续作链接 ------------------------------------------------
  const linkFields = ['continuationOf', 'supersedes', 'reworkOf', 'replaces'];
  const linkField = linkFields.find((field) => typeof candidate[field] === 'string' && String(candidate[field]).trim());
  if (linkField) {
    const targetId = String(candidate[linkField]).trim();
    const target = existing.find((work) => work.workId === targetId);
    if (!target) {
      return {
        ...base,
        ok: false,
        code: 'IDENTITY_CONTINUATION_UNKNOWN',
        message: `${linkField} 指向的 workId ${targetId} 不存在（或已取消）。`,
        hint: '续作/返工必须指向真实存在的原交付物；若原 work 已取消，请由 owner 显式重新计划，而不是声明一个不存在的续作。',
        matchedWorkId: targetId,
        violations: [{ code: 'IDENTITY_CONTINUATION_UNKNOWN', field: linkField, targetId }],
      };
    }
    if (target.ownerMemberId !== candidate.ownerMemberId) {
      return {
        ...base,
        ok: false,
        code: 'IDENTITY_OWNER_MISMATCH',
        message: `续作目标 ${targetId} 属于 owner「${target.ownerMemberId}」，不能由「${candidate.ownerMemberId}」接手。`,
        hint: '同一交付物的返工必须由原 owner 完成；跨 owner 只能在原 owner 结账并显式迁移后发生。',
        matchedWorkId: targetId,
        violations: [{ code: 'IDENTITY_OWNER_MISMATCH', workId: targetId, boundOwner: target.ownerMemberId, attemptedOwner: candidate.ownerMemberId }],
      };
    }
    return {
      ...base,
      ok: policy.relayPolicy !== 'reject' ? true : false,
      action: 'continue',
      code: policy.relayPolicy === 'reject' ? 'IDENTITY_REUSE_REQUIRED' : 'IDENTITY_CONTINUATION_WARN',
      message: `检测到对 ${targetId} 的续作声明：同一交付物必须**沿用原 workId** 修订计划（planRevision+1），不能开新 workId。`,
      hint: `用 team_plan_submit 修订 workId=${targetId}（expectedPlanRevision=当前 planRevision），再 team_dispatch_authorize 新意图；不要用新 workId 重开流程。`,
      matchedWorkId: targetId,
      relatedWorkIds: [targetId],
      violations: [{ code: 'IDENTITY_REUSE_REQUIRED', targetId, field: linkField }],
    };
  }

  // ---- 规则 3/4：产出范围重叠 ---------------------------------------------
  const ownOutputs = outputScopesOf(candidate);
  const overlaps = [];
  for (const work of existing) {
    const otherOutputs = outputScopesOf(work);
    const { ratio, hits } = scopeOverlap(ownOutputs, otherOutputs);
    if (ratio >= policy.overlapThreshold) overlaps.push({ work, ratio, hits });
  }
  // 已取消的历史交付物：只用于"返工必须沿用原 workId"，不算活跃占用。
  const cancelledOverlaps = [];
  for (const work of cancelledWorks) {
    const { ratio, hits } = scopeOverlap(ownOutputs, outputScopesOf(work));
    if (ratio >= policy.overlapThreshold) cancelledOverlaps.push({ work, ratio, hits });
  }
  const P1_REWORK_STATES = new Set(['failed', 'blocked', 'cancelled', 'needs_plan']);
  if (overlaps.length === 0 && cancelledOverlaps.length > 0 && candidate.ownerMemberId) {
    const target = cancelledOverlaps
      .filter((entry) => entry.work.ownerMemberId === candidate.ownerMemberId)
      .sort((a, b) => b.ratio - a.ratio)[0];
    if (target) {
      // P1-5：已取消交付物的返工同样必须沿用原 workId（换名新 id 会绕过原 work 的检查与凭据）。
      // 明确声明 replacements/reworkOf 且指向原 workId 的合法迁移在规则 2 已处理。
      return {
        ...base,
        ok: false,
        action: 'continue',
        code: 'REWORK_REQUIRES_ORIGINAL_WORK_ID',
        message: `已取消的交付物必须沿用原 workId=${target.work.workId} 重新计划（换名新 id 会绕过原 work 的历史与检查）。`,
        hint: `用 team_plan_submit 修订 workId=${target.work.workId}（planRevision+1）并重新 team_dispatch_authorize；不要用新 workId 重开流程。`,
        matchedWorkId: target.work.workId,
        relatedWorkIds: [target.work.workId],
        violations: [{ code: 'REWORK_REQUIRES_ORIGINAL_WORK_ID', existingWorkId: target.work.workId, overlap: target.hits, ratio: Number(target.ratio.toFixed(3)) }],
      };
    }
  }
  if (overlaps.length > 0) {
    // 已 blocked/failed/cancelled 的 work 不再占用产出位置：失败终态不应永久阻断同 owner 重新提交。
    const ACTIVE_RELAY_STATES = new Set(['planned', 'dispatch_authorized', 'ready', 'executing', 'producing', 'produced', 'awaiting_verification', 'verifying', 'accepted', 'needs_plan', 'self_running']);
    const sameOwner = overlaps.filter((entry) => entry.work.ownerMemberId === candidate.ownerMemberId && ACTIVE_RELAY_STATES.has(String(entry.work.state)));
    const otherOwner = overlaps.filter((entry) => entry.work.ownerMemberId !== candidate.ownerMemberId);
    // P1-5：failed/blocked/cancelled/needs_plan 的返工必须沿原 workId+owner 修订；
    // 换名新 id 会绕过原 work 的检查与凭据。blocked 也一样（含人工门控），
    // 只有"同一 workId 修订计划"才是合法返工入口。
    const TERMINAL_REWORK_STATES = P1_REWORK_STATES;
    const terminalSameOwner = overlaps.filter((entry) => {
      if (entry.work.ownerMemberId !== candidate.ownerMemberId) return false;
      const state = String(entry.work.state);
      if (TERMINAL_REWORK_STATES.has(state)) return true;
      // 依赖阻塞的返工也必须沿原 workId（blockedBy 非空）；仅有 blockedReason 的人工门控允许重新计划。
      return state === 'blocked' && Array.isArray(entry.work.blockedBy) && entry.work.blockedBy.length > 0;
    });
    if (sameOwner.length === 0 && otherOwner.length === 0 && terminalSameOwner.length > 0) {
      const target = terminalSameOwner.sort((a, b) => b.ratio - a.ratio)[0];
      return {
        ...base,
        ok: false,
        action: 'continue',
        code: 'REWORK_REQUIRES_ORIGINAL_WORK_ID',
        message: `失败/阻塞/取消的返工必须沿用原 workId=${target.work.workId}（同一交付物换名新 id 会绕过原 work 的检查与凭据）。`,
        hint: `用 team_plan_submit 修订 workId=${target.work.workId}（planRevision+1）并重新 team_dispatch_authorize；不要用新 workId 重开流程。`,
        matchedWorkId: target.work.workId,
        relatedWorkIds: [target.work.workId],
        violations: [{ code: 'REWORK_REQUIRES_ORIGINAL_WORK_ID', existingWorkId: target.work.workId, overlap: target.hits, ratio: Number(target.ratio.toFixed(3)) }],
      };
    }
    if (sameOwner.length === 0 && otherOwner.length === 0) {
      // 重叠对象都是"失败终态且同 owner"的历史 work：不占用产出位置，继续走后续规则。
      // （否则 target 为 undefined，会让 submitWork 抛出运行时 TypeError。）
    } else if (sameOwner.length > 0) {
      const target = sameOwner.sort((a, b) => b.ratio - a.ratio)[0];
      return {
        ...base,
        ok: policy.relayPolicy !== 'reject' ? true : false,
        action: 'continue',
        code: policy.relayPolicy === 'reject' ? 'IDENTITY_RENAME_RELAY' : 'IDENTITY_RENAME_WARN',
        message: `新 workId 的产出范围与既有 ${target.work.workId} 重叠 ${(target.ratio * 100).toFixed(0)}%（${target.hits.join('、')}）：这是**同一交付物改名**，不是新交付物。`,
        hint: `改标题/kind/subject 不能开新流程：请用 team_plan_submit 修订 workId=${target.work.workId}（planRevision+1）并 team_dispatch_authorize 新意图。`,
        matchedWorkId: target.work.workId,
        relatedWorkIds: [target.work.workId],
        violations: [{ code: 'IDENTITY_RENAME_RELAY', existingWorkId: target.work.workId, overlap: target.hits, ratio: Number(target.ratio.toFixed(3)) }],
      };
    } else {
      const target = otherOwner.sort((a, b) => b.ratio - a.ratio)[0];
      return {
        ...base,
        ok: false,
        action: 'create',
        code: 'IDENTITY_SCOPE_OWNER_CONFLICT',
        message: `产出位置与 ${target.work.workId}（owner「${target.work.ownerMemberId}」）重叠（${target.hits.join('、')}），但 owner 不同。`,
        hint: '产出位置归属由原 owner 持有；要改同一份产物请先与该 owner 约定并升版接口，或改到自己的写范围。',
        matchedWorkId: target.work.workId,
        relatedWorkIds: [target.work.workId],
        violations: [{ code: 'IDENTITY_SCOPE_OWNER_CONFLICT', existingWorkId: target.work.workId, overlap: target.hits }],
      };
    }
  }

  // ---- 规则 5：受管派生 / 验证接力的**结构**判定（不再靠自报 kind 豁免） ----
  //
  // 缺陷（Codex 审阅 A）：
  //   旧实现里 `exemptEvidencePackages && kind==='evidence-package' && acceptance 非空`
  //   直接豁免规则 5 —— 只要把 kind 改成 evidence-package 就能绕过（"改 kind 绕过"）。
  // 现在：
  //   - **不看 kind/title 决定豁免**；`kind` 只作为输出分类的辅助信号。
  //   - 5a 受管续作：同 owner 消费自己**尚未 accepted** 的交付物产物 → 这是继续同一交付物，
  //     必须沿用原 workId（`IDENTITY_REUSE_REQUIRED`）。这挡住"实现→核验→接线"换阶段换名。
  //   - 5b 验证接力：同 owner 的输入覆盖既有产物的比例达到阈值，且自身产出是派生/校验类
  //     （输出落在既有 work 的产出/写范围内，或验收文本重合）→ `IDENTITY_HANDOFF_RELAY`。
  //   - 5c 受管派生关联：候选消费了别的 work 的产物，就必须在 `blockedBy`/`dependencies`
  //     里稳定指向那个 workId（`IDENTITY_DERIVATION_UNLINKED`），否则依赖关系是隐式的。
  //   - 真正独立研究：既不消费未结算交付物、产出也不落在对方范围内、验收也不同 → 放行。
  const text = textOf(candidate);
  const verifyHits = hitWords(text, VERIFY_WORDS);
  const outputs = outputScopesOf(candidate);
  const derivedOnly = outputs.length > 0 && outputs.every((output) => hitWords(output, DERIVED_WORDS).length > 0);
  const declaration = inputScopesOf(candidate);
  const normalizedAcceptance = (candidate.acceptance ?? []).map((item) => String(item).trim()).filter(Boolean);
  const declaredRefs = new Set([
    ...toStringListLoose(candidate.blockedBy),
    ...toStringListLoose(candidate.dependencies),
  ]);

  for (const work of existing) {
    const otherOutputs = outputScopesOf(work);
    if (otherOutputs.length === 0) continue;
    const covered = otherOutputs.filter((output) => declaration.some((item) => sameScope(item, output)));
    const coverage = covered.length / otherOutputs.length;
    if (coverage < policy.handoffInputCoverage) continue;
    const sameOwner = work.ownerMemberId === candidate.ownerMemberId;

    // 5a 受管续作：同 owner 消费自己**未结算**的交付物 → 必须复用原 workId。
    if (sameOwner && work.state !== 'accepted') {
      return {
        ...base,
        ok: policy.relayPolicy !== 'reject' ? true : false,
        action: 'continue',
        code: policy.relayPolicy === 'reject' ? 'IDENTITY_REUSE_REQUIRED' : 'IDENTITY_CONTINUATION_WARN',
        message: `新 work 消费了你自己尚未结算的交付物 ${work.workId} 的产物（${covered.join('、')}）：这是**继续同一交付物**（例如实现→核验→接线），不是新交付物。`,
        hint: `沿用原 workId=${work.workId} 修订计划（planRevision+1）并重新授权；不要把同一交付物拆成多个 workId 接力。`,
        matchedWorkId: work.workId,
        relatedWorkIds: [work.workId],
        violations: [{ code: 'IDENTITY_REUSE_REQUIRED', existingWorkId: work.workId, coveredInputs: covered, coverage: Number(coverage.toFixed(3)) }],
      };
    }

    // 5b 验证接力：派生/校验类产出，或验收文本与既有 work 重合。
    const acceptanceOverlap = otherAcceptanceOverlaps(normalizedAcceptance, work);
    const derivedWithinScope = derivedOnly || outputs.some((output) => otherOutputs.some((item) => sameScope(item, output)));
    if (sameOwner && (verifyHits.length > 0 || derivedOnly) && (derivedWithinScope || acceptanceOverlap)) {
      return {
        ...base,
        ok: policy.relayPolicy !== 'reject' ? true : false,
        action: 'continue',
        code: policy.relayPolicy === 'reject' ? 'IDENTITY_HANDOFF_RELAY' : 'IDENTITY_HANDOFF_WARN',
        message: `新 work 的输入覆盖了既有 ${work.workId} 的产物（${covered.join('、')}），且自身产出是派生/校验类：这是对**同一交付物**再做一遍检查，属于接力换名。`,
        hint: `验收/复验请在原 workId=${work.workId} 上由 owner 用 team_exec_check + team_work_verify 完成；确需重做时用 team_plan_submit 修订原 workId。`,
        matchedWorkId: work.workId,
        relatedWorkIds: [work.workId],
        violations: [{ code: 'IDENTITY_HANDOFF_RELAY', existingWorkId: work.workId, coveredInputs: covered, verifyWords: verifyHits, acceptanceOverlap }],
      };
    }

    // 5c 受管派生必须稳定关联原 work/原 owner（不能只有隐式"我读了它的文件"）。
    if (!declaredRefs.has(work.workId) && !declaredRefs.has(work.title)) {
      return {
        ...base,
        ok: false,
        action: 'create',
        code: 'IDENTITY_DERIVATION_UNLINKED',
        message: `新 work 的输入覆盖了 ${work.workId} 的产物（${covered.join('、')}），但在 blockedBy/dependencies 里没有指向它：派生关系必须是显式依赖。`,
        hint: `在 blockedBy 里加 "${work.workId}"（或用 dependencies:[{workId:"${work.workId}",version,requires}]），由 Host 保证版本与顺序；不要用"我读了文件"隐式前置。`,
        matchedWorkId: work.workId,
        relatedWorkIds: [work.workId],
        violations: [{ code: 'IDENTITY_DERIVATION_UNLINKED', existingWorkId: work.workId, coveredInputs: covered }],
      };
    }
  }

  // ---- 规则 6：允许创建（独立对象/模块并行、合法独立研究） ------------------
  const related = existing
    .map((work) => ({ workId: work.workId, ratio: scopeOverlap(ownOutputs, outputScopesOf(work)).ratio }))
    .filter((entry) => entry.ratio > 0)
    .map((entry) => entry.workId);
  return {
    ...base,
    ok: true,
    action: 'create',
    matchedWorkId: null,
    relatedWorkIds: related,
    violations: [],
    fingerprint,
  };
}

/**
 * 一个 work 的**身份记录**（写进 sidecar，供返工/续作解析与前端展示）。
 * 身份在创建时绑定，之后**不随标题/kind 改变**。
 */
export function identityRecordFor(spec, judgement) {
  return {
    identityKey: judgement?.identityKey ?? deliverableIdentityKey(spec),
    fingerprint: judgement?.fingerprint ?? structuralFingerprint(spec),
    workId: spec?.workId ?? null,
    ownerMemberId: spec?.ownerMemberId ?? null,
    teamKey: spec?.teamKey ?? null,
    outputScopes: [...new Set(outputScopesOf(spec))].sort(),
    inputScopes: [...new Set(inputScopesOf(spec))].sort(),
    boundAt: Date.now(),
  };
}

export const IDENTITY_POLICY_DEFAULTS = DEFAULT_POLICY;
