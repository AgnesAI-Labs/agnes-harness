# Agnes Harness 国际化方案

范围：运行时用户可见文案。先做英文和简体中文。未选择语言时使用英文，可以切换。

文档站 `docs/` 已有成对的中英文页面，不进这套运行时机制。

协作只有一条分支：`feat/i18n`。所有人在这条分支上提交。不开个人分支，也不要先把底座合进 `main` 再分叉。

## 1. 目标

- 用户打开 Web 时默认看到英文。语言记在本机浏览器，可在设置的「通用」里切到简体中文。
- 用户打开 CLI / TUI 时默认看到英文。语言只认 `AGNES_LOCALE=en|zh-CN`。未设置时用英文，不再根据 `LANG` 选中文。
- Web 和 CLI 各自保存语言。在网页里切换不会改变终端，设置 `AGNES_LOCALE` 也不会改变网页。
- 固定界面文案和已知错误码随各自入口的语言变化。
- 模型提示词、用户自己的内容、仓库文档、钩子环境里的 `preset.locale` 保持原样。

## 2. 已经落地的底座

`feat/i18n` 上的 `c3fbcb1` 已经完成语言底座，负责人是 yuan。不要重做，也不要把它恢复成「未开始」。

已经生效的行为：

- `LocaleService.register(namespace, catalog)` 接收 `{ en, 'zh-CN' }`。`t(key, vars)` 先查当前语言，没有再查英文，再没有就显示 key。插值是 `{name}`。未知 locale 回落 `en`。
- 这是对外签名变化。旧的扁平字典 `register(namespace, { key: text })` 不再可用。
- Web 未保存选择时用英文。选择写入 `localStorage` 的 `agnes-locale`。切换时设置 `document.documentElement.lang`，并派发 `agnes:locale-changed`。
- `packages/web/public/index.html`、`admin.html`、`resources.html` 的 `<html lang>` 已是 `en`。`theme-boot.ts` 在首屏前按 `agnes-locale` 改 `lang`。它还不回填文案。
- 设置「通用」里已有语言开关。文案在 `packages/web/src/locale-catalog.ts`，命名空间 `@agnes/web`。只有开关自己的句子会随语言变化。
- 其余界面仍是原来的中文。这是并行迁移期间的正常状态。

底座文件后续只修缺陷，或按第 6 节追加 `register` 行：

- `packages/web-client/src/services.ts`
- `packages/web/src/locale-preference.ts`
- `packages/web/src/locale-catalog.ts`（只留给已有的语言开关 key）
- `packages/web/src/client-modules/boot.ts`
- `packages/web/src/theme-boot.ts`（W6 会加首屏回填，见第 8 节）
- `packages/web/src/app.ts` 里已经接上的 locale 回调
- `packages/web/src/appearance.ts` 里已经接上的语言单选

## 3. 做什么，不做什么

| 范围 | 判断 | 原因 |
| --- | --- | --- |
| Web 固定文案：导航、会话、输入框、空状态、设置、插件、技能、MCP、诊断、Computer Use、按钮、占位符、`aria-label` | 做 | 用户直接看到 |
| `index.html`、`admin.html`、`resources.html` 的静态壳 | 做 | 首屏文案在 JS 之外 |
| `packages/web-server/src/server.ts` 里两句管理页不可用提示 | 做 | 用户直接看到 |
| CLI / TUI 界面、斜杠命令、引导、工作区选择、`resource-control-cli` 里给用户看的句子 | 做 | 和 Web 同一批用户 |
| 命令行 `--help`、`doctor`、用法错误 | 做，放在 TUI 文案之后 | 今天已经是英文；补中文 |
| 用户能看到的失败说明 | 做 | 客户端用稳定错误码翻译 |
| 产品专名：Agnes Harness、Computer Use、MCP、Provider、API Key、Token | 两种语言都保留英文 | 和界面语言无关 |
| 协议码、工具名、包名、路径、哈希、日志、堆栈、源码注释 | 不翻译 | 契约、诊断或给开发者看的说明 |
| 模型系统提示词和内置工具 `description` | 第一期不翻译 | 见第 4 节 |
| 用户消息、Skill 正文、插件 `publicConfig`、`examples/` 里的示例文案 | 不在本期 | 作者内容。插件以后用第 6 节的 `register` |
| `docs/` 成对 Markdown | 不进这套机制 | 已经按页面维护双语 |
| `packages/channels/` 发给人的卡片、审批和命令回复 | 本期暂缓 | 见第 10 节 |

## 4. 提示词

`packages/code/prompts/` 下的 persona、环境、编码准则，以及 `read` / `write` / `edit` / `shell` 等工具说明，都是给模型的英文指令。`packages/code/test/prompts.test.ts` 要求这些 Markdown 不含中日韩字符。把它们译成中文会改变模型行为。

第一期保持英文。若以后希望界面切到中文时模型也用中文回答，只在运行时追加一句回复语言说明，不动现有提示词正文。

技能安装审批里写给操作者的中文摘要是界面文案，归错误与审批展示，不归提示词。

## 5. 语言规则

只支持 `en` 和 `zh-CN`。未知值回落英文。未保存过选择时用英文。

三套 locale 各管各的：

| 名字 | 谁在读 | 存在哪里 | 本期行为 |
| --- | --- | --- | --- |
| Web 界面语言 | 浏览器 | `localStorage` 的 `agnes-locale` | 未设置则英文。开关在设置「通用」 |
| CLI 界面语言 | TUI 和命令行 | 进程环境变量 `AGNES_LOCALE` | 只接受 `en` 和 `zh-CN`。未设置则英文。C1 必须去掉「`LANG` 以 `zh` 开头就用中文」 |
| 钩子 locale | 钩子子进程 | `preset.locale` 注入的 `AGNES_LOCALE`，默认 `en` | 不跟着 Web 或 CLI 的界面语言走。不改预设语义 |

`preset.locale` 的 schema 还接受 `zh`、`fr` 这类界面不支持的值。那只影响钩子环境。界面遇到这些值仍然回落英文。

## 6. 技术约定

沿用现有包边界，不新建总包。Web 和 CLI 各写各的目录。审批按钮这类少量重复句子，两处各写一份。

### 6.1 目录

- Key 用语义名，例如 `composer.send`、`settings.appearance.theme.dark`。
- 每一条 key 在同一次提交里同时有 `en` 和 `zh-CN`，而且都不是空串。
- 插值沿用 `{name}`。缺变量时保留 `{name}`。中文不引入复数规则；英文计数写进句子，不引入 ICU。
- 各线使用自己的目录文件，不要往 `locale-catalog.ts` 里追加新 key。那个文件只保留语言开关。
- 新目录在 `packages/web/src/client-modules/boot.ts` 增加一行 `locale.register`。改这个文件之前先同步 `feat/i18n`，只加注册行。
- `web-ui`、`web-units`、`resource-control-web` 的目录放在各自包内，由 boot 注册。
- CLI 只扩展 `packages/cli-tui/src/locale.ts`。

同一 PR 里为新目录加上 key 成对测试：两种语言的 key 集合相同。不要留到收尾才补这道测试。

### 6.2 切换后必须重绘

模块加载时算出的字符串，切换语言后不会变。两种写法：

React 组件在渲染时取词，并订阅 locale，这样切换会触发渲染：

```ts
const locale = useSyncExternalStore(service.subscribe, service.getSnapshot)
const label = service.t('composer.send')
```

`useState` 的初值、文件顶层常量、事件回调里缓存的句子，都不算渲染时取词。

`getSnapshot()` 现在只返回语言字符串。从 `en` 切到 `zh-CN` 时订阅方会重绘。同一种语言下再次 `register`，快照不变，React 不会重绘。内置目录必须在首次渲染之前注册。插件运行中换目录不在本期；要做的话，快照里得带上目录版本，不能只订语言字符串。

静态 HTML 和 `dangerouslySetInnerHTML` 使用这些标记：

- `data-i18n`：元素的文本。只能标在没有子元素的节点上。标在含 SVG 的按钮上会把图标清掉。
- `data-i18n-aria`：`aria-label`。
- `data-i18n-placeholder`：`placeholder`。
- `data-i18n-title`：`title`。

后两个属性现有的 `applyLocaleText` 还没填，和语言开关的缺陷一起补。`applyLocaleText` 在两处调用：

- locale 变化时（已有 `agnes:locale-changed`）。
- 这段 HTML 每次被提交进文档之后。设置页会在重开或热替换时用模板盖掉已经回填的 DOM，所以拥有这段模板的组件要在提交后再次回填。

`theme-boot.ts` 是三个 HTML 页在绘制前都会执行的脚本。W6 把静态壳的回填放进这个文件，这样独立打开的 `admin.html` 和 `resources.html` 也会换语言。这个脚本不能引入 `@agnes/web-client` 的运行时代码，否则会把整份客户端打进阻塞式 `theme.js`。静态壳的目录保持为纯数据，跟现有的 `locale-catalog.ts` 一样只做类型导入。

费用、整数和小数用 `Intl.NumberFormat`，locale 用当前的 `en` 或 `zh-CN`。`packages/web-ui/src/conversation/cost-format.ts` 里的中文单位改成目录中的句子，数字本身交给 `Intl`。日期若出现给用户看的格式，用 `Intl.DateTimeFormat`，不另写一套中文单位。

### 6.3 术语

| 英文 | 简体中文 | 用法 |
| --- | --- | --- |
| session | 会话 | 持久化的 session，以及用户说的「这次对话」。现有界面里的「任务」如果指的就是这次 session，改为「会话」 |
| workspace | 工作区 | |
| approval | 审批 | |
| plugin | 插件 | |
| skill | 技能 | |
| archive | 归档 | |
| account | 账户 | |
| trace | 轨迹 | |
| diagnostics | 诊断 | |

Provider、MCP、API Key、Token、Computer Use、Agnes Harness 两种语言都保留英文。

### 6.4 底座里还要修的行为

这些是 `c3fbcb1` 已经接上、但切换时会错的路径。由语言底座的负责人改，不重新设计 `LocaleService`。

写入 `agnes-locale` 失败时，本次选择仍然生效。`writeLocalePreference` 吞掉异常之后，`agnes:locale-changed` 的处理函数又从 `localStorage` 读取。存储里还是旧值，新语言会被写回去。同页切换要用这次选中的值更新 `LocaleService` 和 `lang`。只有别的文档发出的 `storage` 事件才重新读存储。存储被清空时按未设置处理，回到英文。

`theme-boot.ts` 在主题、皮肤或系统主题重绘时也会读 `agnes-locale` 并设置 `lang`。这次写入若失败，随后改主题会把 `lang` 设回旧值。语言事件带上本次选择；主题重绘不要用一份更旧的存储值覆盖它。

`bind(namespace)` 在本目录没有 key 时会调用全局 `t()`。后注册的目录可以用同一个 key 盖住先注册的宿主句子。各线的 key 必须带自己的前缀，例如 `shell.`、`settings.`、`admin.`。不要用 `save`、`title` 这种裸 key。本期不改 `bind` 的查找顺序。

终端里的中文按现有 `displayWidth` 计两列。C1 的窄屏测试要覆盖中文句子、换行和 ANSI，不能只测英文。

## 7. 单分支协作

分支：`feat/i18n`。

1. 开工前在第 9 节写上负责人，并把该步状态改成「进行中」。没有署名的步骤，别人可以认领。
2. 一个步骤、一个文件，在同一时间只有一个认领人。做完把状态改成「已完成」，并写上提交。
3. 提交前先同步 `feat/i18n`。提交要小，只包含自己认领的文件。
4. 共享文件按第 8 节的锚点改。禁止整文件重排，禁止顺手改别人的 pane。
5. 底座文件按第 2 节冻结。发现缺陷时单独开一个小提交，并在第 9 节记一笔。
6. 界面里已经出现的错误码，由这个文件的认领人改成目录句子。错误码收口的人只改服务端的 code 和英文 `safeMessage`，不改 Web 文案文件。

人少时仍然在同一分支上缩小并行度：同一个人可以连续做 Web 壳和设置，但不要同时改第 8 节里划给别人的锚点。CLI 和 Web 没有共同的文案文件，可以和 Web 并行。

## 8. 文件所有权

`packages/web-units/src/settings.ts` 的 `SETTINGS_MARKUP` 里，每个设置页是单独一行。所有权按 section 锚点划分，不按「谁负责这个功能」整文件拿走。

| 锚点 | 认领 | 里面有什么 |
| --- | --- | --- |
| `#model-settings-pane` | 设置与通用 | 模型与账户页的标题、按钮、占位符 |
| `#archived-settings-pane` | 设置与通用 | 已归档会话页的标题和搜索框 |
| `#appearance-settings-pane` | 设置与通用 | 配色、皮肤、字号。语言开关已完成，不要重写那一组 `data-i18n` |
| `#plugin-settings-pane` | 管理与资源 | 插件页标题、恢复模式、安装和搜索 |
| `#resource-settings-pane` | 管理与资源 | 技能与 MCP 页的标题和工具条 |
| `#computer-use-settings-pane` | 诊断与 Computer Use（yuan） | Computer Use 页的标题、状态卡和按钮。其他人不要改这一行 |

只改自己的那一行。不要把整个模板重新换行或格式化。

其他容易抢的文件：

| 文件 | 谁改 | 其他人 |
| --- | --- | --- |
| `packages/web/src/app.ts` | Web 壳。包括这个文件里直接拼给用户的失败句 | 错误码收口不改它 |
| `packages/web/src/oauth-controls.ts` | 设置与通用。包括这里展示的失败句 | 错误码收口不改它 |
| `packages/web/src/theme-boot.ts` | Web 壳，在 W6 加入静态壳回填 | 设置线不改它。已有的 `lang` 逻辑保持 |
| `packages/web/src/client-modules/boot.ts` | 任何线都可以加一行 `register` | 不改存储、回落和事件 |
| `packages/web/public/index.html` | Web 壳 | |
| `packages/web/public/admin.html`、`resources.html` | 管理与资源 | `lang="en"` 已落地，只迁正文 |
| `packages/web-server/src/server.ts` | 管理与资源，只迁两句「后台暂时不可用」 | 注释不动 |
| `packages/web/src/computer-use-state.ts`、`settings-computer-use.tsx` | 诊断与 Computer Use（yuan） | 模板行见上表 |
| `packages/cli-tui/src/locale.ts` 和 `packages/cli/src` | CLI | |

`app.ts` 里的 locale 回调、`appearance.ts` 里的语言单选已经接好。Web 壳和设置线改这些文件时保留这段接线。

## 9. 实施清单

状态以这一节为准。规模不按「含中文的行数」估算：那种计数把注释算进去，又把设置页一整行里的几十句算成 1。认领人打开文件，只迁渲染给用户的字符串。

### 9.1 总览

| 线条 | 负责人 | 状态 |
| --- | --- | --- |
| 语言底座 | yuan | 已完成（2026-10-01，`c3fbcb1`）。第 6.4 节的缺陷未修 |
| Web 壳 | zzl | 进行中（2026-10-01） |
| 设置与通用 | zzl | 进行中（2026-10-01） |
| 管理与资源 | swx | 进行中（2026-10-01） |
| 诊断与 Computer Use | yuan | 已完成（2026-10-01） |
| CLI | zzl | 进行中（2026-10-01） |
| 错误码收口 | | 未开始 |
| 收尾核对 | | 未开始 |

### 9.2 Web 壳

| 步骤 | 内容 | 文件 | 状态 |
| --- | --- | --- | --- |
| W1 | 输入框与空状态 | `packages/web-units/src/composer.ts` | 未开始 |
| W2 | 侧栏与顶栏 | `packages/web-units/src/sidebar.ts`、`topbar.ts` | 未开始 |
| W3 | 会话菜单、会话操作、导航 | `packages/web/src/session-menu.ts`、`session-actions.ts`、`navigation.ts` | 未开始 |
| W4 | 消息、工具状态、费用和预览 | `packages/web-ui/src/conversation/`（含 `messages.tsx`、`turn-actions.tsx`、`cost-format.ts`、`usage.tsx`）、`packages/web/src/timeline.ts`、`turns.ts`、`presentation.ts`、`usage.ts`、`view.ts`、`document-preview.ts`、`packages/web-units/src/conversation/tool-card.ts` | 未开始 |
| W5 | `app.ts` 里其余用户可见句子 | `packages/web/src/app.ts`。保留已有 locale 回调。这个文件里的失败句一起改成 code 查目录 | 未开始 |
| W6 | 三个页面的静态壳，以及绘制前回填 | `packages/web/public/index.html`；回填实现放在 `packages/web/src/theme-boot.ts`，让 admin / resources 独立打开时同样生效 | 未开始 |
| W7 | 其余用户可见壳句 | `packages/web/src/region-slots.ts`、`shell.ts`、`packages/web-ui/src/confirm.ts`、`packages/web-client/src/outlet.tsx` 的「插件渲染失败」 | 未开始 |

`packages/web/src/client-modules/reconcile.ts`、`runtime-status.ts`、`hot-reload.ts`、`timeline-slot.ts` 里的中文是注释或日志，不迁。若其中有渲染到页面上的句子，记入 W7，不要把整文件当成文案。

### 9.3 设置与通用

| 步骤 | 内容 | 文件 | 状态 |
| --- | --- | --- | --- |
| S1 | 通用页剩余文案 | `settings.ts` 的 `#appearance-settings-pane`。语言开关保持不动 | 未开始 |
| S2 | 模型、账户、已归档会话的模板 | `settings.ts` 的 `#model-settings-pane`、`#archived-settings-pane` | 未开始 |
| S3 | 设置逻辑与账户对话框 | `packages/web/src/settings.ts`（含 `CONFIGURATION_REASON_MESSAGES`）、`appearance.ts`（保留语言单选）、`packages/web-ui/src/settings-accounts.tsx`、`settings-account-dialog.tsx`、`settings-model-pane.tsx` | 未开始 |
| S4 | 选择器、OAuth、皮肤、字号、工具图标 | `model-picker.ts`、`permission-picker.ts`、`provider-picker.ts`、`workspace-picker.ts`、`oauth-controls.ts`（含失败句）、`skin.ts`、`theme.ts`、`tool-icon.ts`、`session-title.ts`、`packages/web-ui/src/select-picker.ts` | 未开始 |

`theme-boot.ts` 不在这一线。`skin.ts`、`theme.ts` 里的注释不迁，只迁用户能看见的名称和提示。

### 9.4 管理与资源

| 步骤 | 内容 | 文件 | 状态 |
| --- | --- | --- | --- |
| A1 | 集中标签 | `packages/web-ui/src/admin-text.ts`、`ui/state-lights.tsx` | 进行中，swx（2026-10-01） |
| A2 | 确认、列表和详情 | `admin-confirmation.tsx`、`admin-dialogs.tsx`、`admin-list.tsx`、`admin-detail.tsx` | 未开始 |
| A3 | 插件管理逻辑，以及插件页模板 | `packages/web/src/admin/plugins/admin.tsx`、`source-form.ts`；`settings.ts` 的 `#plugin-settings-pane` | 未开始 |
| A4 | 资源管理 | `resource-list.tsx`、`resource-detail.tsx`；`packages/resource-control-web/src/admin.tsx`、`skill-copy.ts`、`mcp-form-validation.ts`、`api.ts`；`settings.ts` 的 `#resource-settings-pane` | 未开始 |
| A5 | 静态管理页和服务器不可用提示 | `admin.html`、`resources.html` 的正文；`packages/web-server/src/server.ts` 的两句不可用提示。回填依赖 W6 的 `theme-boot.ts`，A5 在 W6 之后收尾 | 未开始 |

### 9.5 诊断与 Computer Use

| 步骤 | 内容 | 文件 | 状态 |
| --- | --- | --- | --- |
| D1 | Computer Use 状态和设置页模板 | `packages/web/src/computer-use-state.ts`、`packages/web-ui/src/settings-computer-use.tsx`、`settings.ts` 的 `#computer-use-settings-pane` | 已完成（yuan，2026-10-01） |
| D2 | 轨迹面板 | `packages/web-units/src/trace.ts`。这个文件只由诊断线改 | 已完成（yuan，2026-10-01）。徽章、检查器、时间轴和空状态随页面语言变化 |
| D3 | 诊断导出 | `packages/web-units/src/diagnostics-viewer.ts`、`packages/web-ui/src/diagnostics-dialog.tsx`、`packages/web/src/diagnostics-dialog.ts`、`diagnostics-bundle.ts` | 已完成（yuan，2026-10-01）。导出的 HTML 使用导出当时的语言 |

### 9.6 CLI

| 步骤 | 内容 | 文件 | 状态 |
| --- | --- | --- | --- |
| C1 | TUI 文案收进字典，默认改为英文 | `packages/cli-tui/src`。`resolveLocale` 在 `AGNES_LOCALE` 未设置时返回 `en`，不再看 `LANG`。窄屏用 `displayWidth` 断言中文宽度 | 未开始 |
| C2 | 帮助、引导、工作区选择、资源命令里的用户句 | `packages/cli/src` 的 `usage()`、`doctor`、引导；`packages/cli/launch/workspace-picker.ts`；`packages/resource-control-cli/src/resources.ts` | 未开始 |
| C3 | 把 CLI 解析出的 locale 传给 SDK | `packages/sdk/src/text.ts` 已有的两句，跟 TUI 使用同一个 locale | 未开始 |

### 9.7 错误码收口

客户端文件里的失败句已经划给该文件的界面认领人。这一线只处理服务端仍直接写给人看的句子。

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| E1 | 列出 daemon、host、worker-runtime、resource-control 服务端里用户能看到的中文句子。注释、日志、密钥脱敏后的内部句子跳过 | 未开始 |
| E2 | 这些句子改成稳定 code 加英文 `safeMessage`。`safeMessage` 是客户端没有这条 code 时的兜底，保持英文 | 未开始 |
| E3 | 核对界面认领人已经用 code 查目录。缺的 code 补进对应目录，仍由那个界面文件的认领人改客户端 | 未开始 |

已知要在 E1 里打开的位置：daemon 的 config、admin-surface、session-preferences、supervisor、worker-link；host 的 codex-login、skill-install、skill-preload；worker-runtime 的 commands、mcp 行；package-manager、sandbox-remote、core、ai、base extensions 里若有渲染给用户的句子，同样列入。抽查后确认只是注释的，写进第 10 节，不改。

协议继续只传稳定 code，例如 `CONFIG_AUTH_FAILED`、`E_PACKAGE_TRUST`。不改 schema。

### 9.8 收尾

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| F1 | Web 未设置 `agnes-locale` 时是英文；CLI 未设置 `AGNES_LOCALE` 时是英文，中文 `LANG` 不会把它切走。存储写失败后本次语言仍在，改主题不会把它盖回旧值 | 未开始 |
| F2 | 第 9 节全部「已完成」。第 10 节之外，不再有渲染给用户的硬编码中文或硬编码英文用户句 | 未开始 |
| F3 | 每个目录文件都有 key 成对测试；抽查第 6.3 节的术语 | 未开始 |

## 10. 本期不做

| 事项 | 处理 |
| --- | --- |
| `packages/channels/`，包括 `runner/` 的审批、通知、命令回复，以及钉钉卡片 | 暂缓。用户和 Web / CLI 不完全同一批，而且是服务端渲染。以后按 code 加目录做。届时审批句子再决定是否复用 CLI 的 key |
| `examples/` 示例客户端和皮肤包里的中文标签 | 不做。属于示例作者的文案 |
| 源码注释、`console` 日志、`packages/cli/tools/build-local.ts` | 不做 |
| `packages/web/public/style.css`、web-ui 的 tokens、`REGISTRY.md` | 已核实为注释或文档，不做 |
| `packages/web-admin-frame` | 删除计划内，不单独做国际化 |
| extension-api 的中文 | 先视为注释。E1 若发现用户可见句子，再补进 E2 |

## 11. 怎样算一条做完

- 这个步骤里的用户可见句子都在渲染时通过 `t()` 取得，或在 HTML 提交之后用 `data-i18n` 回填。同一屏幕不留一半写死的中文。
- 新 key 同时有英文和简体中文，并带有成对测试。
- 切换语言后，该屏幕上的句子和 `documentElement.lang` 一起变。React 组件会因 locale 订阅而重绘；`innerHTML` 模板在再次提交后仍是新语言。
- 原来断言中文的测试改为断言目录结果。默认语言下断言英文。
- 不改模型提示词，不改协议 schema，不改 `preset.locale`。

收尾时用第 9 节的文件清单核对，不用「源码里中文字符总数必须下降」做门禁。那个总数包含注释，界面迁完也不会变成 0，只改注释也会被误判成回归。

行数上限是另一件事。`tools/guards/ratchet.json` 按目录计源码行，超限会让 `tools/guards/src/ratchet.test.ts` 失败。和这次迁移直接相关、而且已经偏紧的键是：

| 键 | 当前上限 |
| --- | --- |
| `packages/web-client/src` | 1745 |
| `packages/web-ui/src` | 4732 |
| `packages/web/src` | 13622 |
| `packages/web-units/src` | 5234 |
| `packages/web/src/app` | 1838 |

某个目录加了文案文件或把句子搬进渲染之后超限，就在同一次提交里按实测行数改这个上限，并写明增加了多少行。不要放宽扫描范围，也不要为了留下余量把上限改得比实测更高。`packages/web-ui/src`、`packages/web-units/src`、`packages/cli-tui/src` 也有上限，改到它们时同样处理。
