/* @local/dsh-team-workbench — client entry: the plugin object the module factory returns.
 *
 * Everything registered here goes through `ctx.effect` / `ctx.slots.inject` and yields
 * its disposer, so an HMR reload re-applies cleanly without duplicate registrations,
 * duplicate dictionaries, or stacked listeners. No document/window keyboard listener is
 * installed by this plugin: native input, IME, Enter, Queue/Steer and the double-Esc
 * stop keep their original owners (the shipped conversation composer / stop shortcut).
 */

/** Everything the React surface needs, created once per `apply`. */
function tbCreateRuntime(options) {
  const { ctx, t, pinned, bridge, compat } = options;
  const actions = pinned.instance.actions;
  const layoutSource = {
    getSnapshot: () => pinned.instance.getSnapshot(),
    subscribe: (listener) => pinned.instance.subscribe(listener)
  };
  const diagnostics = {
    retains: 0,
    errors: [],
    lastHostOp: undefined,
    // Leaf-target defenses, readable by the Lead / acceptance harness:
    rejectedRetains: 0,        // retain() calls refused before touching ctx.sessions.retain
    notBindableCount: 0,       // every classification that ended as leaf/unknown
    recoveredAfterList: 0,     // targets that were 'unknown' and became bindable after data arrived
    strippedLeafTargets: [],   // positively-identified leaf targets cleared out of the store
    droppedHostTargets: []     // host LayoutRecord leaf targets dropped during merge
  };
  // paneId -> last {signature, verdict} the pane host reported (recovery diagnostics).
  const paneVerdicts = new Map();
  let panelActive = true;
  // A2: mount state of the workbench panel. The bridge may only act while the panel is
  // mounted AND the active main panel (its "don't act" condition is written in §0.4/§7).
  let panelMounted = false;
  // ---- bounded production refresh (event-first, adaptive) --------------------------------
  // The Host backfills usage/cost in batches (about once a minute). A panel opened once must not
  // keep the first snapshot forever, but it also must not pull the whole `/state` every tick:
  //  - event-first: reconnect, tab visibility/focus, panel remount → refresh;
  //  - bounded timer while mounted: cheap PROJECTION refresh (usage/findings/error-fingerprints
  //    through existing read-only ops), full `/state` only on events / at a much slower cadence;
  //  - hidden tab / unmounted panel / disposed runtime → no timer, no requests;
  //  - errors back off and keep the last-known values (never cleared), with timestamps + stale flag.
  // Full `/state` is EVENT-ONLY (reconnect/visibility/focus/remount) — there is deliberately no
  // periodic full cadence: the timer is always the cheap projection refresh.
  const REFRESH = {
    projectionMs: 30000,
    focusMinMs: 15000,
    backoffMs: [60000, 120000, 300000],
    minDelayMs: 5000
  };
  const refreshStateInner = {
    running: false,
    suspended: true,
    stopped: false,
    timer: undefined,
    nextAt: undefined,
    attempts: 0,
    coalesced: 0,
    projections: 0,
    full: 0,
    lastAttemptAt: undefined,
    lastSuccessAt: undefined,
    lastError: undefined,
    errorStreak: 0,
    lastReason: undefined,
    inFlight: undefined,
    pendingReason: undefined,
    stale: false,
    visibility: 'unknown',
    // PER-REGION projection freshness/errors: a partial failure must not make cost look newest.
    regions: {
      usage: { at: undefined, error: undefined },
      findings: { at: undefined, error: undefined },
      errorFingerprints: { at: undefined, error: undefined }
    },
    partial: false
  };

  function refreshSnapshotState() {
    const staleAfter = Math.max(REFRESH.projectionMs * 3, 90000);
    const age = refreshStateInner.lastSuccessAt === undefined ? undefined : Date.now() - refreshStateInner.lastSuccessAt;
    return {
      running: refreshStateInner.running,
      suspended: refreshStateInner.suspended,
      stopped: refreshStateInner.stopped,
      policy: { projectionMs: REFRESH.projectionMs, focusMinMs: REFRESH.focusMinMs, backoffMs: REFRESH.backoffMs.slice(), fullRefresh: 'event-only' },
      nextAt: refreshStateInner.nextAt ?? null,
      attempts: refreshStateInner.attempts,
      coalesced: refreshStateInner.coalesced,
      projections: refreshStateInner.projections,
      full: refreshStateInner.full,
      lastAttemptAt: refreshStateInner.lastAttemptAt ?? null,
      lastSuccessAt: refreshStateInner.lastSuccessAt ?? null,
      lastError: refreshStateInner.lastError ?? null,
      errorStreak: refreshStateInner.errorStreak,
      lastReason: refreshStateInner.lastReason ?? null,
      stale: refreshStateInner.stale === true || (age !== undefined && age > staleAfter),
      ageMs: age ?? null,
      partial: refreshStateInner.partial === true,
      regions: {
        usage: { at: refreshStateInner.regions.usage.at ?? null, error: refreshStateInner.regions.usage.error ?? null },
        findings: { at: refreshStateInner.regions.findings.at ?? null, error: refreshStateInner.regions.findings.error ?? null },
        errorFingerprints: { at: refreshStateInner.regions.errorFingerprints.at ?? null, error: refreshStateInner.regions.errorFingerprints.error ?? null }
      },
      transport: typeof bridge.projectionSeq === 'function' ? bridge.projectionSeq() : 0
    };
  }

  function clearRefreshTimer() {
    if (refreshStateInner.timer !== undefined) {
      try {
        if (typeof clearTimeout === 'function') clearTimeout(refreshStateInner.timer);
      } catch {
        /* timer already gone */
      }
      refreshStateInner.timer = undefined;
    }
    refreshStateInner.nextAt = undefined;
  }

  function scheduleRefresh(delayMs) {
    clearRefreshTimer();
    if (disposed || refreshStateInner.stopped === true || refreshStateInner.suspended === true) return;
    const delay = Math.max(REFRESH.minDelayMs, Math.round(delayMs));
    refreshStateInner.nextAt = Date.now() + delay;
    try {
      refreshStateInner.timer = setTimeout(() => {
        refreshStateInner.timer = undefined;
        refreshStateInner.nextAt = undefined;
        void runRefresh('timer');
      }, delay);
    } catch {
      refreshStateInner.timer = undefined;
    }
  }

  /**
   * One bounded refresh pass. Coalesces concurrent callers (a single trailing refresh), counts
   * attempts, backs off on error and keeps the previous projections on failure.
   */
  async function runRefresh(reason) {
    if (disposed || refreshStateInner.stopped === true || refreshStateInner.suspended === true) return { ok: false, code: 'REFRESH_SUSPENDED' };
    if (refreshStateInner.inFlight !== undefined) {
      refreshStateInner.coalesced += 1;
      refreshStateInner.pendingReason = reason;
      return refreshStateInner.inFlight;
    }
    const full = reason === 'reconnect' || reason === 'focus' || reason === 'visibility' || reason === 'mount';
    refreshStateInner.attempts += 1;
    refreshStateInner.lastAttemptAt = Date.now();
    refreshStateInner.lastReason = reason;
    const task = (async () => {
      let result;
      try {
        result = full === true ? await bridge.fetchState() : await (typeof bridge.fetchProjections === 'function' ? bridge.fetchProjections() : bridge.fetchState());
      } catch (error) {
        result = { ok: false, code: tbHelpers.errorText(error) };
      }
      const fullOk = result !== undefined && result.ok === true;
      const partial = result !== undefined && result.partial === true;
      const failures = result !== undefined && Array.isArray(result.failures) ? result.failures : [];
      if (fullOk === true) {
        // EVERY projection (or the full state) succeeded: only then may the whole panel look fresh.
        refreshStateInner.lastSuccessAt = Date.now();
        refreshStateInner.lastError = undefined;
        refreshStateInner.errorStreak = 0;
        refreshStateInner.stale = false;
        refreshStateInner.partial = false;
        if (full === true) refreshStateInner.full += 1; else refreshStateInner.projections += 1;
        const regions = result.regions !== undefined && result.regions !== null && typeof result.regions === 'object' ? result.regions : {};
        for (const region of ['usage', 'findings', 'errorFingerprints']) {
          const at = regions[region] ?? Date.now();
          if (refreshStateInner.regions[region].error !== undefined || refreshStateInner.regions[region].at === undefined) refreshStateInner.regions[region].at = at;
          else refreshStateInner.regions[region].at = at;
          refreshStateInner.regions[region].error = undefined;
        }
        if (typeof invalidateDetailPages === 'function') invalidateDetailPages();
        noteHostRefresh();
      } else if (partial === true) {
        // SOME projections applied: keep the merged data, but per-region freshness + backoff.
        const regions = result.regions !== undefined && result.regions !== null && typeof result.regions === 'object' ? result.regions : {};
        for (const region of ['usage', 'findings', 'errorFingerprints']) {
          const failure = failures.find((entry) => entry !== null && entry !== undefined && entry.region === region);
          if (failure === undefined) {
            if (regions[region] !== undefined) refreshStateInner.regions[region].at = regions[region];
            refreshStateInner.regions[region].error = undefined;
          } else {
            refreshStateInner.regions[region].error = failure.code ?? 'PROJECTION_FAILED';
          }
        }
        refreshStateInner.partial = true;
        refreshStateInner.stale = true;
        refreshStateInner.lastError = failures.length > 0 ? (failures[0].code ?? 'PARTIAL_PROJECTION') : 'PARTIAL_PROJECTION';
        refreshStateInner.errorStreak += 1;
        // NOTE: lastSuccessAt is deliberately NOT advanced — the failed region (e.g. cost) is stale.
      } else {
        refreshStateInner.lastError = result === undefined ? 'NO_RESULT' : (result.code ?? 'REFRESH_FAILED');
        const failing = failures.length > 0 ? failures : [{ region: 'usage', code: refreshStateInner.lastError }, { region: 'findings', code: refreshStateInner.lastError }, { region: 'errorFingerprints', code: refreshStateInner.lastError }];
        for (const failure of failing) {
          if (failure !== null && failure !== undefined && refreshStateInner.regions[failure.region] !== undefined) refreshStateInner.regions[failure.region].error = failure.code ?? refreshStateInner.lastError;
        }
        refreshStateInner.errorStreak += 1;
        refreshStateInner.stale = true;
        refreshStateInner.partial = false;
      }
      refreshStateInner.inFlight = undefined;
      const pending = refreshStateInner.pendingReason;
      refreshStateInner.pendingReason = undefined;
      // Schedule the next tick: fast cadence while healthy, backoff on any failure/partial, else none.
      if (disposed || refreshStateInner.stopped === true || refreshStateInner.suspended === true) {
        clearRefreshTimer();
      } else if (fullOk !== true) {
        const backoff = REFRESH.backoffMs[Math.min(Math.max(refreshStateInner.errorStreak - 1, 0), REFRESH.backoffMs.length - 1)];
        scheduleRefresh(backoff);
      } else {
        scheduleRefresh(REFRESH.projectionMs);
      }
      if (pending !== undefined && fullOk === true) void runRefresh(pending);
      return result;
    })();
    refreshStateInner.inFlight = task;
    return task;
  }

  /** Event-first entry point (reconnect / focus / visibility / manual). Coalesced + bounded. */
  function requestRefresh(reason, options) {
    if (disposed || refreshStateInner.stopped === true) return Promise.resolve({ ok: false, code: 'REFRESH_STOPPED' });
    const opts = options ?? {};
    if (opts.minIntervalMs !== undefined) {
      const since = refreshStateInner.lastAttemptAt === undefined ? Infinity : Date.now() - refreshStateInner.lastAttemptAt;
      if (since < opts.minIntervalMs) return Promise.resolve({ ok: false, code: 'REFRESH_THROTTLED' });
    }
    refreshStateInner.suspended = false;
    refreshStateInner.running = true;
    return runRefresh(String(reason ?? 'manual'));
  }

  function pauseRefresh(whyReason) {
    refreshStateInner.running = false;
    refreshStateInner.suspended = true;
    clearRefreshTimer();
    refreshStateInner.lastReason = whyReason ?? 'unmounted';
  }

  function resumeRefresh() {
    if (disposed || refreshStateInner.stopped === true) return;
    refreshStateInner.running = true;
    refreshStateInner.suspended = false;
    if (refreshStateInner.inFlight === undefined) scheduleRefresh(REFRESH.minDelayMs);
  }

  function stopRefresh() {
    refreshStateInner.stopped = true;
    refreshStateInner.running = false;
    refreshStateInner.suspended = true;
    clearRefreshTimer();
  }

  // Declared (not implicit globals): the focused pane's SessionTarget, and the picker
  // callback the panel registers so a pane's 「切换」 action can open the overlay.
  let activeTarget;
  let requestPicker;
  // Teardown state: `disposed` gates every public entry point, `heldRefs` are the
  // SessionReferences this runtime handed out and must release on teardown.
  let disposed = false;
  const heldRefs = new Set();
  // autonomy-v1 §八 per-member state: instruction acknowledgements (so a pane shows ITS OWN
  // attribution) and explicit user pauses. `userPaused` is only ever cleared by the user
  // pressing 「恢复派发」 — no automatic wake-up, layout change or reconnect clears it.
  const instructionAcks = new Map();
  const userPaused = new Set();

  function layout() {
    return pinned.instance.getSnapshot();
  }

  function noteError(where, error) {
    const message = tbHelpers.errorText(error);
    diagnostics.errors.push({ where, message, at: Date.now() });
    if (diagnostics.errors.length > 20) diagnostics.errors.shift();
    return message;
  }

  function paneForSession(sessionId) {
    return layout().panes.find((pane) => tbTargetSessionId(pane.target) === sessionId);
  }

  /**
   * The pane that DISPLAYS one session (surface v2): either it is bound to it as its
   * workspace target, or it opened it as its second-level view. Two panes may therefore share
   * the same workspace target as long as they show DIFFERENT children (that is how four
   * members of one team stay side by side), while the same displayed session still never gets
   * two editors.
   */
  function paneDisplaying(sessionId) {
    return layout().panes.find((pane) => {
      if (pane.view !== null && pane.view !== undefined) return pane.view.childSessionId === sessionId;
      return pane.target !== null && pane.target.sessionId === sessionId;
    });
  }

  function firstFreePane() {
    const panes = layout().panes;
    const visible = panes.slice(0, layout().mode);
    return visible.find((pane) => pane.target === null) ?? panes.find((pane) => pane.target === null);
  }

  function ensureVisible(paneId) {
    const needed = tbModeForPane(paneId);
    if (layout().mode < needed) actions.setMode(needed);
  }

  function targetForSession(sessionId) {
    let address;
    try {
      address = ctx.sessions.subagentAddress(sessionId);
    } catch (error) {
      noteError('subagentAddress', error);
      address = undefined;
    }
    return tbTargetFromSession(sessionId, address);
  }

  /**
   * Read-layer leaf probe (kept for diagnostics): true only on POSITIVE leaf evidence.
   * See {@link classifySession} for the fail-closed decision.
   */
  function isLeafSession(sessionId) {
    return classifySession(sessionId).verdict === 'leaf';
  }

  /**
   * Is this id a TEAMMATE session of the current team per the `agentTeam` projection?
   *
   * SURFACE v2: the team LEAD session is a workspace main session (nativeTeamId =
   * rootSessionId, `subagent === null`) and must keep classifying as `main` — it is a legal
   * pane target and the migration target for member-bound panes. Only `role === 'member'`
   * (teammates) belong to the member whitelist. The v1 code included `'lead'` here, which made
   * classifySession(lead) === 'member' and silently broke both `bindTarget` (lead became
   * unbindable) and `migratePaneIfMember` (its target check required the lead to be `main`).
   */
  function isTeamMemberSession(sessionId) {
    try {
      const index = tbBuildTeamIndex(ctx.sessions.list.getSnapshot());
      const info = index.roleBySession[sessionId];
      return info !== undefined && info.role === 'member';
    } catch (error) {
      noteError('teamIndex', error);
      return false;
    }
  }

  /** Fresh team index (a plain read; the session list is the source of truth). */
  function teamIndexNow() {
    try {
      return tbBuildTeamIndex(ctx.sessions.list.getSnapshot());
    } catch (error) {
      noteError('teamIndex', error);
      return { teams: [], roleBySession: Object.create(null), activeTaskByOwner: Object.create(null) };
    }
  }

  /**
   * The SECOND-LEVEL session list of one workspace session (surface v2). This is the ONLY
   * set from which a child may be opened / retained: a member or subagent that is not in it
   * can never be rendered, so the drill-in path cannot become a hidden binding route.
   */
  function childrenOf(sessionId) {
    return tbSessionChildren(ctx.sessions.list.getSnapshot(), teamIndexNow(), sessionId);
  }

  /**
   * FAIL-CLOSED classification of one session id. Bindability requires POSITIVE evidence:
   *
   *   'member'  — the `agentTeam` projection lists it as a TEAMMATE (authoritative whitelist;
   *               the team LEAD is NOT in it — it is a workspace main session, see
   *               `isTeamMemberSession`);
   *   'main'    — positive non-leaf evidence: a live binding whose `subagent` reads exactly
   *               `null` (the contract's "top-level session" marker), or a catalog row with
   *               `origin !== 'subagent'`, no `parentId`, and no `subagent` projection;
   *   'leaf'    — positive leaf evidence (`subagent != null`, `origin === 'subagent'`, …);
   *   'unknown' — no evidence at all (including a snapshot whose `subagent` key is MISSING:
   *               that is a malformed/stale shape, not proof of a main session). NOT bindable.
   *
   * 'unknown' is deliberately non-destructive: the target stays in the store and the pane
   * re-judges when the session list / projections arrive, so a legitimate member session
   * that simply has not loaded yet recovers automatically instead of being dropped.
   */
  function classifySession(sessionId) {
    if (sessionId === undefined) return { verdict: 'unknown', evidence: 'no-session-id' };
    if (isTeamMemberSession(sessionId)) return { verdict: 'member', evidence: 'agentTeam.members' };
    try {
      const binding = ctx.sessions.binding(sessionId);
      const snapshot = binding === undefined ? undefined : binding.session.getSnapshot();
      if (snapshot !== undefined && snapshot !== null && typeof snapshot === 'object') {
        // Contract: `subagent` is REQUIRED (`{address, parentAvailable?} | null`).
        //   explicit `null`            → positive proof of a top-level (main) session;
        //   an object                  → positive proof of a child (leaf);
        //   missing / undefined / other → MALFORMED: no evidence at all. This is decisive and
        //   must NOT fall through to the catalog row — otherwise a stale/partial snapshot
        //   would still let a subagent be bound into a pane (the one hole the Lead flagged).
        if (snapshot.subagent === null) return { verdict: 'main', evidence: 'binding.subagent===null' };
        if (typeof snapshot.subagent === 'object') return { verdict: 'leaf', evidence: 'binding.subagent' };
        return { verdict: 'unknown', evidence: 'binding.subagent-malformed' };
      }
    } catch (error) {
      noteError('binding', error);
    }
    const row = ctx.sessions.list.getSnapshot()?.byId?.[sessionId];
    if (row !== undefined && row !== null) {
      if (row.origin === 'subagent') return { verdict: 'leaf', evidence: 'list.origin' };
      if (row.parentId !== undefined && row.parentId !== null) return { verdict: 'leaf', evidence: 'list.parentId' };
      const projected = row.projectionValues;
      if (projected !== undefined && projected !== null && projected.subagent !== undefined && projected.subagent !== null) {
        return { verdict: 'leaf', evidence: 'list.subagent' };
      }
      return { verdict: 'main', evidence: 'list.row' };
    }
    return { verdict: 'unknown', evidence: 'no-evidence' };
  }

  function classifyTarget(target) {
    return classifySession(tbTargetSessionId(target));
  }

  /**
   * The single place that arms/disarms the compat bridge's target. It is order-independent
   * on purpose: mount, panel activation and focus changes all funnel through here, so the
   * bridge only ever sees a target while the panel is BOTH mounted and the active main panel
   * (A2) — and an unmount clears it even if the panel is remounted later.
   *
   * No-op after `dispose()`: a disposed runtime must be unable to (re-)arm the bridge, so a
   * stale panel reference can never produce `openSession`/`selectPanel` after teardown.
   */
  function syncBridgeTarget() {
    if (disposed) return;
    compat.setActiveTarget(panelActive && panelMounted ? activeTarget : undefined);
  }

  /**
   * The ONE teardown path, shared by the plugin effect's cleanup and the public
   * `runtime.dispose()`. It used to be that `dispose()` only logged diagnostics while the
   * effect cleanup did the real work — a "fake dispose" that made callers believe the bridge
   * was dead while it still armed and still called `openSession`. Calling it twice (in either
   * order, including after `compat.dispose()`/`bridge.dispose()`) is safe.
   */
  function teardown() {
    if (disposed) return;
    disposed = true;
    // 1) stop this runtime from arming anything, then clear the bridge.
    panelMounted = false;
    panelActive = false;
    activeTarget = undefined;
    requestPicker = undefined;
    try {
      compat.setActiveTarget(undefined);
    } catch (error) {
      noteError('teardown.target', error);
    }
    // 2) destroy the bridge (idempotent: its own dispose() is guarded).
    try {
      compat.dispose();
    } catch (error) {
      noteError('teardown.compat', error);
    }
    // 3) release every SessionReference this runtime still holds. The pane cleanups release
    //    their own references first (with their `released` flag), and `release()` is
    //    idempotent, so a double release cannot happen from here.
    const held = [...heldRefs];
    heldRefs.clear();
    for (const reference of held) {
      try {
        if (reference !== null && reference !== undefined && typeof reference.release === 'function') reference.release();
      } catch (error) {
        noteError('teardown.release', error);
      }
    }
  }

  /**
   * THE last gate (client side is the final authority: the host `team_layout` tool may
   * still write a subagent address, so a host record must not be trusted to be bindable).
   *
   * SURFACE v2: a pane target is bindable iff it has POSITIVE evidence of being a workspace
   * MAIN session. A team member is NOT a pane target any more (it is only reachable as the
   * second-level view of its workspace session), and a leaf was never one.
   */
  function isTargetBindable(target) {
    return classifyTarget(target).verdict === 'main';
  }

  /**
   * A `{parentSessionId, childSessionId, mode}` address that is CURRENTLY the second-level
   * view of a bound pane. Only such an address may be handed to the compat focus bridge, so
   * the bridge can follow what the user actually sees without becoming a leaf bypass.
   */
  function isKnownChildTarget(target) {
    if (!target || typeof target !== 'object' || target.kind !== 'subagent') return false;
    const parentSessionId = target.parentSessionId;
    const childSessionId = target.childSessionId;
    if (typeof parentSessionId !== 'string' || typeof childSessionId !== 'string') return false;
    const panes = layout().panes;
    const bound = panes.some((pane) => pane.target !== null && pane.target.sessionId === parentSessionId && pane.view !== null && pane.view.childSessionId === childSessionId);
    if (!bound) return false;
    return childrenOf(parentSessionId).some((child) => child.id === childSessionId);
  }


  /**
   * The user's REAL Workspace list — the same source the shell's own session list groups by:
   * `workspaces.list.getSnapshot()` = `{ items: [{ workspaceId, title, path, sessionIds, createdAt }],
   * archivedSessionIds }`.
   *
   * Used ONLY to group the session picker like the shell sidebar (surface v2). A missing
   * service degrades to "no groups" (every session renders under 未分组) instead of hiding the
   * picker or inventing workspace names. Nothing is fabricated: a group's title comes from the
   * Workspace record, and an empty group is dropped by the caller.
   */
  function workspaceGroups() {
    try {
      const workspaces = typeof ctx.get === 'function' ? ctx.get('workspaces') : undefined;
      const source = workspaces !== undefined && workspaces !== null ? workspaces : ctx.workspaces;
      const snapshot = source !== undefined && source !== null && source.list !== undefined ? source.list.getSnapshot() : undefined;
      const items = snapshot !== undefined && snapshot !== null && Array.isArray(snapshot.items) ? snapshot.items : [];
      const groups = [];
      for (const item of items) {
        if (item === null || typeof item !== 'object' || typeof item.workspaceId !== 'string') continue;
        const title = typeof item.title === 'string' && item.title !== '' ? item.title : (typeof item.path === 'string' && item.path !== '' ? item.path : item.workspaceId);
        groups.push({
          workspaceId: item.workspaceId,
          title,
          path: typeof item.path === 'string' ? item.path : '',
          sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.map(String) : []
        });
      }
      return groups;
    } catch (error) {
      noteError('workspaces', error);
      return [];
    }
  }

  /**
   * B4: archived session ids, read from the workspace controller (public `workspaces`
   * service: `list.getSnapshot().archivedSessionIds`). The picker and the auto-bind are the
   * only consumers, and both re-evaluate on every session-list change, so a plain read is
   * enough (no extra subscription). When the service or the field is unavailable the filter
   * degrades to "nothing known as archived" — that is reported in `diagnostics.archivedSource`
   * rather than silently pretending the filter works.
   */
  function archivedSessionIds() {
    try {
      const workspaces = typeof ctx.get === 'function' ? ctx.get('workspaces') : undefined;
      const source = workspaces !== undefined && workspaces !== null ? workspaces : ctx.workspaces;
      const list = source !== undefined && source !== null && source.list !== undefined ? source.list.getSnapshot() : undefined;
      const ids = list !== undefined && list !== null && Array.isArray(list.archivedSessionIds) ? list.archivedSessionIds : undefined;
      if (ids === undefined) {
        diagnostics.archivedSource = 'unavailable';
        return [];
      }
      diagnostics.archivedSource = 'workspaces.list.archivedSessionIds';
      return ids;
    } catch (error) {
      noteError('archivedSessionIds', error);
      diagnostics.archivedSource = 'error';
      return [];
    }
  }

  /**
   * Member autonomy (autonomy-v1 §八) — READ ONLY, straight from the Host `/state` payload.
   * Nothing is fabricated: `tbAutonomyFor` reports which contract fields the Host did not send
   * and the pane renders "未提供" for them.
   */
  function autonomyFor(sessionId) {
    const hostState = bridge.snapshotSource.getSnapshot();
    const snapshot = hostState !== null && hostState !== undefined ? hostState.snapshot : undefined;
    return tbAutonomyFor(snapshot, sessionId);
  }

  /**
   * Host-paginated detail pages (coordinator revision R2). The client NEVER slices a full ledger
   * from `/state`: long lists are fetched page by page from the host detail interface, cached per
   * (section, kind, owner, page), and re-rendered when the answer lands. Every request is a GET —
   * no model call, no dispatch, no log rescan.
   */
  const detailPages = new Map();

  function detailKey(options) {
    return [options.section, options.kind, options.ownerMemberId ?? '', String(options.page), String(options.pageSize)].join('|');
  }

  /**
   * Drop cached detail pages. Called when a NEW snapshot is published: a page rendered from the
   * previous snapshot may be stale (finished work, changed claim level, new errors). Re-fetching the
   * currently visible page is bounded (one GET per visible list) and stays read-only.
   */
  let detailGeneration = 0;

  /**
   * Drop cached detail pages and bump the generation. The generation is part of every list's effect
   * deps, so already-mounted lists re-fetch their VISIBLE page after a snapshot refresh (otherwise
   * they would sit on a cleared cache forever). Bounded: one read-only GET per visible list.
   */
  function invalidateDetailPages() {
    detailPages.clear();
    detailGeneration += 1;
  }

  // ---- frontend activation ACK (CONTRACT §8.3 + Lead round-21/22 corrections) -----------------
  // Host schema (`service.recordFrontendAck`) is the single authority — it reads:
  //   request.bundle.url, request.bundle.activatedAt, request.frontendRev, request.mounted === true
  // and persists `{bundleUrl, activatedAt, firstAckAt, lastAckAt, mounted, frontendRev, count,
  // persisted, detailTransport}` (it currently DROPS `renderedRegions`; we still send them as
  // read-only evidence for the next Host revision and keep them in diagnostics).
  //
  // Bundle identity: the OFFICIAL client loader appends a classic <script src="…?rev=…"> and the
  // factory is materialized LATER. The builder therefore captures `document.currentScript.src` at
  // SCRIPT EXECUTION time into this factory closure (`__tbSelfBundle`, plain script, no
  // import.meta) and embeds a stable source digest. In addition the loader's real registration
  // records the ACTUAL factory rev in `modules.factories.get(id)?.rev`
  // (dsh-client-modules/lib/client.js:577-580) — that is the loaded revision, unlike
  // `manifest`/`reloadTargets` which may only announce a pending one. There is NO `onRebuilt`
  // method on the frontend client; an HMR rev announcement must NEVER let this old runtime claim
  // the new code is loaded: the instance metadata is frozen for this instance's lifetime.
  const SELF_MODULE_ID = '@local/dsh-team-workbench';
  const ACK_MAX_ATTEMPTS_PER_EPOCH = 2;
  const ACK_REGION_IDS = ['cost', 'findings', 'usage', 'errors'];

  function tbParseBundleRev(url) {
    if (typeof url !== 'string' || url === '') return undefined;
    const match = url.match(/[?&]rev=([^&#]*)/);
    if (match === null) return undefined;
    try {
      const rev = decodeURIComponent(match[1]);
      return rev === '' ? undefined : rev;
    } catch {
      return match[1] === '' ? undefined : match[1];
    }
  }

  /** Frozen instance identity: load-closure capture + the loader's ACTUAL registered factory rev. */
  const selfBundleMeta = (() => {
    const captured = typeof __tbSelfBundle !== 'undefined' && __tbSelfBundle !== null ? __tbSelfBundle : undefined;
    const url = captured !== undefined && typeof captured.url === 'string' && captured.url !== '' ? captured.url : undefined;
    const sourceDigest = captured !== undefined && typeof captured.sourceDigest === 'string' && captured.sourceDigest !== '' ? captured.sourceDigest : undefined;
    let rev = tbParseBundleRev(url);
    let revSource = rev === undefined ? undefined : 'load-url';
    try {
      const modulesService = typeof ctx.get === 'function' ? ctx.get('modules') : undefined;
      const factories = modulesService === undefined || modulesService === null ? undefined : modulesService.factories;
      const registered = factories !== null && factories !== undefined && typeof factories.get === 'function' ? factories.get(SELF_MODULE_ID) : undefined;
      const registeredRev = registered === null || registered === undefined ? undefined : registered.rev;
      if (typeof registeredRev === 'string' && registeredRev !== '') {
        rev = registeredRev;
        revSource = 'modules.factories';
      }
    } catch {
      /* optional metadata only */
    }
    return Object.freeze({
      url: url ?? null,
      rev: rev ?? null,
      revSource: revSource ?? null,
      sourceDigest: sourceDigest ?? null,
      source: url === undefined ? 'unavailable' : (revSource === 'modules.factories' ? 'load-closure+factories' : 'load-closure')
    });
  })();

  function selfBundle() {
    const captured = tbSelfBundleCapture();
    const effectiveRev = selfBundleMeta.rev ?? captured.rev;
    return {
      url: selfBundleMeta.url ?? captured.url,
      rev: effectiveRev,
      revSource: selfBundleMeta.revSource ?? captured.revSource,
      sourceDigest: selfBundleMeta.sourceDigest ?? captured.sourceDigest,
      source: selfBundleMeta.source !== 'unavailable' ? selfBundleMeta.source : captured.source
    };
  }

  // In-flight guard for the ack POST: module-scope let (NOT a global), initialized before any
  // effect can run. Missing this declaration previously caused
  // `EFFECT THROW :: frontendAckInFlight is not defined`.
  let frontendAckInFlight = false;

  const frontendAck = {
    mounted: { main: false },
    renderedRegions: [],
    epoch: undefined,
    attempts: 0,
    sent: false,
    code: undefined,
    activatedAt: undefined,
    lastAckAt: undefined,
    capabilityRetryPending: false,
    refreshSeen: 0,
    regionFollowUpSent: false
  };

  function ackEpoch() {
    try {
      return bridge.capabilityVersion();
    } catch {
      return 'unknown';
    }
  }

  function resetAckEpoch(epoch) {
    frontendAck.epoch = epoch;
    frontendAck.attempts = 0;
    frontendAck.sent = false;
    frontendAck.code = undefined;
    frontendAck.regionFollowUpSent = false;
  }

  /** Host-facing payload (exact `recordFrontendAck` field reads) + read-only region evidence. */
  function ackPayload(reason) {
    const epoch = ackEpoch();
    if (frontendAck.epoch !== epoch) resetAckEpoch(epoch);
    return {
      bundle: {
        url: selfBundleMeta.url,
        activatedAt: frontendAck.activatedAt ?? null,
        sourceDigest: selfBundleMeta.sourceDigest
      },
      frontendRev: selfBundleMeta.rev,
      mounted: true,
      detailTransport: bridge.detailTransport() ?? null,
      renderedRegions: frontendAck.renderedRegions.slice(),
      capabilityVersion: epoch,
      reason
    };
  }

  function postFrontendAck(reason) {
    if (disposed) return;
    // Never send without a real mount commit.
    if (frontendAck.mounted.main !== true) return;
    if (frontendAckInFlight === true) return;
    if (frontendAck.attempts >= ACK_MAX_ATTEMPTS_PER_EPOCH) return;
    frontendAck.attempts += 1;
    frontendAckInFlight = true;
    const payload = ackPayload(reason);
    Promise.resolve(bridge.clientAck(payload)).then((result) => {
      frontendAckInFlight = false;
      frontendAck.sent = result !== undefined && result.ok === true;
      frontendAck.code = result === undefined ? 'NO_RESULT' : result.code;
      frontendAck.lastAckAt = Date.now();
      diagnostics.clientAck = {
        ok: frontendAck.sent,
        code: frontendAck.code,
        epoch: payload.capabilityVersion,
        attempts: frontendAck.attempts,
        reason,
        bundleUrl: payload.bundle.url,
        frontendRev: payload.frontendRev,
        mounted: payload.mounted,
        renderedRegions: payload.renderedRegions,
        persisted: result !== undefined && result.value !== undefined && result.value !== null ? (result.value.ack && typeof result.value.ack === 'object' ? result.value.persisted === true : undefined) : undefined,
        at: frontendAck.lastAckAt
      };
    }, (error) => {
      frontendAckInFlight = false;
      frontendAck.code = tbHelpers.errorText(error);
      diagnostics.clientAck = { ok: false, code: frontendAck.code, epoch: payload.capabilityVersion, attempts: frontendAck.attempts, reason, at: Date.now() };
    });
  }

  /** A real component mount (commit) — the ONLY place that establishes activation. */
  function noteFrontendMount(name) {
    if (disposed) return;
    const key = String(name ?? 'main');
    const remount = frontendAck.mounted[key] !== true;
    frontendAck.mounted[key] = true;
    if (frontendAck.activatedAt === undefined) frontendAck.activatedAt = Date.now();
    frontendAck.regionFollowUpSent = false;
    const epoch = ackEpoch();
    if (frontendAck.epoch !== epoch) resetAckEpoch(epoch);
    if (remount) {
      // A real REMOUNT is a new activation window: a previous successful ack must not mute it, and
      // the bounded attempt budget restarts for this mount (Host dedupes by bundle.url+activatedAt).
      frontendAck.sent = false;
      frontendAck.attempts = 0;
      frontendAck.capabilityRetryPending = false;
      postFrontendAck('mount');
      return;
    }
    if (frontendAck.sent === true && frontendAck.capabilityRetryPending !== true) return;
    frontendAck.capabilityRetryPending = false;
    postFrontendAck('mount');
  }

  /** Real unmount: no later ack may claim mounted until a genuine remount. */
  function noteFrontendUnmount(name) {
    frontendAck.mounted[String(name ?? 'main')] = false;
  }

  /** A rendered Host projection region (`cost`/`findings`/`usage`/`errors`), real commit only. */
  function noteFrontendRendered(region) {
    if (disposed) return;
    const key = typeof region === 'string' ? region : '';
    if (ACK_REGION_IDS.indexOf(key) < 0) return;
    if (frontendAck.mounted.main !== true) return;
    if (frontendAck.renderedRegions.indexOf(key) < 0) {
      if (frontendAck.renderedRegions.length >= ACK_REGION_IDS.length) frontendAck.renderedRegions.shift();
      frontendAck.renderedRegions.push(key);
    }
    if (frontendAck.sent !== true) {
      postFrontendAck('rendered');
      return;
    }
    if (frontendAck.capabilityRetryPending === true) {
      const epoch = ackEpoch();
      if (frontendAck.epoch !== epoch) resetAckEpoch(epoch);
      frontendAck.capabilityRetryPending = false;
      postFrontendAck('capability-changed');
      return;
    }
    if (frontendAck.regionFollowUpSent !== true) {
      frontendAck.regionFollowUpSent = true;
      frontendAck.attempts = 0;
      postFrontendAck('rendered-regions');
    }
  }

  /** Successful `/state` refresh: records the capability delta only — never sends an ack itself. */
  function noteHostRefresh() {
    frontendAck.refreshSeen += 1;
    if (frontendAck.mounted.main !== true) return;
    const epoch = ackEpoch();
    if (epoch !== frontendAck.epoch) frontendAck.capabilityRetryPending = true;
  }

  /** Read-only view (diagnostics / owner-state evidence; no account data). */
  function frontendAckState() {
    return {
      bundle: {
        url: selfBundleMeta.url,
        rev: selfBundleMeta.rev,
        revSource: selfBundleMeta.revSource,
        sourceDigest: selfBundleMeta.sourceDigest,
        source: selfBundleMeta.source,
        activatedAt: frontendAck.activatedAt ?? null
      },
      frontendRev: selfBundleMeta.rev,
      mounted: { main: frontendAck.mounted.main === true },
      renderedRegions: frontendAck.renderedRegions.slice(),
      epoch: frontendAck.epoch ?? null,
      attempts: frontendAck.attempts,
      sent: frontendAck.sent,
      code: frontendAck.code ?? null,
      activatedAt: frontendAck.activatedAt ?? null,
      lastAckAt: frontendAck.lastAckAt ?? null,
      capabilityRetryPending: frontendAck.capabilityRetryPending,
      refreshSeen: frontendAck.refreshSeen
    };
  }

  /** Cached host page for a section (undefined until requested). */
  function detailPageFor(options) {
    return detailPages.get(detailKey(options));
  }

  /**
   * Ensure one host detail page is loaded. Idempotent while a request is in flight (the pending
   * record is reused), so expanding details twice cannot double-fetch.
   */
  function ensureDetailPage(options) {
    if (disposed) return Promise.resolve({ ok: false, code: 'CLIENT_DISPOSED' });
    const key = detailKey(options);
    const cached = detailPages.get(key);
    if (cached !== undefined) {
      if (cached.state === 'loaded' || cached.state === 'loading') return Promise.resolve(cached);
    }
    const record = { state: 'loading', page: tbHostPage(undefined), error: undefined, options };
    detailPages.set(key, record);
    return bridge.fetchDetail(options).then((result) => {
      if (result !== undefined && result.ok === true) {
        const page = tbHostPage(result.value);
        if (page === undefined) {
          record.state = 'unavailable';
          record.error = 'DETAIL_SHAPE_UNKNOWN';
        } else {
          record.state = 'loaded';
          record.page = page;
        }
      } else {
        record.state = 'unavailable';
        record.error = result === undefined ? 'NO_RESULT' : result.code;
      }
      detailPages.set(key, record);
      diagnostics.lastHostOp = { op: 'detail:' + options.section + '/' + options.kind, ok: record.state === 'loaded', code: record.error, at: Date.now() };
      return record;
    }, (error) => {
      record.state = 'unavailable';
      record.error = noteError('detail', error);
      detailPages.set(key, record);
      return record;
    });
  }

  /**
   * Deliver the user's instruction to THIS member session (never to the lead on its behalf).
   * The Host enqueues a `user_instruction` event and wakes that member's real turn; the ack is
   * recorded per member so the pane can show "已发给成员 X" without leaking into other panes.
   */
  function sendUserInstruction(sessionId, text) {
    if (disposed) return Promise.resolve({ ok: false, code: 'CLIENT_DISPOSED' });
    if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve({ ok: false, code: 'NO_TARGET' });
    if (typeof text !== 'string' || text.trim() === '') return Promise.resolve({ ok: false, code: 'EMPTY_TEXT' });
    // A leaf is not a member: the instruction path must not become a subagent bypass (§7).
    const classification = classifySession(sessionId);
    if (classification.verdict === 'leaf') return Promise.resolve({ ok: false, code: 'LEAF_NOT_BINDABLE' });
    return bridge.userInstruction(sessionId, text.trim()).then((result) => {
      // Flat, UI-ready record: the pane renders `ack.ok` / `ack.code` directly (a nested
      // `{ack:{…}}` shape made a successful send display the failure line).
      const ack = {
        ok: result !== undefined && result.ok === true,
        code: result === undefined ? 'NO_RESULT' : result.code,
        eventId: result !== undefined && result.value !== undefined ? result.value.eventId : undefined,
        memberId: result !== undefined && result.value !== undefined ? result.value.memberId : undefined,
        sessionId,
        text: text.trim(),
        at: Date.now()
      };
      instructionAcks.set(sessionId, ack);
      diagnostics.lastHostOp = { op: 'user_instruction', ok: ack.ok, code: ack.code, at: ack.at };
      return ack;
    }, (error) => {
      const ack = { ok: false, code: noteError('user_instruction', error), sessionId, text: text.trim(), at: Date.now() };
      instructionAcks.set(sessionId, ack);
      diagnostics.lastHostOp = { op: 'user_instruction', ok: false, code: ack.code, at: ack.at };
      return ack;
    });
  }

  /**
   * The four DISTINCT control semantics required by §八, sent as four distinct ops so the Host
   * can never conflate them:
   *   stopTurn       → only this member's current turn (authorized work survives)
   *   pauseDispatch  → future dispatch for this member, marked `by:'user'`
   *   resumeDispatch → the ONLY way that pause is lifted (an explicit user action)
   *   cancelWork     → not-yet-started future dispatch (never a running attempt)
   *   stopTeam       → team-level stop
   *
   * Client-side rule: a user pause is recorded and NEVER auto-cleared — no code path calls
   * `resumeDispatch` except the user pressing 「恢复派发」, and layout/pane changes never send a
   * control op at all.
   */
  function memberControl(op, args) {
    if (disposed) return Promise.resolve({ ok: false, code: 'CLIENT_DISPOSED' });
    return bridge.control(op, args).then((result) => {
      const ok = result !== undefined && result.ok === true;
      const code = result === undefined ? 'NO_RESULT' : result.code;
      diagnostics.lastHostOp = { op, ok, code, at: Date.now() };
      return { ok, code, op };
    }, (error) => {
      const code = noteError(op, error);
      diagnostics.lastHostOp = { op, ok: false, code, at: Date.now() };
      return { ok: false, code, op };
    });
  }

  const runtime = {
    t,
    bridge,
    compat,
    actions,
    layoutSource,
    layout,
    diagnostics,
    isLeafSession,
    isTargetBindable,
    classifyTarget,
    archivedSessionIds,
    workspaceGroups,
    setPickerRequestHandler(handler) {
      requestPicker = typeof handler === 'function' ? handler : undefined;
    },
    /** Only entry point the pane's single 「切换」 action needs. */
    requestPicker(paneId) {
      if (disposed) return;
      if (requestPicker !== undefined) requestPicker(paneId);
    },
    // ---- autonomy-v1 §八: member decisions + user control ----
    autonomyFor,
    // ---- 工作台运行状态 R2: host-paginated detail pages (read-only GET, cached per page) ----
    ensureDetailPage,
    detailPageFor,
    detailGeneration() {
      return detailGeneration;
    },
    noteFrontendMount,
    noteFrontendUnmount,
    noteFrontendRendered,
    noteHostRefresh,
    frontendAckState,
    selfBundle,
    instructionAckFor(sessionId) {
      return instructionAcks.get(sessionId);
    },
    isUserPaused(sessionId) {
      return userPaused.has(sessionId);
    },
    sendUserInstruction,
    /** Stop this member's current turn only (authorized work and other members are untouched). */
    stopTurn(sessionId) {
      return memberControl('stop_turn', { sessionId }).then((result) => {
        actions.notify(result.ok ? t('notice.turnStopped') : tbFormat(t, 'notice.controlFailed', { code: result.code }));
        return result;
      });
    },
    /**
     * Pause this member's FUTURE dispatch. The pause is recorded client-side as an explicit
     * user pause and is only lifted by `resumeDispatch` (never by a reconnect, a reconnect
     * compat payload, a layout change or an incoming event).
     */
    pauseDispatch(sessionId) {
      userPaused.add(sessionId);
      return memberControl('pause_dispatch', { by: 'user', scope: 'member', sessionId }).then((result) => {
        if (!result.ok) userPaused.delete(sessionId);
        actions.notify(result.ok ? t('notice.dispatchPaused') : tbFormat(t, 'notice.controlFailed', { code: result.code }));
        return result;
      });
    },
    /** The ONLY path that lifts a user pause — an explicit user action. */
    resumeDispatch(sessionId) {
      return memberControl('resume_dispatch', { by: 'user', scope: 'member', sessionId }).then((result) => {
        if (result.ok) userPaused.delete(sessionId);
        actions.notify(result.ok ? t('notice.dispatchResumed') : tbFormat(t, 'notice.controlFailed', { code: result.code }));
        return result;
      });
    },
    /** Cancel not-yet-started future dispatch (never kills a running attempt). */
    cancelWork(sessionId, workIds) {
      return memberControl('cancel_work', { sessionId, ...(Array.isArray(workIds) ? { workIds } : {}) }).then((result) => {
        actions.notify(result.ok ? t('notice.workCancelled') : tbFormat(t, 'notice.controlFailed', { code: result.code }));
        return result;
      });
    },
    /** Team-level stop: distinct from stopping one turn / cancelling one work item. */
    stopTeam(teamKey) {
      return memberControl('stop_team', { ...(typeof teamKey === 'string' && teamKey !== '' ? { teamKey } : {}) }).then((result) => {
        actions.notify(result.ok ? t('notice.teamStopped') : tbFormat(t, 'notice.controlFailed', { code: result.code }));
        return result;
      });
    },
    setPanelActive(active) {
      if (disposed) return;
      panelActive = active === true;
      syncBridgeTarget();
    },
    /**
     * A2: the panel reports its own mount/unmount. While it is unmounted the bridge must not
     * act at all — a reconnect arriving after unmount used to call `openSession` +
     * `selectPanel('team-workbench')` with a stale target and steal the centre column back.
     * No-op after `dispose()` (a disposed runtime can never re-arm).
     */
    setPanelMounted(mounted) {
    // NOTE: the activation-ack mount flag is driven ONLY by the component commit effects
    // (noteFrontendMount/noteFrontendUnmount); setPanelMounted must not fake a mount.
      if (disposed) return;
      panelMounted = mounted === true;
      syncBridgeTarget();
      // Production refresh lifecycle follows the real mount: unmounted panels never poll.
      if (panelMounted === true) resumeRefresh(); else pauseRefresh('unmounted');
    },
    /** Event-first refresh (reconnect/focus/visibility); coalesced + bounded by the controller. */
    requestRefresh(reason, options) {
      return requestRefresh(reason, options);
    },
    /** Read-only refresh diagnostics (timestamps/stale/backoff; no account data). */
    refreshState() {
      return refreshSnapshotState();
    },
    /** Tab visibility input from the panel/shell lifecycle (no global listener invented here). */
    noteHostVisibility(visibility) {
      if (disposed) return;
      refreshStateInner.visibility = String(visibility ?? 'unknown');
      if (refreshStateInner.visibility === 'hidden') {
        pauseRefresh('hidden');
        return;
      }
      resumeRefresh();
      void requestRefresh('visibility', { minIntervalMs: REFRESH.focusMinMs });
    },
    /** A2: host compat arrives asynchronously; without a mounted panel it only updates state. */
    applyRemoteCompat(compatPayload) {
      if (disposed) return;
      if (panelMounted && panelActive) {
        compat.setRemoteCompat(compatPayload);
        return;
      }
      compat.setRemoteCompatDeferred(compatPayload);
    },
    /**
     * Focus isolation input: the focused pane's target (not just its session id), so the
     * compat bridge can hand `uiWorkspace.openSession` the exact SessionTarget —
     * a session id, or the `{parentSessionId, childSessionId, mode}` address for a subagent.
     * Defense in depth: a leaf that is not a team member is never forwarded.
     */
    noteActiveTarget(target) {
      if (disposed) return;
      activeTarget = isTargetBindable(target) || isKnownChildTarget(target) ? target : undefined;
      syncBridgeTarget();
    },
    /**
     * A2's single arming point, exposed on the runtime so the panel (and the acceptance
     * harness) can re-arm after a remount WITHOUT re-running `apply`.
     *
     * Exact semantics for the unmounted case: it evaluates
     * `compat.setActiveTarget(panelMounted && panelActive ? activeTarget : undefined)`.
     * Arming therefore happens only while the panel is both mounted and the active main
     * panel; called while unmounted (or while another panel is active) it sets the bridge
     * target to `undefined` — i.e. it never arms from a stale target. Safe to call at any
     * time, idempotent, and a no-op once the plugin is disposed.
     */
    syncBridgeTarget,
    /**
     * Hold one client-side SessionReference for a WORKSPACE session. `signal` aborting
     * releases it; the Host Agent is untouched. A non-bindable target (member/leaf/unknown)
     * never reaches `ctx.sessions.retain`: it throws a coded error instead, and callers
     * render the pane as unassigned (they must not crash the slot entry).
     */
    retain(target, signal) {
      if (disposed) {
        const gone = new Error(t('error.clientDisposed'));
        gone.code = 'CLIENT_DISPOSED';
        throw gone;
      }
      const retainTarget = tbTargetToRetainTarget(target);
      if (retainTarget === undefined) throw new Error(t('error.invalidTarget') + ': ' + tbTargetSignature(target));
      const classification = classifyTarget(target);
      if (classification.verdict !== 'main') {
        diagnostics.rejectedRetains += 1;
        const error = new Error(t(classification.verdict === 'leaf' ? 'notice.leafRejected' : classification.verdict === 'member' ? 'notice.memberNotPane' : 'notice.targetNotLoaded'));
        error.code = classification.verdict === 'leaf' ? 'LEAF_NOT_BINDABLE' : classification.verdict === 'member' ? 'MEMBER_NOT_A_PANE' : 'TARGET_NOT_LOADED';
        error.sessionId = tbTargetSessionId(target);
        error.evidence = classification.evidence;
        throw error;
      }
      try {
        const reference = ctx.sessions.retain(retainTarget, { source: 'team-workbench', signal });
        diagnostics.retains += 1;
        // Tracked so `teardown()` can release anything still live if the renderer never
        // unmounts the pane (HMR / aborted commit). `release()` is idempotent, so a pane that
        // already released its own reference is not released twice from here.
        heldRefs.add(reference);
        return reference;
      } catch (error) {
        throw new Error(noteError('retain', error));
      }
    },
    /**
     * Hold the reference for what a pane ACTUALLY renders (surface v2):
     *   - no second-level view → the workspace session (main-only gate, see `retain`);
     *   - second-level view   → the CHILD address, allowed only when the child is a real
     *     child of this pane's own workspace session (`childrenOf`). A leaf can therefore
     *     never be retained by naming it directly.
     */
    retainPane(pane, signal) {
      if (pane === null || pane === undefined) throw new Error(t('error.invalidTarget'));
      const view = tbNormalizeView(pane.view);
      if (view === null) return runtime.retain(pane.target, signal);
      if (tbTargetSessionId(pane.target) !== view.parentSessionId) {
        diagnostics.rejectedRetains += 1;
        const error = new Error(t('notice.childNotKnown'));
        error.code = 'CHILD_NOT_KNOWN';
        throw error;
      }
      return runtime.retainChild(view, signal);
    },
    /** Retain a second-level child address (guarded by `childrenOf`). */
    retainChild(view, signal) {
      if (disposed) {
        const gone = new Error(t('error.clientDisposed'));
        gone.code = 'CLIENT_DISPOSED';
        throw gone;
      }
      const normalized = tbNormalizeView(view);
      if (normalized === null) throw new Error(t('error.invalidTarget'));
      const known = childrenOf(normalized.parentSessionId).some((child) => child.id === normalized.childSessionId);
      if (!known) {
        diagnostics.rejectedRetains += 1;
        const error = new Error(t('notice.childNotKnown'));
        error.code = 'CHILD_NOT_KNOWN';
        error.sessionId = normalized.childSessionId;
        throw error;
      }
      try {
        const reference = ctx.sessions.retain(tbTargetToRetainTarget({ kind: 'subagent', ...normalized }), { source: 'team-workbench', signal });
        diagnostics.retains += 1;
        diagnostics.childRetains = (diagnostics.childRetains ?? 0) + 1;
        heldRefs.add(reference);
        return reference;
      } catch (error) {
        throw new Error(noteError('retainChild', error));
      }
    },
    /** The second-level session list of one workspace session (read-only). */
    childrenOf,
    /** Open the second-level view of a pane (only a real child of its own session). */
    openChild(paneId, child) {
      const pane = layout().panes.find((candidate) => candidate.paneId === paneId);
      const parentSessionId = pane === undefined || pane.target === null ? undefined : pane.target.sessionId;
      if (parentSessionId === undefined) return { ok: false, code: 'NO_PANE_TARGET' };
      const childSessionId = typeof child === 'string' ? child : child?.id;
      if (!childrenOf(parentSessionId).some((candidate) => candidate.id === childSessionId)) {
        actions.notify(t('notice.childNotKnown'));
        return { ok: false, code: 'CHILD_NOT_KNOWN', sessionId: childSessionId };
      }
      // One editor per displayed session: if another pane already shows this child, focus it.
      const existing = paneDisplaying(childSessionId);
      if (existing !== undefined && existing.paneId !== paneId) {
        ensureVisible(existing.paneId);
        actions.setActive(existing.paneId);
        actions.notify(tbFormat(t, 'notice.duplicate', { pane: existing.paneId }));
        return { ok: false, code: 'DUPLICATE_SESSION', paneId: existing.paneId };
      }
      const known = childrenOf(parentSessionId).find((candidate) => candidate.id === childSessionId);
      actions.openChild(paneId, { parentSessionId, childSessionId, mode: known.mode, label: known.label });
      return { ok: true, paneId, childSessionId };
    },
    /** Leave the second-level view and show the pane's workspace session again. */
    closeChild(paneId) {
      actions.closeChild(paneId);
      return { ok: true, paneId };
    },
    /**
     * MIGRATION only (surface v2): a persisted / host-provided pane that binds a TEAM MEMBER
     * session becomes 「its team root workspace session + the member as second-level view」.
     * This keeps the user's existing layout meaningful instead of blanking three panes.
     * Returns true when the pane was migrated (the store changed).
     */
    migratePaneIfMember(paneId) {
      const pane = layout().panes.find((candidate) => candidate.paneId === paneId);
      if (pane === undefined || pane.target === null) return false;
      const classification = classifyTarget(pane.target);
      if (classification.verdict !== 'member') return false;
      const memberSessionId = tbTargetSessionId(pane.target);
      const index = teamIndexNow();
      const info = index.roleBySession[memberSessionId];
      const leadSessionId = info === undefined ? undefined : info.teamKey;
      if (typeof leadSessionId !== 'string' || classifySession(leadSessionId).verdict !== 'main') {
        diagnostics.memberMigrationFailed = (diagnostics.memberMigrationFailed ?? 0) + 1;
        return false;
      }
      const target = { kind: 'session', sessionId: leadSessionId };
      const view = { parentSessionId: leadSessionId, childSessionId: memberSessionId, mode: 'continuable', label: info.memberName ?? memberSessionId };
      actions.migrateMemberPane(paneId, target, view, '');
      // The host LayoutRecord has no `view` field and enforces "one session one pane"; when
      // another pane already carries this workspace session, pushing ours would be refused and
      // could steal the host focus. The local store (persisted) is the source of truth for the
      // second level, so we simply do not push a duplicate target.
      const twin = layout().panes.some((candidate) => candidate.paneId !== paneId && candidate.target !== null && candidate.target.sessionId === leadSessionId);
      if (!twin) bridge.upsertPane({ paneId, target, role: 'auto', label: '' });
      diagnostics.migratedMemberPanes = (diagnostics.migratedMemberPanes ?? 0) + 1;
      return true;
    },
    /** A4: one mapping only — the host client maps the client-shape layout itself. */
    setMode(mode) {
      actions.setMode(mode);
      bridge.setLayout(layout()).then((result) => {
        diagnostics.lastHostOp = { op: 'set-layout', ok: result.ok, code: result.code, at: Date.now() };
      });
    },
    /** A4: pass the CLIENT layout; `bridge.setLayout` performs the single mapping. */
    pushLayout() {
      bridge.setLayout(layout()).then((result) => {
        diagnostics.lastHostOp = { op: 'set-layout', ok: result.ok, code: result.code, at: Date.now() };
      });
    },
    focusPane(paneId) {
      const current = layout();
      // Idempotent: a pointer interaction must not spam the host route when nothing moved.
      if (current.activePaneId === paneId && current.mode >= tbModeForPane(paneId)) return;
      ensureVisible(paneId);
      actions.setActive(paneId);
      bridge.focusPane(paneId).then((result) => {
        diagnostics.lastHostOp = { op: 'focus-pane', ok: result.ok, code: result.code, at: Date.now() };
      });
    },
    /**
     * Bind one pane. One session ⇒ one pane: when the session is already bound the
     * existing pane is focused and a notice explains why (never a second editor).
     */
    bindTarget(paneId, target, role, label) {
      const sessionId = tbTargetSessionId(target);
      if (sessionId !== undefined) {
        // "All other subagents are refused", and a target without positive evidence is refused
        // too: a user-facing bind (picker row, team tree, focus) must never write a target the
        // read layer cannot vouch for. `unknown`/malformed targets can still enter the store
        // through the HOST layout merge (non-destructive, re-judged on every list change), but
        // never through this entry point.
        const classification = classifyTarget(target);
        if (classification.verdict !== 'main') {
          diagnostics.notBindableCount += 1;
          if (classification.verdict === 'leaf') {
            actions.notify(t('notice.leafRejected'));
            return { ok: false, code: 'LEAF_NOT_BINDABLE', sessionId };
          }
          if (classification.verdict === 'member') {
            // Surface v2: a team member is a SECOND-LEVEL view, never a pane identity.
            actions.notify(t('notice.memberNotPane'));
            return { ok: false, code: 'MEMBER_NOT_A_PANE', sessionId };
          }
          actions.notify(t('notice.targetNotLoaded'));
          return { ok: false, code: 'TARGET_NOT_LOADED', sessionId };
        }
        const existing = paneDisplaying(sessionId);
        if (existing !== undefined && existing.paneId !== paneId) {
          ensureVisible(existing.paneId);
          actions.setActive(existing.paneId);
          actions.notify(tbFormat(t, 'notice.duplicate', { pane: existing.paneId }));
          return { ok: false, code: 'DUPLICATE_SESSION', paneId: existing.paneId };
        }
      }
      actions.bindPane(paneId, target, role, label);
      ensureVisible(paneId);
      // The host LayoutRecord has no `view` and enforces "one session one pane". When several
      // panes of THIS tab carry the same workspace session (each with its own child view — the
      // 4-members-of-one-team layout), pushing a duplicate target would be refused by the host
      // and could steal its focus, so the local store stays authoritative for those.
      const twin = layout().panes.some((candidate) => candidate.paneId !== paneId && candidate.target !== null && candidate.target.sessionId === tbTargetSessionId(target));
      if (!twin) {
        bridge.upsertPane({ paneId, target, role, label }).then((result) => {
          diagnostics.lastHostOp = { op: 'upsert-pane', ok: result.ok, code: result.code, at: Date.now() };
        });
      } else {
        diagnostics.duplicateTargetsNotPushed = (diagnostics.duplicateTargetsNotPushed ?? 0) + 1;
      }
      return { ok: true, paneId };
    },
    bindOrFocus(sessionId, role, label) {
      const existing = paneDisplaying(sessionId);
      if (existing !== undefined) {
        ensureVisible(existing.paneId);
        actions.setActive(existing.paneId);
        actions.notify(tbFormat(t, 'notice.focused', { pane: existing.paneId }));
        return { ok: true, mode: 'focused', paneId: existing.paneId };
      }
      const free = firstFreePane();
      if (free === undefined) {
        actions.notify(t('error.hostBusy') + t('notice.agentUntouched'));
        return { ok: false, code: 'NO_FREE_PANE' };
      }
      return runtime.bindTarget(free.paneId, targetForSession(sessionId), role, label);
    },
    /**
     * Release one pane's binding (B5/dead-end fix: this is the affordance the picker's
     * 「释放本窗」 row uses, so `error.hostBusy` is never a dead end). The pane identity and
     * its address stay restorable; the Host record is corrected to `target: null`.
     */
    clearPane(paneId) {
      actions.clearPane(paneId);
      actions.notify(tbFormat(t, 'notice.released', { pane: paneId }));
      bridge.upsertPane({ paneId, target: null, role: 'auto', label: '' });
    },
    async refreshHost() {
      const result = await bridge.fetchState();
      if (!result.ok) return result;
      // A new snapshot may invalidate already-rendered detail pages (finished work, changed claim
      // level, new errors). Dropping the cache re-fetches the visible page — bounded and read-only.
      invalidateDetailPages();
      const snapshot = result.value?.snapshot;
      // Host-downloaded compat config first (A2/A3): `compat.rightBarFocusBridge=false` in
      // the profile patch row must actually switch the focus bridge off, and the bridge may
      // not act before this payload is known. While the panel is unmounted this only
      // updates state — it never reconciles, so a reconnect cannot grab the centre column.
      if (result.value !== undefined && result.value !== null && 'compat' in result.value) {
        runtime.applyRemoteCompat(result.value.compat);
      }
      // Published ≠ activated: a refresh only records the capability delta. The ack is sent by a
      // REAL mount/render commit, never by a refresh (Lead round-21 correction).
      noteHostRefresh();
      const hostLayout = snapshot !== undefined && snapshot !== null && typeof snapshot === 'object' ? snapshot.layout : undefined;
      if (hostLayout !== undefined && hostLayout !== null) {
        runtime.adoptHostLayout(hostLayout);
        return result;
      }
      const got = await bridge.getLayout();
      if (got.ok && got.value?.layout) runtime.adoptHostLayout(got.value.layout);
      return result;
    },
    /**
     * Merge a host LayoutRecord through the bindability gate, then reconcile what is
     * already persisted. This is the path the `team_layout` tool's `bind-pane` reaches, so
     * a leaf target coming from the host is dropped here and never reaches `retain`.
     */
    adoptHostLayout(hostLayout) {
      const adapted = bridge.adoptLayout(hostLayout);
      if (adapted === null) return;
      const before = new Map(layout().panes.map((pane) => [pane.paneId, tbTargetSignature(pane.target)]));
      // First line: only a POSITIVELY identified leaf is destructive. It is never merged
      // into the store and the host record is corrected to `target: null`. An 'unknown'
      // target is kept in the store on purpose (fail-closed rendering + self-recovery when
      // the session list arrives) and is never rewritten on the host.
      const rejected = [];
      for (const pane of adapted.panes ?? []) {
        if (pane.target === null || pane.target === undefined) continue;
        const classification = classifyTarget(pane.target);
        if (classification.verdict !== 'leaf') continue;
        diagnostics.droppedHostTargets.push({ paneId: pane.paneId, target: pane.target, evidence: classification.evidence, at: Date.now() });
        if (diagnostics.droppedHostTargets.length > 20) diagnostics.droppedHostTargets.shift();
        rejected.push(pane.paneId);
        pane.target = null;
        pane.role = 'auto';
        pane.label = '';
      }
      // Second line: the store action re-checks every target it merges (leafs rejected).
      actions.adoptHostLayout(adapted, (target) => classifyTarget(target).verdict !== 'leaf');
      runtime.reconcileStoredTargets();
      for (const paneId of rejected) bridge.upsertPane({ paneId, target: null, role: 'auto', label: '' });
      const changed = layout().panes.some((pane) => before.get(pane.paneId) !== tbTargetSignature(pane.target));
      if (changed) runtime.pushLayout();
    },
    /**
     * Active cleanup, run on mount, after every host layout merge, and whenever the session
     * list changes.
     *
     * Only a POSITIVELY identified leaf is destructive (removed from the store and corrected
     * on the host with `upsert-pane { target: null }`). An 'unknown' target is left in place —
     * fail-closed means "do not render it", not "throw the address away" — so a legitimate
     * member session whose projections have not arrived yet recovers by itself.
     */
    reconcileStoredTargets() {
      const stripped = [];
      let migrated = 0;
      for (const pane of layout().panes) {
        if (pane.target === null || pane.target === undefined) continue;
        const classification = classifyTarget(pane.target);
        // Surface v2: a member target is not destroyed — it is re-expressed as
        // 「workspace session + second-level view」 so the user's layout keeps meaning.
        if (classification.verdict === 'member') {
          if (pane.view === null && runtime.migratePaneIfMember(pane.paneId)) migrated += 1;
          continue;
        }
        if (classification.verdict !== 'leaf') continue; // 'unknown' is kept for re-judging
        stripped.push({ paneId: pane.paneId, target: pane.target, evidence: classification.evidence, at: Date.now() });
        actions.clearPane(pane.paneId);
        bridge.upsertPane({ paneId: pane.paneId, target: null, role: 'auto', label: '' });
      }
      if (stripped.length === 0 && migrated === 0) return 0;
      for (const entry of stripped) {
        diagnostics.strippedLeafTargets.push(entry);
        if (diagnostics.strippedLeafTargets.length > 20) diagnostics.strippedLeafTargets.shift();
      }
      if (stripped.length > 0) console.warn('[team-workbench] removed', stripped.length, 'positively-identified leaf pane target(s):', stripped);
      if (migrated > 0) console.info('[team-workbench] migrated', migrated, 'member-bound pane(s) to 「workspace session + child view」');
      return stripped.length + migrated;
    },
    /** Strip one pane's target on positive leaf evidence (called by the pane host). */
    stripPaneTarget(paneId, target) {
      const pane = layout().panes.find((candidate) => candidate.paneId === paneId);
      if (pane === undefined || pane.target === null) return false;
      const classification = classifyTarget(pane.target);
      if (classification.verdict !== 'leaf') return false;
      diagnostics.strippedLeafTargets.push({ paneId, target: pane.target, evidence: classification.evidence, at: Date.now() });
      if (diagnostics.strippedLeafTargets.length > 20) diagnostics.strippedLeafTargets.shift();
      actions.clearPane(paneId);
      bridge.upsertPane({ paneId, target: null, role: 'auto', label: '' });
      return true;
    },
    /**
     * The pane host reports its verdict for one pane/one target. Used for the
     * "blocked first, recovered after the list arrived" diagnostic the Lead asked for.
     */
    noteTargetVerdict(paneId, signature, verdict, evidence) {
      if (verdict === 'leaf' || verdict === 'unknown') diagnostics.notBindableCount += 1;
      const previous = paneVerdicts.get(paneId);
      paneVerdicts.set(paneId, { signature, verdict });
      if (previous !== undefined && previous.signature === signature && previous.verdict === 'unknown' && (verdict === 'main' || verdict === 'member')) {
        diagnostics.recoveredAfterList += 1;
        actions.notify(tbFormat(t, 'notice.recovered', { pane: paneId }));
        console.info('[team-workbench] pane', paneId, 'recovered after session data arrived (' + evidence + ')');
      }
    },
    /**
     * Really destroys this runtime by taking the SAME path as the plugin effect's cleanup
     * (`teardown()`): clears the panel arming, disposes the compat bridge, drops every
     * callback, and releases still-held SessionReferences. Idempotent, and safe in either
     * order relative to the effect cleanup.
     *
     * It used to only log diagnostics while the effect cleanup did the real work — a "fake
     * dispose" that let callers assert "nothing happens after dispose" against a bridge that
     * was still armed (and still calling `openSession`).
     */
    dispose() {
    stopRefresh();
      const errors = diagnostics.errors.slice();
      if (errors.length > 0) console.warn('[team-workbench] diagnostics on dispose:', errors);
      teardown();
    }
  };
  // Teardown: drop the module-metadata subscription and stop claiming mounted.
  try {
    if (typeof selfModuleUnsubscribe === 'function') selfModuleUnsubscribe();
  } catch {
    /* subscription already gone */
  }
  noteFrontendUnmount('main');
  tbLastRuntime = runtime;
  return runtime;
}

/** Factory-time capture of the frozen self identity (load closure; no ctx needed). */
function tbSelfBundleCapture() {
  const captured = typeof __tbSelfBundle !== 'undefined' && __tbSelfBundle !== null ? __tbSelfBundle : undefined;
  const url = captured !== undefined && typeof captured.url === 'string' && captured.url !== '' ? captured.url : undefined;
  const sourceDigest = captured !== undefined && typeof captured.sourceDigest === 'string' && captured.sourceDigest !== '' ? captured.sourceDigest : undefined;
  let rev;
  if (url !== undefined) {
    const match = url.match(/[?&]rev=([^&#]*)/);
    if (match !== null && match[1] !== '') {
      try {
        rev = decodeURIComponent(match[1]);
      } catch {
        rev = match[1];
      }
    }
  }
  return Object.freeze({
    url: url ?? null,
    rev: rev ?? null,
    revSource: rev === undefined ? null : 'load-url',
    sourceDigest: sourceDigest ?? null,
    source: url === undefined ? 'unavailable' : 'load-closure'
  });
}

const __teamWorkbench = {
  inject: ['slots', 'layout', 'locale', 'sessions'],
  /** Frozen instance identity (load-closure URL + stable digest; never rewritten by HMR). */
  selfBundle: tbSelfBundleCapture(),
  apply(ctx) {
    tbInjectStyle();
    ctx.effect(() => ctx.locale.register(tbLocaleNs, tbLocale), 'team-workbench: dictionaries');
    const t = ctx.locale.bind(tbLocaleNs);
    const pinned = tbCreatePinnedLayoutStore();
    const bridge = tbCreateHostClient('/plugin/team-workbench', t);
    const compat = tbCreateFocusBridge({ ctx, panelId: tbPanelId, t });
    const runtime = tbCreateRuntime({ ctx, t, pinned, bridge, compat });

    // Mount-time sweep: a target persisted by an older build (or written by the host
    // `team_layout` tool before the gate existed) is removed from the store and corrected
    // on the host before anything can retain it.
    ctx.effect(() => {
      runtime.reconcileStoredTargets();
      return () => {};
    }, 'team-workbench: strip non-bindable persisted targets');

    ctx.effect(() => {
      const off = ctx.on('connection/reset', () => {
        // Reconnect is a real event: refresh the full snapshot (coalesced, bounded).
        void runtime.requestRefresh('reconnect');
      });
      return () => off();
    }, 'team-workbench: host refresh on reconnect');

    // Event-first refresh: tab visibility / window focus. Listeners are owned by this effect and
    // removed on teardown — no new page, no global polling, no desktop interaction.
    ctx.effect(() => {
      const doc = typeof document !== 'undefined' ? document : (typeof window !== 'undefined' ? window.document : undefined);
      const win = typeof window !== 'undefined' ? window : undefined;
      const onVisibility = () => {
        const hidden = doc !== undefined && doc !== null && doc.visibilityState === 'hidden';
        runtime.noteHostVisibility(hidden ? 'hidden' : 'visible');
      };
      const onFocus = () => { runtime.noteHostVisibility('visible'); };
      doc?.addEventListener?.('visibilitychange', onVisibility);
      win?.addEventListener?.('focus', onFocus);
      return () => {
        doc?.removeEventListener?.('visibilitychange', onVisibility);
        win?.removeEventListener?.('focus', onFocus);
      };
    }, 'team-workbench: refresh on visibility/focus');

    // Public face for the focus bridge (compat, rc.2-limited): a future/patched right
    // sidebar can consume `teamWorkbenchFocus` instead of guessing the active session.
    ctx.effect(() => {
      const dispose = ctx.reflect.provide('teamWorkbenchFocus', compat.service);
      return () => dispose();
    }, 'team-workbench: focus bridge service');

    ctx.effect(() => {
      const dispose = ctx.slots.inject('main', function* () {
        yield ctx.slots.register({
          name: 'main',
          key: tbPanelId,
          locale: tbLocaleNs,
          store: pinned.store,
          // NOTE: an entry `inject` face is spread into props directly (`renderer:752-769`
          // + `bindInjectSources:424-439` transform only `hooks`/`keyedHooks`), so the
          // runtime must be a plain top-level key — never a `{ props: {...} }` wrapper.
          inject: () => ({ teamWorkbenchRuntime: runtime }),
          // Declaring a session-scoped child is what puts `SessionProvider` on the props.
          children: { [tbPaneSlotKey]: { kind: 'list', scope: 'session' } }
        }, tbWorkbenchPanel);
        // The pane bodies live in the child slot this entry just declared, so they are
        // registered after the declaration exists (same generator, same lifetime).
        yield ctx.slots.inject(tbPaneSlotKey, function* () {
          for (const paneId of tbPaneIds) {
            yield ctx.slots.register({
              name: tbPaneSlotKey,
              id: paneId,
              locale: tbLocaleNs,
              inject: () => ({ teamWorkbenchRuntime: runtime })
            }, tbPaneBody);
          }
        });
      });
      return () => dispose();
    }, 'team-workbench: main panel + pane bodies');

    ctx.effect(() => {
      const dispose = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: tbPanelId,
        order: 10,
        label: () => t('panel.label'),
        locale: tbLocaleNs
      }, tbSidebarPanelIcon));
      return () => dispose();
    }, 'team-workbench: sidebar entry');

    ctx.effect(() => () => {
      // One teardown path, shared with the public `runtime.dispose()`; order-safe and
      // idempotent, so an explicit `dispose()` before or after this cleanup is harmless.
      runtime.dispose();
      compat.dispose();
      bridge.dispose();
    }, 'team-workbench: runtime teardown');
  }
};
