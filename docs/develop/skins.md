# 皮肤作者指南

皮肤让 Agnes 的 Web 界面换一套外观。一份皮肤是**纯数据**：一份样式表、可选的图片/字体资产，
以及可选的语义 token 覆盖。它**不执行代码**。

[文档导航](../README.md) · [插件开发](plugins.md)

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
    "plugins": [{ "id": "ext:my-agh-skin/main", "export": "main" }],
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

- `clientDescriptors.rowId` 必须与插件行 id 相同；描述中的 `skins` 注册皮肤。旧 `agnes.extension.json` 格式不作为新包入口。
- `css` 必须是**包内相对路径**（以 `./` 开头，不含 `..`、盘符、反斜杠）。
- 皮肤 id 不能用 `light` / `dark` / `system` / `none`（内置主题保留字），且在**已安装的整套皮肤里唯一**。

## 2. 区域钩子（稳定的选择器契约）

**只依赖 `data-agnes-region`。** 内部 class 与 id（`.sidebar`、`#composer`、`turn-*` …）**不是**契约，
Agnes 可以随时重命名它们；钩子则是版本化契约，改名会让机检变红而不是让你的皮肤悄悄失效。

| 钩子 | 承载元素 | 出现在 |
| --- | --- | --- |
| `app` | `body` | 三页 |
| `topbar` | 页头 `header` | 三页 |
| `dialog` | `dialog`（工作台 9 个 / 插件管理 4 个 / 技能与 MCP 3 个） | 三页 |
| `sidebar` | `aside.sidebar` | 工作台 |
| `conversation` | 会话区外框 | 工作台 |
| `trace` | 运行轨迹面板 `aside` | 工作台 |
| `rightbar` | 右侧扩展面板 `aside` | 工作台 |
| `transcript` | 对话列表容器 | 工作台 |
| `empty-state` | 空状态 | 工作台 |
| `approval` | 审批区 | 工作台 |
| `composer` | 输入框外框 `form` | 工作台 |
| `composer-input` | 输入文本域 `textarea` | 工作台 |
| `icon` | 界面图标 `svg`（工作台 21 个） | 工作台 |
| `settings-pane` | 设置分页（工作台 3 个） | 工作台 |

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

### 2.3 特异性：为什么用钩子选择器就够，不需要 `!important`

皮肤样式表以 `adoptedStyleSheets` 注入，层叠顺序**永远在所有文档样式表之后**；
而层叠顺序只在**特异性相同**时才决定胜负。所以基础样式表里凡是你可能想覆盖的表面属性，
都**故意声明在 `data-agnes-region` 选择器 (0,1,0) 上**，而不是元素自己的 `#id` (1,0,0) 上。
你和基础样式同为 (0,1,0)，由顺序决定——你必胜。**因此不需要 `!important`。**

```css
/* 这样写就能生效：改输入框背景图 */
[data-agnes-region="composer"] {
  background-image: linear-gradient(160deg, #101820, #1d2b3a);
}
```

这条不变量有机检守卫（`packages/web/test/skin-regions.test.ts`）：谁把表面属性写回 `#id`，
守卫就会变红。

**一个例外：工作台设置弹窗。** 七个弹窗共用一个 `dialog` 钩子，而工作台设置（`#config`）
有自己不同的表面，因此它仍以 `#id` 声明。要覆盖它的表面：

- 优先用 **token**（`--agnes-bg-surface`、`--agnes-bg-page` 等在白名单里，改 token 一定生效）；
- 只有需要给它加**任意 CSS**（例如背景图）时才需要 `!important`。

其余弹窗、`settings-pane` 以及上表所有钩子都不需要 `!important`。

## 3. 语义 token 清单

这些是可以写进 `tokens` 的变量名。它们由 `packages/web/public/style.css` 生成，
**该样式表是唯一色彩权威**；增删 token 会让生成物失配并使 `gen:check` 失败。

<!-- theme-tokens:begin -->
--agnes-brand-primary
--agnes-brand-focus-ring
--agnes-brand-emphasis-soft
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
--agnes-bg-scrim
--agnes-surface-glass-soft
--agnes-surface-glass-hover
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
--shadow-elevation
--shadow-hairline
--shadow-dialog
--shadow-elevation-soft
--shadow-elevation-prominent
--agnes-bg-app-sidebar
--agnes-bg-app-content
--agnes-trace-track
--agnes-trace-row-current
--agnes-trace-row-hover
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
<!-- theme-tokens:end -->

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
  所以**相对引用与绝对路径两种写法都可靠**。

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
