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

管理页的“从来源安装”支持本地路径、Git URL 和归档 HTTPS 地址。本地路径指向 daemon 所在机器。`file:` 接受绝对路径、daemon 工作区外的文件夹、相对文件夹、`.tgz`/`.tar.gz`/`.tar` 与 ZIP。显式的相对 `file:` 仍从 daemon 工作区解析；CLI 裸路径从 CLI 当前目录解析。来源不能是符号链接。归档可直接包含包，或用单个目录包住它；越界路径、链接、特殊文件与过大的归档会被拒绝。只有 npm 包可以包含 `node_modules`、`.git` 或 `fixtures/out`；含有这些目录的归档、URL 或 Git 内容会以原因 `excluded-directory` 被拒绝（文件夹来源会跳过它们），依赖请用 `agh plugins pack` 打包分享。HTTPS 下载不跟随重定向、不接受 URL 凭据。

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

在每个插件的 `agnes.plugins[].capabilities` 中声明请求范围。已安装包、本地插件、代理生成的插件和随包发布的官方插件使用同一种形状：

```json
{
  "agnes": {
    "plugins": [
      {
        "apiRange": "^4.0.0",
        "export": "main",
        "capabilities": {
          "network": ["api.example.com", "*.example.org"],
          "filesystem": { "read": ["workspace/reports/*"], "write": ["workspace/output/*"] },
          "exec": ["node"],
          "secrets": ["weather-api-key"],
          "credentials": ["example-account"],
          "model": true,
          "childAgents": true,
          "ui": true,
          "uiData": ["finance.differences.read"]
        }
      }
    ]
  }
}
```

只写名称与范围，不写秘密值。字符串列表支持 `*`。`uiData` 是例外：每一项都是精确能力名，例如 `finance.differences.read`（`^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$`），最多 32 个。信任审核展示 atom `uiData:<name>`，能力哈希覆盖该列表。通配符不符合该模式。文件范围可用绝对路径、相对路径或以工具 cwd 为根的 `workspace/` 路径。布尔值声明模型、子代理或 UI。同一个对象还描述插件注册什么：`tools`（`prefix`、`names`）、`hooks`、`slots`、`events`、`resources`、`services`、`projections`，以及 `tools.invoke`、`network.publicRead`、`artifacts`、`subagent`。`network` 始终是主机模式列表，`ui` 是标记；皮肤与客户端模块放在条目的 `contributes` 下。包展示的是各插件权限的并集。空对象表示没有请求；省略字段的旧插件显示“未声明”。修改声明会改变信任哈希，需要重新审核。

profile 的 `policy.capabilityCeiling` 在安装时检查每个插件声明的能力类别，例如 `network` 对应网络范围、`hooks` 对应 hook 列表、`filesystem.read` 对应文件读取范围。空 ceiling 拒绝所有非空声明；省略声明的旧插件仍按未声明兼容。`plugin-capabilities.json` 另外检查范围。这两项检查不限制插件 JavaScript，也不强制注册名称白名单。无 profile 的打包/开发检查没有类别 ceiling；安装仍检查目标 profile。

管理员可在 profile 的 `agnes-lock.json` 旁创建 `plugin-capabilities.json`：

```json
{
  "allow": ["network:*.example.com", "filesystem.read:workspace/*", "model", "ui"],
  "deny": ["exec:*", "secrets:*", "credentials:*"]
}
```

策略词汇为 `network:<host>`（或 `network:<host>:<port>`）、`filesystem.read:<scope>`、`filesystem.write:<scope>`、`exec:<command>`、`secrets:<name>`、`credentials:<name>`、`model`、`childAgents`、`ui`。省略 allow 表示除 deny 外均允许；空 allow 表示全部拒绝。deny 优先，宽泛请求不能绕过更窄的拒绝规则；不带端口的拒绝规则覆盖该主机的所有端口。错误策略拒绝操作。检查、安装、信任与启用读取同一策略；后续收紧策略会阻止不符合要求的包进入新激活，不删除其数据。

声明中没有网络主机，只表示未请求网络访问，不保证插件代码无法访问网络。这是社区信任模型：能力声明用于审核受信任代码，不构成隔离沙箱。Host 在工具 exec/沙箱启动、网络 fetch、文件访问边界记录未声明使用，不记录命令参数、目标或秘密值。现有沙箱与网络授权仍决定是否执行。直接使用 Node API、插件初始化和注入服务内部的调用不在该观察范围内。

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

AGH 默认提供四个官方助手插件。每次启动时，profile 从未被提供过且尚未安装的默认插件会自动安装、信任、启用并激活，无需联网下载：

| 插件 | 用途 |
| --- | --- |
| `@agnes/skill-helper` | 在会话中创建、导入和安装 Skill |
| `@agnes/mcp-helper` | 在会话中准备和接入 MCP，查询真实连接状态 |
| `@agnes/plugin-helper` | 在会话中创建工具或 Skill 插件、检查包，并在确认后安装启用 |
| `@agnes/document-reader` | 读取 PDF 文字与页面图片、扫描 PDF、DOC、DOCX 和 ZIP 中选定的文件；OCR 在本地离线运行 |

发行版还包含默认的文件、目标与交互呈现插件 `@agnes/deliverables-ui`、`@agnes/goal-ui` 和 `@agnes/interaction-ui`。已有 profile 若从未被提供过这些呈现插件，启动时也会补装。若能力上限不允许某个可选 UI 插件，会将它记录为已提供但省略，后续启动不再自动重试；其他验证失败仍会阻止初始化。

已安装的插件使用固定快照，重新构建或重启应用不会覆盖旧快照。要使用 `@agnes/document-reader` 0.1.2 的 PDF 按页看图和改进后的 ZIP 读取能力，请在 Web 插件管理中选择该包的“从新来源更新”，来源填写新构建应用的 `file:./bundled-plugins/document-reader`，核对预览后按正常更新和激活流程完成。

四个助手出现在“设置 → 插件管理 → 已安装”，可以禁用或卸载。后续启动与升级尊重你的选择，不自动恢复；移除助手插件不会删除它先前创建或接入的插件、Skill 或 MCP。安装第三方能力仍需要相应确认。

初始化回执记录已提供过的默认插件，包括因能力上限而省略的插件。旧回执仅根据已记录的完整性摘要和当前已安装的默认插件确认历史提供记录，再补装其余缺失项。此前已提供的默认插件保持卸载或禁用状态；仅限全新 profile 的默认项不补装。初始化保留已有同名插件的启用/信任状态。首次默认安装完成后，主动移除的助手可在“发现”中重新安装。首次初始化受部署策略约束，失败时保留记录，恢复后继续处理，不把失败标记为已启用。

## 管理其他插件

| 阶段 | 你要确认什么 |
| --- | --- |
| 检查与安装 | 来源、版本、内容摘要与能力声明是否符合预期 |
| 审核与启用 | 是否允许这一版代码在当前实例中提供能力 |
| 核对实际状态 | 相关后端行是否 ready，前端贡献是否在页面加载 |
| 更新或移除 | 新版本是否生效，旧能力是否正确撤下 |

安装成功后默认保持停用。AGH 仍会在内部记录审核通过的版本和能力范围，再进入激活流程。`desired` 表示期望启用状态，`actual` 表示实际运行状态；分别查看它们，才能区分“已提出请求”和“已经可用”。

安装、信任、更新、启用和回滚校验真实内容；后续受管理的读盘可检查文件身份并定期全量重哈希，未知文件系统与 standalone 调用仍 full。完整性失败撤销信任并停止受影响 worker，包括固定的历史代码。修复字节后需明确重新审核/信任，普通读取不会恢复授权；修复当前版本也不会验证另一份历史物理副本。

## 插件类型、状态与会话默认配置

包可在 `package.json` 中声明可选的多值字段：

```json
{ "agnes": { "provides": ["tool", "loop", "model-adapter", "mcp", "skills", "ui"] } }
```

只声明包实际提供的类型。管理列表和详情展示类型徽标，类型筛选匹配声明值。未声明字段的旧包仍显示在“全部类型”中。

Agent 起草的候选列表先显示类型（插件／技能）、版本、新建／更新和来源轮次的相对时间，再进入审阅。时间来自已记录的来源会话轮次，不推测候选创建时间；详情不可用时明确说明。

插件页面在打开时读取数据，在包或插件树变更、返回浏览器标签页及用户操作后刷新；空闲时不轮询插件树。安装和更新进行中使用有上限的退避刷新，浏览器标签页隐藏时暂停。

插件已安装但尚未信任时显示**待信任**及审阅入口；离开未完成的“安装并启用”流程后仍可继续。更新审阅显示版本变化、新增或移除的能力，并明确标出无法比较的权限或文件信息。

插件列表和概览只显示一个主状态：就绪、受阻、重启后生效、仅历史、已停用或待信任。原因和下一步操作来自后端。撤销信任优先于停用。“仅历史”表示只有已有会话保留的版本可用，其中可能仍有打开的会话；新会话尚无就绪版本。展开“状态维度”可查看信任、期望启用状态、实际运行状态、浏览器模块及代际和会话数量。“运行”表示插件运行环境可用，不表示正在执行工具。目录中的 `active` 仍表示配置中选用。重启操作打开说明，不会声称已重启服务。

旧代际摘要只统计后台报告的已安装插件绑定，并对会话去重。详情保留显示名、版本及代际编号；已卸载包的绑定可在运行诊断中查看。待清理资源本身不能证明旧版本仍被使用。前端失败与后端状态分别保留，支持时可重试界面加载。

“新会话默认配置”读取后台目录，使用配置 revision 保存确切的 Loop/适配器版本及模型 ID。已有会话保留原绑定。已失效的选择须替换或清除，保存冲突时须重新加载目录。本地 daemon 从持有 Host 的共享 worker 查询目录，启动器通过私有 Unix 连接转发。在工作台，新任务在现有模型选择器旁预选保存的 Loop 和模型；首条消息发送前可以修改 Loop，已有会话保留原绑定。会话 Trace 从会话元数据展示记录的 Loop ID/版本，重新打开后同样可见。

固定本地管理路由为 `GET /admin/api/loops`（Loop 目录和默认值/revision）、`GET /admin/api/model-adapters`、`GET /admin/api/defaults` 与 `PUT /admin/api/defaults`，保存参数为 `{ revision, defaults: { preset?, permission?, providers?: { loop?, 'model-adapter'? }, model? } }`。`preset` 是默认配方，`permission` 是默认权限级别（`read-only`、`workspace-write` 或 `full-access`）；旧版保存为默认预设的权限级别名会作为 `permission` 读回。每个 `providers.<kind>` 选择都是 `{ provider, version }`，与其他位置形状相同；`model` 是所选适配器的模型，只能与适配器同时出现。写入需要插件激活权限和同源管理上下文。可信启动器提供通往 daemon 的 `AdminSessionSelection` relay，Host 通过 `createAdminSessionSelection` 组合真实目录与现有配置存储。适配器模型在可用时包含已配置的 `route`，供工作台选择实际运行时模型。端点不导入插件工厂，也不接收凭据。

## 安装后端示例

建议先按[安装指南](install.zh-CN.md)建立临时 AGH_HOME，从仓库根启动该实例。`file:` 相对路径由后台的工作区来源解析；复用不同 cwd 启动的 daemon 时应核对来源，最简单的是在隔离实例的启动目录操作。

```sh
node agnes.mjs package inspect file:./examples/packages/hot-tool-plugin
node agnes.mjs install file:./examples/packages/hot-tool-plugin --yes
```

安装命令展示预览；不加 `--yes` 时需要交互终端，非 TTY 会提示用 `--yes` 重试。检查 package ID、版本、来源、integrity、capabilityHash、警告与 blockers；不能给有 blocker 的包直接授权。`package trust <id> --yes` 显示并信任当前已安装版本的两个哈希；仍可显式传入哈希，不匹配时显示 expected/given。`--yes` 不绕过 blockers 或哈希校验：

```sh
node agnes.mjs package trust @agnes-examples/hot-tool-plugin --yes
node agnes.mjs package enable @agnes-examples/hot-tool-plugin --yes
node agnes.mjs package status
```

Web 对应“设置 → 插件 → 添加插件 → 从来源安装 → 检查/安装 → 启用”。确认启用时会审核并绑定当前完整性摘要和能力摘要，校验成功后才继续激活；普通 Web 流程不再单独显示信任动作。已安装列表的开关只在插件实际运行时打开。服务依赖、策略拒绝或候选加载失败时，开关保持关闭，列表显示出错标签；打开详情查看失败原因，再从操作菜单重试启用。

插件页分为“已安装”和“发现”。发现页先展示三个官方示例，其余收在“更多官方示例”里。行尾菜单提供设置（插件声明配置时）、详情和生命周期操作。详情分为概览、设置、权限、版本；版本页说明仍在使用旧版本的进行中会话，它们的工作不会中断。技术标识、来源和完整性摘要收在“技术详情”中。

声明 `metadata.exampleOf` 的包仅在所属插件的**示例**页面管理：在该页面审核安装和启用、启动示例，并在停止后审核移除。这类包不进入普通插件列表和发现目录；未声明 `exampleOf` 的 FDE 业务 Agent 示例保持原有流程。直接检查示例来源时，页面说明所属关系，并提供所属插件的正常审核安装/启用入口。示例要求所属插件已安装、受信任、已启用且版本兼容；停用所属插件后，示例的启动入口不可用。重新启用所属插件会恢复已启用的示例。该关系不授予服务访问权限。


## 更新与回滚

重新构建 AGH 会保留已安装包经过审核的能力快照，启动时仍会重新验证不可变包文件。早期版本规范化客户端描述时遗漏的流声明，不会导致旧安装失效；旧授权和能力哈希保持不变，重新发现声明也不会自动授予流访问权。要批准当前声明，请按正常流程审核更新，即使来源和版本相同。已安装文件字节发生变化时，完整性校验仍会拒绝启动。

只有已安装依赖插件声明的范围不接受候选版本时，才会阻止父插件更新；预览会列出阻塞的依赖插件。选择“联合审核父插件和依赖插件更新”，可检查它们当前发行来源中的候选版本，逐个审核版本和权限后“一并更新”。请求绑定每个包的已安装摘要和候选摘要；候选不可用、过期或不兼容时保留已安装组合。插件 lock 一次提交整组更新，再发布一个组合运行目标。已停用的依赖插件保持停用，活动引用和来源策略检查仍然生效。

版本匹配中，`*` 和精确版本接受有效的预发布版本（例如 `0.1.0-alpha.0`）。其他受支持的比较范围遵循 npm semver 规则：只有范围中显式包含同一 major/minor/patch 的预发布比较项，才接受该预发布版本。Host API 兼容范围继续遵守这一限制；稳定 API 范围不会接受无关的预发布版本。

运行时快照记录带有格式版本。较早的 plugin-core 记录（包括未写版本的记录）按原来的元信息和能力摘要规则验证，并保留相同的字节与目录树校验。纯格式升级无需手动恢复，也不会改写快照身份、信任决定或会话 pins。新快照使用当前格式；获取新的智能体或应用声明仍走完整性校验和正常审阅更新流程。保留的包操作结果也会在磁盘上保留历史元信息与标签；管理接口仅将其投影为当前展示合同。损坏记录与被修改的字节仍会被拒绝。

运行时 pin 复用当前安装包的完整性摘要时，还必须匹配已验证安装的版本、来源类型与引用、目录树摘要和能力哈希。归档记录自身一致不能为替换字节或伪造来源授予信任。经过审核的更新完成后，历史会话仍保留独立的快照与 generation 身份及原始字节。

发行版维护的内置默认插件（助手与默认呈现插件）跟随当前发行版。启动时，AGH 核对随附载荷与已安装快照的版本、完整性和能力摘要。对于仍使用保留内置来源、已信任且已启用的默认插件，仅在能力摘要不变时，通过常规验证更新与固定快照的运行目标发布流程刷新。发行默认包刷新与固定目标发布先于启动时的 profile 受管资源注册和启动。已有会话保留原快照。已删除的默认插件不会重新安装；已停用、已撤销信任或固定到其他来源的插件保持原状。

启动时，内容未变的内置包只需核对内容摘要，无需复制到候选暂存目录。更新后以及构建最终运行目标前，会重新核验已安装插件；同一轮刷新汇总成一个完整运行目标，统一验证并发布。更新中断或发布失败会在下次启动重试，不会逐个发布中间组合。包更新准入、依赖、信任和运行快照检查仍然生效。

能力变化或常规依赖、引用检查阻止刷新时，**插件 → 内置 → 版本**会显示**有可用更新**、已安装 → 随附版本与**审核更新**操作。该操作先进入既有的内容与能力审核，确认后才更新。复制出的发行载荷保留各包已声明的版本号。仅 `0.0.0` 占位版本使用发行版版本号（私有工作区构建使用已声明的公开候选版本号）。显式指定的发行版本可以提高包版本，但不能降低；复制出的示例精确依赖最终的所属插件版本。版本标签相同时仍比较完整性。

当前 shell `package` 没有 `update` 子命令；请在 Web 插件页选已安装包的“从新来源更新”，或先检查来源后用 TUI `/package update <id> <source> <integrity>` 提交操作（该命令不提供安装式交互确认），程序调用则用 Node SDK `client.packages.update`。

可以用 `hot-service/v1` 与 `v2`，或 `client-panel/v1` 与 `v2` 演练。先安装并启用 v1；更新时选择同 ID 的 v2 来源，核对新摘要和能力变化，按界面提示完成审核与激活。观察 actual 和界面/服务值，而不只看操作进度为 100%。

```sh
node agnes.mjs package rollback PACKAGE_ID
node agnes.mjs package operation OPERATION_ID
```

不携带 activation 的普通回滚会把目标设为未信任、禁用；shell 回滚后重新检查目标摘要，执行 trust、enable，再核对实际服务或界面。SDK 可携带当前安装/活动摘要与明确的目标信任决策进行 activation，不能省略相应校验。

回滚依赖保留的上一版本和当前许可，不是任意历史版本管理。当前上一版本槽有界；已撤信任、被删除或无法核验的快照不能被回滚自动复活。失败候选可能自动回退，但必须读取真实 operation 状态和 actual，不能从“已请求”推断成功。

## 禁用、撤信任与删除

```sh
node agnes.mjs package disable PACKAGE_ID
node agnes.mjs package remove PACKAGE_ID
node agnes.mjs package cancel OPERATION_ID
node agnes.mjs packages pins inspect
```

撤信任保留在 Node SDK 中，供管理和恢复流程使用；普通 Web 页面不再显示这一动作，shell 也没有通用 `package untrust` 命令。禁用停止向新会话提供能力，已有会话保留其 generation 直到删除；删除处理安装状态与自有文件；正在被使用的快照可能有 pin，不能手动删除引用中的目录。`packages pins release PIN_ID` 是针对核验过的孤儿 pin 的显式清理动作，不用它绕开运行安全门。已有隔离演示验证禁用后三个示例包均可删除；仍需以目标平台和最终发行构建复验，具体基线见[验证记录](../maintainers/verification.zh-CN.md)。

取消是请求，收到回执后继续查 operation；部分有副作用操作不能当作从未发生。工具、事件监听、Cordis 服务与前端槽位应随所属 fiber 清理，外部业务数据不因插件卸载自动撤销。

## 更新为何不总是立即切换

每次包激活生成不可变的插件 generation。新会话绑定当前 generation；已有会话在休眠和 worker 重启后仍保留原包、版本、loop 与前端 bundle。禁用或卸载停止新的绑定，已有会话继续排空。关闭或休眠会话保留持久代码 pin 和磁盘快照。旧的内存容器在最后一个打开的会话结束并经过空闲超时后关闭（默认 60 秒，可用 `limits["worker.generation_idle_close_ms"]` 配置，0 表示立即回收）。重开会话会从快照重建原 generation。会话删除后，由 Host 所有者调用 `releaseSessionGeneration(sessionKey)`，不再被会话引用的快照才会回收。

撤信任比禁用更强：generation 或保存的组合导入归档代码之前，会检查当前包的信任决定。已撤信任、已删除或信任绑定失效的包会拒绝冷恢复，返回 `E_SESSION_VERSION_OLDER`，`detail.cause` 保留 `E_WORKSPACE_UNTRUSTED`，说明包含 `E_GENERATION_UNTRUSTED`；会话 pin 保留，供管理恢复使用。单纯禁用仍保留受信的固定代码。当前授权必须匹配安装版本的完整性与能力哈希；不可变历史归档保留升级前已审核的绑定。generation 使用当前安装摘要时，还必须匹配安装版本和目录树摘要。没有包锁文件的显式 Host 必须重新读取其源授权，并核验归档的准确快照身份、版本、完整性、目录树摘要与能力哈希。

存储、文件系统、sandbox 和平台后端仍需要重启。恢复时若固定快照缺失、包文件发生变化，或部署的 loop/adapter 配置不兼容，会明确失败，不会替换成当前 generation。MCP 定义与技能是动态资源：冷恢复使用当前受信且启用的资源，并按固定的会话组合过滤；历史资源归档不代替动态集合。`Host.pluginGenerationStatus()` 和内部 worker 命令 `pluginGenerations.status` 向管理端提供持久引用数、打开会话数、容器存活状态及 active/draining/historical/restart-required/failed 插件状态。draining 表示仍有打开的会话使用旧代码；historical 表示仅历史会话引用，界面显示为“历史会话保留旧版”。符合条件的历史会话可在运行时设置中使用现有的“将会话迁移到当前插件”动作。浏览器名册请求可携带 `sessionId`，加载该会话固定的 generation，资源通过不可变的 generation 路径提供。

候选加载、依赖与激活超时仍可能导致激活失败，旧 generation 继续服务已绑定的会话。浏览器自行加载 bundle 名册，Host active 不等于浏览器已加载。

特权 generation 迁移要求会话连接已关闭，并在修改 pin 的同一串行守卫内检查持久执行事实。待审批、待用户回答、停泊的工具续程、未完成后台任务或子代理、延迟调用、外部效果未知及资源恢复屏障均返回 `E_GENERATION_EXECUTION_UNSETTLED`；`detail.reasons` 列出具体种类、绑定与账本序号。拒绝保留 pin 和账本；关闭或取消不能证明未知的外部结果。没有执行绑定的普通未完成聊天不阻塞迁移。后台任务工具保存结构化状态回执；旧格式的后台启动回执在有持久终态之前仍会阻塞。

实现依据：[shell 命令](../../packages/cli/src/commands/package.ts)、[SDK](../../packages/sdk/src/package-admin.node.ts)、[Web 管理](../../packages/web-admin/src/admin/plugins/admin.tsx)、[EntryTree](../../packages/cordis-loader/src/entry-tree.ts)、[Host 发布](../../packages/host-providers/src/runtime-target-publisher.ts)。

随发行版的 local-dev 与 enterprise 模板显式允许内置示例所用的现代声明类别。已有自定义 profile 若 ceiling 较窄，需要明确加入愿意准入的新声明类别；这只改变准入审核，不改变受信任代码的操作系统权限。


### 插件列表刷新与文件清理

Web 插件页打开时会检查管理上下文。上下文未变化时，可以复用 30 秒内读取的插件列表。窗口重新获得焦点不会反复加载仍然新鲜的数据；插件变更通知和手动刷新仍会触发读取。后台刷新保留已显示的列表，授权与操作预览仍由后端裁定。

打开 **设置 → 运行时与诊断 → 插件文件清理**，检查不再使用的文件保留记录。检查在打开清理面板时执行，不随插件列表刷新。检查失败会显示重试入口，不会误报存在待清理记录。清理需要确认和删除权限；后台会再次核验使用情况，跳过重新被使用的记录。解除保留记录让文件可以被回收，不保证立即释放磁盘空间。

本地发现目录在首次读取时核验内置及仓库示例，不再阻塞后台服务就绪。后续离线读取复用核验结果，继续遵守原有过期规则；安装时仍会重新检查选中的包。
