# AGH 主题

[English](ui-theme.md) | 简体中文

Agnes Web 只有一套内置主题，工作台、设置和独立管理页共用。它安静、偏工具感：暖白底色、一个石墨灰族、一个靛蓝强调色，用边框而不是阴影区分层次。浅色与深色同样完整。

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
| 底色 | `--agnes-bg-page`、`--agnes-bg-app-content` | `#FBFAF8` | `#15161A` |
| 侧栏与面板 | `--agnes-bg-app-sidebar`、`--agnes-bg-subtle` | `#F3F3F1` | `#1B1C21` |
| 表面（卡片、输入框、菜单、弹窗） | `--agnes-bg-surface`、`--agnes-bg-popover`、`--agnes-input-surface` | `#FFFFFF` | `#1F2026` |
| 用户消息气泡 | `--agnes-bg-user-bubble` | `#EFEFEC` | `#26272D` |
| 正文 | `--agnes-text-primary` | `#1B1D22` | `#E6E7EA` |
| 次要文字 | `--agnes-text-secondary` | `#4B4F58` | `#C3C6CC` |
| 弱化文字 | `--agnes-text-tertiary` | `#666B76` | `#9A9EA8` |
| 分隔线 | `--agnes-line-primary` | `#E4E4E0` | `#2C2E35` |
| 强调色 | `--agnes-brand-primary` | `#4F5BD5` | `#8A93FF` |
| 品牌图形标与字标 | `--agnes-brand-mark` | `#3248AF` | `#6983FC` |
| 强调色软底 | `--agnes-brand-emphasis-soft` | `#EEF0FC` | `#252845` |
| 成功、警告、危险标记 | `--agnes-status-*-solid` | `#2F8F5B` `#B7791F` `#C2413B` | `#5CC28A` `#E0A84A` `#EF7B74` |

保持主题一致的几条规则：

- 强调色只用于主操作、当前选中和状态指示，不用于装饰；状态色与强调色分开。
- 悬停、选中和卡片底色是正文色的半透明叠层（`--agnes-bg-hover`、`--agnes-bg-selected`、`--agnes-bg-card`），因此在底色、面板和表面上都成立。
- 状态色有两档：`-text` 用于文字（在底色和自身 `-bg` 上达到 4.5:1），`-solid` 用于圆点和图标（3:1）。浅色下文字档比标记档更深。
- 弱化文字在它出现的每一种表面上（包括悬停与卡片叠层）都保持 4.5:1；控件边界（`--agnes-input-border`）和焦点环保持 3:1。[`token-contrast.test.ts`](../../packages/web-ui/test/token-contrast.test.ts) 与 [`style-tokens.test.ts`](../../packages/web/test/style-tokens.test.ts) 中的对比度表对两种模式分别校验。

## 字体、形状与动效

| 尺度 | Token | 取值 |
| --- | --- | --- |
| 字体族 | `--font-sans`、`--font-mono` | 系统字体栈：SF、Segoe UI、已安装时的 Inter，中文使用 PingFang SC 及各平台对应字体。不下载网络字体。 |
| 字号 | `--font-size-xs` … `--font-size-2xl` | 12、13、14（基准）、16、18、20、24 px |
| 阅读 | `--font-size-prose`、`--line-height-prose`、`--measure-prose` | 对话正文 14px、行高 1.7、行宽 72ch；代码与表格使用整行宽度。 |
| 正文行高 | `--line-height-body` | 1.6，中文正文的下限。 |
| 圆角 | `--radius-control`、`--radius-card`、`--radius-surface`、`--radius-popover`、`--radius-menu-item`、`--radius-composer`、`--radius-pill` | 控件 6px；卡片 8px；弹窗 12px；菜单与浮层 14px，其中的行 10px；输入卡 24px；胶囊形只用于小标签。 |
| 控件高度 | `--control-height`、`--control-height-sm`、`--control-height-form`、`--control-height-touch` | 按钮 36px；紧凑按钮与图标按钮 28px；文本输入框与按钮同为 36px，手机宽度下升到 44px 的触控目标。 |
| 高程 | `--elevation-0`、`--elevation-1`、`--elevation-2`、`--shadow-hairline` | 平面；菜单与浮层；弹窗与抽屉；「新会话」按钮这类安静凸起控件的 1px 抬升。 |
| 动效 | `--motion-fast`、`--motion-base`、`--motion-ease`、`--motion-breathe` | 120ms、200ms、ease-out，以及运行中圆点 2.4s 的呼吸周期。 |

设置页与管理页共用一套标题尺度，不论页面用的是哪一级标题元素：页面标题 16px，分区 14px，行 13px，均为半粗体，正文 13px。弹窗标题为 16px 半粗体。空状态由 24px 的图形、一行 14px 的状态名称和一行 13px 的下一步说明组成。

结构由边框表达。带边框的卡片不加阴影，高程只属于浮在页面之上的层。需要比较的数字（时间、数量、费用、用量）使用 `font-variant-numeric: tabular-nums`。动效只用于弹窗、抽屉这类偶发界面；菜单、页签和键盘触发的操作不做动画，`prefers-reduced-motion` 下所有动画停止。

浏览器自身的界面也跟随主题：`color-scheme` 随模式设置，`theme-color` 元标签写入实际的底色，文字选区使用强调色的浅色调，光标使用强调色，长滚动区域显示细滚动条（`--agnes-scrollbar-thumb`）。

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

颜色没有第二个来源。`ConfigProvider` 只提供 CSS 无法表达的内容：CSP nonce、语言、浮层容器和浮层的 z-index 层级。不要通过 `ConfigProvider` 的 `theme.token` 传颜色，皮肤和深浅切换都到不了那里。测试会检查 Ant Design 样式表读取的每个全局颜色变量都已桥接。

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
| `Disclosure` | 唯一的可折叠区块。始终可见的一行通过 `summary` 传入；需要受控时使用 `open` 和 `onOpenChange`，否则用 `defaultOpen`，之后保留用户自己的展开状态。请使用它，不要直接写 `<details>` 元素。 |
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
