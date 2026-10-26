# 皮肤作者指南

[English](skins.md) | 简体中文

皮肤让 Agnes 的 Web 界面换一套外观。一份皮肤是**纯数据**：一份样式表、可选的图片/字体资产，
以及可选的语义 token 覆盖。它**不执行代码**。

[文档导航](../README.zh-CN.md) · [插件开发](plugins.zh-CN.md)

区域钩子、语义 token 和示例包由仓库测试与实际界面合同交叉校验。

## 1. 快速开始

**可直接安装运行的完整示例**在 [`examples/packages/skin-example/v1`](../../examples/packages/skin-example/v1)：
那份清单与样式表就是本节所说的形态，且由测试对着真实契约校验，不会与本文漂移。

会话中创建时先调用 `plugin_helper_guide`，选择 `kind: "skin"`，会得到完整文件模板；无需在当前工作区找到 AGH 源码。

当前包格式使用 `package.json` 注册插件行并绑定纯数据客户端描述：

```json
{
  "name": "my-agh-skin",
  "version": "0.1.0",
  "type": "module",
  "exports": "./index.mjs",
  "agnes": {
    "plugins": [{ "apiRange": "^5.0.0", "id": "ext:my-agh-skin/main", "export": "main" }],
    "clientDescriptors": [{ "rowId": "ext:my-agh-skin/main", "path": "./extensions/main/agnes.client.json" }]
  }
}
```

`index.mjs` 导出空插件行：`export const main = { apply() {} }`。

`extensions/main/agnes.client.json`：

```json
{
  "skins": [{ "id": "midnight", "name": "午夜", "css": "./skins/midnight/skin.css" }]
}
```

`extensions/main/skins/midnight/skin.css`：

```css
/* 只依赖 data-agnes-region 钩子，这样 Agnes 重构内部 class 也不会让你失效。 */
[data-agnes-region="app"] {
  background-image: linear-gradient(180deg, #10151c, #1c2430);
}
[data-agnes-region="sidebar"] {
  background-color: #151b23;
}
[data-agnes-region="composer"] {
  border-color: #2b3644;
}
```

要点：

- `clientDescriptors.rowId` 必须与插件行 id 相同；描述中的 `skins` 注册皮肤。不再有单独的扩展清单文件；插件条目自带 `capabilities` 和 `contributes`。
- `css` 必须是**包内相对路径**（以 `./` 开头，不含 `..`、盘符、反斜杠）。
- 皮肤 id 不能用 `light` / `dark` / `system` / `none`（内置主题保留字），且在**已安装的整套皮肤里唯一**。

## 2. 区域钩子（稳定的选择器契约）

**只依赖 `data-agnes-region`。** 内部 class 与 id（`.sidebar`、`#composer`、`turn-*` …）**不是**契约，
Agnes 可以随时重命名它们；钩子则是版本化契约，改名会让机检变红而不是让你的皮肤悄悄失效。

| 钩子 | 承载元素 | 出现在 |
| --- | --- | --- |
| `app` | `body` | 三页 |
| `topbar` | 页头 `header` | 三页 |
| `dialog` | `dialog` | 三页 |
| `sidebar` | `aside.sidebar` | 工作台 |
| `conversation` | 会话区外框 | 工作台 |
| `trace` | 运行轨迹面板 `aside` | 工作台 |
| `rightbar` | 右侧扩展面板 `aside` | 工作台 |
| `workbench-right` | 右侧会话停靠区 `aside` | 工作台 |
| `workbench-bottom` | 底部会话停靠区 `aside` | 工作台 |
| `transcript` | 对话列表容器 | 工作台 |
| `empty-state` | 空状态 | 工作台 |
| `home-page` | 首页侧栏入口打开的整页 `section` | 工作台 |
| `approval` | 审批区 | 工作台 |
| `composer` | 输入框外框 `form` | 工作台 |
| `composer-input` | 输入文本域 `textarea` | 工作台 |
| `icon` | 界面图标 `svg` | 工作台 |
| `settings-pane` | 设置分页 | 工作台 |

- 皮肤在**三个页面**都会生效（工作台 `/`、插件管理 `/admin/plugins`、技能与 MCP `/admin/resources`），
  所以 `app` / `topbar` / `dialog` 上的规则在所有页面都适用。
- **消息级内部结构不是契约**：`turn-*` / `node-*` 等由渲染器动态生成，当前可用但**不保证稳定**。

### 2.1 换掉图标：用 `mask` 而不是贴图

`icon` 钩子挂在每个界面图标上，而图标本体是**描边式 SVG**（`stroke: currentColor`）。
想把它换成图片，标准做法是**用图片当遮罩**，让图标的颜色仍然跟着主题走：

```css
[data-agnes-region="icon"] {
  /* 先让原始描边消失，再用图片当遮罩，底色取 currentColor。 */
  stroke: none;
  background-color: currentColor;
  mask: url("assets/glyph.png") center / contain no-repeat;
}
.dark [data-agnes-region="icon"] {
  background-color: var(--agnes-text-primary);
}
```

只改线条粗细/颜色也一样简单：`stroke-width: 2.5; stroke: var(--agnes-brand-primary);`。

> 注意：`.icon` 这类内部 class **不是契约**，只有 `data-agnes-region` 是。所以请始终写
> `[data-agnes-region="icon"]`，不要写 `.icon`。

### 2.2 换字体

字体文件（`.woff2` / `.woff`）和图片走同一套 `assets/` 与同样的体积上限，用 `@font-face` 引入即可：

```css
@font-face {
  font-family: "Skin Face";
  src: url("assets/face.woff2") format("woff2");
}
body,
button,
input,
textarea {
  font-family: "Skin Face", system-ui, sans-serif;
}
```

**不改资产也能换字体**：直接写系统字体栈（无需额外分发字体文件），例如
`font-family: "Chalkboard SE", "Comic Sans MS", cursive;`。

### 2.3 级联层与皮肤优先级

唯一层序声明位于 `@agnes/web-ui/layers.css`：

```css
@layer tokens, base, vendor, ui, app, skin;
```

平台主题变量属于 `tokens`，原生控件默认值属于 `base`，Ant Design 与 Markdown 外部样式属于 `vendor`，共享组件与 Ant Design 主题桥属于 `ui`，应用规则属于 `app`。Web 构建在三个页面入口的规则之前输出一次层序；共享组件 CSS 导出也引用同一个层序文件，供其他 Web UI 消费者使用。

宿主在采用皮肤样式表时，将作者的 CSS 包进 `skin` 层。皮肤文件直接使用公共区域钩子写普通 CSS，无需自行声明层。普通皮肤声明优先于前面的层，也能覆盖应用的 ID 选择器，因此设置弹窗表面覆盖不再需要 `!important`。Token 覆盖继续按现有方式内联应用，保留浅深色切换行为。CSS 的重要声明仍高于普通声明；隐藏元素与减少动效等保障保留必要的重要声明。

```css
[data-agnes-region="composer"] {
  background-image: linear-gradient(160deg, #101820, #1d2b3a);
}
```

区域钩子仍是稳定合同，`packages/web/test/skin-regions.test.ts` 继续检查其表面声明。客户端模块样式通过原生 CSS `@import` 加载进 `app` 层，相对导入与资产 URL 继续以原包样式表为基准解析。客户端模块维护自己的组件样式；皮肤负责跨宿主的外观覆盖。

## 3. 语义 token 清单

以下是可以写进 `tokens` 的变量名。白名单由 `packages/web/public/style.css` 生成，文档测试会将本清单与生成结果核对。**该清单按顺序引用的 `public/styles/` 文件是唯一色彩权威**；增删 token 后未更新生成物会使 `gen:check` 失败。

<!-- theme-tokens:begin -->
--agnes-brand-primary
--agnes-brand-mark
--agnes-brand-focus-ring
--agnes-brand-emphasis-soft
--agnes-focus-ring-soft
--agnes-scrollbar-thumb
--agnes-text-primary
--agnes-text-secondary
--agnes-text-tertiary
--agnes-text-disabled
--agnes-text-inverse
--agnes-text-emphasis
--agnes-icon-secondary
--agnes-bg-page
--agnes-bg-surface
--agnes-bg-popover
--agnes-bg-card
--agnes-bg-code
--agnes-bg-selected
--agnes-bg-hover
--agnes-bg-fill
--agnes-bg-fill-hover
--agnes-bg-group
--agnes-bg-scrim
--agnes-bg-lightbox
--agnes-surface-glass-soft
--agnes-surface-glass-hover
--agnes-bg-user-bubble
--agnes-input-surface
--agnes-input-content-strong
--agnes-input-placeholder
--agnes-input-border
--agnes-input-border-emphasis
--agnes-input-border-focus
--agnes-line-emphasis
--agnes-line-primary
--agnes-button-primary-bg
--agnes-button-primary-bg-hover
--agnes-button-primary-content
--agnes-button-outline-content
--agnes-status-success-text
--agnes-status-success-bg
--agnes-status-warning-text
--agnes-status-warning-bg
--agnes-status-danger-text
--agnes-status-danger-bg
--agnes-status-info-text
--agnes-status-info-bg
--agnes-bg-subtle
--agnes-status-success-border
--agnes-status-warning-border
--agnes-status-danger-border
--agnes-status-info-border
--agnes-status-success-solid
--agnes-status-warning-solid
--agnes-status-danger-solid
--agnes-status-info-solid
--shadow-elevation
--focus-outline
--focus-line
--focus-line-inset
--shadow-raised
--shadow-hairline
--shadow-dialog
--shadow-elevation-soft
--shadow-elevation-prominent
--elevation-0
--elevation-1
--elevation-2
--agnes-line-hairline
--agnes-bg-popover-material
--agnes-menu-active-bg
--agnes-menu-active-text
--agnes-switch-track
--agnes-switch-knob
--agnes-segment-track
--agnes-bg-control
--shadow-control
--shadow-control-primary
--shadow-knob
--shadow-popover
--agnes-bg-app-sidebar
--agnes-bg-app-content
--agnes-trace-track
--agnes-trace-row-current
--agnes-trace-row-hover
--agnes-trace-mark-bg
--agnes-trace-mark-text
--agnes-trace-row-hit
--agnes-trace-lane-input
--agnes-trace-lane-user
--agnes-trace-lane-context
--agnes-trace-lane-model
--agnes-trace-lane-tool
--agnes-trace-badge-user-text
--agnes-trace-badge-user-bg
--agnes-trace-badge-context-text
--agnes-trace-badge-context-bg
--agnes-trace-badge-assistant-text
--agnes-trace-badge-assistant-bg
--agnes-trace-badge-tool-text
--agnes-trace-badge-tool-bg
--agnes-trace-badge-approval-text
--agnes-trace-badge-approval-bg
--agnes-trace-badge-compaction-text
--agnes-trace-badge-compaction-bg
--agnes-file-type-text
--agnes-file-type-html
--agnes-file-type-css
--agnes-file-type-js
--agnes-file-type-ts
--agnes-file-type-json
--agnes-file-type-md
--agnes-file-type-svg
--agnes-file-type-image
--agnes-file-type-code
--agnes-file-type-other
--agnes-document-page-bg
--agnes-terminal-bg
--agnes-terminal-bar
--agnes-terminal-line
--agnes-terminal-text
--agnes-terminal-muted
<!-- theme-tokens:end -->

主题合同新增的状态区域与层级 token：

| Token | 用途 |
| --- | --- |
| `--agnes-status-info-bg` | 信息提示的背景。 |
| `--agnes-bg-subtle` | 次要区域的柔和背景。 |
| `--agnes-status-success-border` | 成功状态的边框。 |
| `--agnes-status-warning-border` | 警告状态的边框。 |
| `--agnes-status-danger-border` | 错误或危险状态的边框。 |
| `--agnes-status-info-border` | 信息状态的边框。 |
| `--elevation-0` | 无阴影的平面区域。 |
| `--elevation-1` | 小型浮层的阴影。 |
| `--elevation-2` | 弹窗与较高浮层的阴影。 |
| `--agnes-bg-user-bubble` | 用户自己消息的气泡底色；中性色，不使用强调色。 |
| `--agnes-status-success-solid` | 成功状态的圆点、图标等非文字标记（至少 3:1）。 |
| `--agnes-status-warning-solid` | 警告状态的非文字标记。 |
| `--agnes-status-danger-solid` | 错误或危险状态的非文字标记。 |
| `--agnes-status-info-solid` | 信息状态的非文字标记。 |
| `--agnes-line-hairline` | 分隔线与控件描边；取文字色的浅色调，高分屏上为一个物理像素宽。 |
| `--agnes-bg-popover-material` | 菜单与选项列表的表面：浮层色 94% 不透明，叠在背景模糊之上。不透明度不要低于 94%，否则文字对比度无法保证。 |
| `--agnes-menu-active-bg`、`--agnes-menu-active-text` | 菜单或选择器中指针所在行、键盘当前行的底色与内容色；这一对必须保持 4.5:1。 |
| `--agnes-switch-track`、`--agnes-switch-knob` | 关闭状态开关的轨道与旋钮；开启状态使用 `--agnes-brand-primary` 与 `--agnes-button-primary-content`。 |
| `--agnes-segment-track` | 分段控件的轨道。 |
| `--agnes-bg-control` | 凸起控件的表面：次按钮、弹出按钮和分段控件的选中块。 |
| `--shadow-control`、`--shadow-control-primary` | 凸起控件的发丝描边与 1px 抬升；主按钮顶部的高光。 |
| `--shadow-knob` | 开关旋钮的阴影。 |
| `--shadow-popover` | 菜单与选项列表的阴影。 |

尺度不在 `tokens` 白名单里，但皮肤样式表可以像写普通 CSS 一样在 `:root` 上设置它们：字阶（`--font-size-title`、`--font-size-caption`）、圆角（`--radius-sm` … `--radius-xl`）、控件尺寸（`--control-height`、`--switch-width`、`--switch-height`）、图标线宽（`--icon-stroke`、`--icon-stroke-strong`）、发丝线宽度（`--hairline`）、连续圆角（`--corner-shape`、`--corner-scale`）和动效（`--motion-short`、`--motion-medium`、`--motion-long`、`--motion-spring`）。共享控件读取这些值，一处声明即可作用到所有按钮、开关、菜单和弹窗。你自己加的动效必须写在 `@media (prefers-reduced-motion: no-preference)` 之内。

内置主题的取值、字号与圆角尺度，以及这些 token 如何传给 Ant Design 与 Ant Design X，见[主题说明](ui-theme.zh-CN.md)。

每个 token 都要**同时**给出 `light` 与 `dark` 两个值：

```json
{
  "tokens": {
    "--agnes-bg-page": { "light": "#fdfeff", "dark": "#161b21" }
  }
}
```

值必须是合法的 CSS 颜色或阴影，**不得**包含 `;` `{` `}` `@`，也**不得**使用 `url(...)`
（`url()` 在 `skin.css` 里可以，在 token 值里不行）。渐变是允许的，例如
`linear-gradient(180deg, #ffffff, #f0f0f0)`。

覆盖**可以只写一部分**——没写的回落当前内置主题。想让皮肤更抗未来变更，优先用 token；
需要 token 表达不了的形状时再用 `skin.css`。

## 4. 深浅色

Agnes 的深浅模式由根元素上的 `.dark` 类切换，并跟随 `prefers-color-scheme`。

- **token** 天然两套：你为每个 token 同时提供 `light`/`dark`，Agnes 按当前模式挑值。
- **`skin.css`** 需要你自己两套都写：

```css
[data-agnes-region="app"] { background-image: linear-gradient(180deg, #f7f8fa, #eef1f5); }
.dark [data-agnes-region="app"] { background-image: linear-gradient(180deg, #10151c, #1c2430); }
```

两套都要给，不要只写一套——只写一套会让另一半模式难读。

## 5. 资产（图片与字体）

放在样式表**同级的 `assets/` 目录**里，用相对路径引用：

```text
skins/aurora/
  skin.css
  assets/
    aurora.webp
    body.woff2
```

```css
[data-agnes-region="app"] {
  background-image: url('assets/aurora.webp');
  background-size: cover;
  background-position: center;
}
@font-face {
  font-family: 'Skin Body';
  src: url('assets/body.woff2') format('woff2');
}
```

规则：

- 允许的扩展名：`.webp` `.png` `.jpg` `.jpeg` `.avif` `.woff2` `.woff`。
- 单资产 ≤ 2 MB，单皮肤资产合计 ≤ 8 MB，样式表 ≤ 128 KB。超限**装不进来**。
- **不能引用网络资源，也不能内联 base64。** 页面策略是 `default-src 'self'`，
  远程图片/字体与 `data:` URI 都会被浏览器拦掉。图片必须放进包里。
- 只有 `assets/` 目录下的文件可以被取到；与样式表同级的其他文件**取不到**。
- **相对路径按样式表自身的位置解析**，和普通 CSS 一样：`url('assets/x.png')` →
  `/skins/<你的皮肤 id>/assets/x.png`。你不需要写绝对路径，也不该把皮肤 id 硬编码进去。
  宿主在下发样式表文本时会替你把它绝对化（因为首帧用的是内联文本，其基准是页面而不是样式表），
  编写皮肤时应始终使用包内相对资产路径。

## 6. 能力与限制

| 想做的 | 能否 |
| --- | --- |
| 改颜色、渐变、阴影 | ✅ |
| 改背景图（页面 / 侧边栏 / **会话区** / **输入框** / 弹窗） | ✅ |
| 换字体 | ✅（字体文件放进 `assets/`） |
| 改圆角、间距、动效、布局 | ✅（就是普通 CSS） |
| 执行 JavaScript、改交互行为 | ❌ 皮肤是纯数据 |
| 引用网络上的图片/字体 | ❌ CSP 拦截 |
| 内联 base64 图片 | ❌ `data:` 被 CSP 拦截 |

## 7. 调试

- **临时关掉皮肤**：在页面网址后面加 `?skin=none`，强制回到内置外观；
  用 `?skin=<id>` 可以强制指定一份皮肤。两者都是**一次性**覆盖，不写缓存——刷新到不带参数的网址就回到原来的选择。
  如果某份皮肤让设置入口变得点不到，用这个办法恢复。
- **改完 CSS 不生效**：皮肤样式表按清单的 `revision` 缓存。停用再启用该包，或重新选择一次皮肤，即可拿到新内容。
- **看当前有哪些皮肤**：设置 →「通用」→ 外观 → 皮肤。清单只包含**已启用且已信任**的包里声明的皮肤。

## 共享控件与可读性

遵循[UI 作者指南](ui-author-guide.zh-CN.md)的 token 规则。共享 `.agh-btn*`、状态、表单、骨架和抽屉都消费语义 token；不要覆盖内部 antd 类或削弱焦点环与窄屏 44px 命中区。正文、图标与状态文字至少 4.5:1，控件边界和焦点至少 3:1，两种主题分别检查。用[token 对比度表](../../packages/web-ui/test/token-contrast.test.ts)作为基础；自定义皮肤须复核其实际覆盖颜色。保留 reduced-motion。
