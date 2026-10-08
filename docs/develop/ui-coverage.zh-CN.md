# Web UI 能力覆盖

[English](ui-coverage.md) | 简体中文

一个设置外壳管理导航、布局、键盘标签页和 `?settings=<section-id>` 深链；`/admin/plugins` 转到同一外壳。分组为：模型与账户、Agent、插件、技能、MCP、工具与搜索、自动化、安全、历史与归档、Computer Use、通用。Agent 包含 Agent Loop、组合包与预设、子代理；插件包含已安装与发现、插件实现、示例与 FDE。技能和 MCP 各出现一次，原账户及资源控制器通过注册桥接保留。参见[注册接口](ui-extension-registries.zh-CN.md)和[术语表](ui-glossary.zh-CN.md)。

| 能力 | 界面 | 边界 |
| --- | --- | --- |
| 插件生命周期 | 来源检查、能力审阅、安装、信任并启用、更新、回滚、移除 | 保留权限与确认；操作完成和实际状态分别展示 |
| 插件实现与类型 | 类型筛选、能力、版本、来源、作用域、重启要求 | 真实目录的描述，不授予执行权限 |
| 插件代际、发布、迁移 | 绑定、发布状态、孤立绑定释放、迁移确认 | 后端决定兼容性及拒绝；不伪造成功 |
| 默认 Agent Loop、模型、组合包及预设 | 修订检查保存，继承结果和来源，友好名称与次级版本 | 新会话采用默认值，旧会话保持绑定；单项不重复下拉 |
| 输入区 | 一个 Agent 芯片包含 Agent Loop、有序组合包及权限预设 | 保留模型、工作区和权限行为 |
| 会话能力 | SessionToolsPanel 展示 SessionCapabilitySet 有效选择、启用/禁用项和 source/rule 来源 | A4 拥有数据形状；兼容旧 toolGroups，不改变授权 |
| 技能、MCP | 独立设置区，原控制器及工作区作用域 | 信任、认证、启用和移除仍由后端处理 |
| 官方示例 | 仓库外也列出 2 个官方 Loop、12 个 FDE 组合包和 3 个社区示例；直接安装入口 | 固定打包白名单，正常审阅、安装、信任启用；不代表业务系统已接通 |
| 工具、上下文、自动化 | 搜索、上下文、作业、日程、终端使用共享卡片、字段及状态 | 服务缺失、失败、加载和只读状态明确 |
| 安全、历史、Computer Use | 沙箱事实、权限预设、历史和归档，原 Computer Use 控制器 | 不增加权限和探测，宽表内部滚动 |
| 对话卡片 | 问题、计划、交付物、作业、子代理、工作流、目标、日程、插件通过注册 API 渲染 | 保留槽位生命周期、文件授权及审批身份 |
| 主题与语言 | en/zh 目录、令牌、弹窗联动、区域化日期和安全失败提示 | 机器 ID 与诊断数据不翻译 |

## 维护中的合并门禁

`pnpm e2e:web` 构建或校验可复用的本地构建，从仓库根目录启动真实 daemon/Web launcher，使用全新隔离 home 和缓存 Chromium 离线运行 SDK 与基于角色/test ID 的 UI 规格。UI 矩阵覆盖 en/zh-CN、浅色/深色及所有设置分区；变更流程通过公开 SDK/CLI 核验持久化结果。未解析翻译键、axe 违规、console error 和 pageerror 均使门禁失败。视觉比较只使用清单中已审核的基线，像素差异容忍度为 0.2%，正常运行不会自动生成缺失基线。53 个声明屏幕均已有审核过的 macOS 与 Linux 基线，包括插件类型行间距及 Discover 分组版本选择。覆盖范围、产物路径、CI 必需状态与本地基线审核步骤见[门禁说明](../../tools/e2e-web/README.md)。

## 浏览器验收

```sh
AGH_WEB_URL=http://127.0.0.1:PORT pnpm test:web-smoke
pnpm test:web-smoke --list
```

运行器使用已安装或缓存的 Playwright/Chromium，不下载浏览器。`AGH_PLAYWRIGHT_PACKAGE` 指定包目录，`AGH_CHROMIUM_PATH` 指定浏览器，`AGH_WEB_TEST_OUTPUT` 指定跟踪目录。变更性用例仅用于隔离合成 home/server。

- `navigation.spec.ts`：双语导航、插件实现目录、旧路由、375px 和宽表键盘滚动。可选 `AGH_MIGRATION_SESSION` 启用迁移确认。
- `ui-quality.spec.ts`：1440×900、1280×800，浅色/深色，en/zh 共 8 个组合；覆盖空首页、真实 demo 会话及卡片、全部设置目的地、账户及来源安装弹窗。每屏检查未解析键、溢出和异常。
- `examples.spec.ts`：显式 `AGH_INSTALL_EXAMPLES=1` 才运行审阅、安装、信任启用、打开弹窗时切换语言、新会话 Loop 选择。
- `locale-catalogs.test.ts`：递归检查四个前端包的 en/zh 键一致、文案非空。

`AGH_UI_REPORT` 保存截图；`AGH_UI_WORKSPACE` 指向合成工作区；可选 `AGH_UI_DELIVERABLE` 指定合成文件。报告记录实际命令与结果；截图不能替代沙箱拒绝、更新/回滚、资源变更和业务集成验收。

设置 ID 和角色见[注册接口](ui-extension-registries.zh-CN.md)。输入区保留 `composer-agent`、`agent-options`、`new-session-loop` / `new-session-loop-readonly`、`new-session-bundles`、`new-session-preset` / `new-session-preset-readonly`。其他 ID 包括 `providers-*`、`security-*`、`plugin-generations`、`composition-publication`、`bundle-order`、`config-dump`、`config-choice-sources`。

## 对话布局验收

```sh
pnpm --filter @agnes/web build
node tools/e2e-web/serve-conversation-fixture.mjs
# 使用打印的回环地址
AGH_WEB_URL=http://127.0.0.1:PORT AGH_CONVERSATION_FIXTURE_URL=http://127.0.0.1:PORT pnpm test:web-smoke conversation.spec.ts
```

夹具使用生产组件及样式、合成 session/resource 端口，验证问题提交、下载、作业/子代理详情、过程折叠和计划允许/拒绝。真实 daemon demo 回合另外覆盖问题、交付物及作业卡片。组件夹具不能证明后端授权。

稳定 ID：`question-card`、`question-field`、`question-option`、`question-free-text`、`question-submit`、`deliverable-card`、`deliverable-open`、`deliverable-download`、`background-job-card`、`child-agent-card`、`tool-detail-toggle`、`tool-detail-text`、`turn-process-toggle`、`plan-approval-card`、`approval-card`、`approval-preview`、`approval-action`。重复 ID 用 `[data-node-id]`、`[data-question-id]`、`[data-artifact-sha256]` 或 `[data-tool-name]` 限定。审批保留 `data-approval-action`，不按位置选择。

设置 `AGH_UI_AXE=1` 后，截图矩阵会检查中英文、浅深色的每个 1440 像素页面及弹窗的 WCAG A/AA 问题。递归语言键集检查还覆盖资源设置包。测试使用仓库锁定的 Playwright 和本机已安装的 Chromium。

设置 `AGH_UI_ISOLATED=1` 后，每个矩阵用例会启动独立的真实 daemon 和合成工作区，并自动创建用于交付物卡片的文件。

## Schema 配置合同

参见 [schema 配置 UI](../extend/configuration-ui.zh-CN.md)。搜索和子代理控件保留原有 ID、操作和保存接口；MCP 管理表单复用共享的引用校验。沙箱、压缩和持久化表单声明取自公开生成 schema，接受调用方提供的权威值与适配器；目录不公开私有配置。配置页面声明负责加载、重试、修订号保留和资源切换取消。

稳定 ID：`<declaration.testId>`、`<declaration.testId>-form`、`search-edit-provider`、`search-endpoint`、`search-max-results`、`search-timeout`、`search-rate`、`child-engine-<engine>-<field>`、`provider-<kind>-config`。发现页每包一张卡片；`plugin-other-versions` 和 `plugin-version-picker` 按 `.plugin-row[data-plugin-id]` 定位。版本切换改变正常审查安装时使用的来源；已安装版本仍独立展示。
