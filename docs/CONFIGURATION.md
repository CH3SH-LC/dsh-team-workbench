# Configuration

[README](../README.en.md) · [Bundle patch](../cordis.patch.yml) · [Normalized defaults](../src/host/config.js)

The bundle contributes a `team-workbench` row and overrides the native `subagent` row. DSH's profile layering determines the final configuration. A later row patch replaces the row's complete `config` object; it is not a nested deep merge. Preserve any settings you still need when creating a profile override. See the [official configuration layering explanation](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish).

Do not edit an installed package merely to keep personal settings. Use the current DSH configuration mechanism for the intended profile and inspect its composed result.

## Native dependency and shared capacity

Enable the official experimental Agent Team in the active profile. This plugin does not replace that bundle or enable every disabled ordinary subagent tool.

The shipped patch deliberately sets:

```yaml
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
  config:
    maxDepth: 2
    maxActiveSubagents: 40
```

The depth permits a member under the leader and a leaf under that member. The active limit applies to the native continuable service shared by the profile. It affects other consumers of that service. Review other bundle and profile overrides before relying on these values.

## Workbench capacity

| Setting under `capacity` | Default | Meaning |
| --- | ---: | --- |
| `hostActivationLimit` | 40 | Native activation budget assumed by workbench accounting; align with the actual native service. |
| `globalLeafLimit` | 30 | Global leaf execution budget. |
| `recoveryReserve` | 3 | Capacity reserved for recovery/control. |
| `interactiveReserve` | 2 | Capacity kept outside the team's usable resident budget. |
| `perMemberLeaves` | 6 | Baseline member fair share; idle capacity may be borrowed. Mission/work budgets and other constraints also apply. |
| `perMemberAttempts` | 24 | Member attempt budget setting. |
| `teamsMaxConcurrent` | 3 | Team fairness/capacity setting; not a guarantee that three arbitrarily sized teams fit. |
| `providerRequestLimit` | `null` | Optional admission bound; `null` supplies no configured provider bound. |

The resident budget is `hostActivationLimit - recoveryReserve - interactiveReserve`, or 35 by default. Five resident members plus 30 leaves already consume those 35 slots. Waiting parents and other native activations matter; counting only running leaf prompts underestimates capacity.

These settings do not discover or raise provider quotas, requests per minute, token limits, CPU capacity, or memory. Start below your actual resource limits and inspect native rejection diagnostics. `perMemberLeaves` is not a universal hard maximum: the current fairness policy can lend unused slots. Use narrower mission and work budgets where needed.

## Scheduler and policy

| Setting | Default | Purpose |
| --- | --- | --- |
| `scheduler.wakeCoalesceMs` | 40 | Coalesce nearby event wakeups. |
| `scheduler.maxStartsPerTick` | 8 | Bound starts in one scheduler pass; not a whole-batch completion barrier. |
| `scheduler.capacityCooldownMs` | 1500 | Back off after a native capacity rejection. |
| `scheduler.agingPerMinute` | 1.5 | Scheduling preference setting. |
| `policy.splitBy` | `independent-deliverable` | Split by complete outputs. |
| `policy.phaseRelay` | `reject` | Reject detected stage-relay plans. |
| `policy.requireArtifactVersion` | `true` | Require dependency versions. |
| `policy.completionGate` | `acceptance-satisfied` | Evidence-aware completion policy. |

Semantic checks help detect unsuitable splits; they do not prove that every plan is sensible. The model and owner remain responsible for the boundaries and acceptance criteria.

## Execution, artifacts, and evidence

- `execution.roots`: allowed directories for check working directories and tracked artifacts. An empty configuration falls back to the Host working directory in the execution runner; configure explicit project roots for reliable deployment.
- `execution.maxTimeoutMs`: 600000 by default.
- `execution.maxOutputBytes`: 262144 by default.
- `execution.allowedCommands`: empty by default; optional lead-level additional commands. Member work should declare exact commands in its plan's `verificationCommands`.
- `materialize.roots`: roots for mechanical file operations; configure only the locations the project needs.
- `materialize.maxBytes`: 268435456 by default.
- `evidence.requireForAccept`, `requireVerification`, `requireAcceptanceMapping`, `requireStrongForAccept`: all default to `true`.

`team_exec_check` runs an executable and argument array in the Host. `shell: false` avoids implicit shell parsing; it does not make an arbitrary executable or script safe. Review the commands you authorize and the roots they operate on. A root check is not an operating-system sandbox around the launched process.

File copying and hashing do not establish that an artifact is correct. Execution success also needs an appropriate check and coverage of the declared acceptance criteria. Do not weaken evidence requirements just to make an unverified task appear accepted.

## Usage and pricing

`usage.enabled` defaults to `true`. Native usage collection can backfill historical sessions: `historicalBackfill: true`, batch size 10, up to 200 sessions and 20000 events per session. Optional external JSONL ingestion uses `usage.sourcePath`; it is `null` by default. The ingestion interval defaults to 60000 ms with an 8 MiB per-ingest bound.

Set `historicalBackfill: false` if only ongoing collection is wanted. Inspect the actual coverage reported by the collector rather than assuming every native session has usable token data.

There are no public default provider prices. A price book has a version, currency, source, and entries that identify provider, model, effective dates, and per-million input/output/cache rates. Configure rates from your own current provider agreement. Missing prices or missing applicable cache rates must remain unknown for affected requests.

An intentionally unpriced configuration is:

```yaml
usage:
  enabled: true
  historicalBackfill: false
  priceBook:
    version: unpriced
    entries: []
```

This is a fragment inside the workbench row, not a complete replacement for all personal settings. Costs remain estimates; mixed currencies must not be treated as one summed bill.

## Optional integration and compatibility

| Setting | Default | Notes |
| --- | --- | --- |
| `context.mode` | `inject` | Compact managed-team context; alternatives are `stats-only` and `off`. |
| `context.maxChars` / `maxItems` | 1200 / 5 | Bound the injected compact state. |
| `context.guardNativeTools` | `true` | Guard relevant native tool operations in managed-team scope. |
| `skills.roleSections` | `true` | Register leader/member/leaf role guidance; no external skill package is required. |
| `compat.rightBarFocusBridge` | `true` | Focus compatibility integration. |
| `compat.rightBarFocusBridgeMinVersion` | `0.2.0-rc.2` | Interface baseline, not a promise that every later version is compatible. |
| `remediation.skillsMigrate` | `false` | External skill migration is opt-in. |
| `remediation.skillsUpgradeEntry` | `null` | Explicit external integration entry as an absolute path or file URL; required when migration is enabled. |
| `remediation.skillsSourceRoot` | `null` | External skill package source directory; also required when migration is enabled. |
| `remediation.skillsPatchPath` | `null` | Optional explicit patch path; the integration otherwise uses `cordis.patch.yml` under the source root. |
| `remediation.routeMode` | `legacy` | Internal upgrade routing selection; leave unchanged unless maintaining an integration. |

The public repository does not include the external skill package. Leave `skillsMigrate` disabled for standalone use. To opt in, provide both the explicit absolute `skillsUpgradeEntry` (or file URL) and `skillsSourceRoot`; setting only an entry is insufficient. Patch path, target version, and expected count are optional integration settings. Integration maintainers must validate the external package and paths rather than guessing a private installation location.

## Persistence and diagnostics

Native `storageDomain` is preferred. The fallback data directory is resolved from `DSH_TEAM_WORKBENCH_DIR`, otherwise from `DSH_HOME` or the user's DSH home with a `team-workbench` subdirectory. Additional remediation data can use `remediation.sidecarDir`.

`singleWriter` defaults to `true`. Two Hosts must not independently write the same data directory. When using parallel DSH instances or profiles, choose distinct data roots or follow the supported single-writer arrangement. Back up persistent records before changing roots or performing recovery work; uninstalling code is not a data migration.

The web base path defaults to `/plugin/team-workbench`. Health, state, and paginated detail routes reveal operational metadata and should remain within the intended DSH access boundary. They are diagnostic interfaces, not a public service to expose independently.
