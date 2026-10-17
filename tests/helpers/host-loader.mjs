/**
 * Locate and load the real Host modules written by the Lead.
 *
 * The test tree must never import `@deepseek-ai/*`; it only ever loads files
 * from this workspace by absolute `file://` URL. When a module has not landed
 * yet the loader reports it as missing, and the owning suite becomes
 * PENDING_HOST instead of a fake PASS.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEST_ROOT = path.resolve(HERE, '..');
export const WORKSPACE_ROOT = path.resolve(TEST_ROOT, '..');

/** Canonical file for every Host seam the suites drive. */
export const HOST_FILES = {
  util: 'src/host/util.js',
  config: 'src/host/config.js',
  adapter: 'src/host/adapter.js',
  storage: 'src/host/storage.js',
  service: 'src/host/service.js',
  scheduler: 'src/host/scheduler.js',
  policy: 'src/host/policy.js',
  tools: 'src/host/tools.js',
  skills: 'src/host/skills.js',
  web: 'src/host/web.js',
  index: 'src/host/index.js',
  entry: 'index.js',
};

const cache = new Map();

/**
 * @param {keyof typeof HOST_FILES} name
 * @returns {Promise<{ name:string, file:string, absPath:string, exists:boolean,
 *   real:boolean, mod:object|null, error:Error|null }>}
 */
export async function loadHostModule(name) {
  const relative = HOST_FILES[name];
  if (!relative) throw new Error(`unknown host module ${name}`);
  if (cache.has(name)) return cache.get(name);
  const absPath = path.join(WORKSPACE_ROOT, relative);
  const entry = { name, file: relative, absPath, exists: false, real: false, mod: null, error: null };
  if (!existsSync(absPath)) {
    cache.set(name, entry);
    return entry;
  }
  entry.exists = true;
  try {
    entry.mod = await import(pathToFileURL(absPath).href);
    entry.real = true;
  } catch (error) {
    entry.error = error;
  }
  cache.set(name, entry);
  return entry;
}

/** Load several modules in one shot. */
export async function loadHostModules(names) {
  const loaded = {};
  for (const name of names) loaded[name] = await loadHostModule(name);
  return loaded;
}

export function hostModulePath(name) {
  return path.join(WORKSPACE_ROOT, HOST_FILES[name]);
}

/** Forget cached imports (used by suites that re-apply a fresh module graph). */
export function resetHostModuleCache() {
  cache.clear();
}

/** Read a workspace-relative UTF-8 file; returns null instead of throwing. */
export function readWorkspaceFile(relative) {
  const absPath = path.join(WORKSPACE_ROOT, relative);
  if (!existsSync(absPath)) return null;
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** True when the file exists (used to gate fixtures like the skills snapshot). */
export function workspaceFileExists(relative) {
  return existsSync(path.join(WORKSPACE_ROOT, relative));
}

export default loadHostModule;
