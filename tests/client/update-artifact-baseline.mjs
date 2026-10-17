/**
 * 维护脚本：把当前 `client.js` 的 sha256/bytes 写进基线并追加历史。
 *
 * **只有在确认这次重建是有意的之后才运行**：
 *   node tools/build-client.mjs && node tests/client/update-artifact-baseline.mjs
 *
 * 为什么需要它：`client.js` 是 web-workbench 拥有的构建产物。
 * 基线检测的意义是"产物变了必须有人显式确认"，而不是"永远不许变"。
 * 本脚本会把旧基线推进 `history`，不覆盖历史，因此漂移仍然可追溯。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const artifactPath = path.join(ROOT, 'client.js');
const fixturePath = path.join(ROOT, 'tests', 'fixtures', 'client-artifact.json');

const bytes = readFileSync(artifactPath);
const sha256 = createHash('sha256').update(bytes).digest('hex').toUpperCase();
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

if (fixture.sha256 === sha256 && fixture.bytes === bytes.byteLength) {
  console.log(`baseline already current: sha256=${sha256} bytes=${bytes.byteLength}`);
  process.exit(0);
}

const history = Array.isArray(fixture.history) ? fixture.history.slice() : [];
history.unshift({ sha256: fixture.sha256, bytes: fixture.bytes, at: fixture.capturedAt ?? null, replacedAt: new Date().toISOString() });

const next = {
  ...fixture,
  sha256,
  bytes: bytes.byteLength,
  capturedAt: new Date().toISOString(),
  history,
};
writeFileSync(fixturePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
console.log(`baseline updated: ${fixture.bytes} → ${bytes.byteLength} bytes`);
console.log(`  old sha256 ${fixture.sha256}`);
console.log(`  new sha256 ${sha256}`);
console.log('请在提交信息/验收记录里说明这次重建的原因。');
