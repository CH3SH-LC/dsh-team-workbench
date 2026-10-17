# Using Team Workbench

[中文首页](../README.md) · [English README](../README.en.md)

This guide describes the implemented interfaces. Run the [live acceptance checklist](ACCEPTANCE.md) in your DSH environment before relying on long unattended work.

## Open and arrange conversations

Install the bundle into the profile that runs your DSH application. Enable the native experimental Agent Team and a continuable subagent provider for team execution. Inspect plugin diagnostics if capabilities are missing.

Open **Team Workbench / 超级工作台** in the sidebar. Select 1, 2, or 4 panes and bind workspace main sessions. The same main session is not intended to occupy two editable panes. This avoids mounting multiple native composers for the same session.

Members and leaf subagents are navigated through the bound session's child-session menu. They are not direct entries in the main-session picker. Follow the session identity shown in the pane before sending or stopping a conversation.

Changing the number of panes changes visibility, not the team's concurrency budget. Hiding a pane or releasing a view is distinct from cancelling work. Approvals and the right sidebar depend on the focused session and DSH's native UI integration; verify them on the installed DSH version.

## Give members complete modules

Good splits are complete systems, objects, or evidence packages: a combat system and an inventory system, or independently usable enemy definitions. Each owner remains responsible for investigation, implementation, verification, and repair within its deliverable.

Do not split one deliverable into a researcher, an implementer, and a final repair agent. Cross-deliverable dependencies are allowed when they identify a concrete versioned interface or verified result.

For autonomous module work, the model should use this sequence:

| Actor | Tool | Result |
| --- | --- | --- |
| Leader | `team_define` | Register the managed team. |
| Leader | `team_member_create` | Create a persistent member with module responsibility and write boundaries. |
| Leader | `team_mission_assign` | Send a module goal, boundaries, input references, budget, and acceptance criteria to that member. |
| Member | `team_member_inbox` | Read and acknowledge module events. |
| Member | `team_plan_submit` | Submit independent deliverables; choose `execution: self` or `delegate`. |
| Member | `team_dispatch_authorize` | Authorize delegated work for the matching plan revision. |
| Host scheduler | Internal scheduling | Consume authorized intents when dependencies and capacity permit. |
| Executor or owner | `team_work_report` | Record artifacts, evidence, and unresolved work. |
| Owner | `team_exec_check`, `team_work_verify` | Execute declared checks and decide whether the artifacts satisfy acceptance criteria. |

A mission cannot be consumed directly by the leaf scheduler. Member plans and authorization are separate from leader assignment. Runtime provenance is derived from the real calling Agent; a prompt or tool argument claiming `plannedBy: member` is not proof of authorship.

The member can authorize multiple ready deliverables at once. As capacity becomes available, the Host starts them without requesting a new leader or member approval for each slot. A changed plan revision requires matching authorization. `self` work stays with the member and does not create a child.

The lower-level `team_work_submit`, `team_work_claim`, and `team_subagent_start` tools remain available. They do not bypass actor, owner, authorization, dependency, or capacity checks. Prefer the mission and plan path for module autonomy.

## Report and verify

`team_work_report` records a result; it does not make every result accepted. Use the work and attempt identifiers returned by the runtime, including the current lease when required by the tool. Inspect the current schema rather than guessing identifiers or copying them from another task.

When planning executable checks, declare `verificationCommands` with a stable check ID, exact executable and arguments, and the acceptance indexes covered by each check. `team_exec_check` executes a permitted command in the Host and returns an execution record. Configure allowed roots for your project as described in [configuration](CONFIGURATION.md).

Owner acceptance uses `team_work_verify` with references to actual execution records and mappings for acceptance criteria. A command string, a path, or `ok: true` written by a model does not replace a recorded run. Changed artifacts can invalidate earlier evidence.

Host command execution records are local or batch evidence. They are not automatically evidence of desktop interaction or real model behavior. If the result needs a player, browser, device, or user check that has not happened, report that boundary explicitly.

## Communicate, pause, and recover

- `team_message` handles member-to-member coordination. A leaf asks its owner through `team_ask_owner`; it does not impersonate a Team member.
- `team_snapshot` reads current team state. `team_wait` waits for changes; a timeout means no observed change, not task failure.
- `team_plan_cancel` cancels future dispatch authorization; it is distinct from stopping an active execution.
- `team_interrupt` exposes explicit scopes. Read its current tool schema and select whether to stop a turn, attempt, work item, members, or the team. Do not equate stopping the leader's current response with disposing the entire parent session.
- `team_recover` reconciles persistent records and native sessions. Recovery still depends on native parent availability and the current DSH APIs.
- `team_maintenance` provides `inspect` and an explicit `compact` operation for context maintenance. Inspect first; compaction uses sequence checks and an idempotency key and can invoke native model-backed maintenance. It is not a read-only refresh.

The dashboard shows plans, wait reasons, dispatch state, receipts, and verification when supplied by the Host. Missing fields remain missing rather than being inferred from a session's idle state.

## Usage, costs, and diagnostics

Use `team_usage`, `team_findings`, `team_error_fingerprints`, and `team_context_query` for targeted inspection. The UI fetches compact projections and paginated details. It does not need to run a model to display these read-only views.

Token accounting can be incomplete if the provider or native session does not expose usage. Costs are estimates based on your configured provider/model/time-specific price book, not a billing statement. The public defaults contain no prices; unknown values do not mean zero.

The Host exposes read-only paths relative to the DSH server:

```text
/plugin/team-workbench/health
/plugin/team-workbench/state
/plugin/team-workbench/state/detail
```

Do not assume a fixed port or expose the DSH server publicly to read these routes. State and diagnostics can contain project paths, identifiers, and artifact references. Redact them before sharing a bug report.

## Common situations

| Symptom | Check |
| --- | --- |
| Workbench loads but no team can start | Native Agent Team and continuable provider availability; the effective profile and diagnostics. |
| Work stays in `needs_plan` | Whether its real owner received the mission and submitted a plan. A leader-created owner field is not member authorization. |
| Work is planned but not dispatched | Matching plan revision, authorized intent, dependencies, budget, write conflicts, and native capacity. |
| Work has artifacts but is not accepted | Verification records, acceptance mappings, freshness, and owner verification. |
| Costs are unknown | Missing usage or a missing price entry for the provider/model/time; do not insert guessed prices. |
| Storage is read-only | A second writer, unavailable storage, or the configured data directory; preserve data and inspect the reason before retrying. |
| UI changes are not visible after an update | Actual frontend revision and DSH reload requirements; an announced revision is not proof that a new bundle mounted. |

Use the error and the narrow failing operation to decide the next step. Preserve active work and persistent records while investigating; repeated blind restarts are not a recovery strategy.
