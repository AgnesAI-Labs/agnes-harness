import type { Plant } from './model.js'
import { dashboard, dossier, emStatus } from './quality.js'
import { dossierSections, reviewSections } from './report-sections.js'

const escape = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
export function report(
  p: Plant,
  kind: 'dossier' | 'apqr' | 'deviations' | 'em',
  batch: string,
  locale: 'zh-CN' | 'en',
) {
  const zh = locale === 'zh-CN',
    t = (cn: string, en: string) => (zh ? cn : en)
  const title =
    t('沙叶质量中枢 · ', 'Sableleaf Quality Hub · ') +
    {
      dossier: t('批次放行档案', 'Batch release dossier'),
      apqr: t('年度产品质量回顾（节选）', 'APQR section'),
      deviations: t('偏差趋势', 'Deviation trend'),
      em: t('夜间环境趋势', 'Nightly EM trend'),
    }[kind]
  const lines = [
    `# ${title}`,
    '',
    t(
      '合成演示数据；场景日期 2024-10-20；非监管提交文件。',
      'Synthetic demo; scenario date 2024-10-20; not a regulatory submission.',
    ),
    `Revision: ${p.revision}`,
    '',
  ]
  if (kind === 'dossier') {
    const check = dossier(p, batch)
    lines.push(
      `## ${batch}`,
      ...check.rows.map((r) => `- [${r.pass ? 'x' : ' '}] ${r.title[locale]}`),
      '',
      JSON.stringify(check.certificate ?? { status: 'BLOCKED / 阻止放行' }, null, 2),
      ...dossierSections(p, batch, locale),
    )
  } else if (kind === 'em') {
    lines.push(t('## 20 天趋势；不是全年外推', '## 20-day trend; no annual extrapolation'))
    for (const r of p.rooms) {
      const samples = p.samples.filter((s) => s.room === r.id)
      lines.push(
        `- ${r.id} (${r.grade}): n=${samples.length}; alert=${samples.filter((s) => emStatus(p, s) === 'alert').length}; action=${samples.filter((s) => emStatus(p, s) === 'action').length}; CFU/m³ alert/action=${r.viableAlert}/${r.viableAction}`,
      )
    }
    lines.push(
      '',
      t(
        '## C-201 日趋势（每日两次主动空气采样的最大值）',
        '## C-201 daily trend (maximum of two active-air samples)',
      ),
      '| Day | n | CFU/m³ max | Alert | Action |',
      '|---|---:|---:|---:|---:|',
      ...Array.from({ length: 20 }, (_, i) => {
        const samples = p.samples.filter((s) => s.room === 'C-201' && Number(s.at.slice(8, 10)) === i + 1)
        return `| 10/${i + 1} | ${samples.length} | ${samples.length ? Math.max(...samples.map((s) => s.viable)) : 'NO SAMPLE'} | 50 | 100 |`
      }),
    )
    lines.push(
      t(
        '警戒：复核、增加采样并评估趋势；行动：隔离受影响批次并启动调查。相关不等于因果。',
        'Alert: review, increase sampling and assess trends. Action: quarantine affected batches and investigate. Correlation is not causation.',
      ),
    )
  } else {
    const k = dashboard(p)
    lines.push(
      t('## 2024 年回顾节选：仅 10 月 1–20 日样本', '## 2024 review section: October 1–20 sample only'),
      `Batches: ${k.batches}; released: ${k.released}; RFT: ${k.rft}%`,
      t(
        'RFT 分母为全部 36 批；未完成批次使该演示指标仅供运营参考。',
        'RFT denominator includes all 36 batches; unfinished batches make this an operational demo indicator.',
      ),
      '',
      t('| 偏差 | 级别 | 阶段 | 批次 | CAPA |', '| Deviation | Class | Stage | Batch | CAPA |'),
      '|---|---|---|---|---|',
      ...p.deviations.map(
        (d) =>
          `| ${d.id} | ${d.severity} | ${d.stage} | ${d.batch} | ${d.actions.filter((a) => a.effective).length}/${d.actions.length} |`,
      ),
      '',
      t(
        '## 建议：校准到期前 7 天预警；需人工审阅候选规则后启用。',
        '## Recommendation: flag calibration expiry within 7 days; enable only after candidate review.',
      ),
    )
  }
  if (kind === 'apqr' || kind === 'deviations') lines.push(...reviewSections(p, locale))
  lines.push(
    '',
    t(
      '框架参考（转述）：EU GMP Annex 1 §9；Annex 11 §§9、14、15；21 CFR Part 11 §§11.10(e)、11.50、11.70；ICH Q9(R1) §4；ICH Q10 §3.2；ALCOA+。',
      'Framework references (paraphrased): EU GMP Annex 1 §9; Annex 11 §§9,14,15; 21 CFR Part 11 §§11.10(e),11.50,11.70; ICH Q9(R1) §4; ICH Q10 §3.2; ALCOA+.',
    ),
  )
  const markdown = lines.join('\n')
  const html = `<!doctype html><html lang="${locale}"><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:15px/1.6 system-ui;max-width:900px;margin:40px auto;padding:24px;color:#172e34}pre{white-space:pre-wrap;overflow-wrap:anywhere}h1{border-bottom:3px solid #087d7d;padding-bottom:16px}@media print{body{margin:0;padding:0}h1{break-after:avoid}pre{font-size:11pt}}</style><h1>${escape(title)}</h1><pre>${escape(markdown)}</pre></html>`
  return { title, markdown, html }
}
