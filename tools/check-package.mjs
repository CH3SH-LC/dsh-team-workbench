#!/usr/bin/env node
/** Assert the exact npm tarball inventory without creating an archive or running lifecycle hooks. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
assert(npmCli && existsSync(npmCli), 'Run this check with npm run check:package (npm_execpath is required).');
const run = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, npm_config_cache: path.join(root, '.runtime', 'npm-cache') },
});
assert.equal(run.status, 0, run.stderr || run.error?.message || 'npm pack failed');
const [pack] = JSON.parse(run.stdout);
assert(pack && Array.isArray(pack.files), 'npm pack returned no file inventory');
const paths = pack.files.map((file) => file.path);
assert.equal(new Set(paths).size, paths.length, 'Duplicate archive paths');
const allowedRoot = new Set(['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.en.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md']);
const allowed = (name) => allowedRoot.has(name)
  || /^src\/(host|client|compat)\/[^/]+\.js$/.test(name)
  || /^locale\/[^/]+\.json$/.test(name)
  || /^docs\/[a-zA-Z0-9_/-]+\.md$/.test(name)
  || name === 'tools/build-client.mjs'
  || name === 'scripts/install-upgrade-entry.mjs';
assert.deepEqual(paths.filter((name) => !allowed(name)), [], 'Package contains files outside the public runtime allowlist');
for (const file of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'LICENSE', 'README.md', 'src/host/index.js', 'src/client/99-entry.js', 'src/compat/01-focus-bridge.js', 'locale/en.json', 'locale/zh.json']) {
  assert(paths.includes(file), `Required runtime file missing from package: ${file}`);
}
const metadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(metadata.license, 'MIT');
for (const [name, value] of Object.entries(metadata.exports ?? {})) {
  if (typeof value !== 'string' || value.includes('*')) continue;
  assert(paths.includes(value.replace(/^\.\//, '')), `Export ${name} points outside package: ${value}`);
}
// Every local import must survive packing. Host providers are supplied by DSH at runtime.
for (const file of paths.filter((name) => name.endsWith('.js') || name.endsWith('.mjs'))) {
  const source = readFileSync(path.join(root, file), 'utf8');
  const localImports = source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g);
  for (const match of localImports) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    assert(paths.includes(target), `Missing local import: ${file} -> ${target}`);
  }
}
console.log(JSON.stringify({ ok: true, filename: pack.filename, files: paths.length, unpackedSize: pack.unpackedSize, license: metadata.license }));
