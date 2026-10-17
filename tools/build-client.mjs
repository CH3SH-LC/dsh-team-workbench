#!/usr/bin/env node
/**
 * tools/build-client.mjs — deterministic builder for the single-file browser artifact.
 *
 * Output contract:
 *
 *   window.__ModuleLoader__.load({
 *     id: '@local/dsh-team-workbench',
 *     factory(require) {
 *       const React = require('react');
 *       <concatenated plain-script fragments>
 *       return __teamWorkbench;
 *     },
 *   });
 *
 * Sources, concatenated in this order:
 *   1. src/compat/*.js   (sorted by filename) — the rc.2-limited, disableable compat layer
 *      (`src/compat/01-focus-bridge.js`); delete the files and they leave the artifact.
 *   2. src/client/*.js   (sorted by filename) — the client half; `99-entry.js` defines
 *      `const __teamWorkbench = { inject, apply }`.
 *
 * Fragments are plain scripts: no import/export, no require other than 'react', and each
 * file prefixes its identifiers (`tb…`) so the shared factory scope stays collision-free.
 *
 * Determinism: LF endings, BOM stripped, no timestamps; the output depends only on the
 * source bytes and their filenames, so re-running produces an identical file.
 *
 * Usage:
 *   node tools/build-client.mjs            # writes client.js, prints files/bytes/sha256
 *   node tools/build-client.mjs --check    # additionally syntax-checks the artifact in-process
 *   node tools/build-client.mjs --verify   # read-only: fail if committed client.js is stale
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outPath = join(root, 'client.js');
const pluginId = '@local/dsh-team-workbench';

/** Read one directory's `.js` fragments in ascending filename order. */
function fragmentsOf(relativeDir) {
  const dir = join(root, relativeDir);
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch (error) {
    throw new Error(`build-client: cannot read ${relativeDir}: ${error.message}`);
  }
  if (names.length === 0) throw new Error(`build-client: ${relativeDir} has no .js fragments`);
  return names.map((name) => ({ relative: `${relativeDir}/${name}`, name }));
}

function normalize(source) {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return withoutBom.replace(/\r\n?/g, '\n').replace(/\s+$/, '\n');
}

/**
 * Theme-token gate. This compatibility list is part of the source tree, so a clean
 * clone and the developer checkout produce the same artifact. It records the
 * DSH 0.2.0-rc.2 tokens used by this client; it is not an exhaustive host API list.
 *
 * Do NOT use `Theme.listTokens` for this: it returns only the tokens that need light/dark
 * overrides (14), i.e. a partial set; treating it as complete once produced five bogus
 * "unknown token" findings for perfectly real tokens.
 *
 * Why gate at all: an unresolved `var()` is invalid at computed-value time, so `border-color`
 * silently falls back to `currentColor` and `color` inherits — the panel then renders with
 * fallback colours no matter how correct the spacing contract is.
 */
const supportedThemeTokens = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-brand-primary',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill'
]);

function assertThemeTokens(text) {
  const allowed = supportedThemeTokens;
  const unknown = new Map();
  for (const match of text.matchAll(/--dsw-[a-z0-9-]+/g)) {
    const token = match[0];
    // `--dsw-alias-*` written as a glob inside a comment is documentation, not a reference.
    if (text[match.index + token.length] === '*') continue;
    if (allowed.has(token)) continue;
    unknown.set(token, (unknown.get(token) ?? 0) + 1);
  }
  if (unknown.size > 0) {
    const list = [...unknown.entries()].map(([token, count]) => `${token} (x${count})`).join(', ');
    throw new Error(`build-client: unknown theme token(s) referenced: ${list}; update the compatibility list only after checking the target DSH version`);
  }
  return { source: 'versioned compatibility list', tokens: allowed.size };
}

const groups = [fragmentsOf('src/compat'), fragmentsOf('src/client')];
const fragments = groups.flat();
const entryFragment = fragments.find((fragment) => fragment.relative === 'src/client/99-entry.js');
if (entryFragment === undefined) throw new Error('build-client: src/client/99-entry.js is required (it defines __teamWorkbench)');

const body = fragments
  .map((fragment) => {
    const text = normalize(readFileSync(join(root, fragment.relative), 'utf8'));
    return `/* ==== ${fragment.relative} ==== */\n${text}`;
  })
  .join('\n');

// Stable SOURCE digest: sha256 over the fragments (with the digest placeholder removed), so the
// value is deterministic and NOT self-referential (embedding it does not change its own input).
const DIGEST_PLACEHOLDER = '__TB_SOURCE_DIGEST__';
const digestBasis = body.split(DIGEST_PLACEHOLDER).join('');
const sourceDigest = createHash('sha256').update(digestBasis, 'utf8').digest('hex');
const bodyWithDigest = body.split(DIGEST_PLACEHOLDER).join(sourceDigest);

const artifact = [
  '/* @local/dsh-team-workbench ' + String.fromCharCode(0x2014) + ' GENERATED by tools/build-client.mjs. Do not edit by hand.',
  ' * Single-file browser artifact: require() resolves only the platform seed `react`.',
  ' * Regenerate with: node tools/build-client.mjs',
  ' *',
  ' * The wrapper captures `document.currentScript.src` AT SCRIPT EXECUTION TIME (a classic-script',
  ' * load appends the tag, see dsh-client-modules defaultLoadBundle) because the module factory is',
  ' * evaluated LATER (materialization), when `document.currentScript` is already null. The captured',
  ' * URL + stable source digest live in the factory closure only: official plain-script protocol,',
  ' * no `import.meta`, no script-tag guessing, and an HMR rev announcement cannot rewrite them.',
  ' */',
  '(function (registry) {',
  '  var loadedScriptUrl = null;',
  '  try {',
  '    var doc = typeof document !== "undefined" ? document : (typeof window !== "undefined" ? window.document : undefined);',
  '    var current = doc !== undefined && doc !== null ? doc.currentScript : undefined;',
  '    if (current !== undefined && current !== null && typeof current.src === "string" && current.src !== "") loadedScriptUrl = current.src;',
  '  } catch (error) { loadedScriptUrl = null; }',
  '  registry.load({',
  '    id: ' + JSON.stringify(pluginId) + ',',
  '    factory(require) {',
  '      var __tbSelfBundle = Object.freeze({',
  '        url: loadedScriptUrl,',
  '        sourceDigest: ' + JSON.stringify(sourceDigest),
  '      });',
  "      const React = require('react');",
  '',
  '/*BODY*/',
  '',
  '      return __teamWorkbench;',
  '    },',
  '  });',
  '})(window.__ModuleLoader__);',
  ''
].join('\n');
const artifactText = artifact.replace('/*BODY*/', bodyWithDigest);

// Theme-token gate runs BEFORE anything is written: a build with an unknown `--dsw-*` token
// must not produce a client.js that silently renders with fallback colors.
const tokenCheck = assertThemeTokens(body);

if (process.argv.includes('--verify')) {
  let current;
  try { current = readFileSync(outPath, 'utf8'); } catch { current = null; }
  if (current !== artifactText) {
    throw new Error('build-client: client.js is missing or stale; run npm run build and review the change');
  }
} else {
  writeFileSync(outPath, artifactText, 'utf8');
}

const sha256 = createHash('sha256').update(artifactText, 'utf8').digest('hex');
console.log(`build-client: ${fragments.length} fragments -> client.js`);
for (const fragment of fragments) console.log(`  - ${fragment.relative}`);
console.log(`build-client: theme tokens OK (source of truth: ${tokenCheck.source}, ${tokenCheck.tokens} allowed)`);
console.log(`build-client: bytes=${Buffer.byteLength(artifactText, 'utf8')} sha256=${sha256}`);

if (process.argv.includes('--check')) {
  // In-process parse check: Function() compiles without executing (no child process, so
  // it also works under the Windows file sandbox where piped spawn fails with EPERM).
  try {
    // eslint-disable-next-line no-new-func
    new Function(artifactText);
    console.log('build-client: syntax OK (in-process compile)');
  } catch (error) {
    console.error('build-client: SYNTAX ERROR:', error.message);
    process.exitCode = 1;
  }
}
