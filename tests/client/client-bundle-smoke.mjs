/**
 * 客户端半边确定性验收 — 构建产物 `client.js`。
 *
 * 用 mini-React + 假 module loader + 假 Cordis client ctx 真跑 `apply(ctx)` 后递归渲染，
 * 断言（surface v2，docs/ARCHITECTURE.md）：
 * main/sidebar 注册形状、session 作用域子插槽、每 pane 一次 SessionProvider + retain、
 * 窗格/选择器只允许工作区主会话（成员 MEMBER_NOT_A_PANE、leaf LEAF_NOT_BINDABLE）、
 * 同会话去重只聚焦、4↔1 窗可见性释放、二级视图（openChild/closeChild + 子会话地址 retain）、
 * 历史成员窗格迁移、`conversation.content` 调用形状、窗头恰好一行（无状态栏/团队树/小字）、
 * 卸载显式 release、以及「只读 retain/list、从不 touch interrupt/prompt/stop」。
 *
 * 另含两条回归：
 *   1. `client.js` sha256 漂移检测（构建产物不是黑盒，baselinePolicy=strict）；
 *   2. rc.2 假 signal「abort 不释放」语义 —— 断言我们只能靠显式 `release()`。
 *
 * 本轮新增（工作台运行状态，`docs/ARCHITECTURE.md` §1）：
 * 成员二级视图的「费用 + 真实成果」只读投影 —— `snapshot.usage` / `findings` / `errorFingerprints`
 * 的渲染与本地分页、缺字段降级（「等待宿主数据」且不编造金额）、unknown/estimate/invalidated/stale
 * 显式标注，以及「驱动这些数据只发生 GET /state、sessions 只有只读成员」。
 *
 * **simulated = true**：这里渲染的是打桩的 mini-React，不是真实页面。
 * 真实页面证据在 docs/ACCEPTANCE.md（U01–U10 / W07 行）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runSuite, isMain, main } from '../helpers/suite.mjs';
import { runClientHarness } from '../helpers/mini-react.mjs';
import { WORKSPACE_ROOT, workspaceFileExists } from '../helpers/host-loader.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const join = path.join;

export const meta = {
  id: 'client-bundle-smoke',
  title: '客户端产物（surface v2）：主会话窗格、二级视图/迁移、会话去重、可见性释放、只读 retain、产物漂移与 abort 语义',
  acceptance: ['U01', 'U02', 'U04', 'U05', 'U07', 'W07'],
  requires: ['client'],
};

export async function run() {
  const relative = 'client.js';
  if (!workspaceFileExists(relative)) {
    return runSuite({
      ...meta,
      simulated: true,
      pending: true,
      pendingReason: `${relative} 尚未构建（先跑 node tools/build-client.mjs）`,
    }, null);
  }
  const clientPath = path.join(WORKSPACE_ROOT, relative);
  const fixture = JSON.parse(readFileSync(path.join(WORKSPACE_ROOT, 'tests/fixtures/client-artifact.json'), 'utf8'));

  return runSuite({ ...meta, simulated: true }, async (suite) => {
    // ---- 产物漂移检测 -----------------------------------------------------
    // `baselinePolicy: 'track'` 是**显式、有期限**的豁免：批次 B 期间 client.js 是移动目标，
    // 漂移只记录不判 FAIL（也**不**更新基线）。B 组收尾后改回 'strict' 并统一收口。
    const bytes = readFileSync(clientPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex').toUpperCase();
    const matches = sha256 === String(fixture.sha256).toUpperCase();
    const bytesMatch = bytes.byteLength === fixture.bytes;
    const tracked = fixture.baselinePolicy === 'track';
    suite.assert(
      matches || tracked,
      `client.js 与基线产物一致（sha256=${sha256}, ${bytes.byteLength} bytes）；不一致请跑 node tools/build-client.mjs 重建后更新 tests/fixtures/client-artifact.json`,
      matches ? undefined : { expected: fixture.sha256, actual: sha256, expectedBytes: fixture.bytes, actualBytes: bytes.byteLength, rebuild: fixture.rebuildHint, baselinePolicy: fixture.baselinePolicy },
    );
    suite.assert(
      bytesMatch || tracked,
      'client.js 字节数与基线一致',
      bytesMatch ? undefined : { expected: fixture.bytes, actual: bytes.byteLength, rebuild: fixture.rebuildHint, baselinePolicy: fixture.baselinePolicy },
    );
    suite.assert(
      ['strict', 'track'].includes(fixture.baselinePolicy ?? 'strict'),
      'baselinePolicy 只能是 strict 或 track（不允许其他形式的静默放宽）',
      fixture.baselinePolicy,
    );
    if (tracked) {
      suite.note(
        `产物漂移被显式豁免（baselinePolicy=track，批次 B 进行中）：基线 ${fixture.bytes}B/${String(fixture.sha256).slice(0, 12)}… ↔ 当前 ${bytes.byteLength}B/${sha256.slice(0, 12)}…。原因：${fixture.baselinePolicyReason ?? ''}`,
      );
    }

    // ---- 主题 token 交叉检查（唯一的自动化"静默视觉失效"防线） --------------
    // 价值说明：CSS 里 `var(--x)` 引用一个**不存在的 token** 不会报错，只会
    // invalid at computed-value time → 分隔线回落到 currentColor（失去层次）、
    // `color: var(--label-tertiary)` 回落 inherit（元信息不变淡）。也就是
    // **"排版参数生效了，但颜色/分隔线根本没生效"**——人眼不细看发现不了，
    // 因此这是唯一能自动发现这类失效的手段。fixture 来源是运行时真实 token 集
    // （`cordis_inspect_query(platform="client", provider="Theme", method="listTokens")`），不是文档抄的。
    {
      const tokenFixture = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'theme-tokens.json'), 'utf8'));
      // 定义集 = CSS 定义集 ∪ 运行时已验证名单（个别 --dsw-specific-* 由运行时注入，不在静态 CSS 里）。
      // 教训（写进 deterministic.md 同款）：凡按"平台清单"校验命名，**先确认该清单的语义范围**：
      // 全集 / 子集 / 仅覆盖项。`Theme.listTokens` 是"需要浅/深色覆盖"的**子集**（14 个），
      // 拿它当全集会让 5 个真实 token（border-l3 / label-tertiary / interactive-bg-hover /
      // button-primary-fill / state-warn-label）被误判为缺失。
      const known = new Set([...tokenFixture.tokens, ...(tokenFixture.runtimeVerified?.tokens ?? [])]);
      // 误报处理：`--dsw-alias-` 这类**前缀片段**（来自字符串拼接）也会被正则匹配到，
      // 但它们不是 token 引用 → 排除以 `-` 结尾的片段，并要求 token 后跟 `)`/`,`/`;`/空白/引号。
      const TOKEN_REF = /--dsw-[a-z0-9-]+(?=[),;\s'"])/g;
      const files = [];
      const walk = (target) => {
        let stat;
        try {
          stat = statSync(target);
        } catch {
          return;
        }
        if (stat.isDirectory()) {
          for (const entry of readdirSync(target)) walk(join(target, entry));
          return;
        }
        if (/\.(js|mjs|css)$/.test(target)) files.push(target);
      };
      for (const root of [clientPath, join(here, '..', '..', 'src', 'client'), join(here, '..', '..', 'src', 'compat')]) walk(root);

      const referenced = new Set();
      const offenders = new Map();
      for (const file of files) {
        for (const match of readFileSync(file, 'utf8').matchAll(TOKEN_REF)) {
          const token = match[0];
          if (token.endsWith('-')) continue; // 前缀片段，不是引用
          referenced.add(token);
          if (!known.has(token)) {
            const list = offenders.get(token) ?? [];
            list.push(path.basename(file));
            offenders.set(token, list);
          }
        }
      }
      suite.assert(files.length > 0 && referenced.size > 0, 'theme tokens：确实扫到了引用（断言未空转）', { files: files.length, referenced: referenced.size });
      suite.assert(
        offenders.size === 0,
        `theme tokens：产物与源码引用的 --dsw-* 必须全部存在于运行时 token 集（缺失=${offenders.size}）`,
        offenders.size === 0 ? undefined : { missing: [...offenders.entries()].map(([token, where]) => `${token} @ ${[...new Set(where)].join(',')}`) },
      );
      suite.note(`theme tokens：扫描 ${files.length} 个文件、${referenced.size} 个不同 token 引用，缺失 ${offenders.size} 个（fixture 来源：${tokenFixture.source}）。`);
    }

    // ---- `className` 用到的 tb-* 类名必须有 CSS 规则（静态回归） -----------------
    // 价值：**缺一条 CSS 规则不会报错，只会静默裁掉 UI**。真实案例（用户实机 blocker）：
    // `30-components.js` 用了 `className:'tb-cell-inner'`，但 `00-helpers.js` 里**没有**
    // `.tb-cell-inner` 规则 → 该元素是普通 block（高度=内容高度）→ 其下
    // `.tb-cell-body{flex:1 1 auto;min-height:0}` 完全不生效（父级非 flex 容器）→
    // 会话内容把 `.tb-cell` 撑高、再被 `.tb-cell{overflow:hidden}` 裁掉 →
    // **滚轮失效、底部输入/审批/回答框被裁出可视区**。人眼不看发现不了，必须自动化。
    // 前缀处理：模板拼接会产生半截 token（`'tb-storage-' + level`、`'tb-dot-' + x`），
    // 因此**以 `-` 结尾的 token 一律视为前缀片段并跳过**。
    {
      const files = [];
      const walk = (target) => {
        let stat;
        try {
          stat = statSync(target);
        } catch {
          return;
        }
        if (stat.isDirectory()) {
          for (const entry of readdirSync(target)) walk(join(target, entry));
          return;
        }
        if (/\.(js|mjs|css)$/.test(target)) files.push(target);
      };
      for (const root of [clientPath, join(here, '..', '..', 'src', 'client'), join(here, '..', '..', 'src', 'compat')]) walk(root);

      const used = new Set();
      const defined = new Set();
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/tb-[a-z0-9-]+/g)) {
          const token = match[0];
          if (token.endsWith('-')) continue; // 模板拼接的前缀片段，不是完整类名
          used.add(token);
        }
        // CSS 规则选择器：`.tb-x{` / `.tb-x,` / `.tb-x ` / `.tb-x:` / `.tb-x.tb-y{`
        for (const match of text.matchAll(/\.(tb-[a-z0-9-]+)(?=[\s,{:>~+.[])/g)) defined.add(match[1]);
      }
      const missing = [...used].filter((token) => !defined.has(token)).sort();
      suite.assert(used.size > 0 && defined.size > 0, 'tb-* 类名静态回归：确实扫到了类名与规则（断言未空转）', { used: used.size, defined: defined.size });
      suite.assert(
        missing.length === 0,
        `tb-* 类名静态回归：className 用到的每个 tb-* 都必须有 CSS 规则（缺失=${missing.length}）`,
        missing.length === 0 ? undefined : { missing },
      );
      suite.note(`tb-* 类名静态回归：扫描 ${files.length} 个文件，用到 ${used.size} 个类名 / 定义 ${defined.size} 条规则，缺失 ${missing.length} 个。`);
    }

    // ---- 真跑产物 + 渲染 ------------------------------------------------
    const evidence = {};
    const result = await runClientHarness({
      clientPath,
      check: (name, ok, detail) => suite.check(name, ok, detail),
      onEvidence: (captured) => Object.assign(evidence, captured),
    });

    // ---- harness 自证：确实执行了产物并发生了渲染 -------------------------
    suite.assert(result?.registration !== undefined, 'harness 捕获到 __ModuleLoader__.load 注册');
    suite.compare(evidence.renderCount ?? 0, '>=', 1, 'mini-React 至少渲染了 1 轮（不是空跑）');
    suite.compare((evidence.retainedSources ?? []).length, '>=', 1, 'harness 观察到真实 retain 调用');
    suite.equal((evidence.internalFailures ?? []).length, 0, 'harness 内部无渲染/effect/cleanup 抛错');
    suite.note(`client.js sha256=${sha256} bytes=${bytes.byteLength}（基线 ${fixture.capturedAt}）`);
    suite.note(`renderCount=${evidence.renderCount} activePaneId=${evidence.activePaneId} released=${JSON.stringify(evidence.releasedIds)}`);
    suite.note(`会话范围（surface v2）：候选=${JSON.stringify(evidence.candidateIds)}；渲染到的候选行=${evidence.pickerRowCount}；leaf 绑定拒绝码=${evidence.leafBindCode}；成员窗格拒绝码=${evidence.memberPaneBindCode}`);
    suite.note('会话范围（surface v2）：窗格/选择器只列工作区主会话；团队成员返回 MEMBER_NOT_A_PANE，只能从所属会话的「子会话」经 runtime.openChild 进入；leaf 仍 LEAF_NOT_BINDABLE、也不作为任何 pane 的 target。');
    suite.note(`二级视图/迁移：childView=${JSON.stringify(evidence.childView)}；childRetains=${evidence.childRetains}；migratedMemberPanes=${evidence.migratedMemberPanes}（retainPane 在 view 存在时 retain 子会话地址；retainChild 对伪造子会话抛 CHILD_NOT_KNOWN）。`);

    // ---- 费用 + 真实成果（真实 host 契约：CONTRACT §7.1/§7.2 + §8.1–§8.4） ----
    // 断言只锚定**行为事实**：费用未知/已知/零费率/混币的呈现、明细来自宿主分页接口、
    // claimScope/verificationLevel/evidenceLevel/limitations/legacyOwnerClaim 分开呈现、
    // 缺字段降级、只读。具体文案/金额/产物路径/等级文本已在 mini-react 的同一族 check 里逐条断言。
    const cost = evidence.costFindings ?? {};
    suite.assert(cost.currencyKnownShown === true, '费用(R1)：真实 pricing.book（币种+费率）已知时显示金额并标「估算」');
    suite.assert(cost.currencyUnknownMarked === true, '费用(R1)：未配置价目/币种 → 费用 unknown（不默认 USD、不默认零费率）');
    suite.assert(cost.zeroRateKnown === true, '费用(R1)：显式 0 费率是已知免费（不是 unknown）');
    suite.assert(cost.mixedCurrencyMarked === true, '费用(R1)：混币不相加并标 mixedCurrency');
    suite.assert((cost.hostDetailCalls ?? 0) > 0, '明细(R2)：长列表走宿主分页接口（GET /state/detail），不是 /state 全量 + 前端本地分页', { hostDetailCalls: cost.hostDetailCalls });
    suite.assert(cost.claimScopeRendered === true && cost.verificationLevelRendered === true && cost.evidenceLevelRendered === true, '成果(R3)：claimScope / verificationLevel / evidenceLevel 分开呈现');
    suite.assert(cost.limitationsRendered === true && cost.legacyClaimRendered === true, '成果(R3)：limitations 与 legacyOwnerClaim 原样标注（不冒充实机/用户接受）');
    suite.assert(cost.versionRendered === true, '成果(v4)：产物版本逐条展示且缺版本显式「版本未提供」');
    suite.assert(cost.dependencyVersionsRendered === true, '成果(v4)：依赖版本 artifact@vN(requires) 逐条展示');
    suite.assert(cost.trustedExecutionRendered === true, '成果(v4)：可信执行 attempt/execution/exitCode/artifactSha256 逐条展示（不完整显式警告、不升级等级）');
    suite.assert(cost.usageViewsPaged === true, '费用(v4)：按阶段/工作项走宿主分页（kind=byPhase / kind=byWork），不本地切页');
    suite.assert(cost.unknownReasonsRendered === true, '费用(v4)：unknown 原因码原样显示（CURRENCY_UNKNOWN/PRICE_UNKNOWN，不默认 USD/0）');
    const refresh = evidence.refreshMechanism ?? {};
    suite.assert(refresh.timerArmed === true && refresh.projectionsOnly === true, '生产刷新：挂载后有界计时器且定时只走轻量投影（不拉全量 /state）', refresh);
    suite.assert(refresh.partialHandled === true, '生产刷新：部分成功按分区标陈旧（usage 失败不把旧费用标最新）且保留旧值', refresh);
    suite.assert(refresh.crossTypeStaleGuarded === true, '生产刷新：旧 /state 迟到不得覆盖较新 projection（跨类型版本保护）', refresh);
    suite.assert(refresh.eventOnlyFull === true, '生产刷新：全量 /state 事件驱动（无周期性 full、无未使用常量）', refresh);
    suite.assert(refresh.resumeOnMount === true && typeof refresh.lastSuccessAt === 'number', '生产刷新：卸载暂停/重挂恢复且成功时间可读', refresh);
    suite.assert(cost.previewOnlyFallback === true || cost.detailUnavailableFallback === true, '反向(R2)：无分页接口时显式降级（previewOnly / detailUnavailable）');
    suite.assert(cost.noLocalSlicing === true, '反向(R2)：绝不把 /state 全量数组当前端本地分页');
    suite.assert(
      JSON.stringify(cost.missingDataKeys) === JSON.stringify(['cost.waiting', 'findings.waiting', 'errors.waiting']),
      '缺字段：usage/findings/errorFingerprints 缺失时全部降级为「等待宿主数据」',
      cost.missingDataKeys,
    );
    suite.assert(cost.readOnlyOnly === true, '只读：驱动费用/成果数据期间 /state 与 /state/detail 全为 GET；POST 仅 usage-records/client-ack');
    const ack = evidence.activationAck ?? {};
    suite.assert(
      ack.bundleUrl === '/plugin-assets/team-workbench/client.js?rev=rev-load-1' && ack.bundleRev === 'rev-registered-1' && ack.revSource === 'modules.factories',
      '前端激活回执：bundle 身份来自官方 load-closure URL + 实际注册 factory rev（非 manifest 宣告值）',
      ack,
    );
    suite.assert(typeof ack.sourceDigest === 'string' && /^[0-9a-f]{64}$/.test(ack.sourceDigest), '前端激活回执：嵌入确定性 source digest（非 final hash 自引用）', ack.sourceDigest);
    suite.assert(ack.hostSchemaAligned === true && ack.hostReadBack === true, '前端激活回执：schema 与 Host recordFrontendAck 读取字段对齐且后端可持久读回', ack);
    suite.assert(ack.mountedAfterUnmount === false, '前端激活回执：卸载后不虚报 mounted', ack);
    suite.assert(ack.noAckWithoutMount === true, '前端激活回执：仅刷新未 mount 时不发回执（refresh 不伪造激活）', ack);
    suite.assert(ack.hmrKeptInstanceRev === true, '前端激活回执：HMR 仅广播新 rev 时旧 runtime 不自报新代码（实例元数据冻结）', ack);
    suite.assert(ack.noCurrentScriptHonest === true, '前端激活回执：无 currentScript 时诚实降级（url/rev 为 null，不猜 script 标签）', ack);
    suite.assert(Array.isArray(ack.renderedRegions) && ack.renderedRegions.length > 0, '前端激活回执：renderedRegions 来自真实渲染的 Host 投影', ack.renderedRegions);
    suite.note('费用/成果（真实契约）：`/state.usage` 只作汇总（`scopes.byOwner` 成员级、`scopes.team` 仅在 teamKey 匹配时显示，账户级汇总不在成员窗格显示）；金额仅在真实 `pricing.book`（币种+显式费率）时显示并标「（估算）」，未配置 → unknown（不默认 USD/0），显式 0 费率 = 已知免费，混币不相加。明细（已证成果/未完成/驳回/过期/重复错误/用量 byOwner）全部走 `GET /state/detail?section=findings|errors|usage&kind=…&page=…&pageSize=…`，客户端不本地切页；无该路由时只展示 `/state.findings.preview`（≤5）或显式降级，绝不渲染全量数组。每项成果单独呈现 claimScope / verificationLevel / evidenceLevel / ceiling / limitations，`legacyOwnerClaim` 明确标注为历史声明。');
    suite.note(`窗头清理：每窗恰好一行（● 标题 [子会话 N] [切换]）；二级视图为 [‹ 返回] ● 子标题；无 tb-status* / tb-team* / tb-node* / tb-pane-task / tb-pane-meta。`);
    suite.note('simulated=true：渲染的是打桩 mini-React + 假 slots/sessions，不是真实页面。真实页面证据见 docs/ACCEPTANCE.md。');
  });
}

if (isMain(import.meta.url)) await main(run, meta);
