/* @local/dsh-team-workbench — React surface: workbench panel, pane head, conversation body.
 *
 * SURFACE v2 (docs/contracts/client-surface-v2.md, FROZEN). Shape (verified against
 * docs/contracts/client-api.md and the rc.2 bundles):
 *
 *   main entry (root scope, key 'team-workbench')
 *     ├─ declares `teamWorkbench.pane` (list / scope session) → yields `SessionProvider`
 *     ├─ renders one `tbPaneHost` per VISIBLE pane
 *     │    └─ SessionProvider session={SessionReference}   ← one occurrence per pane
 *     │         └─ renderSlot('teamWorkbench.pane', { paneId }, { only: paneId })
 *     │              └─ `tbPaneBody`: the ONE-line pane head + `conversation.content`
 *     └─ sidebar entry (list / root) renders the icon only
 *
 * User-facing contract:
 *   - a pane IS a workspace main session. Team members and subagents are NOT pane targets:
 *     they are a SECOND-LEVEL view opened from the pane's own 「子会话 N」 menu, exactly like
 *     the shell itself goes through a workspace session to reach its subagents;
 *   - the pane head is ONE permanent line: dot + title + [子会话 N] + [切换]; while a child is
 *     shown it is `‹ 返回 + child title`. No project/task/progress/status lines, no footer;
 *   - the team tree and the host/focus-bridge footer are GONE (they were pure small print);
 *   - default state is 1 pane, auto-bound to the session the user is already working in.
 *
 * Invariants kept here:
 *   - one session ⇒ one pane (duplicates focus the existing pane, never a second editor);
 *   - a pane that is not visible keeps its paneId→SessionAddress but holds NO
 *     SessionReference (release() is a client-side reference drop, never a Host stop);
 *   - every action takes an explicit paneId — no action reads "the latest global state";
 *   - no document/window keyboard listener is installed anywhere in this file.
 */

function tbUseSource(source) {
  return React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

/** Stable effect dependency for a target (the store clones objects on every update). */
function tbTargetSignature(target) {
  if (!target || typeof target !== 'object') return '';
  return [target.kind ?? 'session', target.sessionId ?? '', target.parentSessionId ?? '', target.childSessionId ?? '', target.mode ?? ''].join('|');
}

/**
 * Storage health of the Host snapshot (`snapshot.storage`), as a pure function so both the
 * pane and the acceptance harness can reason about it.
 *
 * Ordering is deliberate: `backend` is read FIRST, because a host generation that predates
 * `degraded` still reports `backend !== 'storageDomain'` — relying on `degraded` alone would
 * silently miss exactly the degraded state this row exists to explain.
 *
 *   - `durable === false`                                → critical (memory-only: nothing persists)
 *   - `degraded === true` OR backend ≠ 'storageDomain'    → warn (plugin's own backend in use)
 *   - otherwise                                           → ok (no row)
 *   - no `storage` at all (older host)                    → none (no row, never a false critical)
 *
 * Reporting only: the client never repairs, retries, clears data or reinstalls storage.
 */
function tbStorageHealth(storage) {
  if (storage === null || storage === undefined || typeof storage !== 'object') return { level: 'none' };
  const backend = typeof storage.backend === 'string' ? storage.backend : undefined;
  const degradedByBackend = backend !== undefined && backend !== 'storageDomain';
  const degraded = storage.degraded === true || degradedByBackend;
  const error = storage.backendError !== null && typeof storage.backendError === 'object' ? storage.backendError : undefined;
  const code = error !== undefined && typeof error.code === 'string' ? error.code : undefined;
  const message = error !== undefined && typeof error.message === 'string' ? error.message : undefined;
  const fallbackDir = typeof storage.fallbackDir === 'string' ? storage.fallbackDir : undefined;
  const detail = [
    backend === undefined ? '' : 'backend=' + backend,
    'durable=' + String(storage.durable),
    'degraded=' + String(degraded),
    code === undefined ? '' : 'backendError.code=' + code,
    message === undefined ? '' : 'backendError.message=' + message,
    fallbackDir === undefined ? '' : 'fallbackDir=' + fallbackDir
  ].filter((part) => part !== '').join(' | ');
  // Critical outranks warning: a memory-only backend loses data on restart.
  if (storage.durable === false) return { level: 'critical', backend, code, detail, fallbackDir };
  if (degraded) return { level: 'warn', backend, code, detail, fallbackDir };
  return { level: 'ok', backend, code, detail, fallbackDir };
}

/** The sidebar glyph. Own inline SVG (no client package import); `size` comes from the row.
 *  The narrow (rail) sidebar shows no row text, so `aria-label` + `title` + `<title>` are
 *  the only way a user can identify the entry/see a tooltip. */
function tbSidebarPanelIcon(props) {
  const size = typeof props.size === 'number' ? props.size : 18;
  const label = typeof props.t === 'function' ? props.t('panel.label') : 'Team Workbench';
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      role: 'img',
      'aria-label': label,
      title: label,
      focusable: 'false'
    },
    React.createElement('title', null, label),
    React.createElement('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, opacity: props.active ? 1 : 0.85 }),
    React.createElement('line', { x1: 8, y1: 2.5, x2: 8, y2: 13.5, stroke: 'currentColor', strokeWidth: 1.1 }),
    React.createElement('line', { x1: 1.5, y1: 8, x2: 14.5, y1: 8, stroke: 'currentColor', strokeWidth: 1.1 })
  );
}

/** Which visible-pane count a pane id needs, so focusing a hidden pane can reveal it. */
function tbModeForPane(paneId) {
  const index = tbPaneIds.indexOf(paneId);
  if (index < 1) return 1;
  if (index < 2) return 2;
  return 4;
}

/** Status dot class for one session state. */
function tbStatusTone(running, failed) {
  if (failed) return 'bad';
  if (running) return 'run';
  return 'idle';
}

/** Pane head for a pane with no session yet: one line + the empty hint (root scope). */
function tbPaneHeadEmpty(props) {
  const { paneId, t, runtime } = props;
  return React.createElement('div', { className: 'tb-pane-head' }, [
    React.createElement('div', { key: 'r1', className: 'tb-pane-row tb-pane-row-title' }, [
      React.createElement('span', { key: 'dot', className: 'tb-dot' }),
      React.createElement('span', { key: 'title', className: 'tb-pane-title' }, t('pane.unassigned')),
      React.createElement('button', {
        key: 'switch',
        type: 'button',
        className: 'tb-btn',
        title: t('picker.title'),
        onClick: () => runtime.requestPicker(paneId)
      }, t('action.switch'))
    ]),
    // The degraded-storage line must be visible on an EMPTY pane too: "nothing bound + storage
    // degraded" is precisely the state where a user would otherwise assume the plugin is broken.
    tbStorageRow(runtime, t)
  ]);
}

/**
 * The ONE-line pane head. It is a component (not a pure view) because the 「子会话」menu needs
 * local open/close state; nothing else is stored here.
 *
 *   bound, no view : ● <workspace title>            [子会话 N] [切换]
 *   second level   : [‹ 返回] ● <child title>
 */
function tbPaneHead(props) {
  const { pane, runtime, t, title, running, failed, children, onSwitch } = props;
  const [menuOpen, setMenuOpen] = React.useState(false);
  const view = pane === undefined || pane === null ? null : pane.view;
  const viewing = view !== null && view !== undefined;
  const row = [];
  if (viewing) {
    row.push(React.createElement('button', {
      key: 'back',
      type: 'button',
      className: 'tb-btn tb-btn-quiet',
      title: t('action.back'),
      onClick: () => runtime.closeChild(pane.paneId)
    }, '‹ ' + t('action.back')));
  }
  row.push(React.createElement('span', { key: 'dot', className: 'tb-dot tb-dot-' + tbStatusTone(running, failed) }));
  row.push(React.createElement('span', { key: 'title', className: 'tb-pane-title', title }, title));
  if (!viewing && children.length > 0) {
    row.push(React.createElement('button', {
      key: 'children',
      type: 'button',
      className: 'tb-btn',
      'aria-expanded': menuOpen ? 'true' : 'false',
      title: t('pane.children'),
      onClick: () => setMenuOpen(!menuOpen)
    }, tbFormat(t, 'pane.childrenCount', { n: children.length })));
  }
  if (!viewing) {
    row.push(React.createElement('button', {
      key: 'switch',
      type: 'button',
      className: 'tb-btn',
      title: t('picker.title'),
      onClick: onSwitch
    }, t('action.switch')));
  }
  const nodes = [React.createElement('div', { key: 'r1', className: 'tb-pane-row tb-pane-row-title' }, row)];
  if (menuOpen && !viewing) {
    nodes.push(React.createElement(tbChildMenu, {
      key: 'menu',
      children: children,
      t,
      onPick: (child) => {
        setMenuOpen(false);
        runtime.openChild(pane.paneId, child);
      },
      onClose: () => setMenuOpen(false)
    }));
  }
  nodes.push(tbStorageRow(runtime, t));
  return React.createElement('div', { className: 'tb-pane-head' }, nodes);
}

/** The 「子会话」menu: exactly the second-level sessions of THIS pane's workspace session. */
function tbChildMenu(props) {
  const { children, t, onPick, onClose } = props;
  const rows = children.map((child) => React.createElement('button', {
    key: child.id,
    type: 'button',
    className: 'tb-row tb-child-row',
    'data-child': child.id,
    title: child.id,
    onClick: () => onPick(child)
  }, [
    React.createElement('span', { key: 'dot', className: 'tb-dot tb-dot-' + (child.running ? 'run' : 'idle') }),
    React.createElement('span', { key: 'name', className: 'tb-row-name' }, child.label),
    child.kind === 'member' ? React.createElement('span', { key: 'kind', className: 'tb-child-kind' }, t('child.member')) : null
  ]));
  if (rows.length === 0) rows.push(React.createElement('div', { key: 'none', className: 'tb-note' }, t('pane.childrenEmpty')));
  return React.createElement('div', { className: 'tb-child-menu', role: 'menu', 'aria-label': t('pane.children') }, [
    React.createElement('div', { key: 'head', className: 'tb-child-menu-head' }, [
      React.createElement('span', { key: 't' }, t('pane.children')),
      React.createElement('button', { key: 'x', type: 'button', className: 'tb-btn tb-btn-quiet', onClick: onClose }, '×')
    ]),
    React.createElement('div', { key: 'rows' }, rows)
  ]);
}

/**
 * Panel-side pane host: owns exactly one SessionReference for its own lifetime and renders
 * the session body. Release happens explicitly in the cleanup (rc.2 abort does not release).
 *
 * SURFACE v2: what it retains is `runtime.retainPane(pane)` — the workspace session, or the
 * second-level child address when `pane.view` is set (guarded by `childrenOf`).
 */
function tbPaneHost(props) {
  const { pane, runtime, SessionProvider, renderSlot, t, actions, active } = props;
  const signature = tbPaneSignature(pane);
  const [entry, setEntry] = React.useState({ status: 'empty' });
  // A1: the verdict is recomputed on every render, so a session-list / projection arrival
  // (which re-renders the panel) re-evaluates the pane: 'unknown' can recover to a bindable
  // verdict. The verdict — not the list identity — is the effect dependency, so message
  // traffic never re-retains.
  const classification = signature === '' ? { verdict: 'none', evidence: 'no-target' } : runtime.classifyTarget(pane.target);
  const verdict = classification.verdict;
  // A live reference holder + released flag: the provider must never receive a reference
  // that a cleanup already released (B8), even for the intermediate render that React can
  // produce between a cleanup and the following effect.
  const holder = React.useRef({ reference: undefined, released: false });

  React.useEffect(() => {
    runtime.noteTargetVerdict(pane.paneId, signature, verdict, classification.evidence);
    if (signature === '') {
      holder.current = { reference: undefined, released: true };
      setEntry({ status: 'empty' });
      return undefined;
    }
    if (verdict === 'member') {
      // Surface v2 migration: a persisted/host record that bound a team member is re-expressed
      // as 「team root session + member as second-level view」. The store update re-runs this
      // effect with the new signature; until then the pane shows the pending line.
      holder.current = { reference: undefined, released: true };
      setEntry({ status: 'pending', verdict: 'member' });
      runtime.migratePaneIfMember(pane.paneId);
      return undefined;
    }
    if (verdict === 'leaf') {
      // Positive leaf evidence: drop it from the store and correct the host record. Never
      // render it, never retain it.
      holder.current = { reference: undefined, released: true };
      runtime.stripPaneTarget(pane.paneId, pane.target);
      setEntry({ status: 'stripped', verdict: 'leaf' });
      return undefined;
    }
    if (verdict !== 'main') {
      // Fail-closed: no positive evidence yet. Keep the target in the store (non-destructive)
      // and show the pending state; a later list update re-runs this.
      holder.current = { reference: undefined, released: true };
      setEntry({ status: 'pending', verdict: 'unknown' });
      return undefined;
    }
    const controller = new AbortController();
    let reference;
    try {
      reference = runtime.retainPane(pane, controller.signal);
    } catch (error) {
      holder.current = { reference: undefined, released: true };
      setEntry({ status: 'error', message: tbHelpers.errorText(error) });
      return () => controller.abort();
    }
    if (reference === undefined) {
      holder.current = { reference: undefined, released: true };
      setEntry({ status: 'stripped', verdict: 'leaf' });
      return () => controller.abort();
    }
    holder.current = { reference, released: false };
    setEntry({ status: 'ready', sessionId: reference.sessionId });
    return () => {
      // Release-only: the Host Agent keeps running (ARCHITECTURE §3.5).
      // rc.2 fact (dsh-api-session-controller/lib/client.js:3192-3205): aborting
      // `options.signal` only rejects the pending `ready` wait, it never drops the
      // reference — `release()` must be called explicitly (idempotent).
      const held = holder.current.reference;
      holder.current = { reference: undefined, released: true };
      try {
        if (held !== undefined) held.release();
      } catch (error) {
        console.error('[team-workbench] SessionReference release failed:', error);
      }
      controller.abort();
    };
  }, [runtime, signature, verdict, classification.verdict]);

  const children = [];
  const live = holder.current.reference !== undefined && holder.current.released === false;
  if (entry.status === 'ready' && live && SessionProvider !== undefined) {
    children.push(React.createElement(SessionProvider, {
      key: 'body',
      session: holder.current.reference,
      empty: () => React.createElement('div', { className: 'tb-cell-empty' }, t('pane.unassigned')),
      children: renderSlot(tbPaneSlotKey, { paneId: pane.paneId }, { only: pane.paneId })
    }));
  } else {
    children.push(React.createElement(tbPaneHeadEmpty, { key: 'head', paneId: pane.paneId, t, runtime }));
    children.push(React.createElement('div', { key: 'sep', className: 'tb-sep' }));
    if (SessionProvider === undefined) {
      children.push(React.createElement('div', { key: 'err', className: 'tb-err' }, t('error.sessionProviderMissing')));
    } else if (entry.status === 'error') {
      children.push(React.createElement('div', { key: 'err', className: 'tb-err' }, t('pane.unassigned') + ': ' + entry.message));
    } else if (entry.status === 'stripped') {
      // The pane stays empty and says why (never a silent blank, never a leaf render).
      children.push(React.createElement('div', { key: 'stripped', className: 'tb-cell-empty' }, t('notice.leafRejected')));
    } else if (entry.status === 'pending') {
      // Fail-closed while the session data has not arrived; recovers by itself (A1).
      children.push(React.createElement('div', { key: 'pending', className: 'tb-cell-empty' }, t('notice.targetNotLoaded')));
    } else {
      children.push(React.createElement('div', { key: 'empty', className: 'tb-cell-empty' }, t('pane.unassignedHint')));
    }
  }

  return React.createElement('div', {
    className: 'tb-cell',
    'data-active': active ? 'true' : 'false',
    'data-pane-id': pane.paneId,
    onPointerDown: () => actions.setActive(pane.paneId)
  }, children);
}

/**
 * Registered entry for `teamWorkbench.pane`.
 *
 * B7: this dispatcher calls NO hooks. It picks between three components with stable hook
 * sets, so a change in the injected seats' definedness remounts the subtree instead of
 * changing the hook count of a live component (which React rejects with "Rendered more
 * hooks than during the previous render" — the old code called hooks conditionally and
 * could blank the whole pane entry).
 */
function tbPaneBody(props) {
  const essential = typeof props.useSession === 'function'
    && typeof props.useSessions === 'function'
    && typeof props.renderFactorySlot === 'function'
    && props.teamWorkbenchRuntime !== null
    && typeof props.teamWorkbenchRuntime === 'object';
  if (!essential) return React.createElement(tbPaneBodyUnbound, { t: typeof props.t === 'function' ? props.t : (key) => key });
  const hasOptional = typeof props.useSessionStatus === 'function' && typeof props.useProjection === 'function';
  return hasOptional ? React.createElement(tbPaneBodyFull, props) : React.createElement(tbPaneBodyReduced, props);
}

/** Fallback body when the session seats are not injected (no hooks at all). */
function tbPaneBodyUnbound(props) {
  return React.createElement('div', { className: 'tb-cell-empty' }, props.t('error.sessionSeatsMissing'));
}

/** Full variant: status + projection seats available. Hook set is fixed for its lifetime. */
function tbPaneBodyFull(props) {
  const { sessionId, useSession, useSessions, useSessionStatus, useProjection } = props;
  const layout = tbUseSource(props.teamWorkbenchRuntime.layoutSource);
  // Host `/state` snapshot (usage / findings / errorFingerprints / storage): subscribing here is
  // what makes the read-only projections below appear when the asynchronous /state answer lands.
  // It only schedules a re-render — no fetch, no model call, no dispatch, no log rescan.
  const hostState = tbUseSource(props.teamWorkbenchRuntime.bridge.snapshotSource);
  const sessionsList = useSessions((s) => s);
  const session = useSession((s) => s);
  const status = useSessionStatus((s) => (sessionId === undefined ? undefined : s.get(sessionId)));
  const ownTeamProjection = useProjection('agentTeam');
  return tbPaneBodyView({ props, layout, sessionsList, session, status, hostState, ownTeamProjection, ownTeamProjectionSeat: true });
}

/** Reduced variant: no status/projection seats. Same view, same hook count every render. */
function tbPaneBodyReduced(props) {
  const { sessionId, useSession, useSessions } = props;
  const layout = tbUseSource(props.teamWorkbenchRuntime.layoutSource);
  const hostState = tbUseSource(props.teamWorkbenchRuntime.bridge.snapshotSource);
  const sessionsList = useSessions((s) => s);
  const session = useSession((s) => s);
  return tbPaneBodyView({ props, layout, sessionsList, session, status: undefined, hostState, ownTeamProjection: undefined, ownTeamProjectionSeat: false });
}

/**
 * The pane body itself: a pure function (NO hooks) parameterized by the resolved seats, so
 * both variants share one layout implementation. The only hook users are `tbPaneHead` (menu
 * state) and `tbMemberPanel` (detail state), both rendered as children.
 */
function tbPaneBodyView(model) {
  const { props, layout, sessionsList, session, status, hostState } = model;
  const { paneId, renderFactorySlot, t } = props;
  const runtime = props.teamWorkbenchRuntime;
  const pane = layout.panes.find((candidate) => candidate.paneId === paneId) ?? { paneId, target: null, view: null, role: 'auto', label: '' };
  const viewing = pane.view !== null && pane.view !== undefined;
  const parentSessionId = pane.target === null || pane.target === undefined ? undefined : pane.target.sessionId;

  const teamIndex = React.useMemo(() => tbBuildTeamIndex(sessionsList), [sessionsList]);
  const sessionId = pane.view !== null && pane.view !== undefined
    ? pane.view.childSessionId
    : (props.sessionId ?? (parentSessionId === undefined ? undefined : parentSessionId));
  const summary = sessionId === undefined ? undefined : sessionsList.byId?.[sessionId];
  const roleInfo = sessionId === undefined ? undefined : teamIndex.roleBySession[sessionId];
  const memberName = roleInfo === undefined ? undefined : roleInfo.memberName;
  const running = status?.running === true || summary?.running === true;
  const failed = typeof session?.lastAgentError !== 'undefined' && session.lastAgentError !== null;
  const blank = session?.blank === true;

  const title = viewing
    ? (pane.view.label !== '' ? pane.view.label : (summary?.displayTitle ?? sessionId ?? t('pane.unassigned')))
    : (summary?.displayTitle ?? sessionId ?? t('pane.unassigned'));
  const children = viewing || parentSessionId === undefined ? [] : runtime.childrenOf(parentSessionId);

  const head = React.createElement(tbPaneHead, {
    key: 'head',
    pane,
    runtime,
    t,
    title,
    running,
    failed,
    children,
    onSwitch: () => runtime.requestPicker(paneId)
  });

  const variant = layout.mode === 1 ? 'main' : 'embedded';
  const hero = !running && blank && (session?.openState === 'open' || summary?.blank === true);
  const settling = session?.openState === 'loading';
  const phase = settling ? 'settling' : hero ? 'hero' : 'active';
  const conversationTree = renderFactorySlot('conversation.content', { variant, phase, hero }, { slots: { views: tbPaneConversationView } });

  // autonomy-v1 §八: a MEMBER second-level view must show what the member ITSELF decided
  // (one summary line + on-demand details). A workspace session keeps just the conversation.
  const isMemberView = viewing && roleInfo !== undefined && (roleInfo.role === 'member' || roleInfo.role === 'lead');
  const autonomy = isMemberView ? runtime.autonomyFor(sessionId) : undefined;
  // 工作台运行状态: cost + real results, read straight from the same `/state` snapshot
  // (CONTRACT.md §1). Nothing is fabricated here — the projections report their own missing
  // fields and the UI prints 「未提供」/「等待宿主数据」.
  // `ownerMemberId` / `scopes.byOwner` keys are host-owned, so the member pane tries the session
  // id, the member name and the member id it knows, in that order (documented, not guessed).
  const ownerKeys = isMemberView
    ? [sessionId, memberName, roleInfo.memberName].filter((value) => typeof value === 'string' && value !== '')
    : [];
  const snapshot = hostState !== null && hostState !== undefined ? hostState.snapshot : undefined;
  const usage = isMemberView ? tbUsageFor(snapshot, ownerKeys) : undefined;
  const findings = isMemberView ? tbFindingsFor(snapshot, ownerKeys) : undefined;
  const fingerprints = isMemberView ? tbErrorFingerprintsFor(snapshot, ownerKeys) : undefined;
  const memberBlock = isMemberView && sessionId !== undefined
    ? React.createElement(tbMemberPanel, {
      key: 'member',
      paneId,
      sessionId,
      memberLabel: memberName ?? roleInfo.memberName ?? title,
      autonomy,
      usage,
      findings,
      fingerprints,
      // Host detail pages are scoped by owner/team; keys come from what the client knows.
      ownerKeys,
      teamKey: roleInfo === undefined ? undefined : roleInfo.teamKey,
      runtime,
      t
    })
    : null;

  return React.createElement('div', { className: 'tb-cell-inner' }, [
    head,
    memberBlock,
    React.createElement('div', { key: 'sep', className: 'tb-sep' }),
    React.createElement('div', { key: 'conv', className: 'tb-cell-body' }, conversationTree)
  ]);
}

/**
 * The storage-health line, shared by BOTH pane heads (bound and unbound): the degraded state
 * matters most exactly when nothing is bound yet, so it must not depend on a session being
 * present. Read-only reporting — no repair, no retry, no data clearing.
 */
function tbStorageRow(runtime, t) {
  const hostState = runtime.bridge.snapshotSource.getSnapshot();
  const snapshot = hostState !== null && hostState !== undefined ? hostState.snapshot : undefined;
  const storage = snapshot !== null && snapshot !== undefined ? snapshot.storage : undefined;
  const health = tbStorageHealth(storage);
  if (health.level !== 'warn' && health.level !== 'critical') return null;
  const textKey = health.level === 'critical' ? 'storage.critical' : 'storage.warn';
  return React.createElement('div', {
    key: 'storage',
    className: 'tb-pane-row tb-storage-row tb-storage-' + health.level,
    'data-storage-level': health.level,
    title: t(textKey) + ' | ' + health.detail
  }, [
    React.createElement('span', { key: 'text' }, t(textKey)),
    health.code === undefined ? null : React.createElement('span', { key: 'code' }, tbFormat(t, 'storage.codeLabel', { code: health.code })),
    health.fallbackDir === undefined ? null : React.createElement('span', { key: 'dir' }, tbFormat(t, 'storage.fallbackLabel', { dir: health.fallbackDir })),
    React.createElement('span', { key: 'hint' }, t('storage.restartHint'))
  ]);
}

/** The `views` local slot selection: the pane's own body view inside the factory. */
function tbPaneConversationView(props) {
  return React.createElement(React.Fragment, null, props.renderSlot('conversation.session', {}));
}

/** The folder glyph used by the picker's Workspace headers (own inline SVG; 14px). */
function tbFolderIcon() {
  return React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, [
    React.createElement('path', {
      key: 'f',
      d: 'M1.8 3.4c0-.5.4-.9.9-.9h3.1l1.3 1.5h5.3c.5 0 .9.4.9.9v6.7c0 .5-.4.9-.9.9H2.7c-.5 0-.9-.4-.9-.9V3.4Z',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.2,
      strokeLinejoin: 'round'
    })
  ]);
}

/**
 * The session picker — a faithful miniature of the shell's own session list (user request
 * 「模仿 dsh 主页面的会话」, surface v2):
 *
 *   选择工作区会话
 *   [filter input]
 *   ▾ 📁 dsh
 *       超级工作台                       刚刚     ← the pane's current session
 *       你好                             2天
 *   ▾ 📁 Workspace
 *   ▾ 📁 未分组
 *   ─────────────
 *   释放本窗
 *
 * There is NO close "×" (the user called it useless). It closes the way a real menu does:
 * a click on the backdrop, Escape in the filter, picking a session, or pressing the same
 * 「切换」 button again (the panel toggles it).
 */
function tbSessionPicker(props) {
  const { runtime, layout, candidates, t, paneId, onClose } = props;
  const [filter, setFilter] = React.useState('');
  const [collapsed, setCollapsed] = React.useState({});
  const pane = layout.panes.find((candidate) => candidate.paneId === paneId);
  const currentSessionId = pane === undefined || pane.target === null || pane.target === undefined ? undefined : pane.target.sessionId;
  const groups = tbSessionGroups(tbFilterCandidates(candidates, filter), runtime.workspaceGroups());
  const nodes = [];
  for (const group of groups) {
    const isCollapsed = collapsed[group.key] === true;
    const label = group.workspaceId === undefined ? t('picker.ungrouped') : group.title;
    nodes.push(React.createElement('button', {
      key: 'g-' + group.key,
      type: 'button',
      className: 'tb-ws-group',
      'data-group': group.key,
      'aria-expanded': isCollapsed ? 'false' : 'true',
      title: label,
      onClick: () => setCollapsed({ ...collapsed, [group.key]: !isCollapsed })
    }, [
      React.createElement('span', { key: 'chevron', className: 'tb-ws-chevron' }, isCollapsed ? '▸' : '▾'),
      React.createElement('span', { key: 'folder', className: 'tb-ws-folder' }, tbFolderIcon()),
      React.createElement('span', { key: 'name', className: 'tb-ws-name' }, label)
    ]));
    if (isCollapsed) continue;
    for (const candidate of group.sessions) {
      const bound = layout.panes.find((row) => row.target !== null && row.target !== undefined && tbTargetSessionId(row.target) === candidate.id);
      const isCurrent = candidate.id === currentSessionId;
      nodes.push(React.createElement('button', {
        key: 's-' + candidate.id,
        type: 'button',
        className: 'tb-ws-session',
        'data-candidate': candidate.id,
        'data-current': isCurrent ? 'true' : 'false',
        title: candidate.id,
        onClick: () => {
          if (bound !== undefined && !isCurrent) runtime.focusPane(bound.paneId);
          else if (!isCurrent) runtime.bindTarget(paneId, { kind: 'session', sessionId: candidate.id }, 'auto', candidate.row.displayTitle);
          onClose();
        }
      }, [
        candidate.row.running === true ? React.createElement('span', { key: 'dot', className: 'tb-dot tb-dot-run' }) : null,
        React.createElement('span', { key: 'title', className: 'tb-ws-title' }, candidate.row.displayTitle),
        React.createElement('span', { key: 'time', className: 'tb-ws-time' }, tbHelpers.compactAgo(candidate.row.updatedAt, Date.now(), t))
      ]));
    }
  }
  if (nodes.length === 0) nodes.push(React.createElement('div', { key: 'none', className: 'tb-note' }, t('picker.empty')));
  return React.createElement(React.Fragment, null, [
    React.createElement('div', {
      key: 'backdrop',
      className: 'tb-picker-backdrop',
      'data-picker-backdrop': paneId,
      onClick: onClose
    }),
    React.createElement('div', { key: 'panel', className: 'tb-picker', role: 'dialog', 'aria-label': t('picker.title') }, [
      React.createElement('div', { key: 'head', className: 'tb-picker-head' }, t('picker.title')),
      React.createElement('input', {
        key: 'q',
        type: 'text',
        value: filter,
        placeholder: t('picker.search'),
        'aria-label': t('picker.search'),
        onChange: (event) => setFilter(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Escape') onClose();
        }
      }),
      React.createElement('div', { key: 'groups', className: 'tb-ws-groups' }, nodes),
      React.createElement('button', {
        key: 'release',
        type: 'button',
        className: 'tb-ws-release',
        'data-release-pane': paneId,
        onClick: () => {
          runtime.clearPane(paneId);
          onClose();
        }
      }, t('picker.releasePane'))
    ])
  ]);
}

/** The session the first pane should adopt on open: native main view, else running, else first. */
function tbDefaultCandidate(candidates, sessionsList) {
  if (candidates.length === 0) return undefined;
  const nativeMain = candidates.find((candidate) => (sessionsList.byId?.[candidate.id]?.retainedBy?.mainView ?? 0) > 0);
  if (nativeMain !== undefined) return nativeMain;
  const runningMain = candidates.find((candidate) => candidate.row.running === true);
  if (runningMain !== undefined) return runningMain;
  return candidates[0];
}

/** The `main` panel: one toolbar, the pane grid, the picker overlay. Nothing else. */
function tbWorkbenchPanel(props) {
  const { SessionProvider, renderSlot, useSessions, usePanelInfo, useStore, actions, t, teamWorkbenchRuntime } = props;
  const runtime = teamWorkbenchRuntime;
  const layout = useStore((s) => s);
  const sessionsList = useSessions((s) => s);
  const panelActive = usePanelInfo((info) => info.activePanelId === tbPanelId);
  const [pickerPaneId, setPickerPaneId] = React.useState(null);
  const autoBound = React.useRef(false);
  const teamIndex = React.useMemo(() => tbBuildTeamIndex(sessionsList), [sessionsList]);
  const candidates = React.useMemo(
    () => tbSessionCandidates(sessionsList, teamIndex, runtime.isLeafSession, runtime.archivedSessionIds()),
    [sessionsList, teamIndex, runtime]
  );
  const visiblePanes = layout.panes.slice(0, layout.mode);
  const activePane = layout.panes.find((pane) => pane.paneId === layout.activePaneId) ?? visiblePanes[0];
  const activeTarget = activePane === undefined ? undefined : activePane.target;
  const activeSignature = tbPaneSignature(activePane);

  // Focus isolation: the compat bridge and the focus handler are driven by the active pane only.
  // While a second-level view is open the bridge follows THE CHILD (what the user really sees).
  const activeFocusTarget = activePane === undefined || activePane.view === null || activePane.view === undefined
    ? activeTarget
    : { kind: 'subagent', parentSessionId: activePane.view.parentSessionId, childSessionId: activePane.view.childSessionId, mode: activePane.view.mode };

  React.useEffect(() => {
    runtime.noteActiveTarget(activeFocusTarget);
  }, [runtime, activeSignature]);

  React.useEffect(() => {
    runtime.compat.setFocusRequestHandler((paneId) => actions.setActive(paneId));
    return () => runtime.compat.setFocusRequestHandler(undefined);
  }, [runtime, actions]);

  React.useEffect(() => {
    // The pane's single 「切换」 action toggles this picker (surface v2 has no close "×": the
    // same button, the backdrop, Escape and picking a row are the ways out).
    runtime.setPickerRequestHandler((paneId) => setPickerPaneId((current) => (current === paneId ? null : paneId)));
    return () => runtime.setPickerRequestHandler(undefined);
  }, [runtime]);

  React.useEffect(() => {
    runtime.setPanelActive(panelActive === true);
  }, [runtime, panelActive]);

  // A2: unmount (and HMR remount) must not leave the panel's focus armed. A separate
  // mount-lifetime effect is used on purpose: putting this in the deps-carrying effect above
  // would clear and re-arm the bridge on every pane focus change.
  React.useEffect(() => {
    runtime.setPanelMounted(true);
    // Frontend activation ACK (CONTRACT §8.3): published ≠ activated. The ack is pure metadata
    // (bundle url + activation time + which components mounted) posted once per mount — no model
    // call, no account/session data, no desktop interaction. Failures stay recorded for diagnosis.
    runtime.noteFrontendMount('main');
    return () => {
      runtime.setPanelMounted(false);
      // Unmount must not keep reporting `mounted` in the activation ack.
      runtime.noteFrontendUnmount('main');
    };
  }, [runtime]);

  React.useEffect(() => {
    runtime.refreshHost();
  }, [runtime]);

  // A1: re-judge every stored target whenever the session list changes, so a target that was
  // 'unknown' at mount recovers as soon as its row/projection arrives, a member-bound pane is
  // migrated to 「workspace session + child view」, and one that is proven to be a leaf is
  // stripped (and the host record corrected).
  React.useEffect(() => {
    runtime.reconcileStoredTargets();
  }, [runtime, sessionsList]);

  // Default usability: the first pane adopts the session the user is already working in
  // (native main-view retention, then a running session), once per mount and only while that
  // pane is still empty — a persisted or user-chosen pane is never overridden.
  React.useEffect(() => {
    if (autoBound.current) return;
    const first = layout.panes[0];
    if (first === undefined || first.target !== null) {
      autoBound.current = true;
      return;
    }
    const preferred = tbDefaultCandidate(candidates, sessionsList);
    if (preferred === undefined) return;
    autoBound.current = true;
    runtime.bindTarget(first.paneId, { kind: 'session', sessionId: preferred.id }, 'auto', preferred.row.displayTitle);
  }, [runtime, candidates, layout, sessionsList]);

  // 布局：1 → 1×1；**2 → 1 行 2 列（两窗并排、铺满整窗）**；4 → 2×2。
  const rows = layout.mode === 4 ? 2 : 1;
  const cols = layout.mode === 1 ? 1 : 2;
  const cells = visiblePanes.map((pane) => React.createElement(tbPaneHost, {
    key: pane.paneId,
    pane,
    runtime,
    SessionProvider,
    renderSlot,
    t,
    actions,
    active: pane.paneId === layout.activePaneId
  }));
  const gridStyle = {
    gridTemplateColumns: cols === 1 ? '1fr' : '1fr 1fr',
    gridTemplateRows: rows === 1 ? '1fr' : '1fr 1fr'
  };

  const modeButtons = tbModes.map((mode) => React.createElement('button', {
    key: 'mode-' + mode,
    type: 'button',
    className: 'tb-btn',
    'aria-pressed': layout.mode === mode ? 'true' : 'false',
    onClick: () => runtime.setMode(mode)
  }, t('action.mode' + mode)));

  const notice = layout.notice === null || layout.notice === undefined
    ? null
    : React.createElement('div', { className: 'tb-notice' }, [
      React.createElement('span', { key: 'n' }, layout.notice.text),
      React.createElement('button', { key: 'x', type: 'button', className: 'tb-btn tb-btn-quiet', onClick: () => actions.notify(null) }, '×')
    ]);

  return React.createElement('div', { className: 'tb-root' }, [
    React.createElement('div', { key: 'main', className: 'tb-main' }, [
      React.createElement('div', { key: 'bar', className: 'tb-bar' }, [
        React.createElement('span', { key: 'title', className: 'tb-bar-title' }, t('panel.label')),
        modeButtons,
        React.createElement('span', { key: 'g', style: { flex: '1 1 auto' } })
      ]),
      notice,
      React.createElement('div', { key: 'grid', className: 'tb-grid', style: gridStyle }, cells),
      pickerPaneId === null ? null : React.createElement(tbSessionPicker, {
        key: 'picker',
        runtime,
        layout,
        candidates,
        t,
        paneId: pickerPaneId,
        onClose: () => setPickerPaneId(null)
      })
    ])
  ]);
}
