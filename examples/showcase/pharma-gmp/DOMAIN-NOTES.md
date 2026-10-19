# 领域说明 / Domain notes

## 范围 / Scope

虚构沙叶非无菌口服固体制剂厂，片剂 250 mg、胶囊 100 mg。固定数据时点 2024-10-20（标识 B-2410），2024 年 APQR 仅展示 10 月 1–20 日节选，不把 20 天外推全年。UI 时间为 ISO UTC；场景账龄和测量发生时间使用固定场景时钟（合成复验为 2024-10-20T12:00:00Z）；录入审计与人工签署使用实际 UTC 时间，区分模拟事件发生与本次演示录入。

Fictional Sableleaf nonsterile oral solid doses: 250 mg tablets and 100 mg capsules. B-2410 means October 2024. APQR is an October 1–20 section, not a full-year conclusion. Seed records use UTC; aging and measurement occurrence use the fixed scenario clock (synthetic retest: 2024-10-20T12:00:00Z); audit entries and signatures record actual UTC time, distinguishing simulated occurrence from this replay's recording time.

## 批记录与规格 / Batch records and specifications

称量误差 ±0.5%，制粒进风 55–70 °C，干燥 LOD 1.0–2.5%，混合均匀度 RSD≤5%，装量误差 ±5%，片剂硬度 60–100 N、脆碎度≤1%，包衣增重 2.5–3.5%。胶囊走填充步骤，无片剂硬度、脆碎度或包衣。IPC 与 CPP 在本切片共用工序测量结构，来源编号与独立操作者/复核者签名保留。

Dispensing variance ±0.5%; granulation inlet 55–70 °C; drying LOD 1.0–2.5%; blend RSD≤5%; unit weight ±5%; tablet hardness 60–100 N, friability≤1%; coating gain 2.5–3.5%. Capsules use filling without tablet hardness/friability/coating. CPP/IPC share step measurement records with source IDs and independent signatures.

QC 为产品特定演示规格：含量 95–105% 标示量、总杂质≤0.5%、溶出 Q=80%（S1 六单位最低值≥Q+5=85%，不声称所有药典均适用）、TAMC≤1000 CFU/g。未模拟逐个微生物鉴别或完整取样验证。规格仅为合成产品，不可套用于真实品种。

QC uses product-specific synthetic limits: assay 95–105% label, total impurities≤0.5%, dissolution Q=80% (S1 minimum of six units≥Q+5=85%), TAMC≤1000 CFU/g. This is not a universal pharmacopeial claim. Full sampling validation and organism identification are outside this slice.

## EM / Environmental monitoring

[EU GMP Annex 1](https://health.ec.europa.eu/medicinal-products/eudralex/eudralex-volume-4_en) §9 的 A/B/C/D 术语来自无菌生产框架。A/B 只作未使用参考，不将非无菌固体制剂误标为无菌认证区域。C-201 依场地风险选用 Grade C 参考，运行态≥0.5 µm 非活性粒子行动值 3,520,000/m³；主动空气微生物警戒/行动 50/100 CFU/m³。D 区运行态非活性粒子限度为场地自定，不冒充 Annex 1 的固定 Grade D 运行态限度。参考 A 的微生物行动值 0 代表任何检出需调查；无监测值不代表零。

Annex 1 §9 provides sterile-area grade terminology. A/B are unused references. C-201 uses a risk-selected Grade C reference, in-operation ≥0.5 µm particle action 3,520,000/m³ and site viable alert/action 50/100 CFU/m³. D in-operation particle limits are site-defined, not claimed as mandatory Annex 1 values. Grade A viable action 0 means investigate any recovery; absence of sampling is not zero.

警戒与行动用 `>` 判断。C-201 的 72 CFU/m³ 高于警戒 50，低于行动 100，不能称行动超限。LOD 与 EM 同时同室仅是相关性；探头故障和清洁缺口分别调查。DR-02 的 2024-10-16 到期影响 016/017/018；后续校准不能自动证明历史状态，必须有追溯影响评估。原始 3.4% OOS 保留；1.9% 复验与批准返工方案链接，不通过“复验合格”自动否定 OOS。

Limits use `>`. C-201's 72 CFU/m³ is an alert, below the 100 action limit. Co-occurrence is not causation. Probe drift and cleaning lapse are assessed separately. DR-02 expiry affects 016/017/018. Later calibration does not prove historical fitness: retrospective impact evidence is required. Original 3.4% OOS is retained; 1.9% retest links to approved synthetic reprocessing evidence, rather than invalidating OOS by testing into compliance.

## 质量与签名 / Quality and signatures

[ICH Q9(R1)](https://www.ich.org/page/quality-guidelines) §4 指导风险评估；[ICH Q10](https://database.ich.org/sites/default/files/Q10_Guideline.pdf) §3.2 作为偏差、CAPA、过程监测和持续改进框架。5-Why 是结构化草稿，不代替专家调查。可扩展鱼骨的六个维度见 playbook。

ICH Q9(R1) §4 informs risk assessment; Q10 §3.2 informs monitoring, CAPA and continual improvement. 5-Why is a structured draft, not an expert investigation substitute. Six fishbone dimensions appear in the playbook.

EU GMP Annex 11 §§9、14、15、[21 CFR Part 11](https://www.ecfr.gov/current/title-21/chapter-I/subchapter-A/part-11) §§11.10(e)、11.50、11.70 与 [MHRA ALCOA+ §3.10](https://www.gov.uk/government/publications/guidance-on-gxp-data-integrity) 为审计、签名含义/关联、数据完整性参考。不可删除的业务审计通过应用服务体现（底层存储管理员不在此演示信任边界内）；宿主批准凭证与版本绑定，姓名不能由模型传入。部署仍需身份重新认证、权限治理、系统验证、备份、留存、QP 资格与程序验证等真实控制，演示不声称符合 Part 11。

Annex 11 §§9/14/15, Part 11 §§11.10(e)/11.50/11.70 and MHRA ALCOA+ §3.10 inform audit, signature meaning/linking and integrity. Application services expose no audit deletion; storage administrators remain outside this demo trust boundary. Approval proof binds identity and revision; the model cannot supply a signer. Real deployment still requires re-authentication, role governance, validation, backup/retention, QP qualification and validated procedures. This demo makes no Part 11 compliance claim.

## 展示与证据一致性 / Presentation and evidence consistency

10/17 的 72 CFU/m³ 警戒关联 B-2410-017；10/19 的 121 CFU/m³ 行动限事件是另一事件，关联 B-2410-019。趋势图保留两者，017 调查不得把 19 日事件合并为同一暴露。校准措施引用 SIM-CAL 证据；返工复验与 EM 措施分别标记对应的 SIM-REPROCESS 证据范围，有效性记录追加 SIM-EFFECT。未提供的单批结论不能从同一设备关联推定。

The Oct 17 72 CFU/m³ alert belongs to B-2410-017; Oct 19's 121 CFU/m³ action excursion is separate and belongs to B-2410-019. Both remain on the trend. Calibration, reprocessing/retest and EM actions retain their respective evidence scopes; effectiveness appends its own reference. A shared device does not prove a batch-specific conclusion.

`asOf=2024-10-20` 是合成业务时钟，CAPA 到期与报表均按其计算；审计时间与签名时间为实际记录时间，不能倒填。工具的 `signature` 是当前质量记录的人签回执，`recordApprovals` 是既往签署索引，`certificate` 只代表最终 QA 放行。空放行证书不等于记录未签名。完整待签对象与证据绑定在原生业务决策中，系统或模型答案均不能替代真人签署。

`asOf=2024-10-20` is synthetic business time for due dates and reporting; audit/signature timestamps are actual recording time and are never backdated. Tool `signature` is the current human record-signing receipt, `recordApprovals` indexes earlier signoffs, and `certificate` means final QA release only. A null release certificate does not mean the records were unsigned. The native business decision binds the reviewed object and evidence; system/agent answers cannot sign.

RFT 保留首次合格口径：有偏差、记录发现或设备追溯影响评估的批次不计入分子。补校、返工、复验或最终放行不能把历史首次不合格重新算成首次合格。该演示分母仍为全部 36 批，包含未完成批次。

RFT excludes batches with deviations, findings or retrospective equipment impact assessment. Subsequent calibration, reprocessing, retesting or release cannot restore first-pass status. This demo denominator remains all 36 batches, including unfinished batches.
