# 领域模型与参考 / Domain model and references

穹序 QV-X27 是虚构的推进阀驱动分系统，不映射任何真实型号。名称组合已通过公开检索排查明显航天品牌冲突；数据不来自客户。 / Qiongxu QV-X27 is a fictional propulsion valve-driver subsystem. A public search checked the combined name for obvious aerospace-brand collisions. No customer data is used.

## 工程解释 / Engineering interpretation

需求分 system → subsystem → component，根节点外无上级的组件被标为孤立；设计缺口、未指定验证用例、验证未通过分别列出。Verification method 包含 test / analysis / inspection / demonstration，页面中的“验证用例”并非全部必须是硬件试验。覆盖要求有设计证据、对应验证已通过且需求验证状态有效；更改批准使受影响验证失效。 / Requirements have a three-level tree. Non-root unparented components are orphans. Missing design, missing verification cases and open verification are distinct. Verification cases include test, analysis, inspection and demonstration. A design link, passing case and valid verification status are all needed; approved changes invalidate affected verification.

TVAC 记录为 1 min 展示采样，非瞬态带宽原始波形。冷平台 −40 °C，真空度约 3×10⁻⁵ Pa，驱动电流正常约 1.22 A，1.80 A 为项目限值。66–70 min 多个显示采样越限，峰值由数据计算；真实失效分析应查看高采样率波形、探头校准和控制环路。新批次焊点热疲劳引发间歇高阻与闭环补偿只是候选，电流越限本身不能证明焊点机理。相似 NCR 不等于独立复现。 / TVAC uses one-minute display samples, not raw transient-bandwidth waveforms. The plateau is −40 °C at approximately 3×10⁻⁵ Pa; normal current is about 1.22 A with a programme limit of 1.80 A. Several samples exceed the limit at 66–70 minutes. Peak is computed. Real diagnosis needs high-rate waveforms, calibration and loop dynamics. Lot solder fatigue is a hypothesis; overcurrent does not establish it. Similar NCRs do not prove reproduction.

Rework（返工）恢复原受控要求；repair（修理）可能偏离原图样，需设计权威评审。Use-as-is 是让步处置，不等于取消要求。Scrap / return-to-supplier 是报废/退供授权，不表示实物已销毁/送达。MRB 审批只批准处置；实施、复验与正式放行分离。配置更改批准也不自动产生通过证据。 / Rework restores controlled requirements; repair may depart from the drawing and needs design-authority review. Use-as-is is a concession. Scrap/return authorize action, not confirmed physical completion. MRB approval, execution, re-verification and release remain separate. Configuration approval cannot manufacture passing evidence.

双五条按技术 T1–T5（定位准确、机理清楚、问题复现、措施有效、举一反三）和管理 M1–M5（过程清楚、责任明确、措施落实、严肃处理、完善规章）记录证据。样例只有三项已审，归零报告必须为草案，关闭操作拒绝缺证。管理条目用合成审阅记录表示，不针对真实人员作处理。 / The double-five practice tracks five technical and five management criteria with evidence. Only three criteria are reviewed in the seed. Reports must stay drafts; closure refuses incomplete evidence. Management review records are synthetic and do not concern real people.

器件等级是项目自定义的 qualified / screened industrial 分类，不声称器件已获得某国家或军用质量等级。优选不替代批次鉴定，假冒风险只触发隔离和调查，不宣称已证实假冒。 / Grades are programme-defined categories, not certified national or military grades. Preferred status does not replace lot qualification. A counterfeit-risk flag triggers quarantine/investigation, not a confirmed counterfeit finding.

## 框架引用 / Named frameworks

只概述概念，不复制标准正文；本应用不是合规、认证或适航放行工具。条款引用供项目裁剪时核对正版标准。 / These references identify concepts without reproducing copyrighted requirements. This is not a certification or flight-release tool. Check licensed editions and programme tailoring.

- **ECSS-Q-ST-10C** product assurance management, **ECSS-Q-ST-20C** quality assurance, **ECSS-Q-ST-10-09C** nonconformance control, and **ECSS-E-ST-10-02C** verification: assurance plans, evidence and controlled nonconformance. [ECSS product-assurance catalogue](https://ecss.nl/standards/active-standards/product-assurance/), [ECSS active standards](https://ecss.nl/standards/active-standards/).
- **AS9100D**, §8.3.6 design changes, §8.5.2 identification/traceability, §8.7 nonconforming outputs and §10.2 corrective action inform the example's change/lot/NCR/effectiveness model. [SAE authoritative standard record](https://saemobilus.sae.org/standards/as9100d-quality-management-systems-requirements-aviation-space-defense-organizations).
- **NASA-STD-8739** workmanship family, particularly **NASA-STD-8739.4** interconnections and **NASA-STD-8739.10** EEE parts assurance, informs workmanship and part evidence. NASA-STD-8739.2/.3 are legacy soldering references, superseded in NASA practice by applicable IPC requirements; this example does not prescribe an obsolete soldering standard. [NASA workmanship](https://sma.nasa.gov/sma-disciplines/workmanship), [NASA EEE parts](https://sma.nasa.gov/sma-disciplines/eee-parts), [NASA-STD-8739.4](https://standards.nasa.gov/node/283).
- **NPR 7120.5** lifecycle/key-decision and technical review concepts inform milestones, not a claim that this synthetic board is an actual NASA KDP. [NASA lifecycle guidance](https://www.nasa.gov/reference/3-0-nasa-program-project-life-cycle/).
- **GJB 9001C** (Chinese military quality management) and **双五条归零** inform traceability, accountability, corrective-action implementation and explicit evidence closure. The double-five practice is presented as a practice, not asserted to be a verbatim clause of GJB 9001C. / 以军用质量管理和双五条实践作为概念背景，不把双五条冒称为 GJB 9001C 某条原文。

## 模型边界 / Model boundaries

审批通过宿主 authority，UI 不签名；项目内策略审批是有界数据变更。原生 Skill 候选另走 Host Skill install 审阅，安装后下一轮有效；启用策略后下一次影响分析使用规则版本。每周任务只读现状并生成摘要，不无人值守处置硬件。 / Host authority owns approval. Programme policy activation is a bounded data change. Native Skill installation has its own Host review and next-turn effect; the next impact analysis consumes the active rule version. Weekly jobs summarize state and never disposition hardware unattended.
