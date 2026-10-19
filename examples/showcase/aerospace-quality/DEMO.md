# 穹序 · 7 分钟演示 / Qiongxu · Seven-minute demo

所有名称、测量、批次和历史签字为虚构。以下审批由演示操作者完成，不允许模型自批。 / All names, measurements, lots and archived signatures are fictional. The demonstration operator owns approvals; the model cannot approve itself.

先按 README 构建并选择独立 home、工作区和非 4177/4178 端口。真实模型使用已配置 DeepSeek，付费验收总额上限 $3，不读取个人默认配置。 / Build using README; use an isolated home/workspace and a port other than 4177/4178. Use explicitly configured DeepSeek for reasoning, with a $3 acceptance cap and no personal-default configuration.

| 时间 / Time | 中文操作与讲解 | English action and narration |
| --- | --- | --- |
| 0:00–0:50 | 安装包，设置→应用预览来源、完整性、能力、品牌、主页、皮肤与五个智能体，再显式采纳。展示产品从 AGH 变成穹序质量台。安装本身不切换产品。 | Install; preview source/integrity/capabilities/brand/home/skin/five agents in Settings → Application; explicitly adopt. AGH becomes Qiongxu quality. Installation alone never changes identity. |
| 0:50–1:30 | 总览：需求覆盖、重大 NCR、待审 ECR、未闭归零、里程碑与试验活动。点“调查异常”，展开 AN-027 证据抽屉；切换浅深与中英文。 | Inspect coverage, major NCRs, pending ECRs, open zeroing, milestones and campaigns. Investigate AN-027 and open the evidence drawer; switch theme/locale. |
| 1:30–2:30 | 智能体→试验异常诊断员，先读技能，调查 AN-027。模型引用 TC-026、BL-C、L2609-B、ECR-014 和 NCR-016/017，区分观察、关联与焊点疲劳假设，并提出新旧批次对照、连续性、校准探头和切片复现计划。 | Launch Test Anomaly Investigator. Read the skill, investigate AN-027; cite TC-026, BL-C, L2609-B, ECR-014 and NCR-016/017. Separate observation/correlation from solder-fatigue hypothesis; propose A/B lots, continuity, calibrated probe and cross-section testing. |
| 2:30–3:30 | MRB 助理比较五种处置，保存 NCR-018 返工草案：隔离/拒收批次，按原图样返工受影响试件并复验。请求正式处置时出现宿主审批，先拒绝一次证明无状态变化，再明确批准。展示批准实施状态和仍在隔离的器件。 | MRB Assistant compares five dispositions and drafts NCR-018 rework: reject/quarantine the lot, restore the drawing and re-verify affected units. Reject one native approval to prove no mutation, then explicitly approve a fresh reviewed request. Show disposition approved for execution and hardware still on hold. |
| 3:30–4:20 | 需求追溯分析师列出受影响需求、设计、接口和 VT-001/004/008 复验；筛选孤立和未测试需求。技术状态页查看 ECR-016 影响，审批前不改基线。 | Traceability Analyst shows affected requirements/design/interfaces and VT-001/004/008 re-verification. Filter orphan/untested requirements. Review ECR-016 impact; no baseline change before approval. |
| 4:20–5:10 | 质量助手生成双五条报告，展示 Markdown 与可打印 HTML 交付物。技术五条/管理五条尚有缺证，报告为草案，不宣称归零。打开执行记录查看工具、审批、effect、包来源和 pin。 | Generate the double-five report; open Markdown and printable HTML deliverables. Missing technical/management evidence keeps it a draft. Inspect tool calls, approvals, effects, provenance and pins in execution records. |
| 5:10–6:20 | 提议热循环组件更换批次追加 TVAC 的受审技能候选；通过原生 Skill proposal 展示文件和 digest，由人批准安装，下一轮技能生效。再批准项目内 TVAC-LOT-001 策略；下一次 ECR-016 分析显示 v1 与追加筛选。批准更改后增加 pending 的 VT-033，不能宣称试验通过。 | Propose a reviewed TVAC lot-screening skill. Inspect native Skill proposal files/digest; human approves installation, effective next turn. Approve the bounded TVAC-LOT-001 programme policy. The next ECR-016 review shows v1 and additional screening; approved change adds pending VT-033, never a fabricated passing result. |
| 6:20–7:00 | 运行 automation.mjs 创建每周一摘要，在自动化页“立即运行”，打开新会话中的摘要交付物。指出任务冻结启动目标，每次执行重新准入，拒绝无人值守审批。 | Create the Monday digest with automation.mjs; Run now in Automation and open the new session's deliverables. Target selection is frozen at creation; each run is readmitted and unattended approvals refuse. |

## 模型提示词 / Reasoning prompts

1. `先调用 aero_playbook，再用 aero_investigate 调查 AN-027。请引用峰值、限值、冷平台窗口、批次更改和相似 NCR。分清事实/假设，提出替代解释与复现方法，不批准处置。`
   / `Read aero_playbook, investigate AN-027, cite peak/limit/cold plateau/lot change/similar NCRs, separate facts from hypothesis and propose alternatives and reproduction. Do not approve disposition.`
2. `按当前证据起草 NCR-018 的返工方案，先列 use-as-is/rework/repair/scrap/return-to-supplier 的权衡。用 aero_mrb_draft 保存，不自行声称批准。`
   / `Compare all five dispositions; save an evidence-based NCR-018 rework draft with aero_mrb_draft. Do not claim approval.`
3. `用 aero_trace 和 aero_change_review(ecrId=ECR-016) 给出需求、接口和复验影响。生成 aero_report(kind=zeroing,locale=zh-CN)，强调双五条缺证。`
   / `Use aero_trace and aero_change_review for ECR-016 impacts; generate the zeroing report, explicitly retaining missing double-five evidence.`
4. `提议 TVAC-LOT-001。调用 aero_rule_propose 后，用 aero_skill_candidate(action=prepare) 提交原生候选。展示 proposalId、digest、文件，等人工审阅，再 commit。`
   / `Propose TVAC-LOT-001, then prepare a native candidate with aero_skill_candidate. Show proposalId/digest/files for human review before commit.`

## 确定性 Demo 调用 / Deterministic Demo calls

每步使用当前 revision；拒绝之后查询当前状态，不重放不确定操作。Demo 模型没有真实推理，需演示者讲解；真实模型验收会实际执行对应智能体步骤。 / Use current revision. After refusal read state; never replay an uncertain operation. The Demo model does not reason; the presenter narrates. Real acceptance executes the corresponding agent steps.

```text
call aero_playbook {}
call aero_investigate {"anomalyId":"AN-027"}
call aero_briefing {"locale":"zh-CN"}
call aero_trace {}
call aero_mrb_draft {"ncrId":"NCR-018","disposition":"rework","rationale":"Quarantine lot L2609-B, restore affected PVD-011/012/013 to the drawing and re-verify VT-001/004/008 before release.","expectedRevision":1}
call aero_decide {"kind":"mrb","id":"NCR-018","expectedRevision":2}
call aero_report {"kind":"zeroing","locale":"zh-CN"}
call aero_rule_propose {"expectedRevision":3}
call aero_skill_candidate {"action":"prepare"}
call aero_skill_candidate {"action":"commit","proposalId":"<Host returned proposalId>"}
call aero_skill_candidate {"action":"status","proposalId":"<same Host proposalId; wait for ready>"}
call aero_decide {"kind":"rule","id":"TVAC-LOT-001","expectedRevision":4}
call aero_change_review {"ecrId":"ECR-016"}
call aero_decide {"kind":"configuration","id":"ECR-016","expectedRevision":5}
```

升级演示为可选：在测试副本中安装下一版，经完整性/能力复核后，旧会话保留原 pin、新会话采用新版本；不要修改正在运行的不可变包。`/?admin` 保留宿主恢复。 / Optional upgrade: install a reviewed new version from a test copy. Old sessions retain pins; new sessions use the new version. Never edit installed immutable bytes. `/?admin` remains available.
