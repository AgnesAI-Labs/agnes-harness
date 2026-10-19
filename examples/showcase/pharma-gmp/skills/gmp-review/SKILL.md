---
name: gmp-review
description: Review synthetic OSD batch evidence, investigate deviations, trend EM and prepare a human-approved release. 审核合成固体制剂批次、调查偏差、分析 EM 并准备人工放行。
---

# GMP 质量工作规程 / GMP quality playbook

这是虚构沙叶工厂的合成场景，时点 2024-10-20；不要推断现实生产许可。按用户语言回答。先调用 pharma_inspect 和 pharma_dossier。每条结论附测量/记录编号、限度、单位和时间；区分原始记录、推测和已验证事实。

This is the fictional Sableleaf plant, a synthetic scenario as of 2024-10-20, not production authorization. Respond in the user's language. Start with pharma_inspect and pharma_dossier. Cite record IDs, limits, units and timestamps; distinguish originals, hypotheses and verified facts.

质量记录工具返回 signature（本次业务签名回执）；dossier.certificate 仅是最终 QA 批次放行证书，null 不表示此前记录未签名。dossier.evidence.recordApprovals 是先前签署索引。场景 asOf=2024-10-20，CAPA 到期按合成场景日期评估；审计 recordedAt 是今天实际记录时间，不代表合成事件今天才发生。放行必须使用 dossier.signatureMeaning 原文，不提议改写。

Tool signature is the current record-signing receipt; dossier.certificate is only the final QA release certificate. null does not mean earlier records were unsigned. evidence.recordApprovals indexes prior signoffs. asOf=2024-10-20 is synthetic business time; audit recordedAt is actual recording time. Assess due dates in scenario time. Use dossier.signatureMeaning verbatim for release.

业务签署：用户明确要求登记、推进、复核或放行时，直接调用相应业务工具。工具内部先请求宿主 `business.confirm` 人工签名，签名批准前不会写入。不要先用 ask_user_question、ui_render 或文字“同意”重复收集签名；这些不能代替业务签署，也不要把问题控件不可用误判为业务工具不可用。investigate 登记待验证假设，只有后续明确合成的校准证据才确认漂移。按本场景批准的连续三批有效性方案执行，不编造额外已完成验证。

Business signatures: when the user explicitly requests recording, advancement, review or release, invoke the corresponding business tool. It requests Host `business.confirm` before any write. Do not collect duplicate signatures with ask_user_question, ui_render or a text “approve”; these cannot sign. An unavailable question widget does not make the business tool unavailable. Investigation records a hypothesis; only later explicit synthetic calibration evidence confirms drift. Follow the approved three-batch effectiveness scenario without inventing completed checks.

BPR 复核签署使用 pharma_record 的 review 动作，用于完成清单的 bpr 项；该项尚未通过是待复核状态，不是禁止复核。此签名确认质量记录，不是最终放行含义。设备 evidence 保留带修订标签的历史快照，EM 当前状态由 samples.disposition 及后续评估证据判定，不把早期 pending 快照当成当前未评估。

BPR review uses pharma_record action review to complete the bpr checklist item; pending bpr does not prohibit that review. This signs the quality record, not final release. Equipment evidence retains revision-labelled historical snapshots; current EM status comes from samples.disposition and subsequent assessment evidence, not an earlier pending note.

1. 批记录：检查称量→制粒→干燥→混合→压片或胶囊填充→包衣（片剂）→包装。比较 CPP/IPC 与具体产品规格；检查操作者和独立复核者、时间序列、数据来源。按 ALCOA+ 解释缺口，不宣称自动验证全部数据完整性属性。
   BPR: check dispensing → granulation → drying → blending → compression/filling → coating (tablets) → packaging. Compare CPP/IPC against product-specific limits. Review independent signatures, chronology and source. Explain ALCOA+ gaps; do not claim comprehensive automated data-integrity validation.
2. 调查：使用 5-Why；提出鱼骨维度（人员、设备、方法、物料、测量、环境）。LOD 与同室 EM 相关不证明共同因果。探头漂移需 as-found/as-left 校准证据；评估 B-2410-016/017/018。CAPA 须责任人、期限、证据与连续三批有效性检查。pharma_record 的 advance 只录入明确合成的演示证据，不能编造真实仪器结果；每次写入均由人工审批。
   Investigation: use 5-Why and fishbone dimensions (people/equipment/method/material/measurement/environment). Co-occurring LOD/EM does not prove causation. Probe drift needs as-found/as-left evidence; assess B-2410-016/017/018. Assign CAPA owners, dates, evidence and three-batch effectiveness. pharma_record advance records explicitly synthetic demonstration evidence only, with human approval on each write.
3. EM：警戒限触发复核、加密采样和趋势评估；行动限触发调查、风险评估和受影响批次隔离。未采样不等于零。A/B 为未使用参考，非无菌固体制剂 C/D 阈值为场地风险自定；Annex 1 §9 为术语与分级参考。
   EM: alerts trigger review, increased sampling and trend assessment; action excursions trigger investigation, risk assessment and batch quarantine. No sample is not zero. A/B are unused references; C/D limits are site risk-based for nonsterile OSD, with Annex 1 §9 as reference terminology.
4. QA：清单全部通过后，先解释精确档案版本和签名含义，再调用 pharma_release 等待宿主人工批准。签名含义必须为 `I approve this batch for release after reviewing the complete quality dossier. / 我已审核完整质量档案，批准本批放行。`。不得提供自己的批准人或审批凭证。原始 OOS 不覆盖，复验不自行否定 OOS；返工须合成批准方案并留下完整追溯。最终输出 pharma_report（dossier/APQR/deviations/em），其内部调用 present 展示 Markdown 与 HTML。
   QA: only after every checklist item passes explain the exact revision and signature meaning, then call pharma_release and wait for Host human approval. Use the exact bilingual statement above. Never supply a signer/approval proof. Retests do not independently invalidate OOS. Preserve originals and approved reprocessing evidence. pharma_report generates dossier/APQR/deviations/em Markdown and HTML and invokes present.
   档案解释：`findings` 保留原始历史发现，当前阻断是 `blockers` / 未通过的清单项；同时检查 `evidence` 的结案、返工复验、EM 和设备追溯，不能仅因历史超限仍在就说档案矛盾。`revision` 是状态版本，签名本身加一；证书的 `dossierRevision` 指签署前的审阅版本。
   Dossier interpretation: findings retain historical originals; blockers / failed rows identify current release blockers. Review evidence for closure, reprocessing/retest, EM and equipment. A retained OOS is not itself a contradictory ready status. Signing increments state revision; certificate.dossierRevision identifies the pre-signature reviewed version.
5. 成长：在质量中枢会话提出“校准到期前 7 天预警”候选，用 plugin_helper_create 创建一个只读检查工具及 SKILL.md，输入批次工序日期与设备到期日，0≤天数≤7 时标记。先 test、commit 到 review；人工审阅精确哈希批准后才发布；新会话调用该候选工具验证 B-2410-017/DR-02。不得自行跳过审阅或标记已启用。工具和技能一起注册时，作者测试须为声明的 skills 注入提供 services.skills.register 测试替身（收集技能定义）；否则 Cordis 不会装配该入口。通过 createPluginTestHost 的真实工具调用检查 structured 结果，不能仅断言 invoke 存在或删除失败用例。
   Growth: in the Hub session propose a reviewed candidate for “calibration expiry within 7 days”. Use plugin_helper_create for a read-only checking tool plus SKILL.md, comparing step date and due date (0≤days≤7). Test, commit to review, then human-publish the exact hash. Verify the tool in a fresh session. Never self-approve or claim activation before review. For a plugin injecting both tools and skills, provide a services.skills.register test double to createPluginTestHost so Cordis can mount its declared dependencies; collect the skill definition there. Invoke the real registered tool and assert its structured result, rather than only checking invoke exists or deleting failing cases.
6. 自动化：先生成 EM 报告并建议每日 02:00 Asia/Shanghai 的任务参数。指导用户在自动化页明确选择环境监测智能体、新会话、unattendedApproval=refuse，提示调用 pharma_report kind=em。该选择冻结智能体的 Loop、Bundle、预设及模型，每次运行重新准入。普通 schedule_create 新会话不自动克隆当前角色；不要把它说成同一智能体。不得定时放行。
   Automation: generate the EM report and propose daily 02:00 Asia/Shanghai parameters. Guide the user to choose EM Analyst explicitly in Automation, a new session and unattendedApproval=refuse, prompting pharma_report kind=em. That selection freezes the agent's Loop, Bundle, preset and model; each run is re-admitted. An ordinary schedule_create new-session task does not clone the current role. Never schedule batch release.

参考 / References (paraphrased): EU GMP Annex 11 §§9,14,15 (audit/signatures/release), 21 CFR Part 11 §§11.10(e),11.50,11.70 (audit/meaning/linking), ICH Q9(R1) §4 (risk), ICH Q10 §3.2 (PQS), MHRA GxP data integrity §3.10 (ALCOA+). This unvalidated demo does not implement production identity re-authentication, QP licensing or validated LIMS/MES integration. 本未验证演示未实现生产身份重新认证、QP 资格审查或经过验证的 LIMS/MES 集成。
