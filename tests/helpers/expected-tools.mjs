/**
 * 工具名基线（单一来源）。
 *
 * 所有用例都从这里**派生**计数与集合，禁止在用例里硬编码数字：
 * 以后再加一个 `team_*` 工具，只需要更新
 * `tests/fixtures/dsh-tool-names.json`，而不是去改一堆断言。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TOOL_BASELINE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/dsh-tool-names.json', import.meta.url)), 'utf8'),
);

/** 官方工具（inspection 实测）。 */
export const OFFICIAL_TOOLS = Object.freeze([...TOOL_BASELINE.official]);
/** 本插件注册的 `team_*` 工具（权威清单）。 */
export const TEAM_TOOLS = Object.freeze([...TOOL_BASELINE.pluginTeamTools]);
/** 已被官方占用、本插件不得重复注册的名字。 */
export const RESERVED_OFFICIAL_TEAM_NAMES = Object.freeze([...TOOL_BASELINE.reservedOfficialTeamNames]);
/** 不是工具、但可能出现在技能正文里的合法标识符。 */
export const NOT_TOOLS = Object.freeze([...TOOL_BASELINE.notTools]);

/** 期望的 `team_*` 工具数量（派生，不硬编码）。 */
export const EXPECTED_TEAM_TOOL_COUNT = TEAM_TOOLS.length;
/** 全量真实工具名集合。 */
export const ALL_TOOL_NAMES = Object.freeze([...OFFICIAL_TOOLS, ...TEAM_TOOLS]);
export const ALL_TOOL_NAME_SET = new Set(ALL_TOOL_NAMES);

/** 与真实 `registerTools()` 结果做集合比较（顺序无关）。 */
export function compareToolSets(actual) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(TEAM_TOOLS);
  return {
    actualCount: actual.size ?? actual.length,
    expectedCount: EXPECTED_TEAM_TOOL_COUNT,
    missing: [...expectedSet].filter((name) => !actualSet.has(name)),
    unexpected: [...actualSet].filter((name) => !expectedSet.has(name)),
  };
}

export default {
  TEAM_TOOLS,
  OFFICIAL_TOOLS,
  RESERVED_OFFICIAL_TEAM_NAMES,
  ALL_TOOL_NAMES,
  EXPECTED_TEAM_TOOL_COUNT,
};
