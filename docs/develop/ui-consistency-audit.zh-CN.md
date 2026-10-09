# Web UI 源码清单与实施顺序

[English](ui-consistency-audit.md) | 简体中文

[一致性规范](ui-consistency.zh-CN.md)

源码基线：`901970ed3`（完整 SHA 见英文版）。这是内置 Web 界面的静态审计，不是视觉验收或实现完成声明。第三方插件自身内容不在有限清单内，其宿主包装、公开 UI 钩子在范围内。相同共享界面的变体按族归并，例如安装、信任、更新的确认弹窗。

共 98 界面族：29 页面、31 面板、18 对话框族、20 卡片族。覆盖 registry 的全部 25 个设置入口；可观测性与自动审核属于子面板而非独立路由。工作台面板按 register.tsx 和 Intelligent UI 注册入口核对。源码壳可能在运行时被替换，不能据此断言重复控件一定可见。

## 界面清单

C 原生控件；B 手写按钮/选择呈现；H 骨架/标题；S 尺度与字段；L 列表/元数据；E 状态；D 对话框页脚；I 本地化。“需视觉复核”不代表已观察到像素缺陷。英文版同名行给出具体源码现象。

| 类型 / 界面 | 入口 | 归属文件 | 当前组件 | 归并或复核项目 |
| --- | --- | --- | --- | --- |
| 页面 / `home` | /; 新会话 | `packages/web/src/app.ts` | region slots; Composer; ConversationMessages | 原生控件或静态回退壳需归并；手写动作/选择呈现需复用共享组件 |
| 页面 / `conversation` | /?session=<id> | `packages/web/src/conversation-message-adapter.tsx` | ConversationMessages; registered cards | 标题/骨架/动作位置需统一 |
| 页面 / `standalone-plugins` | /admin.html | `packages/web/public/admin.html` | PluginAdminPage; PluginList; native shell | 原生控件或静态回退壳需归并；标题/骨架/动作位置需统一；对话框正文/页脚需统一 |
| 页面 / `standalone-resources` | /resources.html | `packages/web/public/resources.html` | ResourceAdminPage; ResourceListContent; native shell | 原生控件或静态回退壳需归并；标题/骨架/动作位置需统一；对话框正文/页脚需统一 |
| 页面 / `settings-model` | / → 设置 → model | `packages/web-ui/src/settings-model-pane.tsx` | SettingsHub / SettingsModelPane; SettingsAccounts | 标题/骨架/动作位置需统一；对话框正文/页脚需统一 |
| 页面 / `settings-models` | / → 设置 → models | `packages/web-admin/src/admin/plugins/session-defaults-panel.tsx` | SettingsHub / SettingsCard; Field; SettingsInput; SettingsSelect | 标题/骨架/动作位置需统一；空态、加载、错误或状态反馈需统一 |
| 页面 / `settings-bundles` | / → 设置 → bundles | `packages/web-admin/src/admin/plugins/bundles-panel.tsx` | SettingsHub / SettingsCard; Field; Select; SettingsInput | 标题/骨架/动作位置需统一；列表/表格/元数据需统一呈现 |
| 页面 / `settings-engines` | / → 设置 → engines | `packages/web-admin/src/settings/child-engines.tsx` | SettingsHub / SettingsCard; SchemaConfigForm | 间距、字段或专用内容需视觉复核，保留行为 |
| 页面 / `settings-system-prompt` | / → 设置 → system-prompt | `packages/web-admin/src/settings/system-prompt.tsx` | SettingsHub / SettingsCard; SettingsTextArea; SettingsToolbar; SettingsState | 间距、字段或专用内容需视觉复核，保留行为 |
| 页面 / `settings-memory` | / → 设置 → memory | `packages/web-admin/src/settings/memory.tsx` | SettingsHub / SettingsCard; Field; SettingsSelect; SettingsTextArea; SettingsToolbar; SettingsState | 间距、字段或专用内容需视觉复核，保留行为 |
| 页面 / `settings-plugins` | / → 设置 → plugins | `packages/web-admin/src/admin/plugins/admin/page.tsx` | SettingsHub / SettingsHub; PluginList; OrphanPins | 原生控件或静态回退壳需归并；手写动作/选择呈现需复用共享组件；空态、加载、错误或状态反馈需统一 |
| 页面 / `settings-discover` | / → 设置 → discover | `packages/web-admin/src/admin/plugins/admin/views.tsx` | SettingsHub / PluginList; Select; SettingsDetails | 手写动作/选择呈现需复用共享组件；空态、加载、错误或状态反馈需统一 |
| 页面 / `settings-providers` | / → 设置 → providers | `packages/web-admin/src/settings/runtime-panels.tsx` | SettingsHub / SettingsCard; SettingsList; SettingsRow; SettingsDetails; Badge | 间距、字段或专用内容需视觉复核，保留行为 |
| 页面 / `settings-examples` | / → 设置 → examples | `packages/web-admin/src/settings/examples.tsx` | SettingsHub / SettingsCard; SettingsRow; Button; Badge | 间距、字段或专用内容需视觉复核，保留行为 |
| 页面 / `settings-skills` | / → 设置 → skills | `packages/resource-control-web/src/admin.tsx` | SettingsHub / ResourceListContent; SkillDetailContent; StateLights | 手写动作/选择呈现需复用共享组件；空态、加载、错误或状态反馈需统一；标题/骨架/动作位置需统一 |
| 页面 / `settings-mcp` | / → 设置 → mcp | `packages/resource-control-web/src/admin.tsx` | SettingsHub / ResourceListContent; McpDetailContent; createMcpForm | 原生控件或静态回退壳需归并；手写动作/选择呈现需复用共享组件；对话框正文/页脚需统一；宿主文案需补本地化 |
| 页面 / `settings-search` | / → 设置 → search | `packages/web-admin/src/settings/search.tsx` | SettingsHub / SettingsCard; SchemaConfigForm; SettingsInput; SettingsToolbar | 间距、字段或专用内容需视觉复核，保留行为 |
| 页面 / `settings-context` | / → 设置 → context | `packages/web-admin/src/settings/context.tsx` | SettingsHub / SettingsCard; SettingsInput; SettingsState; Button | 手写动作/选择呈现需复用共享组件；间距、字段或专用内容需视觉复核，保留行为 |
| 页面 / `settings-jobs` | / → 设置 → jobs | `packages/web-admin/src/settings/jobs-panel.tsx` | SettingsHub / SettingsCard; SettingsInput; SettingsSelect; SettingsState; Button | 列表/表格/元数据需统一呈现；标题/骨架/动作位置需统一 |
| 页面 / `settings-schedules` | / → 设置 → schedules | `packages/web-admin/src/settings/schedules.tsx` | SettingsHub / SettingsCard; SettingsInput; SettingsSelect; SettingsState; Button | 手写动作/选择呈现需复用共享组件；列表/表格/元数据需统一呈现 |
| 页面 / `settings-triggers` | / → 设置 → triggers | `packages/web-admin/src/settings/triggers.tsx` | SettingsHub / SettingsCard; Field; SettingsSelect; SettingsTextArea; SettingsToolbar | 列表/表格/元数据需统一呈现；空态、加载、错误或状态反馈需统一 |
| 页面 / `settings-terminal` | / → 设置 → terminal | `packages/web-admin/src/settings/jobs-panel.tsx` | SettingsHub / SettingsCard; SettingsTextArea; Button; SettingsState | 标题/骨架/动作位置需统一；间距、字段或专用内容需视觉复核，保留行为 |
| 页面 / `settings-security` | / → 设置 → security | `packages/web-admin/src/settings/runtime-panels.tsx` | SettingsHub / SettingsCard; Badge; AutoReviewPanel | 标题/骨架/动作位置需统一；空态、加载、错误或状态反馈需统一 |
| 页面 / `settings-diagnostics` | / → 设置 → diagnostics | `packages/web-admin/src/settings/diagnostics.tsx` | SettingsHub / SettingsCard; SettingsRow; SettingsState; DoctorChecks; ObservabilityPanel | 标题/骨架/动作位置需统一；列表/表格/元数据需统一呈现 |
| 页面 / `settings-history` | / → 设置 → history | `packages/web-admin/src/settings/history.tsx` | SettingsHub / SettingsCard; SettingsInput; SettingsState; Button | 列表/表格/元数据需统一呈现；间距、字段或专用内容需视觉复核，保留行为 |
| 页面 / `settings-archived` | / → 设置 → archived | `packages/web/src/session-actions.ts` | SettingsHub / native template search; DOM rows/buttons | 原生控件或静态回退壳需归并；手写动作/选择呈现需复用共享组件；空态、加载、错误或状态反馈需统一 |
| 页面 / `settings-feedback` | / → 设置 → feedback | `packages/web-admin/src/settings/feedback.tsx` | SettingsHub / SettingsCard; Field; SettingsSelect; Button | 原生控件或静态回退壳需归并；空态、加载、错误或状态反馈需统一；列表/表格/元数据需统一呈现 |
| 页面 / `settings-computer-use` | / → 设置 → computer-use | `packages/web-ui/src/settings-computer-use.tsx` | SettingsHub / SettingsComputerUse; SettingsPage; Button | 间距、字段或专用内容需视觉复核，保留行为 |
| 页面 / `settings-general` | / → 设置 → general | `packages/web-foundation/src/appearance.ts` | SettingsHub / React radio input; native template fieldsets | 原生控件或静态回退壳需归并；标题/骨架/动作位置需统一 |
| 面板 / `auto-review` | 所属页 / 注册面板 | `packages/web-admin/src/settings/auto-review.tsx` | SettingsCard; SettingsCheckbox; SettingsSelect; SettingsInput; Button | 空态、加载、错误或状态反馈需统一；间距、字段或专用内容需视觉复核，保留行为 |
| 面板 / `observability` | 所属页 / 注册面板 | `packages/web-admin/src/settings/observability.tsx` | SettingsCard; SettingsState; SettingsDetails; SettingsToolbar | 列表/表格/元数据需统一呈现；间距、字段或专用内容需视觉复核，保留行为 |
| 面板 / `doctor` | 所属页 / 注册面板 | `packages/web-admin/src/settings/doctor.tsx` | DoctorChecks; SettingsToolbar; SettingsState | 间距、字段或专用内容需视觉复核，保留行为 |
| 面板 / `generations` | 所属页 / 注册面板 | `packages/web-admin/src/settings/runtime-panels.tsx` | SettingsCard; SettingsRow; Badge | 列表/表格/元数据需统一呈现 |
| 面板 / `publication` | 所属页 / 注册面板 | `packages/web-admin/src/settings/runtime-panels.tsx` | SettingsCard; SettingsRow | 列表/表格/元数据需统一呈现 |
| 面板 / `local-plugins` | 所属页 / 注册面板 | `packages/web-admin/src/settings/runtime-panels.tsx` | SettingsCard; Button | 列表/表格/元数据需统一呈现；空态、加载、错误或状态反馈需统一 |
| 面板 / `presets` | 所属页 / 注册面板 | `packages/web-admin/src/settings/runtime-panels.tsx` | SettingsCard; SettingsRow | 间距、字段或专用内容需视觉复核，保留行为 |
| 面板 / `account-network` | 所属页 / 注册面板 | `packages/web-admin/src/settings/account-network.tsx` | SchemaConfigFields; Field | 间距、字段或专用内容需视觉复核，保留行为 |
| 面板 / `session-tools` | 所属页 / 注册面板 | `packages/web-admin/src/settings/session-tools.tsx` | SettingsDetails; Button | 列表/表格/元数据需统一呈现 |
| 面板 / `files` | 所属页 / 注册面板 | `packages/web-conversation/src/workbench/files-panel.tsx` | Button; SettingsState | 标题/骨架/动作位置需统一；列表/表格/元数据需统一呈现 |
| 面板 / `changes` | 所属页 / 注册面板 | `packages/web-conversation/src/workbench/changes-panel.tsx` | Button; Select; SettingsState | 标题/骨架/动作位置需统一；列表/表格/元数据需统一呈现 |
| 面板 / `facts` | 所属页 / 注册面板 | `packages/web-conversation/src/workbench/fact-chain-panel.tsx` | Button; FeedbackProvenance; ReviewEvidence | 空态、加载、错误或状态反馈需统一；列表/表格/元数据需统一呈现 |
| 面板 / `goal` | 所属页 / 注册面板 | `packages/web-conversation/src/workbench/goal-panel.tsx` | SettingsState | 标题/骨架/动作位置需统一；列表/表格/元数据需统一呈现 |
| 面板 / `workbench-terminal` | 所属页 / 注册面板 | `packages/web-conversation/src/workbench/terminal-panel.tsx` | Button; Field; SettingsInput; SettingsSelect; SettingsState | 原生控件或静态回退壳需归并；标题/骨架/动作位置需统一 |
| 面板 / `workbench-feedback` | 所属页 / 注册面板 | `packages/web-conversation/src/workbench/feedback-panel.tsx` | FeedbackForm; FeedbackProvenance | 标题/骨架/动作位置需统一；空态、加载、错误或状态反馈需统一 |
| 面板 / `review-evidence` | 所属页 / 注册面板 | `packages/web-conversation/src/workbench/review-evidence.tsx` | Button | 间距、字段或专用内容需视觉复核，保留行为；空态、加载、错误或状态反馈需统一 |
| 面板 / `intelligent-workbench` | 所属页 / 注册面板 | `packages/web/src/intelligent-ui/placements.tsx` | IntelligentSurface; Button | 空态、加载、错误或状态反馈需统一；标题/骨架/动作位置需统一 |
| 面板 / `trace` | 所属页 / 注册面板 | `packages/web-units/src/trace.ts` | React DOM; request trace component | 原生控件或静态回退壳需归并；手写动作/选择呈现需复用共享组件；标题/骨架/动作位置需统一 |
| 面板 / `request-trace` | 所属页 / 注册面板 | `packages/web-units/src/trace-request.tsx` | Button; SettingsCode | 列表/表格/元数据需统一呈现；间距、字段或专用内容需视觉复核，保留行为 |
| 面板 / `transcript` | 所属页 / 注册面板 | `packages/web-units/src/transcript.ts` | React DOM | 标题/骨架/动作位置需统一；空态、加载、错误或状态反馈需统一 |
| 面板 / `computer-use-session` | 所属页 / 注册面板 | `packages/web-conversation/src/computer-use-pane.tsx` | Button; shared screen region | 间距、字段或专用内容需视觉复核，保留行为；空态、加载、错误或状态反馈需统一 |
| 面板 / `composer` | 所属页 / 注册面板 | `packages/web-units/src/composer.ts` | React textarea; native actions; ReferencePicker | 原生控件或静态回退壳需归并；手写动作/选择呈现需复用共享组件 |
| 面板 / `child-controls` | 所属页 / 注册面板 | `packages/web-units/src/composer/child-controls.ts` | React input/Button | 原生控件或静态回退壳需归并；间距、字段或专用内容需视觉复核，保留行为 |
| 面板 / `queue-editor` | 所属页 / 注册面板 | `packages/web-units/src/composer/queue-editor.ts` | React textarea/Button | 原生控件或静态回退壳需归并；间距、字段或专用内容需视觉复核，保留行为 |
| 面板 / `sidebar` | 所属页 / 注册面板 | `packages/web-units/src/sidebar.ts` | React DOM | 手写动作/选择呈现需复用共享组件；标题/骨架/动作位置需统一 |
| 面板 / `topbar` | 所属页 / 注册面板 | `packages/web-units/src/topbar.ts` | React DOM | 手写动作/选择呈现需复用共享组件；标题/骨架/动作位置需统一 |
| 面板 / `plugin-config` | 所属页 / 注册面板 | `packages/web-admin/src/admin/plugins/config-tab.tsx` | Dialog; PluginConfigPanel | 标题/骨架/动作位置需统一；对话框正文/页脚需统一 |
| 面板 / `plugin-config-form` | 所属页 / 注册面板 | `packages/web-admin/src/admin/plugins/config-panel.tsx` | PluginSchemaFields; Button | 空态、加载、错误或状态反馈需统一；间距、字段或专用内容需视觉复核，保留行为 |
| 面板 / `candidate-list` | 所属页 / 注册面板 | `packages/web-admin/src/admin/plugins/candidates.tsx` | CandidateListFacts; Button; Badge | 列表/表格/元数据需统一呈现；空态、加载、错误或状态反馈需统一 |
| 面板 / `candidate-review` | 所属页 / 注册面板 | `packages/web-admin/src/admin/plugins/candidate-review.tsx` | Badge; CandidateFileDiff; CandidateTechnical | 列表/表格/元数据需统一呈现；间距、字段或专用内容需视觉复核，保留行为 |
| 面板 / `capability-provenance` | 所属页 / 注册面板 | `packages/web-admin/src/admin/plugins/capability-review.tsx` | CapabilityReview; ProvenanceReview | 标题/骨架/动作位置需统一；列表/表格/元数据需统一呈现 |
| 对话框族 / `workspace` | / → 选择工作区 | `packages/web/src/workspace-picker.ts` | native dialog; DOM controller | 原生控件或静态回退壳需归并；手写动作/选择呈现需复用共享组件；对话框正文/页脚需统一 |
| 对话框族 / `setup-guide` | / → 首次使用 | `packages/web-ui/src/first-run.tsx` | Dialog; Field; Select; SettingsState; Button | 间距、字段或专用内容需视觉复核，保留行为 |
| 对话框族 / `account` | 设置 → model → add/edit | `packages/web-ui/src/settings-account-dialog.tsx` | SettingsOptionSelect; native fields/buttons | 原生控件或静态回退壳需归并；手写动作/选择呈现需复用共享组件；对话框正文/页脚需统一 |
| 对话框族 / `oauth` | Account → auth method | `packages/web-admin/src/oauth-controls.ts` | React password input; Button | 原生控件或静态回退壳需归并；空态、加载、错误或状态反馈需统一 |
| 对话框族 / `model-picker` | composer → model | `packages/web/src/model-picker.ts` | React input; custom menu | 原生控件或静态回退壳需归并；手写动作/选择呈现需复用共享组件 |
| 对话框族 / `agent-options` | composer → agent | `packages/web-admin/src/permission-picker.ts` | Select; Popover; React DOM | 间距、字段或专用内容需视觉复核，保留行为 |
| 对话框族 / `reference-picker` | composer → attach reference | `packages/web-units/src/reference-picker.tsx` | Popover; Button; SettingsInput | 间距、字段或专用内容需视觉复核，保留行为 |
| 对话框族 / `session-rename` | sidebar → rename | `packages/web/src/session-actions.ts` | native dialog + innerHTML | 原生控件或静态回退壳需归并；手写动作/选择呈现需复用共享组件；对话框正文/页脚需统一 |
| 对话框族 / `plugin-source` | plugin page → install source | `packages/web-ui/src/admin-dialogs.tsx` | SourceDialogContent; SettingsInput; SettingsSelect | 原生控件或静态回退壳需归并；手写动作/选择呈现需复用共享组件；对话框正文/页脚需统一 |
| 对话框族 / `plugin-detail` | plugin row → detail | `packages/web-ui/src/admin-detail.tsx` | DetailContent; StateLights; native actions | 手写动作/选择呈现需复用共享组件；标题/骨架/动作位置需统一；对话框正文/页脚需统一 |
| 对话框族 / `plugin-confirm` | plugin install/trust/update/remove | `packages/web-ui/src/admin-dialogs.tsx` | ConfirmDialogContent; confirmation facts | 手写动作/选择呈现需复用共享组件；对话框正文/页脚需统一 |
| 对话框族 / `admin-confirm` | resource action → confirm | `packages/web-ui/src/admin-confirmation.tsx` | AdminConfirmContent | 手写动作/选择呈现需复用共享组件；对话框正文/页脚需统一 |
| 对话框族 / `skill-detail` | Skills → row | `packages/web-ui/src/resource-detail.tsx` | SkillDetailContent; StateLights | 手写动作/选择呈现需复用共享组件；对话框正文/页脚需统一；列表/表格/元数据需统一呈现 |
| 对话框族 / `mcp-detail` | MCP → row | `packages/web-ui/src/resource-detail.tsx` | McpDetailContent; StateLights | 手写动作/选择呈现需复用共享组件；对话框正文/页脚需统一；列表/表格/元数据需统一呈现 |
| 对话框族 / `mcp-form` | MCP → add/edit | `packages/resource-control-web/src/mcp-form.ts` | native HTML controls + SelectPicker bridge | 原生控件或静态回退壳需归并；宿主文案需补本地化；对话框正文/页脚需统一 |
| 对话框族 / `feedback-form` | message → feedback | `packages/web-units/src/message-feedback/form.tsx` | Field; SettingsSelect; SettingsTextArea; Button | 间距、字段或专用内容需视觉复核，保留行为 |
| 对话框族 / `diagnostics-bundle` | conversation → diagnostics | `packages/web-ui/src/diagnostics-dialog.tsx` | Dialog; Button | 对话框正文/页脚需统一；列表/表格/元数据需统一呈现 |
| 对话框族 / `generic-confirm` | existing confirmation calls | `packages/web-ui/src/confirm.ts` | shared confirm factory | 对话框正文/页脚需统一 |
| 卡片族 / `message` | 会话 / 所属面板 | `packages/web-ui/src/conversation/messages.tsx` | ConversationMessages; message variants | 间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `tool` | 会话 / 所属面板 | `packages/web-ui/src/conversation/messages/tool-card.tsx` | ConversationToolCard; ConversationCardLayout | 间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `approval` | 会话 / 所属面板 | `packages/web-units/src/approval.ts` | React DOM; Approval actions | 手写动作/选择呈现需复用共享组件；空态、加载、错误或状态反馈需统一 |
| 卡片族 / `goal` | 会话 / 所属面板 | `packages/web-conversation/src/goal-card.tsx` | ConversationCardLayout; Button; Badge | 间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `workflow` | 会话 / 所属面板 | `packages/web-conversation/src/workflow-run-card.tsx` | ConversationCardLayout | 列表/表格/元数据需统一呈现；间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `question` | 会话 / 所属面板 | `packages/web-conversation/src/default-tool-cards.tsx` | ConversationCardLayout; SettingsInput; SettingsTextArea; Button | 间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `deliverable` | 会话 / 所属面板 | `packages/web-conversation/src/default-tool-cards.tsx` | ConversationCardLayout; document preview | 间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `schedule` | 会话 / 所属面板 | `packages/web-conversation/src/default-tool-cards.tsx` | ConversationCardLayout; Button | 间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `background-job` | 会话 / 所属面板 | `packages/web-conversation/src/conversation-registry.tsx` | ConversationCardLayout | 间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `child-agent` | 会话 / 所属面板 | `packages/web-conversation/src/conversation-registry.tsx` | ConversationCardLayout | 间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `plugin` | 会话 / 所属面板 | `packages/web-conversation/src/conversation-registry.tsx` | ConversationCardLayout | 间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `interaction-result` | 会话 / 所属面板 | `packages/web-ui/src/conversation/interaction-result.tsx` | ConversationInteractionResult | 间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `feedback-provenance` | 会话 / 所属面板 | `packages/web-units/src/message-feedback/provenance.tsx` | FeedbackProvenance | 空态、加载、错误或状态反馈需统一；列表/表格/元数据需统一呈现 |
| 卡片族 / `document-preview` | 会话 / 所属面板 | `packages/web-ui/src/conversation/document-preview.tsx` | DocumentPreview | 间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `intelligent-surface` | 会话 / 所属面板 | `packages/web-ui/src/intelligent-ui/surface.tsx` | IntelligentSurface; Button | 空态、加载、错误或状态反馈需统一；间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `intelligent-catalog` | 会话 / 所属面板 | `packages/web-ui/src/intelligent-ui/catalog.tsx` | Field; SettingsInput; SettingsTextArea; Select; Button | 原生控件或静态回退壳需归并；列表/表格/元数据需统一呈现 |
| 卡片族 / `intelligent-chart` | 会话 / 所属面板 | `packages/web-ui/src/intelligent-ui/chart.tsx` | SVG chart + semantic table | 间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `prompt-source` | 会话 / 所属面板 | `packages/web-admin/src/settings/system-prompt.tsx` | SettingsCode; SettingsDetails | 间距、字段或专用内容需视觉复核，保留行为 |
| 卡片族 / `doctor-notice` | 会话 / 所属面板 | `packages/web-ui/src/first-run.tsx` | DoctorNotice; Button | 标题/骨架/动作位置需统一 |
| 卡片族 / `offline-diagnostics` | 会话 / 所属面板 | `packages/web-units/src/diagnostics-viewer.ts` | generated standalone HTML viewer | 列表/表格/元数据需统一呈现；间距、字段或专用内容需视觉复核，保留行为 |

## 已确认的源码发现

- web-ui 外 TS/TSX 31 处声明、11 文件：21 JSX/模板元素，10 React.createElement。settings.ts 模板有 18 处，包括已被共享账户组件替换的回退壳。mcp-form.ts 中 select 是注释，不是控件构造。不能把 React.createElement 混算为 DOM API。
- HTML 30 处：index 15、resources 12、admin 3。源码与静态回退独立计数，不代表 61 个可见控件；源码级迁移必须清除两者的重复控件。
- web-ui 内部有 17 个原生 JSX 控件、1 个临时剪贴板 DOM textarea。库内原生语义实现合法；账户表单、列表/详情动作仍需共享呈现。显式 document/doc 原生控件构造扫描在调用方为 0，库内唯一为剪贴板回退。普通 DOM 构造仍在菜单、归档行、壳宿主和离线诊断查看器中。
- feedback.tsx:42 使用普通 input；error/empty 为普通段落，pending fetch 缺少专用 loading 呈现。auto-review.tsx:229 失败时只改 role 未选 error tone，clear/save 未用共享 toolbar。
- bundles-panel.tsx:117 在 hub 已有标题的页内放 h2；session-defaults-panel.tsx:108 手写标题，未使用 SettingsCard 的 title 槽。
- index.html:174 的 HTTP Header 无 i18n；resources 对应字段已本地化。协议示例及凭据引用语法保留原样。
- 02-base-controls 全局控制原生元素，17-settings-forms 与 web-ui/tokens 再叠控制器/toolbar 样式，19-settings-runtime-overrides 又覆盖。按组件归属归并，不直接删掉全局 reset。17-settings-forms.css:309、470 使用尺度外 0.6875rem；Intelligent UI 重复字面 8/12/20px。
- 除 token 权威外，公开 CSS 仅 13-turn-process.css:561–562 使用 #000 radial mask，属于蒙版几何而非状态裸色。Intelligent UI 已用语义色。未发现已确认的深色 token 或图标缺陷；这些仍需截图核对。
- no-create-element guard 覆盖 27 文件，管命令式 DOM 回退，不管原生控件归属或视觉统一。只有真实迁移所有权后才追加文件，不能弱化守卫。

## 实施顺序与估算

行数是 additions + deletions 的估计，不是硬上限。各组有文件交叉，按组件组相加；保持行为、ID、ARIA、语言目录、皮肤钩子和后端合同。

| 顺序 / 组件工作组 | 范围 | 主要归属 | 预计增删行 |
| --- | --- | --- | --- |
| 1 共享控件/动作呈现 | 调用方 31 + HTML 30 声明；上传例外 1；共享列表/详情按钮族 | web-ui/settings-layout、settings-account-dialog、admin-list/detail/dialogs、resource-list/detail | 500–850 |
| 2 调用方表单迁移 | composer、queue、child、trace 3 控件、模型搜索、OAuth、反馈、重命名、工作区、MCP、外观 | web-units、web、web-admin、resource-control-web；保留 event/ref/DOM 合同 | 450–750 |
| 3 骨架/标题/页脚 | 29 页面、31 面板、18 对话框族 | SettingsHub、原生桥接、独立 HTML、共享对话框内容、工作台 | 250–450 |
| 4 状态/列表/徽标 | 反馈、自动审核、资源/插件、诊断/OTLP、触发器、历史、工作台、Intelligent UI | SettingsState、List/Row、ConversationCardLayout、Badge/StateLights | 250–450 |
| 5 CSS 尺度归并 | 审查 26 公开样式模块、主题桥、Intelligent UI；仅改重复控件/布局规则 | 02、10、15、17、19、25 样式；web-ui/tokens.css | 180–320 |
| 6 文档与必要回归用例 | 扩展已有合同用例；纯间距不添加实现镜像测试 | 相关包与既有 Web 交互/截图 spec | 80–180 |

合计 1,710–3,000 增删行，按共享组件归属分批。预计不新增依赖。只为确认缺失的语义角色补 token，浅深成对，并更新生成的公共皮肤合同。

| 页面组按用户影响排序 | 可见结果 | 预计行数（已包含上表） |
| --- | --- | --- |
| 主会话/输入区及工作区、模型、重命名弹窗 | 共享字段/动作；保留选区、IME、键盘、上传 | 220–380 |
| 账户/通用设置/配置 | 共享标签、控件、页脚，保留 radio/native-select 事件 | 250–450 |
| 插件/发现/类型/示例及来源、详情、审核、配置弹窗 | 统一标题/动作/行/状态 | 280–480 |
| Skills/MCP 内嵌及独立页 | 共享骨架、控件、错误、凭据说明、确认页脚；删除重复静态壳 | 250–450 |
| 反馈/记忆/搜索/上下文/系统提示词 | 共用工具栏/状态/列表；明确 loading/error tone | 150–260 |
| 诊断/可观测性/安全/自动审核 | 一致的小节标题、状态摘要、表单页脚 | 120–220 |
| jobs/计划任务/触发器/历史/归档 | 一致的筛选、元数据、行操作、空态/错误 | 180–300 |
| 工作台/Intelligent UI/会话卡片 | 统一标题/动作/状态，保留专用内容几何 | 200–350 |

## 截图矩阵与实施门

逐界面族采集 en/zh-CN × light/dark × 桌面 1280×900 / 窄屏 390×844，before/after 同名同合成数据。页面每个配置需一个可见入口，弹窗/面板/卡片需明确状态构造。长页面另补滚动帧，不能把一张 viewport 截图当作覆盖全部正文。不得包含真实凭据或调用外部模型。

本静态审计版本尚未截图。当前 checkout 没有依赖、打包 runtime/Web 产物；标准 e2e 入口会自动 build/typecheck，在禁止构建约束下不能调用。历史 baseline 不能复制为当前截图。需要兼容的现成合成环境，并记录源码 revision、构建来源和覆盖范围；实施必须等待明确的阶段授权。
