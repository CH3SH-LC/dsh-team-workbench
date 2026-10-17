# Contributing

Thank you for helping improve Team Workbench. Keep changes reviewable against the actual DSH interfaces and preserve existing conversations and artifacts.

## Scope

This repository owns the workbench UI, team runtime, scheduling, persistence, evidence, and usage projections. External skill collections are optional integrations. Do not add a required dependency on a private workflow package, a local checkout outside this repository, or an account-specific provider setup.

Use the [architecture guide](docs/ARCHITECTURE.md) to find the owning module. One change owner should follow its deliverable from investigation through implementation and verification. Parallel work should divide independent deliverables rather than hand the same deliverable between research, implementation, and repair agents.

## Development workflow

Use Node.js 22 or newer in a complete source checkout. The package uses ES modules. Consult `package.json` for the exact current scripts. The released `.tgz` is a runtime package and does not replace the development checkout.

1. Read the relevant production module and its native adapter boundary before changing behavior.
2. Complete a coherent implementation or a substantial runnable increment before running its validation set.
3. Run `npm run build` to regenerate the frontend bundle.
4. Run `npm test` and `npm run check:package`.
5. For changes affecting native UI, model execution, recovery, or tool permissions, also follow the relevant [live acceptance scenarios](docs/ACCEPTANCE.md). Report unexecuted scenarios explicitly.

`npm run baseline:update` updates maintained baselines. Use it only after reviewing the intended change; updating a snapshot to hide a failure is not validation. Include the source change and its resulting baseline difference together.

CI is configured for Windows and Ubuntu with Node.js 22 and 24. A green CI job proves only the checks in that job, not the live DSH scenarios.

## Required invariants

- Native Agent identity comes from the runtime, never from model-supplied `actorId` or `memberApproved` fields.
- A mission is a module goal, not a directly executable leaf job. Members own plans and dispatch authorization.
- The scheduler executes authorized intents and enforces dependencies and capacity. It must not invent plans for a member.
- A slow independent job cannot impose a whole-batch barrier on ready jobs.
- Produced, verified, accepted, and user-confirmed are distinct claims. Preserve evidence scope and artifact freshness.
- Read-only state routes must not dispatch, wake models, mutate business state, or rescan full logs per refresh.
- Register disposable hooks and UI contributions. Unload and replacement must not leave duplicate listeners or editors.
- Treat write scopes as cooperative coordination, not proof of filesystem isolation.
- Unknown usage and unknown prices must remain unknown. Do not turn missing data into a zero-cost claim.

## Tests and issue reports

Prefer a regression that exercises the production path over a test that reimplements the behavior being tested. Simulated native adapters are useful for deterministic tests, but label them as simulations.

An issue or pull request should state:

- What the user did and what happened, including expected behavior.
- DSH version, plugin version or commit, operating system, and relevant redacted settings.
- The narrow reproduction and the changed modules.
- Validation performed, its results, and any live checks still unexecuted.

Do not commit private session databases, raw model transcripts, provider credentials, personal price books, local profile files, or screenshots containing private content. Use synthetic fixtures and redact unrelated information before sharing logs. Report a security issue without posting exploitable private data in a public issue; use repository security reporting when available.

## License

Contributions are provided under this repository's [MIT license](LICENSE). Identify third-party code and its license instead of copying bundled DSH implementation into this project.
