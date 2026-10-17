/**
 * `versionGraph.js` — 独立版本化模块图。
 *
 * ## 为什么必须复制版本目录
 * 仅动态 `import('./upgradeBundle.js')` 不够：它的**静态依赖**（`./service.js` 等）会按源码目录
 * 的旧 URL 命中 ESM cache，热升级实际装载的是旧代码。做法：
 *
 * - 把当前最新源码树（至少 `src/host/**` + `package.json`）**程序化**复制到
 *   `<包根>/.runtime/team-workbench/versions/<srcHash>/`；
 * - 副本内写 `package.json`（`{"type":"module"}` 等）与 `src/host/buildMarker.js`（含 `BUILD_MARKER = srcHash`）；
 * - `upgradeEntry` 从副本目录 `import(pathToFileURL(versions/<hash>/src/host/upgradeBundle.js))`；
 * - 用**可观察证据**证明装载的是新代码：activate 后读 `BUILD_MARKER` 与 `service.workVerify.toString()`
 *   是否含标记（或新导出），标记缺失 → 失败回滚。
 *
 * ## 边界
 * 纯文件系统复制 + 哈希；不改源码树、不重载 workbench、不新建进程。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // …/src/host
const PACKAGE_ROOT = path.resolve(HERE, '..', '..');
const RUNTIME_DIR = path.join(PACKAGE_ROOT, '.runtime', 'team-workbench');

const COPY_ROOTS = Object.freeze([
  'src/host',
]);
const COPY_FILES = Object.freeze([
  'package.json',
  'cordis.patch.yml',
]);

async function hashTree(entries) {
  const hash = createHash('sha256');
  for (const file of entries) {
    hash.update(file.relative);
    hash.update(await fsp.readFile(file.absolute));
  }
  return hash.digest('hex').slice(0, 12);
}

async function listFiles(root, prefix, out = []) {
  const dir = path.join(root, prefix);
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) await listFiles(root, relative, out);
    else if (entry.isFile()) out.push({ relative, absolute: path.join(root, relative) });
  }
  return out;
}

/** 计算当前源码树 hash（不含 node_modules/.runtime）。 */
export async function currentSourceHash() {
  const files = [];
  for (const rel of COPY_ROOTS) await listFiles(PACKAGE_ROOT, rel, files);
  for (const rel of COPY_FILES) files.push({ relative: rel, absolute: path.join(PACKAGE_ROOT, rel) });
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  return { hash: await hashTree(files), files };
}

/**
 * 准备（或复用）版本目录。
 * @param {{ reuse?: boolean }} [options]
 * @returns {Promise<{ok:boolean, code?:string, hash?:string, versionDir?:string,
 *   upgradeBundleUrl?:string, indexUrl?:string, marker?:string, reused?:boolean, files?:number}>}
 */
export async function prepareVersionGraph(options = {}) {
  let snapshot;
  try {
    snapshot = await currentSourceHash();
  } catch (error) {
    return { ok: false, code: 'VERSION_GRAPH_HASH_FAILED', message: String(error?.message ?? error) };
  }
  const { hash, files } = snapshot;
  const versionDir = path.join(RUNTIME_DIR, 'versions', hash);
  const tempDir = versionDir + '.tmp-' + process.pid;
  const existing = await fsp.stat(path.join(versionDir, 'src', 'host', 'buildMarker.js')).then(() => true).catch(() => false);
  if (options.reuse !== false && existing) {
    return {
      ok: true,
      hash,
      versionDir,
      marker: hash,
      reused: true,
      files: files.length,
      upgradeBundleUrl: pathToFileURL(path.join(versionDir, 'src', 'host', 'upgradeBundle.js')).href,
      indexUrl: pathToFileURL(path.join(versionDir, 'src', 'host', 'index.js')).href,
    };
  }
  try {
    await fsp.rm(tempDir, { recursive: true, force: true });
    await fsp.mkdir(tempDir, { recursive: true });
    // 程序化复制（保留目录结构；不复制 node_modules/.runtime）
    for (const file of files) {
      const target = path.join(tempDir, file.relative);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(file.absolute, target);
    }
    // **源复制文件**逐文件 sha 复核（只校验从源码树复制的文件；派生文件 package.json/buildMarker.js
    // 由本函数生成，不能与源逐文件比较——这是 VERSION_GRAPH_COPY_VERIFY_FAILED: package.json 的根因）。
    for (const file of files) {
      const [sourceBuf, copyBuf] = await Promise.all([fsp.readFile(file.absolute), fsp.readFile(path.join(tempDir, file.relative))]);
      if (!sourceBuf.equals(copyBuf)) throw new Error('VERSION_GRAPH_COPY_VERIFY_FAILED: ' + file.relative);
    }
    // 副本自带（派生）package.json 与 module 标记
    const pkg = await fsp.readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8').catch(() => '{}');
    let parsed = {};
    try { parsed = JSON.parse(pkg); } catch { parsed = {}; }
    const copyPkg = { ...parsed, type: 'module', name: `${parsed.name ?? '@local/dsh-team-workbench'}-version-${hash}`, version: parsed.version ?? '0.0.0' };
    delete copyPkg.dependencies;
    delete copyPkg.devDependencies;
    delete copyPkg.scripts;
    copyPkg.exports = { '.': './src/host/index.js', './upgrade-entry': './src/host/upgradeEntry.js', './upgrade-bundle': './src/host/upgradeBundle.js' };
    await fsp.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(copyPkg, null, 2), 'utf8');
    // 可观察标记：副本自己的 buildMarker.js
    const markerSource = `/**
 * 自动生成（versionGraph.prepareVersionGraph）：标识该版本目录来自源码树 hash。
 * 用于证明热升级装载的是**版本目录**里的一份，而不是源码目录的旧 ESM cache。
 */
export const BUILD_MARKER = ${JSON.stringify(hash)};
export const BUILD_SOURCE_ROOT = ${JSON.stringify(PACKAGE_ROOT)};
export const BUILD_VERSION_DIR = ${JSON.stringify(versionDir)};
`;
    await fsp.writeFile(path.join(tempDir, 'src', 'host', 'buildMarker.js'), markerSource, 'utf8');
    // 派生文件已单独生成；原子 finalize（tmp → 正式），避免'标记存在即复用半份目录'。
    await fsp.rm(versionDir, { recursive: true, force: true });
    await fsp.rename(tempDir, versionDir);
    return {
      ok: true,
      hash,
      versionDir,
      marker: hash,
      reused: false,
      files: files.length,
      upgradeBundleUrl: pathToFileURL(path.join(versionDir, 'src', 'host', 'upgradeBundle.js')).href,
      indexUrl: pathToFileURL(path.join(versionDir, 'src', 'host', 'index.js')).href,
    };
  } catch (error) {
    return { ok: false, code: 'VERSION_GRAPH_COPY_FAILED', hash, versionDir, message: String(error?.message ?? error) };
  }
}

/** 读取版本目录的标记（可观察证据）；不一致返回 `VERSION_MARKER_MISMATCH`。 */
export async function verifyVersionMarker(versionDir, expectedMarker) {
  const markerPath = path.join(String(versionDir ?? ''), 'src', 'host', 'buildMarker.js');
  try {
    const stat = await fsp.stat(markerPath);
    if (!stat.isFile()) return { ok: false, code: 'VERSION_MARKER_MISSING' };
    const mod = await import(`${pathToFileURL(markerPath).href}?twb-marker=${Date.now()}`);
    if (mod?.BUILD_MARKER !== expectedMarker) return { ok: false, code: 'VERSION_MARKER_MISMATCH', marker: mod?.BUILD_MARKER ?? null, expected: expectedMarker };
    return { ok: true, marker: mod.BUILD_MARKER, versionDir: mod.BUILD_VERSION_DIR ?? versionDir, sourceRoot: mod.BUILD_SOURCE_ROOT ?? null };
  } catch (error) {
    return { ok: false, code: 'VERSION_MARKER_LOAD_FAILED', message: String(error?.message ?? error) };
  }
}

export { PACKAGE_ROOT, RUNTIME_DIR };
