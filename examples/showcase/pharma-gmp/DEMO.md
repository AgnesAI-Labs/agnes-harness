# 7 分钟投资者演示 / Seven-minute investor demo

[中文说明](README.zh-CN.md) · [English overview](README.md)

场景：虚构沙叶 OSD，2024-10-20，B-2410-017。所有证据与人员均为合成。操作会改变隔离演示档案；脚本的一次性批准是测试管理员行为，不是模型自签。真实使用在宿主原生审批中由人审阅。

Scenario: fictional Sableleaf OSD, 2024-10-20, B-2410-017. All evidence/people are synthetic. Changes affect only the isolated demo. One-time approvals in the acceptance runner represent the test administrator, never model self-signing. Real users review the Host's native approval request.

| 时间 / Time | 中文脚本 | English script |
|---|---|---|
| 0:00–0:50 | 在图库点沙叶应用卡片“安装并采用”，审阅能力、完整性、来源，确认信任启用和应用预览，观察品牌、主题，以及质量总览、待办与签署、更多的精简导航。 | Choose Install and adopt on the Sableleaf gallery application card; review capabilities/integrity/source, trust/enable and explicitly confirm application consent; observe brand, skin and slim Overview / Tasks & signatures / More navigation. |
| 0:50–1:30 | 总览：36 批、待放行、RFT、偏差分级、CAPA 逾期和 EM；点击 017 查看七工序、规格带、QC 和双人签名。 | Overview: 36 batches, release queue, RFT, deviations, overdue CAPA and EM. Open 017 to inspect seven steps, limits, QC and independent signatures. |
| 1:30–2:40 | 从偏差对象点击“调查偏差”（或输入区同名快捷操作），在当前对象页签旁编辑请求：“调查 017 的 LOD 与同室 EM，列出证据、假设、5-Why 和跨批影响，不能把相关当因果”。工具卡显示原始 LOD 3.4%、限度 1–2.5%，72 CFU/m³ 是警戒而非行动，DR-02 校准 10-16 到期；016/018 也需评估。 | Choose Investigate deviation on the object or composer; edit the request beside Current object: “Investigate 017 LOD and same-room EM; cite evidence, hypotheses, 5-Why and cross-batch impact; do not equate correlation with causation.” Evidence cards show original LOD 3.4% vs 1–2.5%, 72 CFU/m³ alert (not action), overdue DR-02 and impacted 016/018. |
| 2:40–3:40 | QA 放行助理构建档案：拒绝放行，指出批记录、偏差、EM 和设备阻断。经人工批准启动调查（0→1），录入合成校准证据到 CAPA（1→2），批准返工/独立复验 1.9% 与 EM 评估到有效性（2→3），连续三批确认并关闭（3→4），审核员复核（4→5）。每次变更审阅精确版本与证据。 | QA builds dossier and blocks release on BPR/deviation/EM/equipment. Human approves investigation (0→1), synthetic calibration evidence/CAPA (1→2), approved reprocessing/retest 1.9% and EM assessment (2→3), three-batch effectiveness/closure (3→4), then BPR review (4→5). Review exact revision and evidence each time. |
| 3:40–4:30 | QA 展示六项清单全部通过，读取签名含义，人工在会话右侧“待签署”页签批准。证书显示真实批准凭证的签名人、时间、记录版本和含义（5→6）。再次提交或旧版本均拒绝。 | QA shows six passing checks and signature meaning. Human signs in the Pending signatures tab through Host. Certificate records proof-bound signer/time/revision/meaning (5→6). Duplicate or stale releases refuse. |
| 4:30–5:10 | 生成放行档案、APQR 节选、偏差趋势 Markdown+HTML，经交付物打开/打印。打开审计页，再打开会话工具详情/执行证据，核对来源包、版本和 pin。 | Generate dossier, APQR section and deviation trend in Markdown+HTML; open/print deliverables. Inspect business audit and session tool details/execution evidence, including package/version/pin. |
| 5:10–6:20 | 质量中枢提出“使用时距校准到期≤7 天预警”新规则；用候选工具创建只读检查工具和 SKILL.md，测试、提交 review。人工审核精确哈希后发布，新会话输入 2024-10-17 与 2024-10-20，输出 due-soon=true；不把“已提议”说成“已启用”。 | Hub proposes “flag use within seven days of calibration expiry”; create read-only checking tool and SKILL.md, test, submit review. Human publishes exact reviewed hash. Fresh session with 2024-10-17 / 2024-10-20 returns due-soon=true. Proposal is not activation. |
| 6:20–7:00 | 环境监测分析员先分析趋势；在自动化页选择该智能体，建立每日 02:00 Asia/Shanghai 新会话任务，拒绝无人值守审批；运行一次生成夜间趋势，并核对冻结目标与交付物。最后切英文/深色，布局和业务数据一致。 | EM Analyst analyzes the trend; in Automation select that agent for a daily 02:00 Asia/Shanghai new-session task with unattended approvals refused. Run once, verify frozen target and nightly deliverable. Switch to English/dark and verify consistent data/layout. |

## 自然业务对话 / Natural business conversation

按以下顺序提问；智能体自行选择工具、读取证据和当前版本。标准及工作区写入权限由操作者在宿主审阅签署；完全访问下，宿主代表会话真人自动提交精确签名值，记录“完全访问下自动确认”，不弹签名卡片。拒绝、取消、过期或提交前撤权均不能写入。

Ask in sequence. The agent chooses tools and reads evidence/current revisions. With standard or workspace-write permission the operator reviews each Host signature. Full access submits the exact declared signature for the human principal without a pending card, recorded as “auto-confirmed under full access”. Rejection, cancellation, expiry and narrowing before commit cannot write.

1. **调查员**：“B-2410-017 的干燥 LOD 超限了，同房间还有 EM 警戒，帮我调查一下，给出 CAPA 建议并说明其他批次是否受影响。先不要改档案。” / **Investigator**: “B-2410-017 has a drying LOD excursion and a same-room EM alert. Investigate, suggest CAPA and assess other batches; keep the records unchanged.”
2. **质量中枢**：“请登记这次调查。我们在隔离演示中使用合成证据；每次变更都让我审阅签署。” / **Quality Hub**: “Record this investigation using synthetic evidence in this isolated demo. Let me review and sign each change.”
3. “合成证据 SIM-CAL-017 已复核：T02 as-found +4.1°C，as-left 校准合格，016/017/018 回顾评估完成。把调查推进到 CAPA。” / “Reviewed synthetic SIM-CAL-017: T02 as-found +4.1°C, acceptable as-left calibration, retrospective 016/017/018 assessment complete. Advance to CAPA.”
4. “合成返工方案、独立 LOD 1.9% 复验、QC、清洁和 EM 鉴别/重采样证据 SIM-REPROCESS-017 已复核，请登记并进入有效性评价。” / “Record reviewed synthetic SIM-REPROCESS-017: approved reprocessing, independent 1.9% LOD retest, QC, cleaning, EM identification/resampling. Begin effectiveness evaluation.”
5. “连续三批合成有效性确认和逾期升级机制验证 SIM-EFFECT-017 已完成，请完成偏差结案。之后由批记录审核员独立复核并发起我的复核签名。” / “Synthetic three-batch effectiveness and overdue escalation verification SIM-EFFECT-017 are complete. Close the deviation. Then have the BPR reviewer independently review it and request my review signature.”
6. **QA 助理**：“请核对 B-2410-017 放行清单、当前版本和固定签名含义，保留原始超限。” 看完后回复：“我确认已审阅独立审核记录和全部合成证据，请对当前版本发起我的放行签名。” / **QA**: “Check B-2410-017 release readiness, revision and fixed signature meaning; preserve the original excursion.” After review: “I have reviewed the independent BPR review and all synthetic evidence. Request my release signature for the current revision.”
7. “请生成中文放行档案和 APQR 节选，展示可打印报告，并告诉我如何追溯到证据、审批人和插件版本。” / “Generate Chinese release dossier and APQR excerpts, present printable reports and show how to trace evidence, signer and plugin version.”
8. **质量中枢**：“把‘设备使用日期距校准到期 0–7 天预警、逾期单列’做成可复用的只读技能候选。读取当前作者指南，创建、测试并提交审阅；发布由我批准。” / **Hub**: “Create, test and submit a reusable read-only skill candidate for calibration expiry within 0–7 days; report overdue separately. Use the current author guide. I will approve publication.”
9. 人工审阅文件、测试与精确摘要后发布；新会话问：“2024-10-17 使用、2024-10-20 校准到期，按刚审阅的技能判断是否应预警。” / Human reviews files/tests/exact digest and publishes. In a fresh session: “Use the reviewed skill: equipment used Oct 17, 2024 expires Oct 20. Is an alert due?”
10. **EM 分析员**：“请生成今晚的环境趋势报告。把 10/17 的 72 警戒与 10/19 的 121 行动限事件分开解释；然后建议每天凌晨两点的巡检任务。” / **EM**: “Produce tonight's EM trend report. Distinguish Oct 17's 72 alert from Oct 19's 121 action excursion, then suggest a daily 02:00 check.” 在自动化页明确选择 EM 智能体、新会话、Asia/Shanghai、无人值守审批拒绝；立即运行并打开报告。 / In Automation select EM Analyst, new session, Asia/Shanghai and refused unattended approvals; Run now and open the report.

真实模型演示使用 `../scripts/presentation.mjs pharma-gmp --real`，从空 home 经图库安装与采用，执行上述业务阶段并保存 AGH 用量与截图。密钥仅按 README 的命令级 keychain 注入，总费用不超过 $3。原确定性验收脚本只用于机制回归。

Run `../scripts/presentation.mjs pharma-gmp --real` for fresh-home gallery installation/adoption, natural business stages, AGH usage and screenshots. Inject the key per command from keychain as in README; cap total spend at $3. The deterministic runner is for mechanism regression.
