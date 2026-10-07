# 插件安装、启用、更新与清理

[English](packages.md) | 简体中文

[文档导航](../README.zh-CN.md) · [开发插件](../develop/plugins.zh-CN.md)

本页带你走完一个插件从检查、安装到更新和卸载的过程。先使用仓库自带的文本统计插件，跑通后再换成自己的包。

## 分享与安装

安装插件无需手抄信任哈希：

```sh
agh plugins add /ABS/DOWNLOADS/hello-tool.tgz
agh plugins add ../hello-tool
agh plugins add https://example.com/team/hello-tool.git
agh plugins add https://example.com/hello-tool.zip
```

命令显示来源、内容摘要、能力哈希、能力范围、警告与阻断项。确认 `plugins add` 后安装、信任并启用核对过的确切版本。已明确授权的脚本可用 `--yes`；未确认的非交互调用会报出原因，并提示使用 `--yes`。旧的 `agh install` 仍保持未信任、停用。`agh plugins trust <id>` 自动读取已安装版本的哈希供确认，`agh plugins enable <id>` 启用前再次展示能力。

管理页的“从来源安装”支持本地路径、Git URL 和归档 HTTPS 地址。本地路径指向 daemon 所在机器。`file:` 接受绝对路径、daemon 工作区外的文件夹、相对文件夹、`.tgz`/`.tar.gz`/`.tar` 与 ZIP。显式的相对 `file:` 仍从 daemon 工作区解析；CLI 裸路径从 CLI 当前目录解析。来源不能是符号链接。归档可直接包含包，或用单个目录包住它；越界路径、链接、特殊文件与过大的归档会被拒绝。HTTPS 下载不跟随重定向、不接受 URL 凭据。

Git URL 可省略提交，或用 `#` 指定分支/标签。检查时固定提交，安装时校验预览内容摘要。Git 仓库必须包含可安装的插件入口与运行产物；获取过程不执行安装脚本。

分享时连同第三方 JavaScript 依赖一起打包：

```sh
# 作者先安装依赖；exports 指向 dist/ 时先构建。
agh plugins pack /ABS/PLUGIN/hello-tool ./hello-tool.tgz
# 朋友的机器：
agh plugins add ./hello-tool.tgz
```

`pack` 校验静态清单，打包后端和声明的前端入口，保留第三方法律注释及许可证/NOTICE，输出 `package/` 格式 tarball。`agnes.hostProvidedExternals` 声明的 Host SDK 由 AGH 提供，不重复打入包；旧包保留 Agnes SDK 外部导入。朋友无需作者的 `node_modules`、源码目录或能力哈希。支持静态 JavaScript/TypeScript 导入；原生插件与读取未声明动态文件的依赖需要作者准备可分发产物。打包不执行插件代码、测试或安装脚本；输出文件不能已存在或位于来源目录内。

## 能力声明

在 `package.json` 中声明请求范围。本地插件、代理生成的插件和普通安装包使用同一份声明：

```json
{
  "agnes": {
    "plugins": [{ "apiRange": "^1.4.0", "export": "main" }],
    "capabilities": {
      "network": ["api.example.com", "*.example.org"],
      "filesystem": { "read": ["workspace/reports/*"], "write": ["workspace/output/*"] },
      "exec": ["node"],
      "secrets": ["weather-api-key"],
      "credentials": ["example-account"],
      "model": true,
      "childAgents": true,
      "ui": true
    }
  }
}
```

只写名称与范围，不写秘密值。字符串列表支持 `*`；文件范围可用绝对路径、相对路径或以工具 cwd 为根的 `workspace/` 路径。布尔值声明模型、子代理或 UI。空对象表示没有请求；省略字段的旧插件显示“未声明”。修改声明会改变信任哈希，需要重新审核。

管理员可在 profile 的 `agnes-lock.json` 旁创建 `plugin-capabilities.json`：

```json
{
  "allow": ["network:*.example.com", "filesystem.read:workspace/*", "model", "ui"],
  "deny": ["exec:*", "secrets:*", "credentials:*"]
}
```

策略词汇为 `network:<host>`、`filesystem.read:<scope>`、`filesystem.write:<scope>`、`exec:<command>`、`secrets:<name>`、`credentials:<name>`、`model`、`childAgents`、`ui`。省略 allow 表示除 deny 外均允许；空 allow 表示全部拒绝。deny 优先，宽泛请求不能绕过更窄的拒绝规则。错误策略拒绝操作。检查、安装、信任与启用读取同一策略；后续收紧策略会阻止不符合要求的包进入新激活，不删除其数据。

这是社区信任模型：能力声明用于审核受信任代码，不构成隔离沙箱。Host 在工具 exec/沙箱启动、网络 fetch、文件访问边界记录未声明使用，不记录命令参数、目标或秘密值。现有沙箱与网络授权仍决定是否执行。直接使用 Node API、插件初始化和注入服务内部的调用不在该观察范围内。

## 排障

每个 `agnes.plugins` 条目都必须声明经过测试的扩展 API `apiRange`（例如 `^1.4.0`）。新安装和更新会在导入插件代码前拒绝缺失或不兼容的范围，不会根据当前 Host 版本推断范围。

缺少声明的旧安装包仍显示在列表中，带有 `incompatible` 阻断及 `plugin-api-range-required` 引用；不能信任、启用、激活或用作回滚目标。包文件和锁条目保留，支持更新或删除。迁移时，获取兼容的新版本，或在作者源码的每个插件条目中添加经过测试的范围，按需重新构建或打包，然后使用**从新来源更新**（也可以删除后重装）。启用前重新审核完整性和信任声明。不要直接编辑安装缓存或锁文件，否则完整性校验会失败。此前安装的官方助手也需要这样更新；重启或重新构建 AGH 会保留已固定的旧快照。

失败状态携带简短修复建议和文档链接。管理页详情提供“修复指南”，CLI 失败也显示建议。

| 失败 | 修复 |
| --- | --- |
| 缺少导出 | 导出 `agnes.plugins` 指定的函数，核对 `package.json.exports`。 |
| API 范围不兼容 | 安装兼容版本，或更新 Host。 |
| 缺少 inject | 安装并启用必需服务的提供者。 |
| Schema 错误 | 按 schema 修正清单或配置。 |
| 能力被策略拒绝 | 核对声明及 allow/deny；经授权修改后重试。 |
| 前端加载失败 | 重新构建前端，核对声明路径，再刷新页面。 |
| 激活失败 | 查看入口与激活日志，修复包后重试。 |

## 开箱可用的助手插件

AGH 默认提供四个官方助手插件。新建本地配置，以及已有配置首次升级到支持默认助手的版本时，会自动安装、信任并启用尚未安装的助手，无需联网下载：

| 插件 | 用途 |
| --- | --- |
| `@agnes/skill-helper` | 在会话中创建、导入和安装 Skill |
| `@agnes/mcp-helper` | 在会话中准备和接入 MCP，查询真实连接状态 |
| `@agnes/plugin-helper` | 在会话中创建工具或 Skill 插件、检查包，并在确认后安装启用 |
| `@agnes/document-reader` | 读取 PDF 文字与页面图片、扫描 PDF、DOC、DOCX 和 ZIP 中选定的文件；OCR 在本地离线运行 |

已安装的插件使用固定快照，重新构建或重启应用不会覆盖旧快照。要使用 `@agnes/document-reader` 0.1.2 的 PDF 按页看图和改进后的 ZIP 读取能力，请在 Web 插件管理中选择该包的“从新来源更新”，来源填写新构建应用的 `file:./bundled-plugins/document-reader`，核对预览后按正常更新和激活流程完成。

四个助手出现在“设置 → 插件管理 → 已安装”，可以禁用或卸载。后续启动与升级尊重你的选择，不自动恢复；移除助手插件不会删除它先前创建或接入的插件、Skill 或 MCP。安装第三方能力仍需要相应确认。

从只有 Skill/MCP Helper 的版本升级时，补装 Plugin Helper 和 Document Reader，不恢复此前已移除的旧助手。从三个助手的版本升级时，只补装 Document Reader。已有同名插件保留原版本和启用/信任状态。首次默认安装完成后，主动移除的助手可在“发现”中重新安装。首次初始化受部署策略约束，失败时保留记录，恢复后继续处理，不把失败标记为已启用。

## 管理其他插件

| 阶段 | 你要确认什么 |
| --- | --- |
| 检查与安装 | 来源、版本、内容摘要与能力声明是否符合预期 |
| 审核与启用 | 是否允许这一版代码在当前实例中提供能力 |
| 核对实际状态 | 相关后端行是否 ready，前端贡献是否在页面加载 |
| 更新或移除 | 新版本是否生效，旧能力是否正确撤下 |

安装成功后默认保持停用。AGH 仍会在内部记录审核通过的版本和能力范围，再进入激活流程。`desired` 表示期望启用状态，`actual` 表示实际运行状态；分别查看它们，才能区分“已提出请求”和“已经可用”。

## 插件类型、状态与会话默认配置

包可在 `package.json` 中声明可选的多值字段：

```json
{ "agnes": { "kinds": ["tool", "loop", "model-adapter", "mcp", "skills", "ui"] } }
```

只声明包实际提供的类型。管理列表和详情展示类型徽标，类型筛选匹配声明值。未声明字段的旧包仍显示在“全部类型”中。

状态徽标分别报告已安装、期望启用、后台确认运行中、排干中、需要重启与失败。只有后台明确报告旧会话绑定时才显示排干中，待清理资源本身不能证明排干。前端失败与后端状态同时保留，支持时可重试界面加载。

“新会话默认配置”读取后台目录，使用配置 revision 保存确切的 Loop/适配器版本及模型 ID。已有会话保留原绑定。已失效的选择须替换或清除，保存冲突时须重新加载目录。本地 daemon 从持有 Host 的共享 worker 查询目录，启动器通过私有 Unix 连接转发。在工作台，新任务在现有模型选择器旁预选保存的 Loop 和模型；首条消息发送前可以修改 Loop，已有会话保留原绑定。会话 Trace 从会话元数据展示记录的 Loop ID/版本，重新打开后同样可见。

固定本地管理路由为 `GET /admin/api/loops`（Loop 目录和默认值/revision）、`GET /admin/api/model-adapters`、`GET /admin/api/defaults` 与 `PUT /admin/api/defaults`，保存参数为 `{ revision, defaults: { loop?, modelAdapter? } }`。Loop 选择包含 `id` 和 `version`，适配器选择还包含 `model`。写入需要插件激活权限和同源管理上下文。可信启动器提供通往 daemon 的 `AdminSessionSelection` relay，Host 通过 `createAdminSessionSelection` 组合真实目录与现有配置存储。适配器模型在可用时包含已配置的 `route`，供工作台选择实际运行时模型。端点不导入插件工厂，也不接收凭据。

## 安装后端示例

建议先按[安装指南](install.zh-CN.md)建立临时 AGH_HOME，从仓库根启动该实例。`file:` 相对路径由后台的工作区来源解析；复用不同 cwd 启动的 daemon 时应核对来源，最简单的是在隔离实例的启动目录操作。

```sh
node packages/cli/dist/local/agnes.mjs package inspect file:./examples/packages/hot-tool-plugin
node packages/cli/dist/local/agnes.mjs install file:./examples/packages/hot-tool-plugin --yes
```

安装命令展示预览；不加 `--yes` 时需要交互终端，非 TTY 会提示用 `--yes` 重试。检查 package ID、版本、来源、integrity、capabilityHash、警告与 blockers；不能给有 blocker 的包直接授权。`package trust <id> --yes` 显示并信任当前已安装版本的两个哈希；仍可显式传入哈希，不匹配时显示 expected/given。`--yes` 不绕过 blockers 或哈希校验：

```sh
node packages/cli/dist/local/agnes.mjs package trust @agnes-examples/hot-tool-plugin --yes
node packages/cli/dist/local/agnes.mjs package enable @agnes-examples/hot-tool-plugin --yes
node packages/cli/dist/local/agnes.mjs package status
```

Web 对应“设置 → 插件 → 从来源安装 → 检查/安装 → 启用”。确认启用时会审核并绑定当前完整性摘要和能力摘要，校验成功后才继续激活；普通 Web 流程不再单独显示信任动作。已安装列表的开关只在插件实际运行时打开。服务依赖、策略拒绝或候选加载失败时，开关保持关闭，失败原因显示在当前行，可直接再次点击启用重试。

## 更新与回滚

当前 shell `package` 没有 `update` 子命令；请在 Web 插件页选已安装包的“从新来源更新”，或先检查来源后用 TUI `/package update <id> <source> <integrity>` 提交操作（该命令不提供安装式交互确认），程序调用则用 Node SDK `client.packages.update`。

可以用 `hot-service/v1` 与 `v2`，或 `client-panel/v1` 与 `v2` 演练。先安装并启用 v1；更新时选择同 ID 的 v2 来源，核对新摘要和能力变化，按界面提示完成审核与激活。观察 actual 和界面/服务值，而不只看操作进度为 100%。

```sh
node packages/cli/dist/local/agnes.mjs package rollback PACKAGE_ID
node packages/cli/dist/local/agnes.mjs package operation OPERATION_ID
```

不携带 activation 的普通回滚会把目标设为未信任、禁用；shell 回滚后重新检查目标摘要，执行 trust、enable，再核对实际服务或界面。SDK 可携带当前安装/活动摘要与明确的目标信任决策进行 activation，不能省略相应校验。

回滚依赖保留的上一版本和当前许可，不是任意历史版本管理。当前上一版本槽有界；已撤信任、被删除或无法核验的快照不能被回滚自动复活。失败候选可能自动回退，但必须读取真实 operation 状态和 actual，不能从“已请求”推断成功。

## 禁用、撤信任与删除

```sh
node packages/cli/dist/local/agnes.mjs package disable PACKAGE_ID
node packages/cli/dist/local/agnes.mjs package remove PACKAGE_ID
node packages/cli/dist/local/agnes.mjs package cancel OPERATION_ID
node packages/cli/dist/local/agnes.mjs packages pins inspect
```

撤信任保留在 Node SDK 中，供管理和恢复流程使用；普通 Web 页面不再显示这一动作，shell 也没有通用 `package untrust` 命令。禁用停止向新会话提供能力，已有会话保留其 generation 直到删除；删除处理安装状态与自有文件；正在被使用的快照可能有 pin，不能手动删除引用中的目录。`packages pins release PIN_ID` 是针对核验过的孤儿 pin 的显式清理动作，不用它绕开运行安全门。已有隔离演示验证禁用后三个示例包均可删除；仍需以目标平台和最终发行构建复验，具体基线见[验证记录](../maintainers/verification.zh-CN.md)。

取消是请求，收到回执后继续查 operation；部分有副作用操作不能当作从未发生。工具、事件监听、Cordis 服务与前端槽位应随所属 fiber 清理，外部业务数据不因插件卸载自动撤销。

## 更新为何不总是立即切换

每次包激活生成不可变的插件 generation。新会话绑定当前 generation；已有会话在休眠和 worker 重启后仍保留原包、版本、loop 与前端 bundle。禁用或卸载停止新的绑定，已有会话继续排空。关闭连接不会释放持久会话的 generation；会话删除后，由 Host 所有者调用 `releaseSessionGeneration(sessionKey)`，不再被会话引用的 generation 才会销毁并回收。

存储、文件系统、sandbox 和平台后端仍需要重启。恢复时若固定快照缺失、包文件发生变化，或部署的 loop/adapter 配置不兼容，会明确失败，不会替换成当前 generation。私有 MCP 工厂或 Skills 视图也必须能够重建；原视图缺失时拒绝冷恢复。`Host.pluginGenerationStatus()` 和内部 worker 命令 `pluginGenerations.status` 向管理端提供 generation 引用数及 active/draining/restart-required/failed 插件状态。浏览器名册请求可携带 `sessionId`，加载该会话固定的 generation，资源通过不可变的 generation 路径提供。

候选加载、依赖与激活超时仍可能导致激活失败，旧 generation 继续服务已绑定的会话。浏览器自行加载 bundle 名册，Host active 不等于浏览器已加载。

实现依据：[shell 命令](../../packages/cli/src/commands/package.ts)、[SDK](../../packages/sdk/src/package-admin.node.ts)、[Web 管理](../../packages/web/src/admin/plugins/admin.tsx)、[EntryTree](../../packages/cordis-loader/src/entry-tree.ts)、[Host 发布](../../packages/host/src/runtime-target-publisher.ts)。
