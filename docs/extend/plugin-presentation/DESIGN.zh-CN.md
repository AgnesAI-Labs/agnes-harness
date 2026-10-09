# 插件用途与页面设计提案

[English](DESIGN.md) | 简体中文

**状态：待审核提案。本次不实现协议、运行时或页面。**

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

package-manager 的 inspect 在安装前校验包与行 metadata，plugin-manifest 接受新字段，extension-api/manifest 复用共享 schema。catalog、preview、contribution summary、lock 与不可变 snapshot 携带已校验值。详情按确切快照展示，旧版本不读取新版本的文案。打包与创作候选保留公开 metadata。缺失合法，存在但非法则拒绝安装。

这是可选公开字段增量，不引入迁移与兼容垫片。类型、验证器和引用文档来自协议生成器。metadata 不改变权限、装载、信任或配置语义；文案变更自然改变包 integrity，仍走既有审核，metadata 不加入 capability hash 输入。提案在实现前保持明确的“待实现”标注。

## 派生事实与复用来源

作者文案说明“为什么”，运行时事实说明“实际有什么、哪里生效”。先复用现有读 API；尚未公开的事实，在现有 plugin-tree 读响应中增加有界、只读 `presentation` 投影。不要把 UI 文案塞入 canonical PluginRow 或改变 target hash/generation 选择。

后端投影按 packageId、snapshotId、rowId 与 generation/target 身份关联，携带 metadata、可信来源、贡献、依赖引用与完整性。每项含贡献类型、稳定 ID、归属行、可选显示名、生效位置和证据（registered/configured/observed）。每个维度区分 known、unavailable、partial；“已确认空”不同于“未知”。沿用公开响应界限，每页最多 128 行/贡献项，超出则返回明确游标，不静默截断。浏览器事实只合并相同 roster revision/row/snapshot；新旧 generation 不按 package ID 混合。

| 信息 | 当前事实源 | 规则 |
| --- | --- | --- |
| 工具 | ext-host/ports，Host generation 工具目录，带 ToolSource 的归属 | 只统计实际注册 ID；capabilities.tools.names 是声明 |
| Loop、策略、适配器、记忆、压缩、存储、沙箱、子 Agent、引用、触发器 | host-common 的 ProviderRegistry / 公开 ProviderCatalogEntry | 复用 sourcePackage、kind、id/version、active、selectedFor、scope、restartRequired；包身份不足时补行/快照归属读字段 |
| seam 与服务 | 经过 mount 核验的 provide/inject，Cordis 活服务和 ServiceRegistry | export 声明与 manifest 一致、注册成功后才算实际提供；空入口不虚构注册 |
| 面板与工具卡片 | web-client SlotRegistry，当前 roster，以及已传给页面的 actualSlots | 只用活跃归属注册；注册成功和赢得位置后可见分别展示 |
| 设置 | 公开 settingsSections，D3 config 读合同与 config-panel | 已注册设置入口与行配置表单分别展示；schema 不等于独立设置页 |
| 命令与技能 | CommandService.list，当前 Skill 资源注册与 slash catalog | 普通命令不能冒充 slash；技能来自已选择的资源，不来自 kind |
| 事件 | 活跃 hook、归属 projection 订阅、已观察到的 extension event 类型 | 区分监听与发出；事件是 append 而非预注册；events 权限不等于已经发出 |
| 独立页面 | 现有 surfaceLinks 与部署 service grant | 可用挂载才显示打开链接；声明仅标 configured |
| 依赖/被依赖 | 快照 npm dependencies，runtime tree 服务边，provider selection 与 composition 来源 | 分开包版本范围、必需服务、选中 provider；后端用完整清单求反向边，不用筛选结果 |
| 停用影响/固定版本 | lifecycle 的 assertNoReferences，profile/generation/deployment 引用、durable pins | 提取并复用现有引用收集，按操作区分；当前 inventory blockers 为空不是无引用证明 |
| 权限与信任 | CapabilityReview、ProvenanceReview、inventory | 作者文字不能证明官方来源、信任或停用安全 |

生效位置通过通用贡献类型/slot 映射得到，不按插件 ID 写特例：工具/技能/slash→聊天；workbench slot→工作台；设置 section/config→设置；选定工具策略→审批；hook、Loop、压缩、记忆与遥测→后台执行并说明作用范围。模型适配器影响聊天，引用解析影响输入区，webhook 影响触发入口，skin 可在外观设置选择并在应用中生效。

实际注册不代表在所有会话都选中；展示“已提供，尚未选用”。未加载/停用插件展示“尚未确认”，声明放入权限或明确标 configured 的部分。不能为枚举而加载不受信任或停用代码。事件历史不可用时标未知，不能把权限 flag 当发出事件。

不新增持久化目录、第二份事件库或另一套运行时。后端在已发布 generation 上派生，浏览器在其活 registry 上派生。只有 provider/seam 的官方内置行也需要 metadata；既有 Providers 技术目录保留并共享用途卡片，避免只覆盖可安装包。

## 来源、状态与停用影响

来源归属（官方/示例/第三方/本地创作）与安装方式（folder/npm/git/tarball）分开。官方身份来自 Host 内置行 provenance，示例来自可信的随附 catalog/source provenance，不凭 agnes/community 名称或作者字段判断。经审核的本地 candidate 可以证明本地创作，任意 folder 安装只能证明本地来源，显示“本地来源，作者未确认”。示例与官方默认插件分开筛选，信任另按确切 integrity/capability hash 展示。

卡片保留期望启用、实际运行、浏览器失败与固定版本/保留会话。绿色开关不等于实际运行。离线/过期沿用现有提示和动作限制。

停用提示不作绝对安全承诺，只说明事实：

- **被…引用**：包/服务、配置/provider、部署阻塞，提供可追溯入口。
- **旧会话仍保留此版本**：固定/绑定会话数；现有语义允许 draining 时，pin 不自动变成停用阻塞。
- **需要重启**：来自实际 provider 生命周期或当前操作结果。
- **未发现阻塞引用**：只用于完整、当前、针对该操作的后端引用结果，并说明新会话会失去的贡献。
- **停用影响尚未确认**：不可用、部分或过期的事实，不显示零引用。

从 lifecycle 检查提取只读引用收集，保留 disable/remove 各自策略。提交时后端仍重查，前端提示不能覆盖后端授权。不开批量停用、自动释放 pin 或连带删除依赖。

## 列表线框

```text
插件                                             [从来源安装]
[已安装] [发现] [插件类型] [示例与 FDE]
[搜索名称、用途、工具或技能________________________]
[类别：全部 v] [来源：全部 v] [状态：全部 v] [kind v]

客服分流示例                    示例 · Agent 执行       [已启用]
对样例客服工单分类，并在记录模拟回复前请求批准。
提供  [Loop 1] [工具 4] [策略 1] [技能 1] [面板 1]
生效  聊天 · 工作台 · 审批流程
运行中 · 已信任 · 2 个会话保留旧版本
[详情]                                  [为新会话启用]

执行进度检查                    官方 · Agent 执行
发现重复写入和停滞的执行，并按配置限制要求修正或升级处理。
提供  [验证器] [修正策略]        生效  后台执行
默认会话已选用                  [详情]

vendor/plugin                   第三方 · 未分类
作者未提供用途说明
kind：tool · 提供内容尚未确认 · 已安装 · 未信任
[详情]                                                [审核]
```

上方数量只是线框占位，非该插件测量结果。使用类别筛选，不默认展开九个分组；来源与类别正交。多行包可展开，不重复展示已属于包的贡献行。来源“全部”作用于当前 tab，不另建汇总路由；没有包 inventory 的内置 provider 在 Providers 中也有相同用途卡片，并从已安装页提供跳转；仅有 manifest 的休眠条目不创建已安装状态。

搜索 ID、显示名、summary、两种已提供语言、真实工具/provider/Skill/命令 ID 和通用贡献标签，不区分大小写。关键词在可搜索字段间按 AND 匹配，类别/来源/状态/kind 也按 AND 组合。无结果提供清除筛选。已安装使用当前归一化 inventory，catalog 在现有离线后端查询中先搜索再分页，不能只筛首屏。未激活 catalog 项只搜索可核对的声明并标注声明。不开远程 marketplace，不因搜索加载插件。

标题按钮打开详情，开关与动作保持独立，不把交互控件嵌入整卡按钮。最多四个 provides chip 后加 +N，窄屏折行，整句对无障碍读取保留。375px 过滤器与卡片纵向排布，动作有完整标签，无横向滚动。ID/hash/长路径进入技术披露；错误、权限问题和用途缺失提示可见。

## 详情线框

```text
客服分流示例                                          [关闭]
示例 · Agent 执行 · 运行中 · 已信任
概览 / 提供什么 / 在哪里生效 / 设置 /
权限与信任 / 版本与固定 / 依赖关系

概览：用途短句、说明段落、明确模拟范围、文档链接
提供什么：真实 Loop/工具/策略/技能/面板 ID，注册和选用范围
在哪里生效：聊天、工作台、审批、设置；是否已注册、可见、选中
设置：现有 D3 schema 表单与 configReload 提示，相关设置页入口
权限与信任：复用 CapabilityReview 与 ProvenanceReview
版本与固定：已安装/实际版本，绑定会话、固定版本与现有释放规则
依赖关系：需要哪些包/服务/provider；哪些项目依赖它
停用影响：当前预设引用此插件；旧会话保留其代码
[为新会话停用]                 [移除]（沿用当前后端限制）
```

七个语义区段使用详情内跳转导航，不新增七层嵌套 tab。保留 D3 的 Settings tab/form，设置跳转进入该表单；默认概览。权限、依赖不藏入技术披露。打开保留合理焦点，Escape 关闭后返回标题按钮，刷新不抢焦点、不覆盖未保存配置。只读模式展示解释与可用读链接。

## 一致性、主题与证据

扩展 @agnes/web-ui 的 PluginList/DetailContent，并复用 SettingsCard、SettingsToolbar、Field、SettingsInput、Select、Badge、Button、SettingsDetails、StateSwitch。外部 UI 库仍仅在 web-ui。使用共享 token、间距、边框、圆角、状态色和 skin hook，状态伴随文字。候选审核、信任、pin、配置仍归现有模块。

遵循已合入的 [Web UI 一致性合同](../../develop/ui-consistency.zh-CN.md)：SettingsPage 拥有唯一标题、说明和页面动作，子面板不重复标题。列表用 PluginList 或 SettingsList/SettingsRow，技术信息用 SettingsDetails，不为每个属性嵌套卡片。加载/空/错误/成功用 SettingsState，保留上下文与草稿。原生 dialog 宿主保留控制器与共享内容，取消在主动作之前。原生选择语义用 SettingsSelect，富搜索选择才用 Select，保留既有 ID、aria 关系、IME 和 skin hook。

沿用 01-tokens.css 与 web-ui 的语义桥接：行内 --s8/--s12、区段 --s16/--s24、页面 --s24/--s32；输入面用 --agnes-input-surface，状态用双主题 --agnes-status-*，支持减少动态效果，不另建 palette。390px 是正式窄屏评审规格，线框的 375px 是额外目标。嵌入/独立页面共享标题、正文、动作节奏。

通用界面、错误/空/未知状态均提供 en/zh-CN，使用稳定 test ID：plugin-category-filter、plugin-origin-filter、plugin-summary、plugin-provides、plugin-appearances、plugin-dependencies、plugin-disable-impact，加 package/row/version 属性。标签可见，控件键盘可用，焦点可辨，chip 为可读静态文本。浅深主题均应可读，停用状态不只用颜色表示。

## 依据源码描述当前页面

admin/views.tsx 先展示 SettingsHub 导航、候选收件箱和 generation-drain 提示，再放搜索、KindFilter、来源安装和插件创作动作。当前没有类别与来源筛选。admin/page.tsx 的 filteredInstalled 搜索 ID、版本与 contributionText，不搜索统一用途 summary。

web-ui/src/admin-list.tsx 逐个展示已安装包：标题按钮、kind/状态、可选描述、版本、StateSwitch 和可展开技术详情。四个官方辅助包的名称/描述来自 UI locale key。已知样例使用 settings 里的 ID 名称表，FDE 共用宽泛 summary，没有分别说明其业务用途。其他条目可能只有技术包 ID，没有描述和“用途缺失”提示。来源/integrity 可在技术详情查看，但没有清晰的可信来源归属 badge。

renderDetailPluginView 已展示来源、integrity、贡献概括、实际浏览器 slot、失败、清理与回滚目标，并复用能力/provenance 审核和 D3 配置包装。生命周期信息已有基础，尚缺统一的用途概览、实际提供内容、生效位置与按操作的停用依赖。这是源码观察，不是运行验收结果。

开发期间禁止产品构建。Phase A 使用上述源码描述和线框，真实 before/after 截图统一留到预交接验收阶段：通过共享锁一次一个浏览器/页面，覆盖双语、浅深色、桌面与 390px。提案审核不以截图为前置条件。

## 实施顺序与留待统一执行的验证

1. 共享 schema/type/校验与包、行、extension 解析；按确切快照传 metadata，更新双语作者文档。
2. 把 CONTENT 中 37 个官方 manifest 与 56 个样例文件的双语文案写进作者清单；补齐普通官方 row、默认 Loop、provider 与四个官方辅助包；删除逐 ID 名称/描述和 regex 展示特例。
3. 最小只读事实投影：实际注册、来源、完整依赖与被依赖、按操作的停用影响；保持 target/授权语义。
4. 共享卡片/详情、搜索与组合筛选；保留候选、信任、固定版本、安装和 D3 配置流程。
5. 扩展现有就近单元测试并写一个已注册 Web spec；本阶段只编写，不运行。真实 before/after 截图留至预交接验收，在锁内采集。

测试用例覆盖缺 metadata、zh 回退、空白/超长/未知字段/危险 URL 拒绝、第三方同合同、快照保留文案、无注册/停用不能虚构能力、浏览器版本不匹配、多行归属、注册与选用区分、命令不冒充 slash、事件权限不冒充 emission、反向依赖来自完整 inventory、过期/部分影响不能承诺无阻塞、summary/真实工具搜索和首屏以外 catalog 命中、AND 筛选、刷新保留未保存 D3 表单。Web spec 用合成数据与稳定 role/ID。

提案/开发阶段不运行 tsc、Vitest、构建、Web spec、CI、guards。Phase A 证据只包括源码阅读、清单枚举与 diff 自审。实际执行结果留给统一验证，公开文档不能把提案写成已交付 API。
