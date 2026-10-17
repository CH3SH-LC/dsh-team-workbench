#!/usr/bin/env node
/** Isolated source snapshots and real Host upgrade transaction; native DSH services are fixtures. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { currentSourceHash } from '../src/host/versionGraph.js';
import { normalizeConfig } from '../src/host/config.js';
import { loadSkillsUpgradeModule, runSkillsMigration } from '../src/host/skillsBridge.js';
import { createWorkbench } from './helpers/harness.mjs';

const checks = [];
const check = (name, assertion) => { assertion(); checks.push(name); };
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'twb-standalone-upgrade-'));
const runtimes = [];
try {
  const source = await currentSourceHash();
  check('source snapshot has no external skill package', () => assert(source.files.every(file => !file.relative.startsWith('packages/'))));
  const fixtureRoot = path.join(temporaryRoot, 'standalone source with spaces');
  for (const file of source.files) {
    const target = path.join(fixtureRoot, file.relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file.absolute, target);
  }
  const fixtureGraph = await import(pathToFileURL(path.join(fixtureRoot, 'src/host/versionGraph.js')).href);
  const graph = await fixtureGraph.prepareVersionGraph();
  check('standalone version graph prepares without sibling packages', () => assert.equal(graph.ok, true, JSON.stringify(graph)));
  check('snapshot matches source hash', () => assert.equal(graph.hash, source.hash));
  const marker = await fixtureGraph.verifyVersionMarker(graph.versionDir, graph.hash);
  check('version marker proves isolated module graph', () => assert.equal(marker.ok, true));
  const reused = await fixtureGraph.prepareVersionGraph();
  check('unchanged source reuses completed graph', () => assert.equal(reused.reused, true));
  const [bundle, host, tools, web] = await Promise.all([
    import(graph.upgradeBundleUrl), import(graph.indexUrl),
    import(pathToFileURL(path.join(graph.versionDir, 'src/host/tools.js')).href),
    import(pathToFileURL(path.join(graph.versionDir, 'src/host/web.js')).href),
  ]);
  check('isolated host and upgrade entry load', () => {
    assert.equal(typeof host.apply, 'function');
    assert.equal(typeof bundle.createUpgradeBundle, 'function');
  });

  const defaults = normalizeConfig({});
  check('external skills disabled by default', () => assert.equal(defaults.remediation.skillsMigrate, false));
  const skipped = await runSkillsMigration({ service: { ctx: { get() { throw new Error('disabled bridge touched runtime'); } } } });
  check('default skip does not touch native skills', () => assert.equal(skipped.skipped, true));
  const missing = await runSkillsMigration({ config: { remediation: { skillsMigrate: true } } });
  check('explicit enabled missing entry fails', () => assert.equal(missing.code, 'SKILLS_UPGRADE_ENTRY_REQUIRED'));
  const relative = await loadSkillsUpgradeModule({ remediation: { skillsUpgradeEntry: 'missing/upgrade.js' } });
  check('relative external entry rejected', () => assert.equal(relative.code, 'SKILLS_UPGRADE_ENTRY_INVALID'));
  const absent = await loadSkillsUpgradeModule({ remediation: { skillsUpgradeEntry: path.join(temporaryRoot, 'missing.js') } });
  check('missing external file fails', () => assert.equal(absent.code, 'SKILLS_UPGRADE_ENTRY_MISSING'));
  const invalidEntry = path.join(temporaryRoot, 'invalid-entry.mjs');
  await fs.writeFile(invalidEntry, 'export const unrelated = true;\n');
  const invalid = await loadSkillsUpgradeModule({ remediation: { skillsUpgradeEntry: pathToFileURL(invalidEntry).href } });
  check('external file without bridge contract rejected', () => assert.equal(invalid.code, 'SKILLS_UPGRADE_NO_EXPORTS'));
  const configured = normalizeConfig({ remediation: { skillsMigrate: true, skillsUpgradeEntry: pathToFileURL(invalidEntry).href, skillsSourceRoot: temporaryRoot, skillsPatchPath: path.join(temporaryRoot, 'cordis.patch.yml'), skillsVersionTarget: path.join(temporaryRoot, 'copied'), skillsExpectedCount: 2, installableEntry: graph.indexUrl } });
  check('explicit external configuration survives normalization', () => {
    assert.equal(configured.remediation.skillsMigrate, true);
    assert.equal(configured.remediation.skillsSourceRoot, temporaryRoot);
    assert.equal(configured.remediation.skillsUpgradeEntry, pathToFileURL(invalidEntry).href);
    assert.equal(configured.remediation.skillsExpectedCount, 2);
    assert.equal(configured.remediation.installableEntry, graph.indexUrl);
  });

  async function makeController(remediation = {}) {
    const workbench = await createWorkbench({ config: { usage: { enabled: false, historicalBackfill: false }, remediation: { sidecarDir: path.join(temporaryRoot, `sidecar-${runtimes.length}`), installableEntry: graph.indexUrl, ...remediation } } });
    runtimes.push(workbench);
    assert.equal(workbench.mode, 'real');
    const controller = bundle.createUpgradeBundle({
      ctx: workbench.ctx, adapter: workbench.adapter, storage: workbench.storage,
      service: workbench.service, scheduler: workbench.scheduler, config: workbench.config,
      clock: workbench.clock, registerTools: tools.registerTools, registerWebRoutes: web.registerWebRoutes,
      startContextHooks: host.startContextHooks, startUsageIngest: host.startUsageIngest,
      versionGraph: graph,
    });
    return { workbench, controller };
  }
  const standalone = await makeController();
  const beforeWorks = standalone.workbench.service.works;
  const activated = await standalone.controller.activate();
  check('standalone Host upgrade completes all postconditions', () => assert.equal(activated.ok, true, JSON.stringify(activated)));
  check('external skills explicitly recorded as skipped', () => assert.equal(activated.mounted.skills.skipped, true));
  check('upgrade preserves live work map identity', () => assert.equal(standalone.workbench.service.works, beforeWorks));
  const again = await standalone.controller.activate();
  check('completed activation is idempotent', () => assert.equal(again.alreadyUpgraded, true));

  const rejected = await makeController({ skillsMigrate: true });
  const beforeStorage = rejected.workbench.service.storage;
  const beforeSubmit = rejected.workbench.service.submitWork;
  const failed = await rejected.controller.activate();
  check('explicit external failure rejects whole upgrade', () => assert.equal(failed.code, 'SKILLS_MIGRATION_FAILED', JSON.stringify(failed)));
  check('failed optional integration restores service descriptors and storage', () => {
    assert.equal(rejected.workbench.service.storage, beforeStorage);
    assert.equal(rejected.workbench.service.submitWork, beforeSubmit);
    assert.equal(rejected.workbench.service.__hotUpgrade, null);
  });
  console.log(JSON.stringify({ ok: true, nativeServices: 'fixtures', checks: checks.length, passed: checks }));
} finally {
  for (const runtime of runtimes) {
    await runtime.dispose();
    runtime.ctx?.dispose?.();
  }
  // The only recursive cleanup target is the fresh directory created above.
  assert(path.resolve(temporaryRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
