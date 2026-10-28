# 让 Agent 创建插件

[English](agent-built-plugins.md) | 简体中文

[作者指南](README.zh-CN.md) · [本地插件](local-plugins.zh-CN.md) · [测试](testing.zh-CN.md)

让能调用工具的模型实现可复用工具或 Skill，并提供确定性测试。内置 Demo 可离线复现显式的 `call <工具> <JSON>` 指令，不会自主设计代码。

Agent 创作的文件走 **候选 → 测试 → 权限裁决 → 发布**。Host 将有界纯文本文件集合写入 profile 的私有 `.authoring-candidates` 区。发现流程不会加载它，即使自定义发现根目录指向候选区内部。创建候选不会安装；完全访问下提交候选可自动发布。

候选作者测试在 macOS/Linux 保留 Host OS 沙箱，只运行独立候选副本；POSIX 沙箱缺失时仍拒绝执行。Windows 仍无隔离。完全访问下所有平台自动允许精确哈希的测试决定；`workspace-write` 权限 仍展示包名、哈希、执行方式、风险和范围，要求一次确认。哈希变化后拒绝旧授权。决定保存在 `candidate-test-audit.jsonl`；测试本身不发布。完全访问下提交通过测试的候选，会自动完成现有安装、信任、启用和运行时激活事务。

会话已解析的权限为 `full-access` 时，全部权限裁决在所有平台自动允许，不再弹出审批。包括候选测试与发布（安装、信任、启用及能力变更）、Skill 导入、MCP 注册／启动、询问模式的记忆写入、工具请求的凭据管理、主体审批和交互式验证器审批。每项决定保留执行者、精确操作绑定和 `full-access` 原因；Trace 与执行证据显示 **自动允许（完全访问）**。其他权限级别保持原有人工审阅流程。

选择 API 或 token 前，先读两条指南共用的[源码生成作者参考](../reference/plugin-author-api.zh-CN.md)。`apply(ctx)` 使用 PluginContext 登记能力，`execute(args, ctx)` 才接收 ToolContext。工作区文件用 `ctx.fs.read/write`（字节或字符串），插件或应用 profile 数据用声明 `capabilities.store: true` 后的可选 `ctx.store`。不存在 `PluginContext.fs.readText/writeText`。

工具需要自带 UI 面板时选 `tool-with-panel`，复用已有模板。当前目录提供该工具时，优先用 `plugin_scaffold({template: "tool-with-panel", name: "my-agh-plugin"})` 初始化一次，保存完整清单、客户端和测试。指南的 `previewFiles` 缺少部分文件，不能手抄为候选文件树；仅当本次请求实际提供 `run_code` 时，也可通过它将指南中完整的 `files` 数组传给 `plugin_helper_create`。候选已经存在时，在同一候选补齐 client、描述符和测试。读取候选后，用 `mode: "merge"` 仅写变化文件，未改清单、客户端与测试自动保留；creator 指南提供可执行 cell 示例。每次修改都会清空旧测试，最终证据必须是最终 `candidateHash` 的 `plugin_test`。

使用 `@agnes/host/author-testkit` 的 `createPluginTestHost(main)` 做真实 Host 登记及 `host.invoke(name, args)` 调用测试，需要 I/O 时通过 `options.context` 提供明确的调用端口。手造 PluginContext mock 不能证明安装成功。使用受控候选 runner；`node --test` 管道接 `tail` 会隐藏测试退出码。后端测试不能证明浏览器外观。

`tool-with-panel` 是完整的小型待办示例：React ESM 导入、profile 页面、声明的 query/effect 服务，以及共享 owner store 持久化。继承的测试通过真实客户端门面验证 DOM 添加、勾选与错误，并验证 Host 重建后数据保留。请用[作者参考](../reference/plugin-author-api.zh-CN.md)和模板，只用公开作者 API、授权工作区文件及 artifact 引用；禁止翻查宿主或安装源码、其他工作区、环境变量和凭据，不做全盘搜索。浏览器没有 `ctx.tools.invoke`，应使用 `ctx.profile.services` 并在 `client.services` 声明精确名称。`present` 接受工作区文件系统路径，不能传 `artifact://` 引用。

## 免密钥 Demo 练习

沿用[快速上手](quickstart.zh-CN.md)的独立 home 和工作区，在 Web 新建 **Demo** 会话，提交 `create a plugin` 并确认保存候选的工具审批。Demo 复制版本匹配的文本统计示例，不会根据需求设计新代码。`agh -p` 没有交互审批处理器，创作调用会被拒绝；不要通过放宽策略绕过。

在候选列表审阅生成的源码和测试，记下返回的 `proposalId`（即 `candidateId`），然后在同一个 Web 会话依次提交以下消息，把 `CANDIDATE_ID` 换成实际值，并在当前权限预设要求时确认唯一的精确摘要测试执行卡：

```text
call plugin_helper_install {"action":"test","proposalId":"CANDIDATE_ID"}
call plugin_helper_install {"action":"commit","proposalId":"CANDIDATE_ID"}
```

确认候选为 `state: review`、`tests.state: passed` 且 `tests.count >= 1` 后，再使用下方 CLI 审阅命令。`draft` 的 `reviewHash` 为 `null`，不能直接批准。发布后在新会话提交 `call my_text_stats {"text":"hello world"}`，预期结果为 `{"characters":11,"words":2}`。也可按[成长演示](../../examples/demos/growing-skills/README.zh-CN.md)运行独立的离线练习。

默认 **Plugin Helper** 提供四个工具：

1. `plugin_helper_guide`（`kind: tool|tool-with-panel|skill|skin`）返回版本匹配的 JavaScript 模板和 Node 合同测试。实现需求后，加强测试，包括无效输入。
2. `plugin_helper_create`（`files: [{path, content}, …]`）仅写 Host 候选区，返回 `proposalId`（候选 ID）、`candidateHash` 和 `draft` 状态。创建沿用内置 scaffold 的文本候选合同，支持其 TypeScript 面板模板；不会执行生命周期脚本。
3. `plugin_helper_install`（`action: test`、`proposalId`）按上述会话策略裁决后，对该摘要的私有副本执行 Node 作者测试。`action: commit` 提交通过的结果供审阅；`action: status` 查询持久候选。Commit 在完全访问权限下自动发布；其他权限级别提交人工审阅。旧 onboarding proposal ID 需重新创建候选。

新创作 Markdown 的 `skill_helper_create` 同样保存为可审阅的 Skill 包候选；`skill_helper_install` 对候选 ID 使用 test/commit/status。创作包在此 profile 发布；代码按会话固定，已批准的 Skill 资源实时刷新；create 不再接受原 workspace/user 范围与仅安装参数。已有 Skill 导入保留 workspace/user 导入审批流程。

4. `plugin_helper_write` 是 `plugin_candidate_write` 的别名，接受相同的 `candidateId`、必填 `expectedHash`、`mode`、`files` 和可选 `remove`。

内置 `agnes/plugin-creator` 扩展另有 `plugin_scaffold`（tool、tool-with-panel、mcp-skills、model-adapter、loop、skill）、`plugin_candidate_read`、`plugin_candidate_write`、`plugin_test` 和 `plugin_install_local`。写入须以旧 `candidateHash` 为 `expectedHash`；推荐 `mode: "merge"` 保留未改文件，默认 `replace` 替换完整文本树；`plugin_install_local` 只提交测试通过的摘要，不将代码复制到发现根目录。

两组工具共用同一个由 Host 绑定的候选服务：`plugin_helper_create` 创建的草稿可以继续由 `plugin_candidate_read` 和 `plugin_candidate_write` 编辑，沿用原候选 ID 与当前哈希。Host 记录真实调用包、代码快照（内置工具使用该会话固定的代码代际）、行与行级 lease，并检查每次工具调用的生命期。子代理、已取消或过期的调用以及缺少当前 owner 授权的调用不能使用此端口。内置作者工具的错误回执标明操作、阶段、候选 ID，并区分宿主能力不可用、权限拒绝、哈希过期和验证失败。能力不可用不表示管理员关闭了作者功能；保留草稿并报告实际失败的操作。

## 按证据报告并交付完整包

推荐路径为 **指南 → 创建一次 → 读取／编辑同一候选 → 精确摘要测试 → 提交人工审阅**：先用 `plugin_helper_guide`、`plugin_helper_create`，再用当前工具目录中的 `plugin_candidate_read/write`、`plugin_test`、`plugin_install_local`。`plugin_creator_guide` 提供相同路径；`plugin_scaffold` 是初始模板步骤的替代入口；当前目录提供它时，也推荐用它保存完整面板模板。`plugin_helper_install test/commit/status` 保留为同一服务的兼容别名，`proposalId` 就是原候选 ID；commit 只提交审阅。指南中的 Host 端口 supplied 仅表示已提供端口，每次调用仍须授权。

复述实际回执的 `operation`、`stage`、`candidateId`。创建成功、随后 write 返回 `unavailable-host-capability` 时，应说草稿已创建、**write** 失败，保留同一草稿并在继续前读取当前摘要。后续阶段失败不意味着创建失败；除非人工明确要求新草稿，否则不要重复创建。不得推测“管理员关闭”或编造设置开关，也不得用 shell／配置修改绕过拒绝。

候选工具摘要中的 `verification` 是保守的展示投影，不是新的持久状态。各阶段分别报告：

| 阶段 | 所需证据 |
| --- | --- |
| 草稿生成 | 成功创建回执中的候选 ID／摘要 |
| 结构验证 | 明确且无 blocker 的检查证据，例如提交审阅后的 preview 或成功打包；单纯 draft 回执不包含此证据 |
| 候选测试通过 | `tests.state: passed`、摘要一致且至少执行一个测试 |
| 安装验证 | 实际安装／运行状态；`published` 回执包含运行时确认 |
| 浏览器／外观验证 | 已安装皮肤的亮暗模式观察，以及禁用并恢复默认外观 |
| 已发布 | 人工审阅后实际 `state: published` 回执 |

皮肤模板的 Node 测试仅检查入口、清单、描述符与资产结构。JSON／路径／CSS 字符串断言不能证明安装或外观。候选回执始终将浏览器外观标为“未验证”；后续浏览器检查须单独报告证据。本会话无法运行时，明确说明“浏览器／外观未验证”，请人工检查亮暗模式和禁用恢复。不能仅据源码测试说“皮肤本身没问题”。

给出安装命令前，核实实际 CLI 可执行文件／版本／帮助、有效 `AGH_HOME`、profile 和 daemon 启动工作区，不展示凭据。本版支持 `agh dev <plugin-folder>`、`agh plugins add`、`agh plugins pack`。dev 的目录须位于 daemon 启动工作区下，并走正常管理审阅；这不授权代理自行安装，也不存在通用的“必须停服务”前提。

承诺下载成品时，用 `plugin_candidate_read` 读取同一候选／摘要的**全部** `sourceFiles`；分页 JSON 须先完整重组。通过普通、已授权的工作区写入，将每个文件按相对路径复制到新目录，位置须在发现目录及 AGH 私有 home 之外。不得执行入口或包生命周期脚本。随后使用核实后的现有命令：

```sh
agh plugins pack <staging-folder> <new-output.tgz>
```

该命令调用 `plugin-pack.ts`，验证发行树并生成目录压缩包。皮肤须包含 `package.json`、`index.mjs`、描述符及全部相对资产；打包还会添加由打包清单选择的 bundle 入口。输出放在 staging 目录之外。打包成功后，调用 `present`，参数为 `files: [{path: "<workspace-output.tgz>", description: "完整插件包；安装及外观需分别验证"}]`，提供一个持久下载（上限 32 MiB）。零散 CSS／JSON 卡片和 `candidate-source.json` 只是源码预览，不是可安装包。工作区写入、pack 或 present 不可用时，明确交付未完成并保留候选。下载不代表安装、信任、启用或发布；人工仍通过现有管理流程完成。

更新后的 Host 重新装配工具时才获得此绑定。已经运行的 worker 在正常重启前继续使用原装配能力；保留会话仍沿用原代码 pin，重新打开不会改写 pin 或升级固定的工具代码。原候选与哈希保持可读，helper 创建的草稿也适用。本次更新不会清理草稿或自动发布。

大包分步构建，每次回复的新文件文本最多 8 KiB，每次完成一个文件。读取同一候选后，用 `mode: "merge"` 仅写变化文件，`remove` 显式删除。只有本次请求实际提供 `run_code` 时才可用它自动编辑；目录元数据不能证明可用性。发生 `OUTPUT_LIMIT` 后，读取原候选并用更小片段接续，未完成调用已被丢弃。最终摘要须重新测试后再提交审阅。

在 **插件 → 待审阅 → 候选** 从列表选择草稿；状态标签区分待审阅、已拒绝和已发布。摘要显示插件、来源会话与轮次、测试结果及新增权限。逐个展开文件查看新增和删除行，长文件在差异区域内滚动。默认收起的 **技术详情** 包含候选、已安装基线、审阅和测试运行的摘要，原始能力变化、会话／工具 ID 及测试输出。检查改动时，审阅页底部保持 **批准发布** 和 **拒绝** 可见。

先看源码再运行测试：候选作者测试使用上文说明的 Host 沙箱，剥离环境、限制时间和输出并支持取消。发布后的后端插件仍为进程内受信代码。运行器使用 Node 24 与公开作者 SDK，不运行包生命周期脚本，不将 Markdown 当命令；至少一个实际执行的测试通过后才能提交。

提交后，在现有确认弹窗中选择 **批准发布** 或 **拒绝**。审批同时绑定候选摘要与不可变审阅摘要。草稿编辑、审阅副本损坏、已安装基线改变都会拒绝旧审批；须重新测试并提交。失败测试、已拒绝候选不能发布。新增能力须遵守部署的正常能力策略并获得新的人工审批。

CLI 审阅：

```sh
agh plugins candidates list --json
agh plugins candidates show <candidate-id> --json
agh plugins candidates approve <candidate-id> --candidate-hash <sha256> --review-hash <sha256>
agh plugins candidates reject <candidate-id> --candidate-hash <sha256> --review-hash <sha256>
```

两个摘要均取自实际审阅的记录。CLI 不会悄悄批准编辑后的最新草稿。App Server 提供 `_agnes/v1/plugins.candidates.{list,show,create,write,test,submit,approve,reject}`；create/write 仅供 Host 标记的作者通道，Agent 无法自行批准／拒绝。协议 schema 维护这些方法及持久来源字段。

发布走正常包安装／更新、信任、启用和代际协调。只有运行时确认审阅摘要已 running，才能返回 `published`。新会话获得插件代码，旧会话保留固定代码代际。已批准的 Skill Markdown 属于实时资源，也可在旧会话中变为可见。来源保留 `installer=agent`、作者会话／轮次及审阅者。失败或中断的发布不自动重放；先检查实际包状态，再创建新候选。

Markdown Skill 是包内数据，全文与插件快照一起审阅。Skill 提及的脚本仍需普通工具审批。人工维护的[本地插件](local-plugins.zh-CN.md)与[热重载](hot-reload.zh-CN.md)继续作为明确的开发者信任路径；作者 helper 不向其中写草稿。已授权 shell 仍拥有正常文件系统权限。

候选只含文本（最多 64 文件、每文件 128 KiB、总计 256 KiB），每 profile 最多 128 个持久候选。创建失败会清理未发布的树；不可读或已损坏的记录会从列表隔离；没有有效记录的未完成目录不占持久候选配额。二进制资产和依赖安装走普通作者／包工作流；目前没有候选垃圾回收命令。内置实现位于 `packages/package-manager/bundled-plugins/plugin-helper`；creator 资源生成命令为 `node packages/base/extensions/plugin-creator/gen-assets.mjs`。

Web 优先显示待处理候选，已发布、已拒绝和已中断的审阅放在折叠历史中。发布成功后关闭详情，并显示已安装技能或插件的链接。终态详情保留文件与来源，不再显示批准/拒绝按钮。

作者回执通过有界、白名单化的 `diagnostics` 提供原因代码、包内相对路径、字段、出错名称与修正提示。校验与测试失败会在普通工具文本中展示可操作的诊断；测试输出经过脱敏，超限带有 `[truncated]` 标记。读取同一候选（仅在实际提供时可通过 `run_code`）可检查完整但仍受长度限制的 `tests.output`；测试通过时回执保持简洁。超时和进程非零退出会通过相同脱敏路径保留有界的部分输出；即使其中包含通过的 TAP 文本，也仍记为测试失败。

`candidate.write` 支持显式 `mode: "merge"`：`files` 中的文件新增或替换，`remove: [paths]` 删除已有文件，其他文件保留。`files: []` 支持仅删除。同一路径同时出现在两组中，或删除不存在的路径，分别以 `conflicting-write-path`、`missing-remove-path` 及包内路径拒绝。必填 `expectedHash` 绑定当前完整树，返回新的完整树摘要；所有路径、文本、文件数及字节上限仍应用于合并后的树。默认 `mode: "replace"` 保留整树替换兼容性，不接受删除列表，须包含所有要保留的文件。

`writeSummary` 列出新增、删除、修改文件及声明入口、缺失文件。草稿可以不完整；删除清单或入口会警告，test/submit 拒绝。重复内容或拒绝提示先读候选／诊断，不设重试上限。每次成功写入仍清空测试和人工审阅证据。
