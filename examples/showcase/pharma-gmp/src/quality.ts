import { type Batch, DEMO_DATE, label, out, type Plant, SIGNATURE_MEANING } from './model.js'

export function batchOf(p: Plant, id: string): Batch {
  const b = p.batches.find((b) => b.id === id)
  if (!b) throw new Error('Batch not found / 批次不存在')
  return b
}
export function emStatus(p: Plant, sample: Plant['samples'][number]) {
  const room = p.rooms.find((r) => r.id === sample.room)!
  if (sample.viable > room.viableAction || sample.particles > room.particleAction) return 'action'
  if (sample.viable > room.viableAlert || sample.particles > room.particleAlert) return 'alert'
  return 'control'
}
export function findings(p: Plant, id: string) {
  const b = batchOf(p, id)
  return b.steps.flatMap((s) => [
    ...s.cpp.filter(out).map((m) => ({
      severity: 'major',
      code: 'CPP',
      text: label(
        `${m.name['zh-CN']} ${m.value} ${m.unit}，限度 ${m.min}–${m.max}；原始结果保留`,
        `${m.name.en} ${m.value} ${m.unit}, limit ${m.min}–${m.max}; original retained`,
      ),
      source: m.source,
    })),
    ...(!s.verifier || s.verifier.actor === s.operator.actor || s.verifier.at < s.at
      ? [
          {
            severity: 'major',
            code: 'ALCOA',
            text: label(
              '独立复核签名缺失或时序异常',
              'Missing independent verification or inconsistent timestamps',
            ),
            source: s.id,
          },
        ]
      : []),
    ...p.equipment
      .filter((e) => e.id === s.equipment && (e.due < s.at.slice(0, 10) || e.qualification !== 'qualified'))
      .map((e) => ({
        severity: 'major',
        code: 'EQUIPMENT',
        text: label(`${e.id} 校准或确认不合格`, `${e.id} calibration/qualification issue`),
        source: e.id,
      })),
  ])
}
export function dossier(p: Plant, id: string) {
  const b = batchOf(p, id),
    deviations = p.deviations.filter((d) => d.batch === id || d.impact.includes(id))
  const originalsResolved = b.steps
    .flatMap((s) => s.cpp.filter(out))
    .every(
      (m) =>
        b.retests.some((r) => r.id === `RETEST-${m.id}` && !out(r)) &&
        deviations.some((d) => d.stage === 'closed'),
    )
  const rows = [
    {
      key: 'bpr',
      title: label('批记录及 ALCOA+ 复核', 'BPR and ALCOA+ review'),
      pass:
        b.review === 'accepted' &&
        b.steps.every((s) => s.verifier && s.verifier.actor !== s.operator.actor && s.verifier.at >= s.at) &&
        originalsResolved,
    },
    {
      key: 'deviations',
      title: label('偏差结案 / 关联批次影响已评估', 'Deviations closed / linked-batch impact assessed'),
      pass: deviations.every((d) => d.stage === 'closed'),
    },
    {
      key: 'em',
      title: label('环境事件风险评估与处置证据', 'EM risk assessment and disposition evidence'),
      pass:
        b.steps.every((step) => p.samples.some((s) => s.batch === id && s.room === step.room)) &&
        p.samples
          .filter((s) => s.batch === id && emStatus(p, s) !== 'control')
          .every((s) => s.disposition === 'assessed' && Boolean(s.evidence)),
    },
    {
      key: 'qc',
      title: label('QC 含量 / 杂质 / 溶出 / 微生物', 'QC assay / impurities / dissolution / micro'),
      pass: b.qc.length === 4 && b.qc.every((m) => !out(m)),
    },
    {
      key: 'equipment',
      title: label('设备确认及使用时校准追溯', 'Equipment qualification and use-time calibration'),
      pass: b.steps.every((s) => {
        const e = p.equipment.find((e) => e.id === s.equipment)
        return (
          e &&
          e.qualification === 'qualified' &&
          e.due >= DEMO_DATE &&
          (e.calibrated <= s.at.slice(0, 10) ||
            e.evidence.some((x) => x.startsWith('RETROSPECTIVE:') && x.includes(id)))
        )
      }),
    },
    { key: 'production', title: label('生产完成', 'Production complete'), pass: b.status !== 'production' },
  ]
  return {
    batch: id,
    revision: p.revision,
    asOf: DEMO_DATE,
    signatureMeaning: SIGNATURE_MEANING,
    ready: rows.every((r) => r.pass),
    rows,
    blockers: rows.filter((r) => !r.pass).map((r) => r.key),
    findings: findings(p, id),
    evidence: {
      recordApprovals: p.audit
        .filter((entry) => entry.record === id && entry.approval)
        .map((entry) => ({
          action: entry.action,
          approvalId: entry.approval!,
          recordedBy: entry.actor,
          recordedAt: entry.at,
          reviewedRevision: entry.fromRevision,
        })),
      deviations,
      retests: b.retests,
      equipment: p.equipment.filter((e) => b.steps.some((s) => s.equipment === e.id)),
      em: p.samples.filter((s) => s.batch === id && emStatus(p, s) !== 'control'),
      interpretation: label(
        'findings 保留原始历史发现；当前阻断以 blockers 和 rows.pass 为准，须结合偏差结案及批准返工复验依据审阅。revision 是当前状态版本；证书 dossierRevision 是签署前被审阅的版本，签署本身使状态版本加一。asOf 是合成业务场景日期，CAPA 到期按该日期评估；审计 recordedAt 是当前真实记录时间。certificate 仅用于最终 QA 放行；null 不代表前面的质量记录未签名，recordApprovals 引用各次人工签署决策。assessed 是警戒风险评估，不等同于行动限事件自动关闭。017 放行不代表关联批次 016/018 放行，它们仍由各自档案决定处置。',
        'findings retain original historical observations. Current blockers are the failed checklist rows; review deviation closure and approved reprocessing/retest evidence. revision is current state; certificate.dossierRevision identifies the pre-signature dossier reviewed. Signing itself increments state revision by one. asOf is synthetic business time and the basis for CAPA due-date assessment; audit recordedAt is actual recording time. certificate is only the final QA release certificate: null does not mean earlier records were unsigned; recordApprovals reference their human signature decisions. assessed means an alert risk assessment, not automatic closure of an action excursion. Release of 017 does not release linked batches 016/018; each retains its own dossier and disposition requirements.',
      ),
    },
    certificate: b.certificate,
  }
}
export function investigation(p: Plant, id: string) {
  const b = batchOf(p, id),
    equipment = p.equipment.filter((e) => b.steps.some((s) => s.equipment === e.id))
  const em = p.samples.filter((s) => s.batch === id && emStatus(p, s) !== 'control')
  const suspect = equipment.filter((e) => e.due < DEMO_DATE || e.qualification !== 'qualified')
  return {
    batch: id,
    revision: p.revision,
    findings: findings(p, id),
    em,
    rooms: p.rooms.filter((room) => b.steps.some((step) => step.room === room.id)),
    equipment,
    relatedBatches: p.batches
      .filter((x) => x.id !== id && x.steps.some((s) => suspect.some((e) => e.id === s.equipment)))
      .map((b) => b.id),
    hypothesis: label(
      '探头漂移可能导致干燥终点误判；EM 警戒仅时间空间相关，不能证明同一根因。需校准前后数据和清洁调查验证。',
      'Probe drift may cause an incorrect drying endpoint. EM is temporally/spatially correlated, not proof of a shared cause. Verify with as-found/as-left calibration and cleaning investigation.',
    ),
  }
}
export function dashboard(p: Plant) {
  const open = p.deviations.filter((d) => d.stage !== 'closed')
  return {
    batches: p.batches.length,
    production: p.batches.filter((b) => b.status === 'production').length,
    awaiting: p.batches.filter((b) => b.status === 'review').length,
    released: p.batches.filter((b) => b.status === 'released').length,
    rft: Math.round(
      (100 *
        p.batches.filter(
          (b) =>
            !p.deviations.some((d) => d.batch === b.id) &&
            !findings(p, b.id).length &&
            !p.equipment.some((equipment) =>
              equipment.evidence.some((evidence) => evidence.startsWith(`RETROSPECTIVE:${b.id}:`)),
            ),
        ).length) /
        p.batches.length,
    ),
    deviations: Object.fromEntries(
      ['minor', 'major', 'critical'].map((c) => [c, open.filter((d) => d.severity === c).length]),
    ),
    overdue: open.flatMap((d) => d.actions).filter((a) => !a.effective && a.due < DEMO_DATE).length,
    excursions: p.samples.filter((s) => emStatus(p, s) !== 'control' && s.disposition === 'pending').length,
  }
}
