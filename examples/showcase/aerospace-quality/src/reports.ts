import { health, investigate } from './domain.js'
import type { State } from './model.js'
export function report(s: State, kind: 'zeroing' | 'digest', locale: 'zh-CN' | 'en') {
  const zh = locale === 'zh-CN',
    h = health(s),
    a = investigate(s)
  const title =
    kind === 'zeroing'
      ? zh
        ? 'AN-027 双五条归零报告 · 草案'
        : 'AN-027 double-five zeroing report · DRAFT'
      : zh
        ? '每周不合格品审理摘要'
        : 'Weekly nonconformance digest'
  const lines = [
    `# ${title}`,
    '',
    `${zh ? '虚构项目 / 合成数据' : 'Fictional programme / synthetic data'} · QV-X27 · ${zh ? '数据修订' : 'Data revision'} ${s.revision}`,
    '',
    `## ${zh ? '结论与边界' : 'Findings and boundaries'}`,
    zh
      ? '冷平台峰值电流越限；批次关联支持焊点热疲劳假设，但不能证明因果。复现与措施有效性证据尚缺。审批不等于硬件返修完成、鉴定通过或飞行放行。'
      : 'Cold-plateau current exceeded limits. Lot correlation supports a solder-fatigue hypothesis, not causality. Reproduction and effectiveness evidence remain open. Approval is not physical rework completion, qualification or flight release.',
    '',
    `- ${zh ? '峰值 / 限值' : 'Peak / limit'}: ${a.peakA.toFixed(3)} / 1.800 A; −40 °C; 66–70 min`,
    `- ${zh ? '受影响状态' : 'Affected configuration'}: BL-C · L2609-B · PVD-011/012/013`,
    `- NCR: ${h.ncrs}; ECR: ${h.ecrs}; ${zh ? '验证覆盖' : 'Verification coverage'}: ${h.verified}/${h.total}`,
    '',
    `## ${zh ? '证据链' : 'Evidence chain'}`,
    ...a.evidence.map((id) => `- ${id}`),
    '',
    `## ${zh ? '处置与复验' : 'Disposition and re-verification'}`,
    ...s.ncrs
      .filter((r) => r.lot === 'L2609-B')
      .map(
        (r) =>
          `- ${r.id}: ${r.status} / ${r.disposition ?? (zh ? '未定' : 'undecided')} · ${r.rationale || (zh ? '待 MRB 审理' : 'MRB review pending')}`,
      ),
    `- VT-001, VT-004, VT-008; ${zh ? '新旧批次对照、四线连续性、校准探头与切片分析' : 'A/B lots, four-wire continuity, calibrated probe and cross-section analysis'}`,
    '',
    `## ${zh ? '双五条证据' : 'Double-five evidence'}`,
    '| ID | Criterion / 条目 | Evidence / 证据 | Status / 状态 |',
    '| --- | --- | --- | --- |',
    ...s.zeroing[0]!.criteria.map(
      (c) =>
        `| ${c.id} | ${c.title[locale]} | ${c.evidence.join(', ') || '—'} | ${c.accepted ? (zh ? '已审阅' : 'Reviewed') : zh ? '待补证' : 'Open'} |`,
    ),
    '',
    `## ${zh ? '受审规则候选' : 'Reviewed rule candidate'}`,
    `${s.rule.status} · v${s.rule.version} · ${s.rule.body}`,
    '',
    `## ${zh ? '审计与责任' : 'Audit and accountability'}`,
    ...s.audit
      .slice(-12)
      .map((e) => `- r${e.revision} ${e.at} ${e.action} ${e.subject}; Host approval: ${e.approval ?? '—'}`),
    '',
    'ECSS-Q-ST-10/20 series; ECSS-Q-ST-10-09C; AS9100D §8.3.6 / §8.5.2 / §8.7 / §10.2; NASA-STD-8739 workmanship concepts; NPR 7120.5 lifecycle reviews; GJB 9001C; 双五条归零. Conceptual demonstration, no certification claim.',
  ]
  const markdown = lines.join('\n')
  const escapeHtml = (v: string) =>
    v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const blocks: string[] = []
  let list = false,
    table = false
  const close = () => {
    if (list) {
      blocks.push('</ul>')
      list = false
    }
    if (table) {
      blocks.push('</tbody></table>')
      table = false
    }
  }
  for (const line of lines.slice(1)) {
    if (!line) {
      close()
      continue
    }
    if (line.startsWith('| ---')) continue
    if (line.startsWith('| ')) {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((cell) => escapeHtml(cell.trim()))
      if (!table) {
        close()
        blocks.push(
          `<table><caption>${zh ? '双五条证据矩阵' : 'Double-five evidence matrix'}</caption><thead><tr>${cells.map((c) => `<th scope="col">${c}</th>`).join('')}</tr></thead><tbody>`,
        )
        table = true
      } else blocks.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    } else if (line.startsWith('- ')) {
      if (!list) {
        close()
        blocks.push('<ul>')
        list = true
      }
      blocks.push(`<li>${escapeHtml(line.slice(2))}</li>`)
    } else {
      close()
      blocks.push(
        line.startsWith('## ') ? `<h2>${escapeHtml(line.slice(3))}</h2>` : `<p>${escapeHtml(line)}</p>`,
      )
    }
  }
  close()
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:15px/1.7 system-ui;max-width:960px;margin:48px auto;padding:24px;color:#15283c;overflow-wrap:anywhere}h1{font-size:28px;border-bottom:3px solid #247b90;padding-bottom:16px}h2{font-size:19px;margin-top:28px}table{border-collapse:collapse;width:100%;font-size:13px}caption{text-align:left;font-weight:600;margin:8px 0}th,td{border:1px solid #cad6df;padding:9px;text-align:left}th{background:#eef5f8}tr{break-inside:avoid}@media print{body{margin:0;padding:0;font-size:11px}h1{font-size:24px}h2{break-after:avoid}table{font-size:10px}}</style></head><body><h1>${escapeHtml(title)}</h1>${blocks.join('')}</body></html>`
  return { title, markdown, html, revision: s.revision }
}
