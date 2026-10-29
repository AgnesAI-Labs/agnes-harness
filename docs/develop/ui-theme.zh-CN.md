# AGH 主题

[English](ui-theme.md) | 简体中文

Agnes Web 只有一套内置主题，工作台、设置和独立管理页共用。它安静、偏工具感：纯白工作内容、一阶灰色导航、一个石墨灰族、一个靛蓝强调色，用边框而不是阴影区分层次。浅色与深色同样完整。

[文档](../README.zh-CN.md) · [皮肤](skins.zh-CN.md) · [UI 作者指南](ui-author-guide.zh-CN.md) · [前端](frontend.zh-CN.md)

## 取值在哪里

| 层 | 文件 | 内容 |
| --- | --- | --- |
| `tokens` | [`packages/web/public/styles/01-tokens.css`](../../packages/web/public/styles/01-tokens.css) | 基础色（`--agnes-color-*`，内部使用）、浅色（`:root`）与深色（`.dark`）的语义 token，以及各类尺度。 |
| `ui` | [`packages/web-ui/src/tokens.css`](../../packages/web-ui/src/tokens.css) | 语义 token 到 Ant Design 与 Ant Design X 变量（`--ant-*`）的主题桥。 |
| `ui` | [`packages/web-ui/src/components.css`](../../packages/web-ui/src/components.css) | 共享组件契约（`.agh-*`）。 |

组件和插件只读取语义 token。具体色值只写在基础色一处；样式测试会拒绝其他位置出现的裸色值和对基础色的直接引用。

## 颜色角色

| 角色 | Token | 浅色 | 深色 |
| --- | --- | --- | --- |
| 内容（对话及整个工作台面板） | `--agnes-bg-page`、`--agnes-bg-app-content` | `#FFFFFF` | `#1B1C21` |
| 导航（侧栏及设置导航栏） | `--agnes-bg-app-sidebar` | `#F3F3F1` | `#15161A` |
| 柔和填充 | `--agnes-bg-subtle` | `#F3F3F1` | `#1B1C21` |
| 表面（卡片、输入框、菜单、弹窗） | `--agnes-bg-surface`、`--agnes-bg-popover`、`--agnes-input-surface` | `#FFFFFF` | `#1F2026` |
| 用户消息气泡 | `--agnes-bg-user-bubble` | `#F3F3F1` | `#26272D` |
| 正文 | `--agnes-text-primary` | `#1B1D22` | `#E6E7EA` |
| 次要文字 | `--agnes-text-secondary` | `#4B4F58` | `#C3C6CC` |
| 弱化文字 | `--agnes-text-tertiary` | `#666B76` | `#9A9EA8` |
| 分隔线 | `--agnes-line-primary` | `#E4E4E0` | `#2C2E35` |
| 强调色 | `--agnes-brand-primary` | `#4F5BD5` | `#8A93FF` |
| 品牌图形标与字标 | `--agnes-brand-mark` | `#3248AF` | `#6983FC` |
| 强调色软底 | `--agnes-brand-emphasis-soft` | `#EEF0FC` | `#252845` |
| 成功、警告、危险标记 | `--agnes-status-*-solid` | `#2F8F5B` `#B7791F` `#C2413B` | `#5CC28A` `#E0A84A` `#EF7B74` |

保持主题一致的几条规则：

- 浅色只有两个中性基础表面：工作内容纯白 `#ffffff`，导航和辅助填充灰色 `#f3f3f1`，不增加中间近白底；浅色空态不再叠加品牌光晕。侧栏与设置导航为灰；对话、文档、轨迹、画廊、自动化、设置正文与管理页为白。
- 顶栏及整个右侧工作台（应用页签、筛选、正文、页脚）为白：它们操作和检查当前任务，因此延续对话内容表面。面板内部的次级导航、代码块、图标底、普通输入填充和用户气泡用同一阶灰。
- 卡片、设置分组、工具/证据卡、composer、弹窗、抽屉和浮层使用白色表面 token。卡片用轻量 primary 边框分组，composer 和悬浮层另加柔和阴影。航天/制药应用采用同一中性表面，保留品牌与状态色。深色保持既有表面取值。
- hover 和 selected 是临时石墨叠层（`--agnes-bg-hover`、`--agnes-bg-selected`），不作为额外基础表面；选中导航/会话项用白底和轻边界或微抬升。主操作、焦点、菜单选中和状态继续使用明确的强调/状态 token。
- 辅助填充统一由 `--agnes-bg-subtle`、`--agnes-bg-fill`、`--agnes-bg-card` 和 `--agnes-bg-code` 提供；实际卡片容器使用 `--agnes-bg-surface` 或 `--agnes-bg-group`。填充型输入框为灰色，聚焦回到白色；普通输入框读取白色输入表面，工作台的平面筛选框保持白底。`--agnes-line-primary` 界定容器，`--agnes-line-hairline` 分隔行，不增加填充层。菜单保留 94% 白色 material 与背景模糊，因此浮层实际像素可以偏离两个不透明基础色。
- 状态色有两档：`-text` 用于文字（在底色和自身 `-bg` 上达到 4.5:1），`-solid` 用于圆点和图标（3:1）。浅色下文字档比标记档更深。
- 弱化文字在它出现的每一种表面上（包括悬停与卡片叠层）都保持 4.5:1；控件边界（`--agnes-input-border`）和焦点环保持 3:1。输入框是这条细边界线内的柔和中性填充（`--agnes-bg-fill`）；键盘焦点环由紧贴元素边缘的 1px 实色线（`--focus-line`，由它保证 3:1）和外侧 3px 柔和光晕（`--focus-outline`）组成，都跟随元素圆角。[`token-contrast.test.ts`](../../packages/web-ui/test/token-contrast.test.ts) 与 [`style-tokens.test.ts`](../../packages/web/test/style-tokens.test.ts) 中的对比度表对两种模式分别校验。

## 字体、形状与动效

| 尺度 | Token | 取值 |
| --- | --- | --- |
| 字体族 | `--font-sans`、`--font-mono` | 系统字体栈：SF、Segoe UI、已安装时的 Inter，中文使用 PingFang SC 及各平台对应字体。不下载网络字体。 |
| 字号 | `--font-size-xs` … `--font-size-2xl`、`--font-size-caption`、`--font-size-title` | 12、13、14（基准）、16、18、20、24 px；分组标签与行说明 12.5px；页面标题 26px 粗体（`--font-weight-bold`、`--tracking-title`，中日韩文字不收紧字距）。 |
| 阅读 | `--font-size-prose`、`--line-height-prose`、`--measure-prose` | 对话正文 14px、行高 1.7、行宽 72ch；代码与表格使用整行宽度。 |
| 正文行高 | `--line-height-body` | 1.6，中文正文的下限。 |
| 圆角 | `--radius-chip`、`--radius-control`、`--radius-segmented`、`--radius-tile`、`--radius-card`、`--radius-surface`、`--radius-modal`、`--radius-popover`、`--radius-menu-item`、`--radius-composer`、`--radius-pill` | 尺度为 8 / 10 / 14 / 20。小标签、按钮、输入框、弹出按钮、菜单行与导航项 8px；分段轨道与图标块 10px；分组卡片、面板、菜单与浮层 14px；弹窗 20px；输入卡 24px；胶囊形只用于徽标和开关。浏览器支持 `corner-shape: squircle` 时，共享表面使用连续圆角，并按 `--corner-scale`（1.3）放大半径；不支持时保持普通圆角。 |
| 控件尺寸 | `--control-height`、`--control-height-sm`、`--control-height-xs`、`--control-height-form`、`--control-height-touch`、`--menu-item-height`、`--row-min-height`、`--switch-width`、`--switch-height`、`--switch-knob` | 按钮、弹出按钮与图标按钮 28px；紧凑按钮与分段 24px；文本输入框 32px，手机宽度下升到 44px 的触控目标；菜单行 26px；设置行最小高 46px；开关 38×22，旋钮 18px。 |
| 节奏 | `--space-section`、`--space-page-top`、`--hairline` | 节与节之间 28px，页面标题上方 36px；分隔线和控件描边在高分屏上为一个物理像素（2x 下 0.5px），其余为 1px。 |
| 图标 | `--icon-stroke`、`--icon-stroke-strong` | 所有 16px 线性图标 1.5；主按钮内、选中的导航项或页签上 1.75。 |
| 高程 | `--elevation-0`、`--elevation-1`、`--elevation-2`、`--shadow-hairline`、`--shadow-control`、`--shadow-control-primary`、`--shadow-knob`、`--shadow-popover` | 平面；浮层；弹窗与抽屉；安静凸起控件的 1px 抬升；凸起控件的发丝描边与主按钮顶部高光；开关旋钮；菜单与选项列表。 |
| 动效 | `--motion-short`、`--motion-medium`、`--motion-long`、`--motion-exit`、`--motion-ease-out`、`--motion-spring`、`--press-scale`、`--press-dim`、`--motion-breathe` | 按下 160ms；折叠、切换页签和开关旋钮 260ms；菜单、弹窗和侧栏面板 320ms；退出时长为进入的 60%；一条缓出曲线和一条约 8% 过冲的弹性曲线；按下时缩到 0.97 并略微变暗；运行中圆点 2.4s 的呼吸周期。`--motion-fast`、`--motion-base` 与 `--motion-ease` 仍用于颜色变化。 |

设置页与管理页共用一个模板和一套标题尺度，不论页面用的是哪一级标题元素：页面标题 18px，分区 14px，行 13px，均为半粗体，正文 13px。一个页面由页头（标题、一行说明、页面操作）、可选的页签和在弹窗内滚动的正文组成；页头与正文都落在同一列（`--settings-column`，760px）和同一留白（`--settings-gutter`）之内，因此不会碰到弹窗边缘或关闭按钮。一组页面只在页签上方命名一次，其下各页只显示自己的说明和操作。简单设置是一个描边分组里的分隔行；描边卡片只用于账户、插件这类对象。弹窗标题为 16px 半粗体。空状态由 24px 的图形、一行 14px 的状态名称和一行 13px 的下一步说明组成。

结构由边框表达。带边框的卡片不加阴影，高程只属于浮在页面之上的层。需要比较的数字（时间、数量、费用、用量）使用 `font-variant-numeric: tabular-nums`。动效短促，只改变 `transform` 和 `opacity`：折叠、切换页签、菜单、弹窗和侧栏面板带一点回弹，退出更短且不回弹。用键盘打开的界面直接出现（动效只在指针输入时启用），按钮按下只是轻微缩小并变暗，没有涟漪或光晕，`prefers-reduced-motion` 下所有动画停止。

浏览器自身的界面也跟随主题：`color-scheme` 随模式设置，`theme-color` 元标签写入实际的底色，文字选区使用强调色的浅色调，光标使用强调色，长滚动区域显示细滚动条（`--agnes-scrollbar-thumb`）。

## 精修层

[`packages/web-ui/src/refinement.css`](../../packages/web-ui/src/refinement.css) 是一份独立样式，在主题之上给共享控件原生比例。它不改变任何颜色角色：每条声明都读取上面的 token，拿掉它界面仍然完整。

| 控件 | 形态 |
| --- | --- |
| 页头（`PageHeader`、`.agh-page-title`、`.agh-page-description`） | 26px 粗体标题，一行 13px 说明，页面操作在右侧。 |
| 分组标签（`SettingsSection` 标题、`.agh-group-label`） | 12.5px 半粗体，次级灰，贴在分组左上方。 |
| 按钮 | 高 28px，圆角 8px。次按钮是带发丝描边的凸起中性表面；主按钮顶部有高光；图标按钮是圆角方形。 |
| 开关（`StateSwitch`、`LabeledSwitch`、`Switch`） | 38×22 轨道，18px 旋钮，带回弹。 |
| 分段控件（`Segmented`） | 圆角矩形轨道，选中项是浮起的块；内部是原生单选，方向键与表单语义不变。用于 2–6 个短选项。 |
| 弹出按钮（`Select`、`SettingsSelect`、设置选择器） | 凸起表面，右端是带上下箭头的强调色块：表示从一组里选一个。可搜索或多选的 `Select` 仍是输入框。 |
| 菜单与选项列表 | 唯一的半透明表面：94% 不透明，叠在背景模糊之上。指针所在行或键盘当前行使用强调色底和对应的内容色（浅色 5.54:1，深色 6.58:1）。 |

自己写的导航请用 `aria-current`、`role="tab"` 加 `aria-selected="true"`，或 `data-selected="true"` 标出当前项，它的图标会使用较粗的线宽。

## Ant Design 如何取色

Ant Design 以 `zeroRuntime` 模式运行：预构建样式表加载在 `vendor` 层，样式值读取 `--ant-*` 变量。`tokens.css` 中的主题桥在 `ui` 层把这些变量逐一指向语义 token：

```css
:root,
:root .agnes-theme {
  --ant-color-primary: var(--agnes-brand-primary);
  --ant-color-bg-container: var(--agnes-bg-surface);
  --ant-border-radius: var(--radius-control);
}
```

颜色没有第二个来源。`ConfigProvider` 只提供 CSS 无法表达的内容：CSP nonce、语言、浮层容器和浮层的 z-index 层级，并关闭点击涟漪。不要通过 `ConfigProvider` 的 `theme.token` 传颜色，皮肤和深浅切换都到不了那里。测试会检查 Ant Design 样式表读取的每个全局颜色变量都已桥接。

## Ant Design X 如何取色

Ant Design X 从 `@agnes/web-ui/x` 导出（`Bubble`、`Sender`、`Conversations`、`ThoughtChain`、`Think`、`Actions`、`Welcome`、`Prompts`、`Attachments`、`FileCard`、`Sources`、`Suggestion`）。这个库没有预构建样式表，所以每处使用都要放在同一模块的 `XProvider` 之下：

```tsx
import { Bubble, XProvider } from '@agnes/web-ui/x'

<XProvider>
  <Bubble content={text} />
</XProvider>
```

`XProvider` 让这棵子树在运行时生成样式。生成的样式带有页面的 CSP nonce，放入 `vendor` 层，并在主题桥所针对的同一个 `agnes-theme` 键下声明变量。因此 X 的颜色、圆角、字体和阴影与 Ant Design 一样来自语义 token，两种模式都生效。主题桥同时映射了 X 为自身组件计算的颜色变量（例如 `--ant-sender-*` 与 `--ant-thought-chain-*`）；测试会渲染这些组件，新增变量仍停留在库默认值时即失败。

只有 `packages/web-ui` 可以导入 `antd` 和 `@ant-design/x`，应用与客户端模块使用 `@agnes/web-ui` 和 `@agnes/web-ui/x`。这些组件只负责呈现，渲染的是你的 store 中的数据；不包含 x-sdk 的对话运行时。

## 共享的小细节

以下展示原语由 `@agnes/web-ui` 导出：

| 原语 | 用途 |
| --- | --- |
| `Disclosure` | 唯一的可折叠区块：一个说明区块名称的按钮，加上它展开的区域。始终可见的一行通过 `summary` 传入；需要受控时使用 `open` 和 `onOpenChange`，否则用 `defaultOpen`，之后保留用户自己的展开状态。根元素带有 `data-open="true|false"`，供样式使用；`dismissible` 用于浮层，按 Escape 或点击外部即关闭。控制器需要先展开再聚焦某个字段时，调用 `setDisclosureOpen(element, true)`。请使用它，不要写 `<details>` 元素。 |
| `Kbd`、`shortcutLabel` | 操作旁的键盘提示。`shortcutLabel(['mod', 'N'])` 在 Apple 键盘上得到 `⌘N`，其他平台得到 `Ctrl+N`。 |
| `StatusDot` | 6px 状态圆点，支持 `tone` 与 `running`；运行中的圆点会呼吸，减少动态效果时保持静止。旁边没有文字说明状态时传入 `label`。 |
| `CompletionCheck` | 回合或步骤完成后留下的浅色对勾，可附带耗时。 |
| `CopyButton` | 复制操作；复制成功后图标变为对勾，随后恢复。失败通过 `onCopied(false)` 交给调用方处理。 |

## 皮肤如何覆盖主题

皮肤修改的是同一批语义 token，所以它的颜色会同时到达 Agnes 组件、Ant Design 和 Ant Design X：

```json
{
  "tokens": {
    "--agnes-brand-primary": { "light": "#0f766e", "dark": "#5eead4" },
    "--agnes-bg-user-bubble": { "light": "#e6f2ef", "dark": "#1d3531" }
  }
}
```

token 覆盖以内联方式应用，在两种模式下都优先于内置取值。token 表达不了的部分，皮肤样式表会被放入 `skin` 层，位于 `tokens, base, vendor, ui, app` 之后，因此写在 `data-agnes-region` 钩子上的普通声明无需 `!important` 即可生效。不要选择 `.ant-*` 类，也不要重新定义 `--ant-*` 变量；请覆盖主题桥读取的语义 token。token 清单、限制和区域钩子见[皮肤作者指南](skins.zh-CN.md)。
