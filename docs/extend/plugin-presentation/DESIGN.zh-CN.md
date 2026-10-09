# 插件用途与页面设计提案

[English](DESIGN.md) | 简体中文

**状态：Phase A 已批准，简化 Phase B 已实现，等待统一验收。**

Lead 于 2026-10-10 批准元数据契约与内容。本次实现可选公开契约、分类／搜索卡片、六个详情区块，仅用现有可读目录／注册信息和轻量 PackagePresentation 字段。证据等级、已观察事件、新增分页、依赖／反向依赖图和停用影响分析延期，现有 blockers／pins 继续保持权威。开发期间未运行构建、测试或截图。

[扩展指南](../README.zh-CN.md) · [逐项双语文案](CONTENT.zh-CN.md)

## 目标与核验

管理员应在约五秒内理解插件解决什么问题、提供什么、在哪里生效、来源与状态，以及停用影响。列表先说明业务用途，详情保留可核对的技术身份。

核验源码 `7b5271ffa`：`packages/base/extensions/*/agnes.extension.json` 共 **37** 份，全部缺少用途 metadata。排除 node_modules/dist 后，packages 和 examples 共 **126** 份 package.json，**10** 份有 npm description：packages 为 10/70，examples 为 0/56。此前 6/97 的数字已不适用于该版本；npm description 也不是经过校验的双语展示合同。

目前 `admin/views.tsx` 按 example ID 选择名称与 summary，`web-ui/src/locales/admin-list.ts` 另有四个官方辅助包的名称/描述。这两套逐 ID 特例应同时移入作者清单。类别、贡献类型、状态等通用界面文本继续共享翻译。

包级 kinds 只有 tool、loop、model-adapter、mcp、skills、ui、bundle，不能据此覆盖全部功能。公开 provider catalog 另有 policy、compaction、memory、persistence、sandbox、child-agent、reference-resolver、webhook-trigger；feedback、intelligent-ui、observability 还有独立端口。类别是用途导航，不新增运行时 kind。

37 份 manifest 也不等于 37 个正在运行的插件：部分入口不注册能力，实现由 seam/provider 承载；sandbox 未作为普通 extension 列入 base 包。描述可以说明职责，“提供内容”必须核对实际注册，不能生成虚假的活跃行。

## 公开 metadata 合同

在 protocol 的 extension-manifest schema 定义可复用的 `PluginMetadata`，通过 extension-api 的公开导出提供生成类型。同一对象可放在：

- `agnes.extension.json.metadata`：extension 用途。
- `package.json.agnes.metadata`：包级概览，覆盖组合包、provider 库样例。
- `package.json.agnes.plugins[].metadata`：普通插件行的用途。

行 metadata 以整个对象覆盖包级概览；extension 使用自己的 manifest；包卡片使用包 metadata。多行包展开为各自贡献行，不把包级概览重复当作每一行的独立用途。base 包内置行通过公开声明携带或公开引用关联 extension 的已校验 metadata，Host/Web 不维护官方描述表。只有 manifest、没有运行行的条目留在内容清单，不伪装为已启用插件。

```json
{
  "metadata": {
    "displayName": "Progress checks",
    "summary": "Detects repeated writes and stalled work, then requests revision or escalation within configured limits.",
    "description": "Checks execution for repetition, missing progress and unfinished plans. The selected repair policy can request another attempt, escalate or park the task; limits come from the session configuration.",
    "category": "agent-loop",
    "locales": {
      "zh-CN": {
        "displayName": "执行进度检查",
        "summary": "发现重复写入和停滞的执行，并按配置限制要求修正或升级处理。",
        "description": "检查重复执行、缺少进展与未完成计划。选定的修正策略可要求再次尝试、升级处理或暂存任务，次数限制来自会话配置。"
      }
    }
  }
}
```

metadata 整块可省略；存在时 displayName、summary、description、category 必填，docsUrl、locales 可选。基础文案默认英文。locales 仅允许 en、zh-CN，各自可部分覆盖 displayName、summary、description、docsUrl；category 不随语言改变。官方与样例提供完整英文基础文案和中文文案，第三方不必提供翻译即可安装。

| 字段 | 校验 |
| --- | --- |
| displayName | 1–80 个 Unicode 码点，去首尾空白后的单行可打印文本 |
| summary | 1–240 个码点，单行可打印文本；“一句话”作为编辑规范 |
| description | 1–1,200 个码点，单段可打印文本 |
| category | 下表的稳定枚举 |
| docsUrl | 1–2,048 个码点，绝对 HTTPS URL，不含凭据或控制字符 |
| locales | 最多两个已知语言键；所有对象拒绝未知字段 |
| 整块 | 包含翻译后最多 24 KiB UTF-8 JSON |

字符串要求已去首尾空白；安装时拒绝空白、换行和超长值，不静默修正。显示端仅作为文本渲染，不执行 HTML/Markdown。文档链接由用户主动打开，附带 noopener noreferrer，不自动加载远程内容。

| 值 | en | zh-CN |
| --- | --- | --- |
| agent-loop | Agent Loop | Agent 执行 |
| tools | Tools | 工具 |
| safety-approval | Safety & Approval | 安全与审批 |
| memory-context | Memory & Context | 记忆与上下文 |
| collaboration | Collaboration | 协作 |
| integrations | Integrations | 集成 |
| observability | Observability | 可观测性 |
| ui | UI | 界面 |
| developer | Developer | 开发者 |

逐字段按当前语言覆盖→基础文案回退。metadata 缺失时显示完整 ID、已知 kind，以及 **作者未提供用途说明 / No description provided**；类别为未分类。不能猜测用途、调用模型补写或读私有 ID 表。已知 kind 技术筛选继续保留。

package-manager 的 inspect 在安装前校验包与行 metadata，plugin-manifest 接受新字段，extension-api/manifest 复用共享 schema。catalog、preview、lock 与不可变 snapshot 携带已校验包 metadata；只读 presentation 携带行 metadata。详情按确切快照展示，旧版本不读取新版本的文案。打包与创作候选保留公开 metadata。缺失合法，存在但非法则拒绝安装。

这是可选公开字段增量，不引入迁移与兼容垫片。类型、验证器和引用文档来自协议生成器。metadata 不改变权限、装载、信任或配置语义；文案变更自然改变包 integrity，仍走既有审核，metadata 不加入 capability hash 输入。双语作者指南记录已实现合同。

## 派生事实与复用来源（简化 Phase B）

预览、安装库存和目录 DTO 增加可选只读 `presentation`：rows 包含 ID、作者 metadata／扩展 source ID、configSchema 是否存在；展示 DTO 的 origin 由后端现有内置来源、bundled 目录或来源记录推导。package-manager 从确切库存目录读取公开声明，不导入代码，不改变 canonical PluginRow、target hash、能力哈希或启停决策。行用途与实际注册分开展示，没有第二个持久化目录。

页面通过既有 runtime() 和 composition() 读取可选事实，再与现有 actualSlots 和 surfaceLinks 合成轻量内存展示模型。读取失败不阻止库存渲染；工具能力声明、events 权限和包 kinds 不作为注册证据。

| 信息 | 复用来源 | 展示规则 |
| --- | --- | --- |
| 工具 | composition 的 session toolGroups，由实际工具目录派生并保留 source | 按包／公开内置扩展 source 归属去重；可读会话 pin 与展示版本不同则排除 |
| Loop、策略等 provider | RuntimeAdminSnapshot.providers／ProviderCatalogEntry | 按 sourcePackage 关联，展示 ID、选用与生命周期；已知 actual integrity 不同时不混入当前库存 |
| 组合包 | 现有 runtime bundle catalog | 关联 sourcePackage，安装不代表选用 |
| 界面／设置插槽 | 现有 actualSlots(packageId) | 用通用 slot 名推导聊天、工作台、设置、审批；不推断竞争插槽赢家 |
| 配置 | 已校验插件行的 configSchema 是否存在 | 设置 chip 与说明；编辑仍在既有配置标签页，保留草稿 |
| 随包技能／主题 | 已验证库存的贡献描述 | 展示可用资源／主题 ID，不声称已在会话选中 |
| 独立页面 | 现有 surfaceLinks | 仅展示可读挂载页面与链接 |
| 信任／版本 | 现有库存、权限与来源审核、generation、rollback | 复用状态、blockers 与 pins，不由作者文案改变权限 |

settingsSections 当前没有逐包归属，不能按 ID 猜测谁提供了全局设置页；仅展示带归属的设置插槽和配置支持。命令与事件的归属也不从文案推断。位置由通用贡献类型／slot 映射；会话选用与实际展示可不同。不可读时显示“当前暂不可读取注册信息”，不把缺失解释为零。

本次不增加证据层、事件采集、分页、归属／快照采集设施或依赖／停用分析；已写入外部 hardening backlog。

## 来源、状态与既有阻塞

来源与安装方式分开：官方／示例／第三方／本地编写，本地文件无法确认作者时显示“本地来源 · 作者未确认”。身份来自现有内置、随附目录与来源记录，不从包名或作者文案推测。来源 badge 与信任 badge 分开，示例继续有现有示例架入口。

卡片保留期望启用／停用、实际运行、浏览器失败与旧版本保留提示。绿色开关不等于实际运行。离线、过期提示和动作限制沿用既有规则。本次不新增“可安全停用”承诺、依赖图或影响分析，保留既有 blockers、generation 提示、rollback 与 pins 操作，后端检查仍是权威。

## 列表线框

```text
插件                                             [从来源安装]
[已安装] [发现] [插件类型] [示例与 FDE]
[搜索名称、用途、工具或技能________________________]
[类别：全部 v] [kind v]

客服分流示例                    示例 · Agent 执行       [已启用]
对样例客服工单分类，并在记录模拟回复前请求批准。
提供  [Loop 1] [工具 4] [策略 1] [技能 1] [面板 1]
运行中 · 已信任 · 2 个会话保留旧版本
[详情]                                  [为新会话启用]

执行进度检查                    官方 · Agent 执行
发现重复写入和停滞的执行，并按配置限制要求修正或升级处理。
提供  [当前可读的实际贡献类型]
默认会话已选用                  [详情]

vendor/plugin                   第三方 · 未分类
作者未提供用途说明
kind：tool · 提供内容尚未确认 · 已安装 · 未信任
[详情]                                                [审核]
```

上方数量只是线框占位，非实际测量。分类与现有 kind 筛选作用于当前包列表。卡片展示包用途、来源、既有状态／信任 badge 与可读贡献数量。多行作者用途在“概览”展开区查看；仅有 manifest 不生成活跃卡片。

搜索按不区分大小写的短语匹配 ID、版本、显示名、summary、两种已提供语言、行用途、贡献 ID、可读注册 ID 与通用贡献标签。搜索、分类与 kind 按 AND 组合。目录查询在既有分页前搜索缓存描述中的双语 metadata 和行／贡献 ID；分类／kind 仍筛选已加载的目录行。本次不新增分页或远程浏览。

标题按钮打开详情，既有开关／动作保持独立。提供内容 chip 使用共享间距折行，summary 完整可读，长 ID、hash 与来源路径在技术披露中。保留既有加载、空、恢复与失败状态。窄屏与浅深色可读性等待统一验收。

## 详情线框

```text
客服分流示例                                          [关闭]
示例 · Agent 执行 · 运行中 · 已信任
概览 / 提供什么 / 在哪里生效 / 设置 /
权限与信任 / 版本与固定版本

概览：用途短句、说明段落、明确模拟范围、文档链接
提供什么：真实 Loop/工具/策略/技能/面板 ID，注册和选用范围
在哪里生效：聊天、工作台、审批、设置；位置随选用与插槽展示而变化
设置：配置支持说明；编辑保留在既有 D3 设置标签页
权限与信任：复用 CapabilityReview 与 ProvenanceReview
版本与固定：已安装/实际版本，绑定会话、固定版本与现有释放规则
既有 blockers 与 pins 保留在用途区块下方。
[为新会话停用]                 [移除]（沿用当前后端限制）
```

六个语义区块位于既有详情滚动区域，不新增区块跳转导航。保留 D3 的 Settings tab/form；概览在前，权限与信任可见，来源、integrity、浏览器插槽与回滚信息放在“版本与固定版本”的技术披露。打开保留合理焦点，Escape 关闭后返回标题按钮，刷新不抢焦点、不覆盖未保存配置。只读模式展示解释与可用读链接。

## 一致性、主题与证据

扩展 @agnes/web-ui 的 PluginList/DetailContent，并复用 SettingsCard、SettingsToolbar、Field、SettingsInput、Select、Badge、Button、SettingsDetails、StateSwitch。外部 UI 库仍仅在 web-ui。使用共享 token、间距、边框、圆角、状态色和 skin hook，状态伴随文字。候选审核、信任、pin、配置仍归现有模块。

遵循已合入的 [Web UI 一致性合同](../../develop/ui-consistency.zh-CN.md)：SettingsPage 拥有唯一标题、说明和页面动作，子面板不重复标题。列表用 PluginList 或 SettingsList/SettingsRow，技术信息用 SettingsDetails，不为每个属性嵌套卡片。加载/空/错误/成功用 SettingsState，保留上下文与草稿。原生 dialog 宿主保留控制器与共享内容，取消在主动作之前。原生选择语义用 SettingsSelect，富搜索选择才用 Select，保留既有 ID、aria 关系、IME 和 skin hook。

沿用 01-tokens.css 与 web-ui 的语义桥接：行内 --s8/--s12、区段 --s16/--s24、页面 --s24/--s32；输入面用 --agnes-input-surface，状态用双主题 --agnes-status-*，支持减少动态效果，不另建 palette。390px 是正式窄屏评审规格，线框的 375px 是额外目标。嵌入/独立页面共享标题、正文、动作节奏。

通用界面、错误/空/未知状态均提供 en/zh-CN，使用稳定 test ID：plugin-category-filter、plugin-summary、plugin-provides、plugin-appears-detail，加 package/row/version 属性。标签可见，控件键盘可用，焦点可辨，chip 为可读静态文本。浅深主题均应可读，停用状态不只用颜色表示。

## 依据源码描述当前页面

admin/views.tsx 先展示 SettingsHub 导航、候选收件箱和 generation-drain 提示，再放搜索、KindFilter、来源安装和插件创作动作。当前没有类别与来源筛选。admin/page.tsx 的 filteredInstalled 搜索 ID、版本与 contributionText，不搜索统一用途 summary。

web-ui/src/admin-list.tsx 逐个展示已安装包：标题按钮、kind/状态、可选描述、版本、StateSwitch 和可展开技术详情。四个官方辅助包的名称/描述来自 UI locale key。已知样例使用 settings 里的 ID 名称表，FDE 共用宽泛 summary，没有分别说明其业务用途。其他条目可能只有技术包 ID，没有描述和“用途缺失”提示。来源/integrity 可在技术详情查看，但没有清晰的可信来源归属 badge。

renderDetailPluginView 已展示来源、integrity、贡献概括、实际浏览器 slot、失败、清理与回滚目标，并复用能力/provenance 审核和 D3 配置包装。生命周期信息已有基础，尚缺统一的用途概览、实际提供内容、生效位置与按操作的停用依赖。这是源码观察，不是运行验收结果。

开发期间禁止产品构建。Phase A 使用上述源码描述和线框，真实 before/after 截图统一留到预交接验收阶段：通过共享锁一次一个浏览器/页面，覆盖双语、浅深色、桌面与 390px。提案审核不以截图为前置条件。

## 简化实施与延期验收

新增 docs/extend/plugin-metadata 中英作者指南。公开元数据、安装验证、快照携带与双语内容已实现；两个逐 ID 文案表及示例架／旧版本提示中的消费已删除。多行包的作者用途在“概览”展开区展示，不声称实际注册。当前详情为概览／提供什么／在哪里出现／设置／权限与信任／版本与固定版本六个区块，保留原配置编辑标签页和生命周期控件。

已编写元数据／安装／本地化、实际来源注册／缺失与版本差异、目录双语搜索、通用卡片详情／纯文本安全单测，以及一份已注册 Web spec（分类／搜索、可配置项、双语详情、390px 键盘打开、配置草稿保留）；按要求未运行。仅运行允许的协议生成器与廉价格式化。真实浅色／深色前后截图、编译和运行行为留到统一交接验收。
