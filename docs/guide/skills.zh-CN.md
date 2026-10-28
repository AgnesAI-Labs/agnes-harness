# Skills：把团队方法带进每一次任务

[English](skills.md) | 简体中文

[文档导航](../README.zh-CN.md) · [插件开发](../develop/plugins.zh-CN.md)

将项目约定、检查步骤和常用方法整理为 Skill，让 Agent 在任务中使用这些知识。本页从一个工作区示例开始，再介绍来源管理、同名选择和维护方式。

Skill 提供任务说明与资源，不等于执行权限。AGH 发现候选、审核版本、选择同名胜出项，再向会话暴露可用内容；不能只因磁盘上存在文件就声称模型已读取。

## 让 Agent 创作 Skill

例如：“创建一个简单的技能，叫数学老师skill。”Agent 使用 `math-teacher` 等 ASCII 目录标识；`SKILL.md` frontmatter 可以保留中文显示名，必须提供 `name` 和 `description`。

纯说明草稿（`SKILL.md` 及可选的 `.md`、`.txt`、`.json`、`.yaml`、`.yml`、`.csv` 资源，资源不能位于 `scripts/`）只做静态验证。AGH 检查 frontmatter 与调用开关、名称及冲突、文件数量和大小、相对路径及资源完整性，不生成 JavaScript 插件，也不运行 Node 作者测试。安装确认中可审阅名称、描述、文件清单、目标和 SHA256 摘要。完全访问下自动允许冻结修订的安装、信任和启用，也自动允许导入时的来源读取裁决；其他权限级别仍需一次确认。默认安装到工作区，也可选择用户范围或仅安装。等待 `ready` 后在下一轮使用；`installed` 表示仅安装。

脚本、包清单及其他文件类型继续走插件候选 → 作者测试 → 人工发布流程。安装不执行其中脚本，也不授予执行权限。导入已有本地来源仍保留独立的来源读取审批。无效或冲突草稿会被拒绝，不覆盖文件；拒绝、取消、归属失效或 lease 变化都不能授权安装。私有收据保留创作会话、插件快照、内容摘要和资源修订。已安装的 Skill Helper 需要更新后才能使用此流程，助手包不会自动升级。

## 创建一个工作区 Skill

在目标项目（不是必须在 AGH 源码库）创建 `.agh/skills/review-notes/SKILL.md`：

```markdown
---
name: review-notes
description: 只读整理项目说明中的不一致之处
---
先读取 README 与相关说明，列出互相冲突的描述和对应文件。
只提出修改建议，不写文件，不安装依赖。
```

daemon 会监视 Skill 根目录，也会发现启动后新建的文件夹。已登记工作区与 `$AGH_HOME/skills` 中的新磁盘 Skill 自动信任并启用，只放入你信任的说明。修改内容后，已记录的信任/拒绝和启用/禁用决定保留并绑定到新修订；被拒绝或禁用的 Skill 不会因修改自动恢复。Skill 不授予执行权限。空闲会话在下一次请求看到更新，在途轮次保留原快照。

在目标项目运行 CLI，会自动登记当前目录并打印 workspaceId。refresh 是可选的立即重扫，需要确认；无需手填工作区 ID：

```sh
node /path/to/agnes-harness/agnes.mjs skills refresh --yes
node /path/to/agnes-harness/agnes.mjs skills list
```

请替换上面的构建路径；PATH 中已有 `agh` 时可直接使用。指定另一个已登记工作区时加 `--workspace-id WORKSPACE_ID`。`skills list` 打印资源 ID、修订、信任、期望与实际状态。仍可显式执行 `agh skills trust SKILL_RESOURCE_ID REVISION trusted --yes`；启用/禁用用 `agh resources enable|disable SKILL_RESOURCE_ID --expected-revision REVISION --yes`。非 TTY 写操作必须加 `--yes`，只代替确认，不绕过修订校验。

确认 `trust=trusted`、`desired=enabled`、`actual=ready`、`winner`，再在该工作区会话明确说“使用 review-notes 整理项目说明”。当前 Host 对明确提名且唯一匹配的可用 Skill 有预加载路径；模糊描述不是确定性的激活语法。

## 来源与冲突

默认磁盘来源是工作区 `.agh/skills`（也支持工作区 `.agents/skills`、`.claude/skills`）和 `$AGH_HOME/skills`；包也可以贡献 Skill。操作系统用户的 `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills` 默认不导入，包括全新或隔离的 AGH_HOME。只有启动 daemon 时显式设置部署配置 `AGNES_SKILLS_IMPORT_USER=1` 才导入；导入的用户技能同样自动信任，因此只对可信目录开启。`AGH_HOME` 不会重定位其他工具的用户目录。多工作区按会话自己的工作区读取，不以 worker 启动目录替代。

默认优先级如下，数字越大越优先：

| 来源 | 默认值 | 可设置用户覆盖 | 可永久删除 |
| --- | --- | --- | --- |
| 工作区 `.agh/skills` | 500 | 是 | 是，仅所选 Skill 目录 |
| Cordis 运行时贡献 | 450 | 否 | 否，由插件生命周期撤下 |
| `AGH_HOME/skills` | 400 | 是 | 是 |
| 用户 `.agents/skills` | 300 | 是 | 是，可能影响共用它的其他应用 |
| 用户 `.claude/skills` | 200 | 是 | 是，可能影响共用它的其他应用 |
| 用户 `.codex/skills` | 100 | 是 | 是，可能影响共用它的其他应用 |
| 包贡献 | 50 | 是 | 否，通过插件管理处理 |

同名按去除首尾空白并忽略大小写分组；非删除候选先按有效优先级降序，同分按 `sourceId` 排序。`winner` 是解析结果，仍须通过自己的 trust/desired 检查才会 ready。高优先级项未信任、被拒绝或停用时，不会仅因不可用就自动选择低优先级项。

刷新失败可能留下 stale/最近已知内容，不把 stale 当作本次扫描成功。内容修改会保留现有决定并更新绑定修订。

磁盘上的扁平文件无需 YAML frontmatter。例如 `$AGH_HOME/skills/review-notes.md` 内容为 `# Review project notes` 时，名称取文件名 `review-notes`，描述取首个非空标题或文本行（最多 1024 字符），完整 Markdown 保留为正文。空文件与无效的显式 frontmatter 会被拒绝；目录 `SKILL.md` 与打包的 Skill 贡献仍需带 `name`、`description` 的 frontmatter。

技能根里可以是目录 `<name>/SKILL.md`，也可以是扁平的 `<name>.md`。两者同名时目录胜出。安装目录的 `context.json` 支持 `customSkillRoots`（绝对路径）。可在 **设置 → 模型 → 运行配置 → 上下文** 中配置；它们在 `AGH_HOME/skills` 之后按优先级 400 扫描。参见[默认上下文](context.zh-CN.md)。`SKILL.md` 可以设置 `disable-model-invocation`、`user-invocable` 和 `disable`；省略这些字段时模型与用户两侧都允许。daemon 会监视目录中的说明与相对资源文件；`skills refresh --yes` 可立即重扫。细节与不支持的情况见 [MCP 与 Skills 支持范围](mcp-skills-support.zh-CN.md)。

## 在 Web 中管理技能

候选测试保留 [Host 隔离与精确摘要规则](security.zh-CN.md)。完全访问在所有平台自动允许测试，包括没有 OS 隔离的 Windows；`workspace-write` 权限 仍需一次确认。测试本身不发布包。完全访问下提交测试通过的候选，会通过现有发布事务自动安装、信任和启用；其他权限级别保留人工审阅。

完全访问会话中的工具请求也会自动允许 Skill 导入安装、能力范围变更、MCP 注册／启动、询问模式记忆写入及凭据管理确认。每项权限决定记录执行者及 `full-access` 原因。保护路径保留硬拒绝；人工维护的本地插件和可信磁盘 Skill 仍遵循各自文档中的信任路径。

**插件 → 技能**显示技能列表；**插件 → 待审阅**包含“候选”和“反馈记录”。“新建技能”菜单可以让 Agent 起草技能，或查看已有文件夹的导入方法。插件候选提议出现在“待审阅 → 候选”中，助手起草的纯说明技能使用上面的安装确认。打开候选审阅对话框，先查看内容差异与测试证据，再批准发布或拒绝。只有存在待审阅项时才显示数量圆点。

“我的技能”支持按名称和说明搜索。行尾开关与菜单沿用原有启用、信任和删除确认流程。“技能文件夹在哪里？”显示 daemon 实际报告的来源；导入说明链接到其他 Agent 的部署文档，不会修改 daemon 启动时的导入设置。“刷新技能”和“扫描文件夹”沿用原有需要确认的扫描操作。

## 调整同名候选优先级

1. 在 Web 插件 → 技能，选对应工作区并打开 Skill 详情，展开“技术详情”查看来源、当前 winner、被覆盖候选和有效优先级。
2. 展开“高级选项”，在“同名覆盖优先级”输入 **50–500 的整数**，点击**保存优先级**并确认。它只改变该 resourceId 在当前 profile 中的持久覆盖，不改文件内容，也不会启用 Skill。
3. 等待操作完成，重新查看 winner 与 actual。若新 winner 尚未启用，审核后再启用；不要只看优先级保存成功。
4. 当前 Web 页面不提供“恢复默认优先级”。需要执行这一管理操作时，通过 Node 客户端传入 `priority: null`。已有内容 revision 相同也可能有并行优先级修改，因此保存还校验 `expectedPriority`；冲突时刷新，不盲重试。

例如 `AGH_HOME/skills` 的用户候选默认 400、工作区候选默认 500。要使用用户项，可把工作区项降到 350；不要靠双方同为 500 来猜谁会胜出。删除高优先级项后，剩余同名候选可能接替，但不会继承已删项的信任或启用状态。活动轮次持有不可变快照，控制面成功不证明进行中的轮次已经切换；在操作结束后检查下一轮/新会话的实际状态。

## 永久删除一个磁盘 Skill

需要暂时停用时选择“停用”。**“永久删除”会删除选中的 Skill 目录及其中全部文件，不只删除 SKILL.md，也不是移入回收站。** 用户目录可能同时供其他应用使用。

1. 只在隔离实验目录演练；刷新并核对详情中的来源、工作区、内容修订和同名候选。
2. 对 workspace 或 user 来源点击“永久删除”，阅读目录整体删除和同名接替提示后确认。package/runtime 来源不能在此单独删除。
3. 保存 operation ID，等待状态 `succeeded`，核对列表/目录与剩余同名候选。API 返回 receipt 仅表示受理；部分删除后仍可能失败。
4. 若报告 `SKILL_REMOVAL_PENDING`，条目已被阻止重新启用。保留状态，排除文件占用等原因后显式重试删除；不要将失败理解为已恢复原文件。删除操作受理后不支持取消，重启也不是撤销。

后台不接受调用者提供的任意删除路径：从已登记来源与 resourceId 推导目标，核对 workspace 身份、revision、目录与文件身份。过期扫描、符号链接/目录连接、硬链接或路径替换等情况会拒绝；预检失败不会先写删除标记。执行中途失败会保留身份进度与删除标记供受限重试，进度不保存文件内容，不是备份。删除标记跨重启保留，刷新不会把同一个被删 resourceId 自动复活；当前没有恢复已删除 Skill 的接口。

## API、权限与 CLI 边界

这些管理动作可从 Web 或 Node SDK 执行；当前 shell/TUI Skills 命令不包含 `remove` / `priority` 子命令，不能把方法名直接当 CLI 语法。

- `client.skills.remove({ profile, clientId, commandId, resourceId, expectedRevision })` → `_agnes/v1/skills.remove`。
- `client.skills.prioritySet({ profile, clientId, commandId, resourceId, expectedRevision, expectedPriority, priority })` → `_agnes/v1/skills.priority.set`；`priority: null` 恢复默认。
- 两者需要服务端授予的 admin authority 与 `resources.skills.write`；JSON 参数不能授予权限。浏览器管理页通过受约束的同源 BFF 调用，不把管理 SDK 给插件。
- 使用当前实例返回的身份、revision、priority，保存 commandId 和 operation receipt；相同已受理请求使用相同 commandId 查询/重放，删除失败后的新重试则显式发起新操作。用 `client.resources.operation.get({ profile, operationId })` 或 shell `resources operation OPERATION_ID` 查询结果。

合同依据：[资源 Schema](../../packages/protocol/schema/resource-control.json)、[方法与权限](../../packages/resource-control-contracts/src/resource-control.ts)、[Node 客户端](../../packages/sdk/src/resource-control.node.ts)、[持久控制与删除标记](../../packages/resource-control-store/src/skills.ts)、[状态投影](../../packages/resource-control-store/src/skill-state.ts)、[日志准入](../../packages/resource-control-store/src/skill-journal.ts)、[Web 操作](../../packages/resource-control-web/src/admin.tsx)、[Worker 接线](../../packages/resource-control-worker/src/runtime-bootstrap.ts)。原生删除由[Worker 删除实现](../../packages/resource-control-worker/src/skill-remove.ts)调用 system-node 完成。源码链接对应所在文档版本；运行旧产物时应核对相应版本的合同。

## Cordis 运行时贡献

普通受信插件可声明 `inject: ['skills']`，在 `apply` 中使用：

```js
ctx.skills.register({
  name: 'review-notes',
  description: '只读整理说明冲突',
  body: '读取相关说明，列出矛盾与证据，不修改文件。',
})
```

`register()` 返回 disposer，注册随调用方 fiber 清理。动态集合用 `registerProvider(control => ({ skills() { return [...] } }))`；数据改变后调用 `control.invalidate()`，卸载会中止 `control.signal`。服务只允许贡献，不提供列出或读取其他 Skill 的接口。

运行时贡献不进入磁盘 trust/desired 管理流程；其信任来自受信代码。与磁盘刷新、包 Skill 的加载方式区分。相同层级的独立插件重名会失败；同一行替换的后继 fiber 有专门处理，不能概括成允许任意覆盖同名 Skill。

随分发提供的 Skill Helper 插件有自己的安装请求流程；工具可申请，不意味着能绕过用户确认、来源审核和写入边界。子 agent 不能借此申请 Skill 安装。

实现依据：[发现根](../../packages/base/extensions/skills/src/discover.ts)、[候选注册表](../../packages/resource-control-runtime/src/skills.ts)、[Cordis service](../../packages/resource-control-runtime/src/skills-cordis.ts)、[会话预加载](../../packages/host-extensions/src/resources/skill-preload.ts)、[Skill Helper](../../packages/package-manager/bundled-plugins/skill-helper/README.md)。

在 Web 或 TUI 中使用 `/skill invoke NAME ARGUMENTS` 调用允许用户调用的 Skill；上下文页面也提供调用表单。Host 只加载唯一、可信且启用的胜出项；未知、停用或禁止用户调用的 Skill 会被拒绝。参数保留在用户消息中。

包内 Skill 的附件会随获准的运行快照保存。现有规则不支持的文件类型仍会忽略。创作测试在提交审核前，按实际加载器的限制检查支持的附件。已安装的某个 Skill 文档无效、附件无法读取或超过预算时，只将该 Skill 标记为不可用：插件 → 技能页显示原因，不开放残缺正文或附件，服务启动时其他正常 Skill 继续加载。请通过原有审核流程修复并更新包，再重新加载。包完整性校验和快照发布失败仍按原有安全规则拒绝。插件 → 技能页里的运行时 Skill 先按当前插件组合和注册实例筛选，再处理同名竞争。它们由所属插件管理，不能在 Skill 页单独编辑或开关；旧会话仍保留自己固定的插件版本。
