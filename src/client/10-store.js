/* @local/dsh-team-workbench — workbench layout state and its persisted store seat.
 *
 * SURFACE v2 (docs/contracts/client-surface-v2.md, FROZEN):
 *   - a pane identity is ALWAYS a workspace main session (`pane.target`);
 *   - a subagent / team member is only reachable as a SECOND-LEVEL view inside that pane
 *     (`pane.view`), never as a pane target of its own;
 *   - `view` is client-only state (persisted in this store, never written to the host layout
 *     record): the host LayoutRecord keeps describing the workspace session a pane shows.
 *
 * The store goes through the slot `store` seat (`spec.persist`), so the layout
 * (mode, paneId→session, second-level view, focus, ratios) survives a page reload without
 * any host round trip. The host line is used for the layout record and cross-window
 * sharing, never as the rendering source of truth.
 */

const tbPaneIds = ['pane-1', 'pane-2', 'pane-3', 'pane-4'];
/** Kept only to normalize a host record / older persisted record. The UI no longer uses it:
 *  a pane is a workspace session, so a role pill would be a second source of truth. */
const tbPaneRoles = ['auto', 'task', 'lead', 'member', 'subagent'];
const tbModes = [1, 2, 4];

/** One fresh pane record (every pane already exists as an identity; "closed" = no target). */
function tbEmptyPane(paneId) {
  return { paneId, target: null, view: null, role: 'auto', label: '' };
}

/** The only recognized second-level view shape, or null. */
function tbNormalizeView(view) {
  if (view === null || view === undefined || typeof view !== 'object') return null;
  if (typeof view.parentSessionId !== 'string' || typeof view.childSessionId !== 'string') return null;
  if (view.parentSessionId === '' || view.childSessionId === '') return null;
  return {
    parentSessionId: view.parentSessionId,
    childSessionId: view.childSessionId,
    mode: typeof view.mode === 'string' && view.mode !== '' ? view.mode : 'unknown',
    label: typeof view.label === 'string' ? view.label : ''
  };
}

/** Layout declaration consumed by `tbCreateStoreHandle` (ui-renderer StoreSpec shape). */
const tbLayoutStoreSpec = {
  init: () => ({
    v: 3,
    mode: 1,
    panes: tbPaneIds.map(tbEmptyPane),
    activePaneId: 'pane-1',
    ratios: { cols: [1, 1], rows: [1, 1] },
    notice: null,
    hostLayout: null
  }),
  persist: 'dsh.team-workbench.layout',
  /**
   * B6: force every persisted pane into the declared shape. An unknown role becomes `auto`
   * (never a `pane.role.undefined` tooltip), labels become strings, an unrecognized target
   * becomes null, the four pane identities are always present, and mode/focus/ratios are
   * clamped. Runs after the exact-version merge, so a hand-edited or downgraded record
   * cannot leak foreign values into rendering.
   *
   * v3 invariant enforced here: a view without a workspace target is dropped, and the
   * view's parent must be the pane's own target (a stale view can never point a pane at
   * another session's child).
   */
  normalize: (state) => {
    const next = { ...state };
    next.v = 3;
    next.mode = tbModes.indexOf(Number(next.mode)) >= 0 ? Number(next.mode) : 1;
    const byId = new Map();
    for (const pane of Array.isArray(next.panes) ? next.panes : []) {
      if (pane === null || typeof pane !== 'object' || typeof pane.paneId !== 'string') continue;
      byId.set(pane.paneId, pane);
    }
    next.panes = tbPaneIds.map((paneId) => {
      const pane = byId.get(paneId) ?? {};
      const target = tbNormalizeTarget(pane.target);
      let view = tbNormalizeView(pane.view);
      const parentSessionId = target === null ? undefined : target.sessionId;
      if (view !== null && view.parentSessionId !== parentSessionId) view = null;
      return {
        paneId,
        target,
        view,
        role: tbPaneRoles.indexOf(pane.role) >= 0 ? pane.role : 'auto',
        label: typeof pane.label === 'string' ? pane.label : ''
      };
    });
    if (tbPaneIds.indexOf(next.activePaneId) < 0) next.activePaneId = 'pane-1';
    const visible = tbPaneIds.slice(0, next.mode);
    if (visible.indexOf(next.activePaneId) < 0) next.activePaneId = visible[0];
    const ratios = next.ratios !== null && typeof next.ratios === 'object' && next.ratios !== undefined ? next.ratios : {};
    const axis = (value) => {
      const pair = Array.isArray(value) ? value : [];
      const first = tbHelpers.clamp(Number(pair[0]) || 1, 0.2, 0.8);
      return [first, Number((2 - first).toFixed(4))];
    };
    next.ratios = { cols: axis(ratios.cols), rows: axis(ratios.rows) };
    if (next.notice !== null && (typeof next.notice !== 'object' || next.notice === undefined || typeof next.notice.text !== 'string')) next.notice = null;
    return next;
  },
  actions: {
    setMode: (draft, mode) => {
      const next = tbModes.indexOf(Number(mode)) >= 0 ? Number(mode) : 1;
      draft.mode = next;
      const visible = tbPaneIds.slice(0, next);
      if (visible.indexOf(draft.activePaneId) < 0) draft.activePaneId = visible[0];
    },
    setActive: (draft, paneId) => {
      if (tbPaneIds.indexOf(paneId) >= 0) draft.activePaneId = paneId;
    },
    /** Bind one pane to a WORKSPACE session. A new binding always clears the child view. */
    bindPane: (draft, paneId, target, role, label) => {
      for (const pane of draft.panes) {
        if (pane.paneId !== paneId) continue;
        pane.target = target ?? null;
        pane.view = null;
        pane.role = tbPaneRoles.indexOf(role) >= 0 ? role : 'auto';
        pane.label = typeof label === 'string' ? label : '';
      }
      if (tbPaneIds.indexOf(paneId) >= 0) draft.activePaneId = paneId;
    },
    /** Open the SECOND-LEVEL view (child of the pane's own workspace session). */
    openChild: (draft, paneId, view) => {
      const normalized = tbNormalizeView(view);
      if (normalized === null) return;
      for (const pane of draft.panes) {
        if (pane.paneId !== paneId) continue;
        if (pane.target === null || pane.target.sessionId !== normalized.parentSessionId) return;
        pane.view = normalized;
      }
      if (tbPaneIds.indexOf(paneId) >= 0) draft.activePaneId = paneId;
    },
    closeChild: (draft, paneId) => {
      for (const pane of draft.panes) {
        if (pane.paneId !== paneId) continue;
        pane.view = null;
      }
    },
    /** Migration only: an old pane bound to a team member becomes 「root session + view」. */
    migrateMemberPane: (draft, paneId, target, view, label) => {
      const normalized = tbNormalizeView(view);
      if (target === null || normalized === null) return;
      for (const pane of draft.panes) {
        if (pane.paneId !== paneId) continue;
        if (target.sessionId !== normalized.parentSessionId) return;
        pane.target = target;
        pane.view = normalized;
        pane.role = 'auto';
        pane.label = typeof label === 'string' ? label : '';
      }
      if (tbPaneIds.indexOf(paneId) >= 0) draft.activePaneId = paneId;
    },
    clearPane: (draft, paneId) => {
      for (const pane of draft.panes) {
        if (pane.paneId !== paneId) continue;
        pane.target = null;
        pane.view = null;
        pane.label = '';
      }
    },
    setRatios: (draft, axis, values) => {
      if (axis !== 'cols' && axis !== 'rows') return;
      if (!Array.isArray(values) || values.length !== 2) return;
      const a = tbHelpers.clamp(Number(values[0]) || 1, 0.2, 0.8);
      draft.ratios[axis] = [a, Number((2 - a).toFixed(4))];
    },
    notify: (draft, text) => {
      draft.notice = text === null || text === undefined || text === '' ? null : { text: String(text), at: Date.now() };
    },
    /**
     * Merge a host LayoutRecord. `isBindable` is the final gate for a foreign target: a
     * host record that names a leaf session (e.g. written by the `team_layout` tool) must
     * never enter the local store, so the pane is left empty instead.
     *
     * Host/client identity model is the same one (ARCHITECTURE §2.3 + host
     * `normalizeLayout`): the layout always holds the four fixed identities `pane-1..pane-4`
     * and `mode` only selects how many are visible. Therefore this merge fills empty local
     * panes only — it never deletes a pane, and a host record that omits an invisible pane
     * leaves that pane's binding untouched. A host record never carries `view`: the second
     * level is a client-side choice and must not be overwritten by a stale GET.
     */
    adoptHostLayout: (draft, layout, isBindable) => {
      draft.hostLayout = layout ?? null;
      if (!layout || typeof layout !== 'object') return;
      const hostMode = Number(layout.mode);
      if (tbModes.indexOf(hostMode) >= 0) draft.mode = hostMode;
      const hostPanes = Array.isArray(layout.panes) ? layout.panes : [];
      for (const hostPane of hostPanes) {
        if (!hostPane || typeof hostPane.paneId !== 'string') continue;
        const pane = draft.panes.find((candidate) => candidate.paneId === hostPane.paneId);
        if (pane === undefined) continue; // foreign paneId: ignored, never created
        // The host record wins only while the local pane has no binding: a local choice
        // made in this tab is never silently reverted by a stale GET.
        if (pane.target !== null || !hostPane.target) continue;
        if (typeof isBindable === 'function' && isBindable(hostPane.target) !== true) continue;
        pane.target = hostPane.target;
        pane.view = null;
        pane.role = tbPaneRoles.indexOf(hostPane.role) >= 0 ? hostPane.role : pane.role;
        pane.label = typeof hostPane.label === 'string' ? hostPane.label : pane.label;
      }
      if (typeof layout.activePaneId === 'string' && tbPaneIds.indexOf(layout.activePaneId) >= 0) draft.activePaneId = layout.activePaneId;
    }
  }
};

/** The one root-scoped store instance shared by the panel and the runtime controller. */
function tbCreatePinnedLayoutStore() {
  const handle = tbCreateStoreHandle(tbLayoutStoreSpec);
  const instance = handle.create();
  return { handle, instance, store: { ...handle, create: () => instance } };
}

/**
 * The session id a target actually renders.
 *
 * For an addressed subagent the *child* session is the one retained and rendered;
 * its address is kept so lineage and `parentAvailable` still resolve.
 */
function tbTargetSessionId(target) {
  if (!target || typeof target !== 'object') return undefined;
  if (target.kind === 'subagent') return typeof target.childSessionId === 'string' ? target.childSessionId : undefined;
  if (typeof target.sessionId === 'string') return target.sessionId;
  return undefined;
}

/** Stable dedupe key: one editor per session means one pane per resolved session id. */
function tbTargetKey(target) {
  const sessionId = tbTargetSessionId(target);
  return sessionId === undefined ? '' : sessionId;
}

/**
 * B6: coerce a persisted target into one of the two recognized shapes, or null. Also drops
 * `note`-era/foreign variants so the store never carries an unclassifiable address.
 */
function tbNormalizeTarget(target) {
  if (target === null || target === undefined || typeof target !== 'object') return null;
  if (typeof target.sessionId === 'string' && target.sessionId !== '') return { kind: 'session', sessionId: target.sessionId };
  if (typeof target.parentSessionId === 'string' && typeof target.childSessionId === 'string') {
    return { kind: 'subagent', parentSessionId: target.parentSessionId, childSessionId: target.childSessionId, mode: typeof target.mode === 'string' ? target.mode : 'unknown' };
  }
  return null;
}

/** The object handed to `sessions.retain()` (string id or the SubagentAddress). */
function tbTargetToRetainTarget(target) {
  if (!target || typeof target !== 'object') return undefined;
  if (target.kind === 'subagent') {
    if (typeof target.parentSessionId !== 'string' || typeof target.childSessionId !== 'string') return undefined;
    return { parentSessionId: target.parentSessionId, childSessionId: target.childSessionId, mode: target.mode ?? 'unknown' };
  }
  return typeof target.sessionId === 'string' ? target.sessionId : undefined;
}

/** Persisted target for a retained session id (subagent addresses keep their lineage). */
function tbTargetFromSession(sessionId, address) {
  if (address && typeof address.parentSessionId === 'string' && typeof address.childSessionId === 'string') {
    return { kind: 'subagent', parentSessionId: address.parentSessionId, childSessionId: address.childSessionId, mode: address.mode ?? 'unknown' };
  }
  return { kind: 'session', sessionId };
}

/** The retain-target for the SECOND-LEVEL view of one pane, or undefined (no view / bad shape). */
function tbViewRetainTarget(target, view) {
  if (!target || target.kind !== 'session' || typeof target.sessionId !== 'string') return undefined;
  if (view === null || view === undefined || typeof view !== 'object') return undefined;
  if (view.parentSessionId !== target.sessionId) return undefined;
  if (typeof view.childSessionId !== 'string' || view.childSessionId === '') return undefined;
  return { parentSessionId: view.parentSessionId, childSessionId: view.childSessionId, mode: view.mode ?? 'unknown' };
}

/** Effect dependency for a pane: its workspace target AND its second-level view. */
function tbPaneSignature(pane) {
  const target = tbTargetSignature(pane === undefined ? undefined : pane.target);
  const view = pane === undefined || pane.view === null || pane.view === undefined
    ? ''
    : [pane.view.parentSessionId, pane.view.childSessionId, pane.view.mode].join('>');
  return target + '|' + view;
}
