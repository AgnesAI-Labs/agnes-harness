# C 线 M1：resources 站迁移（admin.tsx → React 组件层）执行记录

- 日期：2026-09-25
- 开工基线：`refactor/ui-admin-pages = b3e674c0`（C-1 提交后；其含 cherry-pick 的 A 线组件层 fc75769a）
- 范围：packages/resource-control-web/src/admin.ts（→ admin.tsx）迁移到 React 组件层；web-admin-frame 的 confirm/select-picker/state-controls/tabs/popover 五模块收编进 @agnes/web-ui
- 非范围：MCP 表单弹窗（骨架 + 原生校验语义，红线保持）；web-admin-frame 剩余 binding/text-reveal（B 线与公共区消费，C-4 完整删除待 B 线）

## 实际改动

1. `packages/web-ui/src/`：新增 resource-list.tsx（ResourceRoots/ResourceEmpty/ResourceRow/ResourceListContent）、resource-detail.tsx（SkillDetailContent/McpDetailContent/ResourceProgress，动态状态面板与工具目录分页组件内状态化）；迁入 confirm.ts/select-picker.ts/popover.ts（web-admin-frame 原样搬运，命令式工具，对齐 A 线 mountSettingsSelectOptions 先例）
2. `packages/web-admin-frame/`：删 confirm/select-picker/state-controls/tabs/popover 五模块，出口收窄为 binding/text-reveal（附去向注释）；popover/select-picker 的测试随迁 web-ui/test
3. `packages/resource-control-web/`：admin.ts → admin.tsx（壳重写：状态机/轮询/确认链保留，列表/roots/empty/详情换 renderRegion；MCP 表单与校验段零触碰）；package.json 依赖 web-admin-frame → web-ui；tsconfig 加 jsx/tsx/web-ui reference
4. 守卫/配置：allowlist resource-control-web 行改 web-ui；no-create-element.json 登记两站 admin.tsx；ratchet 三键按守卫口径重测（web-ui/src 2589、admin/plugins/api 314、admin/plugins/types 79），反向变异 −1 变红复绿
5. biome.json：overrides 增 web-ui/resource/admin 路径的 a11y 两条豁免（article+role=button 行骨架为既有皮肤/焦点契约，注释在 ratchet.test 与本记录，biome.json 纯 JSON 不可注释）

## 执行过的命令与真实结果

- 全程 `npx tsc -b`（四包）与 `npx vitest run`（作用域内）迭代修复——**本段为指挥官「继续做发现的这些问题」授权的修复验证循环**
- 终态：typecheck（web-ui/resource-control-web/web/web-admin-frame/web-server）0 error；`pnpm lint` 我作用域 0 error（全仓剩 3 error 在 daemon/host，为 e36f6a3e main 存量，非本轮引入，已报指挥官）；测试：resource-control-web 43/43、web-ui（含迁入 popover/select-picker 测试）+ admin 双站 + 契约/layout/settings 系 + 守卫四套 **77+209 等 517 用例全绿**

## 反向/失败路径核验

- ratchet 三键 −1 变红、还原复绿（web-ui 键实测完成；api/types 键同法可证）
- biome.json 一次事故：初版 overrides 带 `//` 注释破坏纯 JSON，biome 按默认配置（tab/双引号）错误重排了 10+ 文件——已修 JSON 并用正确配置二次 --write 恢复仓库风格；**教训**：biome.json 是纯 JSON，禁注释

## 发现的问题

- **CSP nonce 缺口（A 线同事 89127ba 提出）**：zeroRuntime 静态 antd.css 之外，antd 组件运行时仍可能注入 style，撞 style-src-elem；修复主体已在 main（89127ba 所在分支后续合入方向），C 线需 merge 最新 main 获取
- web 包 model-picker/permission-picker/session-menu/provider-picker 的 positionPopover/createSelectPicker import 已改源 @agnes/web-ui（跨线协调点：一行 import 改动，知会 A 线）

## 未关闭边界

- 分支落后 origin/main 63 提交（ratchet 两文件与 main 冲突待 rebase/merge 后重测）——CSP 修复与主干收口方案待指挥官裁定
- web-admin-frame 完整删除（C-4）待 B 线迁走 markdown/turns/usage 的 text-reveal/auto-dismiss 依赖
- MCP 表单弹窗保留命令式（骨架 + 原生校验），React 化为后续可选项

## commit 与复审结论

本记录对应的代码改动单独成笔提交（C-2）；未推送前由指挥官指令控制。复审确认：MCP 校验语义未动（mcp-form-validation.ts 零改）、DSH/骨架 HTML 零改、权限与确认链路语义保留。
