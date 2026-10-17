/* @local/dsh-team-workbench — src/compat: rc.2-limited right-bar/focus bridge (named, switchable).
 *
 * WHY THIS EXISTS (the gap it covers, stated instead of hidden)
 * -----------------------------------------------------------
 * `docs/ARCHITECTURE.md` §3.6 / the source-evidence doc require the right-hand preview, the
 * approval target and "global stop" to follow the workbench's focused pane. rc.2 has **no**
 * extension point that sets "the active session" for those surfaces: the client Service
 * catalog has no sidebar-right/navigation service, and `sidebar.right` is not a slot key.
 *
 * HOW IT ENGAGES (public API only — verified in the shipped bundles)
 * ---------------------------------------------------------------
 * Every one of those surfaces resolves its session with the SAME published rule:
 *
 *   Object.values(ctx.sessions.list.getSnapshot().byId)
 *     .find(row => (row.retainedBy.mainView ?? 0) > 0)
 *
 * (`ui-layout/lib/client.js:60`, `ui-session/lib/client.js:283,:340`,
 * `ui-workspace/lib/client.js:106,:260,:2319,:2651,:2746,:2827`).
 * The `mainView` reference itself is established through a public entry point:
 * `ctx.uiWorkspace.openSession(target)` → `replaceMain()` →
 * `sessions.retain(target, { source: 'mainView' })` (`ui-workspace/lib/client.js:821-823,971-994`).
 *
 * So, on every focus change, this bridge:
 *   1. skips when the focused session already holds a `mainView` reference
 *      (`sessions.retainInfo(id).getSnapshot().retainedBy.mainView > 0` — public);
 *   2. otherwise calls `uiWorkspace.openSession(target)` (string id, or the
 *      `{parentSessionId, childSessionId, mode}` SubagentAddress for a subagent);
 *   3. immediately calls `layout.selectPanel('team-workbench')`, because `openSession`
 *      internally does `selectPanel(null)` (order matters);
 *   4. re-reads `retainedBy.mainView` and only reports `engaged` when the retention
 *      actually landed — otherwise it reports `blocked` with the concrete reason.
 *
 * HONEST LIMITS (rc.2 compat layer, not native support)
 * ----------------------------------------------------
 *   - `openSession` briefly switches the centre column to the built-in conversation
 *     panel before step 3 switches it back. Both calls are synchronous in one task, so
 *     React usually never paints the intermediate state — but a single visible flash is
 *     possible and is NOT ruled out; it has not been measured in a real browser here.
 *   - `openSession` also writes the workspace navigation selection
 *     (`dsh.sessions.current`, `ui-workspace:761,980-985`), so the built-in conversation
 *     panel remembers the focused pane session as its current session.
 *   - The bridge holds no `mainView` reference of its own; `ui-workspace` owns it and
 *     releases it when the next `openSession`/`clearMain` replaces it.
 *
 * ROLLBACK
 * --------
 *   - Config (profile patch layer): the plugin row's `config.compat.rightBarFocusBridge`
 *     set to `false` → the bridge never applies and the strip shows `compat.disabled`.
 *     (`cordis.patch.yml` is Lead-owned; this file only reads the value.)
 *   - Runtime: `window.__DSH_TEAM_WORKBENCH_COMPAT__ = { rightBarFocusBridge: false }`
 *     (the older `{ focusBridge: false }` key is still honoured) or
 *     `focusBridge.setEnabled(false)`.
 *   - Source: delete this file (and the `src/compat` row in tools/build-client.mjs) and
 *     rebuild; nothing in `src/client/**` imports it — the panel only uses the
 *     plain-object API below.
 */

const tbCompatFocusBridgeId = 'team-workbench/rightbar-focus-bridge@rc.2';

/**
 * Effective enable switch. Precedence (Lead-owned decision, rc.2):
 *   1. an explicit per-instance `setEnabled(...)` call (debug/rollback API);
 *   2. **host-downloaded config** — `GET /plugin/team-workbench/state` →
 *      `compat.rightBarFocusBridge === false` disables the bridge. This is the only path
 *      that makes the profile patch row's `config.compat.rightBarFocusBridge` effective,
 *      because a browser half cannot read a host row's config directly;
 *   3. `window.__DSH_TEAM_WORKBENCH_COMPAT__` override (`rightBarFocusBridge`, or the older
 *      `focusBridge` key);
 *   4. `ctx.config.compat.rightBarFocusBridge` if a client context ever carries it;
 *   5. built-in default `true`.
 *
 * @param {object} ctx - client context.
 * @param {boolean|undefined} override - explicit per-instance override.
 * @param {object|undefined} hostCompat - last `state.compat` payload, or absence.
 * @returns {{ enabled: boolean, reason: string, minVersion: string|undefined }}
 */
function tbCompatFocusBridgeEnabled(ctx, override, hostCompat) {
  const host = hostCompat !== null && typeof hostCompat === 'object' ? hostCompat.rightBarFocusBridge : undefined;
  const minVersion = hostCompat !== null && typeof hostCompat === 'object' && typeof hostCompat.rightBarFocusBridgeMinVersion === 'string'
    ? hostCompat.rightBarFocusBridgeMinVersion
    : undefined;
  if (typeof host === 'boolean' && host === false) return { enabled: false, reason: 'disabled-by-host-config', minVersion };
  if (typeof override === 'boolean') return { enabled: override, reason: override ? 'enabled-by-instance' : 'disabled-by-instance', minVersion };
  try {
    const runtime = globalThis.__DSH_TEAM_WORKBENCH_COMPAT__;
    if (runtime !== null && typeof runtime === 'object') {
      if (typeof runtime.rightBarFocusBridge === 'boolean') return { enabled: runtime.rightBarFocusBridge, reason: runtime.rightBarFocusBridge ? 'enabled-by-window' : 'disabled-by-window', minVersion };
      if (typeof runtime.focusBridge === 'boolean') return { enabled: runtime.focusBridge, reason: runtime.focusBridge ? 'enabled-by-window' : 'disabled-by-window', minVersion };
    }
  } catch (_noGlobal) {
    /* no global override object */
  }
  try {
    const compat = ctx !== undefined && ctx !== null && ctx.config !== undefined && ctx.config !== null ? ctx.config.compat : undefined;
    if (compat !== null && typeof compat === 'object' && typeof compat.rightBarFocusBridge === 'boolean') {
      return { enabled: compat.rightBarFocusBridge, reason: compat.rightBarFocusBridge ? 'enabled-by-client-config' : 'disabled-by-client-config', minVersion };
    }
  } catch (_noConfig) {
    /* no client-side config */
  }
  if (typeof host === 'boolean') return { enabled: host, reason: host ? 'enabled-by-host-config' : 'disabled-by-host-config', minVersion };
  return { enabled: true, reason: 'default-enabled', minVersion };
}

/** Resolve one client service: `ctx.get(name)` first (shipped idiom), then the ctx property. */
function tbCompatService(ctx, name) {
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name);
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    }
  } catch (_noGet) {
    /* fall through to the context property */
  }
  const direct = ctx[name];
  return direct === undefined || direct === null ? undefined : direct;
}

/** The public `SessionTarget` form `uiWorkspace.openSession` accepts for one pane target. */
function tbCompatOpenSessionTarget(target) {
  if (target === null || target === undefined || typeof target !== 'object') return undefined;
  if (target.kind === 'subagent') {
    if (typeof target.parentSessionId !== 'string' || typeof target.childSessionId !== 'string') return undefined;
    return { parentSessionId: target.parentSessionId, childSessionId: target.childSessionId, mode: target.mode ?? 'unknown' };
  }
  return typeof target.sessionId === 'string' ? target.sessionId : undefined;
}

/**
 * Build the bridge.
 *
 * @param {{ ctx: object, enabled?: boolean, panelId: string }} options
 */
function tbCreateFocusBridge(options) {
  const ctx = options.ctx;
  const sessions = tbCompatService(ctx, 'sessions');
  const panelId = typeof options.panelId === 'string' ? options.panelId : 'team-workbench';
  // B3: every user-visible bridge string goes through the plugin locale namespace.
  const tr = typeof options.t === 'function' ? options.t : (key) => key;
  let enabledOverride = typeof options.enabled === 'boolean' ? options.enabled : undefined;
  // A3: the host config is not known until `/state` answers. `hostCompatKnown` is what keeps
  // the bridge from acting on the first mount: an early `openSession` could not be stopped
  // by a later `rightBarFocusBridge:false` or a version fence.
  let hostCompat;
  let hostCompatKnown = false;
  const initial = tbCompatFocusBridgeEnabled(ctx, enabledOverride, hostCompat);
  const state = {
    compat: tbCompatFocusBridgeId,
    enabled: initial.enabled,
    enableReason: initial.reason,
    hostMinVersion: initial.minVersion,
    hostCompatKnown: false,
    phase: 'idle',
    activeSessionId: undefined,
    activeTargetKind: undefined,
    mainViewSessionId: undefined,
    nativeMainSessionId: undefined,
    appliedCount: 0,
    lastAppliedSession: undefined,
    lastAppliedAt: 0,
    verified: false,
    reason: 'idle',
    detail: '',
    lastError: undefined
  };
  const observable = tbCreateObservable({ ...state });
  let activeTarget;
  let applying = false;
  let requestFocus;
  let disposed = false;

  function publish(patch) {
    if (disposed) return;
    // The local record and the published snapshot must move together: `reconcile()` and
    // `activeSessionId()` read this record, so publishing into a detached clone would
    // freeze the bridge (a bug the off-repo harness caught).
    for (const key of Object.keys(patch)) state[key] = patch[key];
    observable.set({ ...state });
  }

  /** Session ids that currently hold a `mainView` reference (the shipped selection rule). */
  function mainViewHolders() {
    if (sessions === undefined || sessions === null || typeof sessions.list?.getSnapshot !== 'function') return { holders: [], known: false };
    let list;
    try {
      list = sessions.list.getSnapshot();
    } catch (error) {
      return { holders: [], known: false, error: tbHelpers.errorText(error) };
    }
    const byId = list !== null && typeof list === 'object' && list.byId !== undefined && list.byId !== null ? list.byId : {};
    const holders = [];
    for (const id of Object.keys(byId)) {
      const retainedBy = byId[id] !== null && typeof byId[id] === 'object' ? byId[id].retainedBy : undefined;
      if (retainedBy !== null && typeof retainedBy === 'object' && (retainedBy.mainView ?? 0) > 0) holders.push(id);
    }
    return { holders, known: true };
  }

  /** `retainedBy.mainView` for one session through the public `retainInfo` observable. */
  function mainViewCount(sessionId) {
    if (sessions === undefined || sessions === null || typeof sessions.retainInfo !== 'function') return { count: 0, known: false };
    try {
      const info = sessions.retainInfo(sessionId).getSnapshot();
      const retainedBy = info !== null && typeof info === 'object' ? info.retainedBy : undefined;
      return { count: retainedBy !== null && typeof retainedBy === 'object' ? retainedBy.mainView ?? 0 : 0, known: true };
    } catch (error) {
      return { count: 0, known: false, error: tbHelpers.errorText(error) };
    }
  }

  /** Read-only cross-check of the internal source the shipped surfaces publish. */
  function readNativeMain() {
    try {
      const service = tbCompatService(ctx, 'uiSession');
      const source = service === undefined ? undefined : service.current;
      if (source === undefined || typeof source.getSnapshot !== 'function') return { readable: false };
      const value = source.getSnapshot();
      return { readable: true, sessionId: value !== null && typeof value === 'object' && typeof value.key === 'string' ? value.key : undefined };
    } catch (error) {
      return { readable: false, error: tbHelpers.errorText(error) };
    }
  }

  function blocked(reason, detail, error) {
    const holders = mainViewHolders();
    publish({
      enabled: true,
      phase: 'blocked',
      reason,
      detail,
      verified: false,
      lastError: error === undefined ? state.lastError : tbHelpers.errorText(error),
      mainViewSessionId: holders.holders[0],
      nativeMainSessionId: readNativeMain().sessionId
    });
  }

  /** Recompute the bridge for the current focus. Idempotent and reentrancy-safe. */
  function reconcile() {
    if (disposed) return;
    const resolved = tbCompatFocusBridgeEnabled(ctx, enabledOverride, hostCompat);
    if (!resolved.enabled) {
      publish({
        enabled: false,
        enableReason: resolved.reason,
        hostMinVersion: resolved.minVersion,
        hostCompatKnown,
        phase: 'disabled',
        reason: 'disabled-by-config',
        detail: tr('compat.detail.disabled', { id: tbCompatFocusBridgeId, reason: resolved.reason }),
        verified: false
      });
      return;
    }
    // A3: without the host's compat payload the bridge must NOT act — the effective switch
    // and the version fence can only be applied once the host has answered.
    if (!hostCompatKnown && enabledOverride === undefined) {
      publish({
        enabled: true,
        enableReason: 'host-compat-unknown',
        hostMinVersion: undefined,
        hostCompatKnown: false,
        phase: 'unknown',
        reason: 'host-compat-unknown',
        detail: tr('compat.detail.hostUnknown'),
        verified: false
      });
      return;
    }
    // Version fence: we only vouch for the rc.2 mechanism this file was written against.
    if (resolved.minVersion !== undefined && resolved.minVersion !== '0.2.0-rc.2') {
      publish({
        enabled: true,
        enableReason: resolved.reason,
        hostMinVersion: resolved.minVersion,
        hostCompatKnown,
        phase: 'blocked',
        reason: 'compat-version-mismatch',
        detail: tr('compat.detail.versionMismatch', { version: resolved.minVersion }),
        verified: false
      });
      return;
    }
    const target = activeTarget;
    const sessionId = tbTargetSessionId(target);
    const openTarget = tbCompatOpenSessionTarget(target);
    const holders = mainViewHolders();
    const native = readNativeMain();
    const base = {
      enabled: true,
      enableReason: resolved.reason,
      hostMinVersion: resolved.minVersion,
      hostCompatKnown,
      activeSessionId: sessionId,
      activeTargetKind: target === undefined || target === null ? undefined : target.kind ?? 'session',
      mainViewSessionId: holders.holders[0],
      nativeMainSessionId: native.sessionId
    };
    if (sessionId === undefined || openTarget === undefined) {
      publish({ ...base, phase: 'idle', reason: 'no-active-pane', detail: '', verified: false });
      return;
    }
    // Already the main-view session: nothing to do (and no extra side effect).
    const held = mainViewCount(sessionId);
    if (held.count > 0) {
      publish({
        ...base,
        phase: 'engaged',
        reason: 'already-main-view',
        detail: tr('compat.detail.alreadyMainView', { n: held.count }),
        verified: held.known
      });
      return;
    }
    if (applying) {
      // A `selectPanel` reflow is already in flight for this focus: keep the previous
      // verdict instead of starting a second `openSession` (no oscillation).
      publish({ ...base, phase: state.phase === 'idle' ? 'blocked' : state.phase, reason: 'reentrant-skip', detail: tr('compat.detail.applying') });
      return;
    }
    const uiWorkspace = tbCompatService(ctx, 'uiWorkspace');
    if (uiWorkspace === undefined || typeof uiWorkspace.openSession !== 'function') {
      blocked('missing-service:uiWorkspace', tr('compat.detail.missingUiWorkspace'));
      return;
    }
    const layout = tbCompatService(ctx, 'layout');
    if (layout === undefined || typeof layout.selectPanel !== 'function') {
      blocked('missing-service:layout', tr('compat.detail.missingLayout'));
      return;
    }
    applying = true;
    try {
      // 1) establish the public `mainView` reference for the focused pane's session.
      uiWorkspace.openSession(openTarget);
      // 2) `openSession` ends with selectPanel(null): switch the centre column back to us.
      layout.selectPanel(panelId);
      // 3) verify with the public observable that the retention actually landed.
      const after = mainViewCount(sessionId);
      const applied = after.count > 0;
      publish({
        ...base,
        phase: applied ? 'engaged' : 'blocked',
        reason: applied ? 'openSession-applied' : 'mainView-not-applied',
        detail: applied
          ? tr('compat.detail.applied', { n: after.count, panel: panelId })
          : tr('compat.detail.notApplied'),
        appliedCount: applied ? state.appliedCount + 1 : state.appliedCount,
        lastAppliedSession: applied ? sessionId : state.lastAppliedSession,
        lastAppliedAt: applied ? Date.now() : state.lastAppliedAt,
        verified: applied
      });
    } catch (error) {
      // openSession threw (unknown id, aborted navigation, host refusal, ...): report it.
      blocked('open-session-failed', tr('compat.detail.openSessionFailed', { message: tbHelpers.errorText(error) }), error);
    } finally {
      // Release the guard on a later task so the selectPanel reflow settles, then converge
      // once: if the reflow re-focused a different pane while the guard was held, that
      // focus gets its (single) application instead of being dropped.
      const release = () => {
        applying = false;
        if (!disposed) reconcile();
      };
      if (typeof queueMicrotask === 'function') queueMicrotask(release);
      else setTimeout(release, 0);
    }
  }

  return {
    id: tbCompatFocusBridgeId,
    snapshotSource: { getSnapshot: observable.getSnapshot, subscribe: observable.subscribe },
    setFocusRequestHandler(handler) {
      requestFocus = typeof handler === 'function' ? handler : undefined;
    },
    /** The panel pushes the focused pane's target (or undefined) here. */
    setActiveTarget(target) {
      if (disposed) return;
      activeTarget = target === undefined || target === null ? undefined : target;
      publish({
        activeSessionId: tbTargetSessionId(activeTarget),
        activeTargetKind: activeTarget === undefined ? undefined : activeTarget.kind ?? 'session'
      });
      reconcile();
    },
    /** Runtime rollback switch (highest precedence; explicit call also marks host compat known). */
    setEnabled(enabled) {
      enabledOverride = enabled === true;
      hostCompatKnown = true;
      reconcile();
    },
    /**
     * Adopt the host-downloaded compat config (`GET /state` → `compat`). Marks the config as
     * KNOWN, which is what unblocks the first `openSession` (A3).
     */
    setRemoteCompat(compat) {
      if (disposed) return;
      hostCompatKnown = true;
      hostCompat = compat !== null && typeof compat === 'object' ? compat : {};
      reconcile();
    },
    /**
     * A2: same adoption, but without reconciling — used while the workbench panel is not
     * mounted, so a late/reconnect answer can never make the bridge act on a stale target.
     */
    setRemoteCompatDeferred(compat) {
      if (disposed) return;
      hostCompatKnown = true;
      hostCompat = compat !== null && typeof compat === 'object' ? compat : {};
      publish({
        hostCompatKnown: true,
        enableReason: hostCompatKnown ? 'host-compat-known-deferred' : 'host-compat-unknown',
        enabled: hostCompat.rightBarFocusBridge !== false
      });
    },
    /** What the host last told us (for diagnostics). */
    remoteCompat: () => hostCompat,
    reconcile,
    /** Verifiable counters for docs/evidence. */
    appliedCount: () => state.appliedCount,
    lastAppliedSession: () => state.lastAppliedSession,
    /** Public face a future/patched right bar can consume instead of guessing. */
    service: {
      id: 'teamWorkbenchFocus',
      compat: tbCompatFocusBridgeId,
      getSnapshot: observable.getSnapshot,
      subscribe: observable.subscribe,
      activeSessionId: () => state.activeSessionId,
      appliedCount: () => state.appliedCount,
      lastAppliedSession: () => state.lastAppliedSession,
      focusPane: (paneId) => {
        if (requestFocus !== undefined) requestFocus(paneId);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      applying = false;
      observable.set({ ...observable.getSnapshot(), phase: 'disposed' });
    }
  };
}
