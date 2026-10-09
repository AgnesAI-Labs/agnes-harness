# Web UI source inventory and implementation sequence

English | [简体中文](ui-consistency-audit.zh-CN.md)

[Consistency contract](ui-consistency.md)

Source baseline: `901970ed38ac4046fffe91652f7ddee449ebb779`. This is a static audit of built-in Web surfaces, not visual acceptance or completed implementation. Third-party plugin bodies are outside this finite inventory; their host wrappers and public UI hooks are covered. Variants of a single shared surface are grouped into one family (for example install/trust/update confirmation). A source declaration can be replaced at runtime; it is not proof of a second visible field.

The inventory contains 29 pages, 31 panels, 18 dialogs, 20 cards (98 total). All 25 settings entries registered by `web-admin/src/settings/registry.tsx` are included, plus the main/standalone pages. Observability and auto review are nested panels rather than extra routes. Workbench panels come from `web-conversation/src/workbench/register.tsx` and Intelligent UI placement registration.

Codes: **C** raw/native controls; **B** hand-rolled actions/choice presentation; **H** header/skeleton inconsistency; **S** scale/control spacing to consolidate or visually verify; **L** list/table/metadata presentation; **E** empty/loading/error/status presentation; **D** dialog/footer; **I** localization. “Visual verification pending” and “inspect” are verification requirements, not observed pixel defects. No missing dark token or icon defect is asserted without evidence.

## Surface inventory

| Kind / surface | Entry | Owning source | Components now | Deviation / review requirement |
| --- | --- | --- | --- | --- |
| page / `home` | /; new session | `packages/web/src/app.ts` | region slots; Composer; ConversationMessages | C/B: shell native buttons; page states spread across region owners; visual verification pending |
| page / `conversation` | /?session=<id> | `packages/web/src/conversation-message-adapter.tsx` | ConversationMessages; registered cards | H: card families and legacy process styles require shared state/action rhythm; visual verification pending |
| page / `standalone-plugins` | /admin.html | `packages/web/public/admin.html` | PluginAdminPage; PluginList; native shell | C/H/D: 3 static controls; native toolbar/tab/header; dialog footer styles separate from settings |
| page / `standalone-resources` | /resources.html | `packages/web/public/resources.html` | ResourceAdminPage; ResourceListContent; native shell | C/H/D: 12 static controls; separate standalone header; MCP dialog duplicate shell |
| page / `settings-model` | / → Settings → model | `packages/web-ui/src/settings-model-pane.tsx` | SettingsHub / SettingsModelPane; SettingsAccounts | H/D: native pane bridge and account dialog use separate header/footer CSS |
| page / `settings-models` | / → Settings → models | `packages/web-admin/src/admin/plugins/session-defaults-panel.tsx` | SettingsHub / SettingsCard; Field; SettingsInput; SettingsSelect | H/E: title manually repeated in card; raw error paragraph |
| page / `settings-bundles` | / → Settings → bundles | `packages/web-admin/src/admin/plugins/bundles-panel.tsx` | SettingsHub / SettingsCard; Field; Select; SettingsInput | H/L: manual h2 inside hub page; custom checkbox and origin table layout |
| page / `settings-engines` | / → Settings → engines | `packages/web-admin/src/settings/child-engines.tsx` | SettingsHub / SettingsCard; SchemaConfigForm | S: reuse shared form; inspect generated field spacing in both themes |
| page / `settings-system-prompt` | / → Settings → system-prompt | `packages/web-admin/src/settings/system-prompt.tsx` | SettingsHub / SettingsCard; SettingsTextArea; SettingsToolbar; SettingsState | S: shared controls present; preserve code-source disclosure and form footer |
| page / `settings-memory` | / → Settings → memory | `packages/web-admin/src/settings/memory.tsx` | SettingsHub / SettingsCard; Field; SettingsSelect; SettingsTextArea; SettingsToolbar; SettingsState | S: shared controls present; editor/form footer and empty/loading matrix to capture |
| page / `settings-plugins` | / → Settings → plugins | `packages/web-admin/src/admin/plugins/admin/page.tsx` | SettingsHub / SettingsHub; PluginList; OrphanPins | C/B/E: template search field; library hand-rolled row buttons/empty states; recovery and orphan notices |
| page / `settings-discover` | / → Settings → discover | `packages/web-admin/src/admin/plugins/admin/views.tsx` | SettingsHub / PluginList; Select; SettingsDetails | B/E: native detail/action buttons and plugin-empty; version picker already shared |
| page / `settings-providers` | / → Settings → providers | `packages/web-admin/src/settings/runtime-panels.tsx` | SettingsHub / SettingsCard; SettingsList; SettingsRow; SettingsDetails; Badge | S: shared rows present; normalize status mapping only where presentation differs |
| page / `settings-examples` | / → Settings → examples | `packages/web-admin/src/settings/examples.tsx` | SettingsHub / SettingsCard; SettingsRow; Button; Badge | S: existing shared rows/actions; check empty/loading and footer alignment |
| page / `settings-skills` | / → Settings → skills | `packages/resource-control-web/src/admin.tsx` | SettingsHub / ResourceListContent; SkillDetailContent; StateLights | B/E/H: native pane bridge; library row buttons and resource-empty versus SettingsState |
| page / `settings-mcp` | / → Settings → mcp | `packages/resource-control-web/src/admin.tsx` | SettingsHub / ResourceListContent; McpDetailContent; createMcpForm | C/B/D/I: duplicate HTML form; native fields and footer; HTTP Header label |
| page / `settings-search` | / → Settings → search | `packages/web-admin/src/settings/search.tsx` | SettingsHub / SettingsCard; SchemaConfigForm; SettingsInput; SettingsToolbar | S: shared schema controls present; keep field-surface contract and credential refs |
| page / `settings-context` | / → Settings → context | `packages/web-admin/src/settings/context.tsx` | SettingsHub / SettingsCard; SettingsInput; SettingsState; Button | B/S: custom checkbox labels and save group instead of shared checkbox/toolbar |
| page / `settings-jobs` | / → Settings → jobs | `packages/web-admin/src/settings/jobs-panel.tsx` | SettingsHub / SettingsCard; SettingsInput; SettingsSelect; SettingsState; Button | L/H: manual heading and table; refresh and row actions use separate layout |
| page / `settings-schedules` | / → Settings → schedules | `packages/web-admin/src/settings/schedules.tsx` | SettingsHub / SettingsCard; SettingsInput; SettingsSelect; SettingsState; Button | B/L: custom checkbox/actions; list/editor/detail need one shared form footer |
| page / `settings-triggers` | / → Settings → triggers | `packages/web-admin/src/settings/triggers.tsx` | SettingsHub / SettingsCard; Field; SettingsSelect; SettingsTextArea; SettingsToolbar | L/E: raw ul/li records and deliveries; empty/list feedback presentation differs |
| page / `settings-terminal` | / → Settings → terminal | `packages/web-admin/src/settings/jobs-panel.tsx` | SettingsHub / SettingsCard; SettingsTextArea; Button; SettingsState | H/S: refresh and session controls outside shared header; preserve terminal keyboard contract |
| page / `settings-security` | / → Settings → security | `packages/web-admin/src/settings/runtime-panels.tsx` | SettingsHub / SettingsCard; Badge; AutoReviewPanel | H/E: security status and auto-review form combined; status/action hierarchy needs consistent sections |
| page / `settings-diagnostics` | / → Settings → diagnostics | `packages/web-admin/src/settings/diagnostics.tsx` | SettingsHub / SettingsCard; SettingsRow; SettingsState; DoctorChecks; ObservabilityPanel | H/L: doctor, errors, OTLP and runtime have distinct action placement; custom error rows |
| page / `settings-history` | / → Settings → history | `packages/web-admin/src/settings/history.tsx` | SettingsHub / SettingsCard; SettingsInput; SettingsState; Button | L/S: result cards and filtering toolbar require common row/metadata rhythm |
| page / `settings-archived` | / → Settings → archived | `packages/web/src/session-actions.ts` | SettingsHub / native template search; DOM rows/buttons | C/B/E: 1 search input in template; hand-built restore rows and native empty/error paragraphs |
| page / `settings-feedback` | / → Settings → feedback | `packages/web-admin/src/settings/feedback.tsx` | SettingsHub / SettingsCard; Field; SettingsSelect; Button | C/E/L: raw input; unstyled alert/empty paragraphs; no explicit loading state; raw list |
| page / `settings-computer-use` | / → Settings → computer-use | `packages/web-ui/src/settings-computer-use.tsx` | SettingsHub / SettingsComputerUse; SettingsPage; Button | S: shared page present; native pane shell may repeat headings; preserve permission states |
| page / `settings-general` | / → Settings → general | `packages/web-foundation/src/appearance.ts` | SettingsHub / React radio input; native template fieldsets | C/H: skin radio + 8 template radio controls; separate appearance cards and headings |
| panel / `auto-review` | owning page / registered panel | `packages/web-admin/src/settings/auto-review.tsx` | SettingsCard; SettingsCheckbox; SettingsSelect; SettingsInput; Button | E/S: failed status changes role without error tone; save/clear actions lack SettingsToolbar |
| panel / `observability` | owning page / registered panel | `packages/web-admin/src/settings/observability.tsx` | SettingsCard; SettingsState; SettingsDetails; SettingsToolbar | L/S: runtime health uses raw paragraph sequence; keep token-backed fields |
| panel / `doctor` | owning page / registered panel | `packages/web-admin/src/settings/doctor.tsx` | DoctorChecks; SettingsToolbar; SettingsState | S: shared checks; preserve probe/refresh ownership and nonblocking notice |
| panel / `generations` | owning page / registered panel | `packages/web-admin/src/settings/runtime-panels.tsx` | SettingsCard; SettingsRow; Badge | L: generation technical rows and summary format |
| panel / `publication` | owning page / registered panel | `packages/web-admin/src/settings/runtime-panels.tsx` | SettingsCard; SettingsRow | L: technical publication status uses independent row formatting |
| panel / `local-plugins` | owning page / registered panel | `packages/web-admin/src/settings/runtime-panels.tsx` | SettingsCard; Button | L/E: local source configuration and operation feedback |
| panel / `presets` | owning page / registered panel | `packages/web-admin/src/settings/runtime-panels.tsx` | SettingsCard; SettingsRow | S: shared row composition; visual verification pending |
| panel / `account-network` | owning page / registered panel | `packages/web-admin/src/settings/account-network.tsx` | SchemaConfigFields; Field | S: keep advanced schema field sizing |
| panel / `session-tools` | owning page / registered panel | `packages/web-admin/src/settings/session-tools.tsx` | SettingsDetails; Button | L: session tool disclosure and row action rhythm |
| panel / `files` | owning page / registered panel | `packages/web-conversation/src/workbench/files-panel.tsx` | Button; SettingsState | H/L: own workbench toolbar/tree/preview; no shared page heading; preserve internal scrolling |
| panel / `changes` | owning page / registered panel | `packages/web-conversation/src/workbench/changes-panel.tsx` | Button; Select; SettingsState | H/L: own toolbar/list/diff/provenance sections; shared heading rhythm needed |
| panel / `facts` | owning page / registered panel | `packages/web-conversation/src/workbench/fact-chain-panel.tsx` | Button; FeedbackProvenance; ReviewEvidence | E/L: empty/error and custom node list need common state presentation |
| panel / `goal` | owning page / registered panel | `packages/web-conversation/src/workbench/goal-panel.tsx` | SettingsState | H/L: h2 objective and raw progress/reason; keep dock-provided title |
| panel / `workbench-terminal` | owning page / registered panel | `packages/web-conversation/src/workbench/terminal-panel.tsx` | Button; Field; SettingsInput; SettingsSelect; SettingsState | C/H: raw textarea terminal target; custom tabs/toolbar; preserve VT/keyboard/ref behavior |
| panel / `workbench-feedback` | owning page / registered panel | `packages/web-conversation/src/workbench/feedback-panel.tsx` | FeedbackForm; FeedbackProvenance | H/E: feedback panel composes independent form/status blocks |
| panel / `review-evidence` | owning page / registered panel | `packages/web-conversation/src/workbench/review-evidence.tsx` | Button | S/E: three override actions ungrouped; raw decision summaries |
| panel / `intelligent-workbench` | owning page / registered panel | `packages/web/src/intelligent-ui/placements.tsx` | IntelligentSurface; Button | E/H: Empty/raw alert paragraphs; refresh separated from heading |
| panel / `trace` | owning page / registered panel | `packages/web-units/src/trace.ts` | React DOM; request trace component | C/B/H: 2 selects + search input; hand-rolled toolbar; specialized timeline geometry |
| panel / `request-trace` | owning page / registered panel | `packages/web-units/src/trace-request.tsx` | Button; SettingsCode | L/S: request metrics and code sections use custom trace layout |
| panel / `transcript` | owning page / registered panel | `packages/web-units/src/transcript.ts` | React DOM | H/E: separate transcript details/metadata presentation |
| panel / `computer-use-session` | owning page / registered panel | `packages/web-conversation/src/computer-use-pane.tsx` | Button; shared screen region | S/E: preserve image aspect/control state; inspect permission/loading states |
| panel / `composer` | owning page / registered panel | `packages/web-units/src/composer.ts` | React textarea; native actions; ReferencePicker | C/B: raw prompt textarea and button family; hidden file chooser exception |
| panel / `child-controls` | owning page / registered panel | `packages/web-units/src/composer/child-controls.ts` | React input/Button | C/S: child instruction input; keep session command handlers |
| panel / `queue-editor` | owning page / registered panel | `packages/web-units/src/composer/queue-editor.ts` | React textarea/Button | C/S: queued draft textarea; keep ref/selection/update behavior |
| panel / `sidebar` | owning page / registered panel | `packages/web-units/src/sidebar.ts` | React DOM | B/H: custom new/settings/history actions and navigation rows |
| panel / `topbar` | owning page / registered panel | `packages/web-units/src/topbar.ts` | React DOM | B/H: action buttons and metadata spacing |
| panel / `plugin-config` | owning page / registered panel | `packages/web-admin/src/admin/plugins/config-tab.tsx` | Dialog; PluginConfigPanel | H/D: custom detail heading/scroll body inside Dialog; same footer rhythm needed |
| panel / `plugin-config-form` | owning page / registered panel | `packages/web-admin/src/admin/plugins/config-panel.tsx` | PluginSchemaFields; Button | E/S: ensure load/save/revision feedback and footer align to schema form |
| panel / `candidate-list` | owning page / registered panel | `packages/web-admin/src/admin/plugins/candidates.tsx` | CandidateListFacts; Button; Badge | L/E: candidate empty/list actions have separate styles |
| panel / `candidate-review` | owning page / registered panel | `packages/web-admin/src/admin/plugins/candidate-review.tsx` | Badge; CandidateFileDiff; CandidateTechnical | L/S: bespoke diff/disclosure; preserve diff geometry and review decisions |
| panel / `capability-provenance` | owning page / registered panel | `packages/web-admin/src/admin/plugins/capability-review.tsx` | CapabilityReview; ProvenanceReview | H/L: manual headings/list/failure paragraph |
| dialog / `workspace` | / → choose workspace | `packages/web/src/workspace-picker.ts` | native dialog; DOM controller | C/B/D: index.html path input/actions; retain validation and focus |
| dialog / `setup-guide` | / → first run | `packages/web-ui/src/first-run.tsx` | Dialog; Field; Select; SettingsState; Button | S: shared presentation; keep bespoke progress/backdrop and skip behavior |
| dialog / `account` | Settings → model → add/edit | `packages/web-ui/src/settings-account-dialog.tsx` | SettingsOptionSelect; native fields/buttons | C/B/D: 4 library inputs; manual form labels/buttons/footer; duplicate template account shell |
| dialog / `oauth` | Account → auth method | `packages/web-admin/src/oauth-controls.ts` | React password input; Button | C/E: raw password input; keep device flow and callback lifecycle |
| dialog / `model-picker` | composer → model | `packages/web/src/model-picker.ts` | React input; custom menu | C/B: search input and menu actions; preserve keyboard/search selection |
| dialog / `agent-options` | composer → agent | `packages/web-admin/src/permission-picker.ts` | Select; Popover; React DOM | S: keep public popover ownership and composed fields |
| dialog / `reference-picker` | composer → attach reference | `packages/web-units/src/reference-picker.tsx` | Popover; Button; SettingsInput | S: keep keyboard navigation/search and selection state |
| dialog / `session-rename` | sidebar → rename | `packages/web/src/session-actions.ts` | native dialog + innerHTML | C/B/D: raw input/buttons; retain required validation, submit and focus |
| dialog / `plugin-source` | plugin page → install source | `packages/web-ui/src/admin-dialogs.tsx` | SourceDialogContent; SettingsInput; SettingsSelect | C/B/D: static duplicate source controls; shared content still hand-rolled buttons |
| dialog / `plugin-detail` | plugin row → detail | `packages/web-ui/src/admin-detail.tsx` | DetailContent; StateLights; native actions | B/H/D: own header/scroll/actions; retain native dialog host |
| dialog / `plugin-confirm` | plugin install/trust/update/remove | `packages/web-ui/src/admin-dialogs.tsx` | ConfirmDialogContent; confirmation facts | B/D: native footer actions; preserve explicit destructive review |
| dialog / `admin-confirm` | resource action → confirm | `packages/web-ui/src/admin-confirmation.tsx` | AdminConfirmContent | B/D: shared content inside native host; operation footer |
| dialog / `skill-detail` | Skills → row | `packages/web-ui/src/resource-detail.tsx` | SkillDetailContent; StateLights | B/D/L: manual action buttons and metadata lists |
| dialog / `mcp-detail` | MCP → row | `packages/web-ui/src/resource-detail.tsx` | McpDetailContent; StateLights | B/D/L: manual actions; preserve failure guidance and policy facts |
| dialog / `mcp-form` | MCP → add/edit | `packages/resource-control-web/src/mcp-form.ts` | native HTML controls + SelectPicker bridge | C/I/D: forms in index/resources HTML; HTTP Header untranslated; native validation/controller types |
| dialog / `feedback-form` | message → feedback | `packages/web-units/src/message-feedback/form.tsx` | Field; SettingsSelect; SettingsTextArea; Button | S: shared fields; align footer and empty/error/confirmation states |
| dialog / `diagnostics-bundle` | conversation → diagnostics | `packages/web-ui/src/diagnostics-dialog.tsx` | Dialog; Button | D/L: export/technical detail actions need common footer; preserve redaction |
| dialog / `generic-confirm` | existing confirmation calls | `packages/web-ui/src/confirm.ts` | shared confirm factory | D: standardize action spacing while keeping caller outcome and dismissal |
| card / `message` | conversation / owning panel | `packages/web-ui/src/conversation/messages.tsx` | ConversationMessages; message variants | S: message actions/metadata use conversation scale; preserve streaming behavior |
| card / `tool` | conversation / owning panel | `packages/web-ui/src/conversation/messages/tool-card.tsx` | ConversationToolCard; ConversationCardLayout | S: already shared card; retain single detail action and raw results |
| card / `approval` | conversation / owning panel | `packages/web-units/src/approval.ts` | React DOM; Approval actions | B/E: native action buttons; preserve authorization identity and refusal state |
| card / `goal` | conversation / owning panel | `packages/web-conversation/src/goal-card.tsx` | ConversationCardLayout; Button; Badge | S: shared card exists; keep goals/backend state unchanged |
| card / `workflow` | conversation / owning panel | `packages/web-conversation/src/workflow-run-card.tsx` | ConversationCardLayout | L/S: receipt list hierarchy and metadata |
| card / `question` | conversation / owning panel | `packages/web-conversation/src/default-tool-cards.tsx` | ConversationCardLayout; SettingsInput; SettingsTextArea; Button | S: preserve question IDs, keyboard and submission payload |
| card / `deliverable` | conversation / owning panel | `packages/web-conversation/src/default-tool-cards.tsx` | ConversationCardLayout; document preview | S: preserve preview and file links |
| card / `schedule` | conversation / owning panel | `packages/web-conversation/src/default-tool-cards.tsx` | ConversationCardLayout; Button | S: existing shared card; normalize metadata only |
| card / `background-job` | conversation / owning panel | `packages/web-conversation/src/conversation-registry.tsx` | ConversationCardLayout | S: registry plain variant receives caller body; inspect body state/action rhythm |
| card / `child-agent` | conversation / owning panel | `packages/web-conversation/src/conversation-registry.tsx` | ConversationCardLayout | S: registry plain variant and child controls; preserve lifecycle |
| card / `plugin` | conversation / owning panel | `packages/web-conversation/src/conversation-registry.tsx` | ConversationCardLayout | S: registry plain variant; preserve plugin-provided body |
| card / `interaction-result` | conversation / owning panel | `packages/web-ui/src/conversation/interaction-result.tsx` | ConversationInteractionResult | S: existing localized summary and details; preserve raw protocol data |
| card / `feedback-provenance` | conversation / owning panel | `packages/web-units/src/message-feedback/provenance.tsx` | FeedbackProvenance | E/L: provenance metadata/actions separate from shared rows |
| card / `document-preview` | conversation / owning panel | `packages/web-ui/src/conversation/document-preview.tsx` | DocumentPreview | S: specialized document geometry stays; align empty/error state |
| card / `intelligent-surface` | conversation / owning panel | `packages/web-ui/src/intelligent-ui/surface.tsx` | IntelligentSurface; Button | E/S: draft/review/receipt paragraphs and header action placement |
| card / `intelligent-catalog` | conversation / owning panel | `packages/web-ui/src/intelligent-ui/catalog.tsx` | Field; SettingsInput; SettingsTextArea; Select; Button | C/L: internal raw selection input; shared library ownership legitimate, choice styling not yet shared |
| card / `intelligent-chart` | conversation / owning panel | `packages/web-ui/src/intelligent-ui/chart.tsx` | SVG chart + semantic table | S: specialized chart/data geometry; visual/theme capture needed |
| card / `prompt-source` | conversation / owning panel | `packages/web-admin/src/settings/system-prompt.tsx` | SettingsCode; SettingsDetails | S: code-source/technical disclosure uses same footer and spacing |
| card / `doctor-notice` | conversation / owning panel | `packages/web-ui/src/first-run.tsx` | DoctorNotice; Button | H: fixed notice may compete with narrow page/header; visual verification pending |
| card / `offline-diagnostics` | conversation / owning panel | `packages/web-units/src/diagnostics-viewer.ts` | generated standalone HTML viewer | L/S: exported diagnostic table is separate offline surface; no form controls, keep embedded token style |

## Confirmed source findings

- Outside web-ui, 31 control declarations in 11 TS/TSX files: 21 JSX/template elements and 10 React.createElement controls. `web-units/src/settings.ts` alone retains 18 template controls, including a replaced account template. `resource-control-web/src/mcp-form.ts` contains a select in a comment, not a control constructor. The source hit count must exclude that comment.
- Public HTML contains 30 declarations: index 15, resources 12, admin 3. Source declarations and template fallbacks are counted independently; they are not 61 distinct visible controls. Both must be removed or encapsulated to meet a source-level migration criterion.
- web-ui has 17 native JSX elements and one temporary DOM textarea used for clipboard fallback. Native shared-library internals are valid implementations, but its account dialog and administrative list/detail actions still need unified wrappers. React.createElement is not document.createElement. The explicit document/doc form-control constructor scan finds no consumer control creation; the remaining library constructor is the clipboard fallback. General DOM construction still exists in session menus, archived rows, shell hosts and the offline diagnostic viewer.
- `feedback.tsx:42` renders a raw input. Error/empty results are plain paragraphs, and its pending fetch has no dedicated loading presentation.
- `auto-review.tsx:229` changes role to alert on failure without selecting SettingsState's error tone; its clear/save actions have no shared toolbar.
- `bundles-panel.tsx:117` puts an h2 inside a page already titled by the hub. `session-defaults-panel.tsx:108` renders its own heading rather than SettingsCard's title slot.
- `index.html:174` contains a literal “HTTP Header” host label without an i18n attribute; resources.html already localizes the corresponding label. Protocol examples and credential-reference syntax are intentional literals.
- `02-base-controls.css` globally styles button/input/select/textarea; `17-settings-forms.css` and web-ui/tokens.css add shared-looking control/toolbar rules; `19-settings-runtime-overrides.css` adds another override layer. Consolidate by ownership rather than deleting the base reset indiscriminately. `17-settings-forms.css:309,470` use 0.6875rem outside the font scale. Intelligent UI styles duplicate existing 8/12/20 px spacing as literals.
- The public stylesheet scan finds no raw UI colors outside the token authority except a `#000` radial mask in `13-turn-process.css:561–562`; that is mask geometry, not a status color. Intelligent UI surface styles already use semantic colors. A missing information-background token is not a demonstrated defect because existing components use neutral backgrounds.
- The no-create-element guard is a per-file imperative DOM guard, not a native-control or visual-unification guard. It currently covers 27 paths; append newly migrated owners only when their DOM ownership really changes. Do not weaken it to permit raw controls.

## Implementation order and estimates

Estimates are changed lines (additions plus deletions), not limits. Groups overlap in file ownership; sum estimates by component group only. Preserve existing behavior, IDs, ARIA, locale catalogs, region/skin hooks and backend contracts.

| Order / component group | Surfaces and counts | Main owners | Estimate |
| --- | --- | --- | --- |
| 1 Shared control/action presentation | 31 consumer source declarations + 30 HTML declarations; 1 upload exception; shared list/detail button families | web-ui/settings-layout, settings-account-dialog, admin-list/detail/dialogs, resource-list/detail; consumer owners above | 500–850 lines |
| 2 Shared form/control migration | composer, queue, child controls, trace (3), model search, OAuth, feedback, rename, workspace, MCP, appearance | web-units, web, web-admin, resource-control-web; current event/ref/DOM contracts retained | 450–750 lines |
| 3 Page/header/footer rhythm | 29 page entries; 31 panels; 18 dialog families | SettingsHub, native pane bridges, standalone HTML, shared dialog content, workbench dock | 250–450 lines |
| 4 State/list/status presentation | feedback, auto review, resources/plugins, diagnostics/OTLP, triggers, history, workbench and Intelligent UI | SettingsState, SettingsList/Row, ConversationCardLayout, Badge/StateLights | 250–450 lines |
| 5 CSS scale consolidation | 26 public style modules + shared token bridge + Intelligent UI styles; changes limited to duplicated control/layout rules | 02-base-controls, 10-dialogs, 15-settings-shell, 17-settings-forms, 19-settings-runtime-overrides, 25-responsive-overrides; web-ui/tokens.css | 180–320 lines |
| 6 Documentation and meaningful regression cases | existing contracts nearest to the changed behavior; no new tests for pure spacing | affected package test files and existing Web screenshot/interaction specs | 80–180 lines |

Expected implementation total: 1,710–3,000 changed lines, staged by shared component ownership. No dependency change expected. Add tokens only for a demonstrated missing semantic role, with both themes and generated public skin contracts.

| Page group by user impact | Planned result | Estimate within groups above |
| --- | --- | --- |
| Main conversation/composer + workspace/model/rename dialogs | Shared fields/actions, unchanged selection/IME/keyboard and upload behavior | 220–380 |
| Accounts/general + configuration forms | Shared labels/controls/footer; existing radio and native-select event contracts retained | 250–450 |
| Plugins/discover/providers/examples + source/detail/review/config dialogs | One heading/action rhythm; shared row/buttons/state presentation | 280–480 |
| Skills/MCP embedded and standalone | Shared skeleton, controls, errors, credentials help and confirmation footer; remove duplicate HTML fields | 250–450 |
| Feedback/memory/search/context/system prompt | Shared toolbar/state/list presentation; explicit loading/error tone | 150–260 |
| Diagnostics/observability/security/auto review | Common section titles, status summaries and form footer | 120–220 |
| Jobs/schedules/triggers/history/archived | Shared filtering, list metadata, row actions and empty/error states | 180–300 |
| Workbench/Intelligent UI/conversation card families | Shared title/action/state rhythm while preserving specialized content geometry | 200–350 |

## Capture matrix and implementation gate

For every inventory surface, capture en and zh-CN × light and dark × desktop (1280 × 900) and narrow (390 × 844), using the same synthetic data and stable filename in before and after. Page families need one visible entry per case; dialogs/panels/cards need an explicit state recipe. Record additional long-page scroll frames rather than claiming a single viewport proves all sections. Include no real credentials or external provider calls.

No screenshot capture has been performed at this static-audit revision. The current checkout has neither dependencies nor packaged runtime/Web build output. The standard e2e runner would build and typecheck automatically, so it must not be invoked under a no-build audit constraint. Existing baseline files are historical evidence and must not be copied as current captures. A compatible prebuilt synthetic environment is required; record its source revision, artifact provenance and capture coverage before implementation acceptance. UI implementation must wait for the explicit implementation gate.
