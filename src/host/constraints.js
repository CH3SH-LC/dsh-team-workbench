/**
 * `constraints.js` — 容量与公平额度的纯计算。
 *
 * 与 `service.capacity()` 分开，是为了让验证 harness 能直接断言"容量怎么算出来的"，
 * 而不是只看一个数字。
 *
 * 三层容量（`docs/ARCHITECTURE.md` §2.5）：
 *   residentCapacity  DSH Continuable Activation 名额，含等待 children 的父成员与恢复余量
 *   workerCapacity    正在执行的叶子数量
 *   providerCapacity  真实模型请求 / 工具 / CPU / 网络资源上限
 *
 * 示例（不是性能承诺）：5 members × 6 leaves 全展开 = 30 个叶子 Activation
 * + 5 个等待 children 的父成员 = 35；再加 recoveryReserve + interactiveReserve。
 *   residentCapacity = hostActivationLimit - recoveryReserve - interactiveReserve
 *   默认 40 - 3 - 2 = 35 → 正好容纳该示例。
 */
export function createSchedulerConstraints({ service, config }) {
  const capacity = config.capacity;

  function residentCapacity() {
    return Math.max(0, capacity.hostActivationLimit - capacity.recoveryReserve - capacity.interactiveReserve);
  }

  function workerCapacity() {
    return capacity.globalLeafLimit;
  }

  function providerCapacity() {
    return capacity.providerRequestLimit;
  }

  /** 每团队公平额度：至少 1，避免团队数多时饿死单个团队。 */
  function teamFairShare(activeTeamCount) {
    const divisor = Math.max(1, Math.min(Math.max(1, activeTeamCount), capacity.teamsMaxConcurrent));
    return Math.max(1, Math.floor(workerCapacity() / divisor));
  }

  /** 每成员公平额度（基础值，保证多成员竞争时人人有份）。 */
  function memberFairShare() {
    return capacity.perMemberLeaves;
  }

  /**
   * 每成员**实际准入上限**。
   *
   * 基础 fair-share 只保证"别人有份"，不该让一个成员在其它成员空闲时浪费空槽：
   *   reserveForOthers = perMemberLeaves × (activeMembers - 1)
   *   limit            = max(perMemberLeaves, workerCapacity - reserveForOthers)
   *
   * 1 个成员 → 可吃满 workerCapacity；5 个成员 → 每人正好 perMemberLeaves。
   */
  function memberAdmissionLimit(activeMembers) {
    const members = Math.max(1, Number.isFinite(activeMembers) ? Math.trunc(activeMembers) : 1);
    const reserveForOthers = memberFairShare() * (members - 1);
    return Math.max(memberFairShare(), workerCapacity() - reserveForOthers);
  }

  /** 交互保留：普通根会话任何时候都必须还能发起请求。 */
  function interactiveHeadroom(usage) {
    return Math.max(0, capacity.hostActivationLimit - usage - capacity.interactiveReserve);
  }

  /** 这个 work 现在能不能预留（纯函数版本，便于测试）。 */
  function admit(work, usage) {
    const reasons = [];
    if (usage.resident + 1 > residentCapacity()) reasons.push('RESIDENT_CAPACITY_FULL');
    if (usage.leaves + 1 > workerCapacity()) reasons.push('WORKER_CAPACITY_FULL');
    const memberLimit = Number.isFinite(usage.memberLimit) ? usage.memberLimit : memberAdmissionLimit(usage.activeMembers);
    if (usage.memberInUse >= memberLimit) reasons.push('MEMBER_FAIR_SHARE_FULL');
    const provider = providerCapacity();
    if (provider !== null && usage.providerInUse + 1 > provider) reasons.push('PROVIDER_CAPACITY_FULL');
    if ((work?.attempts?.length ?? 0) >= (work?.delegationBudget?.maxAttempts ?? 6)) reasons.push('ATTEMPT_BUDGET_EXHAUSTED');
    return { ok: reasons.length === 0, reasons };
  }

  function describe() {
    return {
      hostActivationLimit: capacity.hostActivationLimit,
      residentCapacity: residentCapacity(),
      workerCapacity: workerCapacity(),
      providerCapacity: providerCapacity(),
      recoveryReserve: capacity.recoveryReserve,
      interactiveReserve: capacity.interactiveReserve,
      perMemberLeaves: memberFairShare(),
      teamsMaxConcurrent: capacity.teamsMaxConcurrent,
      fullExpansionExample: capacity.fullExpansionExample(),
      derivation: 'residentCapacity = hostActivationLimit - recoveryReserve - interactiveReserve; full expansion = members × perMemberLeaves + recoveryReserve + interactiveReserve; memberAdmissionLimit = max(perMemberLeaves, workerCapacity - perMemberLeaves×(activeMembers-1))',
      live: service ? service.capacity() : null,
    };
  }

  return {
    residentCapacity,
    workerCapacity,
    providerCapacity,
    teamFairShare,
    memberFairShare,
    memberAdmissionLimit,
    interactiveHeadroom,
    admit,
    describe,
  };
}
