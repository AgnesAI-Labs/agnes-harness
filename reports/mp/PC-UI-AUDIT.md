# PC-UI-AUDIT：Web 组件架构与操作反馈审查

## 中文摘要

当前 Web 已有共享组件体系，问题是**同一语义有多条呈现路径、页面继续决定基础外观、操作结果没有统一出口**。不能把这次工作理解成再造一套 UI 库，也不能逐页重新设计。

优先处理保存反馈：当前基线**已有共享 Toast**，不是缺少 Toast 文件。`web-ui/src/ui/toast.tsx` 提供 antd message 包装，`overlay-toast.tsx` 提供对话框内的容器适配，公开入口已导出；有约 8 个 JSX 调用点、分布在 7 个文件。与此同时，成功还会走持久绿色 `SettingsState`、2 秒 `SettingsSaveBar`、普通行内文字、全局 `#notice`，或完全没有成功提示。最明显的具体问题包括 Schema 表单同时产生两份成功确认、模型设置成功提示夹带生效范围、技能目录把“已保存”和“还需扫描”混在一条绿色状态中。

建议先审批本文 §5 的 **18 项组件规格表**，再执行 §6 的迁移批次。普通成功统一短暂 toast；字段错误就地显示；操作失败保留在相关操作区域并给出可执行的恢复方法；仅需用户采取行动的后果保留 notice；按钮统一 busy。保留 2026-10-12 决定的自研展示原语，Ant Design / Ant Design X 只经 `web-ui` 接入。**页面逐页 redesign 暂停；Menu 由 PC-SIDEBAR-MENUS 建设中，本任务不并行另造。**

本次只读审查产品代码，仅新增此报告。源码基线：`09218d3d73b7cf009f6d61d7bfab0aa0d6d46062`，分支 `review/agh-pc-ui-audit`；审查时 `git ls-remote origin refs/heads/feat/agh-plugin-core` 返回同一 SHA。未启动应用、未做浏览器或像素验收。下文“源码确认”和“视觉待复核”严格区分。

## 1. 保存、操作的成功 / 错误 / 进度反馈完整盘点（最高优先级）

### 1.1 读表约定与共用样式

这是按**用户可触发操作族**盘点，合并复用同一处理函数的按钮，例如 triggers 的 configure/upsert/delete/test；并非只搜索“已保存”。包含页面关闭后反馈、自动保存、复制、下载、审批和插件示例。纯读取/导航没有“保存成功”，也在后表明确说明。具体反馈渲染点另见附录 B；组件调用点见附录 A。文件路径以下均相对仓库根，`web-admin/…` 等缩写均指 `packages/web-admin/src/…`。

| 代号 | 显示位置 / 外观 / 语义 | 持续时间与清除方式 | 实现依据 |
| --- | --- | --- | --- |
| T | 顶部居中 toast；成功用 success 绿文字/浅绿底/绿边框，info 用 info 色，error 用 danger 色；图标+文字；`role=status`、polite | 默认 3000ms；Escape；卸载清理；单次实例由调用方 `open/onDismiss` 管理 | `packages/web-ui/src/ui/toast.tsx:34`、`overlay-toast.tsx:9`、`components.css:615` |
| N | 右上独立错误卡；普通文字、popover 底、细边框和关闭按钮；message 是 `role=alert` | 默认 6000ms；关闭、pagehide；最多 5 条由 appNotice 保留 | `web-ui/src/ui/notifications.tsx:22`、`components.css:7`、`web/src/app-notices.tsx:47` |
| S+ / S− / S0 | `SettingsState` 占据内容宽度的状态块：成功绿字绿底，错误红字红底，empty 中性文字；success/status，error/alert | **组件无计时器**，一直到调用方清空状态、替换、离页/卸载；不能称为 toast | `web-ui/src/settings-layout.tsx:254`、`tokens.css:540` |
| B | `Banner` 内容宽度 notice：info / warning / error 底色，图标有语义色、正文常规文字；可带行动按钮 | 无自动消失；只有 info 且传 onDismiss 才能手动关；warning/error 不提供关闭 | `web-ui/src/ui/banner.tsx:18`、`components.css:825` |
| F | Field：错误替换 hint，红字+错误图标；连 `aria-describedby/aria-invalid`；错误 `role=alert` | 保留至字段校正 / 新校验结果；无计时器 | `web-ui/src/ui/field.tsx:37` |
| G | 组标题“保存失败 · 重试”，红色；读取错误则 `Loadable` 保留已有内容并显示重试 | 到成功重试或新状态；无成功输出 | `web-ui/src/ui/settings-controls.tsx:51`、`components.css` 的 `.agnes-settings-save-failed` |
| I | 普通行内 status/alert；颜色依所在页面 CSS，不自动等同绿/红 | 通常持久，除非表内另注 | 各操作行给出源文件 |
| P | 按钮 `loading`→spinner + `aria-busy`；有些页面仅 disabled 或容器 aria-busy，外观不等价 | 到 Promise/后台操作结算；不能把 HTTP accepted 当完成 | `web-ui/src/ui/button.tsx:28` |

持久状态均指“当前挂载生命周期内保留”，不是写入持久存储；页面重新挂载可能消失。所有颜色上述均为 `--agnes-status-*` / `--agnes-text-*` token，浅深色已有对应定义；绿色满宽块的问题是**反馈类型和生命周期**，不应靠改成另一种绿色来解决。

### 1.2 保存与配置操作矩阵

“文案”列给出现码的中文文案或精确 locale key；动态错误使用所属 catalog / 安全错误映射，不推断为固定字符串。时长沿用上表，P 栏特指可见进度，单纯 disabled 已明确标出。

| 操作、入口 / 源码 | 成功：位置、时长、样式、文案 | 错误与进度 | 生效说明 / 问题 |
| --- | --- | --- | --- |
| 通用 Schema 保存 / 测试；`web-ui/src/config-form.tsx:309`、`schema-settings.tsx`、`provider-config-form.tsx` | S+ 持久，`saved`=“配置已保存。”、`tested`=“配置测试完成。”；sticky 模式还产生下一行的确认 | 字段走 F；未知/schema 错误 S−；安全映射 `appServerErrorMessage`；保存按钮 P，测试按钮仅 disabled，共用 busy | 通用 action resolve 只说明保存完成；无统一 effect 返回值。不能自动添加“立即生效” |
| 脏表单保存条；`web-ui/src/settings-layout.tsx:669` | `.agh-settings-saved` 行内绿色勾+`ui.saved`=“已保存”，**2000ms**；dirty=false 时显示 | 保存按钮 P；discard 禁用；业务错误由外层负责 | Schema sticky 路径同时保留 S+：**重复成功确认**。Skill priority 的 SaveBar 没传 saved，并不会显示此成功行 |
| 模型账户新增/修改；`web-admin/src/settings.ts:625`、`web-ui/src/settings-accounts.tsx:175` | 账户列表 T，`accounts.saved`=“账户已保存”；inline host 流程返回父页时 `savedNotice=!inlineHost`，**不能假定所有入口都有 toast**；控制器还 `say(settings.saved.*)` | `#config-error` 普通 alert，经脱敏错误映射；账户表单 `#config-save` disabled+aria-busy；step status“正在保存…”；OAuth 另见下表 | `settings.saved.restartRequired/newSessionsOnly`，当前会话模型不变；成功回调还进入 app notice，存在多位置反馈 |
| 账户设为默认 / 删除等 account action；`web-admin/src/settings.ts:779` | say `settings.saved.restartNeeded/newSessions`，普通表单 status，持久到后续 step | 同 `setError` 与控制器 busy；列表变化是另一可见结果 | “已保存；需要重启后台后生效。” / “已保存；对新会话生效，已有会话保持原配置。”；与新增账户文案/载体不同 |
| 主模型/思考强度/上下文预算；`web/src/app.ts:1990–2071`、`model-picker.tsx` | `appNotice.setText`→全局 `#notice` I，持久中性灰；`app.notice.modelSaved`=“模型配置已保存，后续请求将使用新的思考强度和上下文窗口。”；账户回调还有 `app.model.savedNotice` | 失败经 showError→N；尚未生效用 `app.model.savedNotEffective` 留在 #notice；picker 有 disabled/忙状态 | 后续请求、新会话默认、未生效三种作用域不同。`#notice` 固定 role=alert，成功也被作为 alert 朗读 |
| 全局辅助模型；`web-admin/src/settings/model-slots.tsx:133` | S+ 持久，`modelSettings.slots.saved`=“已保存，新会话会使用这些模型。” | B error，failed/conflict，带“重新读取”；选择器 disabled，busy，不是保存按钮 P | 自动保存选择；新会话生效不是需持续占位的行动 notice |
| 当前会话辅助模型；`web-ui/src/session-auxiliary-models.tsx:40` | S+ 持久，`modelSettings.slots.sessionSaved`=“已为当前会话保存” | S− `sessionFailed`；按钮 disabled，无 loading；修改选择时清消息 | 与全局辅助模型效果不同，不能统一改成“新会话生效” |
| 新会话默认 loop/model-adapter 等；`web-admin/src/admin/plugins/session-defaults-panel.tsx:100` | **无成功提示**；useAutosave 更新行值 | G，busy/choice.busy 写容器，部分控件禁用；409 会重新读取/保留意图 | 行和帮助说明新会话默认，不应全局 toast 每个中间草稿 |
| 默认权限；`web-admin/src/settings/permission-defaults.tsx:86` | **无成功提示**，选择更新/确认框关闭 | G+conflict 行内 note，saveFailed 时另有 S−；容器 aria-busy，确认动作由 Dialog 持有 | 新会话默认；full-access 仍需原有确认，不能将 toast 接入变成权限逻辑变更 |
| 组合包顺序应用；`web-admin/src/admin/plugins/bundles-panel.tsx:337` | I footer status，持久中性文字，`bundles.saved`=“已应用。网页还不能重启后台：请重启 agh，之后新会话按此顺序生效。” | B error（failed/conflict）带 reload；按钮 P，容器 aria-busy | **需重启**是持久 notice 的合理用途；“已应用”与尚待重启易混，应拆保存结果与生效行动 |
| 子代理引擎保存；`web-admin/src/settings/child-engines.tsx:102,213` | I `.capability-save > span`，持久**中性灰**；`engine.saved/savedRestart` | 同一 span，error 时红色、alert；按钮 P；命令/allow 缺失是组级消息，非 F | “已保存。新会话会使用这些子代理，进行中的会话保留原版本。” / “已保存。请重启运行时后，新会话才会使用这些引擎。”；“后台/运行时/引擎/子代理”混用 |
| 自定义指令/回复风格；`web-admin/src/settings/personalization.tsx:73` | **无成功提示**，useAutosave，文本停 1000ms / blur 保存、选择立即保存 | G；冲突 `PromptConflictNotice`；组 aria-busy；草稿保留 | full override 造成不可编辑时 B info；非保存成功，不能删；作用范围从 prompt 合同读取 |
| 完整提示词替换/重置；`web-admin/src/settings/system-prompt.tsx:84` | **无成功提示**，状态“使用中/未使用”与编辑器变化 | G + conflict notice；应用按钮 P；警告 B 持续 | 页内静态“只对新会话生效。”；“我已理解”确认必须保留 |
| 上下文设置/规则读取；`web-admin/src/settings/context.tsx:153` | 保存**无成功提示**；自动保存选择/文本，读取更新快照 | 保存 G；规则读取失败 B error；组 aria-busy | 帮助保留上下文范围；读取不是保存成功，不能因 load resolve 发 success |
| 记忆设置/写文件/重置或清空；`web-admin/src/settings/memory.tsx:65` | **无成功提示**；更新 snapshot/file/content | change 失败保留 failedChange→G 可重试；file 错误 B；busy 禁用；字段/文件数据仍由后台校验 | 内存访问启用和具体记忆文件内容不是同一个效果；不能同用含“新会话”的模板 |
| 自动审批开关/模型/规则增删清空；`web-admin/src/settings/auto-review.tsx:109` | **无成功提示**，useAutosave | G；加载模型失败 B；aria-busy/控件禁用 | 规则作用于未来调用，不能暗示更改历史审批结果 |
| OTLP 设置自动保存；`web-admin/src/settings/observability.tsx:57` | **无成功提示**；开关/选择立即、文本 idle 保存 | G；组 busy；invalid header 名称/env `addHeader` 会直接 return，**没有字段反馈** | 静态 help“设置在一秒内生效。”；不应用客户端计时器据此宣称后端已生效 |
| OTLP 测试/刷新；同文件 `:67,287` | 测试通过 B **info**，持久 `ok`=“Collector 已接受连接测试”；刷新无成功提示 | 测试失败 B error，`failed`=“Collector 连接测试失败”；按钮仅 disabled | 测试结果与保存完成不是同一事件；长期健康状态另留 status group |
| 搜索服务保存/默认服务/移除凭据；`web-admin/src/settings/search.tsx:229,328,550` | S+ 持久，`searchSaved`=“搜索设置已保存。下一次网页搜索会使用它们。” | 页面与编辑器 S−/B error，安全 envelope；按钮主要 disabled；清除/设默认后走同一 save 反馈 | **成功出现在“试试搜索”区域内**，不在被修改服务行；高可见性位置问题 |
| 搜索测试；同文件 `:278,545` | S+ 持久，“测试通过 · N 条结果 · …ms”（keys tested/results）；结果列表保留 | S− probeFailure，耗时附注；忙时 disabled | 测试成功不可复用“已保存”；无结果也不是保存失败 |
| 定时任务新建/编辑；`web-admin/src/settings/schedules.tsx:255`、`schedule-form.tsx:545` | 返回列表，S+ 持久 `schedulesCreated/schedulesSaved`=“定时任务已创建。/定时任务已保存。” | 表单 S−，字段解析失败经 failureText 汇总；保存按钮 P | 保存的是任务，不是任务已经运行；页面跳转后仍需同一次结果可见 |
| 定时任务运行/暂停/继续/归档；同文件 `:281,570` | S+ 持久 runStarted/noticePaused/noticeResumed/schedulesArchived | 列表/确认处 S−，busy 阻重复，保存/归档等动作有 P | runStarted=请求开始，不等于执行完成；实时运行记录应保留为业务事实 |
| Webhook 端点 configure、开关、规则 upsert/delete、test；`web-admin/src/settings/triggers.tsx:162` | 所有 action 共用 notice；`delivery.status ?? 'saved'`；saved/accepted 为 S+，pending/disabled/duplicate/no-rule 为 S0，其余 S−；持久；saved=“已保存” | error 为 S−；JSON.parse 错误也只 generic failed；section aria-busy；编辑保存 P，但端点保存/测试仅 disabled | 删除、开关都可能显示“已保存”，**操作对象丢失**；accepted/pending/unknown 必须保留不同含义 |
| 插件配置保存/默认值/校验；`web-admin/src/admin/plugins/config-panel.tsx:126,153` | `<p role=status>` I 持久，`saved`=“配置已保存。”；默认值只改草稿，无成功反馈 | invalid/conflict/refused/pending/unavailable **也走相同中性 status 段落**；issues 同时在列表和字段展示；saving 仅 disabled；validating I“正在校验…” | live/next 用另一段说明：“在安全运行边界…”/“已有会话继续使用原配置”；pending 不可变成绿色成功 |
| 技能目录保存；`web/src/pages/plugins/skill-folders.tsx:45,107` | S+ 持久 `folders.saved`=“已保存。确认重新扫描后，这些目录里的技能就会出现。” | 相对路径 F；读/写失败 S−共用 `folders.failed`；保存按钮仅 disabled | 保存成功 + **还需扫描**应拆开；当前 onSaved 打开后续扫描流程，不能只把整句塞 3 秒 toast |
| 凭据创建/重命名/替换/删除；`resource-control-web/src/credential-editor.tsx:48`、`credentials.tsx:115,164,204` | 返回列表，S+ 持久；“凭据已保存。/凭据已重命名。/密钥值已替换。请重新连接使用它的 MCP 服务。/凭据已删除。”（credentials-locale 的 saved/renamed/replaced/deleted） | B error，编辑器表单级红色错误，删除确认 B；保存按钮 P，delete ConfirmDialog busy | 不回显值；被引用/权限/冲突是不同失败，不应笼统“网络错误”；重命名不等同替换凭据值；替换后重连是需行动的后果，不应随toast丢失 |

### 1.3 其他操作、业务进度与无反馈路径

| 操作 / 源码 | 成功 / 错误 / 进度的位置、时长和文案 | 样式 / 后果说明 |
| --- | --- | --- |
| 插件安装、启停、更新、删除、回滚；`web-admin/src/admin/plugins/operation-feedback.tsx:24` + `admin/page.tsx` | completed 后 T 3s，`ux.success.{operation}`；新安装 `review.installed`“已安装「{name}」”+“去启用”T **6s**；开始检查/安装/更新为 controller notice，operation 状态还在列表呈现 | 成功 T 绿；失败 Banner 红 / 安全错误，工作中 notice 中性或 info；插件变更的后台状态和浏览器 UI 待确认分开，不应“HTTP 成功→已启用” |
| 插件运行状态补偿/刷新；`web/src/pages/plugins/plugins-tab.tsx:210–247`、`web-admin/src/admin/plugins/admin/page.tsx:824` | inspection/operation 指示、recovery warning、load error B；一般 state 是 S0；`notice.runtime-pending/runtime-retry` 持久 | 后台完成、浏览器 UI 待确认是需行动 notice；不能与普通成功一起自动清除 |
| 候选草稿测试/发布/拒绝/隔离；`web-admin/src/admin/plugins/candidates.tsx:243,432` | pending 控件禁用；发布后 S+ 持久“candidates.published”并带安装/打开操作；错误普通 `<p role=alert>`，测试细节持续展示 | 一般错误未包共享红色状态；发布并不表示启用，也不表示原会话已换版；不要丢弃测试结果 |
| 本地插件信任目录、重新扫描；`web-admin/src/settings/runtime-panels.tsx:409,428,518` | `trusted/rescanned` 在 SettingsFooter status，I 持久；失败 B error；扫描按钮 P | 信任/扫描/激活结果不同；发布记录和 restartRequired 独立保留 |
| 迁移会话至当前插件；同文件 `:149,307` | S+ 持久，`migrated/alreadyCurrent`，附 previous/current ID；失败 B error；确认操作 P | 保留迁移条件、只改合格会话、失败仍原代际；刷新失败不得反报迁移失败 |
| 清理 retained pins；`web-admin/src/settings/pins.tsx:50,109` | 成功主要是列表变化；skipped>0 却 S+“pinsSkipped”；逐项失败 S−，读错误 B+retry，busy 禁用 | “N 项仍被使用，未释放”是部分未执行，**不应绿色全成功**；不能为消除提示强行删除 |
| Skill/MCP 创建、启用、停用、删除、优先级、工具模式、重载；`resource-control-web/src/admin.tsx:392`、`mcp-form.ts`、`web-ui/src/resource-detail.tsx` | admin-notice I 持久；submitted→succeeded/failed；最多120次*500ms后 still running warning；SkillPage 把 successMessage 另显示 T 3s（embedded/standalone 两个互斥调用点）；优先级 SaveBar 无 saved 标志 | success 绿文字，warning 黄，error 红；MCP created 文案明确“已创建，但尚未可用…点击启用”；保存定义、发布和可用不可合并 |
| MCP OAuth/凭据绑定；`resource-control-web/src/mcp-credentials.tsx`、`mcp-wizard.ts` | 拒绝/未授权帮助和保存结果进入资源 notice；控件禁用；无独立统一 operation toast | 不能把已保存 credential 当已登录/已连接；不要改变安全引用模型 |
| 模型 OAuth；`web-admin/src/oauth-controls.ts:83,153,221` | I oauth-status，持久“等待授权…”/provider notice/“授权完成”；awaiting aria-busy；失败经 callbacks.error→账户错误 | 完成授权后还需模型验证/账户保存；现有状态不能换成“账户已保存” |
| 首次引导连接账户/工作区/完成；`web-ui/src/first-run.tsx:116,124,155`、`web-admin/src/first-run.ts` | 账户就绪一处普通 status、“默认模型已就绪”一处 S+，均持久；busy S loading /按钮 P；error S− | 属于向导步骤完成事实；应保留步骤标记，但不重复发保存成功和默认就绪两份 toast |
| 诊断刷新/复制/导出；`web-admin/src/settings/diagnostics.tsx:140,292,429` | copied/summaryCopied/exported 为 S+持久；invalid/copyFailed S−；error B；busy 禁用 | “开始下载/已导出”不能声称文件已经写入用户磁盘；导出审查、部分资料缺失应继续显式说明 |
| 诊断包流程；`web/src/diagnostics-dialog.tsx`、`web-units/src/diagnostics-viewer.tsx`、`web-units/src/diagnostics-locale.ts` | Dialog 中状态/下载链接，title.saved“诊断文件已保存”；partial、错误和生成阶段由流程保留；saveZip有实际await写入的原生文件选择器路径与下载链接fallback | 持久的是可下载产物/部分结果，而普通操作结算可 T；原生文件写入可确认saved，下载fallback只证明开始下载，应区分措辞 |
| 后台任务取消/终端输入/停止；`web-admin/src/settings/jobs-panel.tsx:116,275`、`web-conversation/src/workbench/terminal-panel.tsx:239` | 成功主要更新任务/终端状态，未发 success toast；失败 S−/B；取消确认 busy；终端运行/退出/截断为 I | “请求取消/已终止/结果未知”有后端差异；终端每次按键不发 toast，命令回显是业务反馈 |
| FDE 业务 Agent 启动/安装计划；`web-admin/src/agents/start-dialog.tsx:206,449`、`start-flow.ts`、`gallery.tsx` | I progress help，卡片 starting/loading，失败 B error；成功导航到会话，无单独成功 toast | 进度按实际启动步骤；阻断配置 B、demo info B 不与成功混用；进入会话即成功可见结果 |
| FDE 工具结果；`examples/fde/{meeting-actions,support-triage}/client/index.js`、`examples/community/tool-panel/client/index.js` | 原始 `block.status ?? 'planned'` 放普通 `<p role=status>`；结果/等待英文 pre，持续随业务状态，无计时器；没有用户保存按钮 | 未本地化 planned/completed/failed；没有统一阶段色/错误动作；发送回执是业务事实，不能以会消失 toast 取代 |
| 会话审批与恢复确认；`web-units/src/approval.tsx`、`web/src/app/pending-approval.ts`、`app/turn-controller.ts` | 待审批卡持久，answered 等待 Agent；按钮 disabled，容器状态驱动；失败走 showError/N 或恢复 notice | 保留风险、重写摘要、未展示内容、reconcile unknown；“已批准”不代表工具已经执行成功 |
| 全局 profile 审批；`web/src/regions/profile-approvals.tsx:44,89` | 成功移除决策行，无 success toast；错误普通 alert，持久到下一次成功读取/回答（3s polling）；busy 禁用整组 | “批准后返回原操作继续；审批只适用于所示操作。”属重要后果；当前读取错误可能被轮询清除，要区分回答失败与列表读取恢复 |
| Trace 保存未来规则；`web-units/src/trace-review.tsx:40` | I 普通 p，成功 status“以后同类调用的规则已保存”；失败 alert“无法保存规则”；持久；按钮仅 disabled | 作用范围明确 future calls，历史审批不变；未来规则保存也应接入同一个 plain success toast |
| 消息点赞/备注/撤回/生成 Skill；`web-units/src/message-feedback/form.tsx:313,336` | 普通保存成功**无提示**，pressed 状态变更；drafting/生成完成/需本地模型/保存失败/草稿失败用 feedback-status I，持久；retry/打开 review 行动；pending aria-busy | tone=busy/done/error 有 domain CSS；localOnly 明确“仅保存在此设备”，不可说全局已保存；候选待审核是业务状态 |
| 新建/选择工作区；`web-units/src/workspace-dialog.tsx:96,142`、`web/src/workspace-picker.ts` | 成功关闭并导航，**无 toast**；失败普通 alert；表单/按钮 aria-busy | 若成功导航已明显完成可不叠 toast；文件夹选择器取消不是操作失败 |
| 会话重命名/归档/恢复；`web/src/session-actions.tsx:35,181`、`archived-sessions.ts` | 成功行/列表变化或 dialog 关闭，无 success toast；rename 失败红色普通 alert；archive 错误 sink→N；pending aria-busy | “名称已保存，但列表刷新失败：…”专门区分部分成功；重试只刷新，不二次改名 |
| 会话 fork；`web-ui/src/conversation/turn-actions.tsx:219`、`web/src/app/session-controller.ts:414` | 成功新会话/全局 #notice“app.fork.created”持久；失败 turn-feedback I（**无自动消失**）；pending 禁用 | 不能自动重试 fork，避免重复会话；toast 必须以 operation/session identity 去重 |
| CopyButton；`web-ui/src/ui/copy-button.tsx:21`，提示词/文件等消费者 | 成功按钮图标变勾、label 改“已复制”，**1600ms**，隐藏 polite status；失败只回调 onCopied(false)，**消费者不传就无可见失败** | 当前是另一种操作成功反馈；目标普通成功统一 T，复制勾可作装饰确认，避免双 live announcement |
| 对话复制；`web-ui/src/conversation/turn-actions.tsx:195` | 成功 turn-feedback 1600ms + Actions 图标变化；失败 turn-feedback 持久 | 失败与成功同一 status 容器；保留 legacy clipboard fallback 与焦点恢复 |
| 插件详情复制；`web-admin/src/admin/plugins/detail-copy.tsx` | 成功 T 3s；失败 S−持久；无 busy | 同一个复制在不同页有三种模型 |
| Intelligent UI 复制；`web-ui/src/intelligent-ui/{chip,surface}.tsx` | T 3s success/error；`ui.copied/ui.copyFailed` | 直接导入 primitive toast，和公开 overlay adapter 并存；要验证活动 dialog 容器 |
| Intelligent UI action / question submit；`web-ui/src/intelligent-ui/{catalog,question-card,form-fields}.tsx`、`web/src/intelligent-ui` | 组件级 pending、字段错误、receipt / source-state；`SettingsState` 和会话摘要持续保留；无统一 operation result 总线 | confirmed/refused/stale/approval-needed/unknown 的 receipt 是业务事实；未知结果要 notice/检查，不能自动成功或自动重试外部写入 |
| 文件产物下载/预览；`web/src/intelligent-ui/artifact-file.tsx:402,433`、`web-client/src/artifact-download.ts` | deliverable-note I loading/status/alert，下载 failure 保留，成功主要由浏览器下载；无统一成功 toast | 下载 helper 只返回 URL/release，不渲染 UI；验证 sha/大小/权限不属于展示组件职责；“已开始下载”准确于“已保存到磁盘” |
| 文件树/changes 刷新、会话搜索、引用选择、查看 trace、切页/tab/menu、展开、dock 调整；对应 `web-conversation/src/workbench`、`web/src/{session-search,workbench}`、`web-units/src/reference-picker.tsx` | 这些是读取/局部交互；无保存 toast；读取错误 S−/Loadable/普通 note，loading 200ms 后占位/3s slow；选中/展开即反馈 | 不把任何 Promise resolve 都转换为 success。终端/代码/树量测仍允许专用布局 |
| 外观/语言/字号/皮肤、侧栏展开、dock 选中位置；`web-foundation/src/{appearance,theme,skin}.ts`、`web/src/app/appearance-controller.ts`、`navigation.tsx`、`workbench/dock.tsx` | 大部分即时视觉变化；无保存 toast；存储异常部分 catch 后降级；settings route 移动用 info T | 用户设备偏好与后台配置不能同称“已为全部会话保存”；无需每点一次主题弹保存提示 |
| 插件 service-panel v1/v2；`examples/packages/client-service-panel/{v1,v2}/extensions/main/client/index.js` | 读取 service.version 后 sidebar 字符串 `backend … / invalid / unavailable`，持久普通文字；无忙态或 toast | 是显式演示，不是产品 canonical 反馈；client-panel/multi-panel/DSH fixture 见 §2，不应机械改坏对账测试 |

还需计入以下容易被“保存”字面搜索漏掉的操作：

| 操作 / 源码 | 成功、错误、进度、时长及样式 | 效果 / 限制 |
| --- | --- | --- |
| 会话书签增删；`web-ui/src/conversation/turn-nav.tsx:125`、`web/src/app/session-bookmarks.ts` | 成功书签标记变化，无success toast；失败预览卡内红色`turnNav.bookmarkFailed`，到切换预览/关闭或后续结果；异步写队列保留最新意图 | 保存会话preferences；旧失败不能撤销新意图；不支持RPC时隐藏操作 |
| 当前权限切换；`web-admin/src/permission-picker.tsx`、`web/src/app.ts:1873` | picker禁用/忙态；成功#notice I持久`app.permission.draftNotice/notice.full/notice.mode`；拒绝切换sandbox为`app.permission.fixed`+“在新会话中使用”行动；其他失败N | 当前会话/新草稿/后续序号不同；权限提升确认与fail-closed保留 |
| 新草稿Loop/组合包/preset选择；`web/src/loop-picker.tsx`、`new-session-dialog.tsx` | 即时selected视觉，未提交不报已保存；开始会话走workspace/session流程，catalog错误留本地说明 | 会话创建草稿不是持久默认配置；多选bundles是Select实际用例 |
| 撤销会话/长期授权、刷新工具；`web/src/session-runtime-dialog.tsx:373`、`session-runtime-sections.tsx:119,179` | 撤销成功重读grants列表，无success toast；行按钮P；失败options.error→app N；工具refresh P，读取失败S−+retry；restartRequired为持久Tag/status | 撤权成功与列表刷新分开；scope/过期/拒绝必须保留 |
| Goal pause/resume/complete/clear；`web-conversation/src/goal-actions.tsx` | 按钮发slash command，进度/结果走conversation/goal snapshot，不单发save toast；失败走submission showError，disabled随session控制 | 命令已提交不代表Goal已结束；持久phase/reason留在goal卡 |
| Composer排队、立即发送、移除/编辑附件；`web-units/src/composer/{queue,attachment-list}.tsx`、`web/src/app/{submission,composer}-controller.ts` | 列表/草稿变化反馈；异步queue action catch(onError)→N；send pending由真实opState控制，上传错误留附件区域 | 草稿局部操作不发后台保存toast；停止未确认保留action notice |
| Computer Use控制/查看；`web-conversation/src/computer-use-pane.tsx`、`computer-use.ts`、`web-ui/src/settings-computer-use.tsx` | 能力状态、屏幕/控制请求与会话工具状态在本地pane持续呈现；不可用状态说明，普通动作无独立保存成功；caller onError负责操作错误 | 平台能力/审批/控制锁是业务状态，不能将发请求等同获得控制 |

#### 行内反馈的颜色与容器补充（I 不是统一样式）

| 载体 | 成功 / 错误 / 进度实际外观 | 样式依据 |
| --- | --- | --- |
| 账户 `#config-state/#config-error` | 保存结果tone为空时secondary字+hover底；progress为info字/底；ok为success字/底；warn为warning字/底；error为danger字/底；均行内卡块，无自动消失 | `web/public/styles/17-settings-forms.css:1185`；控制器直接写保存结果时明确置空tone |
| engine `.capability-save > span` | 成功仍secondary灰字无底，失败danger红字；按钮右置；无自动消失 | `web/public/styles/31-plugins-page.css:323` |
| `#notice` / `.admin-notice` | app普通结果tertiary灰字，kind=error红；admin success绿字、warning黄字、state info字，均无满宽色底、无计时器 | `05-workbench.css:97`、`15-settings-shell.css:135` |
| 插件配置p、TraceReview p、profile审批失败p、FDE status p | 普通正文继承，无独立success/error背景；即使role=alert/status也不会自动有语义色。插件配置pending/refused/unavailable和saved没有视觉tone分流 | 各TSX/JS没有共享状态class；继承宿主正文。浏览器最终级联待复核 |
| 对话 `.turn-feedback` | **统一danger红字**，未分success/error；复制成功1600ms的“已复制”也渲染于此span，适用相同红色声明；复制按钮另变勾 | `web/public/styles/13-turn-process.css:479`、`web-ui/src/conversation/turn-actions.tsx:345`；源码确认的tone缺口，待视觉复核 |
| 消息feedback-status | busy/普通为secondary灰；done为success绿；error为danger红，无底；生成/失败保留，retry link用品牌色 | `web-ui/src/tokens.css:1386` |
| bookmark失败 / rename失败 | danger红字、无色底，前者在preview卡、后者在dialog；无自动计时（preview随hover/关闭消失） | `web-ui/src/conversation/messages.css:216`、`web/public/styles/03-sidebar.css:346` |
| deliverable-note / Agent启动help / OAuth-status | 前二者secondary字，OAuth tertiary小字；status/alert不自动换色；行为持续至新状态/离页 | `web-ui/src/intelligent-ui/styles.css:979`、`30-home-pages.css:210`、`17-settings-forms.css:492` |
| SettingsFooter状态 / 首次引导普通p | footer secondary字，无底；首次引导普通p继承正文，另一个步骤同句是S+绿底；无自动消失 | `web-ui/src/components.css`的`.agnes-settings-footer-status`、`web-ui/src/first-run.tsx:116,124` |

### 1.4 “已保存”词条并不等于独立组件

需迁移的词条入口覆盖：`web-ui/src/locales/index.ts`（ui.saved/saving/saveFailed）、`locales/config-form.ts`（saved/tested/error.action）、`locales/model-settings.ts`（slots.saved/sessionSaved/sessionFailed）、`locales/first-run.ts`（firstRun.saved）、`locales/conversation.ts`（accounts.saved）；`web-foundation/src/locales/settings.ts`（accounts.saved、settings.saved 四种 effect 句）、`locales/app.ts`（savedNotice/savedNotEffective/modelSaved）、`locales/session.ts`（savedRefreshFailed）；`web-admin/src/settings/locales/providers.ts`（engine.saved/savedRestart）、`locales/operations.ts`（schedulesSaved/Created/Archived）、`locales/knowledge.ts`（searchSaved）、`triggers-locale.ts`（saved）、`admin/plugins/config-locale.ts`（saved/invalid/conflict/refused/pending）、`admin/plugins/locales/admin/{operations,runtime}.ts`；`web/src/pages/plugins/page-locale.ts`（folders.saved）；`web-units/src/trace-locale.ts`（ruleSaved/Failed）、`diagnostics-locale.ts`、`locales/settings-shell.ts`（accounts.saved）、`message-feedback/feedback-locale.ts`；`resource-control-web/src/credentials-locale.ts` 和 `locales/admin.ts`。

`settings.key.savedHint`、`savedThinkingUnavailable`、`savedValue` 等是已有状态/帮助，不能批量替换成 toast；同名 accounts.saved 在多个 catalog 是文案重复，不能按词条数认定运行时出现几次提示。

### 1.5 唯一目标反馈模型（待 owner 审批）

| 事件 | 唯一载体、时长、视觉 | 必要行为 |
| --- | --- | --- |
| 确认已完成的普通保存/操作 | 共享 FeedbackHost 内一个 Toast，成功绿图标与 success token，**3 秒**；不移动焦点 | 只在后端确认后发布；路由切换不丢；一个 operationId/intent revision 只报一次；重复同文案的新操作也重启时长；不同时显示成功 Banner/SaveBar 确认 |
| 字段校验失败 | 该字段 Field.error，红字图标/invalid，直到修正或再次验证 | 定位具体字段、错误替换 help；首次提交聚焦首个错误；保留草稿；JSON 路径映射到所属编辑器 |
| 非字段操作失败（网络/权限/冲突/拒绝） | 操作区 StatusMessage(error)+恢复动作，持续到修复/明确 dismiss；**不凭空定位字段** | 请求未确认、部分成功、刷新失败分别描述；无安全自动重试则只给“检查状态”；长久阻断/重启后果使用 notice 模式 |
| 保存已完成但需行动后才生效 | toast“已保存” + **一条持久 warning notice**，说明“重启后台后生效”或“重新扫描…”并给真实可用动作 | 依据 authoritative effect；只有后端证实问题解除才清除；前端无 restart 接口时给准确手动步骤，不造“重启”按钮 |
| 已保存，仅作用于新会话 / 后续请求 | toast 第二短句说明作用域；相同说明作为字段/组的稳定 help | 这不需要用户行动，**不产生持久 notice**；不能默认“立即生效” |
| 执行中 | 发起按钮 loading + disabled/aria-busy，保留动词；开关/自动保存显示局部 busy，等价状态可由组 status 呈现 | 只有必要时说“正在保存…”；长操作显示进度事实；取消语义由原 controller 决定；accepted/pending/unknown 不发布 success |
| 自动保存 | 一次提交批次结算后同一 success toast；连续输入按 resourceKey 合并，**每次键入不弹** | 1s idle/blur、写队列、undo 原合同保留；输入仍归组件/业务 controller；失败就地可重试，旧 intent 不能覆盖新结果 |
| 已有业务事实（任务运行结果、审批、工具回执、连接恢复、向导步骤） | 原业务状态持续展示；普通动作结算仍按以上规则 | toast 不取代可审计记录；纯导航、主题预览、每次终端按键无 success toast |

建议 API（是本次待审规格，不是现存导出；保持现有 Toast/Field/Button 作底层，不新增第二套库）：

```ts
type EffectNote =
  | { kind: 'current-session' }
  | { kind: 'next-request' }
  | { kind: 'new-sessions' }
  | { kind: 'restart-required' }
  | { kind: 'rescan-required' }
  | { kind: 'reconnect-required' }
  | { kind: 'enable-required' }

type OperationFeedback = {
  id: string                 // 业务 operationId 或调用方生成的意图标识
  scope: string              // settings resource / session / plugin；不含敏感数据
  outcome: 'success' | 'error' | 'pending' | 'unknown' | 'partial'
  message: string            // 调用方用统一 catalog 本地化；仅脱敏文字
  effect?: EffectNote        // 只来自拥有者返回/既有合同，不由组件猜测
}
type FeedbackSink = { publish(result: OperationFeedback): void }
// Shell 持有队列，业务通过注入的 sink 发布；不让 web-ui 调 RPC。
type FeedbackHostProps = {
  results: readonly OperationFeedback[]
  onDismiss(id: string): void
}
type StatusMessageProps = {
  kind: 'error' | 'notice' | 'pending' | 'partial'
  children: React.ReactNode
  action?: { label: string; onSelect(): void; busy?: boolean }
  onDismiss?: () => void     // 未解决的行动 notice 不应仅因关闭视图而清除
}
// 已有 API 沿用：<Toast open onDismiss duration={3000} tone="success">…</Toast>
// <Field label={…} error={…}><SettingsInput … /></Field>
// <Button loading={pending} disabled={pending}>保存</Button>
```

普通 success 队列最多同时呈现一个，连续结算依次/合并显示，不能用全局单个字符串覆盖别的资源结果。业务 owner 保留 actionable notice 的 authoritative 状态；UI 关闭不等于取消后台操作。Host 根据当前活动对话框选择 `getOverlayContainer`，保持单 root、CSP/locale 和焦点陷阱。通用 `web-client` 不得反向依赖 `web`，插件通过可注入 presentation sink 复用，不把授权/恢复裁决搬进组件。

**统一 zh/en 文案规范：** 完成用“对象 + 已 + 动词”，英文“Object + past participle”；只有当前操作上下文毫无歧义时允许“已保存 / Saved”。短句不加感叹号、“成功地”、技术错误码；全站使用相同标点规则：完整句加 `。/.`，按钮/短标签不加句号。效果另起一句，先范围再是否需行动；相同中文对象固定翻译，后台统一 backend，不在引擎/运行时/服务间随意切换。

| 场景 | zh-CN | en |
| --- | --- | --- |
| 普通保存 | 设置已保存。 | Settings saved. |
| 新会话 | 模型设置已保存。新会话会使用这些设置。 | Model settings saved. New sessions use these settings. |
| 当前会话 | 模型设置已保存。仅用于当前会话。 | Model settings saved. Applies to this session only. |
| 下个请求 | 搜索设置已保存。下次搜索会使用这些设置。 | Search settings saved. Applies to the next search. |
| 重启（toast / notice 分开） | 设置已保存。 / 重启后台后生效。请重启 agh。 | Settings saved. / Restart the backend to apply these settings. Restart agh. |
| 需扫描（toast / notice） | 技能目录已保存。 / 重新扫描以加载这些目录中的技能。 | Skill folders saved. / Rescan to load skills from these folders. |
| 替换凭据后（toast / notice） | 密钥值已替换。 / 重新连接使用此凭据的 MCP 服务。 | Credential value replaced. / Reconnect the MCP services using this credential. |
| 字段错误 | 请输入绝对路径。 | Enter an absolute path. |
| 保存失败 | 未能保存设置。草稿已保留，请重试。 | Could not save settings. Your draft is kept. Try again. |
| 保存成功、刷新失败 | 名称已保存，但列表未刷新。请刷新列表。 | Name saved, but the list did not refresh. Refresh the list. |
| 结果未知 | 操作结果尚未确认。请检查状态后再试。 | The outcome is not confirmed. Check the status before trying again. |
| 正在进行 | 正在保存… | Saving… |
| 已提交/运行开始 | 已提交运行请求。 | Run requested. |
| 安装后未启用 | 插件已安装。 / 启用插件后可使用。 | Plugin installed. / Enable the plugin to use it. |
| 下载 | 已开始下载。 | Download started. |

“新会话生效”“当前会话不变”按真实 effect 选其必要句；restart 优先，不能同时用“已生效”。新安装“去启用”不能仅藏在6秒toast里，安装详情继续保留可发现的启用动作。不可把“无法刷新列表”笼统说成“保存失败”；不可将“未知/待确认”标成 error 后直接“重试”外部操作。

## 2. UI 原语与模式实现盘点

### 2.1 口径

静态扫描 682 个受 Git 管理的源/样式文件：Web 146、web-ui 191、web-admin 118、web-units 71、web-foundation 21、web-client 24，加实际承载会话/工作台的 web-conversation 37、resource-control-web 22、examples 的 client/skin 52。匹配 `.ts/.tsx/.js/.mjs/.html/.css`；不扫构建产物和运行 home。计数是 JSX（含泛型）和 `React.createElement(Component, …)` 的**静态调用点约数**，不是运行时实例数；循环只计一次，互斥分支分别计，fixture 也明确保留为源声明，import 不计，改名 import/间接 factory 另列，库内部组件不算产品页使用。附录 A 展开所有匹配文件；不能用总数推断用户看见几份控件。

### 2.2 实现、canonical、旁路

| 原语 / 模式 | 当前全部主要实现与约数 | Canonical 与具体旁路 / 差异 |
| --- | --- | --- |
| 按钮、图标按钮 | `web-ui/src/ui/button.tsx` **399** 点/136文件；`ui/icon-button.tsx` **58**/45；`ui/copy-button.tsx` **6**/6；`settings-control-templates.ts` 的 createSettingsButton（DOM bridge）；`ui/disclosure.tsx` / push-stack / settings-subpages 内部语义按钮 | Button/必填label的IconButton是主实现，CopyButton是操作适配。历史 `primary/secondary/icon-button` class 和工厂不是另一套批准样式。现码仅少量业务 raw：`web/src/timeline-node-host.tsx:195` 的“读取更早消息”；DSH fixture raw button 见附录 C |
| 开关/checkbox | `ui/state-lights.tsx` StateSwitch **23**/16；antd `ui/switch.tsx` **0直接调用**；LabeledSwitch **0直接调用**（内部调用 StateSwitch）；SettingsCheckbox **8**/6；SchemaControl 的 Boolean→StateSwitch；`intelligent-ui/form-fields.tsx` 原生 checkbox/radio，`plugin-schema-fields.tsx` 原生 checkbox | 行内 stopPropagation 和 caller-owned checked 使 StateSwitch 为已使用主路，不能强制换 antd Switch。checkbox 是多选/确认语义，需保留紧凑 variant。LabeledSwitch 是已存在未普及适配，不新增第三种 |
| 分段/choice | `ui/segmented.tsx` **19**/15（原生radio）；SettingsChoice **9**/3（外观tiles、preset radio）；SettingsChips **2**/2、SettingsChipToggle **1**/1（多选）；`web/src/model-picker.tsx:354` 自制 ChoiceGroup/role radio | 单选短项 Segmented；tiles（主题预览）与多选 chips 是实际独立需求，不应把checkbox伪装成互斥radio。model-picker-choices、appearance-choices、settings-choices 各有CSS，外观/键盘逻辑需收敛 |
| Tabs | `ui/tabs.tsx` antd，**10**/10；settings-shell / hub tablist；session-views 自定义 view strip（同文件也有 Tabs）；dock Header 自定义 overflow strip + 低宽 fallback Tabs；trace-inspector 手写 tabs；diagnostics-viewer 手写 tabs + Tabs | Tabs 主路；dock的溢出/关闭/拖放不是标准settings tabs，保留业务适配但共享样式与键盘模型；不能只凭 role=tablist 数量断定应删掉导航 |
| Select/dropdown/picker | antd `ui/select.tsx` **14**/9；原生 SettingsSelect **40**/21（`settings-layout.tsx:327`）；SettingsOptionSelect **6**/2（原生options事件bridge）；createSelectPicker DOM bridge（`select-picker.ts`）；SessionPicker 复用Select；SettingsPresetSelect **4**/4；model-picker、permission-picker、reference-picker、session-search 是专用 listbox | 普通表单保留原生值/event/表单语义，rich/search用Select；**统一视觉层而非统一成antd事件**。原生/Ant/DOM三条绘制链、picker listbox自身hover/selection样式需统一。非搜索Select的蓝色上下箭头是 refinement 主动实现，并非能直接认定OS默认控件 |
| 输入/textarea | SettingsInput **71**/36、SettingsTextArea **18**/13（`settings-layout.tsx:295`）；SearchBar 内原生search；X Sender一处；DOM createSettingsControl/materializeSettingsControls；plugin-schema / intelligent-ui field内部原生复选控件 | 表单主路SettingsInput/TextArea，composer保留X Sender（IME/草稿/快捷键）；终端 `presentation=plain` 与hidden file input是合理语义差异。输入灰底在共享tokens.css，非所有页面各写裸 input |
| number/time/date | SettingsInput type=number（triggers、schedule-form、model-picker预算、schema、preset custom）；schedule-form datetime-local/time、PluginSchemaFields按schema format渲染date/date-time；SettingsPresetSelect秒/分钟转换，account-network独立preset范围；schema Number转换 | 不增加独立 DatePicker/InputNumber 库。原生stepper、timezone、min/max/step、空值/0、单位不能为外观一致而丢失；统一Input surface、Field单位/错误与preset适配 |
| Field/label/help | Field **59**/18；SchemaConfigFields/PluginSchemaFields；SettingsItem **98**/27 作setting row；settings-account-dialog手工form-field、field-hint+controller status；config模板labels | Field负责字段连接；SettingsItem负责行布局，职责不同。nested layout wrapper不会被Field自动递归注入ARIA；要透传id/describedBy。triggers JSON错误、engine错误还在表单级，而schema路径能到字段 |
| 卡片/列表行 | ListRow **29**/15；SettingsRow **8**/4；SettingsList **23**/13；SettingsGroup **19**/15；SettingsCard **2**/2；DataList **0直接调用**；PluginList / ResourceListContent / account rows；agent gallery卡 | ListRow/SettingsRow适配；SettingsGroup/List提供一层边框。业务卡（agent、tool、approval）保留领域内容。`16-plugin-resources.css` 尚有 `.plugin-row:not(.agh-list-row)` 等历史规则；不把残留CSS直接认定活跃页面 |
| 展开行 | Disclosure **40**/29；SettingsDetails **32**/23，SettingsExpand **9**/4，SettingsTechnicalDetails / SettingsAdvanced适配；Conversation process / workbench 树另有展开状态 | Disclosure是collapse机制；缺少“固定header + 独立body”的列表布局约束。ListRow children在copy列，整行center使左右图标/开关随body居中。不应在业务各加top margin补丁 |
| Menu/context menu | `ui/menu.tsx` **27**/27，antd Dropdown/Menu+自管keyboard；contextMenu/longpress适配；旧picker、permission/model/reference列表见上一行 | **PC-SIDEBAR-MENUS 建设中**。此基线Menu已存在不代表该窗口交付已完成；目标规格接口以该owner审定版本为准。值选择listbox不能伪装menu；共享hover token，不复制菜单实现 |
| Dialog / drawer / confirm | Dialog **12**/12（antd Modal）；ConfirmDialog **4**/4；Drawer **0直接调用**；admin-confirmation / confirm.ts / native dialog binding；native hosts：app-shell七处，workspace-dialog、session-actions、session-search、session-runtime、diagnostics、hosted-pages，以及web-ui account/admin hosts | Dialog+ConfirmDialog为主，native host是既有top layer/ID/skin合同兼容壳；不能再嵌套新modal。Drawer已有可复用但无业务直接调用，**不因库存存在而新引入页面迁移** |
| Toast/banner/inline status | Toast **8**/7（不含aliased primitive wrapper）；Notifications **1**/1；Banner **45**/27；SettingsState **126**/52；SettingsSaveBar **2**/2；SettingsBlock **47**/17；大量I与控制器notice | 所有实现、时长、色彩、文案和效果见§1。主缺口是统一result contract/host和消费规则，非再建Toast |
| 空态 | EmptyState **20**/17；ResourceEmpty领域适配；SettingsState empty（同126总数，不另冒充全为空态）；ConversationCardLayout empty；`web/src/regions/empty-state.tsx` X Welcome **1**；plugin/permission/model/reference搜索空值、业务工具empty | 页面无内容用EmptyState，行/局部列表用紧凑适配；conversation hero保留Welcome。loading/error/disabled和empty须分开。`web-client/outlet.tsx` 插件失败普通div，不能误报empty |
| 徽标/状态pill/metadata | Badge **21**/16；Tag **28**/21；SettingsTag **7**/4；StateLights **0直接调用**；StatusDot **5**/4；MetaText/Count、CompletionCheck适配；页面局部 provider/account 状态 | Tag warn/bad/info 与 Badge ok/warn/off/bad/unknown、SettingsTag ok/warn/error/muted/brand 的tone词汇重复；同色不必同业务状态。metadata默认文本，仅真正可导航的内容是link |
| Tooltip | `ui/tooltip.tsx` **17**/11，加IconButton/Button disabledReason内部使用；原生title（StateSwitch、legacy DOM picker、trace rows等） | IconButton统一tooltip+accessible label；native title与定制tooltip延迟/键盘说明不同。label不可被tooltip取代 |
| 页头 / breadcrumb | PageHeader **0直接调用**；SettingsPageHeader **4**/4；SettingsPage **4**/3；PushHeader **3**/3；PushCrumbs **7**/5；PushPage **10**/10；Settings hub、plugins/automation主页面自有适配 | 正在使用的是SettingsPage→PushHeader line，不是另一个PageHeader。root heading/actions和drill breadcrumb是一种页头规格的两种上下文；不要把title+description垂直版再铺一遍 |
| settings rows / groups | SettingsItem/Group/Block/Drill/Expand、SettingsSection/Footer/Toolbar；useAutosave、SettingsUndoScope；Provider/Account/Schema域适配 | 保留一层共享group边框与稳定label/control列。布局、异步状态、字段校验分责；web-ui不决定配置保存与授权。多数基础控件已复用，不能以“重复很多”为由重写整页 |
| Conversation / workbench / approvals | `web-ui/src/conversation`、`web-conversation`、`web-units`；X Bubble/Sender/Conversations/Think/ThoughtChain/Actions等；Approval专用结构 | Ant Design X是展示适配，caller store为事实源；无x-sdk chat runtime。terminal/markdown/tree/approval不是需要用antd Card替换的第二套设置控件 |

### 2.3 插件 UI 边界

仓库 plugin UI 不只 packages/web*：`resource-control-web` 是产品资源界面；FDE meeting-actions 两个工具slot、support-triage 三个工具slot与community/tool-panel一个slot均共用各自小 renderer，有领域结果但没有共享tool-state外壳。`examples/fde/recruiting-screen` 没有自己的client目录，不能编造招聘页面样式问题。

`examples/packages` 的 client-panel v1/v2、client-multi-panel v1/v2、client-service-panel v1/v2、dsh-input-controls v1/v2/broken、dsh-model-picker-{a,b} v1/v2/broken、dsh-tool-view v1/v2/broken是**明确测试/演示夹具**。有意使用不同边框/版本标签来证明装载、替换、退位；保留其测试意图，不计为18组件目标的新增需求。skins-builtin 的12份 skin.css是主题定义，不计为业务裸色违规。第三方未安装源码不在本次有限库存中，报告不声称审查了所有外部插件。

另有必须区别的安全边界：`examples/fde/finance-reconcile/client/reconciliation-diff.mjs`是自包含Intelligent UI renderer，经`web/src/intelligent-ui/custom-host.tsx`和`web-server/src/ui-component-frame.ts`在opaque-origin iframe执行，**禁止runtime imports / external styles**。它用原生table/caption/scoped th输出对账差异，标题和列名支持zh/en，但`simulated-approved/unresolved/needs-review`状态直接String输出、无统一pill/空态；只读，无保存/操作反馈。宿主frame用Canvas/CanvasText和color-scheme，14px system font，并非自动继承整套shell token。该边界不能为“复用web-ui”而放开CSP或引入宿主React；建议在允许的frame主题/locale API内定义最小展示约定，保留text fallback和preset表格。`skin-example` v1/broken另有两份skin.css，v1有浅深覆盖，broken为拒绝夹具，不是遗漏的业务控件。

## 3. 按用户可见性排序的问题与页面例证

优先级以可见频率、误导程度和影响面排序；源码可证明结构/声明，真实像素、系统原生下拉外观均待浏览器复核。

| 顺序 | 问题、用户入口与源码证据 | 结论 / 建议 |
| --- | --- | --- |
| 1 | 保存后载体/时长/文案各异；模型辅助槽 `settings/model-slots.tsx:194`、automation `schedules.tsx:416`、triggers `:245`、搜索 `search.tsx:550`、凭据 `credentials.tsx:204` | 源码确认持久绿色块；普通保存应转T，作用范围按§1拆句；优先解决owner当前痛点 |
| 2 | 共享Schema sticky同时 SaveBar + status；`web-ui/src/config-form.tsx:378,390` | 源码确认重复渲染路径。先改共享机制，再验证所有Schema消费者，避免各页单独去重 |
| 3 | 操作和结果含义错配：triggers delete/configure默认saved；pinsSkipped绿；插件pending/refused普通status；bundles“已应用”但需重启 | 源码确认。采用operation-specific copy、partial/unknown类型、action notice，权限与业务事实不变 |
| 4 | 模型页/设置页/automation混合select：native SettingsSelect、DOM select-picker、Ant Select；`refinement.css:308–425` + `17-settings-forms.css:230,365` + `settings-layout.tsx:327` | 蓝色上下箭头是共享refinement主动实现，不应未经复核称为native blue stepper。native/Ant/DOM分别绘制，**多重实现事实确认，具体截图所见归属待复核** |
| 5 | 灰填输入 vs 白select/search：`tokens.css:457` input用bg-fill，`:485` focus用input-surface；`refinement.css:338,359` select用bg-control；SearchBar `components.css:1859`用input-surface | 源码确认角色选择不一致，不是发现大量硬编码白色。应在组件规格统一idle/hover/focus的surface；特殊code/terminal保留plain |
| 6 | 插件展开行左右随内容垂直居中；`web-ui/src/admin-list.tsx:311,366` + `ui/list-row.tsx` + `components.css:873` | 结构确认：icon/copy/actions为同一flex行，body在copy内，align-items:center。拆固定header/body；在report示意规格审批后实现，实际偏移量未量测 |
| 7 | automation端点“保存端点设置”默认secondary且直接放Disclosure body；`settings/triggers.tsx:332`，没有Toolbar/align slot | 默认Button是secondary已确认；body grid默认stretch可能造成满宽，**最终宽度待浏览器验证**。改为统一form actions语义，不能在按钮各写width:auto补丁 |
| 8 | 多种分段风格：settings外观tiles，default权限SettingsChoice，models手写radio，plugins review Segmented；`model-picker.tsx:354`、`settings-panes.tsx`、`session-defaults-panel.tsx:224` | 三类需求：短项单选、预览tiles、多选；只给实际需求variants。模型思考强度/上下文的键盘、失效档位保留 |
| 9 | 菜单和picker hover：Menu/Ant Select用accent，model-picker `09-model-picker.css:138`用bg-hover，DOM picker另有selected/active处理 | 视觉规则不同确认，语义不同合理；PC-SIDEBAR-MENUS建设共享Menu，先定hover/current/disabled/danger规则，值picker只复用token，不复用menu角色 |
| 10 | 链接式metadata与状态pill混杂：automation外链 `30-home-pages.css:308`，plugin版本/source/endpoint technical copy、Badge/Tag/SettingsTag多个tone空间 | 真链接保留link affordance；不可点击标识统一MetaText。不能把所有蓝色文字都删掉链接；需按href/handler判断 |
| 11 | empty/error/loading有多条UI路径：EmptyState、S0、普通p、X Welcome、ConversationCard；插件slot失败普通div | 首页hero与列表空态合理区分；相同“无数据”要标题/原因/CTA一致。failed/refused不应成普通empty；读取失败保持已有内容 |
| 12 | sidebar / workbench / conversation / approvals中的局部实现：dock tab strip、reference picker、消息feedback、复制、profile审批错误、FDE英文raw status；对话复制成功仍渲染于danger色turn-feedback（§1行内表） | 高频功能先统一基础规格再逐域接入；复制success/error必须分tone。不能把安全后果、审批pending或工具回执改成toast；FDE本地化和领域外壳独立批次 |

## 4. Tokens、主题与深色模式

### 4.1 已有基础与准确边界

`web/public/styles/01-tokens.css` 是色板和语义token来源，`:root` / `.dark`、`color-scheme`都有定义；`web-ui/src/tokens.css` 将其桥接到Ant Design与X变量。`layers.css`固定 `tokens,base,vendor,ui,app,skin`；`tools/web-style-source.mjs:43`明确tokens→components→native→doctor→refinement顺序；refinement最后输出。同层顺序和更高的app/skin层均能覆盖组件。样式散在tokens.css、components.css、refinement.css、Web领域CSS，不是token缺失就能解释所有不一致。

基础主题确实已有浅深success/error/输入/控件token，不应报告成“没有dark mode”。存在 `web-ui/test/{tokens,token-contrast}.test.ts`、Web style-tokens测试和X桥测试；本次没有运行它们，也不以其存在证明当前视觉通过。

### 4.2 裸色实际命中与例外

按源码扫描，**内置业务TS/CSS未发现大面积十六进制色值**。精确例子如下；详见附录C。`rgb/rgba/hsl/hsla`同样扫描，而非只查hex。

| 位置 | 命中 | 处理判断 |
| --- | --- | --- |
| `web-ui/src/settings-layout.tsx:537` | SchemeThumbnail light/dark各4个固定hex | 有意展示另一个配色方案，在dark页仍须显示light缩略图。属受控preview palette例外，宜集中命名/测试，不盲换成当前主题token |
| `web-ui/src/intelligent-ui/styles.css:934` | gradient mask `#000` | 遮罩alpha几何，不是前景/背景色；明确例外 |
| `web/public/styles/13-turn-process.css:553–554` | 两处radial mask `#000` | 同上；当前presentation baseline已记录，不能为了“0hex”破坏mask |
| `examples/packages/client-panel/{v1,v2}/…/index.css` | hex fallback（白底/蓝/灰等），`--agnes-border/--agnes-accent`旧名 | fallback可能在dark里落到白/蓝；示例应改成现行语义token的示范，保留版本差异测试意图 |
| `examples/packages/dsh-{input-controls,model-picker-a,model-picker-b,tool-view}/{v1,v2,broken}/…/index.css` | version专用accent、固定light背景/红色failed | 有意夹具，**可证明缺少相应dark覆盖，但不是主产品页面dark故障**；应用文档明确fixture定位，不让新插件照抄 |
| `examples/packages/skins-builtin/{v1,v2,broken}/…/skins/*/skin.css` | 主题定义字面值 | 合理定义层，禁色规则必须排除定义而非取消皮肤支持 |

### 4.3 尺度和CSS职责旁路

有token不等于组件比例统一。`native.css`仍有gap `0.5rem`、padding `0.25rem 0.75rem`；`doctor-groups.css`有padding `8px 12px`、radius `6px`；`refinement.css:315`弹出箭头radius `5px`；`17-settings-forms.css`中外观/option间距有 `0.375rem/5px`；`06-trace.css`、`13-turn-process.css`、`16-plugin-resources.css`各有约20–30条含literal的padding/margin/gap/radius声明（只是regex约数，包含calc/几何，不等于全违规）。优先把一般控件的 spacing/radius 收敛到 `--s*`、`--radius-control/card/surface/pill`，不要把1px hairline、图标路径、mask、safe-area、虚拟列表和gantt坐标当设计间距批量替换。

动态inline还存在：`web-units/src/diagnostics-viewer.tsx:133`（depth*16 padding）、`trace-list-row.tsx:73`、`trace.tsx`/`trace-gantt.tsx`（缩进/虚拟化/时间坐标）；web-ui turn-nav/usage/progress的动态宽高；web-client outlet hidden entry和web-units几个region `display:contents`。这是**可解释例外**与布局耦合，不能一条“禁止所有style”抹平。FDE/example预格式化结果的whiteSpace/overflowWrap则适合共享外壳CSS。Badge inline color引用的是semantic token，Chart palette同样token，不是裸色。

### 4.4 深色/皮肤待验收项

1. native `select` 的展开菜单和number/time/date的系统内部UI不能单凭CSS声明证明一致；需macOS/Linux目标浏览器观察，当前无截图证据。
2. fallback旧token、fixture固定浅色背景有明确dark覆盖缺口；官方新插件示例应先修，测试夹具单列允许。
3. `.agnes-settings-input`灰填→focus变surface、Select bg-control和SearchBar input-surface均随dark切换，但角色不一致仍在；应统一状态表，不再加另一套.dark selector。
4. 菜单material背景是94%混色+blur，实际文字对比、forced-colors与reduced-motion要覆盖；不能因为使用token便声称a11y通过。
5. popup必须位于活动dialog scope，Toast也有public adapter与内部primitive两种import；皮肤、top-layer、focus-return属于组件验收条件。

## 5. 供 owner 审批的组件规格表 v0.1（18 项，尚未批准实施）

### 5.1 归属与交付次序

**先审批此表、状态和文案，再迁移页面。** 本报告不授权页面逐一 redesign，也未实现任何新组件。建议用现有主题/内容做组件目录页供 owner 检视：每项只展示下面列出的实际变体、关键状态；先看反馈、表单控件、列表展开、菜单，再确认页头/空态。本文是可审的spec sheet，不冒称已经有可运行预览或得到批准。

保持包边界：`packages/web-ui/src/ui` 放 primitives、`components.css/refinement.css/tokens.css`放唯一视觉定义；设置布局/Schema/Conversation是组合适配，`web-admin/web-units/web-conversation`持有领域状态；`web`做shell装配和路由；`web-foundation`做locale/theme/appearance；`web-client`保留服务与slot隔离，通过公开导出和注入展示能力。新外部库不得进入业务包。

遵守自研展示原语决定：Badge/Tag、EmptyState、Skeleton、ListRow、Banner、Icon、SheetHandle继续自研；不换成antd等价件。Button/Select/Tabs/Dialog/Popover/Menu等交互底座按现有web-ui封装；会话Bubble/Sender/Conversations等继续经`@agnes/web-ui/x`，不引入x-sdk、另一套消息store或另一套theme provider。18项是owner审批的**组件家族**，不是要求删除所有既有adapter/export；公共skin hooks、IDs、native form contract保留兼容。

### 5.2 小规格表：主实现、真正需要的变体和状态

| # / 组件家族 | Canonical 当前文件；保留适配 | 实际需要的 variants（到此为止） | 必须可演示/可验证的 states |
| --- | --- | --- | --- |
| 1 Button（含 IconButton） | `web-ui/src/ui/button.tsx`、`icon-button.tsx`；CopyButton是行为适配，createSettingsButton是DOM兼容 | primary / secondary / ghost / danger / link；sm/md；icon-only必须label；filled danger仅最终破坏性确认 | idle、hover、keyboard focus、disabled+原因、busy；一个主操作；busy防重复提交 |
| 2 Field | `ui/field.tsx`；Schema/PluginSchema将路径错误映射进来 | label+control；optional标记；hint / error二选一；单位作为control组合 | normal、invalid、required/optional、read-only说明；id/htmlFor/describedBy稳定 |
| 3 Input | `settings-layout.tsx` SettingsInput/SettingsTextArea；SearchBar/preset/factory为适配 | 单行text/search/url/password、number、原生date/time/datetime-local（date来自schema）、多行field/plain、checkbox（确认/多选）、hidden file；只使用现码已需类型 | empty/value、hover/focus、disabled、invalid、read-only；多行IME、number空值/范围/单位、upload native事件不变；统一field surface |
| 4 Select | `ui/select.tsx` rich；`settings-layout.tsx` SettingsSelect native；SettingsOptionSelect/createSelectPicker为兼容 | 普通单选、可搜索分组单选、多选（新会话loop-picker组合包选择）、数值preset+custom适配 | closed/open、hover/current/selected、disabled项/整体、empty options、unavailable saved value、loading；native/rich外观同一状态表 |
| 5 SegmentedControl（沿用 Segmented 导出） | `ui/segmented.tsx`；主题预览tile的SettingsChoice和multi chips为明确适配 | 2–6短项单选inline/block；preview tile；chips多选适配；不再增加新的pill风格 | selected/unselected、disabled、keyboard focus、radio arrows；多选用aria-pressed/checkbox，不冒充radio |
| 6 Switch | 已用主路 `ui/state-lights.tsx` StateSwitch；LabeledSwitch为可见状态文字适配 | switch；必要时旁置On/Off（LabeledSwitch），不是再一套轨道 | on/off、disabled、busy、focus；不触发行打开；checked/授权由调用方提供；antd Switch保留兼容但不新增使用分支 |
| 7 Section（设置group/card/list模板） | `settings-layout.tsx` SettingsSection/Group/List/Item；`ui/settings-controls.tsx` SettingsBlock | group内setting rows / list rows；section标题与description；bare领域内容；compact technical disclosure | ready、read loading、read error+retry、save failure；一层边框，control列统一；布局不持久化数据 |
| 8 ListRow / ExpandableRow | `ui/list-row.tsx` + `ui/disclosure.tsx`；SettingsRow/Details/Expand适配 | 普通row、可打开详情row、可展开row；可选leading icon、secondary metadata、trailing actions；body在header下 | idle/hover/focus、disabled actions、expanded/collapsed、busy action；header图标/开关不随展开body移位；动作不触发行打开 |
| 9 Menu（**在建**） | `ui/menu.tsx`；**PC-SIDEBAR-MENUS owner**，消费其最终导出 | click action menu、context menu（键盘/右键/触摸长按）、分组separator；不含value picker | closed/open、hover/keyboard current、disabled+reason、danger-last、action busy；Escape/Tab/focus-return与modal-local container；不由本窗口追加API/实现 |
| 10 Tabs | `ui/tabs.tsx`；dock/trace/header strip是领域适配 | 页面view tabs；紧凑panel tabs；dock overflow/close仅领域adapter | selected、focus、disabled、overflow；arrow/Home/End/aria-controls；切换后草稿和panel不意外丢失 |
| 11 Dialog / ConfirmDialog | `ui/dialog.tsx` + `confirm-dialog.tsx`；原生host/bindDialogSheets为兼容 | sm420/md560/lg720；表单/信息/确认；破坏性确认有filled danger；窄屏bottom-sheet；既有Drawer保留库存，**当前0直接用例，不另扩迁移范围** | open/closed、busy veto、field/operation error、focus trap/return、Escape、Enter（不截textarea/IME/combobox）、reduced-motion |
| 12 Popover | `ui/popover.tsx`；DOM popover helpers为兼容 | click / hover；anchored rich content；listbox通过专用picker适配 | open/closed、outside dismiss、Escape、anchor不可见/卸载、modal scope、viewport边界；业务负责选中值 |
| 13 Tooltip | `ui/tooltip.tsx`，由IconButton/disabledReason使用 | icon说明、disabled reason；无独立“高级tooltip” | hover500ms、focus即显、dismiss、disabled control可读、无重复accessible name；内容本地化 |
| 14 Feedback（Toast / StatusMessage） | `ui/toast.tsx` + public `overlay-toast.tsx`、`ui/banner.tsx`；Notifications/SettingsState/SaveBar迁移消费规则 | success toast；field error归Field；error / action notice / pending / partial；busy归Button/Switch | §1.5全表；success3s，不抢焦点；notice持续至解决；locale/多操作去重/跨路由/卸载计时器；不另造Toast2 |
| 15 EmptyState | `ui/empty-state.tsx`；ResourceEmpty / ConversationCard局部empty；首页X Welcome域适配 | 页面/列表无内容；过滤无结果compact；最多primary+secondary操作；help可选 | 真empty、筛选无结果；loading/error/read-only另行区分；title+description/已有有用CTA，不新增无功能按钮 |
| 16 Status / metadata | `ui/tag.tsx` Tag/MetaText/Count，`status-dot.tsx`；Badge/SettingsTag/CompletionCheck为兼容 | 异常warn/bad/info pill；普通metadata文本；count；decorative/labelled dot | warning/error/info、running、normal用文字；状态与文字并存，不能只用色；零count省略；保留后端状态映射 |
| 17 PageHeader | 已用 `SettingsPageHeader`→`ui/push-stack.tsx` PushHeader；SettingsPage/PushPage组合 | root title+actions；drill breadcrumb+back；description在页内/无障碍说明；dock用tab title不重复header | root/drill、long localized title、narrow actions wrap、busy动作；一个可见页头/主动作；稳定headingId |
| 18 Loadable | `ui/loadable.tsx` + `ui/skeleton.tsx`；SettingsState loading/SettingsBlock读态适配 | lines / rows / cards placeholder；已有内容刷新；page top progress只作聚合 | 0–200ms静默、≥200ms占位、≥3s slow、error+retry保留内容、empty与ready；reduced-motion；读取成功不发操作toast |

**不再新增的独立组件：** Toast2、通用SuccessBanner、第二个Segmented、每页FormField、原生/Ant各自的一套视觉规范、替代现成ConfirmDialog、仅为形式增加Table/Card/InputNumber/TimePicker库。现有Table/Chart/Terminal/Markdown/Icon等作为专用展示/底层工具保留，不扩进此次需审批的通用18项；不删除没有新增用例的public export。

**owner审批点（未批准）：** success 3s和行动notice规则；Input/Select三态surface与箭头样式；Segmented/preview/multi三种实际需求边界；ExpandableRow header/body布局；页头root/drill统一；Menu以负责窗口交付为准。审批前只允许继续审查/做规格预览，不安排页面redesign。组件预览应使用真实zh/en长文案、只读/权限拒绝/错误/忙态，不能仅放一排正常控件。

### 5.3 API 规格补充（复用优先，不破坏旧事件合同）

已有Field/Select/Segmented/Toast/ListRow/EmptyState/PageHeader/ConfirmDialog/Menu均已存在。“缺失”主要是语义、组合或接入，不应把以下草案作为必须新建同名文件的指令。可加adapter/可选props，并保留既有exports；新增公开契约先由owner批准。

```ts
// Field：保持现有实现及含义，不增加另一套 FormField。
type FieldSpec = {
  label: React.ReactNode; htmlFor?: string
  hint?: React.ReactNode; error?: React.ReactNode
  optional?: boolean; children: React.ReactNode
}
// 上层必要时统一控件入口；旧SettingsSelect仍用原生event，不强制转换。
type SelectSpec<T extends string> =
  | { mode: 'native'; value: T; name?: string; disabled?: boolean
      options: readonly { value: T; label: string; disabled?: boolean }[]
      onChange(event: React.ChangeEvent<HTMLSelectElement>): void }
  | { mode: 'rich'; value: T | null; searchable?: boolean; disabled?: boolean
      options: readonly { value: T; label: React.ReactNode; disabled?: boolean }[]
      onChange(value: T): void }
// 多选保留loop-picker已有Ant Select mode=multiple适配；不将T和T[]塞进单选回调。
type SegmentedControlSpec<T extends string> = {
  label: string; value: T
  options: readonly { value: T; label: React.ReactNode; disabled?: boolean }[]
  onChange(value: T): void; disabled?: boolean; block?: boolean; name?: string
}
// 建议扩展现有ListRow，或以一个wrapper组合；body不再参与header的纵向对齐。
type ListRowSpec = {
  title: React.ReactNode; description?: React.ReactNode; meta?: React.ReactNode
  icon?: React.ReactNode; status?: React.ReactNode; actions?: React.ReactNode
  onOpen?: () => void
}
type ExpandableRowSpec = ListRowSpec & {
  expanded: boolean; onExpandedChange(expanded: boolean): void
  children: React.ReactNode; bodyId: string
}
// onOpen与展开按钮的含义不得互相覆盖；trailing switch/menu动作不触发任一种。
type EmptyStateSpec = {
  icon: React.ReactNode; title: React.ReactNode; description: React.ReactNode
  actions?: React.ReactNode; help?: React.ReactNode
}
type PageHeaderSpec = {
  title: React.ReactNode; headingId?: string; actions?: React.ReactNode
  description?: React.ReactNode
  crumbs: readonly React.ReactNode[]
  onBack(): void; onCrumb(depth: number): void
  // 沿用PushHeader；root由SettingsPageHeader提供[]和noop，业务不另做Breadcrumb2。
}
type ConfirmDialogSpec = {
  open: boolean; title: React.ReactNode; children?: React.ReactNode
  confirmLabel: React.ReactNode; cancelLabel: React.ReactNode
  busy?: boolean; destructive?: boolean
  onConfirm(): void; onCancel(): void
}
// Feedback APIs：完整定义见§1.5。
// Menu：以下只是当前契约消费要求，最终签名等待PC-SIDEBAR-MENUS。
type MenuRequirement = {
  trigger: React.ReactElement; label: string
  items: readonly {
    id: string; label: string; icon?: React.ReactElement
    disabled?: boolean; disabledReason?: string; danger?: boolean
    onSelect(): void
  }[]
  triggerMode?: 'click' | 'contextMenu'
}
```

`Menu`例中不要求负责窗口接受本报告命名/增加签名；以当前public `MenuProps`和该窗口批准结果作最后对齐。ConfirmDialog继续onConfirm请求、busy拒绝重复决策，组件不await RPC也不发success。PageHeader统一应迁到已被使用的PushHeader/SettingsPageHeader线路，不能把零调用的ui/page-header另强推为第二套页头。

### 5.4 防止回潮的lint/guards（现有与增量分清）

| 规则 | 现状与真实缺口 | 推荐增量与允许例外 |
| --- | --- | --- |
| 禁业务raw控件 | `web-component-boundary.ts`已禁native button/input/select/textarea/table、DOM createElement/innerHTML、仿component class；对全部含web的包扫描；已有24个baseline文件 | 保持精确ratchet，只减不加；将JS createElement/namespace/alias漏检作为规则质量提升；web-ui内部native为合法implementation；approved native hosts/materialization保留 |
| 外部UI依赖仅web-ui | `ui-layer.test.ts`已禁antd、@ant-design/*、recharts及其private paths，扫package与vendor | 不另写重复lint。新插件示例及新文件也需检查import；不能绕过通过相对路径deep import |
| 裸颜色 | `ui-presentation.ts`只匹配hex，business source/public CSS有fingerprint ceiling；web-ui被排除、examples不扫；Web style-tokens测试另有更强CSS检查 | AST/CSS parser覆盖rgb/hsl/named color、inline/模板字符串、base palette role bypass；palette/skin、mask alpha、scheme preview限文件+用途例外；不要禁transparent/currentColor/semantic var |
| 尺度/局部样式 | frontend-ui规则只对部分包抓style/layout写入；未阻止每页CSS重写组件内部 | 对组件内部presentation selector建立owner fence（业务不能给.agh-btn设颜色/radius/height）；布局允许容器grid/宽度/滚动；spacing/radius新literal以小allowlist检查，1px/图标/量测不误杀 |
| Success不能满宽持久 | 当前没有跨调用路径的反馈规则；组件复用检查拦不住SettingsState success | 按最终规格限制业务新增 `SettingsState tone=success`/success Banner；只允许向导/业务receipt等列明例外；禁止业务自己setTimeout实现saved状态；不靠grep全部中文“已保存”判断正确性 |
| Feedback identity/lifetime | 现Toast控制open，success string可能重复或离页丢失；Notifications另有timer | 补共享host的contract测试：同文案新id重发、同id去重、路由卸载仍可见、scope切换不串错、dismiss/timer cleanup；后台unknown/partial不变success |
| 文案effect | catalogs有重复saved和backend/runtime混词；有些copy不是locale catalog而是zh ternary | 统一formatter/catalog，要求plain success对象与动词、effect结构化；枚举fallback不能输出原始code；en/zh key parity；不传凭据/未脱敏error进入toast |

Guard验收要包含“把raw select/checkbox、RGB颜色、第二份同字面值、未声明内部selector各插入一个新fixture→确实报错”的反例，并验证合法palette、mask、number/time控件、native bridge不误报。不得扩大legacy allowance隐藏新页面style。报告只推荐规则，不改守卫或原baseline。

### 5.5 只读参考 dsh 的可取经验

已按standing rules查阅同问题的实现：`deepseek-harness/packages/client/ui-schedule/src/client/CatalogFeedback.tsx`将loading/读取错误与操作结算分离，有数据时刷新不抹掉旧列表；`DeleteToast.tsx`用一个outcome source、递增seq与`shell.overlay`显示删除结果，页面卸载不丢反馈，pending不报结果。可借鉴**单一结果源+一次性事件ID+shell出口**，不拷贝代码，不将dsh的视觉/模块结构当AGH批准规格。AGH已有Toast/overlay policy，直接在自身边界内组合。参考仓只读，无改动。

## 6. 审批后的独立迁移批次（当前暂停页面redesign）

### 6.1 共同前置和并行规则

**Gate S0：owner批准18项规格表和反馈文案；Gate S1：共享契约/组件先交付并合入基线。** 下表是可分配的后续批次，不是本次已经实施。共享组件与全局CSS只由一个基础窗口修改；PC-SIDEBAR-MENUS拥有Menu，其他窗口仅消费。业务批次可在S1后并行，避免多人同时修改 `web-ui/src/index.ts`、tokens/components/refinement、公共catalog、guards allowlist、`web/src/app.ts`。每个批次删除自己的旧style时向基础窗口提供精确selector清单，不能各自扩重写组件样式。

| 批次（按可见性排序） | 页面与文件分配 | 风险 / 依赖 | 行为验收（无pixel snapshot） |
| --- | --- | --- | --- |
| S0：组件规格审批 | 本报告§1.5/§5；未来组件预览由统一基础窗口做 | 没有owner批准不迁页；Menu规格等负责窗口 | 检查18项都有实际variant/state，zh/en、disabled/error/busy/effect均可审；审批记录与最终契约一致 |
| S1：共享feedback与控件修复 | `web-ui/src/ui/{toast,field,button,list-row,disclosure}.tsx`、`overlay-toast.tsx`、`settings-layout.tsx`、`config-form.tsx`、public exports/theme CSS；shell FeedbackHost仅一个指定owner接线 | 中高：overlay/ARIA/重入/表单事件；不能改RPC/授权；Menu不在此批重做 | 扩展 `web-ui/test/{primitives,settings-layout,config-form,notifications,overlay-policy,settings-template}.test.tsx`：success仅一份、3s/同文案newid/卸载清理、字段连接、失败保稿、busy拒重复、动作不触发行打开、expanded body为独立region；保留native事件 |
| B1：automation保存反馈（最高优先） | `web-admin/src/settings/{schedules,schedule-form,triggers}.tsx`、`{automation,triggers}-locale.ts`、`settings/locales/operations.ts`；`web/src/pages/automation-page.tsx`仅必要适配 | 中：configure/upsert/delete/test区别；多表单/路由；依S1 | 扩展 `web-admin/test/schedules-page.test.ts`；triggers现有覆盖由 `rg --files packages/web-admin/test packages/web/test`确认（见后文）；分别测成功toast一次、切回列表仍可见、JSON在字段报错、accepted/pending/unknown非success、按钮busy防重、归档拒绝不消失/不误成功 |
| B2：模型与常用设置 | `web-admin/src/settings.ts`、`settings/{model-slots,account-network,personalization,system-prompt,permission-defaults}.tsx`、`web-ui/src/session-auxiliary-models.tsx`；`web/src/model-picker.tsx`；locale仅本域；app.ts由shell owner一次接入sink | 中高：controller ID/ref/native events、账户inline和dialog、revision/secret redaction/生效范围；可分model和general两小包但不同时改settings.ts | `web/test/{settings,settings-accounts,model-picker,settings-oauth}.test.ts`、`web-admin/test/{model-slots-settings,system-prompt-settings,security-settings}.test.tsx`；覆盖本会话/新会话/next request/restart、inline返回、OAuth≠保存、409保稿、failure不清合法值、同配置并发写不倒退 |
| B3：插件/资源（与B1/B2文件独立） | `web-admin/src/admin/plugins/{config-panel,operation-feedback,candidates,detail-copy}.tsx`、`settings/{child-engines,runtime-panels,pins}.tsx`；`resource-control-web/src/{admin,credentials,credential-editor,skills-page}.tsx`；`web/src/pages/plugins/skill-folders.tsx` | 高：install→enable、UI reconcile、partial/unknown、restart/rescan；不可把operation状态降格为toast | `web/test/{plugin-install-flow,plugin-page-progress,plugins-page}.test.tsx`、`web-admin/test/{child-engines-settings,bundles-settings}.test.*`、资源已有suite；测completed才toast、安装未启用可发现行动、清理skipped是partial、扫描notice至后端确认清除、credential值不进反馈、撤权fail-closed |
| B4：侧栏/menus与对话常用操作 | Menu仅由PC-SIDEBAR-MENUS；其后 `web/src/{navigation,session-actions,session-search,session-menu}.tsx`、`web-units/src/{sidebar,reference-picker}.tsx`、`web-ui/src/conversation/turn-actions.tsx` | 中高：keyboard/焦点、context menu、名称已保存但列表刷新失败、fork去重；依Menu与S1 | `web/test`现有navigation/session动作/搜索suite、`web-units/test/sidebar*`、`web-ui/test/conversation-turn-actions.test.ts`；测Escape/focus return、Arrow/Home/End、disabled reason、部分成功只重读不重写、同会话不重复fork、复制拒绝有反馈 |
| B5：其余设置和读取状态 | `web-admin/src/settings/{search,context,memory,auto-review,observability,diagnostics,jobs-panel}.tsx`、`settings/{search,observability,diagnostics,memory,auto-review}-locale.ts`；`web-units/src/trace-review.tsx` | 中：自动保存/undo、搜索结果与保存位置、导出部分失败、长期health | 对应 `web-admin/test/*-settings.test.*`、`web-units/test/*trace*`；测idle/blur合并、old failure不覆盖new success、field错误与operation错误分开、测试通过不报saved、只下载发起不声称磁盘写入 |
| B6：workbench / FDE / approvals一致性适配 | `web-conversation/src/workbench/{files-panel,changes-panel,terminal-panel,terminal-tabs}.tsx`、`web/src/workbench/dock.tsx`、`web-units/src/{approval,message-feedback/form}.tsx`、`web/src/regions/profile-approvals.tsx`、`web-admin/src/agents/{gallery,start-dialog}.tsx`；FDE两个client renderer | 高：流式状态/终端/审批恢复；部分文件可按域再分，原controller保持 | `web/test/{approval-region,turn-approval,workbench-dock}.test.*`、`web-units/test/message-feedback.test.tsx`、`web-ui/test/intelligent-ui*.test.tsx`；测批准≠执行、拒绝/过期/未知保留、pending不重试外部effect、terminal每键不toast、异步旧session不串状态、文件hash拒绝仍生效 |
| B7：插件作者示例和ratchet收尾 | `examples/fde/{meeting-actions,support-triage}/client/index.js`、`examples/community/tool-panel/client/index.js`、`examples/packages/client-panel/{v1,v2}/…/index.css`；docs作者指南和precise allowlist | 低到中；测试夹具有意不同，不批量迁移；公共文档双语 | 确认fixture slot认领/替换/退位、version差异仍可断言；新插件只用public exports/语义token；guard反例能拒绝新旁路；文档链接/locale完整 |

相同文件若同时出现在B3/B7（FDE示例）或B4/B6（对话feedback）只分配一次：按先合入的基础适配确定后续批次为消费/验证，不安排两个窗口各改一半。同一CSS片段不可被多个批次同时编辑，先拆域或交基础owner。

### 6.2 验证原则与真实现有测试入口

现有测试适合扩展，不新增与实现同构的大量测试。实际文件包括：`web-admin/test/schedules-page.test.ts`、`child-engines-settings.test.ts`、`model-slots-settings.test.tsx`、`bundles-settings.test.tsx`、`context-settings.test.ts`、`memory-settings.test.tsx`、`observability-settings.test.tsx`、`search-settings.test.tsx`、`system-prompt-settings.test.tsx`、`security-settings.test.tsx`；`web-ui/test/{primitives,config-form,settings-layout,settings-template,refinement,notifications,settings-v4}.test.tsx`；`web/test/settings.test.ts`、`settings-accounts.test.ts`、`settings-oauth.test.ts`、`model-picker.test.ts`、`plugin-install-flow.test.tsx`、`plugin-page-progress.test.tsx`；资源测试以其owning package现有文件为准。triggers不能冒用schedules覆盖，也不能假设存在`triggers.test.ts`：需在实施时定位现有trigger行为suite，无现有覆盖才新增一个最小contract suite。

每一批都必须测输入/输出、可见反馈、已保存状态、错误/拒绝、busy/cancel、焦点及草稿保存，不断言私有helper调用次数/精确DOM字节/像素。主题/viewport/语言用无障碍角色、可达性、溢出和手动组件规格验收；不用像素snapshot替代行为验证。规格审批后的视觉确认应覆盖en/zh、light/dark、desktop/390px、键盘/IME/reduced-motion，但**当前窗口按COMMON不执行browser/heavy/e2e/release build**。

实施窗口的light命令应从仓根实际匹配文件：Node24 + pinned pnpm，所有vitest/tsc-b经heavy-lock；`--project fast --maxWorkers=1`，确认测试数>0。不要为了这份只读报告安装依赖、跑full fast/heavy/e2e或占用owner服务。

## 7. 小而高可见性的候选 quick wins（全部在组件规格获批后）

1. **统一保存成功出口**：先修Schema表单的双成功，再将辅助模型、schedules、triggers、search、credentials的plain success接入现有Toast；删除相应S+渲染，保留业务记录与action notice。这是接入修复，不做页面布局重设计。
2. **纠正三句误导反馈**：triggers删除/开关按动作说“已删除/已启用”；pinsSkipped用partial说明；bundles“已应用”拆成“已保存”与“重启后台后生效”。不改后台语义。
3. **端点保存行为可见**：用统一form action slot，保存端点按钮 `loading={busy}`，JSON parse错误绑定filters/sample字段；不另加局部按钮CSS。
4. **共享row header/body分离**：先在组件目录通过可展开长内容+switch/menu样例，后迁PluginList；图标/开关不会在展开时跳到内容中部。不要先为各页调magic margin。
5. **统一复制失败可见性**：对CopyButton缺少onCopied失败处理的消费者补operation error；其成功接入同一反馈模型，取消重复live announcement。
6. **消除“有组件却没用”的新增分叉**：停止新增PageHeader/Drawer/Switch别名使用，页头沿SettingsPageHeader，switch沿StateSwitch，Menu等待负责窗口；后续只用18项规格。

这些是候选变更清单，没有在本次worktree改动产品代码，也没有声称已完成体验修复。

## 8. 执行证据、局限与交付

### 8.1 实际执行

| 检查 | 命令 / 方法 | 结果 |
| --- | --- | --- |
| 仓库基线 | `git status --short`、`git remote -v`、`git log -5 --oneline`、`git branch --show-current`、`git rev-parse HEAD origin/feat/agh-plugin-core` | 初始干净；指定review分支；本地base相同；无共享历史改写 |
| 远端只读核对 | `git ls-remote origin refs/heads/feat/agh-plugin-core` | `09218d3d73b7cf009f6d61d7bfab0aa0d6d46062` |
| 规则与定位 | 任务/COMMON、AGENTS、README、docs/README、CONTRIBUTING、source-map、UI consistency/theme/registry、相关实现/测试；只读dsh参考 | 完成；旧skill中“web-ui只有骨架”等2026-09-25描述已由当前源码纠正，未作为事实写入报告 |
| 工具链 | `mise exec node@24 -- node --version` / `pnpm --version` | Node `v24.20.0`，pnpm `10.34.5` |
| 要求的guards尝试 | `heavy-lock.sh mise exec node@24 -- pnpm exec vitest run tools/guards/src --project fast --maxWorkers=1` | **未启动测试，exit254：Command "vitest" not found**。当前worktree无安装依赖；不是测试通过、也不是发现产品失败 |
| 直接执行现有规则函数 | Node24原生TS导入 `web-component-boundary.ts` 与 `ui-presentation.ts`，只对tracked源码执行现有函数，并对照现有JSONbaseline（未修改） | **通过**：组件边界609文件、24个现存baseline文件完全相符；presentation443文件、baseline ceiling24无新增违规。只覆盖这两项扫描，不等于guards全套通过 |
| 静态库存 | 对tracked源文件正则计数JSX/React.createElement（含泛型），反馈render点、raw控件、inline样式、颜色、spacing/radius；人工逐域追踪mutation与locale | 完成；计数见§2和附录，不能替代AST完整语义/运行实例数 |
| 报告自身检查 | 源码路径（含brace分组）存在、表格列数、库存snippet实际执行、`git diff --check`、最终report-only diff核对 | 通过；示例重现Toast8/7、SaveBar2/2、SettingsState126/52、Button399/136、Select14/9、Segmented19/15；只提交报告，结果不含产品测试通过声明 |

### 8.2 未执行与不确定项

未安装依赖；未typecheck、lint、生成器、全量guards、产品单测、browser、e2e、heavy、Storybook、dev/release build。原因是只读报告没有产品变更，且vitest缺依赖；按standing rules不运行重检查。未启动或访问4177/4178，未读owner home/keys，未改其他worktree、dsh或产品文件。未根据owner截图独立复现像素：当前输入未附原图，本文以源码定位其候选路径；native系统stepper/弹层最终宽度/暗色实际对比均保留待视觉复核。

本报告审查有限仓库内UI和声明的插件示例，不审计未知外部插件。约数可能漏掉别名/反射/动态构建的调用，factory/循环另列，所有结论均固定在报告基线，其他窗口后续提交不自动视为已覆盖。PC-SIDEBAR-MENUS状态来自owner指令，本文不代其宣告Menu完工。

收尾远端再次只读核对时，`feat/agh-plugin-core`已推进到`47d29dc4b0050d9fae56cee95640bb311afb3db0`；本worktree的审查基线仍为上文09218d3d…，没有把其他窗口的增量合入后冒称复核。此报告提交是固定源码快照的审查交付，后续基础组件窗口应在其最新集成基线重新核对被触及文件。

交付仅`reports/mp/PC-UI-AUDIT.md`及standing rules要求的报告目录副本；没有main行为移植，因此“main SHA→行为→实现commit”不适用。报告commit用于审查交接，READY行在最终回复给出完整40位SHA；没有push/产品提交/合并。

## 附录 A. 共享组件逐文件调用库存

此表列出扫描命中的每个消费文件及各静态调用点数量；包含web-ui内部组合、互斥分支与settings-fixture。它是§2计数的可复核展开，不表示有748种组件。泛型调用如`<Select<string>>`已计入；未匹配的别名调用、DOM factory和专用listbox在§2单列。路径均为仓根相对路径。

| 源文件 | 组件（静态调用点约数） |
| --- | --- |
| `packages/resource-control-web/src/credential-editor.tsx` | `Banner` ×1, `Button` ×3, `Dialog` ×1, `Field` ×2, `SettingsInput` ×2 |
| `packages/resource-control-web/src/credentials.tsx` | `Banner` ×3, `Button` ×3, `Dialog` ×1, `EmptyState` ×1, `IconButton` ×2, `ListRow` ×1, `Loadable` ×1, `Menu` ×1, `SettingsCheckbox` ×1, `SettingsList` ×1, `SettingsPage` ×1, `SettingsState` ×1 |
| `packages/resource-control-web/src/mcp-credentials.tsx` | `Banner` ×1, `Button` ×1 |
| `packages/resource-control-web/src/mcp-presets.tsx` | `Button` ×1, `Field` ×1, `SettingsSelect` ×1 |
| `packages/resource-control-web/src/skills-page.tsx` | `Button` ×4, `IconButton` ×1, `Menu` ×1, `Popover` ×1, `SettingsDetails` ×1, `SettingsPageHeader` ×1, `SettingsState` ×2, `Tabs` ×1, `Toast` ×2 |
| `packages/web-admin/src/admin/plugins/admin/dependent-update.tsx` | `Banner` ×1, `SettingsGroup` ×1, `SettingsItem` ×1 |
| `packages/web-admin/src/admin/plugins/admin/detail-body.tsx` | `Badge` ×1, `Button` ×1, `SettingsState` ×2, `Tag` ×1 |
| `packages/web-admin/src/admin/plugins/admin/example-parent.tsx` | `Banner` ×1, `Button` ×1 |
| `packages/web-admin/src/admin/plugins/admin/views.tsx` | `Button` ×3, `Field` ×1, `Menu` ×1, `Popover` ×1, `SettingsDetails` ×1, `SettingsPageHeader` ×1, `SettingsSelect` ×1, `StateSwitch` ×1, `Tabs` ×1 |
| `packages/web-admin/src/admin/plugins/bundles-panel.tsx` | `Banner` ×1, `Button` ×4, `IconButton` ×1, `Select` ×1, `SettingsBlock` ×5, `SettingsItem` ×4, `SettingsTag` ×1, `StateSwitch` ×1 |
| `packages/web-admin/src/admin/plugins/candidate-review.tsx` | `Badge` ×1, `Disclosure` ×2 |
| `packages/web-admin/src/admin/plugins/candidates.tsx` | `Badge` ×2, `Button` ×7, `EmptyState` ×1, `ListRow` ×1, `PushCrumbs` ×2, `SettingsDetails` ×1, `SettingsState` ×2, `Tag` ×1 |
| `packages/web-admin/src/admin/plugins/config-panel.tsx` | `Button` ×3, `Disclosure` ×1, `SettingsSelect` ×1, `SettingsState` ×1 |
| `packages/web-admin/src/admin/plugins/config-tab.tsx` | `Tabs` ×1 |
| `packages/web-admin/src/admin/plugins/detail-copy.tsx` | `Button` ×1, `SettingsState` ×1, `Toast` ×1 |
| `packages/web-admin/src/admin/plugins/install-review.tsx` | `Banner` ×3, `Button` ×5, `SettingsGroup` ×2, `SettingsItem` ×3 |
| `packages/web-admin/src/admin/plugins/operation-feedback.tsx` | `Button` ×1, `Toast` ×1 |
| `packages/web-admin/src/admin/plugins/plugin-badges.tsx` | `Disclosure` ×1, `Field` ×1, `Select` ×1, `Tag` ×2, `Tooltip` ×1 |
| `packages/web-admin/src/admin/plugins/session-defaults-panel.tsx` | `Select` ×3, `SettingsBlock` ×2, `SettingsChoice` ×2, `SettingsGroup` ×1, `SettingsItem` ×3, `SettingsTag` ×2 |
| `packages/web-admin/src/agents/gallery.tsx` | `Button` ×2, `EmptyState` ×2, `Loadable` ×2, `PushPage` ×1, `Segmented` ×1, `StatusDot` ×1, `Tag` ×1 |
| `packages/web-admin/src/agents/start-dialog.tsx` | `Banner` ×3, `Button` ×7, `Loadable` ×1, `PushPage` ×1, `SettingsGroup` ×1, `SettingsItem` ×3, `Tag` ×1 |
| `packages/web-admin/src/oauth-controls.ts` | `Button` ×1, `Field` ×1, `SettingsInput` ×1 |
| `packages/web-admin/src/permission-picker.tsx` | `Button` ×2, `Popover` ×1 |
| `packages/web-admin/src/settings/account-network.tsx` | `SettingsBlock` ×1, `SettingsItem` ×1, `SettingsPresetSelect` ×1 |
| `packages/web-admin/src/settings/account-tiles.ts` | `Button` ×1, `Disclosure` ×1 |
| `packages/web-admin/src/settings/auto-review.tsx` | `Banner` ×1, `Button` ×2, `IconButton` ×1, `Segmented` ×1, `SettingsBlock` ×5, `SettingsChipToggle` ×1, `SettingsChips` ×1, `SettingsInput` ×1, `SettingsItem` ×9, `SettingsPresetSelect` ×1, `SettingsSelect` ×1, `StateSwitch` ×1 |
| `packages/web-admin/src/settings/child-engines.tsx` | `Button` ×1, `SettingsDetails` ×1, `SettingsGroup` ×1, `SettingsItem` ×1 |
| `packages/web-admin/src/settings/context.tsx` | `Banner` ×1, `IconButton` ×1, `Select` ×2, `SettingsBlock` ×3, `SettingsChips` ×1, `SettingsExpand` ×1, `SettingsItem` ×7, `SettingsPresetSelect` ×1, `StateSwitch` ×2 |
| `packages/web-admin/src/settings/diagnostics.tsx` | `Banner` ×1, `Button` ×6, `Dialog` ×1, `Segmented` ×1, `SettingsBlock` ×5, `SettingsExpand` ×1, `SettingsInput` ×2, `SettingsItem` ×9, `SettingsState` ×1 |
| `packages/web-admin/src/settings/doctor.tsx` | `Button` ×4, `SettingsBlock` ×1, `SettingsDetails` ×1, `SettingsState` ×2 |
| `packages/web-admin/src/settings/examples.tsx` | `Button` ×3, `IconButton` ×1, `SettingsCard` ×1, `SettingsDetails` ×2, `SettingsState` ×2 |
| `packages/web-admin/src/settings/feedback.tsx` | `Badge` ×1, `EmptyState` ×1, `IconButton` ×2, `SettingsSelect` ×3, `SettingsState` ×2 |
| `packages/web-admin/src/settings/hub.tsx` | `Banner` ×1, `Button` ×4, `Disclosure` ×1, `PushCrumbs` ×1, `SettingsInput` ×1, `SettingsPage` ×2, `SettingsState` ×3 |
| `packages/web-admin/src/settings/jobs-panel.tsx` | `Banner` ×2, `Button` ×5, `Dialog` ×1, `EmptyState` ×2, `Field` ×1, `IconButton` ×1, `ListRow` ×1, `Menu` ×1, `SettingsDetails` ×2, `SettingsState` ×3, `Tag` ×1 |
| `packages/web-admin/src/settings/memory.tsx` | `Banner` ×1, `Button` ×3, `Segmented` ×1, `SettingsBlock` ×4, `SettingsItem` ×8, `SettingsSelect` ×1, `SettingsTextArea` ×1 |
| `packages/web-admin/src/settings/model-slots.tsx` | `Banner` ×1, `Button` ×1, `Loadable` ×1, `SettingsItem` ×1, `SettingsState` ×1 |
| `packages/web-admin/src/settings/observability.tsx` | `Banner` ×2, `Button` ×3, `IconButton` ×1, `Segmented` ×2, `SettingsBlock` ×3, `SettingsInput` ×4, `SettingsItem` ×13, `SettingsPresetSelect` ×1, `SettingsTag` ×1, `StateSwitch` ×1 |
| `packages/web-admin/src/settings/pages.tsx` | `Banner` ×1, `Button` ×1, `Loadable` ×1 |
| `packages/web-admin/src/settings/permission-defaults.tsx` | `Button` ×2, `Dialog` ×1, `SettingsBlock` ×2, `SettingsChoice` ×1, `SettingsItem` ×1, `SettingsSelect` ×1, `SettingsState` ×1 |
| `packages/web-admin/src/settings/personalization.tsx` | `Banner` ×1, `Button` ×1, `Segmented` ×1, `SettingsBlock` ×1, `SettingsInput` ×1, `SettingsItem` ×2, `SettingsTextArea` ×2 |
| `packages/web-admin/src/settings/pins.tsx` | `Banner` ×2, `Button` ×5, `ListRow` ×1, `SettingsList` ×1, `SettingsState` ×3 |
| `packages/web-admin/src/settings/prompt-conflict.tsx` | `Banner` ×1, `Button` ×1, `SettingsBlock` ×1, `SettingsItem` ×1 |
| `packages/web-admin/src/settings/registry.tsx` | `SettingsBlock` ×1, `SettingsExpand` ×6 |
| `packages/web-admin/src/settings/runtime-panels.tsx` | `Badge` ×4, `Banner` ×5, `Button` ×10, `SettingsDetails` ×3, `SettingsGroup` ×1, `SettingsInput` ×1, `SettingsItem` ×1, `SettingsList` ×5, `SettingsRow` ×5, `SettingsState` ×6, `Tag` ×1 |
| `packages/web-admin/src/settings/schedule-form.tsx` | `Button` ×2, `Field` ×14, `PushPage` ×1, `Segmented` ×2, `SettingsInput` ×6, `SettingsSelect` ×5, `SettingsState` ×1, `SettingsTextArea` ×1, `StateSwitch` ×1 |
| `packages/web-admin/src/settings/schedules.tsx` | `Button` ×2, `ConfirmDialog` ×1, `EmptyState` ×1, `IconButton` ×1, `ListRow` ×2, `Loadable` ×1, `Menu` ×1, `Segmented` ×1, `SettingsDetails` ×1, `SettingsList` ×2, `SettingsState` ×5, `StateSwitch` ×2, `StatusDot` ×2, `Tag` ×1 |
| `packages/web-admin/src/settings/search.tsx` | `Badge` ×1, `Banner` ×2, `Button` ×6, `ConfirmDialog` ×1, `EmptyState` ×1, `Field` ×4, `IconButton` ×1, `ListRow` ×2, `Menu` ×1, `PushPage` ×1, `Segmented` ×1, `SettingsDetails` ×1, `SettingsGroup` ×1, `SettingsInput` ×1, `SettingsItem` ×2, `SettingsList` ×3, `SettingsState` ×6, `StateSwitch` ×3, `Tag` ×2 |
| `packages/web-admin/src/settings/security-status.tsx` | `Banner` ×2, `Button` ×1, `SettingsBlock` ×3, `SettingsDetails` ×1, `SettingsItem` ×6, `SettingsList` ×1, `SettingsRow` ×1, `SettingsState` ×1, `SettingsTag` ×3 |
| `packages/web-admin/src/settings/session-tools.tsx` | `Disclosure` ×3, `SettingsDetails` ×2, `SettingsState` ×2 |
| `packages/web-admin/src/settings/status-check.tsx` | `Button` ×2, `Dialog` ×1 |
| `packages/web-admin/src/settings/system-prompt.tsx` | `Banner` ×2, `Button` ×3, `CopyButton` ×1, `Segmented` ×1, `Select` ×1, `SettingsBlock` ×7, `SettingsCheckbox` ×1, `SettingsExpand` ×1, `SettingsItem` ×2, `SettingsTextArea` ×1, `StateSwitch` ×1 |
| `packages/web-admin/src/settings/triggers.tsx` | `Button` ×8, `ConfirmDialog` ×1, `EmptyState` ×1, `Field` ×12, `IconButton` ×1, `ListRow` ×2, `Loadable` ×1, `Menu` ×1, `PushPage` ×1, `SettingsDetails` ×3, `SettingsGroup` ×1, `SettingsInput` ×5, `SettingsItem` ×1, `SettingsList` ×2, `SettingsSelect` ×4, `SettingsState` ×5, `SettingsTextArea` ×3, `StateSwitch` ×2, `StatusDot` ×1, `Tag` ×1 |
| `packages/web-conversation/src/conversation-registry.tsx` | `ConversationCardLayout` ×1 |
| `packages/web-conversation/src/goal-actions.tsx` | `Button` ×1 |
| `packages/web-conversation/src/goal-card.tsx` | `Button` ×2, `ConversationCardLayout` ×1, `Field` ×3, `Popover` ×1, `SettingsInput` ×2, `SettingsState` ×1, `SettingsTextArea` ×1 |
| `packages/web-conversation/src/workbench/changes-panel.tsx` | `Button` ×7, `Disclosure` ×2, `IconButton` ×1, `Segmented` ×2, `SettingsState` ×9 |
| `packages/web-conversation/src/workbench/files-panel.tsx` | `Button` ×3, `EmptyState` ×1, `IconButton` ×1, `Menu` ×1, `SettingsState` ×2 |
| `packages/web-conversation/src/workbench/files-preview.tsx` | `Button` ×2, `Segmented` ×1, `SettingsState` ×4 |
| `packages/web-conversation/src/workbench/files-tree.tsx` | `Button` ×1, `IconButton` ×1 |
| `packages/web-conversation/src/workbench/goal-panel.tsx` | `Disclosure` ×1, `SettingsState` ×3 |
| `packages/web-conversation/src/workbench/terminal-panel.tsx` | `Button` ×2, `ConfirmDialog` ×1, `IconButton` ×2, `Menu` ×1, `SettingsState` ×2 |
| `packages/web-conversation/src/workbench/terminal-tabs.tsx` | `Button` ×1, `IconButton` ×1, `Menu` ×1, `Popover` ×1, `SettingsInput` ×1, `StatusDot` ×1 |
| `packages/web-conversation/src/workbench/terminal-view.tsx` | `SettingsState` ×1 |
| `packages/web-foundation/src/appearance.ts` | `Button` ×1, `SettingsState` ×1 |
| `packages/web-ui/src/admin-confirmation.tsx` | `Disclosure` ×1 |
| `packages/web-ui/src/admin-detail.tsx` | `Button` ×4, `IconButton` ×1, `Menu` ×1 |
| `packages/web-ui/src/admin-dialogs.tsx` | `Button` ×5, `Field` ×2, `SettingsInput` ×1, `SettingsSelect` ×1 |
| `packages/web-ui/src/admin-list.tsx` | `Button` ×4, `EmptyState` ×1, `IconButton` ×1, `ListRow` ×1, `Menu` ×1, `Select` ×1, `SettingsDetails` ×1, `SettingsList` ×2, `SettingsState` ×1, `StateSwitch` ×2, `Tag` ×1 |
| `packages/web-ui/src/auxiliary-model-fields.tsx` | `Badge` ×1, `SettingsGroup` ×1, `SettingsItem` ×1, `SettingsSelect` ×1 |
| `packages/web-ui/src/config-form.tsx` | `Button` ×2, `Field` ×1, `SettingsInput` ×1, `SettingsSaveBar` ×1, `SettingsSelect` ×1, `SettingsState` ×5, `SettingsTextArea` ×1, `StateSwitch` ×1 |
| `packages/web-ui/src/conversation/cost.tsx` | `Disclosure` ×1 |
| `packages/web-ui/src/conversation/interaction-result.tsx` | `SettingsDetails` ×1 |
| `packages/web-ui/src/conversation/messages/activity-row.tsx` | `Button` ×1 |
| `packages/web-ui/src/conversation/messages/attachment-image.tsx` | `Button` ×1 |
| `packages/web-ui/src/conversation/messages/process-step.tsx` | `CopyButton` ×1 |
| `packages/web-ui/src/conversation/messages/turn.tsx` | `Bubble` ×2, `Disclosure` ×1 |
| `packages/web-ui/src/conversation/messages/user-message.tsx` | `Button` ×1, `Disclosure` ×1 |
| `packages/web-ui/src/conversation/turn-actions.tsx` | `Button` ×2, `Disclosure` ×1 |
| `packages/web-ui/src/conversation/turn-nav.tsx` | `Button` ×1 |
| `packages/web-ui/src/conversation/turn-usage.tsx` | `Disclosure` ×3 |
| `packages/web-ui/src/conversation/usage.tsx` | `Disclosure` ×1 |
| `packages/web-ui/src/diagnostics-dialog.tsx` | `Button` ×7, `SettingsCheckbox` ×3, `SettingsState` ×1 |
| `packages/web-ui/src/doctor-groups.tsx` | `Button` ×1 |
| `packages/web-ui/src/first-run.tsx` | `Badge` ×1, `Button` ×10, `Dialog` ×1, `Disclosure` ×1, `Field` ×1, `SettingsInput` ×1, `SettingsList` ×1, `SettingsRow` ×1, `SettingsState` ×3 |
| `packages/web-ui/src/intelligent-ui/catalog.tsx` | `Button` ×1, `IconButton` ×1, `SettingsState` ×4 |
| `packages/web-ui/src/intelligent-ui/chip.tsx` | `Button` ×1, `IconButton` ×1, `Menu` ×1, `Toast` ×1 |
| `packages/web-ui/src/intelligent-ui/presets.tsx` | `Badge` ×1, `Tabs` ×1 |
| `packages/web-ui/src/intelligent-ui/question-card.tsx` | `Button` ×7, `SettingsInput` ×2, `SettingsTextArea` ×1 |
| `packages/web-ui/src/intelligent-ui/render-boundary.tsx` | `Button` ×1, `SettingsState` ×1 |
| `packages/web-ui/src/intelligent-ui/surface.tsx` | `Badge` ×1, `Button` ×11, `CopyButton` ×1, `Disclosure` ×1, `IconButton` ×1, `Menu` ×1, `SettingsState` ×1, `Toast` ×1 |
| `packages/web-ui/src/mcp-connection-row.tsx` | `Button` ×1, `IconButton` ×1, `ListRow` ×1, `Menu` ×1, `StateSwitch` ×1, `Tag` ×1 |
| `packages/web-ui/src/plugin-purpose.tsx` | `Badge` ×1, `SettingsDetails` ×1 |
| `packages/web-ui/src/plugin-schema-fields.tsx` | `Button` ×7, `SettingsInput` ×3, `SettingsSelect` ×2 |
| `packages/web-ui/src/plugin-schema-json.tsx` | `SettingsTextArea` ×1 |
| `packages/web-ui/src/plugin-schema-secret.tsx` | `SettingsInput` ×1, `SettingsSelect` ×1 |
| `packages/web-ui/src/region-error-boundary.tsx` | `Button` ×1 |
| `packages/web-ui/src/resource-detail.tsx` | `Button` ×9, `Disclosure` ×2, `Field` ×2, `IconButton` ×1, `Segmented` ×1, `SettingsInput` ×1, `SettingsSaveBar` ×1, `SettingsState` ×2 |
| `packages/web-ui/src/resource-list.tsx` | `Button` ×7, `Disclosure` ×1, `EmptyState` ×1, `IconButton` ×1, `ListRow` ×2, `Menu` ×1, `SettingsList` ×1, `SettingsState` ×4, `StateSwitch` ×2, `Tag` ×2 |
| `packages/web-ui/src/schema-settings.tsx` | `Button` ×1, `SettingsCard` ×1, `SettingsState` ×2 |
| `packages/web-ui/src/session-auxiliary-models.tsx` | `Button` ×1, `SettingsDetails` ×1, `SettingsState` ×2 |
| `packages/web-ui/src/session-picker.tsx` | `Select` ×1 |
| `packages/web-ui/src/settings-account-dialog.tsx` | `Button` ×8, `Disclosure` ×2, `Field` ×8, `SettingsInput` ×4, `SettingsOptionSelect` ×4 |
| `packages/web-ui/src/settings-accounts.tsx` | `Badge` ×1, `Button` ×8, `EmptyState` ×1, `Loadable` ×1, `Menu` ×1, `SettingsGroup` ×2, `SettingsState` ×1, `Tag` ×2, `Toast` ×1 |
| `packages/web-ui/src/settings-computer-use.tsx` | `Badge` ×1, `Button` ×7, `IconButton` ×1, `SettingsDetails` ×1, `SettingsGroup` ×2, `SettingsItem` ×4, `Tag` ×1 |
| `packages/web-ui/src/settings-layout.tsx` | `Button` ×2, `CopyButton` ×1, `Disclosure` ×3, `PushHeader` ×1, `SettingsInput` ×1, `SettingsPageHeader` ×1, `Skeleton` ×1 |
| `packages/web-ui/src/settings-model-pane.tsx` | `SettingsBlock` ×1, `SettingsPage` ×1 |
| `packages/web-ui/src/settings-option-select.tsx` | `SettingsSelect` ×1 |
| `packages/web-ui/src/ui/banner.tsx` | `IconButton` ×1 |
| `packages/web-ui/src/ui/button.tsx` | `Tooltip` ×1 |
| `packages/web-ui/src/ui/chart.tsx` | `Disclosure` ×1, `Tooltip` ×2 |
| `packages/web-ui/src/ui/confirm-dialog.tsx` | `Button` ×2, `Dialog` ×1 |
| `packages/web-ui/src/ui/copy-button.tsx` | `IconButton` ×1 |
| `packages/web-ui/src/ui/data-list.tsx` | `ListRow` ×1 |
| `packages/web-ui/src/ui/drawer.tsx` | `IconButton` ×1 |
| `packages/web-ui/src/ui/icon-button.tsx` | `Button` ×1, `Tooltip` ×1 |
| `packages/web-ui/src/ui/labeled-switch.tsx` | `StateSwitch` ×1 |
| `packages/web-ui/src/ui/list-row.tsx` | `Button` ×1 |
| `packages/web-ui/src/ui/loadable.tsx` | `Button` ×1 |
| `packages/web-ui/src/ui/menu.tsx` | `Tooltip` ×1 |
| `packages/web-ui/src/ui/notifications.tsx` | `IconButton` ×1 |
| `packages/web-ui/src/ui/push-stack.tsx` | `PushCrumbs` ×2, `PushHeader` ×1 |
| `packages/web-ui/src/ui/settings-controls.tsx` | `Loadable` ×1, `SettingsGroup` ×1, `SettingsInput` ×1, `SettingsSelect` ×1 |
| `packages/web-ui/src/ui/settings-subpages.tsx` | `PushHeader` ×1 |
| `packages/web-units/src/approval.tsx` | `Button` ×1 |
| `packages/web-units/src/composer-uploads.tsx` | `Button` ×3 |
| `packages/web-units/src/composer.tsx` | `Button` ×6, `Sender` ×1, `SettingsInput` ×1, `Tooltip` ×2 |
| `packages/web-units/src/composer/attachment-list.tsx` | `Button` ×1 |
| `packages/web-units/src/composer/child-controls.tsx` | `Button` ×2, `Disclosure` ×1, `SettingsInput` ×1, `SettingsState` ×1 |
| `packages/web-units/src/composer/extras.tsx` | `SettingsDetails` ×1 |
| `packages/web-units/src/composer/file-mentions.tsx` | `Button` ×1 |
| `packages/web-units/src/composer/queue.tsx` | `Button` ×5, `IconButton` ×1, `Menu` ×1, `SettingsTextArea` ×1, `Tooltip` ×3 |
| `packages/web-units/src/conversation.tsx` | `Button` ×1 |
| `packages/web-units/src/conversation/tool-card.tsx` | `Tag` ×1 |
| `packages/web-units/src/diagnostics-viewer.tsx` | `Button` ×1, `SettingsList` ×1, `SettingsRow` ×1, `SettingsState` ×1, `Tabs` ×1 |
| `packages/web-units/src/message-feedback/form.tsx` | `Button` ×5, `Popover` ×1, `SettingsCheckbox` ×1, `SettingsTextArea` ×1 |
| `packages/web-units/src/message-feedback/provenance.tsx` | `Button` ×1, `Disclosure` ×1 |
| `packages/web-units/src/reference-picker.tsx` | `Button` ×1 |
| `packages/web-units/src/run-status.tsx` | `Button` ×2 |
| `packages/web-units/src/settings-fixture.tsx` | `Button` ×8, `Disclosure` ×2, `SettingsInput` ×4, `SettingsSelect` ×4 |
| `packages/web-units/src/settings-panes.tsx` | `SettingsBlock` ×2, `SettingsChoice` ×6, `SettingsItem` ×5, `SettingsOptionSelect` ×2, `SettingsPageHeader` ×1, `StateSwitch` ×1 |
| `packages/web-units/src/settings-shell.tsx` | `Button` ×6, `PushCrumbs` ×1 |
| `packages/web-units/src/settings.tsx` | `Toast` ×1 |
| `packages/web-units/src/sidebar.tsx` | `Button` ×2, `IconButton` ×2, `Tooltip` ×2 |
| `packages/web-units/src/topbar-title.tsx` | `IconButton` ×2, `SettingsInput` ×1 |
| `packages/web-units/src/topbar.tsx` | `Button` ×1, `IconButton` ×1 |
| `packages/web-units/src/trace-gantt.tsx` | `Button` ×1 |
| `packages/web-units/src/trace-inspector-panes.tsx` | `Button` ×1 |
| `packages/web-units/src/trace-inspector-parts.tsx` | `Button` ×1, `CopyButton` ×1, `IconButton` ×1 |
| `packages/web-units/src/trace-inspector.tsx` | `Button` ×3, `IconButton` ×2, `Menu` ×1 |
| `packages/web-units/src/trace-list-row.tsx` | `Button` ×1 |
| `packages/web-units/src/trace-provenance.tsx` | `Button` ×1 |
| `packages/web-units/src/trace-request.tsx` | `Button` ×1, `CopyButton` ×1, `Segmented` ×1, `SettingsCheckbox` ×1, `SettingsDetails` ×3, `SettingsSelect` ×2, `SettingsState` ×4, `Tag` ×1 |
| `packages/web-units/src/trace-review.tsx` | `Button` ×3 |
| `packages/web-units/src/trace-toolbar.tsx` | `Button` ×2, `IconButton` ×4, `Menu` ×1, `SettingsInput` ×1 |
| `packages/web-units/src/trace.tsx` | `Button` ×3, `EmptyState` ×1 |
| `packages/web-units/src/workspace-dialog.tsx` | `Button` ×3, `Dialog` ×1, `Disclosure` ×1, `SettingsInput` ×1 |
| `packages/web/src/app-dialogs.tsx` | `Button` ×12, `Disclosure` ×1, `ListRow` ×3, `SettingsCheckbox` ×1, `SettingsInput` ×9, `SettingsSelect` ×6, `SettingsTextArea` ×3 |
| `packages/web/src/app-notices.tsx` | `Banner` ×1, `Button` ×7, `Notifications` ×1 |
| `packages/web/src/app-shell.tsx` | `Button` ×1, `TopProgress` ×1 |
| `packages/web/src/conversation-message-adapter.tsx` | `Button` ×1 |
| `packages/web/src/intelligent-ui/artifact-file.tsx` | `Button` ×4, `IconButton` ×1, `Menu` ×1 |
| `packages/web/src/intelligent-ui/placements.tsx` | `Button` ×3, `Menu` ×1, `SettingsState` ×2 |
| `packages/web/src/intelligent-ui/turn-deliverables.tsx` | `Disclosure` ×1 |
| `packages/web/src/intelligent-ui/workbench-deliverables.tsx` | `Button` ×1, `Disclosure` ×1, `SettingsState` ×2 |
| `packages/web/src/loop-picker.tsx` | `Button` ×1, `Field` ×3, `Popover` ×1, `Select` ×3, `SettingsInput` ×1 |
| `packages/web/src/model-picker.tsx` | `Button` ×2, `Popover` ×1, `SettingsInput` ×2 |
| `packages/web/src/navigation.tsx` | `Button` ×7, `Conversations` ×1, `EmptyState` ×2, `IconButton` ×2, `PushCrumbs` ×1, `SettingsInput` ×1 |
| `packages/web/src/pages/agents-page.tsx` | `IconButton` ×1 |
| `packages/web/src/pages/automation-page.tsx` | `Tabs` ×1 |
| `packages/web/src/pages/plugins-page.tsx` | `Button` ×2, `IconButton` ×1, `Menu` ×1, `Tabs` ×1 |
| `packages/web/src/pages/plugins/capabilities.tsx` | `Badge` ×2, `PushPage` ×1, `SettingsGroup` ×2, `SettingsItem` ×3, `Tabs` ×1 |
| `packages/web/src/pages/plugins/hosted-pages.tsx` | `PushPage` ×1 |
| `packages/web/src/pages/plugins/install-page.tsx` | `PushPage` ×1 |
| `packages/web/src/pages/plugins/market-tab.tsx` | `Badge` ×1, `Button` ×5, `EmptyState` ×1, `Select` ×1, `SettingsDetails` ×1, `SettingsSelect` ×1, `SettingsState` ×1, `Tag` ×1 |
| `packages/web/src/pages/plugins/plugins-tab.tsx` | `Badge` ×1, `Banner` ×3, `Button` ×4, `Field` ×1, `ListRow` ×1, `Popover` ×1, `SettingsSelect` ×1, `SettingsState` ×3, `Tag` ×1 |
| `packages/web/src/pages/plugins/resources-tab.tsx` | `Banner` ×1, `Button` ×2 |
| `packages/web/src/pages/plugins/review-tab.tsx` | `PushPage` ×1, `Segmented` ×2, `SettingsState` ×1 |
| `packages/web/src/pages/plugins/skill-folders.tsx` | `Button` ×1, `Field` ×1, `SettingsDetails` ×1, `SettingsState` ×2, `SettingsTextArea` ×1 |
| `packages/web/src/pages/plugins/skill-run.tsx` | `Button` ×1, `PushPage` ×1, `SettingsGroup` ×1, `SettingsInput` ×1, `SettingsItem` ×1 |
| `packages/web/src/regions/empty-state.tsx` | `Welcome` ×1 |
| `packages/web/src/regions/home-entries.tsx` | `Button` ×2, `Menu` ×1, `Tooltip` ×2 |
| `packages/web/src/regions/profile-approvals.tsx` | `Button` ×1, `Tooltip` ×1 |
| `packages/web/src/regions/rightbar.tsx` | `EmptyState` ×1 |
| `packages/web/src/regions/session-tools.tsx` | `IconButton` ×2, `Menu` ×1 |
| `packages/web/src/regions/session-views.tsx` | `Button` ×1, `IconButton` ×1, `Tabs` ×1 |
| `packages/web/src/session-actions.tsx` | `Button` ×2, `Dialog` ×1, `SettingsInput` ×1 |
| `packages/web/src/session-menu.tsx` | `Button` ×1, `Menu` ×1 |
| `packages/web/src/session-runtime-dialog.tsx` | `Button` ×1, `Dialog` ×1, `ListRow` ×8, `SettingsGroup` ×1, `SettingsItem` ×5, `SettingsList` ×1, `Tag` ×4 |
| `packages/web/src/session-runtime-sections.tsx` | `Button` ×3, `ListRow` ×2, `SettingsDetails` ×1, `SettingsList` ×2, `SettingsState` ×6, `Tag` ×1 |
| `packages/web/src/session-search.tsx` | `Button` ×1, `Dialog` ×1, `IconButton` ×1, `SettingsInput` ×3 |
| `packages/web/src/workbench/dock.tsx` | `Button` ×2, `EmptyState` ×1, `IconButton` ×3, `Menu` ×1, `Tabs` ×1, `Tooltip` ×1 |

0个直接调用的库存：`Switch`、`LabeledSwitch`、`DataList`、`Drawer`、`StateLights`、`PageHeader`、`Prompts`。这不代表库内不互相调用，例如LabeledSwitch本身调用StateSwitch，适配器/React.createElement别名也可能间接触达；不能据此擅自删public exports。`PrimitiveToast`是overlay adapter内部别名，单列为1个转发，不重复加到8个业务/组合调用点中。

## 附录 B. 反馈渲染点逐文件索引

列出全部扫描到的Toast/Notifications/Banner/SettingsState/SettingsSaveBar和直接`role=status/alert`渲染行，共125个文件、299个命中行。Field错误可从附录A的Field与Schema实现追踪；controller动态say/setNotice、业务receipt、无反馈路径已在§1逐操作盘点。一个render行可服务多个operation；本表不把它们重复算成独立实现。模板字符串role对象、跨行动态role不保证由正则全识别，故人工追踪优先。

| 文件 | 行号与渲染载体 |
| --- | --- |
| `packages/resource-control-web/src/credential-editor.tsx` | 102: Banner |
| `packages/resource-control-web/src/credentials.tsx` | 198: Banner; 200: Banner; 204: SettingsState; 318: Banner |
| `packages/resource-control-web/src/mcp-credentials.tsx` | 54: Banner |
| `packages/resource-control-web/src/skills-page.tsx` | 145: Toast; 155: Toast; 192: SettingsState; 198: SettingsState |
| `packages/web-admin/src/admin/plugins/admin/dependent-update.tsx` | 92: Banner |
| `packages/web-admin/src/admin/plugins/admin/detail-body.tsx` | 212: SettingsState; 217: SettingsState |
| `packages/web-admin/src/admin/plugins/admin/example-parent.tsx` | 70: Banner |
| `packages/web-admin/src/admin/plugins/bundles-panel.tsx` | 197: Banner; 199: alert; 337: status |
| `packages/web-admin/src/admin/plugins/candidates.tsx` | 432: SettingsState/status; 449: alert; 458: SettingsState; 489: alert |
| `packages/web-admin/src/admin/plugins/config-panel.tsx` | 142: status; 149: SettingsState; 187: alert; 212: status |
| `packages/web-admin/src/admin/plugins/detail-copy.tsx` | 24: SettingsState; 25: Toast |
| `packages/web-admin/src/admin/plugins/install-review.tsx` | 100: Banner; 117: alert; 202: Banner; 212: Banner |
| `packages/web-admin/src/admin/plugins/operation-feedback.tsx` | 35: Toast |
| `packages/web-admin/src/agents/start-dialog.tsx` | 404: Banner; 411: Banner; 449: status; 457: Banner |
| `packages/web-admin/src/settings/auto-review.tsx` | 191: Banner |
| `packages/web-admin/src/settings/child-engines.tsx` | 214: dynamic role |
| `packages/web-admin/src/settings/context.tsx` | 276: Banner/alert |
| `packages/web-admin/src/settings/diagnostics.tsx` | 292: SettingsState; 441: Banner |
| `packages/web-admin/src/settings/doctor.tsx` | 67: SettingsState; 69: SettingsState; 76: status; 178: status; 187: alert |
| `packages/web-admin/src/settings/examples.tsx` | 140: SettingsState; 141: SettingsState |
| `packages/web-admin/src/settings/feedback.tsx` | 124: SettingsState; 125: SettingsState |
| `packages/web-admin/src/settings/hub.tsx` | 285: SettingsState; 366: SettingsState; 371: Banner; 408: SettingsState |
| `packages/web-admin/src/settings/jobs-panel.tsx` | 160: Banner; 167: SettingsState; 205: Banner; 209: SettingsState; 261: status; 295: SettingsState |
| `packages/web-admin/src/settings/memory.tsx` | 210: Banner/alert |
| `packages/web-admin/src/settings/model-slots.tsx` | 194: SettingsState; 199: Banner |
| `packages/web-admin/src/settings/observability.tsx` | 283: Banner; 288: Banner/status |
| `packages/web-admin/src/settings/pages.tsx` | 199: Banner |
| `packages/web-admin/src/settings/permission-defaults.tsx` | 142: status; 212: SettingsState |
| `packages/web-admin/src/settings/personalization.tsx` | 94: Banner |
| `packages/web-admin/src/settings/pins.tsx` | 105: Banner; 109: SettingsState; 111: Banner; 135: SettingsState; 157: SettingsState |
| `packages/web-admin/src/settings/prompt-conflict.tsx` | 17: Banner; 19: alert |
| `packages/web-admin/src/settings/runtime-panels.tsx` | 66: SettingsState; 185: SettingsState; 205: SettingsState; 234: SettingsState; 280: Banner; 307: Banner/alert; 311: SettingsState/status; 361: SettingsState; 365: Banner/alert; 485: Banner; 513: Banner/alert |
| `packages/web-admin/src/settings/schedule-form.tsx` | 546: SettingsState |
| `packages/web-admin/src/settings/schedules.tsx` | 372: SettingsState; 416: SettingsState; 421: SettingsState; 591: SettingsState; 635: SettingsState |
| `packages/web-admin/src/settings/search.tsx` | 470: SettingsState; 475: Banner; 487: SettingsState; 497: Banner; 545: SettingsState; 551: SettingsState; 693: SettingsState; 726: SettingsState |
| `packages/web-admin/src/settings/security-status.tsx` | 34: SettingsState; 201: Banner; 203: Banner |
| `packages/web-admin/src/settings/session-tools.tsx` | 53: SettingsState; 168: SettingsState |
| `packages/web-admin/src/settings/system-prompt.tsx` | 138: Banner; 140: Banner; 142: alert |
| `packages/web-admin/src/settings/triggers.tsx` | 240: SettingsState/alert; 245: SettingsState; 256: status; 431: SettingsState; 655: SettingsState; 717: SettingsState |
| `packages/web-conversation/src/goal-card.tsx` | 73: SettingsState/status |
| `packages/web-conversation/src/workbench/changes-panel.tsx` | 109: SettingsState; 176: SettingsState; 183: SettingsState; 240: SettingsState; 288: status; 293: status; 298: status; 303: status; 308: status; 326: SettingsState; 379: SettingsState; 384: status; 385: status; 486: SettingsState; 487: SettingsState; 488: SettingsState; 492: status |
| `packages/web-conversation/src/workbench/files-panel.tsx` | 188: SettingsState; 240: SettingsState; 276: status; 290: status; 294: status |
| `packages/web-conversation/src/workbench/files-preview.tsx` | 128: status; 142: SettingsState; 152: SettingsState; 156: SettingsState; 157: SettingsState |
| `packages/web-conversation/src/workbench/goal-panel.tsx` | 20: SettingsState; 23: SettingsState; 25: SettingsState; 30: status; 49: status |
| `packages/web-conversation/src/workbench/terminal-panel.tsx` | 302: SettingsState; 326: SettingsState; 375: status |
| `packages/web-conversation/src/workbench/terminal-view.tsx` | 29: SettingsState |
| `packages/web-ui/src/admin-dialogs.tsx` | 87: alert |
| `packages/web-ui/src/admin-list.tsx` | 261: SettingsState |
| `packages/web-ui/src/config-form.tsx` | 174: SettingsState; 180: SettingsState; 189: SettingsState; 358: SettingsState; 378: SettingsSaveBar; 391: SettingsState |
| `packages/web-ui/src/conversation/messages/attachment-image.tsx` | 131: status |
| `packages/web-ui/src/conversation/messages/message.tsx` | 120: status; 126: status |
| `packages/web-ui/src/conversation/messages/turn.tsx` | 273: alert |
| `packages/web-ui/src/conversation/messages/user-message.tsx` | 58: status; 200: status; 314: status |
| `packages/web-ui/src/conversation/turn-actions.tsx` | 345: status |
| `packages/web-ui/src/conversation/turn-nav.tsx` | 427: status |
| `packages/web-ui/src/diagnostics-dialog.tsx` | 157: SettingsState/alert |
| `packages/web-ui/src/first-run.tsx` | 116: status; 124: SettingsState; 155: SettingsState; 156: SettingsState; 201: status |
| `packages/web-ui/src/intelligent-ui/catalog.tsx` | 65: SettingsState/alert; 101: SettingsState/alert; 267: status; 401: SettingsState; 411: SettingsState |
| `packages/web-ui/src/intelligent-ui/chip.tsx` | 76: Toast |
| `packages/web-ui/src/intelligent-ui/custom.tsx` | 18: status |
| `packages/web-ui/src/intelligent-ui/presets.tsx` | 286: status |
| `packages/web-ui/src/intelligent-ui/question-card.tsx` | 208: alert; 212: alert |
| `packages/web-ui/src/intelligent-ui/render-boundary.tsx` | 16: SettingsState/alert |
| `packages/web-ui/src/intelligent-ui/surface.tsx` | 167: Toast; 221: SettingsState; 224: status; 416: status |
| `packages/web-ui/src/plugin-schema-fields.tsx` | 371: alert |
| `packages/web-ui/src/plugin-schema-json.tsx` | 63: alert |
| `packages/web-ui/src/plugin-schema-secret.tsx` | 81: dynamic role |
| `packages/web-ui/src/region-error-boundary.tsx` | 49: alert |
| `packages/web-ui/src/resource-detail.tsx` | 126: SettingsState; 213: SettingsSaveBar; 296: SettingsState |
| `packages/web-ui/src/resource-list.tsx` | 91: SettingsState; 98: SettingsState; 111: SettingsState; 413: SettingsState |
| `packages/web-ui/src/schema-settings.tsx` | 68: SettingsState; 71: SettingsState |
| `packages/web-ui/src/session-auxiliary-models.tsx` | 71: SettingsState; 86: SettingsState |
| `packages/web-ui/src/settings-account-dialog.tsx` | 79: alert; 142: alert |
| `packages/web-ui/src/settings-accounts.tsx` | 175: Toast; 196: SettingsState |
| `packages/web-ui/src/settings-computer-use.tsx` | 89: status |
| `packages/web-ui/src/settings-layout.tsx` | 264: dynamic role; 611: status; 700: status |
| `packages/web-ui/src/ui/banner.tsx` | 27: dynamic role |
| `packages/web-ui/src/ui/copy-button.tsx` | 62: status |
| `packages/web-ui/src/ui/field.tsx` | 86: dynamic role |
| `packages/web-ui/src/ui/loadable.tsx` | 26: status; 85: alert |
| `packages/web-ui/src/ui/notifications.tsx` | 33: alert |
| `packages/web-ui/src/ui/settings-controls.tsx` | 53: alert |
| `packages/web-ui/src/ui/table.tsx` | 89: status |
| `packages/web-ui/src/ui/tag.tsx` | 34: status |
| `packages/web-ui/src/ui/toast.tsx` | 19: status |
| `packages/web-units/src/composer-uploads.tsx` | 187: status |
| `packages/web-units/src/composer.tsx` | 303: status |
| `packages/web-units/src/composer/attachment-list.tsx` | 56: status |
| `packages/web-units/src/composer/child-controls.tsx` | 69: status; 108: SettingsState |
| `packages/web-units/src/composer/queue.tsx` | 244: alert |
| `packages/web-units/src/diagnostics-viewer.tsx` | 146: SettingsState |
| `packages/web-units/src/message-feedback/form.tsx` | 313: status |
| `packages/web-units/src/message-feedback/provenance.tsx` | 50: alert |
| `packages/web-units/src/reference-picker.tsx` | 372: status |
| `packages/web-units/src/run-status.tsx` | 106: status |
| `packages/web-units/src/settings-fixture.tsx` | 150: alert; 154: alert |
| `packages/web-units/src/settings.tsx` | 413: Toast |
| `packages/web-units/src/topbar-title.tsx` | 121: alert |
| `packages/web-units/src/topbar.tsx` | 137: status |
| `packages/web-units/src/trace-inspector.tsx` | 146: alert; 150: status |
| `packages/web-units/src/trace-provenance.tsx` | 187: alert; 231: status; 237: alert |
| `packages/web-units/src/trace-request.tsx` | 170: SettingsState; 171: SettingsState; 172: SettingsState; 266: status; 273: SettingsState |
| `packages/web-units/src/trace-review.tsx` | 109: dynamic role |
| `packages/web-units/src/trace-toolbar.tsx` | 148: status |
| `packages/web-units/src/trace.tsx` | 970: status |
| `packages/web-units/src/workspace-dialog.tsx` | 142: alert |
| `packages/web/src/app-dialogs.tsx` | 59: alert; 104: status; 162: status; 260: alert |
| `packages/web/src/app-notices.tsx` | 100: Notifications; 105: alert; 159: Banner; 195: status |
| `packages/web/src/client-modules/reconcile/navigation.tsx` | 56: status |
| `packages/web/src/intelligent-ui/artifact-file.tsx` | 402: status; 409: dynamic role; 433: alert; 449: status; 453: status |
| `packages/web/src/intelligent-ui/placements.tsx` | 77: SettingsState; 182: SettingsState |
| `packages/web/src/intelligent-ui/workbench-deliverables.tsx` | 145: SettingsState; 189: SettingsState |
| `packages/web/src/loop-picker.tsx` | 306: status |
| `packages/web/src/model-picker.tsx` | 294: status; 309: alert; 501: alert |
| `packages/web/src/navigation.tsx` | 187: alert |
| `packages/web/src/pages/plugins/market-tab.tsx` | 144: alert; 215: SettingsState |
| `packages/web/src/pages/plugins/plugins-tab.tsx` | 213: SettingsState; 226: Banner; 231: Banner; 241: Banner; 245: SettingsState; 247: SettingsState |
| `packages/web/src/pages/plugins/resources-tab.tsx` | 147: Banner; 166: status |
| `packages/web/src/pages/plugins/review-tab.tsx` | 106: SettingsState |
| `packages/web/src/pages/plugins/skill-folders.tsx` | 103: SettingsState/alert; 107: SettingsState |
| `packages/web/src/regions/profile-approvals.tsx` | 89: alert |
| `packages/web/src/session-actions.tsx` | 150: alert |
| `packages/web/src/session-runtime-dialog.tsx` | 132: status |
| `packages/web/src/session-runtime-sections.tsx` | 75: SettingsState; 77: SettingsState/alert; 94: SettingsState; 189: SettingsState; 191: SettingsState; 193: SettingsState |
| `packages/web/src/session-search.tsx` | 331: status |

## 附录 C. 原生控件、样式旁路与夹具例外

### C.1 所有扫描到的原生交互/表格声明

这是source中的声明，不是新增违规列表。`web-ui`内部native语义和其他包已批准native dialog壳属于兼容实现；现有component guard对其中仍需兼容的声明有精确baseline。测试/演示DSH输入故意不同，不按产品页改造。

| 文件 | 原生标签声明约数 | 判断 |
| --- | --- | --- |
| `examples/fde/finance-reconcile/client/reconciliation-diff.mjs` | table ×1 | opaque-origin自包含renderer；禁runtime import，原生table是安全合同允许 |
| `examples/packages/dsh-input-controls/broken/extensions/main/client/index.js` | button ×1, input ×1 | DSH兼容/版本夹具；保留测试意图 |
| `examples/packages/dsh-input-controls/v1/extensions/main/client/index.js` | button ×1, input ×1 | DSH兼容/版本夹具；保留测试意图 |
| `examples/packages/dsh-input-controls/v2/extensions/main/client/index.js` | button ×1, input ×1 | DSH兼容/版本夹具；保留测试意图 |
| `examples/packages/dsh-model-picker-a/v1/extensions/main/client/index.js` | button ×1 | DSH兼容/版本夹具；保留测试意图 |
| `examples/packages/dsh-model-picker-a/v2/extensions/main/client/index.js` | button ×1 | DSH兼容/版本夹具；保留测试意图 |
| `examples/packages/dsh-model-picker-b/v1/extensions/main/client/index.js` | button ×1 | DSH兼容/版本夹具；保留测试意图 |
| `examples/packages/dsh-model-picker-b/v2/extensions/main/client/index.js` | button ×1 | DSH兼容/版本夹具；保留测试意图 |
| `packages/web-admin/src/settings/security-status.tsx` | table ×1 | 语义table残留；不为统一而移除表头/可访问关系 |
| `packages/web-admin/src/settings/session-tools.tsx` | table ×2 | 语义table残留；不为统一而移除表头/可访问关系 |
| `packages/web-ui/src/admin-detail.tsx` | dialog ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/admin-dialogs.tsx` | dialog ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/conversation/markdown.tsx` | button ×1, table ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/intelligent-ui/form-fields.tsx` | input ×2 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/plugin-schema-fields.tsx` | input ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/select-picker.ts` | button ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/settings-account-dialog.tsx` | dialog ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/settings-control-templates.ts` | button ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/settings-layout.tsx` | input ×2, select ×1, textarea ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/ui/chart.tsx` | table ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/ui/disclosure.tsx` | button ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/ui/file-mention.tsx` | button ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/ui/push-stack.tsx` | button ×2 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/ui/search-bar.tsx` | input ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/ui/segmented.tsx` | input ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/ui/settings-controls.tsx` | button ×3, input ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/ui/settings-subpages.tsx` | button ×2 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/ui/sheet-handle.tsx` | button ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/ui/state-lights.tsx` | button ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-ui/src/ui/table.tsx` | table ×1 | 共享层实现；受控native语义/bridge，不是业务旁路 |
| `packages/web-units/src/settings-fixture.tsx` | dialog ×1 | native host兼容（fixture另标）；保留ID/top-layer/生命周期 |
| `packages/web-units/src/workspace-dialog.tsx` | dialog ×1 | native host兼容（fixture另标）；保留ID/top-layer/生命周期 |
| `packages/web/src/app-shell.tsx` | dialog ×7 | native host兼容（fixture另标）；保留ID/top-layer/生命周期 |
| `packages/web/src/diagnostics-dialog.tsx` | dialog ×1 | native host兼容（fixture另标）；保留ID/top-layer/生命周期 |
| `packages/web/src/pages/plugins/hosted-pages.tsx` | dialog ×1 | native host兼容（fixture另标）；保留ID/top-layer/生命周期 |
| `packages/web/src/session-actions.tsx` | dialog ×1 | native host兼容（fixture另标）；保留ID/top-layer/生命周期 |
| `packages/web/src/session-runtime-dialog.tsx` | dialog ×1 | native host兼容（fixture另标）；保留ID/top-layer/生命周期 |
| `packages/web/src/session-search.tsx` | dialog ×1 | native host兼容（fixture另标）；保留ID/top-layer/生命周期 |
| `packages/web/src/timeline-node-host.tsx` | button ×1 | 业务raw button残留；加载历史操作应消费Button |

### C.2 非palette/skin的颜色字面值扫描

以下是匹配hex/rgb/hsl的所有命中行，排除`01-tokens.css`与skins目录的合法定义。多处颜色可能在同一行；值见源码。三处mask是alpha几何，thumbnail是固定preview，不计普通业务裸色。fixture缺少dark语义由其用途决定处理方式。

| 文件 | 命中行 |
| --- | --- |
| `examples/packages/client-panel/v1/extensions/main/client/index.css` | 3, 6, 7 |
| `examples/packages/client-panel/v2/extensions/main/client/index.css` | 3, 6, 7 |
| `examples/packages/dsh-input-controls/broken/extensions/main/client/index.css` | 2 |
| `examples/packages/dsh-input-controls/v1/extensions/main/client/index.css` | 2 |
| `examples/packages/dsh-input-controls/v2/extensions/main/client/index.css` | 2 |
| `examples/packages/dsh-model-picker-a/broken/extensions/main/client/index.css` | 2, 5, 6 |
| `examples/packages/dsh-model-picker-a/v1/extensions/main/client/index.css` | 2, 5, 6 |
| `examples/packages/dsh-model-picker-a/v2/extensions/main/client/index.css` | 2, 5, 6 |
| `examples/packages/dsh-model-picker-b/broken/extensions/main/client/index.css` | 2, 5, 6 |
| `examples/packages/dsh-model-picker-b/v1/extensions/main/client/index.css` | 2, 5, 6 |
| `examples/packages/dsh-model-picker-b/v2/extensions/main/client/index.css` | 2, 5, 6 |
| `examples/packages/dsh-tool-view/broken/extensions/main/client/index.css` | 5, 8, 9 |
| `examples/packages/dsh-tool-view/v1/extensions/main/client/index.css` | 5, 8, 9 |
| `examples/packages/dsh-tool-view/v2/extensions/main/client/index.css` | 5, 8, 9 |
| `packages/web-ui/src/intelligent-ui/styles.css` | 934 |
| `packages/web-ui/src/settings-layout.tsx` | 538, 539 |
| `packages/web/public/styles/13-turn-process.css` | 553, 554 |

### C.3 自定义交互/模式的owner（不是另行批准的组件集合）

| 模式 | 实现文件与范围 | 需消费的shared规格 |
| --- | --- | --- |
| model picker/listbox与思考强度radio | `packages/web/src/model-picker.tsx`、`packages/web/src/model-picker/{state,types}.ts` | Select视觉/键盘共用，模型与预算仍由caller负责 |
| permission picker/listbox | `packages/web-admin/src/permission-picker.tsx` | Select/Popover、busy/拒绝/新会话行动 |
| reference picker/listbox | `packages/web-units/src/reference-picker.tsx` | Select/Popover视觉、空态、keyboard；不能丢scope与文件/会话引用语义 |
| session search | `packages/web/src/session-search.tsx` | Input/SearchBar、Select-style listbox、Dialog、读取状态 |
| DOM select bridge | `packages/web-ui/src/select-picker.ts`、`packages/web-admin/src/provider-picker.ts`、`web-ui/src/auxiliary-model-fields.tsx` | 统一Select表面；保留native event/options/disabled/form和destroy |
| page tab/nav | `packages/web-units/src/settings-shell.tsx`、`packages/web-admin/src/settings/hub.tsx`、`packages/web/src/regions/session-views.tsx` | PageHeader/Tabs状态，不把route导航当普通状态切换 |
| dock/terminal tabs | `packages/web/src/workbench/dock.tsx`、`packages/web-conversation/src/workbench/terminal-tabs.tsx` | Tabs/Menu规格、overflow和焦点；保留独立terminal session身份 |
| trace/diagnostics tabs | `packages/web-units/src/{trace-inspector,diagnostics-viewer}.tsx` | Tabs + Loadable；保留trace selection与长内容滚动 |
| settings appearance/preset choices | `packages/web-units/src/settings-panes.tsx`、`packages/web-admin/src/settings/permission-defaults.tsx`、`admin/plugins/session-defaults-panel.tsx` | Segmented/preview tile/checkable多选，不能合并语义 |
| plugin/resource/account rows | `packages/web-ui/src/{admin-list,resource-list,settings-accounts,mcp-connection-row}.tsx` | ListRow固定header/body、Menu、Switch、Status |
| 消息/工具/审批/goal卡 | `packages/web-ui/src/conversation`、`packages/web-units/src/approval.tsx`、`packages/web-conversation/src/{goal-card,computer-use-pane}.tsx` | 领域组合保留；Button/Status/Feedback/Disclosure共用 |
| FDE工具视图 | `examples/fde/meeting-actions/client/index.js`、`examples/fde/support-triage/client/index.js`、`examples/community/tool-panel/client/index.js` | 公共组件出口、locale与领域状态外壳，不复制内部实现 |

## 附录 D. 复核与再现方法

只对受版本管理的源码扫描，不读任何运行环境文件。计数可用以下无依赖脚本重现；扫描器需把`components`替换为附录A关注的公开组件名集合。近似调用点不能代替manual追踪。

```python
from pathlib import Path
import re, subprocess, collections
tracked = subprocess.check_output(['git', 'ls-files'], text=True).splitlines()
packages = ['web', 'web-ui', 'web-units', 'web-admin', 'web-foundation',
            'web-client', 'web-conversation', 'resource-control-web']
files = [p for p in tracked if
    (any(p.startswith('packages/' + k + '/src/') for k in packages)
     or (p.startswith('packages/web/public/') and p.endswith(('.html', '.css')))
     or (p.startswith('examples/') and ('/client/' in p or '/skins/' in p)))
    and re.search(r'\.(tsx?|jsx?|mjs|html|css)$', p)]
components = ['Toast', 'SettingsSaveBar', 'SettingsState', 'Button', 'Select', 'Segmented']
for name in components:
    counts = {}
    for path in files:
        if path.endswith('.css'): continue
        source = Path(path).read_text()
        n = len(re.findall(r'<' + name + r'(?=[\s/><])', source))
        n += len(re.findall(r'\bcreateElement\(\s*' + name + r'\s*[,)]', source))
        if n: counts[path] = n
    print(name, sum(counts.values()), len(counts), counts)
```

现有静态规则直接复核方法：Node24以原生TS导入`tools/guards/src/web-component-boundary.ts`与`ui-presentation.ts`，按对应`.test.ts`列出的scope遍历tracked源码；将`webComponentViolations`的文件/rule计数与`tools/guards/web-component-allowlist.json.offenders`做deepEqual，将`newPresentationViolations(presentationCounts(source), baseline.files[path] ?? {})`合并断言为空。此次得到609/443个文件与24个allowlist文件/24个presentation ceiling。此独立扫描没有运行vitest的反例单测、其他guard、未跟踪文件或浏览器，不可以简称“guards全绿”。临时扫描脚本/原始输出放仓库外，没有加入产品提交。
