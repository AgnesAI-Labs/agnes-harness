import { out, type Plant } from './model.js'
import { batchOf, emStatus } from './quality.js'

export function dossierSections(p: Plant, id: string, locale: 'zh-CN' | 'en') {
  const b = batchOf(p, id),
    zh = locale === 'zh-CN',
    t = (cn: string, en: string) => (zh ? cn : en)
  return [
    '',
    `## ${t('原始批记录 / IPC', 'Original BPR / IPC')}`,
    '| Step | Equipment / room | CPP / IPC | Result | Limit | Operator / verifier |',
    '|---|---|---|---|---|---|',
    ...b.steps.flatMap((s) =>
      s.cpp.map(
        (m) =>
          `| ${s.name[locale]} | ${s.equipment} / ${s.room} | ${m.id}: ${m.name[locale]} | ${m.value} ${m.unit}${out(m) ? ' OOS' : ''} | ${m.min}–${m.max} | ${s.operator.actor} @ ${s.operator.at}; ${s.verifier?.actor ?? 'MISSING'} @ ${s.verifier?.at ?? '—'} |`,
      ),
    ),
    '',
    `## ${t('QC 与独立复验', 'QC and independent retest')}`,
    ...[...b.qc, ...b.retests].map(
      (m) => `- ${m.id}: ${m.name[locale]} = ${m.value} ${m.unit}; ${m.min}–${m.max}; ${m.source}; ${m.at}`,
    ),
    '',
    `## ${t('偏差、根因、跨批影响和 CAPA', 'Deviation, root cause, batch impact and CAPA')}`,
    ...p.deviations
      .filter((d) => d.batch === id || d.impact.includes(id))
      .flatMap((d) => [
        `### ${d.id} · ${d.severity} · ${d.stage}`,
        d.cause || t('根因未确认', 'Root cause unconfirmed'),
        `Impact: ${d.impact.join(', ')}`,
        ...d.actions.map(
          (a) =>
            `- ${a.id}: ${a.text[locale]}; ${a.owner}; due=${a.due}; effectiveness=${a.effective}; evidence=${a.evidence || 'MISSING'}`,
        ),
      ]),
    '',
    `## ${t('环境监测与设备追溯', 'EM and equipment traceability')}`,
    ...p.samples
      .filter((s) => s.batch === id && emStatus(p, s) !== 'control')
      .map(
        (s) =>
          `- ${s.id} / ${s.room} @ ${s.at}: ${s.viable} CFU/m³, ${s.particles} particles/m³; ${emStatus(p, s)}; ${s.disposition}; ${s.evidence || 'MISSING'}`,
      ),
    ...p.equipment
      .filter((e) => b.steps.some((s) => s.equipment === e.id))
      .map(
        (e) =>
          `- ${e.id}: ${e.qualification}; calibrated=${e.calibrated}; due=${e.due}; ${e.evidence.join('; ')}`,
      ),
    '',
    `## ${t('审计索引', 'Audit index')}`,
    ...p.audit
      .filter((a) => a.record === id)
      .map(
        (a) =>
          `- ${a.id} ${a.at} ${a.actor}: ${a.action}; r${a.fromRevision}→r${a.toRevision}; approval=${a.approval ?? '—'}; session=${a.session ?? '—'}`,
      ),
  ]
}
export function reviewSections(p: Plant, locale: 'zh-CN' | 'en') {
  const zh = locale === 'zh-CN',
    t = (cn: string, en: string) => (zh ? cn : en)
  const lod = p.batches
    .flatMap((b) => b.steps.filter((s) => s.id === 'drying').flatMap((s) => s.cpp))
    .map((m) => m.value)
  return [
    '',
    `## ${t('产品和过程回顾', 'Product and process review')}`,
    ...(['tablet', 'capsule'] as const).map((form) => {
      const batches = p.batches.filter((b) => b.form === form),
        assay = batches.flatMap((b) => b.qc.filter((m) => m.id.endsWith('-assay')))
      return `- ${form}: n=${batches.length}; units=${batches.reduce((n, b) => n + b.size, 0)}; assay n=${assay.length}, range=${Math.min(...assay.map((m) => m.value))}–${Math.max(...assay.map((m) => m.value))}% label; OOS=${assay.filter(out).length}`
    }),
    `- LOD: n=${lod.length}; min=${Math.min(...lod)}%; max=${Math.max(...lod)}%; mean=${(lod.reduce((a, b) => a + b, 0) / lod.length).toFixed(2)}%. ${t('包含原始 OOS；独立复验不替换原始值。', 'Includes original OOS; independent retests do not replace originals.')}`,
    '',
    `## ${t('偏差周趋势（样本计数，不推断发生率）', 'Weekly deviation trend (counts, not inferred incidence)')}`,
    '| Period | Minor | Major | Critical | Total |',
    '|---|---:|---:|---:|---:|',
    ...[
      [1, 7],
      [8, 14],
      [15, 20],
    ].map(([start, end]) => {
      const records = p.deviations.filter((d) => {
        const day = Number(d.opened.slice(8, 10))
        return day >= start! && day <= end!
      })
      return `| 10/${start}–10/${end} | ${records.filter((d) => d.severity === 'minor').length} | ${records.filter((d) => d.severity === 'major').length} | ${records.filter((d) => d.severity === 'critical').length} | ${records.length} |`
    }),
    '',
    `## ${t('有效性与管理评审关注点', 'Effectiveness and management review')}`,
    ...p.deviations
      .filter((d) => d.stage !== 'closed')
      .map(
        (d) =>
          `- ${d.id}: ${d.stage}; ${d.actions.filter((a) => a.effective).length}/${d.actions.length} CAPA effective`,
      ),
    t(
      '建议：验证逾期升级机制、复核采样覆盖和 CAPA 有效性；本样本不足以证明长期过程能力或全年改进。',
      'Review overdue escalation, sampling coverage and CAPA effectiveness. This sample does not establish long-term process capability or full-year improvement.',
    ),
  ]
}
