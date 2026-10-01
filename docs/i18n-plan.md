# Agnes Harness 国际化方案

范围：运行时用户可见文案。先做英文和简体中文。未选择语言时使用英文，可以切换。

本文包含方案本身，以及多人同时推进时的分工和同步方式。文档站 `docs/` 已有成对的中英文页面，不进这套运行时机制。

## 1. 目标

- 用户打开 Web 或 TUI 时，默认看到英文。
- 可以切换到简体中文。Web 记在本机浏览器，CLI 认 `AGNES_LOCALE`。
- 固定界面文案和已知错误码随语言变化。
- 模型提示词、用户自己的内容、仓库文档保持原样。

## 2. 现状

文档页已经按英文和简体中文成对维护。运行时有两套半成品，默认语言与本方案相反。

Web 的 `LocaleService`（`packages/web-client/src/services.ts`）能注册字典、切换 locale、通知界面重绘。生产代码没有注册过字典，也没有语言开关。`t()` 只按 key 查字符串，不看当前语言。启动时用页面的 `lang`；`packages/web/public/index.html` 是 `zh-CN`，缺省也回落到 `zh-CN`（`packages/web/src/client-modules/boot.ts`）。

CLI 的 `packages/cli-tui/src/locale.ts` 已有 `en` / `zh-CN` 和 `{name}` 插值，大约 18 个 key，覆盖审批、状态条和断线提示。`AGNES_LOCALE` 优先；否则 `LANG` 以 `zh` 开头就用中文。欢迎语、斜杠命令、工具卡片、用量面板仍是写死的中文。命令行帮助和报错几乎全是英文。

预设里的 `preset.locale` 会注入钩子环境变量 `AGNES_LOCALE`，默认 `en`。这是部署预设，和界面语言分开。第一期不跟着界面切换。

Web 生产源码里大约有一千条写死的简体中文用户文案。集中在设置页整段 HTML、轨迹面板、插件确认框、会话编排和 Computer Use 状态。现有测试大量断言这些中文，迁移时要一起改。

## 3. 做什么，不做什么

| 范围 | 判断 | 原因 |
| --- | --- | --- |
| Web 固定文案：导航、会话、输入框、空状态、设置、插件、技能、MCP、诊断、Computer Use、按钮、占位符、`aria-label` | 做 | 用户直接看到 |
| `packages/web/public/index.html` 里的静态壳 | 做 | 首屏文案在 JS 之外，`lang` 也在这里 |
| CLI / TUI 界面文案、斜杠命令说明、引导、工作区选择 | 做 | 和 Web 同一批用户 |
| 命令行 `--help`、`doctor`、用法错误 | 做，放在 TUI 之后 | 今天已经是英文，符合默认英文；补中文 |
| 用户能看到的失败说明 | 做，放在最后 | 用稳定错误码在客户端翻译 |
| 产品专名：Agnes Harness、Computer Use、MCP、Provider、API Key、Token | 两种语言都保留英文 | 和界面语言无关 |
| 协议码、工具名、包名、路径、哈希、日志、堆栈 | 不翻译 | 是契约和诊断材料 |
| 模型系统提示词和内置工具 `description` | 第一期不翻译 | 见第 4 节 |
| 用户消息、Skill 正文、插件自己的 `publicConfig` 文案 | 不在本期 | 作者内容；插件以后可以用现有的 `locale.register` |
| `docs/` 成对 Markdown | 不进这套机制 | 已经按页面维护双语 |

## 4. 提示词

`packages/code/prompts/` 下的 persona、环境、编码准则，以及 `read` / `write` / `edit` / `shell` 等工具说明，都是给模型的英文指令。`packages/code/test/prompts.test.ts` 要求这些 Markdown 不含中日韩字符。把它们译成中文会改变模型行为，和界面换语言不是一件事。

第一期保持英文。若以后希望界面切到中文时模型也用中文回答，只在运行时追加一句回复语言说明，不动现有提示词正文。

技能安装审批里现在有直接写给操作者的中文摘要。那是界面文案，归到错误与审批展示，不归到提示词。

## 5. 语言规则

只支持 `en` 和 `zh-CN`。未知值回落英文。

未保存过选择时用英文。

- Web：选择写入本机 `localStorage`，和主题同一类偏好。切换后立刻改 `document.documentElement.lang` 并重绘。入口放在设置里的「通用」，和配色、字号放在一起。
- CLI：继续认 `AGNES_LOCALE=en|zh-CN`，并在 TUI 里提供切换。未设置时用英文，不再根据 `LANG` 自动选中文。

`preset.locale` 继续只服务钩子环境。

## 6. 技术约定

沿用现有包边界，不新建总包。

- Web 修正 `LocaleService`：字典按 locale 存放。`t(key, vars)` 先查当前语言，没有再查英文，再没有就显示 key。现在没有生产代码调用 `register`，改签名的兼容成本低。
- `web`、`web-ui`、`web-units`、`resource-control-web` 各自带目录。
- CLI 继续扩展 `cli-tui` 的字典。
- 审批按钮这类少量重复文案，两处各写一份。

Key 用语义名，例如 `composer.send`、`settings.appearance.theme.dark`。插值沿用 `{name}`。中文不需要复数规则；英文计数也先放进句子，不引入 ICU。

目录按命名空间拆开，例如 `shell`、`settings`、`admin`、`diagnostics`、`cli`。不要往同一个字典文件里加 key。

渲染时取词。现在很多文案是模块加载时就写死的常量，例如会话状态对照表和设置页那一整段 HTML。语言切换后它们不会更新。静态节点用 `data-i18n`，在启动和切换时回填。`packages/web-units/src/settings.ts` 和 `index.html` 适合这种方式。

费用和数字走 `Intl.NumberFormat`，随当前 locale 格式化。`packages/web-ui/src/conversation/cost-format.ts` 里的中文单位一起换掉。

术语表（后续译文都照此）：

| 英文 | 简体中文 |
| --- | --- |
| session | 会话 |
| workspace | 工作区 |
| approval | 审批 |
| plugin | 插件 |
| skill | 技能 |
| archive | 归档 |
| account | 账户 |
| trace | 轨迹 |
| diagnostics | 诊断 |

Provider、MCP、API Key、Token、Computer Use、Agnes Harness 两种语言都保留英文。

## 7. 实施顺序

### 7.1 语言底座

修正 `LocaleService`，加上英文缺省、持久化和通用设置里的切换。内置目录先只放切换控件自己的文案，用来验证切换、回落和 `lang`。

底座保持很小，不改这些热点文件：

- `packages/web-units/src/settings.ts`
- `packages/web/src/app.ts`

语言开关的界面由设置页负责人加。底座只提供 `setLocale` 和持久化。

### 7.2 Web 固定壳

侧栏、顶栏、输入框、空状态、会话菜单、消息和工具状态、审批按钮。

静态 `index.html` 默认写成英文，启动前读取 `localStorage` 再回填，避免已选中文的用户先看到英文。

代表文件：

- `packages/web/src/app.ts`
- `packages/web-ui/src/conversation/messages.tsx`
- `packages/web-units/src/composer.ts`
- `packages/web-units/src/sidebar.ts`
- `packages/web-units/src/topbar.ts`
- `packages/web/src/view.ts`
- `packages/web/public/index.html`

### 7.3 设置、管理和诊断

设置模板、`admin-text.ts`、插件确认、资源管理、Computer Use、轨迹面板。这是文案量最大的一段。`packages/web-ui/src/admin-text.ts` 已经是集中的状态标签层，适合先改成按 key 取词。

### 7.4 CLI / TUI，然后是命令行帮助

把欢迎语、斜杠命令、工具卡片、用量、主题选择收进现有字典，默认改为英文。随后补 `usage()`、引导、`doctor`，以及 `packages/cli/launch/workspace-picker.ts` 里目前只有中文的工作区选择框。

把 CLI 解析出的 locale 传给 SDK，让 `packages/sdk/src/text.ts` 里已有的两句安全文案跟界面一致。

### 7.5 用户可见的失败说明

协议继续只传稳定 code，例如 `CONFIG_AUTH_FAILED`、`E_PACKAGE_TRUST`。客户端用 code 查目录。服务端的 `safeMessage` 保持英文，只在客户端没有这条 code 时作兜底。

Web 里已有的 `CONFIGURATION_REASON_MESSAGES` 就是这个模式，把它从写死中文改成目录。

现在直接拼 `error.message` 的位置改成：本地化主句，原始信息留在诊断详情。包括 `packages/web/src/app.ts`、OAuth 提示、轨迹详情和资源列表。

daemon 里仍直接写中文的安装摘要和校验说明，改成 code 加英文 `safeMessage`，由界面翻译。日志、密钥脱敏后的内部句子、堆栈不进目录。

## 8. 多人协作

先合入一份语言底座，然后按文件所有权并行。主分支允许短暂中英混杂。每个界面一旦开工，就必须整页换完。

### 8.1 底座先合并

第一天只派一个人做底座，合进主干后其他人再开分支。这一份改动不碰大文件，见 7.1。

底座里同时放上：

- locale 类型、查词、回落、持久化
- key 命名和 `{name}` 插值
- 各包目录的命名空间约定
- key 双语必须成对的检查
- 第 6 节的术语表

### 8.2 按文件分人

底座合入后，下面几条线同时开。每人只改自己的源文件、对应测试和自己的目录文件。

| 负责人 | 包住的界面 | 主要文件 | 依赖 |
| --- | --- | --- | --- |
| Web 壳 | 侧栏、顶栏、输入框、空状态、会话菜单、消息和工具状态、审批 | `app.ts`、`index.html` 的壳文案、`sidebar.ts`、`topbar.ts`、`composer.ts`、`messages.tsx`、`view.ts` | 底座 |
| 设置与通用 | 设置整页、账户、外观、语言开关 | `packages/web-units/src/settings.ts`、`packages/web/src/settings.ts`、`appearance.ts`、账户相关组件 | 底座 |
| 管理与资源 | 插件确认、安装、技能、MCP | `admin-text.ts`、`admin-confirmation.tsx`、`packages/web/src/admin/plugins/admin.tsx`、`resource-list.tsx`、`resource-detail.tsx`、`packages/resource-control-web/src` | 底座 |
| 诊断与 Computer Use | 轨迹、诊断导出、Computer Use 状态 | `packages/web-units/src/trace.ts`、`diagnostics-viewer.ts`、`diagnostics-dialog.tsx`、`computer-use-state.ts` | 底座 |
| CLI | TUI 剩余文案、帮助、引导、工作区选择 | `packages/cli-tui/src`、`packages/cli/src`、`packages/cli/launch/workspace-picker.ts` | 底座；和 Web 无文件交集 |
| 错误码收口 | 服务端仍写给用户看的中文句子 | daemon、host 里直接展示的摘要；改成稳定 code + 英文 `safeMessage` | 界面侧已按 code 查词；code 字符串可以先并行整理 |

`app.ts`、`settings.ts`、`trace.ts`、`admin.tsx` 都是单文件热点，各只给一个人。

每个界面上已经出现的错误码，由该界面负责人翻译。例如设置页的 `CONFIGURATION_REASON_MESSAGES`。错误码负责人只改服务端句子和 code，不改 Web 文案。

人少时合并线条：

- 两个人：一人做底座、Web 壳和设置；另一人等底座合入后做 CLI。管理和诊断由先空出来的人接。
- 三个人：管理和诊断并成一条 Web 线，CLI 单独一条。

### 8.3 每条线的完成标准

- 这个界面上的固定文案都走 `t()` 或 `data-i18n`。同一屏幕不留一半写死中文。
- 每个新 key 同时有英文和简体中文。
- 渲染时取词，不在模块加载时把译文写进常量。
- 对应测试改为断言目录结果，或断言默认英文。
- 不改模型提示词，不改协议 schema，不改 `preset.locale`。

合入顺序只有一个硬门槛：底座先合并。之后各线互不阻塞。最后留一个短收尾：确认默认仍是英文、切换两边都完整、清单上没有未迁完的用户可见文案。

主干在收尾前会中英混在一起：已迁移的屏幕随语言切换，还没迁移的屏幕仍是原来的中文。用一张清单登记文件归属和是否迁完。

### 8.4 建议清单

| 线条 | 负责人 | 状态 |
| --- | --- | --- |
| 语言底座 |  | 未开始 |
| Web 壳 | zzl | 进行中 |
| 设置与通用 | zzl | 进行中 |
| 管理与资源 | swx | 进行中（2026-10-01） |
| 诊断与 Computer Use |  | 未开始 |
| CLI | zzl | 进行中 |
| 错误码收口 |  | 未开始 |
| 收尾核对 |  | 未开始 |

## 9. 测试与兼容

- 每个目录保证 `en` 和 `zh-CN` 的 key 一致。
- 缺 key 时回落英文。
- 切换语言后，抽查一个标签和 `documentElement.lang`。
- 现有断言中文文案的测试，随对应界面改成断言目录结果或默认英文。
- 协议 schema 不变。
- 预设语义不变。

## 10. 做完后的结果

用户打开 Web 或 TUI 看到英文。在通用设置或 `AGNES_LOCALE` 切到简体中文后，固定界面和已知错误码跟着变。模型提示词、用户内容和文档保持原样。

## 11. 分工线条与步骤（署名清单）

本节把 §7 的实施顺序拆到 §8.2 的线条上，作为可署名的执行清单。规模数字是源码（不含测试）中含中文字符的行匹配数，仅供分人参考，实际以逐文件迁移时盘点为准。

认领与署名惯例：

1. 认领一条线：在 11.1 总览表填上负责人、分支名和日期，状态改「进行中」，并同步 §8.4 总清单。
2. 完成一个步骤：在该步骤行的「完成于 / 署名」列填日期和名字。
3. 一条线（含热点单文件）只归一人；开工先署名，避免撞线。
4. 标「建议并入」的文件是 §8.2 未点名、按界面就近归线的，认领时在 PR 描述注明即可。

### 11.1 线条总览

| 线条 | 规模（约） | 负责人 | 分支 | 状态 |
| --- | --- | --- | --- | --- |
| 语言底座 | 17 文件 / +509 行 | | feat/i18n | 第一版已落地（c3fbcb1f），待评审合主干 |
| Web 壳 | 约 600 处 | zzl | feat/i18n | 进行中（2026-10-01） |
| 设置与通用 | 约 290 处 | zzl | feat/i18n | 进行中（2026-10-01） |
| 管理与资源 | 约 540 处 | swx | feat/i18n | 进行中（2026-10-01） |
| 诊断与 Computer Use | 约 280 处 | | | 未开始 |
| CLI | 字典 18 key 已有，余待迁 | zzl | feat/i18n | 进行中（2026-10-01） |
| 错误码收口 | 盘点后定 | | | 未开始 |
| 收尾核对 | — | | | 未开始 |

### 11.2 Web 壳

建议并入：会话菜单/会话操作/导航，timeline / turns / presentation / usage 工具状态与工具卡（§8.2「消息和工具状态」的就近归属）。

| 步骤 | 内容 | 主要文件（约处数） | 完成于 / 署名 |
| --- | --- | --- | --- |
| W1 | 输入框与空状态 | `web-units/src/composer.ts`（12） | |
| W2 | 侧栏与顶栏 | `sidebar.ts`（16）、`topbar.ts`（9） | |
| W3 | 会话菜单、会话操作、导航 | `session-menu.ts`（21）、`session-actions.ts`（18）、`navigation.ts`（21） | |
| W4 | 消息与工具状态 | `messages.tsx`（47）、`timeline.ts`（55）、`turns.ts`（21）、`presentation.ts`（24）、`usage.ts`（1）、`web-units/src/conversation/tool-card.ts`（7）、`conversation.ts`（2）、`conversation-message-adapter.tsx`（1）、`timeline-node-host.tsx`（1）、`document-preview.ts`（4）、`web-ui/src/conversation/`：`turn-actions.tsx`（22）、`cost-format.ts`（27）、`usage.tsx`（10）、`markdown.tsx`（3）、`document-preview.tsx`（3）、`cost.tsx`（1）、`runtime.ts`（3） | |
| W5 | app.ts 热点（单文件，留到最后） | `app.ts`（120） | |
| W6 | index.html 静态壳 | `index.html`（64），默认英文 + localStorage 回填 + `data-i18n` | |
| W7 | 运行时状态与 slot 壳 | client-modules：`reconcile.ts`（26）、`runtime-status.ts`（10）、`hot-reload.ts`（1）、`timeline-slot.ts`（11）；`region-slots.ts`（7）、`shell.ts`（5）、`view.ts`（24）、`web-ui/src/confirm.ts`（1）、`web-client/src/externals.ts`（3）、`outlet.tsx`（2） | |

### 11.3 设置与通用

建议并入：四个 picker、oauth-controls、skin、theme/theme-boot、tool-icon、session-title、设置页 Computer Use 段。

| 步骤 | 内容 | 主要文件（约处数） | 完成于 / 署名 |
| --- | --- | --- | --- |
| S1 | 通用段模板（`data-i18n` 为主） | `web-units/src/settings.ts`（12） | |
| S2 | 设置主体与账户 | `web/src/settings.ts`（65）、`appearance.ts`（25）、`web-ui/src/settings-accounts.tsx`（8）、`settings-account-dialog.tsx`（15） | |
| S3 | 设置外围控件 | model/permission/provider/workspace-picker（16）、`web-ui/src/select-picker.ts`（1）、`oauth-controls.ts`（14）、`skin.ts`（60）、`theme.ts`（22）、`theme-boot.ts`（20）、`tool-icon.ts`（7）、`session-title.ts`（1）、`settings-model-pane.tsx`（8）、`settings-computer-use.tsx`（13） | |

### 11.4 管理与资源

| 步骤 | 内容 | 主要文件（约处数） | 完成于 / 署名 |
| --- | --- | --- | --- |
| A1 | 集中标签层先行 | `web-ui/src/admin-text.ts`（56）、`ui/state-lights.tsx`（11） | 认领整条管理与资源线：swx（2026-10-01） |
| A2 | 确认与对话框 | `admin-confirmation.tsx`（95）、`admin-dialogs.tsx`（13）、`admin-list.tsx`（27）、`admin-detail.tsx`（9） | |
| A3 | 插件管理 | `web/src/admin/plugins/admin.tsx`（106）、`source-form.ts`（4） | |
| A4 | 资源双站 | `resource-list.tsx`（37）、`resource-detail.tsx`（27）、`resource-control-web/src/admin.tsx`（75）、`skill-copy.ts`（7） | |
| A5 | 静态壳 | `admin.html`（41）、`resources.html`（30），复用 W6 的回填机制 | |

### 11.5 诊断与 Computer Use

| 步骤 | 内容 | 主要文件（约处数） | 完成于 / 署名 |
| --- | --- | --- | --- |
| D1 | Computer Use 状态 | `computer-use-state.ts`（106） | |
| D2 | 轨迹面板（单文件热点） | `web-units/src/trace.ts`（127） | |
| D3 | 诊断导出 | `diagnostics-viewer.ts`（23）、`web-ui/src/diagnostics-dialog.tsx`（14）、`web/src/diagnostics-dialog.ts`（7）、`diagnostics-bundle.ts`（4） | |

### 11.6 CLI

| 步骤 | 内容 | 主要文件 | 完成于 / 署名 |
| --- | --- | --- | --- |
| C1 | TUI 剩余文案收进字典、默认改英文 | `packages/cli-tui/src`（欢迎语/斜杠命令/工具卡片/用量/主题） | |
| C2 | 帮助与引导补中文 | `usage()`、`doctor`、引导、`packages/cli/launch/workspace-picker.ts` | |
| C3 | locale 传 SDK | `packages/sdk/src/text.ts`（2 句） | |

### 11.7 错误码收口

| 步骤 | 内容 | 范围 | 完成于 / 署名 |
| --- | --- | --- | --- |
| E1 | 盘点 daemon / host 直写中文的句子，列清单 | daemon（config / admin-surface / session-preferences / supervisor 三件 / worker-link）、host（codex-login / skill-install / skill-preload）、worker-runtime（commands / mcp-row-runtime / mcp-server-rows）、resource-control-{store,runtime,worker,cli} 各 1–2 件 | |
| E2 | 服务端改稳定 code + 英文 `safeMessage` | E1 清单 | |
| E3 | 客户端按 code 查词，推广 `CONFIGURATION_REASON_MESSAGES` 模式 | app.ts / OAuth 提示 / 轨迹详情 / 资源列表 | |

### 11.8 收尾核对

| 步骤 | 内容 | 完成于 / 署名 |
| --- | --- | --- |
| F1 | 双端默认英文确认 | |
| F2 | §8.4 清单全部「已完成」，无残留用户可见中文 | |
| F3 | key 双语成对检查进 CI，术语表抽查 | |

### 11.9 范围待裁定（差集扫描发现）

| 事项 | 内容 | 建议 |
| --- | --- | --- |
| channels（钉钉卡片） | `channels/src/adapters/dingtalk/cards.ts` 等审批按钮「同意/拒绝」、摘要文案，终端用户可见 | **本期暂缓**（2026-10-01 裁定）：用户群与 Web/CLI 不完全重叠、量小且为服务端渲染；日后按 §7.5 的稳定 code + 目录模式单独处理，notice 系列语义与 cli-tui 字典同源，届时可复用 key |
| 后端零星 | package-manager（client-assets / lockfile）、sandbox-remote、core、ai、base/extensions 零星源码中文 | 多为日志与内部说明，E1 盘点时一并甄别 |
| extension-api | src 四文件，抽查为代码注释 | 预计全豁免，E1 核实 |
| cli/tools/build-local.ts | 构建脚本 | 豁免 |
| web/public/style.css、web-ui tokens.css、REGISTRY.md | 已核实为注释/文档 | 豁免 |
| web-admin-frame | C 线删除计划内 | 有意排除，随删除消失 |

### 11.10 覆盖检查（怎么发现遗漏）

三层，逐层兜底：

1. **分线期差集扫描**：全量列出含中文的源码文件，与 §11 分配表做差集，差出来的就是遗漏：

   ```bash
   rg -l '[\x{4e00}-\x{9fff}]' packages -g '!node_modules' -g '!dist' -g '!**/test/**' -g '!*.test.*' -g '!**/fixtures/**' -g '*.{ts,tsx,html,css}'
   ```

   清单里每个文件必须在 §11.2–11.7 某一步、§11.9 某一行，或属注释/测试豁免——三none即漏。
2. **执行期 ratchet**：开工前记录中文匹配总数作基线，此后每个线 PR 合入前重跑计数，只许降不许涨（防一边迁一边新增硬编码）：

   ```bash
   rg -o '[\x{4e00}-\x{9fff}]' packages -g '!node_modules' -g '!dist' -g '!**/test/**' -g '!*.test.*' -g '!**/fixtures/**' -g '*.{ts,tsx,html}' | wc -l
   ```

3. **收尾期清零门**：F2 时白名单（注释文件、测试、协议码、提示词、channels 暂缓件）之外源码中文残留应为 0；配合 §9 的 key 双语成对检查进 CI，构成最终门。
