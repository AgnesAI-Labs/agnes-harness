import { type Batch, type Plant, DEMO_DATE, label, out } from './model.js'

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
    ...s.cpp
      .filter(out)
      .map((m) => ({
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
      title: label('偏差及批次影响已关闭', 'Deviations and batch impact closed'),
      pass: deviations.every((d) => d.stage === 'closed'),
    },
    {
      key: 'em',
      title: label('环境警戒已评估 / 行动已关闭', 'EM alerts assessed / actions closed'),
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
    ready: rows.every((r) => r.pass),
    rows,
    findings: findings(p, id),
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
    findings: findings(p, id),
    em,
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
        p.batches.filter((b) => !p.deviations.some((d) => d.batch === b.id) && !findings(p, b.id).length)
          .length) /
        p.batches.length,
    ),
    deviations: Object.fromEntries(
      ['minor', 'major', 'critical'].map((c) => [c, open.filter((d) => d.severity === c).length]),
    ),
    overdue: open.flatMap((d) => d.actions).filter((a) => !a.effective && a.due < DEMO_DATE).length,
    excursions: p.samples.filter((s) => emStatus(p, s) !== 'control' && s.disposition === 'pending').length,
  }
}
