# Changelog

## 1.0.0 — 2026-10-17

Initial public source release of the standalone Team Workbench plugin.

### Included

- Native DSH conversation workbench with 1-, 2-, and 4-pane layouts and child-session navigation.
- Persistent module members, missions, member-authored plans, dispatch authorization, inbox events, and owner verification.
- Event-driven scheduling, capacity accounting, dependency checks, cooperative write-scope coordination, and recovery records.
- Artifact identity, execution-backed evidence, acceptance mapping, usage accounting, and diagnostic projections.
- Optional context maintenance and explicit external skill-upgrade integration.
- Production-module tests, simulated-native integration checks, package checks, and cross-platform CI configuration.
- Chinese and English READMEs, usage, configuration, architecture, acceptance, and release documentation.

### Distribution defaults

- MIT license; independently maintained and unofficial.
- No bundled myworkflow skills and no mandatory route to an external skill package.
- External skill migration is disabled by default and requires an explicitly configured integration entry.
- No provider-specific prices. Missing pricing remains unknown.
- The native profile `subagent` row is overridden to depth 2 and 40 active continuable subagents; see [configuration](docs/CONFIGURATION.md).

### Compatibility and evidence

DSH 0.2.0-rc.2 is the investigated interface baseline. This release entry does not claim a new real-model or desktop acceptance run. Review CI results for the specific release commit, and record live DSH acceptance separately using the [checklist](docs/ACCEPTANCE.md).
