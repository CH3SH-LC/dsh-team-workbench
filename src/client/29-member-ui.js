/* @local/dsh-team-workbench — member pane: the member's OWN decisions (autonomy-v1 §八).
 *
 * Everything rendered here comes from the Host payload through `tbAutonomyFor`. A field the
 * Host did not send is rendered as "未提供" — this file never invents a plan, an intent, an
 * attempt or a verification result.
 *
 * SURFACE v2 (docs/contracts/client-surface-v2.md): this block is shown only while a MEMBER
 * is the second-level view of its workspace session. Its permanent footprint is ONE 12px line
 * (plan revision · deliverables · pending inbox) plus 「详情」 — the detail body is the only
 * place the lists/actions/instruction box appear, so the default pane stays free of small
 * print. Per-pane state (expanded / draft / acknowledgement) is local to this component
 * instance so nothing leaks between panes.
 */

/** One `label: value` block line; `value === undefined` renders the "not provided" marker. */
function tbMemberLine(props) {
  const { label, value, t, tone } = props;
  const missing = value === undefined || value === null || value === '';
  return React.createElement('div', { className: 'tb-member-line' }, [
    React.createElement('span', { key: 'l' }, label),
    React.createElement('span', {
      key: 'v',
      className: missing ? 'tb-member-missing' : 'tb-member-value' + (tone === undefined ? '' : ' ' + tone)
    }, missing ? t('member.notProvided') : String(value))
  ]);
}

/** A compact row used by the deliverables / intents / receipts lists. */
function tbMemberItem(props) {
  const { className, title, tags, note } = props;
  return React.createElement('div', { className }, [
    React.createElement('div', { key: 't', className: 'tb-member-item-title' }, title),
    tags === undefined || tags.length === 0 ? null : React.createElement('div', { key: 'g', className: 'tb-member-tagrow' },
      tags.map((tag, index) => React.createElement('span', { key: 'tag' + index, className: 'tb-tag' }, tag))),
    note === undefined || note === '' ? null : React.createElement('div', { key: 'n', className: 'tb-member-item-note' }, note)
  ]);
}

/** Deliverables the MEMBER submitted, each with its own execution decision. */
function tbMemberDeliverables(props) {
  const { autonomy, t } = props;
  const items = autonomy.deliverables;
  if (items === undefined) return React.createElement(tbMemberLine, { label: t('member.deliverables'), value: undefined, t });
  if (items.length === 0) return React.createElement(tbMemberLine, { label: t('member.deliverables'), value: t('member.empty'), t });
  return React.createElement('div', { className: 'tb-member-list' }, items.map((item, index) => {
    const workId = tbStr(item, 'workId');
    const execution = tbStr(item, 'execution');
    const state = tbStr(item, 'state');
    const title = tbStr(item, 'title') ?? workId ?? '#' + (index + 1);
    const tags = [];
    if (tbStr(item, 'kind') !== undefined) tags.push(tbStr(item, 'kind'));
    if (execution !== undefined) tags.push(t('member.execution.' + execution) === 'member.execution.' + execution ? execution : t('member.execution.' + execution));
    else tags.push(t('member.notProvided'));
    if (state !== undefined) tags.push(t('member.state.' + state) === 'member.state.' + state ? state : t('member.state.' + state));
    const outputs = tbArr(item, 'outputs') ?? [];
    return React.createElement(tbMemberItem, {
      key: 'd' + index,
      className: 'tb-member-item tb-deliverable',
      title,
      tags,
      note: outputs.length === 0 ? (workId === undefined ? undefined : t('member.workId') + tbShortId(workId)) : t('member.outputs') + outputs.length
    });
  }));
}

/** Dispatch intents the MEMBER authorized (and what consumed / cancelled them). */
function tbMemberIntents(props) {
  const { autonomy, t } = props;
  const items = autonomy.dispatchIntents;
  if (items === undefined) return React.createElement(tbMemberLine, { label: t('member.dispatch'), value: undefined, t });
  if (items.length === 0) return React.createElement(tbMemberLine, { label: t('member.dispatch'), value: t('member.empty'), t });
  return React.createElement('div', { className: 'tb-member-list' }, items.map((item, index) => {
    const state = tbStr(item, 'state');
    const workId = tbStr(item, 'workId');
    const attempt = tbStr(item, 'consumedByAttemptId');
    const tags = [state === undefined ? t('member.notProvided') : (t('member.intentState.' + state) === 'member.intentState.' + state ? state : t('member.intentState.' + state))];
    const note = [
      workId === undefined ? '' : t('member.workId') + tbShortId(workId),
      attempt === undefined ? '' : t('member.attempt') + tbShortId(attempt),
      tbStr(item, 'intentId') === undefined ? '' : t('member.intentId') + tbShortId(tbStr(item, 'intentId'))
    ].filter((part) => part !== '').join(' · ');
    return React.createElement(tbMemberItem, { key: 'i' + index, className: 'tb-member-item tb-intent', title: workId ?? '#' + (index + 1), tags, note });
  }));
}

/** Receipts the member received from its leaves, plus the member's own verification. */
function tbMemberReceipts(props) {
  const { autonomy, t } = props;
  const items = autonomy.receipts;
  if (items === undefined) return React.createElement(tbMemberLine, { label: t('member.receipts'), value: undefined, t });
  if (items.length === 0) return React.createElement(tbMemberLine, { label: t('member.receipts'), value: t('member.empty'), t });
  return React.createElement('div', { className: 'tb-member-list' }, items.map((item, index) => {
    const verification = tbStr(item, 'verification');
    const outcome = tbStr(item, 'outcome');
    const workId = tbStr(item, 'workId');
    const tags = [];
    if (outcome !== undefined) tags.push(outcome);
    tags.push(verification === undefined ? t('member.notProvided') : (t('member.verification.' + verification) === 'member.verification.' + verification ? verification : t('member.verification.' + verification)));
    return React.createElement(tbMemberItem, {
      key: 'r' + index,
      className: 'tb-member-item tb-receipt',
      title: workId ?? '#' + (index + 1),
      tags,
      note: tbStr(item, 'attemptId') === undefined ? undefined : t('member.attempt') + tbShortId(tbStr(item, 'attemptId'))
    });
  }));
}

/** The four DISTINCT control semantics of autonomy-v1 §八, plus the explicit resume. */
function tbMemberActions(props) {
  const { autonomy, paused, onStopTurn, onPauseDispatch, onResumeDispatch, onCancelWork, onStopTeam, t } = props;
  const button = (key, label, handler, title) => React.createElement('button', {
    key,
    type: 'button',
    className: 'tb-btn tb-btn-quiet',
    title,
    onClick: handler
  }, label);
  return React.createElement('div', { className: 'tb-member-actions' }, [
    button('stop-turn', t('action.stopTurn'), onStopTurn, t('action.stopTurn.hint')),
    paused === true
      ? button('resume', t('action.resumeDispatch'), onResumeDispatch, t('action.resumeDispatch.hint'))
      : button('pause', t('action.pauseDispatch'), onPauseDispatch, t('action.pauseDispatch.hint')),
    button('cancel', t('action.cancelWork'), onCancelWork, t('action.cancelWork.hint')),
    button('stop-team', t('action.stopTeam'), onStopTeam, t('action.stopTeam.hint'))
  ]);
}

/**
 * The per-pane instruction box: the ONE path the user has to say something to THIS member
 * (the native composer also targets this member's session). The draft and the
 * acknowledgement are per-pane component state, so nothing crosses panes.
 */
function tbInstructionBox(props) {
  const { sessionId, memberLabel, runtime, t } = props;
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  // Read the acknowledgement from the runtime instead of local state: it is keyed by session,
  // so it survives a pane remount (layout change) and never leaks into another pane.
  const ack = runtime.instructionAckFor(sessionId);
  const send = () => {
    const text = draft.trim();
    if (text === '' || sending) return;
    setSending(true);
    Promise.resolve(runtime.sendUserInstruction(sessionId, text)).then((result) => {
      setSending(false);
      if (result !== undefined && result.ok === true) setDraft('');
    }, () => setSending(false));
  };
  return React.createElement('div', { className: 'tb-instruction' }, [
    React.createElement('div', { key: 'label', className: 'tb-instruction-label' }, t('instr.label')),
    React.createElement('div', { key: 'row', className: 'tb-instruction-row' }, [
      React.createElement('input', {
        key: 'input',
        className: 'tb-instruction-input',
        type: 'text',
        value: draft,
        placeholder: t('instr.placeholder'),
        onChange: (event) => setDraft(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') send();
        }
      }),
      React.createElement('button', {
        key: 'send',
        type: 'button',
        className: 'tb-btn tb-instruction-send',
        disabled: sending || draft.trim() === '',
        onClick: send
      }, sending ? t('instr.sending') : t('instr.send'))
    ]),
    ack === undefined || ack === null
      ? null
      : React.createElement('div', {
        key: 'ack',
        className: 'tb-instruction-ack' + (ack.ok === true ? '' : ' tb-instruction-ack-failed')
      }, ack.ok === true
        ? tbFormat(t, 'instr.sent', { member: ack.memberLabel ?? memberLabel ?? sessionId })
        : tbFormat(t, 'instr.failed', { code: ack.code ?? 'UNKNOWN' }))
  ]);
}

/* ============================================================================================
 * COST + REAL RESULTS (工作台运行状态; contract docs/ARCHITECTURE.md §1)
 *
 * Same typography contract as the rest of the member detail: one information unit per 12px
 * block line, everything below is ON DEMAND (inside the 「详情」 body), long lists are paginated
 * LOCALLY (no fetch, no model call, no log rescan). A field the host did not send renders
 * 「未提供」; `costEstimate` always carries 「（估算）」; `costUnknownRequests > 0` gets its own
 * lower-bound warning; `invalidated` gets its own 「证据已过期」 line. Counts are never shown as
 * progress.
 * ========================================================================================== */

/** Host pager: one line (prev · host page/total · next). No local slicing (revision R2). */
function tbPager(props) {
  const { page, pages, total, onPrev, onNext, t, marker } = props;
  if (typeof total !== 'number' || total === 0) return null;
  return React.createElement('div', { className: 'tb-pager', 'data-pager': marker ?? '' }, [
    React.createElement('button', { key: 'prev', type: 'button', className: 'tb-btn tb-btn-quiet', disabled: page <= 1, onClick: onPrev }, t('findings.prev')),
    React.createElement('span', { key: 'text', className: 'tb-member-item-note' }, tbFormat(t, 'findings.page', { page, pages, total })),
    React.createElement('button', { key: 'next', type: 'button', className: 'tb-btn tb-btn-quiet', disabled: page >= pages, onClick: onNext }, t('findings.next'))
  ]);
}

/** R1: `currency amount` — only produced when the host sent a real currency. */
function tbMoneyWithEstimate(t, budget, usage) {
  if (budget === undefined || budget.costEstimate === undefined) return undefined;
  const money = tbMoneyText(budget.costEstimate, usage !== undefined && usage.currency !== undefined ? usage.currency : undefined);
  return money === undefined ? undefined : money + t('cost.estimateSuffix');
}

/** One BUDGET line: money (only if cost is knowable) · requests · in/out tokens. */
function tbBudgetText(t, budget, usage) {
  if (budget === undefined) return undefined;
  const parts = [];
  if (usage === undefined || usage.costKnown === undefined || usage.costKnown.known === true) {
    const money = tbMoneyWithEstimate(t, budget, usage);
    if (money !== undefined) parts.push(money);
  }
  if (budget.requests !== undefined) parts.push(tbFormat(t, 'cost.requests', { n: budget.requests }));
  if (budget.inputTokens !== undefined || budget.outputTokens !== undefined) {
    parts.push(tbFormat(t, 'cost.tokens', {
      in: tbTokenText(budget.inputTokens) ?? t('member.notProvided'),
      out: tbTokenText(budget.outputTokens) ?? t('member.notProvided')
    }));
  }
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** `{from} → {to}` compact window (month-day hour:minute); full values stay in the raw line. */
function tbWindowText(from, to) {
  const one = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    const date = new Date(value);
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    return (date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  };
  const left = one(from);
  const right = one(to);
  if (left === undefined && right === undefined) return undefined;
  return (left ?? '?') + ' → ' + (right ?? '?');
}

/** 0.123 → "12.3%"; undefined-safe. */
function tbPercentText(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return undefined;
  return (ratio * 100).toFixed(1).replace(/\.0$/, '') + '%';
}

/**
 * 费用 section (summary only; revisions R1 + §8.1/§8.4):
 *  - **team-scoped only**: `scopes.team` is rendered ONLY when the Host echoed the pane's teamKey
 *    (`team.teamKey === teamKey`). With `teamKey = null` the host returns the ACCOUNT total, which
 *    must not be shown inside every member pane (each member would otherwise display the whole
 *    account). The owner rows (`scopes.byOwner[owner]`) are per-member and always safe.
 *  - **pricing.book**: the real price table (per provider/model/period, explicit numbers where
 *    `0` is a legitimate free tier). `null`/missing rate or an empty book ⇒ cost UNKNOWN; it is
 *    never defaulted to USD or to 0.
 *  - mixed currency (`uncertainty.mixedCurrency`) ⇒ the summed amount is meaningless: shown as
 *    unknown with the mixed-currency warning, `costByCurrency` still listed per currency.
 */
function tbCostSection(props) {
  const { usage, t, now, teamKey, runtime } = props;
  if (usage.found !== true) {
    return React.createElement('div', { className: 'tb-cost', 'data-cost': 'missing' }, [
      React.createElement('div', { key: 'h', className: 'tb-member-sub' }, t('cost.section')),
      React.createElement(tbMemberLine, { key: 'wait', label: t('cost.waiting'), value: undefined, t })
    ]);
  }
  const team = usage.team;
  const teamScoped = team !== undefined && team.teamKey !== null && team.teamKey !== undefined && teamKey !== undefined && team.teamKey === teamKey;
  const costKnown = usage.costKnown === undefined ? { known: false, reason: 'usage' } : usage.costKnown;
  const lines = [];
  if (costKnown.known === true) {
    if (teamScoped) {
      lines.push(React.createElement(tbMemberLine, { key: 'team', label: t('cost.team'), value: tbBudgetText(t, team.cumulative, usage), t }));
      lines.push(React.createElement(tbMemberLine, {
        key: 'teamPhase',
        label: t('cost.teamPhase'),
        value: team.phase === undefined ? undefined : (tbBudgetText(t, team.phase.cumulative, usage) ?? (team.phase.label ?? team.phase.id)),
        t
      }));
    } else {
      // Account-wide totals are not a per-member fact: say so instead of showing the whole account.
      lines.push(React.createElement(tbMemberLine, { key: 'team', label: t('cost.team'), value: t('cost.accountScopeHidden'), t }));
    }
    lines.push(React.createElement(tbMemberLine, { key: 'owner', label: t('cost.owner'), value: tbBudgetText(t, usage.owner, usage), t }));
  } else {
    lines.push(React.createElement(tbMemberLine, { key: 'unknownCost', label: t('cost.team'), value: t('cost.costUnknown'), t, tone: 'tb-member-warn' }));
    // CONTRACT v4 §11.1: unknown + explicit reason codes, never a defaulted USD/0 amount.
    const reasonCodes = usage.reasonCodes === undefined || usage.reasonCodes.length === 0 ? ['USAGE_UNKNOWN'] : usage.reasonCodes;
    lines.push(React.createElement(tbMemberLine, {
      key: 'unknownReason',
      label: usage.reasonDeclared === true ? t('cost.labelWarning') : t('cost.unknownReasonCandidates'),
      value: reasonCodes.map((code) => t('cost.reason.' + code) === 'cost.reason.' + code ? code : t('cost.reason.' + code)).join(' · '),
      t,
      tone: 'tb-member-warn'
    }));
    // Counts stay visible even when the amount is unknown (never hide the ledger).
    const costByCurrency = usage.costByCurrency;
    const currencyKeys = costByCurrency === undefined ? [] : Object.keys(costByCurrency);
    if (currencyKeys.length > 0) {
      lines.push(React.createElement(tbMemberLine, {
        key: 'costByCurrency',
        label: t('cost.labelEstimate'),
        value: currencyKeys.map((code) => {
          const budget = costByCurrency[code];
          const money = tbMoneyText(budget === undefined ? undefined : tbNum(budget, 'costEstimate'), code);
          return code + ': ' + (money === undefined ? t('member.notProvided') : money + t('cost.estimateSuffix'));
        }).join(' · '),
        t
      }));
    }
    if (usage.totals !== undefined) {
      const parts = [];
      if (usage.totals.requests !== undefined) parts.push(tbFormat(t, 'cost.requests', { n: usage.totals.requests }));
      if (usage.totals.inputTokens !== undefined || usage.totals.outputTokens !== undefined) {
        parts.push(tbFormat(t, 'cost.tokens', {
          in: tbTokenText(usage.totals.inputTokens) ?? t('member.notProvided'),
          out: tbTokenText(usage.totals.outputTokens) ?? t('member.notProvided')
        }));
      }
      if (parts.length > 0) lines.push(React.createElement(tbMemberLine, { key: 'counts', label: t('cost.usageDetail'), value: parts.join(' · '), t }));
    }
  }
  lines.push(React.createElement(tbMemberLine, { key: 'ownerPhase', label: t('cost.ownerPhase'), value: undefined, t }));
  // CONTRACT v4 §11.1: even when the priced part yields a (lower-bound) estimate, the Host-declared
  // unknown reason codes must stay visible verbatim (e.g. some requests unpriced at peak time).
  if (costKnown.known === true && usage.reasonCodes !== undefined && usage.reasonCodes.length > 0) {
    lines.push(React.createElement(tbMemberLine, {
      key: 'partialReasons',
      label: usage.reasonDeclared === true ? t('cost.labelWarning') : t('cost.unknownReasonCandidates'),
      value: usage.reasonCodes.map((code) => t('cost.reason.' + code) === 'cost.reason.' + code ? code : t('cost.reason.' + code)).join(' · '),
      t,
      tone: 'tb-member-warn'
    }));
  }
  const uncertainty = usage.uncertainty;
  const unknownRequests = uncertainty !== undefined && uncertainty.missingUsageRequests !== undefined
    ? uncertainty.missingUsageRequests
    : (usage.totals !== undefined ? usage.totals.costUnknownRequests : undefined);
  if (unknownRequests !== undefined && unknownRequests > 0) {
    lines.push(React.createElement(tbMemberLine, { key: 'unknown', label: t('cost.labelWarning'), value: tbFormat(t, 'cost.unknownRequests', { n: unknownRequests }), t, tone: 'tb-member-warn' }));
  }
  if (usage.mixedCurrency === true) {
    lines.push(React.createElement(tbMemberLine, { key: 'mixed', label: t('cost.labelWarning'), value: t('cost.mixedCurrency'), t, tone: 'tb-member-warn' }));
  }
  if (uncertainty !== undefined && uncertainty.unattributedRequests !== undefined && uncertainty.unattributedRequests > 0) {
    lines.push(React.createElement(tbMemberLine, { key: 'unattributed', label: t('cost.labelWarning'), value: tbFormat(t, 'cost.unattributed', { n: uncertainty.unattributedRequests }), t, tone: 'tb-member-warn' }));
  }
  if (uncertainty !== undefined && uncertainty.estimatedCostRatio !== undefined && uncertainty.estimatedCostRatio !== null) {
    lines.push(React.createElement(tbMemberLine, { key: 'ratio', label: t('cost.labelEstimate'), value: tbFormat(t, 'cost.estimateRatio', { ratio: tbPercentText(uncertainty.estimatedCostRatio) ?? t('member.notProvided') }), t }));
  }
  // Pricing book: version/source + the real per-provider rates (traceability, §8.1).
  const pricingView = usage.pricingView;
  if (pricingView === undefined) {
    lines.push(React.createElement(tbMemberLine, { key: 'pricing', label: t('cost.labelPricing'), value: t('cost.noPricing'), t, tone: 'tb-member-warn' }));
  } else {
    const book = pricingView.entries ?? [];
    let pricingText;
    if (book.length === 0) {
      pricingText = pricingView.legacyInputPerMillion !== undefined && pricingView.legacyInputPerMillion !== null
        ? tbFormat(t, 'cost.pricingSingle', {
          input: pricingView.legacyInputPerMillion,
          output: pricingView.legacyOutputPerMillion ?? t('member.notProvided'),
          cache: pricingView.legacyCacheReadPerMillion ?? t('member.notProvided')
        })
        : t('cost.noPricing');
    } else if (book.length === 1) {
      const entry = book[0];
      pricingText = [entry.provider ?? '*', entry.model ?? '*'].join('/') + ' · ' + tbFormat(t, 'cost.pricingSingle', {
        input: entry.inputPerMillion ?? t('member.notProvided'),
        output: entry.outputPerMillion ?? t('member.notProvided'),
        cache: entry.cacheReadPerMillion ?? t('member.notProvided')
      });
    } else {
      pricingText = tbFormat(t, 'cost.pricingBook', { n: book.length });
    }
    lines.push(React.createElement(tbMemberLine, {
      key: 'pricing',
      label: t('cost.labelPricing'),
      value: [pricingView.version ?? t('member.notProvided'), pricingView.source ?? '', pricingText].filter((part) => part !== '').join(' · '),
      t
    }));
  }
  const trace = [];
  if (usage.currency !== undefined) trace.push(tbFormat(t, 'cost.currencyLabel', { currency: usage.currency }));
  if (usage.raw !== undefined && usage.raw.source !== undefined) trace.push(tbFormat(t, 'cost.source', { source: usage.raw.source }));
  if (usage.raw !== undefined) {
    const windowText = tbWindowText(usage.raw.windowFrom, usage.raw.windowTo);
    if (windowText !== undefined) trace.push(tbFormat(t, 'cost.windowLabel', { window: windowText }));
  }
  if (usage.generatedAt !== undefined) trace.push(tbFormat(t, 'cost.generatedAt', { age: tbHelpers.ago(usage.generatedAt, now, t) }));
  if (trace.length > 0) lines.push(React.createElement(tbMemberLine, { key: 'trace', label: t('cost.labelSource'), value: trace.join(' · '), t }));
  if (tbIsOlderThan(usage.generatedAt, now, 5 * 60 * 1000)) {
    lines.push(React.createElement(tbMemberLine, { key: 'stale', label: t('cost.labelWarning'), value: tbFormat(t, 'cost.stale', { age: tbHelpers.ago(usage.generatedAt, now, t) }), t, tone: 'tb-member-warn' }));
  }
  if (usage.missing.length > 0) {
    lines.push(React.createElement('div', { key: 'missing', className: 'tb-member-missing' }, t('member.missing') + usage.missing.join(' / ')));
  }
  // Production refresh state (background, bounded): update time + stale/error, never hides values.
  const refresh = runtime !== undefined && typeof runtime.refreshState === 'function' ? runtime.refreshState() : undefined;
  if (refresh !== undefined) {
    const usageRegion = refresh.regions === undefined || refresh.regions === null ? undefined : refresh.regions.usage;
    const usageFailed = usageRegion !== undefined && usageRegion !== null && usageRegion.error !== null && usageRegion.error !== undefined;
    const usageAt = usageRegion === undefined || usageRegion === null ? undefined : usageRegion.at;
    // PER-REGION truth: if the cost projection is the failed part of a partial refresh, show the
    // OLD cost time + partial/stale, not the newest overall refresh time.
    const stampSource = usageFailed ? usageAt : refresh.lastSuccessAt;
    lines.push(React.createElement(tbMemberLine, {
      key: 'updatedAt',
      label: t('cost.updatedAt'),
      value: tbFormat(t, 'cost.updateInfo', {
        age: stampSource === null || stampSource === undefined ? t('cost.refreshNever') : tbHelpers.ago(stampSource, now, t)
      }) + ' · ' + (usageFailed
        ? (refresh.partial === true ? t('cost.partialRefresh') : t('cost.stale'))
        : (refresh.stale === true ? t('cost.stale') : (refresh.suspended === true ? t('cost.refreshPaused') : t('cost.refreshActive')))),
      t,
      tone: usageFailed ? 'tb-member-warn' : undefined
    }));
    if (usageFailed) {
      const code = usageRegion === undefined || usageRegion === null ? refresh.lastError : usageRegion.error;
      lines.push(React.createElement(tbMemberLine, {
        key: 'usageRefreshError',
        label: t('cost.labelWarning'),
        value: tbFormat(t, 'cost.usageStale', { code: String(code ?? refresh.lastError ?? 'PROJECTION_FAILED') }),
        t,
        tone: 'tb-member-warn'
      }));
    } else if (refresh.lastError !== null && refresh.lastError !== undefined && refresh.partial !== true) {
      lines.push(React.createElement(tbMemberLine, {
        key: 'refreshError',
        label: t('cost.labelWarning'),
        value: tbFormat(t, 'cost.refreshError', { code: String(refresh.lastError) }),
        t,
        tone: 'tb-member-warn'
      }));
    }
  }
  return React.createElement('div', { className: 'tb-cost', 'data-cost': 'provided', 'data-team-scoped': teamScoped ? 'true' : 'false' }, [React.createElement('div', { key: 'h', className: 'tb-member-sub' }, t('cost.section'))].concat(lines));
}

/**
 * Shared host-page reader for one detail kind (revision R2): requests page 1 on mount, renders the
 * host page verbatim, and pages ONLY through host requests. A `preview` (explicit host preview) is
 * shown without a pager when the detail route is unavailable — a full `/state` ledger is never
 * sliced locally.
 */
function tbDetailList(props) {
  const { runtime, t, query, preview, renderItems, marker, emptyKey } = props;
  const [page, setPage] = React.useState(1);
  const [tick, setTick] = React.useState(0);
  // `detailGeneration()` bumps whenever a new snapshot invalidates the cache; it MUST be part of the
  // deps so an already-mounted list re-fetches its visible page instead of sitting on a cleared cache.
  const generation = typeof runtime.detailGeneration === 'function' ? runtime.detailGeneration() : 0;
  React.useEffect(() => {
    let alive = true;
    Promise.resolve(runtime.ensureDetailPage(Object.assign({}, query, { page }))).then(() => {
      if (alive) setTick((value) => value + 1);
    }, () => {
      if (alive) setTick((value) => value + 1);
    });
    return () => {
      alive = false;
    };
  }, [runtime, generation, page, query.section, query.kind, query.ownerMemberId, query.pageSize]);
  const effective = Object.assign({}, query, { page });
  const record = runtime.detailPageFor(effective);
  const state = record === undefined ? 'loading' : record.state;
  if (state === 'loaded') {
    const hostPage = record.page;
    const items = hostPage.items;
    return React.createElement('div', { className: 'tb-cost', 'data-detail': marker, 'data-detail-state': 'loaded', 'data-host-page': String(hostPage.page) }, [
      items.length === 0
        ? React.createElement(tbMemberLine, { key: 'none', label: t(emptyKey), value: t('findings.none'), t })
        : React.createElement('div', { key: 'list', className: 'tb-member-list', 'data-page-items': String(items.length) }, items.map((row, index) => renderItems(row, index))),
      React.createElement(tbPager, {
        key: 'pager',
        page: hostPage.page,
        pages: hostPage.pages,
        total: hostPage.total,
        marker,
        t,
        onPrev: () => setPage(Math.max(1, hostPage.page - 1)),
        onNext: () => setPage(hostPage.page + 1)
      })
    ]);
  }
  if (preview !== undefined) {
    // Explicit host preview only (no local pagination): show what the host marked as preview.
    return React.createElement('div', { className: 'tb-cost', 'data-detail': marker, 'data-detail-state': 'preview' }, [
      React.createElement(tbMemberLine, { key: 'note', label: t('cost.previewOnly'), value: undefined, t }),
      preview.length === 0
        ? React.createElement(tbMemberLine, { key: 'none', label: t(emptyKey), value: t('findings.none'), t })
        : React.createElement('div', { key: 'list', className: 'tb-member-list' }, preview.map((row, index) => renderItems(row, index)))
    ]);
  }
  if (state === 'unavailable') {
    return React.createElement('div', { className: 'tb-cost', 'data-detail': marker, 'data-detail-state': 'unavailable' }, [
      React.createElement(tbMemberLine, { key: 'wait', label: t('cost.detailUnavailable'), value: record.error === undefined ? undefined : record.error, t })
    ]);
  }
  return React.createElement('div', { className: 'tb-cost', 'data-detail': marker, 'data-detail-state': 'loading' }, [
    React.createElement(tbMemberLine, { key: 'loading', label: t('cost.detailLoading'), value: undefined, t })
  ]);
}

/** R3: claim scope + verification level, always rendered as their own lines, verbatim. */
function tbClaimLines(props) {
  const { row, t, levelInfo } = props;
  const claim = tbClaimOf(row);
  const levelText = tbLevelText(t, claim.verificationLevel);
  const evidenceLevelText = tbEvidenceLevelText(t, claim.evidenceLevel);
  return [
    React.createElement(tbMemberLine, {
      key: 'claimScope',
      label: t('findings.claimScope'),
      value: claim.claimScope === undefined ? undefined : tbClaimScopeText(t, claim.claimScope),
      t
    }),
    React.createElement(tbMemberLine, {
      key: 'verificationLevel',
      label: t('findings.verificationLevel'),
      value: levelText === undefined ? undefined : levelText,
      t,
      tone: claim.verificationLevel === 'user-confirmation' || claim.verificationLevel === 'gameplay' ? undefined : 'tb-member-warn'
    }),
    React.createElement(tbMemberLine, {
      key: 'evidenceLevel',
      label: t('findings.evidenceLevel'),
      value: levelInfo !== undefined && levelInfo.evidenceLevel !== undefined
        ? (tbEvidenceLevelText(t, levelInfo.evidenceLevel) ?? levelInfo.evidenceLevel)
        : evidenceLevelText,
      t
    }),
    React.createElement(tbMemberLine, {
      key: 'ceiling',
      label: t('findings.ceiling'),
      value: levelInfo !== undefined && levelInfo.ceiling !== undefined ? levelInfo.ceiling : claim.ceiling,
      t
    })
  ];
}

/** One verified result: title + `path@version` artifacts + one evidence ref per line + claim lines. */
function tbVerifiedItem(props) {
  const { row, t, levelByWork } = props;
  const title = tbStr(row, 'title') ?? tbStr(row, 'workId') ?? t('member.notProvided');
  const claimForVersions = tbClaimOf(row);
  const artifacts = claimForVersions.artifactVersions.map((artifact) => {
    if (artifact.path === undefined) return undefined;
    // §11.3: the version slot is explicit — a missing version says 「版本未提供」, it is never omitted.
    return artifact.version === null
      ? artifact.path + '@' + t('findings.versionMissing')
      : artifact.path + '@v' + artifact.version;
  }).filter((value) => value !== undefined);
  const evidence = tbArr(row, 'evidence') ?? [];
  const nodes = [
    React.createElement('div', { key: 'title', className: 'tb-member-item-title' }, title),
    artifacts.length === 0
      ? React.createElement('div', { key: 'artifacts', className: 'tb-member-item-note' }, t('findings.artifact') + ': ' + t('member.notProvided'))
      : React.createElement('div', { key: 'artifacts', className: 'tb-member-item-note' }, t('findings.artifact') + ': ' + artifacts.join(' · '))
  ];
  // 依赖版本（dependencyVersions / artifactDependencies）：缺版本同上。
  const deps = claimForVersions.dependencyVersions;
  if (deps.length > 0) {
    nodes.push(React.createElement('div', { key: 'deps', className: 'tb-member-item-note' }, t('findings.dependencyVersions') + ': ' + deps.map((dep) => {
      const version = dep.version === null ? t('findings.versionMissing') : 'v' + dep.version;
      const requires = dep.requires === undefined ? '' : '(' + dep.requires + ')';
      return String(dep.artifact ?? '?') + '@' + version + requires;
    }).join(' · ')));
  }
  // 可信执行三元组（attempt / execution / exitCode / artifactSha256）：文件存在 ≠ 真实执行。
  const trusted = claimForVersions.trustedExecution;
  if (trusted !== undefined) {
    const parts = [];
    parts.push(t('findings.trustedExecution.attempt') + ': ' + (trusted.attemptId ?? t('member.notProvided')));
    parts.push(t('findings.trustedExecution.run') + ': ' + (trusted.executionRunId ?? t('member.notProvided')));
    parts.push(t('findings.trustedExecution.exit') + ': ' + (trusted.exitCode === undefined ? t('member.notProvided') : String(trusted.exitCode)));
    parts.push(t('findings.trustedExecution.sha') + ': ' + (trusted.artifactSha256 ?? t('member.notProvided')));
    nodes.push(React.createElement('div', { key: 'trusted', className: trusted.complete === true ? 'tb-member-item-note' : 'tb-member-warn tb-member-item-note' }, t('findings.trustedExecution') + ': ' + parts.join(' · ') + (trusted.complete === true ? '' : ' · ' + t('findings.trustedExecution.incomplete'))));
  }
  if (evidence.length === 0) {
    nodes.push(React.createElement('div', { key: 'evidence0', className: 'tb-member-warn tb-member-item-note' }, t('findings.evidence') + ': ' + t('member.notProvided')));
  } else {
    evidence.forEach((entry, index) => {
      const kind = tbStr(entry, 'kind') ?? t('member.notProvided');
      const ref = tbStr(entry, 'ref') ?? t('member.notProvided');
      nodes.push(React.createElement('div', { key: 'evidence' + index, className: 'tb-member-item-note' }, t('findings.evidence') + ': ' + kind + ' · ' + ref));
    });
  }
  const workId = tbStr(row, 'workId');
  const levelInfo = levelByWork !== undefined && workId !== undefined ? levelByWork[workId] : undefined;
  // `limitations`: what this evidence does NOT prove (host-authored; rendered verbatim).
  const limitations = tbArr(row, 'limitations') ?? [];
  limitations.forEach((text, index) => {
    if (typeof text === 'string' && text !== '') {
      nodes.push(React.createElement('div', { key: 'limitation' + index, className: 'tb-member-warn tb-member-item-note' }, t('findings.limitations') + ': ' + text));
    }
  });
  return React.createElement('div', { className: 'tb-member-item', 'data-verified': workId ?? '' }, nodes.concat(tbClaimLines({ row, t, levelInfo })));
}

/** Verified results (host-paginated) + counts from the summary (R2/R3). */
function tbVerifiedSection(props) {
  const { findings, runtime, t, ownerKeys, teamKey } = props;
  if (findings.found !== true) {
    return React.createElement(React.Fragment, null, [
      React.createElement('div', { key: 'h', className: 'tb-member-sub' }, t('findings.verified')),
      React.createElement(tbMemberLine, { key: 'wait', label: t('findings.waiting'), value: undefined, t })
    ]);
  }
  const counts = findings.counts;
  const preview = findings.preview === undefined ? undefined : findings.preview.verified;
  const ownerId = ownerKeys.length > 0 ? ownerKeys[0] : undefined;
  // §7.1 levels.verified: [{workId, evidenceLevel, ceiling}] → per-item lookup, never invented.
  const levelByWork = {};
  for (const entry of (findings.levels === undefined ? [] : (findings.levels.verified ?? []))) {
    const workId = tbStr(entry, 'workId');
    if (workId !== undefined) levelByWork[workId] = { evidenceLevel: tbStr(entry, 'evidenceLevel'), ceiling: tbStr(entry, 'ceiling') };
  }
  const head = React.createElement('div', { key: 'h', className: 'tb-member-sub' }, t('findings.verified'));
  const countLine = React.createElement(tbMemberLine, {
    key: 'count',
    label: t('findings.countsLine'),
    value: counts === undefined
      ? undefined
      : tbFormat(t, 'findings.countsLine', {
        verified: counts.verified ?? t('member.notProvided'),
        unfinished: counts.unfinished ?? t('member.notProvided'),
        inProgress: counts.inProgress ?? t('member.notProvided'),
        rejected: counts.rejected ?? t('member.notProvided'),
        invalidated: counts.invalidated ?? t('member.notProvided'),
        activity: counts.activity ?? t('member.notProvided'),
        errors: counts.errors ?? t('member.notProvided')
      }),
    t
  });
  const levels = counts === undefined ? undefined : counts.verifiedByLevel;
  const levelLine = levels === undefined
    ? React.createElement(tbMemberLine, { key: 'levels', label: t('findings.levels'), value: undefined, t })
    : React.createElement(tbMemberLine, {
      key: 'levels',
      label: t('findings.levels'),
      value: tbLevelKeys().map((key) => {
        const text = tbLevelText(t, key) ?? key;
        const value = tbNum(levels, key);
        return text + ': ' + (value === undefined ? t('member.notProvided') : value);
      }).join(' · '),
      t
    });
  return React.createElement(React.Fragment, null, [
    head,
    countLine,
    levelLine,
    React.createElement(tbDetailList, {
      key: 'list',
      runtime,
      t,
      marker: 'verified',
      query: { section: 'findings', kind: 'verified', pageSize: 20, ownerMemberId: ownerId, teamKey },
      preview,
      emptyKey: 'findings.verified',
      renderItems: (row, index) => React.createElement(tbVerifiedItem, { key: 'v' + index, row, t, levelByWork })
    })
  ]);
}

/** Unfinished + rejected + invalidated (host-paginated) + last effective progress. */
function tbOutcomeSection(props) {
  const { findings, runtime, t, now, ownerKeys, teamKey } = props;
  if (findings.found !== true) {
    return React.createElement(React.Fragment, null, [
      React.createElement('div', { key: 'h', className: 'tb-member-sub' }, t('findings.unfinished')),
      React.createElement(tbMemberLine, { key: 'wait', label: t('findings.waiting'), value: undefined, t })
    ]);
  }
  const counts = findings.counts;
  const previewUnfinished = findings.preview === undefined ? undefined : findings.preview.unfinished;
  const ownerId = ownerKeys.length > 0 ? ownerKeys[0] : undefined;
  const nodes = [React.createElement('div', { key: 'h0', className: 'tb-member-sub' }, t('findings.unfinished'))];
  nodes.push(React.createElement(tbMemberLine, { key: 'ucount', label: t('findings.unfinishedCount'), value: counts === undefined || counts.unfinished === undefined ? undefined : String(counts.unfinished), t }));
  nodes.push(React.createElement(tbDetailList, {
    key: 'unfinished-list',
    runtime,
    t,
    marker: 'unfinished',
    query: { section: 'findings', kind: 'unfinished', pageSize: 20, ownerMemberId: ownerId, teamKey },
    preview: previewUnfinished,
    emptyKey: 'findings.unfinished',
    renderItems: (row, index) => React.createElement('div', { key: 'u' + index, className: 'tb-member-item', 'data-unfinished': tbStr(row, 'workId') ?? '' }, [
      React.createElement('div', { key: 't', className: 'tb-member-item-title' }, tbStr(row, 'title') ?? tbStr(row, 'workId') ?? t('member.notProvided')),
      React.createElement('div', { key: 'm', className: 'tb-member-item-note' }, t('findings.missing') + ': ' + ((tbArr(row, 'missing') ?? []).join(' · ') || t('member.notProvided')))
    ])
  }));
  nodes.push(React.createElement(tbMemberLine, { key: 'icount', label: t('findings.invalidated'), value: counts === undefined || counts.invalidated === undefined ? undefined : String(counts.invalidated), t }));
  nodes.push(React.createElement(tbDetailList, {
    key: 'invalidated-list',
    runtime,
    t,
    marker: 'invalidated',
    query: { section: 'findings', kind: 'invalidated', pageSize: 20, teamKey },
    preview: undefined,
    emptyKey: 'findings.invalidated',
    renderItems: (row, index) => React.createElement('div', { key: 'i' + index, className: 'tb-member-item', 'data-invalidated': tbStr(row, 'workId') ?? '' }, [
      React.createElement('div', { key: 't', className: 'tb-member-item-title' }, tbStr(row, 'workId') ?? t('member.notProvided')),
      React.createElement('div', { key: 'r', className: 'tb-member-warn tb-member-item-note' }, tbFormat(t, 'findings.invalidatedReason', { reason: tbStr(row, 'reason') ?? t('member.notProvided') })),
      tbIsTrue(row, 'legacyOwnerClaim')
        ? React.createElement('div', { key: 'legacy', className: 'tb-member-warn tb-member-item-note' }, t('findings.legacyClaim'))
        : null
    ])
  }));
  nodes.push(React.createElement(tbMemberLine, { key: 'rcount', label: t('findings.rejected'), value: counts === undefined || counts.rejected === undefined ? undefined : String(counts.rejected), t }));
  nodes.push(React.createElement(tbDetailList, {
    key: 'rejected-list',
    runtime,
    t,
    marker: 'rejected',
    query: { section: 'findings', kind: 'rejected', pageSize: 20, ownerMemberId: ownerId, teamKey },
    preview: undefined,
    emptyKey: 'findings.rejected',
    renderItems: (row, index) => React.createElement('div', { key: 'r' + index, className: 'tb-member-item', 'data-rejected': tbStr(row, 'workId') ?? '' }, [
      React.createElement('div', { key: 't', className: 'tb-member-item-title' }, tbStr(row, 'workId') ?? t('member.notProvided')),
      React.createElement('div', { key: 'n', className: 'tb-member-item-note' }, tbStr(row, 'note') ?? t('member.notProvided'))
    ])
  }));
  const progress = findings.lastEffectiveProgress;
  if (progress !== undefined) {
    const at = tbNum(progress, 'at');
    const parts = [tbStr(progress, 'text') ?? t('member.notProvided')];
    const owner = tbStr(progress, 'ownerMemberId');
    if (owner !== undefined) parts.push(owner);
    if (at !== undefined) parts.push(tbHelpers.ago(at, now, t));
    nodes.push(React.createElement(tbMemberLine, { key: 'progress', label: t('findings.progress'), value: parts.join(' · '), t }));
  } else {
    nodes.push(React.createElement(tbMemberLine, { key: 'progress', label: t('findings.progress'), value: undefined, t }));
  }
  return React.createElement(React.Fragment, null, nodes);
}

/** Usage breakdown (host-paginated detail; summary already shows the headline numbers). */
/** One usage budget row: owner / phase / work dimension, all read from the host page. */
function tbUsageRow(props) {
  const { row, t, usage, index } = props;
  const key = tbStr(row, 'ownerMemberId') ?? tbStr(row, 'workId') ?? tbStr(row, 'phase') ?? tbStr(row, 'label') ?? tbStr(row, 'key');
  if (key === undefined && tbStr(row, 'value') !== undefined) {
    // Compatibility transport (op/usage-records) rows are already normalized to key/value.
    return React.createElement('div', { key: 'u' + index, className: 'tb-member-item' }, [
      React.createElement('div', { key: 'k', className: 'tb-member-item-title' }, tbStr(row, 'key') ?? t('member.notProvided')),
      React.createElement('div', { key: 'v', className: 'tb-member-item-note' }, tbStr(row, 'value') ?? t('member.notProvided'))
    ]);
  }
  const parts = [];
  if (tbNum(row, 'requests') !== undefined) parts.push(tbFormat(t, 'cost.requests', { n: tbNum(row, 'requests') }));
  if (tbNum(row, 'inputTokens') !== undefined || tbNum(row, 'outputTokens') !== undefined) {
    parts.push(tbFormat(t, 'cost.tokens', {
      in: tbTokenText(tbNum(row, 'inputTokens')) ?? t('member.notProvided'),
      out: tbTokenText(tbNum(row, 'outputTokens')) ?? t('member.notProvided')
    }));
  }
  const money = tbMoneyText(tbNum(row, 'costEstimate'), usage === undefined ? undefined : usage.currency);
  if (money !== undefined) parts.push(money + t('cost.estimateSuffix'));
  const unknown = tbNum(row, 'costUnknownRequests');
  if (unknown !== undefined && unknown > 0) parts.push(tbFormat(t, 'cost.unknownRequests', { n: unknown }));
  return React.createElement('div', { key: 'u' + index, className: 'tb-member-item', 'data-usage-key': String(key) }, [
    React.createElement('div', { key: 'k', className: 'tb-member-item-title' }, String(key)),
    React.createElement('div', { key: 'v', className: 'tb-member-item-note' }, parts.length === 0 ? t('member.notProvided') : parts.join(' · '))
  ]);
}

/**
 * Usage detail (collapsible). CONTRACT v4 §11.1: the credit dimension must be visible by
 * owner / phase / work — each view is a HOST-paginated page (`section=usage&kind=…`), never a
 * locally sliced ledger.
 */
function tbUsageDetail(props) {
  const { usage, runtime, t, teamKey } = props;
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (open === true && usage.found === true && runtime !== undefined && typeof runtime.noteFrontendRendered === 'function') {
      runtime.noteFrontendRendered('usage');
    }
  }, [runtime, open, usage.found]);
  if (usage.found !== true) return null;
  const views = [
    { key: 'owner', kind: 'byOwner', label: 'cost.byOwnerView' },
    { key: 'phase', kind: 'byPhase', label: 'cost.byPhaseView' },
    { key: 'work', kind: 'byWork', label: 'cost.byWorkView' }
  ];
  return React.createElement('div', { className: 'tb-cost', 'data-usage-detail': open ? 'open' : 'closed' }, [
    React.createElement('div', { key: 'h', className: 'tb-member-sub' }, [
      t('cost.usageDetail') + ' ',
      React.createElement('button', { key: 'toggle', type: 'button', className: 'tb-btn tb-btn-quiet', onClick: () => setOpen(!open) }, open ? t('label.collapse') : t('label.expand'))
    ]),
    open === false ? null : React.createElement(React.Fragment, null, views.map((view) => React.createElement(React.Fragment, { key: view.key }, [
      React.createElement('div', { key: 'sub', className: 'tb-member-sub' }, t(view.label)),
      React.createElement(tbDetailList, {
        key: 'list',
        runtime,
        t,
        marker: 'usage-' + view.key,
        query: { section: 'usage', kind: view.kind, pageSize: 20, teamKey },
        preview: undefined,
        emptyKey: view.label,
        renderItems: (row, index) => React.createElement(tbUsageRow, { key: 'row' + index, row, index, t, usage })
      })
    ])))
  ]);
}

/** Repeated errors (host-paginated, guidance is a first-class line). */
function tbErrorGroupsSection(props) {
  const { fingerprints, runtime, t, now, ownerKeys, teamKey } = props;
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (open === true && fingerprints.found === true && runtime !== undefined && typeof runtime.noteFrontendRendered === 'function') {
      runtime.noteFrontendRendered('errors');
    }
  }, [runtime, open, fingerprints.found]);
  if (fingerprints.found !== true) {
    return React.createElement('div', { className: 'tb-cost', 'data-errors': 'missing' }, [
      React.createElement('div', { key: 'h', className: 'tb-member-sub' }, t('errors.section')),
      React.createElement(tbMemberLine, { key: 'wait', label: t('errors.waiting'), value: undefined, t })
    ]);
  }
  const ownerId = ownerKeys.length > 0 ? ownerKeys[0] : undefined;
  const head = React.createElement('div', { key: 'h', className: 'tb-member-sub' }, [
    t('errors.section') + ' ' + (fingerprints.total === undefined ? '' : tbFormat(t, 'errors.total', { n: fingerprints.total })) + ' ',
    React.createElement('button', { key: 'toggle', type: 'button', className: 'tb-btn tb-btn-quiet', onClick: () => setOpen(!open) }, open ? t('label.collapse') : t('label.expand'))
  ]);
  return React.createElement('div', { className: 'tb-cost', 'data-errors': open ? 'open' : 'closed' }, [
    head,
    open === false ? null : React.createElement(tbDetailList, {
      key: 'groups',
      runtime,
      t,
      marker: 'errors',
      // Real host: `section=errors` returns errorFingerprints.groups slices (owner filter via memberId).
      query: { section: 'errors', kind: 'errors', pageSize: 10, ownerMemberId: ownerId, teamKey },
      preview: fingerprints.preview,
      emptyKey: 'errors.section',
      renderItems: (row, index) => {
        const code = tbStr(row, 'code') ?? tbStr(row, 'fingerprint') ?? t('member.notProvided');
        const count = tbNum(row, 'count');
        const first = tbNum(row, 'firstAt');
        const last = tbNum(row, 'lastAt');
        const guidance = tbStr(row, 'guidance');
        const memberId = tbStr(row, 'memberId');
        const workIds = tbArr(row, 'workIds') ?? [];
        return React.createElement('div', { key: 'g' + index, className: 'tb-member-item', 'data-error-code': code }, [
          React.createElement('div', { key: 't', className: 'tb-member-item-title' }, tbFormat(t, 'errors.group', { code, count: count ?? t('member.notProvided') })),
          first === undefined && last === undefined
            ? null
            : React.createElement('div', { key: 'w', className: 'tb-member-item-note' }, tbFormat(t, 'errors.window', { first: first === undefined ? '?' : tbHelpers.ago(first, now, t), last: last === undefined ? '?' : tbHelpers.ago(last, now, t) })),
          guidance === undefined
            ? React.createElement('div', { key: 'g', className: 'tb-member-warn tb-member-item-note' }, tbFormat(t, 'errors.guidance', { guidance: t('member.notProvided') }))
            : React.createElement('div', { key: 'g', className: 'tb-member-item-note' }, tbFormat(t, 'errors.guidance', { guidance })),
          memberId === undefined && workIds.length === 0
            ? null
            : React.createElement('div', { key: 'r', className: 'tb-member-item-note' }, tbFormat(t, 'errors.refs', { member: memberId ?? t('member.notProvided'), work: workIds.length === 0 ? t('member.notProvided') : workIds.slice(0, 3).join(', ') }))
        ]);
      }
    })
  ]);
}

/**
 * The member block (surface v2): the member is a SECOND-LEVEL view inside its workspace
 * session, so it gets exactly ONE permanent line —
 *
 *   计划 r2 · 交付 3 · 待处理 0                         [详情]   (用户已暂停派发)
 *
 * Everything else (cost + real results, own deliverables with `execution: self|delegate`,
 * dispatch intents, receipts/verification, decision, waiting reason, the four control actions
 * and the instruction box) is behind the on-demand 「详情」 toggle. The old always-visible pill
 * row + two `label: value` lines were the "too much small print" the user asked to clear.
 */
function tbMemberPanel(props) {
  const { paneId, sessionId, memberLabel, autonomy, usage, findings, fingerprints, ownerKeys, teamKey, runtime, t } = props;
  // Defensive: the sections below must degrade to 「等待宿主数据」 rather than crash if a caller
  // ever renders the panel without the projections (requirement: missing fields never break v2).
  const usageSafe = usage !== undefined && usage !== null ? usage : tbUsageFor(undefined, []);
  const findingsSafe = findings !== undefined && findings !== null ? findings : tbFindingsFor(undefined, []);
  const fingerprintsSafe = fingerprints !== undefined && fingerprints !== null ? fingerprints : tbErrorFingerprintsFor(undefined, []);
  const ownerKeysSafe = Array.isArray(ownerKeys) ? ownerKeys : [];
  const now = Date.now();
  const [expanded, setExpanded] = React.useState(false);
  // Activation ACK evidence: only regions that actually rendered a Host projection AFTER commit.
  React.useEffect(() => {
    if (expanded !== true || runtime === undefined || typeof runtime.noteFrontendRendered !== 'function') return;
    if (usageSafe.found === true) runtime.noteFrontendRendered('cost');
    if (findingsSafe.found === true) runtime.noteFrontendRendered('findings');
  }, [runtime, expanded, usageSafe.found, findingsSafe.found]);
  const counts = tbAutonomyCounts(autonomy);
  // A pause counts as "by user" when EITHER the Host echoes it or the client recorded the
  // user's own explicit pause: the client never lifts it on its own.
  const paused = autonomy.pausedBy === 'user'
    || (autonomy.waitReason !== undefined && tbStr(autonomy.waitReason, 'kind') === 'user_pause')
    || runtime.isUserPaused(sessionId) === true;
  const instructionAck = runtime.instructionAckFor(sessionId);
  const decisionKind = tbStr(autonomy.decision, 'kind');
  const waitKind = tbStr(autonomy.waitReason, 'kind');
  const waitDetail = tbStr(autonomy.waitReason, 'detail');
  const waitText = waitKind === undefined ? undefined : (t('wait.kind.' + waitKind) === 'wait.kind.' + waitKind ? waitKind + (waitDetail === undefined ? '' : ' · ' + waitDetail) : t('wait.kind.' + waitKind) + (waitDetail === undefined ? '' : ' · ' + waitDetail));
  const summary = tbFormat(t, 'member.summary', {
    plan: autonomy.planRevision === undefined ? t('member.notProvided') : 'r' + autonomy.planRevision,
    n: counts.deliverables,
    pending: counts.inboxPending === undefined ? t('member.notProvided') : counts.inboxPending
  });

  return React.createElement('div', { className: 'tb-member', 'data-member': sessionId }, [
    React.createElement('div', { key: 'head', className: 'tb-member-head' }, [
      React.createElement('span', { key: 't', className: 'tb-member-title' }, summary),
      paused === true ? React.createElement('span', { key: 'paused', className: 'tb-pause-badge' }, t('pause.byUser')) : null,
      React.createElement('button', {
        key: 'toggle',
        type: 'button',
        className: 'tb-btn tb-btn-quiet',
        title: t('member.detail'),
        onClick: () => setExpanded(!expanded)
      }, expanded ? t('member.collapse') : t('member.detail'))
    ]),
    expanded === false ? null : React.createElement('div', { key: 'body', className: 'tb-member-body' }, [
      // 费用 + 真实成果 first (same screen as the member's own decisions), then the decisions.
      // Detail lists are HOST-paginated (revision R2): the sections fetch a page on expand and
      // page only through host requests.
      React.createElement(tbCostSection, { key: 'cost', usage: usageSafe, t, now, teamKey, runtime }),
      React.createElement(tbVerifiedSection, { key: 'verified', findings: findingsSafe, runtime, ownerKeys: ownerKeysSafe, teamKey, t }),
      React.createElement(tbOutcomeSection, { key: 'outcome', findings: findingsSafe, runtime, ownerKeys: ownerKeysSafe, teamKey, t, now }),
      React.createElement(tbUsageDetail, { key: 'usageDetail', usage: usageSafe, runtime, teamKey, t }),
      React.createElement(tbErrorGroupsSection, { key: 'errors', fingerprints: fingerprintsSafe, runtime, ownerKeys: ownerKeysSafe, teamKey, t, now }),
      React.createElement(tbMemberLine, { key: 'decision', label: t('member.decision'), value: decisionKind === undefined ? undefined : (t('member.decision.' + decisionKind) === 'member.decision.' + decisionKind ? decisionKind : t('member.decision.' + decisionKind)), t }),
      React.createElement(tbMemberLine, { key: 'wait', label: t('member.wait'), value: waitText, t, tone: waitKind === 'user_pause' ? 'tb-member-warn' : undefined }),
      React.createElement('div', { key: 'p1', className: 'tb-member-sub' }, t('member.plan')),
      React.createElement(tbMemberDeliverables, { key: 'deliverables', autonomy, t }),
      React.createElement('div', { key: 'p2', className: 'tb-member-sub' }, t('member.dispatch')),
      React.createElement(tbMemberIntents, { key: 'intents', autonomy, t }),
      React.createElement('div', { key: 'p3', className: 'tb-member-sub' }, t('member.receipts')),
      React.createElement(tbMemberReceipts, { key: 'receipts', autonomy, t }),
      React.createElement(tbMemberLine, { key: 'progress', label: t('member.progress'), value: (autonomy.recentProgress ?? []).length === 0 ? undefined : tbStr((autonomy.recentProgress ?? [])[autonomy.recentProgress.length - 1], 'text'), t }),
      React.createElement(tbMemberLine, { key: 'subtasks', label: t('member.subtasks'), value: autonomy.subtasks === undefined ? undefined : String(autonomy.subtasks.length), t }),
      React.createElement(tbMemberLine, { key: 'events', label: t('member.events'), value: autonomy.inbox === undefined ? undefined : String(counts.inboxPending === undefined ? t('member.notProvided') : counts.inboxPending), t }),
      React.createElement(tbMemberLine, { key: 'source', label: t('member.source'), value: autonomy.found === true ? autonomy.source : undefined, t }),
      autonomy.missing.length === 0 ? null : React.createElement('div', { key: 'missing', className: 'tb-member-missing' },
        t('member.missing') + autonomy.missing.join(' / ')),
      React.createElement(tbMemberActions, {
        key: 'actions',
        autonomy,
        paused,
        t,
        onStopTurn: () => runtime.stopTurn(sessionId),
        onPauseDispatch: () => runtime.pauseDispatch(sessionId),
        onResumeDispatch: () => runtime.resumeDispatch(sessionId),
        onCancelWork: () => runtime.cancelWork(sessionId),
        onStopTeam: () => runtime.stopTeam()
      }),
      React.createElement(tbInstructionBox, {
        key: 'instr',
        sessionId,
        memberLabel,
        runtime,
        t
      })
    ]),
    instructionAck === undefined || instructionAck === null || expanded === true
      ? null
      : React.createElement('div', { key: 'ack-collapsed', className: 'tb-instruction-ack' },
        tbFormat(t, 'instr.sent', { member: memberLabel ?? sessionId }))
  ]);
}
