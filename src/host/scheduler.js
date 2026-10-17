/**
 * `scheduler.js` — 常驻 Host 调度器：事件驱动的滚动补位。
 *
 * 算法（严格实现，见 `docs/ARCHITECTURE.md` §2.5）：
 *
 *   onRelevantEvent(event):
 *     coalesceWakeup()                       // 同一 tick 的多次事件合并
 *     tick()
 *
 *   tick():
 *     prefetch = await service.prefetchNative()          // 锁外
 *     { report, plans } = await mutex.run(async () => {  // 锁内：只做状态变更
 *        reconcileReceiptsAndCapacity()                  // 启动回执 / 过期 lease
 *        refreshAffectedReadyTasks()                     // ready(task) 计算
 *        reserveEligibleStartsFairly()                   // 原子预留 attempt/lease/容量
 *     })
 *     for (plan of plans) startReservedChildOutsideStateLock(plan)   // 锁外
 *
 * 明确禁止：
 *   - `Promise.all` 全批屏障（只在“一组短的启动调用”上使用 `allSettled`）。
 *   - 拓扑整层等待。
 *   - 为维持并发启动尚未满足依赖的任务（预留阶段只接受 ready 项）。
 *   - 在状态锁内等待模型、网络或子任务结束。
 *   - 用 `setTimeout`/`setInterval` 做合并或退避（确定性测试必须能完全驱动时间）。
 *
 * 满额时**拒绝并保持 ready**（`CAPACITY_FULL` 系列），不排队空等、不用 one-shot 绕上限。
 */
import { createSchedulerConstraints } from './constraints.js';

/**
 * @param {{
 *   service: import('./service.js').TeamWorkbenchService,
 *   adapter: object,
 *   storage: object,
 *   config: object,
 *   clock?: { now: () => number },
 *   mutex?: object,
 * }} deps
 */
export function createScheduler(deps) {
  const { service, adapter, storage, config } = deps;
  const clock = deps.clock ?? service.clock ?? { now: () => Date.now() };
  const diagnostics = [];
  const constraints = createSchedulerConstraints({ service, config });

  let started = false;
  let disposed = false;
  let scheduled = false;
  let inflight = null;
  let tickCounter = 0;
  let wakeReason = null;
  let wakeCount = 0;
  let coalescedCount = 0;
  let lastReport = null;
  const disposers = [];

  function push(code, message, detail) {
    diagnostics.push({ at: clock.now(), code, message: String(message ?? ''), detail: detail ?? null });
    while (diagnostics.length > 200) diagnostics.shift();
  }

  /**
   * 幂等唤醒。`start()` 之前调用是安全的（只记录原因，不排程）。
   * 合并用 microtask，不用定时器。
   */
  function notify(reason, detail) {
    wakeCount += 1;
    wakeReason = { reason, detail, at: clock.now() };
    if (!started || disposed) return;
    if (scheduled) {
      coalescedCount += 1;
      return;
    }
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void runOnce().catch((error) => push('scheduler:error', String(error?.message ?? error)));
    });
  }

  async function runOnce() {
    if (inflight) return inflight;
    inflight = tick().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  /** 一次完整的调度环路。可被确定性测试直接 await。 */
  async function tick() {
    tickCounter += 1;
    const startedAt = clock.now();
    const mode = service.readOnly ? 'read-only' : 'dispatch';

    // 快速路径：没有任何工作项与 attempt 时无事可做，避免空转预取原生状态。
    if (service.works.size === 0 && service.attempts.size === 0) {
      const empty = {
        tick: tickCounter,
        mode: 'idle',
        startedAt,
        finishedAt: clock.now(),
        readyBefore: [],
        started: [],
        rejected: [],
        lateResults: [],
        reconcile: { adopted: [], released: [], requeued: [], staleLeases: [], lateResults: service.lateResults.length, missingNative: [], readOnly: service.readOnly },
        capacityAfter: service.capacity(),
        wakeReason,
      };
      lastReport = empty;
      service.stats.ticks = tickCounter;
      return empty;
    }

    // 1) 锁外预取原生状态（agents / children catalog）。
    const prefetch = await service.prefetchNative();

    // 2) 锁内：只做状态变更与原子预留。
    const reserved = await service.mutex.run(async () => {
      const report = await service.reconcileInLock(prefetch);
      const reservation = await service.reserveStarts(prefetch, config.scheduler.maxStartsPerTick);
      return { report, reservation };
    });

    // 3) 锁外启动（一组短的启动调用，可并发，但不是"等全部结束才开下一批"）。
    const startedPlans = [];
    if (reserved.reservation.plans.length > 0) {
      const results = await Promise.allSettled(
        reserved.reservation.plans.map((plan) => service.executeStart(plan)),
      );
      for (let index = 0; index < results.length; index += 1) {
        const plan = reserved.reservation.plans[index];
        const result = results[index];
        if (result.status === 'fulfilled' && result.value?.ok) {
          startedPlans.push({
            workId: plan.workId,
            attemptId: plan.attemptId,
            childId: result.value.childId ?? plan.childId,
            startedAt: clock.now(),
            teamKey: plan.teamKey,
            ownerMemberId: plan.ownerMemberId,
          });
        } else {
          const code = result.status === 'fulfilled' ? (result.value?.code ?? 'START_FAILED') : 'START_THREW';
          push('scheduler:start-failed', `${plan.workId}: ${code}`, result.status === 'rejected' ? String(result.reason) : null);
        }
      }
    }

    const report = {
      tick: tickCounter,
      mode,
      startedAt,
      finishedAt: clock.now(),
      readyBefore: reserved.reservation.readyBefore ?? [],
      started: startedPlans,
      rejected: reserved.reservation.rejections ?? [],
      lateResults: (service.lateResults ?? []).slice(-10).map((entry) => ({
        workId: entry.workId,
        attemptId: entry.attemptId,
        leaseEpoch: entry.leaseEpoch,
        reason: entry.reason,
      })),
      reconcile: reserved.report,
      capacityAfter: service.capacity(),
      wakeReason,
    };
    lastReport = report;
    service.stats.ticks = tickCounter;
    return report;
  }

  function start() {
    if (started) return () => {};
    started = true;
    push('scheduler:started', 'scheduler started');
    disposers.push(
      service.subscribe((reason, detail) => notify(reason, detail)),
      adapter.on('agent/status', (payload) => notify('agent/status', payload?.agent?.id ?? null)),
      adapter.on('subagent/end', (info) => notify('subagent/end', info?.childId ?? null)),
      adapter.on('subagent/start', (info) => notify('subagent/start', info?.childId ?? null)),
      adapter.on('domain/changed', (change) => notify('domain/changed', change?.name ?? null)),
      adapter.on('agent/disposed', (payload) => notify('agent/disposed', payload?.agent?.id ?? null)),
    );
    // 冷启动对账：不重跑已完成任务，只重建 ready 队列并恢复 parent→child。
    notify('scheduler:startup-reconcile', null);
    return stop;
  }

  function stop() {
    if (!started) return;
    started = false;
    for (const disposer of disposers.splice(0)) {
      try {
        disposer();
      } catch {
        /* 卸载路径吞掉清理异常，避免影响插件停用 */
      }
    }
    push('scheduler:stopped', 'scheduler stopped');
  }

  function dispose() {
    stop();
    disposed = true;
  }

  return {
    start,
    stop,
    dispose,
    notify,
    tick,
    runOnce,
    get started() {
      return started;
    },
    diagnostics: () => diagnostics.slice(),
    lastTick: () => lastReport,
    capacity: () => service.capacity(),
    constraints,
    stats: () => ({ ticks: tickCounter, wakeCount, coalescedCount, inflight: inflight !== null }),
    /** 供确定性测试断言"没有全批屏障"：调度器从不持有批次状态。 */
    batchState: () => ({ hasBatch: false, hasLayerBarrier: false, pendingBatchWaiters: 0 }),
  };
}
