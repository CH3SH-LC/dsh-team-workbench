# DSH Team Workbench · 超级工作台

[English](README.en.md) · [使用指南](docs/USAGE.md) · [配置](docs/CONFIGURATION.md) · [架构](docs/ARCHITECTURE.md)

DeepSeek Harness 的非官方插件：在一个主窗口中以 **1／2／4 窗**查看真实会话，并用持续存在的模块成员组织并行工作。

团队组织方式是 **leader → 模块成员 → 成员自己的子智能体**。leader 给目标和边界，成员自己规划、拆解与授权派发；Host 调度器在依赖满足、容量释放后继续启动已授权工作。

本仓库独立提供工作台与团队运行时，**不包含、也不要求安装 myworkflow 技能包**。

## 能做什么

- **多会话工作台**：切换 1／2／4 窗，保留各会话的草稿与阅读位置，使用 DSH 原生对话组件。
- **模块成员自治**：持久模块委托、成员计划、版本化派发授权、成员收件箱与成果验收。
- **持续补位**：已授权的独立工作按依赖和容量推进，不等待整批结束；保留恢复和交互余量。
- **可追溯交付**：区分产出与验收，关联执行记录、产物哈希、验收条件和未完成事项。
- **运行状态**：查看成员决策、等待原因、任务、用量、费用估算及错误记录。未配置价格或缺少数据时显示未知。

窗格直接绑定工作区主会话；成员和子智能体通过该会话的“子会话”菜单进入。窗口数与并发执行数相互独立。写范围协调也不等于文件系统隔离。

## 兼容范围

已调查的接口基线是 **DSH 0.2.0-rc.2**。前端依赖该版本的 Session、slot、原生对话组件与布局接口；后续版本需重新核对。

团队执行要求当前 profile 已启用 DSH 原生实验性 Agent Team，并提供可用的 continuable 子智能体 provider。缺失能力时插件会给出诊断，不能把“插件加载成功”视为团队可运行。

此发布提供生产模块的自动化测试、模拟原生接口的集成检查、打包检查及 CI 配置。**它们不构成所有 DSH 版本、操作系统或真实模型的运行认证**。真实安装、多窗和团队行为按[验收说明](docs/ACCEPTANCE.md)另行核实。

## 安装

在装有 DSH CLI 的环境中：

```sh
dsh plugin add github:CH3SH-LC/dsh-team-workbench#v1.0.0
```

如需指定已有 profile，例如 `desktop`：

```sh
dsh plugin --profile desktop add github:CH3SH-LC/dsh-team-workbench#v1.0.0
```

请确认安装目标与实际启动的 DSH profile 相同。安装方式遵循 [DSH 官方 bundle 文档](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)。

也可安装本地源码目录或已打包的 `.tgz`。在 DSH 创造模式中，使用原生插件管理工具：

```text
plugin_manager(action="install_bundle", target="github:CH3SH-LC/dsh-team-workbench#v1.0.0")
```

本地安装时将 `target` 替换为本机源码目录的绝对路径。工具行为以[官方 plugin-manager 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)及当前 DSH 版本为准。

**配置影响**：本 bundle 将原生 `subagent` 行设为 `maxDepth: 2`、`maxActiveSubagents: 40`。这会影响同一 profile 中使用该服务的其他任务，不只是工作台。安装前核对已有覆盖配置；详见 [配置说明](docs/CONFIGURATION.md)。没有模型配额或速率限制随安装自动增加。

安装后查看插件加载结果，在侧栏打开“超级工作台”。若当前版本要求重载或重启，应先保存并妥善结束活跃任务，再按 DSH 提示操作。

## 开始使用

可在一个新的 DSH 会话中提出完整目标，例如：

> 创建一个小型游戏内容包。建立敌人内容与装备内容两个模块成员，每个成员交付四个完整对象。成员自行决定对象设计、计划和子任务，独立交付设计说明、结构化数据及验证结果。按完整对象并行，不拆成调研、开发、检查接力。先限制并发，确认流程正常后再调整。

模型侧的推荐路径：

1. leader 用 `team_define`、`team_member_create` 建立团队，再用 `team_mission_assign` 委托模块目标。
2. member 用 `team_plan_submit` 决定自行执行或委派，提交自己的计划，再用 `team_dispatch_authorize` 授权需要派发的工作。
3. Host 调度器启动可执行项；成员通过收件箱和回执继续处理自己的模块。
4. 产物提交后，由 owner 核验。需要可执行验证时使用 `team_exec_check` 记录结果，再由 `team_work_verify` 对照验收条件作出结论。

简单请求可以直接完成，不必创建团队。完整说明见 [使用指南](docs/USAGE.md)。

## 开发与贡献

开发需要 Node.js **22 或更新版本**。源码目录中运行：

```sh
npm run build
npm test
npm run check:package
```

修改前阅读 [贡献指南](CONTRIBUTING.md)。测试在完整源码 checkout 中运行；发布的 `.tgz` 是运行时包。前端生成文件应由构建脚本生成；不要只修改 `client.js`。公开问题报告请去除私有路径、会话正文、账号标识和凭据。

## 文档

- [使用指南与工具分工](docs/USAGE.md)
- [配置、容量和数据位置](docs/CONFIGURATION.md)
- [架构与运行约束](docs/ARCHITECTURE.md)
- [真实 DSH 验收清单](docs/ACCEPTANCE.md)
- [发布流程](docs/RELEASE.md)
- [更新记录](CHANGELOG.md)

## 许可证

[MIT](LICENSE)。本项目由社区独立维护，与 DeepSeek 官方没有隶属或背书关系。
