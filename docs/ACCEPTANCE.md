# Live DSH acceptance

[README](../README.en.md) · [Architecture](ARCHITECTURE.md)

This is a reproducible checklist, not a claim that a live run has already passed. Production-module tests and simulated native interfaces establish different evidence from actual DSH UI and real-model behavior.

## Record the environment

Use a dedicated test team and project with synthetic input. Preserve other conversations and their data. Record DSH version, plugin commit or package hash, operating system, profile, effective capacity settings, provider/model, and start/end time. Keep credentials and private transcripts out of published evidence.

Verify the actual Host and frontend revisions, loaded tools, and required native services. An installed dependency or a new file on disk is not sufficient proof of activation.

## Minimum workload

Create one leader and two members: enemy content and equipment content. Each module should deliver four complete objects containing a description, structured data, and verification evidence. Use four global leaf slots and at most two per member for this scenario so later work needs to refill slots.

The leader supplies module goals, quantities, format constraints, output boundaries, and acceptance criteria. Members decide the concrete objects, plans, child briefs, and delegation. A test driver may prepare clean directories and independent validators; it must not prewrite member plans, authorize work as a member, manufacture receipts, or edit state to simulate success.

## Required scenarios

| Scenario | Required observation |
| --- | --- |
| Installation and activation | Final package loads in the intended real profile; Host tools and mounted frontend match the release under test. |
| Member autonomy | Native records show leader mission, real member model planning, member-authored plan and authorization, and children whose parent is that member. |
| Complete ownership | The same owner processes receipts, verifies its module, and repairs rejected work. |
| Rolling refill | With one child held at a bounded test gate, another finishes and a later authorized child starts before the held child finishes. No new leader approval is needed. |
| Dependency isolation | A work item with a real unsatisfied cross-deliverable dependency stays blocked while independent authorized work proceeds. |
| Leader idle | Stopping the leader's current model turn does not stop members or previously authorized scheduling. Do not confuse this with destroying the parent session. |
| Pane lifecycle | Switching 4→1→2→4 and navigating child sessions preserves the correct conversation, draft, and background work. Focused send, stop, approval, and right-sidebar behavior stay correctly scoped. |
| Specified start | Starting a particular authorized work item cannot reserve a different item or consume its attempt budget. |
| Evidence integrity | A path or bare success claim cannot pass acceptance; actual checks map to criteria and changed artifacts invalidate stale evidence. |
| Cancellation | Cancelling future authorization is distinct from stopping active work; explicit cancellation is not undone by automatic refill. |
| Cold recovery | After a safe restart, completed work stays completed, real parents are restored before child operations, incomplete starts reconcile, and duplicate execution is prevented. |
| Missing data | Unavailable usage, prices, native services, and evidence are shown as unknown or blocked with a specific reason. |

The bounded delay gate is a test fixture, not a fake completion signal. Save its release and timeout events. A delay scenario fails if later ready work cannot start before the gate's deadline; do not silently extend the deadline until it passes.

Run cold recovery only in an instance safe to restart. If another profile or instance is used, label it explicitly rather than claiming it proves recovery in the user's active session.

## Evidence bundle

Retain native session IDs and lineage; real actor identity for plan and dispatch calls; mission, work, plan revision, intent and attempt IDs; timestamps for completion and refill; actual artifacts; independent check output; acceptance decisions; and pre/post-restart snapshots.

For UI scenarios, record the concrete interactions and observed state. Command execution alone cannot prove pane focus or draft behavior. For autonomy, a three-level session tree alone cannot prove that members planned the work.

Report each scenario as **passed**, **failed**, or **not run** with evidence locations. No mock Agent, manually written state, historical run from another build, or driver-authored plan can substitute for a missing real-model scenario. Keep source checks, simulated integration, live Host behavior, desktop interaction, provider execution, and recovery results separate.
