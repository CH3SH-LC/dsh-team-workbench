/** Standalone product contract: real entry point and role injection without an external skill bundle. */
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { loadHostModule } from './helpers/host-loader.mjs';
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createFakeAdapter } from './helpers/fake-adapter.mjs';
import { createFakeContext } from './helpers/fake-ctx.mjs';
import { normalizeConfig } from '../src/host/config.js';

const CONTRACT_TOOLS = [
  'team_mission_assign', 'team_plan_submit', 'team_dispatch_authorize',
  'team_subagent_start', 'team_ask_owner', 'team_work_verify', 'team_plan_cancel', 'team_member_inbox',
];
export const meta = { id: 'standalone-contract', title: '独立包：真实入口、无外部技能依赖、角色注入与费用unknown', requires: ['index', 'skills'] };

export async function run() {
  await loadHostModule('skills');
  const entry = await loadHostModule('index');
  return runSuite(meta, async (suite) => {
    suite.assert(entry.real, '生产入口可加载', entry.error?.message);
    if (!entry.real) return;
    const defaults = normalizeConfig({});
    suite.deepEqual(defaults.usage.priceBook.entries, [], '默认价目表为空，不沿用私人费率');
    suite.equal(defaults.usage.sourcePath, null, '默认不绑定任何本地审计路径');
    const clock = createFakeClock();
    const native = createFakeAdapter({ clock });
    const ctx = createFakeContext({ adapter: native, clock });
    ctx.removeService('skills');
    delete ctx.skills;
    const scoped = new Map();
    const systemPrompt = {
      getSectionOrder: () => 600,
      section(row) {
        if (scoped.has(row.name)) throw new Error(`Duplicate agent section ${row.name}`);
        scoped.set(row.name, row);
        return () => scoped.delete(row.name);
      },
    };
    const leader = native.agentFor('session-lead');
    leader.ctx = { get: (key) => key === 'systemPrompt' ? systemPrompt : undefined };
    const dispose = entry.mod.apply(ctx, {});
    try {
      for (let i = 0; i < 30 && !scoped.has('team-workbench.role.leader'); i += 1) await clock.flush(20);
      suite.equal(ctx.get('skills'), undefined, '场景确实没有skills服务');
      suite.assert(scoped.has('team-workbench.role.leader'), '无skills服务仍注入leader角色');
      suite.assert(scoped.has('team-workbench.routing-anchor'), '无外部技能仍注入通用路由锚点');
      const promptText = [...scoped.values()].map((row) => row.text).join('\n');
      suite.assert(!/myworkflow-|skill\(name=/.test(promptText), '角色提示词不要求加载未安装的工作流技能');
      suite.deepEqual(CONTRACT_TOOLS.filter((name) => !ctx.tools.get(name)), [], '成员自治合同工具均真正注册');
      suite.equal(ctx.registries.skillProviders.size, 0, '工作台不冒充外部技能provider');
      suite.equal(ctx.registries.sections.size, 0, '角色提示词只注入agent作用域');
    } finally {
      await dispose();
      await ctx.dispose();
    }
    suite.equal(scoped.size, 0, '卸载清理agent作用域角色和路由段');
  });
}
if (isMain(import.meta.url)) await main(run, meta);
