/* @local/dsh-team-workbench — client ↔ host line (same-origin fetch, JSON).
 *
 * Route contract: `src/host/web.js` (Lead-owned, read at the time of writing).
 *   GET  <base>/state                        → { ok, version, basePath, snapshot, scheduler, constraints, adapter }
 *   POST <base>/layout  (+ x-team-workbench: 1) → { ok, layout }   body { op: get|set-mode|set-layout|upsert-pane|remove-pane|focus-pane, ... }
 *   POST <base>/op      (+ x-team-workbench: 1) → the same service method the model tools call: { op, args, callerSessionId }
 *   GET  <base>/health
 *
 * Assumed base path `/plugin/team-workbench`; the authoritative value is adopted
 * from the `/state` response (`basePath`) as soon as one answers.
 *
 * The line is optional by design: layout is local-first (store `persist`), so an
 * unreachable route degrades to an explicit "host route unreachable" diagnostic
 * instead of breaking the panes.
 */

/**
 * Client target → host target. Accepts BOTH shapes on purpose (A4): the client form
 * (`{kind:'session'|'subagent', …}`) and an already-adapted address
 * (`{parentSessionId, childSessionId, mode}`), so a second mapping pass is idempotent
 * instead of silently degrading an address to `null`.
 */
function tbTargetForHost(target) {
  if (!target || typeof target !== 'object') return null;
  if (typeof target.sessionId === 'string') return { sessionId: target.sessionId };
  if (typeof target.parentSessionId === 'string' && typeof target.childSessionId === 'string') {
    return { parentSessionId: target.parentSessionId, childSessionId: target.childSessionId, mode: target.mode ?? 'unknown' };
  }
  return null;
}

function tbTargetFromHost(target) {
  if (!target || typeof target !== 'object') return null;
  if (typeof target.sessionId === 'string') return { kind: 'session', sessionId: target.sessionId };
  if (typeof target.parentSessionId === 'string' && typeof target.childSessionId === 'string') {
    return { kind: 'subagent', parentSessionId: target.parentSessionId, childSessionId: target.childSessionId, mode: target.mode ?? 'unknown' };
  }
  return null;
}

/** Strip the client-only pane fields before they reach the host LayoutRecord. */
function tbPaneForHost(pane) {
  return {
    paneId: pane.paneId,
    target: tbTargetForHost(pane.target),
    role: pane.role,
    label: pane.label ?? ''
  };
}

function tbLayoutForHost(layout) {
  return {
    mode: layout.mode,
    panes: (layout.panes ?? []).map(tbPaneForHost),
    activePaneId: layout.activePaneId,
    ratios: layout.ratios
    // NOTE (surface v2): `view` is client-only and deliberately NOT pushed. The host record
    // describes the workspace session a pane shows; the second level is a local choice.
  };
}

/**
 * Versioned-route capability (coordinator/Lead requirement): the Host hot-attaches a NEW route
 * surface onto the still-running old service (`upgradeEntry.js` + `routeMode:'versioned'`), so the
 * legacy `/op` keeps routing to the OLD dispatchOperation. The client must therefore:
 *
 *   1. read the Host-declared capability (versioned basePath + exact detail/ack endpoints),
 *   2. route detail/usage/ack to the NEW routes when declared,
 *   3. keep the old-host fallback (`<basePath>/state/detail`, `POST /op usage-records`, `/op client-ack`).
 *
 * Tolerant locations (host may freeze one of them; all are read-only):
 *   payload.capabilities / payload.compat.capabilities / payload.snapshot.capabilities /
 *   payload.snapshot.compat.capabilities / window.__DSH_TEAM_WORKBENCH_CAPABILITIES__
 *
 * Shape (all fields optional): `{ apiVersion|version|rev, basePath, detail:{endpoint,version,pageSize},
 * ack:{endpoint,op} }`; a bare string `detail`/`ack` is accepted as an endpoint.
 */
function tbCapabilityText(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function tbNormalizeCapabilities(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined;
  const flag = raw.capabilities ?? raw.capability ?? undefined;
  const source = flag !== null && flag !== undefined && typeof flag === 'object' ? flag : raw;
  const detailRaw = source.detail ?? source.stateDetail ?? source.detailEndpoint;
  const ackRaw = source.ack ?? source.clientAck ?? source.ackEndpoint;
  let detail;
  if (typeof detailRaw === 'string' && detailRaw !== '') {
    detail = { endpoint: detailRaw };
  } else if (detailRaw !== null && detailRaw !== undefined && typeof detailRaw === 'object') {
    detail = {
      endpoint: tbCapabilityText(detailRaw.endpoint) ?? tbCapabilityText(detailRaw.path),
      version: tbCapabilityText(detailRaw.version),
      pageSize: typeof detailRaw.pageSize === 'number' && detailRaw.pageSize > 0 ? detailRaw.pageSize : undefined
    };
  }
  let ack;
  if (typeof ackRaw === 'string' && ackRaw !== '') {
    ack = { endpoint: ackRaw };
  } else if (ackRaw !== null && ackRaw !== undefined && typeof ackRaw === 'object') {
    ack = { endpoint: tbCapabilityText(ackRaw.endpoint) ?? tbCapabilityText(ackRaw.path), op: tbCapabilityText(ackRaw.op) };
  }
  const apiVersion = tbCapabilityText(source.apiVersion) ?? tbCapabilityText(source.version) ?? tbCapabilityText(source.rev);
  const basePath = tbCapabilityText(source.basePath) ?? tbCapabilityText(source.base);
  if (apiVersion === undefined && detail?.endpoint === undefined && ack?.endpoint === undefined && ack?.op === undefined) return undefined;
  return { apiVersion, basePath, detail, ack, source };
}

/**
 * Host-frozen default capability (host-autonomy alignment, 2026-10-17): detail and ack stay on the
 * ORIGINAL workbench basePath (`upgradeEntry`'s `/plugin/team-workbench-upgrade` is control-plane
 * only), `apiVersion = 'workbench-v2'`, `detailEndpoint = basePath + '/state/detail'`,
 * `ackEndpoint = basePath + '/op#client-ack'`. Using this as the default means the client needs no
 * path change while still having a stable epoch; a later Host-declared `capabilities` object simply
 * overrides it (and changing the epoch resets the ack retry budget).
 */
function tbDefaultCapabilities(basePath) {
  const base = typeof basePath === 'string' && basePath !== '' ? basePath : '/plugin/team-workbench';
  return {
    apiVersion: 'workbench-v2',
    basePath: base,
    detail: { endpoint: base + '/state/detail', version: 'v2' },
    ack: { op: 'client-ack' }
  };
}

/** Stable capability epoch — frozen formula: apiVersion|basePath|detailEndpoint|ackEndpoint. */
function tbCapabilityVersion(capabilities, fallbackBase) {
  const caps = capabilities === undefined ? tbDefaultCapabilities(fallbackBase) : capabilities;
  const base = caps.basePath ?? fallbackBase ?? '';
  const detail = caps.detail === undefined ? '' : (caps.detail.endpoint ?? '');
  const ack = caps.ack === undefined
    ? ''
    : (caps.ack.endpoint !== undefined ? caps.ack.endpoint : (caps.ack.op === undefined ? '' : base + '/op#' + caps.ack.op));
  return [caps.apiVersion ?? '', base, detail, ack].join('|');
}

/** Resolve one endpoint: absolute URL / absolute plugin path is used verbatim, else basePath+path. */
function tbEndpointPath(endpoint, basePath) {
  if (typeof endpoint !== 'string' || endpoint === '') return undefined;
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  if (endpoint.charAt(0) === '/') return endpoint;
  return String(basePath ?? '') + '/' + endpoint;
}

/**
 * Build the host line. Every method resolves to `{ ok, value }` or `{ ok:false, code, message }`
 * — no method throws, so UI call sites never need try/catch around it.
 */
function tbCreateHostClient(defaultBasePath, t) {
  // B3: diagnostics text also goes through the locale namespace (falls back to the key).
  const tr = typeof t === 'function' ? t : (key) => key;
  const state = {
    phase: 'unknown',
    basePath: defaultBasePath,
    version: undefined,
    capabilities: tbDefaultCapabilities(defaultBasePath),
    capabilityVersion: tbCapabilityVersion(undefined, defaultBasePath),
    projectionsAt: undefined,
    projectionRegions: {},
    lastError: undefined,
    snapshot: undefined,
    fetchedAt: 0
  };
  const observable = tbCreateObservable(state);
  let disposed = false;
  // ONE monotonic sequence shared by `/state` AND projection requests: a slow `/state` answer must
  // not overwrite a newer projection merge (and vice versa). Both paths take a seq when they START
  // and only apply when `seq > appliedSeq`; `appliedSeq` is the single version field of the
  // published snapshot.
  let requestSeq = 0;
  let appliedSeq = 0;

  function publish(patch) {
    if (disposed) return;
    // Keep the mutable local record and the published snapshot on the same values:
    // `request()` reads `state.basePath`, so publishing into a detached clone would
    // silently freeze the local view.
    for (const key of Object.keys(patch)) state[key] = patch[key];
    observable.set({ ...state });
  }

  async function request(method, path, body, withMarker) {
    if (disposed) return { ok: false, code: 'DISPOSED', message: tr('error.clientDisposed') };
    // Absolute URLs / absolute plugin paths (versioned hot-attached routes) are used verbatim;
    // everything else is relative to the current basePath.
    const url = /^(https?:\/\/|\/plugin\/)/i.test(path) ? path : state.basePath + path;
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    // The host fence rejects cross-site simple requests without this marker.
    if (withMarker) headers['x-team-workbench'] = '1';
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store'
      });
      const text = await response.text();
      let payload = null;
      if (text !== '' && text !== undefined) {
        try {
          payload = JSON.parse(text);
        } catch (parseError) {
          publish({ phase: 'unavailable', lastError: 'line response is not JSON: ' + tbHelpers.errorText(parseError) });
          return { ok: false, code: 'INVALID_JSON', message: tr('error.routeNotJson') };
        }
      }
      if (!response.ok) {
        const code = payload && typeof payload.code === 'string' ? payload.code : 'HTTP_' + response.status;
        const message = payload && typeof payload.message === 'string' ? payload.message : 'HTTP ' + response.status;
        publish({ phase: 'unavailable', lastError: code + ': ' + message });
        return { ok: false, code, message };
      }
      if (payload && typeof payload.basePath === 'string' && payload.basePath !== '' && payload.basePath !== state.basePath) {
        state.basePath = payload.basePath;
        // The frozen default follows the Host-declared basePath; the epoch therefore changes and
        // the ack retry budget resets (capability change semantics).
        if (state.capabilities === undefined || state.capabilities.source === undefined) state.capabilities = tbDefaultCapabilities(payload.basePath);
      }
      // Capability may be declared at several read-only locations; the window override lets a
      // future shell announce the hot-attached versioned surface without a page reload.
      const override = typeof window !== 'undefined' ? window.__DSH_TEAM_WORKBENCH_CAPABILITIES__ : undefined;
      const declared = tbNormalizeCapabilities(override) ?? tbNormalizeCapabilities(payload) ?? (payload?.snapshot === undefined ? undefined : tbNormalizeCapabilities(payload.snapshot)) ?? state.capabilities ?? tbDefaultCapabilities(state.basePath);
      const patch = { phase: 'ok', lastError: undefined, version: payload?.version };
      if (declared !== undefined) {
        patch.capabilities = declared;
        patch.capabilityVersion = tbCapabilityVersion(declared, state.basePath);
      }
      publish(patch);
      return { ok: true, value: payload };
    } catch (error) {
      const message = tbHelpers.errorText(error);
      publish({ phase: 'unavailable', lastError: message });
      return { ok: false, code: 'ROUTE_UNREACHABLE', message };
    }
  }

  function layoutOp(op, payload) {
    return request('POST', '/layout', { op, ...(payload ?? {}) }, true);
  }

  /**
   * `POST /op` — the same service methods the model tools call. Used by the member pane for the
   * autonomy-v1 controls: delivering a `user_instruction` to a member (never to the lead on its
   * behalf, §八) and the four DISTINCT stop/pause semantics.
   */
  function serviceOp(op, args, callerSessionId) {
    return request('POST', '/op', { op, args: args ?? {}, ...(callerSessionId === undefined ? {} : { callerSessionId }) }, true);
  }

  /**
   * Host-paginated DETAIL interface (coordinator revision R2: the client must not slice a full
   * ledger locally). Canonical shape, pending host-autonomy confirmation:
   *
   *   GET <base>/state/detail?section=<usage|findings|errorFingerprints>
   *                           &kind=<usageBreakdown|verified|unfinished|rejected|invalidated|errors>
   *                           &page=<1-based>&pageSize=<n>[&ownerMemberId=<id>][&teamKey=<key>]
   *     → { ok, section, kind, page, pageSize, pages, total, items: [...] }
   *
   * Every call is a GET (read-only). A missing route stays an explicit failure result — the UI
   * then says 「明细需宿主分页接口（未提供）」 instead of paginating something it should not.
   */
  function detailQuery(options) {
    const query = ['section=' + encodeURIComponent(options.section), 'kind=' + encodeURIComponent(options.kind), 'page=' + String(options.page), 'pageSize=' + String(options.pageSize)];
    if (typeof options.ownerMemberId === 'string' && options.ownerMemberId !== '') query.push('ownerMemberId=' + encodeURIComponent(options.ownerMemberId));
    if (typeof options.teamKey === 'string' && options.teamKey !== '') query.push('teamKey=' + encodeURIComponent(options.teamKey));
    // Capability-declared (versioned hot-attached) endpoint wins; otherwise the frozen legacy path.
    const declared = state.capabilities === undefined || state.capabilities.detail === undefined ? undefined : state.capabilities.detail.endpoint;
    const path = tbEndpointPath(declared, state.basePath) ?? (state.basePath + '/state/detail');
    const join = path.indexOf('?') >= 0 ? '&' : '?';
    return request('GET', path + join + query.join('&'), undefined, false);
  }

  /**
   * Detail-page compatibility layer (CONTRACT §8.2: ONE transport at a time, host decides).
   *
   * Primary:  `GET /state/detail?…` (frozen §7.2 shape `{page,pageSize,pages,total,items}`).
   * Fallback: the currently deployed host has no GET route yet but DOES expose
   *           `POST /op usage-records {cursor,limit}` (offset cursor) — used when the GET route
   *           is unavailable and the section is `usage`, and normalized to the §7.2 page shape.
   *           No full-ledger list from `/state` is ever used as a page.
   *
   * Both legs are read-only (GET / a read-only op) and are reported through `lastDetailTransport`
   * so the frontend ack can state which one was actually used.
   */
  let lastDetailTransport;
  function detailTransport() {
    return lastDetailTransport;
  }

  function normalizeUsageRecordRows(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => {
      const provider = row !== null && typeof row.provider === 'string' ? row.provider : '?';
      const model = row !== null && typeof row.model === 'string' ? row.model : '?';
      const when = row !== null && typeof row.time === 'number' && row.time > 0 ? new Date(row.time).toISOString().replace('T', ' ').slice(0, 19) : '?';
      const cost = row !== null && row.costKnown === true && typeof row.cost === 'number'
        ? row.currency + ' ' + row.cost
        : 'unknown' + (row !== null && typeof row.costUnknownReason === 'string' && row.costUnknownReason !== '' ? ' · ' + row.costUnknownReason : '');
      return { key: provider + '/' + model + ' · ' + when, value: cost };
    });
  }

  async function fetchDetail(options) {
    const primary = await detailQuery(options);
    if (primary !== undefined && primary.ok === true) {
      lastDetailTransport = 'GET /state/detail';
      return primary;
    }
    const fallbackEligible = options !== undefined && options.section === 'usage';
    if (!fallbackEligible) {
      lastDetailTransport = 'unavailable';
      return primary;
    }
    const limit = Math.max(1, Math.min(200, Number(options.pageSize) || 20));
    const cursor = Math.max(0, (Math.max(1, Number(options.page) || 1) - 1) * limit);
    const fallback = await serviceOp('usage-records', { cursor, limit });
    if (fallback !== undefined && fallback.ok === true) {
      lastDetailTransport = 'POST /op usage-records';
      const value = fallback.value !== null && typeof fallback.value === 'object' ? fallback.value : {};
      const rows = Array.isArray(value.rows) ? value.rows : [];
      const total = typeof value.total === 'number' ? value.total : rows.length;
      const pages = Math.max(1, Math.ceil(total / limit));
      return {
        ok: true,
        value: {
          ok: true,
          section: 'usage',
          kind: options.kind ?? 'records',
          page: Math.max(1, Number(options.page) || 1),
          pageSize: limit,
          pages,
          total,
          items: normalizeUsageRecordRows(rows),
          transport: 'op/usage-records'
        }
      };
    }
    lastDetailTransport = 'unavailable';
    return primary !== undefined && primary.ok === false ? primary : fallback;
  }

  return {
    snapshotSource: { getSnapshot: observable.getSnapshot, subscribe: observable.subscribe },
    /**
     * Bounded PROJECTION refresh (production refresh gap): the open panel must see the host's
     * latest cost / coverage-gap / real-result state while the Host backfills usage in batches.
     *
     * Why not `/state` every time: `/state` carries the whole workbench snapshot (large). This
     * method uses only the Host's EXISTING read-only ops — `usage`, `findings`,
     * `error-fingerprints` — and merges those three projections into the current snapshot. It is
     * cheap, bounded, read-only (no model call, no dispatch) and never clears previous values on
     * failure (unknown stays unknown, stale stays visible with timestamps).
     */
    async fetchProjections() {
      if (disposed) return { ok: false, code: 'DISPOSED', partial: false, failures: [] };
      const seq = ++requestSeq;
      const results = await Promise.all([
        serviceOp('usage', {}),
        serviceOp('findings', {}),
        serviceOp('error-fingerprints', {})
      ]);
      // Cross-type guard: a late projection must not overwrite a newer `/state` (or newer projection).
      if (seq <= appliedSeq) return { ok: false, code: 'STALE_RESPONSE', partial: false, failures: [], seq, appliedSeq };
      const KIND_OF = ['usage', 'findings', 'errorFingerprints'];
      const failures = [];
      const next = {};
      const regionAt = {};
      const at = Date.now();
      const readOf = (result, key) => (result !== undefined && result.ok === true && result.value !== null && result.value !== undefined && result.value[key] !== undefined ? result.value[key] : undefined);
      const usage = readOf(results[0], 'usage');
      const findings = readOf(results[1], 'findings');
      const errorFingerprints = readOf(results[2], 'errorFingerprints');
      const pairs = [[KIND_OF[0], usage], [KIND_OF[1], findings], [KIND_OF[2], errorFingerprints]];
      const resultIndex = [0, 1, 2];
      for (let index = 0; index < pairs.length; index += 1) {
        const key = pairs[index][0];
        const value = pairs[index][1];
        if (value === undefined) {
          const failed = results[resultIndex[index]];
          failures.push({ region: key, code: failed === undefined ? 'NO_RESULT' : (failed.ok === true ? 'EMPTY_PROJECTION' : (failed.code ?? 'PROJECTION_FAILED')) });
          continue;
        }
        next[key] = value;
        regionAt[key] = at;
      }
      const applied = Object.keys(next).length > 0;
      if (applied) {
        appliedSeq = seq;
        const snapshot = state.snapshot !== null && state.snapshot !== undefined && typeof state.snapshot === 'object' ? state.snapshot : {};
        const previousRegions = state.projectionRegions !== null && state.projectionRegions !== undefined && typeof state.projectionRegions === 'object' ? state.projectionRegions : {};
        publish({
          snapshot: Object.assign({}, snapshot, next),
          projectionsAt: at,
          // PER-REGION freshness: a partial failure must NOT make the failed region look fresh.
          projectionRegions: Object.assign({}, previousRegions, regionAt)
        });
      }
      return {
        ok: failures.length === 0,
        code: failures.length === 0 ? undefined : (failures[0].code ?? 'PROJECTION_FAILED'),
        partial: applied && failures.length > 0,
        value: next,
        failures,
        regions: regionAt,
        at,
        seq,
        // Diagnostic for the caller: which regions are stale relative to this merge.
        staleRegions: failures.map((failure) => failure.region)
      };
    },
    /** Single snapshot version (state + projection) for diagnostics. */
    projectionSeq() {
      return appliedSeq;
    },
    /** GET /state — team/task snapshot, the host-downloaded compat config, and the base path. */
    async fetchState() {
      const seq = ++requestSeq;
      const result = await request('GET', '/state', undefined, false);
      if (!result.ok) return result;
      // Old response guard: only publish when this is newer than EVERY applied request (state or
      // projection) — an older `/state` arriving late must not overwrite a newer projection.
      if (seq <= appliedSeq) return { ok: false, code: 'STALE_RESPONSE', seq, appliedSeq };
      appliedSeq = seq;
      publish({
        snapshot: result.value?.snapshot,
        // Host-downloaded compat config (Lead-owned patch row → `/state`): the client cannot
        // read the host row's config directly, so this is the authoritative source for the
        // focus-bridge rollback switch.
        compat: result.value?.compat,
        skills: result.value?.skills,
        fetchedAt: Date.now()
      });
      return result;
    },
    /** R2: ONE host-paginated detail page (read-only; never a full-ledger dump). */
    fetchDetail(options) {
      return fetchDetail(options);
    },
    /** Which transport actually served the last detail page (ack / audit). */
    detailTransport,
    /** POST /layout with the exact op names `src/host/web.js` accepts. */
    async layout(op, payload) {
      return layoutOp(op, payload);
    },
    /** A4: takes the CLIENT layout and performs the single client→host mapping. */
    setLayout(layout) {
      return layoutOp('set-layout', tbLayoutForHost(layout));
    },
    upsertPane(pane) {
      return layoutOp('upsert-pane', { pane: tbPaneForHost(pane) });
    },
    focusPane(paneId) {
      return layoutOp('focus-pane', { paneId });
    },
    getLayout() {
      return layoutOp('get', {});
    },
    /**
     * Frontend activation ACK (CONTRACT §8.3): the client reports that THIS bundle rev is not just
     * published but actually applied, plus which components mounted. Pure metadata: no model call,
     * no account/session data, no desktop interaction. The host must expose a read-only query for
     * it (host-autonomy owns that op); until then the answer stays an explicit failure code.
     */
    clientAck(payload) {
      const ack = state.capabilities === undefined ? undefined : state.capabilities.ack;
      const endpoint = ack === undefined ? undefined : ack.endpoint;
      if (endpoint !== undefined) {
        // Versioned hot-attached ack route: POST the metadata as the body (no dispatch op).
        const path = tbEndpointPath(endpoint, state.basePath);
        return request('POST', path, payload ?? {}, true);
      }
      return serviceOp(ack === undefined ? 'client-ack' : (ack.op ?? 'client-ack'), payload ?? {});
    },
    /** Read-only capability view (ack epoch / diagnostics). */
    capabilities() {
      return state.capabilities;
    },
    capabilityVersion() {
      return state.capabilityVersion;
    },
    /**
     * Deliver a user instruction to a member session. The Host enqueues a `user_instruction`
     * event and wakes that member's real model turn (autonomy-v1 §6); the client never routes
     * it through the lead (that would serialize the member's own decision-making away).
     */
    userInstruction(targetSessionId, text) {
      return serviceOp('user_instruction', { targetSessionId, text });
    },
    /** The four distinct semantics of §八, plus the explicit user resume; `args` carries the
     *  member session (or work/intent ids) so the Host can scope the operation precisely. */
    control(op, args) {
      return serviceOp(op, args);
    },
    /** Adopt a host LayoutRecord into the local state shape (client-only fields kept). */
    adoptLayout(hostLayout) {
      if (!hostLayout || typeof hostLayout !== 'object') return null;
      const panes = Array.isArray(hostLayout.panes) ? hostLayout.panes : [];
      return {
        mode: hostLayout.mode,
        activePaneId: hostLayout.activePaneId,
        ratios: hostLayout.ratios,
        panes: panes.map((pane) => ({
          paneId: pane.paneId,
          target: tbTargetFromHost(pane.target),
          role: pane.role,
          label: pane.label
        }))
      };
    },
    dispose() {
      disposed = true;
      observable.set({ ...observable.getSnapshot(), phase: 'disposed' });
    }
  };
}
