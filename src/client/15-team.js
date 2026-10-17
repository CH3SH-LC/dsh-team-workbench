/* @local/dsh-team-workbench — compact team index derived from session projections.
 *
 * Sources (both public, no RPC):
 *   - `ctx.sessions.list` → `projectionsBySession[leadId].values.agentTeam`
 *     = `{ members: [{ id, name, role:'lead'|'teammate', phase, error? }], tasks:
 *     [{ id, subject, status, ownerName?, ready, blockedBy, writeScopeWarnings }],
 *     failure? }` (host `teamProjectionDefinition`, stateVersion 4)
 *   - `projectionsBySession[leadId].values.subagentCatalog` = the compact child list
 *   - `SessionSnapshot.subagent.address` = lineage for the pane that renders a child
 *
 * Members are keyed by their **session id** (`id: sessionIdSchema`), which is what
 * makes "member id → session to pin in a pane" exact.
 */

/** Which Team (if any) a session belongs to, plus its member/role facts. */
function tbBuildTeamIndex(listSnapshot) {
  const teams = [];
  const roleBySession = Object.create(null);
  const activeTaskByOwner = Object.create(null);
  if (!listSnapshot || typeof listSnapshot !== 'object') return { teams, roleBySession, activeTaskByOwner };
  const byId = listSnapshot.byId ?? {};
  const projections = listSnapshot.projectionsBySession ?? {};
  for (const leadSessionId of Object.keys(projections)) {
    const values = projections[leadSessionId]?.values;
    const team = values?.agentTeam;
    if (!values || team === undefined || team === null || typeof team !== 'object') continue;
    const members = Array.isArray(team.members) ? team.members : [];
    const tasks = Array.isArray(team.tasks) ? team.tasks : [];
    const subagents = Array.isArray(values.subagentCatalog) ? values.subagentCatalog : [];
    const record = {
      leadSessionId,
      title: byId[leadSessionId]?.displayTitle ?? leadSessionId,
      cwd: byId[leadSessionId]?.cwd,
      failure: typeof team.failure === 'string' ? team.failure : undefined,
      members: members.map((member) => ({
        id: String(member?.id ?? ''),
        name: String(member?.name ?? 'member'),
        role: member?.role === 'lead' ? 'lead' : 'teammate',
        phase: String(member?.phase ?? 'active'),
        error: typeof member?.error === 'string' ? member.error : undefined
      })).filter((member) => member.id !== ''),
      tasks: tasks.map((task) => ({
        id: String(task?.id ?? ''),
        subject: String(task?.subject ?? ''),
        status: String(task?.status ?? 'pending'),
        ownerName: typeof task?.ownerName === 'string' ? task.ownerName : undefined,
        ready: task?.ready === true,
        blockedBy: Array.isArray(task?.blockedBy) ? task.blockedBy.map(String) : [],
        writeScopeWarnings: Array.isArray(task?.writeScopeWarnings) ? task.writeScopeWarnings.map(String) : []
      })),
      subagents: subagents.map((child) => ({
        id: String(child?.id ?? ''),
        label: typeof child?.label === 'string' ? child.label : undefined,
        parentSessionId: leadSessionId,
        mode: typeof child?.mode === 'string' ? child.mode : undefined
      })).filter((child) => child.id !== '')
    };
    teams.push(record);
    for (const member of record.members) {
      roleBySession[member.id] = {
        teamKey: leadSessionId,
        teamTitle: record.title,
        role: member.role === 'lead' ? 'lead' : 'member',
        memberName: member.name,
        phase: member.phase,
        error: member.error
      };
    }
    for (const task of record.tasks) {
      if (task.ownerName === undefined) continue;
      if (task.status === 'completed' || task.status === 'deleted') continue;
      const bucket = activeTaskByOwner[task.ownerName] ?? (activeTaskByOwner[task.ownerName] = []);
      bucket.push({ teamKey: leadSessionId, id: task.id, subject: task.subject, status: task.status, ready: task.ready });
    }
    for (const child of record.subagents) {
      if (roleBySession[child.id] === undefined) {
        roleBySession[child.id] = {
          teamKey: leadSessionId,
          teamTitle: record.title,
          role: 'subagent',
          memberName: child.label ?? child.id,
          phase: 'active'
        };
      }
    }
  }
  // Children whose parent is a team member but that never entered the lead's catalog.
  for (const id of Object.keys(byId)) {
    if (roleBySession[id] !== undefined) continue;
    const parentId = byId[id].parentId;
    if (typeof parentId === 'string' && roleBySession[parentId] !== undefined) {
      roleBySession[id] = {
        teamKey: roleBySession[parentId].teamKey,
        teamTitle: roleBySession[parentId].teamTitle,
        role: 'subagent',
        memberName: byId[id].projectionValues?.subagent?.label ?? id,
        phase: 'active'
      };
    }
  }
  return { teams, roleBySession, activeTaskByOwner };
}

/** The current (non-completed) task subject for one member name, or undefined. */
function tbCurrentTask(activeTaskByOwner, memberName) {
  if (memberName === undefined || activeTaskByOwner === null || activeTaskByOwner === undefined) return undefined;
  const bucket = activeTaskByOwner[memberName];
  if (!Array.isArray(bucket) || bucket.length === 0) return undefined;
  const inProgress = bucket.find((task) => task.status === 'in_progress');
  return inProgress ?? bucket[0];
}

/** Status dot class for one member phase / session status. */
function tbStatusTone(running, failed, pending) {
  if (failed) return 'bad';
  if (pending) return 'wait';
  if (running) return 'run';
  return 'idle';
}

/**
 * The ONLY bindable session set — SURFACE v2 (docs/contracts/client-surface-v2.md):
 *
 *   **workspace main sessions only.** A team member session, a continuable/one-shot child and
 *   a leaf are ALL excluded here, before rendering and before search. Members are reachable
 *   only as the SECOND-LEVEL view of the workspace session that owns them
 *   ({@link tbSessionChildren}), never as a pane target.
 *
 * The team LEAD session is a normal top-level session, so it stays bindable.
 *
 * @param {object} listSnapshot - `sessions.list` snapshot.
 * @param {object} teamIndex - `tbBuildTeamIndex(...)` result.
 * @param {(id: string) => boolean} isLeaf - authoritative read-layer probe (see the runtime):
 *   `binding(id).session.getSnapshot().subagent != null`, falling back to the list row's
 *   `origin`/`parentId`/`subagent` projection when the session is not currently open.
 * @param {string[]|undefined} archivedIds - B4: archived sessions never reach the picker and
 *   never take part in auto-binding (the client reads them from the workspace controller's
 *   `archivedSessionIds`; when that list is unavailable the caller passes none).
 * @returns {Array<{id: string, kind: 'main', role: 'main', row: object}>}
 */
function tbSessionCandidates(listSnapshot, teamIndex, isLeaf, archivedIds) {
  const out = [];
  if (listSnapshot === null || listSnapshot === undefined || typeof listSnapshot !== 'object') return out;
  const byId = listSnapshot.byId ?? {};
  const roles = teamIndex !== null && teamIndex !== undefined ? teamIndex.roleBySession : {};
  const leaf = typeof isLeaf === 'function' ? isLeaf : () => false;
  const archived = new Set(Array.isArray(archivedIds) ? archivedIds : []);
  for (const id of listSnapshot.ids ?? []) {
    const row = byId[id];
    if (row === undefined || row === null) continue;
    if (archived.has(id)) continue; // B4: archived sessions are not selectable
    const info = roles[id];
    // Any role other than the team lead is a second-level session, not a workspace session.
    if (info !== undefined && info.role !== 'lead') continue;
    // Everything else must be a plain top-level session; leaves are dropped here too.
    if (leaf(id)) continue;
    out.push({ id, kind: 'main', role: 'main', row });
  }
  // Stable order: running first, then most recent activity, then title.
  out.sort((left, right) => {
    const runningDelta = (right.row.running === true ? 1 : 0) - (left.row.running === true ? 1 : 0);
    if (runningDelta !== 0) return runningDelta;
    const timeDelta = (right.row.updatedAt ?? 0) - (left.row.updatedAt ?? 0);
    if (timeDelta !== 0) return timeDelta;
    return String(left.row.displayTitle ?? left.id).localeCompare(String(right.row.displayTitle ?? right.id));
  });
  return out;
}

/**
 * The SECOND-LEVEL session list of one workspace session (surface v2): the only way a
 * subagent / team member is ever reachable from the workbench.
 *
 * Sources, union by session id:
 *   1. `projectionsBySession[parent].values.subagentCatalog` — the compact child list the
 *      shell already maintains for every session (members ARE subagents of the lead);
 *   2. the `agentTeam.members` roster of the team whose root is `parentSessionId` — used when
 *      the catalog projection has not arrived yet (and to learn the member's display name).
 *
 * Nothing is invented: a child that appears in neither source is not listed, so
 * `openChild`/`retainChild` can never open an address the read layer cannot vouch for.
 *
 * @returns {Array<{id: string, label: string, mode: string, kind: 'member'|'subagent', running: boolean}>}
 */
function tbSessionChildren(listSnapshot, teamIndex, parentSessionId) {
  const out = [];
  if (listSnapshot === null || listSnapshot === undefined || typeof listSnapshot !== 'object') return out;
  if (typeof parentSessionId !== 'string' || parentSessionId === '') return out;
  const byId = listSnapshot.byId ?? {};
  const projections = listSnapshot.projectionsBySession ?? {};
  const seen = new Set();
  const push = (id, label, mode, kind) => {
    if (typeof id !== 'string' || id === '' || id === parentSessionId || seen.has(id)) return;
    seen.add(id);
    const row = byId[id];
    out.push({
      id,
      label: typeof label === 'string' && label !== '' ? label : (row?.displayTitle ?? id),
      mode: typeof mode === 'string' && mode !== '' ? mode : 'unknown',
      kind,
      running: row?.running === true
    });
  };
  const catalog = projections[parentSessionId]?.values?.subagentCatalog;
  if (Array.isArray(catalog)) {
    for (const child of catalog) {
      push(String(child?.id ?? ''), typeof child?.label === 'string' ? child.label : undefined, typeof child?.mode === 'string' ? child.mode : undefined, 'subagent');
    }
  }
  const team = teamIndex !== null && teamIndex !== undefined && Array.isArray(teamIndex.teams)
    ? teamIndex.teams.find((candidate) => candidate.leadSessionId === parentSessionId)
    : undefined;
  if (team !== undefined) {
    for (const member of team.members) {
      if (member.role === 'lead') continue;
      push(member.id, member.name, 'continuable', 'member');
    }
  }
  // A member is a member even if the catalog listed it first.
  if (team !== undefined) {
    const memberIds = new Set(team.members.filter((member) => member.role !== 'lead').map((member) => member.id));
    for (const child of out) {
      if (memberIds.has(child.id)) child.kind = 'member';
    }
  }
  out.sort((left, right) => {
    const runningDelta = (right.running === true ? 1 : 0) - (left.running === true ? 1 : 0);
    if (runningDelta !== 0) return runningDelta;
    return String(left.label).localeCompare(String(right.label));
  });
  return out;
}

/**
 * Group the picker's candidates EXACTLY like the shell's own session list (surface v2):
 * one section per real Workspace in the caller's order, its members resolved from
 * `workspace.sessionIds`; every session that no Workspace accounts for trails in one
 * 未分组 section. Empty groups are dropped (a Workspace with no visible main session must
 * not render as an empty header).
 *
 * Ordering inside a section is recency (the shell list shows newest first), NOT the
 * running-first order the picker's flat candidate list uses.
 *
 * @param {Array<{id: string, row: object}>} candidates - `tbSessionCandidates(...)` result.
 * @param {Array<{workspaceId: string, title: string, sessionIds: string[]}>} workspaceGroups
 * @returns {Array<{key: string, workspaceId: string|undefined, title: string, sessions: Array}>}
 */
function tbSessionGroups(candidates, workspaceGroups) {
  const groups = [];
  const accounted = new Set();
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const recency = (left, right) => (right.row?.updatedAt ?? 0) - (left.row?.updatedAt ?? 0);
  for (const group of Array.isArray(workspaceGroups) ? workspaceGroups : []) {
    const sessions = [];
    for (const id of Array.isArray(group.sessionIds) ? group.sessionIds : []) {
      const candidate = byId.get(id);
      if (candidate === undefined || accounted.has(id)) continue;
      accounted.add(id);
      sessions.push(candidate);
    }
    if (sessions.length === 0) continue;
    sessions.sort(recency);
    groups.push({ key: 'ws:' + group.workspaceId, workspaceId: group.workspaceId, title: group.title, sessions });
  }
  const rest = candidates.filter((candidate) => !accounted.has(candidate.id));
  if (rest.length > 0) {
    rest.sort(recency);
    groups.push({ key: 'ungrouped', workspaceId: undefined, title: '', sessions: rest });
  }
  return groups;
}

/** Case-insensitive candidate filter used by the picker (leaves are already excluded). */
function tbFilterCandidates(candidates, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return candidates;
  return candidates.filter((candidate) => {
    const haystack = [candidate.row.displayTitle, candidate.row.cwd, candidate.id, candidate.memberName]
      .filter((part) => typeof part === 'string')
      .join(' ')
      .toLowerCase();
    return haystack.indexOf(needle) >= 0;
  });
}
