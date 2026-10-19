---
name: aerospace-quality-playbook
description: Evidence-first aerospace programme quality, traceability, MRB, configuration and double-five zeroing / 航天研制质量、追溯、MRB、技术状态与双五条归零。
---

只执行用户明确要求的当前步骤。读取技能或保存草案不授权后续处置、安装、规则启用或技术状态变更；完成所请求步骤后停止。thermallyCycled 是设计环境属性，不证明试验已执行；未给定验收限值的通道不能判通过。归零已审项与缺证项须分别按受控记录报告。

先读取 aero_quality 和 aero_investigate 的受控证据。把观察、关联、假设、已证实机理分开。引用试验、需求、批次、基线和审计 ID；不能把相似 NCR 当作因果证明。调用 aero_trace 定位孤立需求、设计缺口、未覆盖与未通过验证。用 aero_change_review 列出接口、需求与复验影响。

MRB 草案应比较 use-as-is / rework / repair / scrap / return-to-supplier。use-as-is 也需要有依据的让步与本示例的人工审批。返工恢复原图样；修理偏离原设计，需设计权威评审。处置后保持隔离，物理实施、复验和放行是独立步骤。调用 aero_mrb_draft 后用最新 revision 请求 aero_decide；审批被拒绝时停止，不能改用其它服务绕过。

AN-027 的焊点热疲劳只是候选。设计新旧批次冷热循环对照、同步四线电阻/电流测量、探头校准与独立失效分析。双五条归零的五个技术条目：定位准确、机理清楚、问题复现、措施有效、举一反三；五个管理条目：过程清楚、责任明确、措施落实、严肃处理、完善规章。缺任一证据不得宣称归零完成。报告用 aero_report，保持草案状态。

发现可复用检查规则时，调用 aero_rule_propose 提议 TVAC-LOT-001；它只是待审技能候选，不是自动发布插件。由人通过 aero_decide 审批后，下一次 aero_change_review 返回 screeningRequired 与 ruleVersion；追加筛选任务不能伪造试验通过。不要自行安装、放行或签署。

Perform only the explicitly requested stage. Reading a skill or saving a draft does not authorize later dispositions, installation, rule activation or configuration changes; stop after the requested stage. thermallyCycled describes design exposure, not completed testing. Channels without supplied acceptance limits cannot be declared passed. Report accepted and missing zeroing criteria separately from controlled records.

Read controlled evidence first. Separate observation, correlation, hypothesis and confirmed mechanism. Cite requirement/test/lot/baseline/audit IDs. Similar NCRs are not causal proof. Use aero_trace for orphan/design/test gaps and aero_change_review for affected requirements, interfaces and tests.

Compare all five disposition options. Rework restores the drawing; repair departs from it and needs design authority review. Even use-as-is needs a justified concession and human approval in this application. After drafting, request aero_decide with the current revision. Refusal must stop the action. Keep hardware on hold pending implementation, inspection and re-verification.

For AN-027, solder fatigue is a hypothesis. Propose old/new lot thermal-cycle controls, synchronized four-wire/current measurements, probe calibration and independent failure analysis. Never claim closure until all five technical and five management criteria have accepted evidence. Generate draft reports with aero_report. Propose reusable TVAC-LOT-001 with aero_rule_propose; it remains inactive until human approval. The next change review must show its version and screening requirement. Never invent a passing test or certification.
