/* @local/dsh-team-workbench — read-only projection of COST + REAL RESULTS (工作台运行状态).
 *
 * Contract: docs/ARCHITECTURE.md (`snapshot.usage/findings/errorFingerprints`
 * are host-produced frozen fields; the client only READS them) + the coordinator's v1 revisions:
 *
 *   (R1) COST IS NEVER DEFAULTED. No `USD` assumption, no zero pricing: the money string is only
 *        produced when the host sent a real `currency` AND a real pricing (version + a non-zero
 *        rate). Otherwise the amount is `unknown` and the UI says so — a bare number would be a
 *        fabricated claim. (The frozen audit currency is CNY; known codes print as `<code> <amount>`.)
 *
 *   (R2) DETAILS ARE HOST-PAGINATED. `/state` carries only the aggregate ledger/counts (plus an
 *        optional explicit preview); the client must NOT slice a full ledger locally. Long lists
 *        (verified results / unfinished / repeated errors / usage breakdown) are fetched page by
 *        page from the host detail interface (`GET <base>/state/detail?…`, see `20-host.js`).
 *
 *   (R3) EVERY RESULT CARRIES `claimScope` + `verificationLevel`; they are rendered SEPARATELY and
 *        verbatim (offline / integration / engineering-save / gameplay / user-confirmation).
 *        File existence or an owner `accepted` is never upgraded to "real machine done" here — the
 *        UI shows the host level and never invents a higher one.
 *
 * This layer performs no fetch, no model call, no dispatch and no log rescan; the only side effect
 * in the whole feature is the on-demand detail-page GET triggered by user navigation.
 *
 * NOTE: `tbObj`/`tbArr`/`tbStr`/`tbNum` are the generic guards declared in `28-member.js`; plain
 * function declarations hoist inside the single built factory scope (same pattern as other files).
 */

/** Normalize one BUDGET block (CONTRACT §1: all counts are non-negative integers). */
function tbBudgetOf(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined;
  const budget = {
    requests: tbNum(raw, 'requests'),
    inputTokens: tbNum(raw, 'inputTokens'),
    outputTokens: tbNum(raw, 'outputTokens'),
    cacheReadTokens: tbNum(raw, 'cacheReadTokens'),
    reasoningTokens: tbNum(raw, 'reasoningTokens'),
    costEstimate: tbNum(raw, 'costEstimate'),
    costUnknownRequests: tbNum(raw, 'costUnknownRequests'),
    duplicatesSuppressed: tbNum(raw, 'duplicatesSuppressed'),
    retries: tbNum(raw, 'retries'),
    sessions: tbNum(raw, 'sessions')
  };
  budget.provided = Object.keys(budget).some((key) => budget[key] !== undefined);
  return budget;
}

/**
 * R1 (§8.1 + CONTRACT v4 §11.1): is the cost actually knowable?
 *
 * Reason CODES (never defaulted): `CURRENCY_UNKNOWN` (no real currency — no USD default),
 * `PRICE_UNKNOWN` (no price book / no explicit rates — no zero default),
 * `MIXED_CURRENCY` (amounts not summable), `USAGE_UNKNOWN` (no ledger at all).
 * A book entry with explicit numbers (including a legitimate `0`) is priced; a peak-time request that
 * the Host refuses to price stays unknown (`PEAK_PRICE_UNVERIFIED`, surfaced per request).
 */
function tbCostKnown(usage) {
  const codes = [];
  if (usage === null || usage === undefined || typeof usage !== 'object') return { known: false, reason: 'USAGE_UNKNOWN', reasonCodes: ['USAGE_UNKNOWN'], bookEntries: 0, mixedCurrency: false };
  const currency = tbStr(usage, 'currency');
  const pricing = tbObj(usage, 'pricing');
  const book = tbArr(pricing, 'book') ?? [];
  const legacyInput = tbNum(pricing, 'inputPerMillion');
  const legacyOutput = tbNum(pricing, 'outputPerMillion');
  const hasLegacy = legacyInput !== null && legacyInput !== undefined && legacyOutput !== null && legacyOutput !== undefined;
  const bookEntries = book.filter((entry) => entry !== null && typeof entry === 'object');
  const uncertainty = tbObj(usage, 'uncertainty');
  const mixedCurrency = uncertainty !== undefined && tbIsTrue(uncertainty, 'mixedCurrency');
  const currencyUnset = currency === undefined || currency === '';
  if (currencyUnset) codes.push('CURRENCY_UNKNOWN');
  if (mixedCurrency) codes.push('MIXED_CURRENCY');
  if (bookEntries.length === 0 && !hasLegacy) codes.push('PRICE_UNKNOWN');
  if (codes.length === 0) return { known: true, reason: 'PROVIDED', reasonCodes: ['PROVIDED'], bookEntries: bookEntries.length, mixedCurrency };
  return { known: false, reason: codes[0], reasonCodes: codes, bookEntries: bookEntries.length, mixedCurrency };
}

/**
 * Unknown-cost reason codes for DISPLAY. Host-declared reasons win (`uncertainty.reasonCodes` /
 * `costUnknownReason(s)` / `unknownReasons` map); otherwise only the reasons the summary can prove
 * are derived. When the book+currency are fine but requests are still unknown, the summary cannot
 * attribute each request (provider/model or peak-time), so both candidate codes are shown as
 * CANDIDATES and the per-request reason stays available in the usage detail rows.
 */
/** True when the Host itself declared the unknown-cost reasons (vs. derived from the summary). */
function tbReasonDeclared(usage) {
  const uncertainty = tbObj(usage, 'uncertainty');
  if (uncertainty !== undefined) {
    if (uncertainty.reasonCodes !== undefined) return true;
    if (uncertainty.costUnknownReasons !== undefined) return true;
    if (uncertainty.unknownReasons !== undefined) return true;
  }
  return usage !== null && usage !== undefined && (usage.costUnknownReasons !== undefined || usage.costUnknownReason !== undefined);
}

function tbUnknownReasonCodes(usage) {
  const uncertainty = tbObj(usage, 'uncertainty');
  // Host-declared reasons first: they apply even when a priced subset still yields an estimate
  // (e.g. some requests unpriced), so this must run BEFORE the known/unknown short-circuit.
  const declared = [];
  const raw = [
    uncertainty === undefined ? undefined : uncertainty.reasonCodes,
    usage === null || usage === undefined ? undefined : usage.costUnknownReasons,
    usage === null || usage === undefined ? undefined : usage.costUnknownReason
  ];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry !== '') declared.push(entry);
    else if (Array.isArray(entry)) for (const item of entry) if (typeof item === 'string' && item !== '') declared.push(item);
    else if (entry !== null && entry !== undefined && typeof entry === 'object') for (const key of Object.keys(entry)) if (typeof entry[key] === 'number' && entry[key] > 0) declared.push(key);
  }
  if (uncertainty !== undefined && uncertainty.unknownReasons !== null && uncertainty.unknownReasons !== undefined && typeof uncertainty.unknownReasons === 'object') {
    for (const key of Object.keys(uncertainty.unknownReasons)) if (typeof uncertainty.unknownReasons[key] === 'number' && uncertainty.unknownReasons[key] > 0) declared.push(key);
  }
  if (declared.length > 0) return [...new Set(declared)];
  const costKnown = tbCostKnown(usage);
  if (costKnown.known === true) return [];
  const codes = [...costKnown.reasonCodes];
  const totals = tbObj(usage, 'totals');
  const unknownRequests = totals === undefined ? undefined : tbNum(totals, 'costUnknownRequests');
  if (costKnown.bookEntries > 0 && costKnown.mixedCurrency !== true && unknownRequests !== undefined && unknownRequests > 0) {
    // Summary cannot attribute the per-request cause: label them as candidates, never as facts.
    return codes.concat(['PROVIDER_MODEL_UNPRICED', 'PEAK_PRICE_UNVERIFIED']);
  }
  return codes;
}

/** Strict boolean reader (only `true` counts; never truthy-coerced into a claim). */
function tbIsTrue(obj, key) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return false;
  return obj[key] === true;
}

/** Pricing book projection: version/currency/source/entries (each entry keeps its period+rates). */
function tbPricingView(usage) {
  const pricing = tbObj(usage, 'pricing');
  if (pricing === undefined) return undefined;
  const book = tbArr(pricing, 'book') ?? [];
  return {
    version: tbStr(pricing, 'version'),
    source: tbStr(pricing, 'source'),
    currency: tbStr(pricing, 'currency') ?? tbStr(usage, 'currency'),
    entries: book.filter((entry) => entry !== null && typeof entry === 'object').map((entry) => ({
      provider: tbStr(entry, 'provider'),
      model: tbStr(entry, 'model'),
      effectiveFrom: tbNum(entry, 'effectiveFrom'),
      effectiveTo: tbNum(entry, 'effectiveTo'),
      currency: tbStr(entry, 'currency'),
      inputPerMillion: tbNum(entry, 'inputPerMillion'),
      outputPerMillion: tbNum(entry, 'outputPerMillion'),
      cacheReadPerMillion: tbNum(entry, 'cacheReadPerMillion')
    })),
    legacyInputPerMillion: tbNum(pricing, 'inputPerMillion'),
    legacyOutputPerMillion: tbNum(pricing, 'outputPerMillion'),
    legacyCacheReadPerMillion: tbNum(pricing, 'cacheReadPerMillion'),
    estimateOnly: tbIsTrue(pricing, 'estimateOnly')
  };
}

/**
 * `snapshot.usage` → UI-ready SUMMARY projection (R2: no ledger lists here).
 * @param {object|undefined} snapshot host `/state` snapshot
 * @param {string[]} ownerKeys candidate keys for `scopes.byOwner` (member id / session id / name)
 */
function tbUsageFor(snapshot, ownerKeys) {
  const usage = tbObj(snapshot, 'usage');
  if (usage === undefined) {
    return {
      found: false, source: undefined, missing: ['usage'], team: undefined, owner: undefined, ownerKey: undefined,
      totals: undefined, uncertainty: undefined, pricing: undefined, pricingView: undefined, raw: undefined,
      currency: undefined, generatedAt: undefined, costByCurrency: undefined, byProviderModel: undefined,
      costKnown: tbCostKnown(undefined), reasonCodes: ['USAGE_UNKNOWN'], reasonDeclared: false, mixedCurrency: false
    };
  }
  const scopes = tbObj(usage, 'scopes');
  const teamRaw = tbObj(scopes, 'team');
  let team;
  if (teamRaw !== undefined) {
    const phaseRaw = tbObj(teamRaw, 'phase');
    team = {
      teamKey: tbStr(teamRaw, 'teamKey') ?? null,
      cumulative: tbBudgetOf(tbObj(teamRaw, 'cumulative')),
      phase: phaseRaw === undefined ? undefined : {
        id: tbStr(phaseRaw, 'id'),
        label: tbStr(phaseRaw, 'label'),
        startedAt: tbNum(phaseRaw, 'startedAt'),
        cumulative: tbBudgetOf(tbObj(phaseRaw, 'cumulative'))
      },
      attribution: tbObj(teamRaw, 'attribution')
    };
  }
  const byOwner = tbObj(scopes, 'byOwner');
  let ownerKey;
  let owner;
  const keys = Array.isArray(ownerKeys) ? ownerKeys : [];
  for (const key of keys) {
    if (typeof key !== 'string' || key === '') continue;
    const candidate = byOwner === undefined ? undefined : tbBudgetOf(tbObj(byOwner, key));
    if (candidate !== undefined) {
      ownerKey = key;
      owner = candidate;
      break;
    }
  }
  const uncertaintyRaw = tbObj(usage, 'uncertainty');
  const uncertainty = uncertaintyRaw === undefined ? undefined : {
    missingUsageRequests: tbNum(uncertaintyRaw, 'missingUsageRequests'),
    unattributedRequests: tbNum(uncertaintyRaw, 'unattributedRequests'),
    estimatedCostRatio: tbNum(uncertaintyRaw, 'estimatedCostRatio'),
    mixedCurrency: tbIsTrue(uncertaintyRaw, 'mixedCurrency'),
    notes: tbArr(uncertaintyRaw, 'notes'),
    reasonCodes: tbArr(uncertaintyRaw, 'reasonCodes')
  };
  const pricingView = tbPricingView(usage);
  const pricing = pricingView;
  const rawRaw = tbObj(usage, 'raw');
  const raw = rawRaw === undefined ? undefined : {
    source: tbStr(rawRaw, 'source'),
    path: tbStr(rawRaw, 'path'),
    readAt: tbNum(rawRaw, 'readAt'),
    windowFrom: tbNum(rawRaw, 'windowFrom'),
    windowTo: tbNum(rawRaw, 'windowTo'),
    requestsSeen: tbNum(rawRaw, 'requestsSeen'),
    detailEndpoint: tbStr(rawRaw, 'detailEndpoint')
  };
  const currency = tbStr(usage, 'currency');
  const costByCurrency = tbObj(usage, 'costByCurrency');
  const byProviderModel = tbObj(scopes, 'byProviderModel');
  const missing = [];
  if (currency === undefined) missing.push('currency');
  if (team === undefined) missing.push('scopes.team');
  if (byOwner === undefined) missing.push('scopes.byOwner');
  if (tbObj(usage, 'totals') === undefined) missing.push('totals');
  if (uncertainty === undefined) missing.push('uncertainty');
  if (pricing === undefined) missing.push('pricing');
  if (raw === undefined) missing.push('raw');
  return {
    found: true,
    source: 'usage',
    team,
    owner,
    ownerKey,
    totals: tbBudgetOf(tbObj(usage, 'totals')),
    uncertainty,
    pricing,
    pricingView,
    raw,
    currency,
    costByCurrency: costByCurrency === undefined ? undefined : costByCurrency,
    byProviderModel: byProviderModel === undefined ? undefined : byProviderModel,
    generatedAt: tbNum(usage, 'generatedAt'),
    costKnown: tbCostKnown(usage),
    reasonCodes: tbUnknownReasonCodes(usage),
    reasonDeclared: tbReasonDeclared(usage),
    // Read from the RAW uncertainty block: the projection above only carries numeric fields.
    mixedCurrency: tbIsTrue(tbObj(usage, 'uncertainty'), 'mixedCurrency'),
    missing
  };
}

/**
 * `snapshot.findings` → summary projection. R2: only COUNTS (and an optional explicit `preview`)
 * are consumed here; the full lists live behind the host detail interface.
 */
function tbFindingsFor(snapshot, ownerKeys) {
  const findings = tbObj(snapshot, 'findings');
  if (findings === undefined) {
    return { found: false, source: undefined, missing: ['findings'], counts: undefined, preview: undefined, generatedAt: undefined, lastEffectiveProgress: undefined };
  }
  const countsRaw = tbObj(findings, 'counts');
  const counts = countsRaw === undefined ? undefined : {
    verified: tbNum(countsRaw, 'verified'),
    unfinished: tbNum(countsRaw, 'unfinished'),
    inProgress: tbNum(countsRaw, 'inProgress'),
    rejected: tbNum(countsRaw, 'rejected'),
    invalidated: tbNum(countsRaw, 'invalidated'),
    activity: tbNum(countsRaw, 'activity'),
    errors: tbNum(countsRaw, 'errors'),
    verifiedByLevel: tbObj(countsRaw, 'verifiedByLevel')
  };
  const previewRaw = tbObj(findings, 'preview');
  const preview = previewRaw === undefined ? undefined : {
    verified: tbArr(previewRaw, 'verified'),
    unfinished: tbArr(previewRaw, 'unfinished'),
    rejected: tbArr(previewRaw, 'rejected'),
    invalidated: tbArr(previewRaw, 'invalidated')
  };
  // §7.1 keeps an explicit `levels.verified: [{workId, evidenceLevel, ceiling}]` list.
  const levelsRaw = tbObj(findings, 'levels');
  const levels = levelsRaw === undefined ? undefined : { verified: tbArr(levelsRaw, 'verified') };
  const lastEffectiveProgress = tbObj(findings, 'lastEffectiveProgress');
  const missing = [];
  if (counts === undefined) missing.push('counts');
  if (lastEffectiveProgress === undefined) missing.push('lastEffectiveProgress');
  return {
    found: true,
    source: 'findings',
    counts,
    preview,
    levels,
    note: tbStr(findings, 'note'),
    lastEffectiveProgress,
    generatedAt: tbNum(findings, 'generatedAt'),
    missing
  };
}

/** `snapshot.errorFingerprints` → summary projection (total + optional explicit preview only). */
function tbErrorFingerprintsFor(snapshot, ownerKeys) {
  const fingerprints = tbObj(snapshot, 'errorFingerprints');
  if (fingerprints === undefined) {
    return { found: false, source: undefined, missing: ['errorFingerprints'], total: undefined, preview: undefined, generatedAt: undefined };
  }
  // R2: only an EXPLICIT preview is rendered as a fallback; a `groups` array in /state is never
  // treated as the detail ledger (that would silently reintroduce local pagination).
  const previewRaw = tbObj(fingerprints, 'preview');
  return {
    found: true,
    source: 'errorFingerprints',
    total: tbNum(fingerprints, 'total'),
    preview: previewRaw === undefined ? undefined : tbArr(previewRaw, 'groups'),
    generatedAt: tbNum(fingerprints, 'generatedAt'),
    missing: []
  };
}

/**
 * R2: normalize ONE host detail page. The canonical host shape is
 * `{ items, page, pageSize, pages, total }`; a bare array is accepted as a single-page response.
 * Nothing is sliced locally: whatever the host page says is what gets rendered.
 */
function tbHostPage(raw) {
  if (raw === null || raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    return { items: raw, page: 1, pageSize: raw.length, pages: 1, total: raw.length, hasPrev: false, hasNext: false, fromHost: true };
  }
  if (typeof raw !== 'object') return undefined;
  const items = tbArr(raw, 'items') ?? tbArr(raw, 'rows') ?? tbArr(raw, 'entries');
  if (items === undefined) return undefined;
  const page = tbNum(raw, 'page') ?? 1;
  const pageSize = tbNum(raw, 'pageSize') ?? items.length;
  const total = tbNum(raw, 'total');
  const pages = tbNum(raw, 'pages') ?? (total !== undefined && pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1);
  return {
    items,
    page,
    pageSize,
    pages,
    total: total ?? items.length,
    hasPrev: tbNum(raw, 'hasPrev') !== undefined ? raw.hasPrev === true : page > 1,
    hasNext: tbNum(raw, 'hasNext') !== undefined ? raw.hasNext === true : page < pages,
    fromHost: true
  };
}

/** R1: money text — requires a real currency; never assumes USD and never invents a symbol. */
function tbMoneyText(value, currency) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (typeof currency !== 'string' || currency === '') return undefined;
  const abs = Math.abs(value);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return currency + ' ' + value.toFixed(digits);
}

/** Compact token count: 1.2M / 12.3k / 900 (display only, never used as progress). */
function tbTokenText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value >= 1e6) return (value / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(value));
}

/** Factual staleness of a host timestamp (used with a visible age, never as a hidden guess). */
function tbIsOlderThan(at, now, maxAgeMs) {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return false;
  return now - at > maxAgeMs;
}

/** R3: known verification-level keys (rendered verbatim, unknown values stay raw). */
function tbLevelKeys() {
  return ['offline', 'integration', 'engineering-save', 'gameplay', 'user-confirmation'];
}

/** R3: level label for a host value; unknown values are shown raw (never upgraded). */
function tbLevelText(t, level) {
  if (typeof level !== 'string' || level === '') return undefined;
  const key = 'findings.level.' + level;
  const text = t(key);
  return text === key ? level : text;
}

/** R3/§7.2: real claimScope enum (own-work | cross-module | integration | coordination). */
function tbClaimScopeText(t, scope) {
  if (typeof scope !== 'string' || scope === '') return undefined;
  const key = 'findings.claimScope.' + scope;
  const text = t(key);
  return text === key ? scope : text;
}

/** R3/§7.2: real evidenceLevel enum (offline-verified | batch-verified | live-observed | …). */
function tbEvidenceLevelText(t, level) {
  if (typeof level !== 'string' || level === '') return undefined;
  const key = 'findings.evidenceLevel.' + level;
  const text = t(key);
  return text === key ? level : text;
}

/** R3: one result row's claim fields, always reported separately. */
function tbClaimOf(row) {
  return {
    claimScope: tbStr(row, 'claimScope'),
    verificationLevel: tbStr(row, 'verificationLevel'),
    evidenceLevel: tbStr(row, 'evidenceLevel'),
    ceiling: tbStr(row, 'ceiling'),
    // CONTRACT v4 §11.3: artifact versions + dependency versions + trusted execution.
    artifactVersions: tbArtifactVersionsOf(row),
    dependencyVersions: tbDependencyVersionsOf(row),
    trustedExecution: tbTrustedExecutionOf(row)
  };
}

/** `artifacts:[{path,version}]` — version 缺失保持 null（显示「版本未提供」，不省略版本位）。 */
function tbArtifactVersionsOf(row) {
  const artifacts = tbArr(row, 'artifacts') ?? tbArr(row, 'artifactVersions') ?? [];
  return artifacts.filter((entry) => entry !== null && typeof entry === 'object').map((entry) => ({
    path: tbStr(entry, 'path'),
    version: tbNum(entry, 'version') ?? null
  }));
}

/** `dependencyVersions:[{artifact,version,requires}]` (or work-level `artifactDependencies`). */
function tbDependencyVersionsOf(row) {
  const deps = tbArr(row, 'dependencyVersions');
  if (deps !== undefined) {
    return deps.filter((entry) => entry !== null && typeof entry === 'object').map((entry) => ({
      artifact: tbStr(entry, 'artifact') ?? tbStr(entry, 'path'),
      version: tbNum(entry, 'version') ?? null,
      requires: tbStr(entry, 'requires')
    }));
  }
  const legacy = tbArr(row, 'artifactDependencies');
  if (legacy === undefined) return [];
  return legacy.filter((entry) => entry !== null && typeof entry === 'object').map((entry) => ({
    artifact: tbStr(entry, 'artifact') ?? tbStr(entry, 'path'),
    version: tbNum(entry, 'version') ?? null,
    requires: tbStr(entry, 'requires')
  }));
}

/** `trustedExecution:{attemptId,executionRunId,exitCode,artifactSha256,complete}` (§11.3). */
function tbTrustedExecutionOf(row) {
  const raw = tbObj(row, 'trustedExecution');
  if (raw === undefined) return undefined;
  return {
    attemptId: tbStr(raw, 'attemptId'),
    executionRunId: tbStr(raw, 'executionRunId') ?? tbStr(raw, 'runId'),
    exitCode: tbNum(raw, 'exitCode'),
    artifactSha256: tbStr(raw, 'artifactSha256'),
    complete: tbIsTrue(raw, 'complete')
  };
}
