/**
 * Row-config normalisation.
 *
 * The plugin deliberately does not declare a `Config` schema (see README) so it
 * never has to import a schema library. `apply(ctx, config)` therefore receives
 * the raw loader-merged object and this module makes it total and immutable.
 */
import { clampInt, toStringArray } from './util.js';

/** Documented defaults. Every value can be overridden from `cordis.patch.yml`. */
export const CONFIG_DEFAULTS = Object.freeze({
  singleWriter: true,
  capacity: Object.freeze({
    hostActivationLimit: 40,
    globalLeafLimit: 30,
    recoveryReserve: 3,
    interactiveReserve: 2,
    perMemberLeaves: 6,
    perMemberAttempts: 24,
    teamsMaxConcurrent: 3,
    providerRequestLimit: null,
  }),
  scheduler: Object.freeze({
    agingPerMinute: 1.5,
    maxStartsPerTick: 8,
    wakeCoalesceMs: 40,
    /**
     * 原生 Continuable 池满（`ACTIVATION_LIMIT_REACHED` 等容量码）时，调度器退避多久
     * 再尝试预留。容量满属于「拒绝并保持 ready」，**不是**失败；但也不能在同一毫秒里
     * 反复打原生池。
     */
    capacityCooldownMs: 1500,
  }),
  policy: Object.freeze({
    splitBy: 'independent-deliverable',
    phaseRelay: 'reject',
    requireArtifactVersion: true,
    completionGate: 'acceptance-satisfied',
  }),
  /**
   * 2026-10-17 整改新增（契约 v1）。全部为**新增**配置段，旧段不动。
   *
   * - `identity`：稳定交付物身份（契约 §2）。`relayPolicy:'reject'` = 改标题/kind/subject
   *   不能开新流程，必须沿用原 workId 修订计划。
   * - `usage`：费用归账（契约 §1 `snapshot.usage`）。`sourcePath` 为空则不归账（保持 unknown）。
   * - `materialize`：机械复制/哈希的允许根（契约 §3）。
   * - `evidence`：证据式完成判定（契约 §3）。
   */
  identity: Object.freeze({
    relayPolicy: 'reject',
    overlapThreshold: 0.5,
    handoffInputCoverage: 0.5,
    exemptEvidencePackages: true,
  }),
  /** 整改接线（sidecar 根 / 路由模式 / 技能迁移）；默认值保持安全。 */
  remediation: Object.freeze({
    sidecarDir: null,
    routeMode: 'legacy',
    skillsMigrate: false,
    skillsUpgradeEntry: null,
    skillsSourceRoot: null,
    skillsPatchPath: null,
    skillsVersionTarget: null,
    skillsExpectedCount: null,
    installableEntry: null,
  }),
  usage: Object.freeze({
    enabled: true,
    sourcePath: null,
    ingestIntervalMs: 60000,
    maxBytesPerIngest: 8 * 1024 * 1024,
    /** 生产采集边界（正常 apply 配置可覆盖；旧实现把这些字段丢弃）。 */
    historicalBackfill: true,
    historicalBatchSize: 10,
    maxSessions: 200,
    maxEventsPerSession: 20000,
    /** 用户按自己的 provider/model/计费时段配置价格；未配置时费用保持 unknown。 */
    priceBook: Object.freeze({
      version: 'user-configured-v1',
      currency: 'CNY',
      source: null,
      entries: Object.freeze([]),
    }),
  }),
  materialize: Object.freeze({
    roots: Object.freeze([]),
    maxBytes: 256 * 1024 * 1024,
  }),
  /**
   * 可信执行（证据式完成判定的唯一来源）。命令由 Host 用 `spawn(argv, {shell:false})` 真实执行，
   * 记录 runId/exitCode/产物 sha256；`scope:'live'` 一律拒绝（不伪造实机证据）。
   */
  execution: Object.freeze({
    roots: Object.freeze([]),
    maxTimeoutMs: 10 * 60 * 1000,
    maxOutputBytes: 256 * 1024,
    /** lead 可用、但没有在 work.verificationCommands 里声明的命令白名单（默认空）。 */
    allowedCommands: Object.freeze([]),
  }),
  /**
   * 受管团队上下文控制（`agent/pre-step` 注入 + 原生工具守卫）。
   * 只覆盖受管团队；默认 inject，可降级为 stats-only/off。
   */
  context: Object.freeze({
    mode: 'inject',
    maxChars: 1200,
    maxItems: 5,
    guardNativeTools: true,
  }),
  evidence: Object.freeze({
    requireForAccept: true,
    requireVerification: true,
    requireAcceptanceMapping: true,
    requireStrongForAccept: true,
  }),
  compat: Object.freeze({
    rightBarFocusBridge: true,
    rightBarFocusBridgeMinVersion: '0.2.0-rc.2',
  }),
  skills: Object.freeze({
    providerName: 'team-workbench',
    enabled: true,
    roleSections: true,
  }),
  web: Object.freeze({
    basePath: '/plugin/team-workbench',
    maxBodyBytes: 262144,
  }),
  /** storageDomain 挂载晚于本行，等待它的有界宽限（毫秒）；0 表示不等待。 */
  storageGraceMs: 2500,
});

function pickObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nullableLimit(value) {
  if (value === null || value === undefined || value === 'auto' || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.trunc(number);
}

/**
 * @param {unknown} raw raw row config
 * @returns {typeof CONFIG_DEFAULTS & Record<string, unknown>} frozen effective config
 */
export function normalizeConfig(raw) {
  const input = pickObject(raw);
  const capacity = pickObject(input.capacity);
  const scheduler = pickObject(input.scheduler);
  const policy = pickObject(input.policy);
  const compat = pickObject(input.compat);
  const skills = pickObject(input.skills);
  const web = pickObject(input.web);
  // 2026-10-17 整改新增段（缺省用 CONFIG_DEFAULTS，不影响旧配置）。
  const identity = pickObject(input.identity);
  const usage = pickObject(input.usage);
  const remediation = pickObject(input.remediation);
  const materialize = pickObject(input.materialize);
  const execution = pickObject(input.execution);
  const context = pickObject(input.context);
  const evidence = pickObject(input.evidence);

  const hostActivationLimit = clampInt(capacity.hostActivationLimit, 2, 512, CONFIG_DEFAULTS.capacity.hostActivationLimit);
  const recoveryReserve = clampInt(capacity.recoveryReserve, 0, Math.max(0, hostActivationLimit - 1), CONFIG_DEFAULTS.capacity.recoveryReserve);
  const interactiveReserve = clampInt(capacity.interactiveReserve, 0, Math.max(0, hostActivationLimit - 1), CONFIG_DEFAULTS.capacity.interactiveReserve);
  const globalLeafLimit = clampInt(capacity.globalLeafLimit, 1, hostActivationLimit, CONFIG_DEFAULTS.capacity.globalLeafLimit);
  const perMemberLeaves = clampInt(capacity.perMemberLeaves, 1, globalLeafLimit, CONFIG_DEFAULTS.capacity.perMemberLeaves);

  const effective = {
    singleWriter: input.singleWriter !== false,
    capacity: {
      hostActivationLimit,
      globalLeafLimit,
      recoveryReserve,
      interactiveReserve,
      perMemberLeaves,
      perMemberAttempts: clampInt(capacity.perMemberAttempts, 1, 4096, CONFIG_DEFAULTS.capacity.perMemberAttempts),
      teamsMaxConcurrent: clampInt(capacity.teamsMaxConcurrent, 1, 64, CONFIG_DEFAULTS.capacity.teamsMaxConcurrent),
      providerRequestLimit: nullableLimit(capacity.providerRequestLimit),
      /**
       * Documented derivation, exposed so operators can see the arithmetic
       * instead of guessing a single "maxMembers" number:
       *   full expansion = members × leavesPerMember + recoveryReserve + interactiveReserve.
       */
      fullExpansionExample(leavesPerMember = perMemberLeaves, members = 5) {
        return members * leavesPerMember + recoveryReserve + interactiveReserve;
      },
    },
    scheduler: {
      agingPerMinute: Number.isFinite(Number(scheduler.agingPerMinute)) ? Math.max(0, Number(scheduler.agingPerMinute)) : CONFIG_DEFAULTS.scheduler.agingPerMinute,
      maxStartsPerTick: clampInt(scheduler.maxStartsPerTick, 1, 128, CONFIG_DEFAULTS.scheduler.maxStartsPerTick),
      wakeCoalesceMs: clampInt(scheduler.wakeCoalesceMs, 0, 5000, CONFIG_DEFAULTS.scheduler.wakeCoalesceMs),
      capacityCooldownMs: clampInt(scheduler.capacityCooldownMs, 0, 60000, CONFIG_DEFAULTS.scheduler.capacityCooldownMs),
    },
    policy: {
      splitBy: typeof policy.splitBy === 'string' && policy.splitBy ? policy.splitBy : CONFIG_DEFAULTS.policy.splitBy,
      phaseRelay: policy.phaseRelay === 'warn' ? 'warn' : 'reject',
      requireArtifactVersion: policy.requireArtifactVersion !== false,
      completionGate: typeof policy.completionGate === 'string' && policy.completionGate ? policy.completionGate : CONFIG_DEFAULTS.policy.completionGate,
    },
    compat: {
      rightBarFocusBridge: compat.rightBarFocusBridge !== false,
      rightBarFocusBridgeMinVersion:
        typeof compat.rightBarFocusBridgeMinVersion === 'string' && compat.rightBarFocusBridgeMinVersion
          ? compat.rightBarFocusBridgeMinVersion
          : CONFIG_DEFAULTS.compat.rightBarFocusBridgeMinVersion,
    },
    skills: {
      providerName: typeof skills.providerName === 'string' && skills.providerName ? skills.providerName : CONFIG_DEFAULTS.skills.providerName,
      enabled: skills.enabled !== false,
      roleSections: skills.roleSections !== false,
      roots: toStringArray(skills.roots),
    },
    web: {
      basePath: normalizeBasePath(web.basePath),
      maxBodyBytes: clampInt(web.maxBodyBytes, 1024, 4 * 1024 * 1024, CONFIG_DEFAULTS.web.maxBodyBytes),
    },
    // ---- 2026-10-17 整改新增（契约 v1）--------------------------------------
    identity: {
      relayPolicy: identity.relayPolicy === 'warn' ? 'warn' : 'reject',
      overlapThreshold: clampNumber(identity.overlapThreshold, 0, 1, CONFIG_DEFAULTS.identity.overlapThreshold),
      handoffInputCoverage: clampNumber(identity.handoffInputCoverage, 0, 1, CONFIG_DEFAULTS.identity.handoffInputCoverage),
      exemptEvidencePackages: identity.exemptEvidencePackages !== false,
    },
    remediation: {
      sidecarDir: typeof remediation.sidecarDir === 'string' && remediation.sidecarDir.trim() ? remediation.sidecarDir.trim() : null,
      routeMode: remediation.routeMode === 'versioned' ? 'versioned' : 'legacy',
      // External skill packages are optional and never loaded implicitly.
      skillsMigrate: remediation.skillsMigrate === true,
      skillsUpgradeEntry: typeof remediation.skillsUpgradeEntry === 'string' && remediation.skillsUpgradeEntry.trim() ? remediation.skillsUpgradeEntry.trim() : null,
      skillsSourceRoot: typeof remediation.skillsSourceRoot === 'string' && remediation.skillsSourceRoot.trim() ? remediation.skillsSourceRoot.trim() : null,
      skillsPatchPath: typeof remediation.skillsPatchPath === 'string' && remediation.skillsPatchPath.trim() ? remediation.skillsPatchPath.trim() : null,
      skillsVersionTarget: typeof remediation.skillsVersionTarget === 'string' && remediation.skillsVersionTarget.trim() ? remediation.skillsVersionTarget.trim() : null,
      skillsExpectedCount: Number.isInteger(remediation.skillsExpectedCount) && remediation.skillsExpectedCount >= 0 ? remediation.skillsExpectedCount : null,
      installableEntry: typeof remediation.installableEntry === 'string' && remediation.installableEntry.trim() ? remediation.installableEntry.trim() : null,
    },
    usage: {
      enabled: usage.enabled !== false,
      sourcePath: typeof usage.sourcePath === 'string' && usage.sourcePath.trim() ? usage.sourcePath.trim() : null,
      ingestIntervalMs: clampInt(usage.ingestIntervalMs, 5000, 3600000, CONFIG_DEFAULTS.usage.ingestIntervalMs),
      maxBytesPerIngest: clampInt(usage.maxBytesPerIngest, 64 * 1024, 64 * 1024 * 1024, CONFIG_DEFAULTS.usage.maxBytesPerIngest),
      priceBook: normalizePriceBookConfig(usage.priceBook ?? usage.pricing),
      // 生产采集边界必须能被正常 apply 配置控制（旧实现丢弃这些字段 → 无法限制/关闭历史采集）。
      historicalBackfill: usage.historicalBackfill !== false,
      historicalBatchSize: clampInt(usage.historicalBatchSize, 1, 100, CONFIG_DEFAULTS.usage.historicalBatchSize),
      maxSessions: clampInt(usage.maxSessions, 1, 5000, CONFIG_DEFAULTS.usage.maxSessions),
      maxEventsPerSession: clampInt(usage.maxEventsPerSession, 1, 1000000, CONFIG_DEFAULTS.usage.maxEventsPerSession),
    },
    materialize: {
      roots: toStringArray(materialize.roots),
      maxBytes: clampInt(materialize.maxBytes, 1024, 2 * 1024 * 1024 * 1024, CONFIG_DEFAULTS.materialize.maxBytes),
    },
    execution: {
      roots: toStringArray(execution.roots),
      maxTimeoutMs: clampInt(execution.maxTimeoutMs, 1000, 60 * 60 * 1000, CONFIG_DEFAULTS.execution.maxTimeoutMs),
      maxOutputBytes: clampInt(execution.maxOutputBytes, 4096, 16 * 1024 * 1024, CONFIG_DEFAULTS.execution.maxOutputBytes),
      allowedCommands: toStringArray(execution.allowedCommands).slice(0, 50),
    },
    context: {
      mode: ['inject', 'stats-only', 'off'].includes(context.mode) ? context.mode : CONFIG_DEFAULTS.context.mode,
      maxChars: clampInt(context.maxChars, 200, 8000, CONFIG_DEFAULTS.context.maxChars),
      maxItems: clampInt(context.maxItems, 1, 20, CONFIG_DEFAULTS.context.maxItems),
      guardNativeTools: context.guardNativeTools !== false,
    },
    evidence: {
      requireForAccept: evidence.requireForAccept !== false,
      requireVerification: evidence.requireVerification !== false,
      requireAcceptanceMapping: evidence.requireAcceptanceMapping !== false,
      requireStrongForAccept: evidence.requireStrongForAccept !== false,
    },
    storageGraceMs: clampInt(input.storageGraceMs, 0, 60000, CONFIG_DEFAULTS.storageGraceMs),
  };

  return deepFreeze(effective);
}

/** 浮点区间夹取（0..1 的阈值等）。 */
function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * 价目表规范化（契约 v1 §1 修订：**不默认货币、不默认 0 费率**）。
 *
 * 接受两种输入：
 * - 新式 `{version,currency,source,entries:[{provider,model,effectiveFrom,effectiveTo,...}]}`
 * - 旧式 `{inputPerMillion,outputPerMillion,cacheReadPerMillion}` → 视为 `provider='*',model='*'` 通配条目
 *
 * 关键：**没有配置就是空表**（费用 unknown），绝不填占位数字。
 */
function normalizePriceBookConfig(raw) {
  const source = pickObject(raw);
  const book = {
    version: typeof source.version === 'string' && source.version ? source.version : 'pricing-v1',
    currency: typeof source.currency === 'string' && source.currency ? source.currency : null,
    source: typeof source.source === 'string' && source.source ? source.source : (Object.keys(source).length > 0 ? 'config' : 'not-configured'),
    entries: [],
  };
  const entries = Array.isArray(source.entries) ? source.entries : [];
  for (const entry of entries) {
    const item = pickObject(entry);
    const inputPerMillion = Number(item.inputPerMillion);
    const outputPerMillion = Number(item.outputPerMillion);
    if (!Number.isFinite(inputPerMillion) || !Number.isFinite(outputPerMillion)) continue;
    book.entries.push({
      provider: typeof item.provider === 'string' && item.provider ? item.provider : '*',
      model: typeof item.model === 'string' && item.model ? item.model : '*',
      effectiveFrom: Number.isFinite(Date.parse(item.effectiveFrom)) ? Date.parse(item.effectiveFrom) : 0,
      effectiveTo: Number.isFinite(Date.parse(item.effectiveTo)) ? Date.parse(item.effectiveTo) : null,
      currency: typeof item.currency === 'string' && item.currency ? item.currency : book.currency,
      inputPerMillion,
      outputPerMillion,
      cacheReadPerMillion: Number.isFinite(Number(item.cacheReadPerMillion)) ? Number(item.cacheReadPerMillion) : 0,
      cacheWritePerMillion: Number.isFinite(Number(item.cacheWritePerMillion)) ? Number(item.cacheWritePerMillion) : null,
      // 谷时/时段生效范围与条目来源：审计原件可追溯（未配置时段 = 全时段生效）。
      effective: item.effective && typeof item.effective === 'object' ? { ...item.effective } : null,
      source: typeof item.source === 'string' && item.source ? item.source : book.source,
    });
  }
  if (book.entries.length === 0 && Number.isFinite(Number(source.inputPerMillion)) && Number.isFinite(Number(source.outputPerMillion))) {
    book.entries.push({
      provider: '*',
      model: '*',
      effectiveFrom: 0,
      effectiveTo: null,
      currency: book.currency,
      inputPerMillion: Number(source.inputPerMillion),
      outputPerMillion: Number(source.outputPerMillion),
      cacheReadPerMillion: Number.isFinite(Number(source.cacheReadPerMillion)) ? Number(source.cacheReadPerMillion) : 0,
    });
    book.source = 'config';
  }
  if (book.entries.length > 0 && !book.currency) book.currency = book.entries.find((entry) => entry.currency)?.currency ?? null;
  return book;
}

function normalizeBasePath(value) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : CONFIG_DEFAULTS.web.basePath;
  const withSlash = text.startsWith('/') ? text : `/${text}`;
  return withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
