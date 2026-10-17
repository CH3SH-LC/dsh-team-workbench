# DSH Team Workbench

[简体中文](README.md) · [Usage](docs/USAGE.md) · [Configuration](docs/CONFIGURATION.md) · [Architecture](docs/ARCHITECTURE.md)

An unofficial DeepSeek Harness plugin for **1-, 2-, or 4-pane conversations** and persistent module-oriented agent teams.

A team consists of a **leader, module members, and each member's own subagents**. The leader assigns goals and boundaries. Members plan their work and authorize delegation. A Host scheduler starts authorized work as dependencies and capacity allow.

This repository contains the workbench and team runtime only. **The separate myworkflow skill package is neither bundled nor required.**

## Features

- Reuse native DSH conversations in a multi-pane workspace, with separate conversation drafts and reading positions.
- Model persistent module missions, member plans, versioned dispatch authorization, inbox events, and owner verification.
- Refill available execution slots without a whole-batch completion barrier.
- Keep artifact production separate from acceptance, linking checks, artifact hashes, acceptance criteria, and unresolved work.
- Inspect member decisions, waiting reasons, work, usage, estimated costs, and errors. Missing usage or pricing stays unknown.

Panes bind workspace main sessions directly. Members and subagents are opened through the session's child-session menu. Pane count is independent of execution concurrency. Cooperative write scopes are not a filesystem sandbox.

## Compatibility and validation status

The investigated interface baseline is **DSH 0.2.0-rc.2**. Session, slot, native conversation, and layout interfaces may change in later versions.

Team execution requires DSH's native experimental Agent Team in the active profile and an available continuable subagent provider. Missing capabilities produce diagnostics; a successfully loaded plugin does not prove a runnable team.

The release includes tests of production modules, integration checks with simulated native interfaces, packaging checks, and CI configuration. **These do not certify all DSH versions, operating systems, or real model providers.** Use the separate [live acceptance checklist](docs/ACCEPTANCE.md) for actual installation, UI, and model-driven behavior.

## Install

With the DSH CLI installed:

```sh
dsh plugin add github:CH3SH-LC/dsh-team-workbench#v1.0.0
```

To target an existing profile, for example `desktop`:

```sh
dsh plugin --profile desktop add github:CH3SH-LC/dsh-team-workbench#v1.0.0
```

Install into the same profile that your running application uses. See the [official bundle documentation](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish).

A local checkout or packaged `.tgz` can also be installed. In DSH creation mode, use the native plugin manager:

```text
plugin_manager(action="install_bundle", target="github:CH3SH-LC/dsh-team-workbench#v1.0.0")
```

For a local checkout, replace `target` with its absolute directory path. Refer to the [official plugin-manager documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md) for your DSH version.

**Profile-wide configuration change:** this bundle sets the native `subagent` row to `maxDepth: 2` and `maxActiveSubagents: 40`. Other tasks using that service in the same profile are affected. Review existing overrides before installing; see [configuration](docs/CONFIGURATION.md). Provider quotas and rate limits do not increase with these settings.

After installation, inspect the load result and open **Team Workbench / 超级工作台** from the sidebar. If DSH requires a reload or restart, first save and safely finish active work.

## Use a team

Example request for a fresh conversation:

> Build a small game content pack with an enemy-content member and an equipment-content member. Each member should deliver four complete objects, choosing its own designs, plan, and subtasks. Deliver descriptions, structured data, and verification results. Split by independent objects, with the same owner responsible through completion. Start with modest concurrency.

The intended tool sequence is:

1. The leader uses `team_define` and `team_member_create`, then assigns module goals with `team_mission_assign`.
2. Members submit their own plans with `team_plan_submit`, choosing `self` or `delegate`, and authorize delegation with `team_dispatch_authorize`.
3. The Host schedules eligible work; members process inbox events and receipts.
4. Owners verify delivered artifacts. Executable checks use `team_exec_check`; `team_work_verify` connects evidence to acceptance criteria.

Simple requests can be completed directly. See the [usage guide](docs/USAGE.md) for tool roles, stopping, and recovery.

## Development

Use Node.js **22 or newer** in a complete source checkout:

```sh
npm run build
npm test
npm run check:package
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changes. Tests run from the complete checkout; the released `.tgz` is a runtime package. Regenerate `client.js` from frontend sources instead of editing only the generated bundle. Remove private paths, conversation text, account identifiers, and credentials from public issue reports.

## Documentation

- [Usage and tools](docs/USAGE.md)
- [Configuration, capacity, and storage](docs/CONFIGURATION.md)
- [Architecture and invariants](docs/ARCHITECTURE.md)
- [Live DSH acceptance](docs/ACCEPTANCE.md)
- [Release procedure](docs/RELEASE.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE). Independently maintained; not affiliated with or endorsed by DeepSeek.
