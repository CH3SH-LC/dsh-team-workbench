#!/usr/bin/env node
/** Offline integration runner. Each process gets its own working and storage directory. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const jobs = [
  ['generated-client', 'tools/build-client.mjs', '--verify', '--check'],
  ['core-acceptance', 'acceptance/run-all.mjs'],
  ['host-integration', 'scripts/smoke-host.mjs'],
  ['autonomy-evidence-usage', 'tests/host-autonomy/remediation-20261017.mjs'],
  ['compact-state', 'tests/host-autonomy/compact-state-fixture.mjs'],
  ['native-usage', 'tests/native-usage-fixture.mjs'],
  ['materialize-scope', 'tests/materialize-scope-fixture.mjs'],
  ['upgrade-installer', 'tests/install-upgrade-entry-fixture.mjs'],
  ['standalone-upgrade', 'tests/standalone-upgrade.mjs'],
];

const temp = await mkdtemp(path.join(os.tmpdir(), 'dsh-workbench-tests-'));
const results = [];
try {
  for (const [name, file, ...args] of jobs) {
    const cwd = path.join(temp, name);
    await mkdir(cwd, { recursive: true });
    console.log(`\n===== ${name} =====`);
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(root, file), ...args], {
        cwd,
        env: { ...process.env, TMPDIR: cwd, TMP: cwd, TEMP: cwd, DSH_TEAM_WORKBENCH_DIR: path.join(cwd, 'sidecar'), DSH_ACCEPTANCE_RUN_ID: 'offline-public' },
        stdio: 'inherit',
        windowsHide: true,
      });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180_000);
      child.once('error', (error) => { clearTimeout(timer); resolve({ name, ok: false, error: error.message }); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ name, ok: code === 0 && !timedOut, code, signal, timedOut });
      });
    });
    results.push(result);
  }
} finally {
  const relativeTemp = path.relative(path.resolve(os.tmpdir()), path.resolve(temp));
  assert(relativeTemp && !relativeTemp.startsWith('..') && !path.isAbsolute(relativeTemp) && path.basename(temp).startsWith('dsh-workbench-tests-'), 'Refusing to clean a directory outside this test run');
  await rm(temp, { recursive: true, force: true });
}
const failed = results.filter((result) => !result.ok);
console.log(`\nOffline verification: ${results.length - failed.length}/${results.length} groups passed.`);
console.log(JSON.stringify({ kind: 'dsh-workbench/offline-verification', ok: failed.length === 0, results }));
console.log('These checks use real plugin code with simulated host seams. They do not certify live DSH, model behavior, or desktop rendering.');
process.exitCode = failed.length ? 1 : 0;
