# 7 分钟投资者演示 / Seven-minute investor demo

[中文说明](README.zh-CN.md) · [English overview](README.md)

场景：虚构沙叶 OSD，2024-10-20，B-2410-017。所有证据与人员均为合成。操作会改变隔离演示档案；脚本的一次性批准是测试管理员行为，不是模型自签。真实使用在宿主原生审批中由人审阅。

Scenario: fictional Sableleaf OSD, 2024-10-20, B-2410-017. All evidence/people are synthetic. Changes affect only the isolated demo. One-time approvals in the acceptance runner represent the test administrator, never model self-signing. Real users review the Host's native approval request.

| 时间 / Time | 中文脚本 | English script |
|---|---|---|
| 0:00–0:50 | 在独立 home 安装，审阅能力、完整性、来源；信任并启用。设置→应用预览并采纳沙叶，观察品牌、主题、六个入口和默认智能体。 | Install in an isolated home, review capabilities/integrity/source, trust and enable. Preview/adopt Sableleaf in Settings → Application; observe brand, skin, six pages and default agent. |
| 0:50–1:30 | 总览：36 批、待放行、RFT、偏差分级、CAPA 逾期和 EM；点击 017 查看七工序、规格带、QC 和双人签名。 | Overview: 36 batches, release queue, RFT, deviations, overdue CAPA and EM. Open 017 to inspect seven steps, limits, QC and independent signatures. |
| 1:30–2:40 | 启动“偏差调查员”，问“调查 017 的 LOD 与同室 EM，列出证据、假设、5-Why 和跨批影响，不能把相关当因果”。工具卡显示原始 LOD 3.4%、限度 1–2.5%，72 CFU/m³ 是警戒而非行动，DR-02 校准 10-16 到期；016/018 也需评估。 | Launch Deviation Investigator: “Investigate 017 LOD and same-room EM; cite evidence, hypotheses, 5-Why and cross-batch impact; do not equate correlation with causation.” Evidence cards show original LOD 3.4% vs 1–2.5%, 72 CFU/m³ alert (not action), overdue DR-02 and impacted 016/018. |
| 2:40–3:40 | QA 放行助理构建档案：拒绝放行，指出批记录、偏差、EM 和设备阻断。经人工批准启动调查（0→1），录入合成校准证据到 CAPA（1→2），批准返工/独立复验 1.9% 与 EM 评估到有效性（2→3），连续三批确认并关闭（3→4），审核员复核（4→5）。每次变更审阅精确版本与证据。 | QA builds dossier and blocks release on BPR/deviation/EM/equipment. Human approves investigation (0→1), synthetic calibration evidence/CAPA (1→2), approved reprocessing/retest 1.9% and EM assessment (2→3), three-batch effectiveness/closure (3→4), then BPR review (4→5). Review exact revision and evidence each time. |
| 3:40–4:30 | QA 展示六项清单全部通过，读取签名含义，人工在宿主批准。证书显示真实批准凭证的签名人、时间、记录版本和含义（5→6）。再次提交或旧版本均拒绝。 | QA shows six passing checks and signature meaning. Human approves in Host. Certificate records proof-bound signer/time/revision/meaning (5→6). Duplicate or stale releases refuse. |
| 4:30–5:10 | 生成放行档案、APQR 节选、偏差趋势 Markdown+HTML，经交付物打开/打印。打开审计页，再打开会话工具详情/执行证据，核对来源包、版本和 pin。 | Generate dossier, APQR section and deviation trend in Markdown+HTML; open/print deliverables. Inspect business audit and session tool details/execution evidence, including package/version/pin. |
| 5:10–6:20 | 质量中枢提出“使用时距校准到期≤7 天预警”新规则；用候选工具创建只读检查工具和 SKILL.md，测试、提交 review。人工审核精确哈希后发布，新会话输入 2024-10-17 与 2024-10-20，输出 due-soon=true；不把“已提议”说成“已启用”。 | Hub proposes “flag use within seven days of calibration expiry”; create read-only checking tool and SKILL.md, test, submit review. Human publishes exact reviewed hash. Fresh session with 2024-10-17 / 2024-10-20 returns due-soon=true. Proposal is not activation. |
| 6:20–7:00 | 环境监测分析员先分析趋势；在自动化页选择该智能体，建立每日 02:00 Asia/Shanghai 新会话任务，拒绝无人值守审批；运行一次生成夜间趋势，并核对冻结目标与交付物。最后切英文/深色，布局和业务数据一致。 | EM Analyst analyzes the trend; in Automation select that agent for a daily 02:00 Asia/Shanghai new-session task with unattended approvals refused. Run once, verify frozen target and nightly deliverable. Switch to English/dark and verify consistent data/layout. |

## 确定性工具步骤 / Deterministic tool steps

Demo 模型使用精确 `call` 提示，真实模型使用自然语言调查并以这些工具结果核对。Demo uses exact `call` prompts; real-model reasoning is checked against these results.

```text
call pharma_inspect {"batch":"B-2410-017"}
call pharma_dossier {"batch":"B-2410-017"}
call pharma_record {"action":"investigate","batch":"B-2410-017","expectedRevision":0}
call pharma_record {"action":"advance","batch":"B-2410-017","expectedRevision":1,"evidence":"SIM-CAL-017: synthetic as-found +4.1 C and as-left calibration reviewed; retrospective 016/017/018 assessment"}
call pharma_record {"action":"advance","batch":"B-2410-017","expectedRevision":2,"evidence":"SIM-REPROCESS-017: approved synthetic reprocessing protocol, independent LOD 1.9%, QC and cleaning/resampling reviewed"}
call pharma_record {"action":"advance","batch":"B-2410-017","expectedRevision":3,"evidence":"SIM-EFFECT-017: three synthetic verification batches and escalation effectiveness confirmed"}
call pharma_record {"action":"review","batch":"B-2410-017","expectedRevision":4}
call pharma_release {"batch":"B-2410-017","expectedRevision":5,"meaning":"I approve this batch for release after reviewing the complete quality dossier. / 我已审核完整质量档案，批准本批放行。"}
call pharma_report {"kind":"dossier","batch":"B-2410-017","locale":"zh-CN"}
call pharma_report {"kind":"apqr","locale":"zh-CN"}
call pharma_report {"kind":"deviations","locale":"en"}
```

在 EM 智能体会话先生成趋势：`call pharma_report {"kind":"em","locale":"zh-CN"}`。然后打开自动化页，新建任务并明确选择“环境监测分析员”，每日 02:00、Asia/Shanghai、新会话、无人值守审批拒绝，提示为同一条报告命令。选择智能体会把其 Loop、Bundle、预设及模型冻结到任务目标；普通 `schedule_create` 的新会话目标不等同于选择该智能体。点击“立即运行”验证，无需修改系统时间。

In the EM session run `call pharma_report {"kind":"em","locale":"en"}`. In Automation create a daily 02:00 Asia/Shanghai task, explicitly choose EM Analyst, a fresh session and refused unattended approvals, and use that report command as its prompt. Agent selection freezes its Loop, Bundle, preset and model; an ordinary schedule_create new-session target is not an agent selection. Use Run now without changing system time.

校准规则候选通过质量中枢自然语言创建，先调用 plugin_helper_guide 获取当前模板，遵循当前平台的 create→test→commit→人审发布流程。Ask the Hub to create the calibration-rule candidate, starting with plugin_helper_guide and the current create→test→commit→human publication process.

## 可重复验收 / Repeatable acceptance

仓根先构建本包和本地 CLI。运行 `scripts/acceptance.mjs` 用新 home 验证 inspect→install→adopt、角色调用、CAPA、人工放行、报告、候选成长、定时任务和重启。`--real` 使用每条命令注入的 DeepSeek 测试密钥；每应用总上限 $3，证据只保存脱敏业务结果与 AGH usage。浏览器脚本须使用 web-gate-lock 和 heavy-lock，保存中文/英文、浅色/深色与关键流截图；报告记录实际结果，不把静态页面或单测当真实模型通过。

Build this package and the local CLI first. `scripts/acceptance.mjs` uses a fresh home for installation/adoption, roles, CAPA, human release, reports, reviewed growth, schedule and restart. `--real` uses the per-command DeepSeek test key; keep total application spend below $3. Evidence stores redacted business results and AGH usage only. Run the browser script under web-gate-lock and heavy-lock for zh/en light/dark and workflow screenshots. Report actual results, not static UI or unit tests as real-model acceptance.
