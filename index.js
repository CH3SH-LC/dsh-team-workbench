/**
 * @local/dsh-team-workbench — Host half.
 *
 * 这里只做入口转发：真正的实现分在 `src/host/*.js`。
 * 本插件刻意不声明 `Config` schema 并且不 import 任何非 `node:` 内建模块，
 * 因此它在没有 `@deepseek-ai/*` 解析路径的 profile 里也能加载。
 * 行配置原样传入 `apply(ctx, config)`，由 `src/host/config.js` 归一化。
 */
import { apply as applyHost, inject as hostInject, name as hostName } from './src/host/index.js';

export const name = hostName;
export const inject = hostInject;

/**
 * Host entry.
 *
 * @param ctx Cordis Context of this plugin row.
 * @param config Raw row config from `cordis.patch.yml` (already merged by the Loader).
 */
export function apply(ctx, config = {}) {
  return applyHost(ctx, config);
}
