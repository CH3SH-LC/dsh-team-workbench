# Releasing Team Workbench

[README](../README.en.md) · [Changelog](../CHANGELOG.md)

## Release checks

Use a complete source checkout with Node.js 22 or newer. Finish the implementation before running the combined checks:

```sh
npm run build
npm test
npm run check:package
npm pack
```

Review generated frontend changes and the tarball contents. The tarball is a runtime distribution; tests and development fixtures belong to the source checkout. Public artifacts must contain no private profile settings, session records, raw transcripts, account-specific price tables, credentials, or machine-specific paths.

The generated `client.js` must be included and consistent with its sources. Check that every exported entry, bundle patch, locale, license, and linked packaged document is present. A successful archive creation alone does not prove a DSH install.

Run CI for the exact release commit. The configured Windows/Ubuntu and Node.js 22/24 matrix exercises only its declared build, test, and package checks. Do not describe it as desktop or provider certification.

## Version and publish

1. Align `package.json`, `CHANGELOG.md`, installation examples, and intended tag, such as `v1.0.0`.
2. Review the MIT license, repository metadata, public defaults, and optional integrations.
3. Commit the reviewed source and generated bundle. Tag the same commit used for release checks.
4. Publish the tag and attach the runtime `.tgz` if distributing one. Include its checksum and the source commit in release notes.
5. Confirm that the GitHub tag resolves and the runtime artifact is downloadable before announcing either installation route as available.

Pinning the tag selects a release rather than the moving default branch:

```sh
dsh plugin add github:CH3SH-LC/dsh-team-workbench#v1.0.0
```

For local verification, install the produced tarball or a local source directory into a dedicated DSH profile using the supported native plugin installer. Do not manually rewrite the user's installed profile manifest to simulate installation.

## What release notes must say

Summarize behavior changes, profile configuration effects, checks actually performed, known limitations, and migration or recovery requirements. For this version, explicitly mention the native `subagent` override to depth 2 and 40 active continuable subagents, the DSH 0.2.0-rc.2 interface baseline, optional external skill integration, and unknown cost when prices are absent.

Do not promote a check from one evidence level to another. If no new real DSH or model acceptance was run, say so. Use [ACCEPTANCE.md](ACCEPTANCE.md) for a separate live acceptance record, including its precise build and environment.

## Updating an existing installation

Review the target profile's composed settings and preserve active tasks before replacing code. Follow the running DSH version's plugin update and reload behavior. A code update, a Host activation, and a mounted frontend revision are separate observations.

The optional in-process upgrade machinery must report its actual postconditions. External skill migration is disabled by default; only an explicitly configured external integration may enable it. It is not part of installing this standalone repository.

Keep persistent data during rollback unless the user explicitly requests its removal. Restoring an earlier package does not automatically reverse data-format changes; inspect compatibility and recovery diagnostics first.
