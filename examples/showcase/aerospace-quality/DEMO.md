# 穹序 · 7 分钟演示 / Qiongxu · Seven-minute demo

所有名称、测量、批次和历史签字为虚构。以下审批由演示操作者完成，不允许模型自批。 / All names, measurements, lots and archived signatures are fictional. The demonstration operator owns approvals; the model cannot approve itself.

先按 README 构建并选择独立 home、工作区和非 4177/4178 端口。真实模型使用已配置 DeepSeek，付费验收总额上限 $3，不读取个人默认配置。 / Build using README; use an isolated home/workspace and a port other than 4177/4178. Use explicitly configured DeepSeek for reasoning, with a $3 acceptance cap and no personal-default configuration.

| 时间 / Time | 中文操作与讲解 | English action and narration |
| --- | --- | --- |
| 0:00–0:50 | 在图库应用卡片点“安装并采用”，审阅安装来源与能力，再预览品牌、主页、皮肤与五个智能体，显式确认采用。展示产品从 AGH 变成穹序质量台。安装本身不切换产品。 | Choose Install and adopt on the gallery application card; review source/capabilities, then explicitly confirm brand/home/skin/five-agent consent. AGH becomes Qiongxu quality. Installation alone never changes identity. |
| 0:50–1:30 | 总览：需求覆盖、重大 NCR、待审 ECR、未闭归零、里程碑与试验活动。点“调查异常”，展开 AN-027 证据抽屉；切换浅深与中英文。 | Inspect coverage, major NCRs, pending ECRs, open zeroing, milestones and campaigns. Investigate AN-027 and open the evidence drawer; switch theme/locale. |
| 1:30–2:30 | 智能体→试验异常诊断员，先读技能，调查 AN-027。模型引用 TC-026、BL-C、L2609-B、ECR-014 和 NCR-016/017，区分观察、关联与焊点疲劳假设，并提出新旧批次对照、连续性、校准探头和切片复现计划。 | Launch Test Anomaly Investigator. Read the skill, investigate AN-027; cite TC-026, BL-C, L2609-B, ECR-014 and NCR-016/017. Separate observation/correlation from solder-fatigue hypothesis; propose A/B lots, continuity, calibrated probe and cross-section testing. |
| 2:30–3:30 | MRB 助理比较五种处置，保存 NCR-018 返工草案：隔离/拒收批次，按原图样返工受影响试件并复验。请求正式处置时出现宿主审批，先拒绝一次证明无状态变化，再明确批准。展示批准实施状态和仍在隔离的器件。 | MRB Assistant compares five dispositions and drafts NCR-018 rework: reject/quarantine the lot, restore the drawing and re-verify affected units. Reject one native approval to prove no mutation, then explicitly approve a fresh reviewed request. Show disposition approved for execution and hardware still on hold. |
| 3:30–4:20 | 需求追溯分析师列出受影响需求、设计、接口和 VT-001/004/008 复验；筛选孤立和未测试需求。技术状态页查看 ECR-016 影响，审批前不改基线。 | Traceability Analyst shows affected requirements/design/interfaces and VT-001/004/008 re-verification. Filter orphan/untested requirements. Review ECR-016 impact; no baseline change before approval. |
| 4:20–5:10 | 质量助手生成双五条报告，展示 Markdown 与可打印 HTML 交付物。技术五条/管理五条尚有缺证，报告为草案，不宣称归零。打开执行记录查看工具、审批、effect、包来源和 pin。 | Generate the double-five report; open Markdown and printable HTML deliverables. Missing technical/management evidence keeps it a draft. Inspect tool calls, approvals, effects, provenance and pins in execution records. |
| 5:10–6:20 | 提议热循环组件更换批次追加 TVAC 的受审技能候选；通过原生 Skill proposal 展示文件和 digest，由人批准安装，下一轮技能生效。再批准项目内 TVAC-LOT-001 策略；下一次 ECR-016 分析显示 v1 与追加筛选。批准更改后增加 pending 的 VT-033，不能宣称试验通过。 | Propose a reviewed TVAC lot-screening skill. Inspect native Skill proposal files/digest; human approves installation, effective next turn. Approve the bounded TVAC-LOT-001 programme policy. The next ECR-016 review shows v1 and additional screening; approved change adds pending VT-033, never a fabricated passing result. |
| 6:20–7:00 | 运行 automation.mjs 创建每周一摘要，在自动化页“立即运行”，打开新会话中的摘要交付物。指出任务冻结启动目标，每次执行重新准入，拒绝无人值守审批。 | Create the Monday digest with automation.mjs; Run now in Automation and open the new session's deliverables. Target selection is frozen at creation; each run is readmitted and unattended approvals refuse. |

## 自然业务对话 / Natural business conversation

智能体自行选择工具；操作者在宿主审阅精确对象与版本后签署。业务签名通过 `business.confirm`，在 full-access 下仍问真人，工具权限自动批准不等于质量决策。

The agent chooses tools. The operator signs the exact target/revision in Host. `business.confirm` remains human-only under full access; automatic tool permission is no quality disposition.

1. **试验异常诊断员**：“TVAC 冷平台那次电流越限是怎么回事？影响哪些需求和器件？给我证据与替代解释，先别批准任何处置。” / **Investigator**: “What happened with the TVAC cold-plateau current excursion? Which requirements and parts are affected? Show evidence and alternative explanations before any disposition.”
2. **MRB 助理**：“比较 NCR-018 的五种处置方案。请起草返工：隔离 L2609-B，按受控图样恢复 PVD-011/012/013 并复验。保存草案，先不要批准。” / **MRB**: “Compare the five NCR-018 dispositions. Draft rework: quarantine L2609-B, restore PVD-011/012/013 to the controlled drawing and re-verify. Save the draft; do not approve.”
3. “我已审阅这个返工草案，请请求我的正式签署；实施、复验与放行仍是后续独立步骤。” / “I have reviewed this rework draft. Request my formal signature; implementation, re-verification and release remain separate.” 先拒绝一次，再重新审阅并签署；状态不应在拒绝时改变。 / Reject once, then review and sign a new request; refusal must preserve state.
4. **追溯分析师**：“ECR-016 会影响哪些需求、接口与复验？请把没有覆盖和尚未通过的项目列清楚。” / **Traceability Analyst**: “Which requirements, interfaces and re-tests does ECR-016 affect? Identify missing coverage and tests that have not passed.”
5. **质量助手**：“生成中文双五条归零报告和可打印交付物。明确哪些证据仍缺失，并让我追溯到试验、处置签名和插件版本，不能宣称已归零。” / **Quality**: “Generate a Chinese double-five report and printable deliverables. Identify missing evidence and trace tests, disposition signatures and plugin version. Do not claim closure.”
6. “把热循环组件更换批次应追加 TVAC 筛选的经验提议为项目规则，并准备原生可复用技能候选，展示文件与摘要，等我审阅。” / “Propose the lesson that thermally cycled lot substitutions need TVAC screening as a programme rule; prepare a reusable native skill candidate, show files/digest and wait for review.”
7. “我已审阅候选，请提交安装请求，让我在宿主确认。” / “I reviewed the candidate. Submit its installation request for my Host confirmation.” 再说：“请请求我签署 TVAC-LOT-001 项目规则的启用。” / Then: “Request my signature to activate programme rule TVAC-LOT-001.”
8. “重新分析 ECR-016，告诉我新规则是否生效及新增验证。先别改变基线。” / “Re-analyse ECR-016. Does the reviewed rule apply, and what verification is added? Keep the baseline unchanged.” 审阅后：“请请求我签署 ECR-016 技术状态更改；新增试验保持待执行。” / After review: “Request my signature for ECR-016 configuration change. Keep added tests pending.”
9. **质量助手**：“生成本周 NCR 摘要，并建议每周一上午九点的质量巡检任务，不能无人值守批准硬件处置。” / **Quality**: “Generate this week's NCR digest and suggest a Monday 09:00 quality check. Never approve hardware disposition unattended.” 在自动化页选择质量助手、Asia/Shanghai、新会话、无人值守审批拒绝；立即运行并打开报告。 / In Automation select Quality Assistant, Asia/Shanghai, a new session and refused unattended approvals; Run now and open the report.

真实模型演示使用 `../scripts/presentation.mjs aerospace-quality --real`，在隔离 home 通过图库安装采用，再执行自然业务阶段，保存截图与 AGH 用量；总费用上限 $3。原确定性验收脚本仅用于机制回归。`/?admin` 与设置→应用保留宿主恢复。

Use `../scripts/presentation.mjs aerospace-quality --real` for isolated gallery installation/adoption and natural business stages, screenshots and AGH usage; cap total spend at $3. The deterministic runner covers mechanism regression. Settings → Application and `/?admin` retain host recovery.

## Conversation workbench / 会话业务工作台

At standard/workspace-write permission levels, from the overview choose **Investigate anomaly** on AN-027 → review the role launch → edit the request.
The Current object tab focuses AN-027. Choose **Draft MRB disposition** in the composer to open the NCR
role and NCR-018 context; tool writes update that dossier. Sign in **Pending signatures**, then use
**Generate closure report** and **Evidence & reports** to inspect the report and its provenance.
All previous modules remain reachable from the overview; the sidebar keeps overview and tasks/signatures.

在标准/工作区写入权限下，从总览 AN-027 点击“调查异常”→ 审阅角色启动 → 编辑请求，右侧“当前对象”聚焦 AN-027。
点击输入区“起草 MRB 处置”打开 NCR 角色及 NCR-018 上下文，工具写入后档案实时更新。
在“待签署”确认，再通过“生成归零报告”和“证据与报告”检查报告及来源。总览保留全部模块，侧栏只保留总览与待办/签署。

Full access uses the same Host path without a pending card and records automatic confirmation; it is never described as a manual click. / 完全访问沿同一宿主流程自动确认，不显示待签卡，并如实记录自动确认方式。
