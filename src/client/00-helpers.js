/* @local/dsh-team-workbench — client helpers, theme-token style sheet, tiny store engine.
 *
 * Plain script fragment: tools/build-client.mjs concatenates src/compat/*.js then
 * src/client/*.js (filename ascending) inside one module factory. No import/export,
 * no require except 'react'. Every identifier carries the `tb` prefix to avoid
 * collisions with sibling fragments.
 *
 * Colors come exclusively from real `--dsw-*` custom properties. AUTHORITATIVE SOURCE: the
 * shell's own shipped stylesheet
 *   investigation/installed/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.css
 * (95 distinct `--dsw-*` properties; see docs/contracts/client-api.md §7.6).
 * DO NOT use `Theme.listTokens` as the token universe: it returns only the names that need
 * light/dark overrides (14 of them), i.e. a PARTIAL set — treating it as complete once led us
 * to "fix" five perfectly real tokens (border-l3, label-tertiary, interactive-bg-hover,
 * button-primary-fill, state-warn-label) that the shipped CSS defines 40x/14x/3x/2x/3x.
 * The only genuinely non-existent token we referenced was the "inverted primary label",
 * corrected to `--dsw-alias-label-primary-foreground` ("text on a filled primary surface").
 * Geometry uses literal px. `tools/build-client.mjs` FAILS the build if the artifact mentions a
 * `--dsw-*` token outside the shipped set: an unresolved `var()` is invalid at computed-value
 * time, so `border-color` falls back to currentColor and `color` inherits.
 */

const tbPluginId = '@local/dsh-team-workbench';
const tbPanelId = 'team-workbench';
const tbPaneSlotKey = 'teamWorkbench.pane';
const tbLocaleNs = 'teamWorkbench';
const tbStyleTagId = tbPluginId + '/workbench.css';

/** Workbench style sheet. Only shipped `--dsw-*` tokens (see the header for the source).
 *  Token choices:
 *   - `border-l3` for the finest separators (`border-l2` is a STRONGER outline and is kept for
 *     control/overlay outlines only: tag pill, picker overlay, input field);
 *   - `label-primary` for titles/body, `label-tertiary` for dimmed meta text;
 *   - `interactive-bg-hover` for hover surfaces, `bg-layer-2` for the raised picker overlay;
 *   - `button-primary-fill` as the pressed-control fill with `label-primary-foreground` as its
 *     ink (text on a filled primary surface), `brand-primary` for accents (active cell border).
 *
 *  SURFACE v2 typography/spacing contract (user requirement 「清除太多小字」):
 *   - a pane head is ONE 12px block line (13px title); there is no second/third meta line and
 *     no footer — diagnostics live in `runtime.diagnostics`, not on screen;
 *   - the member second-level block is one 12px line + 「详情」; the lists/actions it hides are
 *     12px with no pill row;
 *   - removed on purpose: the team tree, the host/focus-bridge status bar, the picker scope
 *     paragraph, per-row role pills/sub-lines, the member chip row;
 *   - 8px block padding, 1px `--dsw-alias-border-l3` separators between header/content;
 *   - list rows 4px apart. */
const tbCss = [
  // `position:relative` makes this panel the containing block for the picker overlay and its
  // backdrop: otherwise `position:absolute` would resolve against the viewport (or whatever
  // ancestor happens to be positioned) and the menu could open far away from the pane.
  '.tb-root{display:flex;height:100%;min-height:0;position:relative;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}',
  '.tb-main{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}',
  '.tb-bar{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);flex:none}',
  '.tb-bar-title{font-size:13px;font-weight:500;margin-right:4px}',
  '.tb-btn{border:none;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:6px;padding:4px 10px;font-size:12px;line-height:18px}',
  '.tb-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.tb-btn[aria-pressed=true]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
  '.tb-btn:disabled{opacity:.45;cursor:default}',
  '.tb-btn-quiet{padding:2px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.tb-tag{font-size:12px;line-height:18px;border-radius:999px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
  '.tb-grid{flex:1 1 auto;min-height:0;display:grid;gap:8px;padding:8px;background:var(--dsw-alias-bg-base)}',
  '.tb-cell{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:10px;overflow:hidden;position:relative}',
  '.tb-cell[data-active=true]{border-color:var(--dsw-alias-brand-primary)}',
  // **必须有这条规则**：`tbPaneBody` 的外层 div 用的就是这个类名。
  // 缺了它 → 该 div 是普通 block（高度 = 内容高度），于是下面的 `.tb-cell-body{flex:1 1 auto;min-height:0}`
  // **完全不生效**（父级不是 flex 容器）→ 会话内容撑高后被 `.tb-cell{overflow:hidden}` **裁掉**，
  // 表现为：滚轮完全没用（没有可滚动的元素）、输入框/审批框/回答框都在裁掉的区域里看不见。
  '.tb-cell-inner{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0}',
  '.tb-cell-body{flex:1 1 auto;min-height:0;min-width:0;position:relative;overflow:hidden;display:flex;flex-direction:column}',
  '.tb-pane-head{flex:none;display:block;padding:8px 10px}',
  '.tb-pane-row{display:block;line-height:18px}',
  // Storage-health row: its own block line, warn/critical colored with alias tokens only.
  '.tb-storage-row{display:flex;flex-wrap:wrap;gap:8px;font-size:12px;line-height:18px;margin-top:4px}',
  '.tb-storage-warn{color:var(--dsw-alias-state-warn-label)}',
  '.tb-storage-critical{color:var(--dsw-alias-state-error-primary)}',
  '.tb-pane-row-title{display:flex;align-items:center;gap:6px;line-height:18px}',
  '.tb-pane-title{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}',
  '.tb-sep{border-top:1px solid var(--dsw-alias-border-l3)}',
  // 官方会话根是官方自己的类名，这里只保证**第一个顶层节点**吃掉剩余高度。
  // 用 `:first-child` 而不是 `> *`：工厂若返回 Fragment（例如 [会话壳, 输入区] 两个顶层节点），
  // 全部拉伸会把输入框也拉成半屏；只拉伸第一个才既让会话壳拿到确定高度、又不动输入区的自然高度。
  '.tb-cell-body > *:first-child{flex:1 1 auto;min-height:0;min-width:0}',
  '.tb-cell-empty{color:var(--dsw-alias-label-secondary);padding:16px 12px;font-size:12px;line-height:20px}',
  '.tb-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;padding:8px 10px}',
  '.tb-notice{display:block;padding:6px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label);border-bottom:1px solid var(--dsw-alias-border-l3)}',
  '.tb-dot{width:7px;height:7px;border-radius:999px;flex:none;background:var(--dsw-alias-label-tertiary)}',
  '.tb-dot-run{background:var(--dsw-alias-state-success-primary)}',
  '.tb-dot-wait{background:var(--dsw-alias-state-warn-primary)}',
  '.tb-dot-bad{background:var(--dsw-alias-state-error-primary)}',
  // ---- second-level 「子会话」menu (surface v2: the ONLY place a member/subagent is listed) ----
  '.tb-child-menu{position:absolute;z-index:15;left:8px;right:8px;top:40px;max-height:calc(100% - 48px);overflow:auto;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:6px}',
  '.tb-child-menu-head{display:flex;align-items:center;gap:6px;padding:0 2px 4px;font-size:13px;font-weight:500}',
  '.tb-child-menu-head > span:first-child{flex:1 1 auto}',
  '.tb-child-row{display:flex;align-items:center;gap:8px}',
  '.tb-child-kind{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  // ---- session picker: a miniature of the shell's own session list (surface v2) ----
  // The backdrop makes "click outside closes" work without any document-level listener.
  '.tb-picker-backdrop{position:absolute;inset:0;z-index:19;background:transparent}',
  '.tb-picker{position:absolute;z-index:20;right:8px;top:8px;width:min(360px,calc(100% - 16px));max-height:calc(100% - 16px);overflow:auto;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px}',
  '.tb-picker-head{display:block;padding:2px 4px 8px;font-size:13px;font-weight:500}',
  '.tb-picker input{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);padding:6px 8px;font-size:12px;line-height:18px;outline:none;margin-bottom:4px}',
  '.tb-ws-groups{display:block}',
  '.tb-ws-group{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:none;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:6px 8px;border-radius:8px;font-size:12px;line-height:18px}',
  '.tb-ws-group:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.tb-ws-chevron{flex:none;width:12px;text-align:center;font-size:10px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.tb-ws-folder{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary)}',
  '.tb-ws-name{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.tb-ws-session{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:none;background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;padding:7px 10px 7px 32px;border-radius:8px;font-size:13px;line-height:18px}',
  '.tb-ws-session:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.tb-ws-session[data-current=true]{background:var(--dsw-alias-interactive-bg-hover)}',
  '.tb-ws-title{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.tb-ws-time{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.tb-ws-release{display:block;width:100%;margin-top:6px;padding:7px 10px 2px;border:none;border-top:1px solid var(--dsw-alias-border-l3);background:0 0;color:var(--dsw-alias-label-tertiary);text-align:left;font-size:12px;line-height:18px;cursor:pointer}',
  '.tb-ws-release:hover{color:var(--dsw-alias-label-primary)}',
  // ---- child (second-level) menu rows: still the compact `.tb-row` shape ----
  '.tb-row{display:block;width:100%;text-align:left;border:none;background:0 0;color:inherit;cursor:pointer;border-radius:8px;padding:8px 10px;margin-top:4px}',
  '.tb-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.tb-row-title{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px}',
  '.tb-row-name{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.tb-note{display:block;padding:4px 2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  // ---- member second-level view: ONE summary line + on-demand details ----
  '.tb-member{flex:none;display:block;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base)}',
  '.tb-member-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.tb-member-title{flex:1 1 auto;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.tb-member-line{display:block;margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}',
  '.tb-member-value{color:var(--dsw-alias-label-primary)}',
  '.tb-member-warn{color:var(--dsw-alias-state-warn-label)}',
  '.tb-member-missing{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.tb-member-body{display:block;margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l3)}',
  '.tb-member-sub{display:block;margin-top:6px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
  '.tb-member-list{display:block}',
  '.tb-member-item{display:block;margin-top:4px;padding-left:8px;border-left:1px solid var(--dsw-alias-border-l3)}',
  '.tb-member-item-title{font-size:12px;line-height:18px}',
  '.tb-member-tagrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px}',
  '.tb-member-item-note{display:block;margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.tb-member-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}',
  // Local pager for the cost/results lists (prev · page/total · next). 12px, one line.
  '.tb-pager{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}',
  // Cost / real-results block inside the member detail (12px lines; never a competing panel).
  '.tb-cost{display:block}',
  '.tb-deliverable{border-left-color:var(--dsw-alias-brand-primary)}',
  '.tb-intent{border-left-color:var(--dsw-alias-state-idle-primary)}',
  '.tb-receipt{border-left-color:var(--dsw-alias-state-success-primary)}',
  '.tb-pause-badge{font-size:12px;line-height:18px;border-radius:999px;padding:0 7px;border:1px solid var(--dsw-alias-state-warn-label);color:var(--dsw-alias-state-warn-label)}',
  '.tb-instruction{display:block;margin-top:8px}',
  '.tb-instruction-label{display:block;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.tb-instruction-row{display:flex;align-items:center;gap:6px;margin-top:4px}',
  '.tb-instruction-input{flex:1 1 auto;min-width:0;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);padding:4px 8px;font-size:12px;line-height:18px;outline:none}',
  '.tb-instruction-send{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:none;border-radius:6px;padding:4px 10px;font-size:12px;line-height:18px;cursor:pointer}',
  '.tb-instruction-ack{display:block;margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}',
  '.tb-instruction-ack-failed{color:var(--dsw-alias-state-error-primary)}'
].join('\n');

/** Idempotent style tag injection (HMR/reload safe; one tag per plugin id). */
function tbInjectStyle() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tbStyleTagId) + ']') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = tbPluginId;
  tag.dataset.pluginCss = tbStyleTagId;
  tag.textContent = tbCss;
  document.head.appendChild(tag);
}

/** Small dependency-free helpers used across the fragments. */
const tbHelpers = {
  clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  },
  /** Basename of a workspace path; separator-only or empty paths echo the raw value. */
  baseName(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return '';
    const parts = cwd.split(/[\\/]+/).filter((part) => part !== '');
    return parts.length === 0 ? cwd : parts[parts.length - 1];
  },
  /**
   * Compact relative time, matching the shell's own session list ("刚刚" / "5分钟" / "2天"
   * without the "前" suffix). Units and wording come from the locale (`picker.time.*`), never
   * from literals here. Used by the picker's right-aligned timestamp.
   */
  compactAgo(at, now, t) {
    const tr = typeof t === 'function' ? t : (key) => key;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '';
    const delta = Math.max(0, now - at);
    const sec = Math.round(delta / 1000);
    if (sec < 60) return tr('picker.time.now');
    const min = Math.round(sec / 60);
    if (min < 60) return tbFormat(tr, 'picker.time.minutes', { n: min });
    const hour = Math.round(min / 60);
    if (hour < 24) return tbFormat(tr, 'picker.time.hours', { n: hour });
    const day = Math.round(hour / 24);
    if (day < 30) return tbFormat(tr, 'picker.time.days', { n: day });
    const month = Math.round(day / 30);
    if (month < 12) return tbFormat(tr, 'picker.time.months', { n: month });
    return tbFormat(tr, 'picker.time.years', { n: Math.round(month / 12) });
  },
  /**
   * Relative "3m ago" wording; deterministic for a given now. B3: all units come from the
   * locale namespace (`t` is the slot seat), never from literals in this file.
   */
  ago(at, now, t) {
    const tr = typeof t === 'function' ? t : (key) => key;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return tr('time.none');
    const delta = Math.max(0, now - at);
    const sec = Math.round(delta / 1000);
    if (sec < 5) return tr('time.justNow');
    if (sec < 60) return tbFormat(tr, 'time.secondsAgo', { n: sec });
    const min = Math.round(sec / 60);
    if (min < 60) return tbFormat(tr, 'time.minutesAgo', { n: min });
    const hour = Math.round(min / 60);
    if (hour < 24) return tbFormat(tr, 'time.hoursAgo', { n: hour });
    return tbFormat(tr, 'time.daysAgo', { n: Math.round(hour / 24) });
  },
  /** Readable failure text; never throws on exotic values. */
  errorText(error) {
    if (error === undefined || error === null) return 'unknown';
    if (typeof error === 'string') return error;
    if (typeof error.message === 'string' && error.message !== '') return error.message;
    try {
      return JSON.stringify(error);
    } catch (_unserializable) {
      return String(error);
    }
  },
  /** Deep structural clone (JSON-safe state only; the store keeps plain JSON). */
  clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }
};

/**
 * Minimal observable: `getSnapshot` returns a stable reference until `set`/`update`,
 * `subscribe` returns its own disposer. Shaped for `React.useSyncExternalStore`.
 */
function tbCreateObservable(initial) {
  let snapshot = initial;
  const listeners = new Set();
  function emit() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[team-workbench] observable subscriber failed:', error);
      }
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      snapshot = next;
      emit();
    },
    update(mutator) {
      const draft = tbHelpers.clone(snapshot);
      mutator(draft);
      snapshot = draft;
      emit();
    },
    listenerCount: () => listeners.size
  };
}

/**
 * Store engine for the slot `store` seat (StoreSpec: `{ spec, create(scopeKey) }`).
 *
 * The official engine lives in `@deepseek-ai/dsh-client-store`; importing a
 * `@deepseek-ai/dsh-client-*` package is forbidden for this bundle, so this
 * fragment reimplements the contract ui-renderer actually consumes:
 *   - `handle.spec.init()` seeds fresh state per instance,
 *   - `handle.spec.persist` (string) rehydrates from and writes to localStorage,
 *   - `handle.create(scopeKey)` returns `{ actions, getSnapshot, subscribe, store, clearPersisted }`.
 * Root-scoped seats call `create()`; session-scoped seats call `create(sessionId)`
 * with the persist key suffixed exactly like the official engine.
 */
function tbCreateStoreHandle(declaration) {
  return {
    spec: declaration,
    create(scopeKey) {
      const persistName = declaration.persist === undefined
        ? undefined
        : scopeKey === undefined
          ? declaration.persist
          : declaration.persist + '.' + scopeKey;
      let state = declaration.init();
      if (persistName !== undefined && typeof localStorage !== 'undefined') {
        try {
          const raw = localStorage.getItem(persistName);
          if (raw !== null) {
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              // B6: an EXACT schema match is required. A record without `v` (older build) is
              // not "compatible by default" — merging it produced panes with unknown roles
              // and `pane.role.undefined` tooltips — so it is discarded.
              if (parsed.v === state.v) {
                state = { ...state, ...parsed };
              } else {
                console.warn('[team-workbench] store "' + persistName + '": persisted schema v' + String(parsed.v) + ' does not match v' + state.v + '; using defaults');
              }
            }
          }
        } catch (error) {
          console.error('[team-workbench] store "' + persistName + '" rehydration failed:', error);
        }
      }
      // B6: even a v2 record can carry foreign/partial values (hand-edited localStorage, a
      // downgrade, a future field), so the declaration may normalize the state in place.
      if (typeof declaration.normalize === 'function') {
        try {
          const normalized = declaration.normalize(state);
          if (normalized !== undefined && normalized !== null) state = normalized;
        } catch (error) {
          console.error('[team-workbench] store "' + persistName + '" normalization failed:', error);
        }
      }
      const listeners = new Set();
      let snapshot = state;
      const store = {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        update(mutator) {
          const draft = tbHelpers.clone(snapshot);
          mutator(draft);
          snapshot = draft;
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch (error) {
              console.error('[team-workbench] store subscriber failed:', error);
            }
          }
        },
        set(next) {
          snapshot = next;
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch (error) {
              console.error('[team-workbench] store subscriber failed:', error);
            }
          }
        }
      };
      if (persistName !== undefined && typeof localStorage !== 'undefined') {
        listeners.add(() => {
          try {
            localStorage.setItem(persistName, JSON.stringify(snapshot));
          } catch (error) {
            console.error('[team-workbench] store "' + persistName + '" persistence failed:', error);
          }
        });
      }
      const actions = {};
      for (const name of Object.keys(declaration.actions)) {
        const mutate = declaration.actions[name];
        actions[name] = function () {
          const params = arguments;
          store.update((draft) => {
            mutate.apply(null, [draft].concat(Array.prototype.slice.call(params)));
          });
        };
      }
      return {
        actions,
        getSnapshot: store.getSnapshot,
        subscribe: store.subscribe,
        store,
        clearPersisted() {
          if (persistName === undefined || typeof localStorage === 'undefined') return;
          try {
            localStorage.removeItem(persistName);
          } catch (_quota) {
            /* clearing is best-effort */
          }
        }
      };
    }
  };
}
