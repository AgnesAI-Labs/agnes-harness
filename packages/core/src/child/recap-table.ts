const nonBatchUnit = /^(?:steps?|checks?|tests?|files?|(?:项|个)?(?:步骤|检查|测试))$/iu
const tableSeparatorRow = /^\s*\|?\s*:?-{2,}:?(?:\s*\|\s*:?-{2,}:?)+\s*\|?\s*$/u
const tableStatusColumn = /^(?:status|state|execution[\s_-]?state|状态|执行态|执行状态)$/iu
const tableTaskIdHeader =
  /^(?:(?:sub-?)?(?:task|agent)|child|job|worker|task[\s_-]?id|child[\s_-]?key|id|name|任务|子任务|子代理|任务\s*id|名称)$/iu
const tableExampleColumn =
  /\b(?:example|sample|e\.g\.|exemplar|illustrative|notes?|comments?)\b|示例|样例|举例|备注/iu
const nonBatchTableCue =
  /\b(?:tests?|test\s+suites?|suites?|checks?|specs?|files?|steps?|lint(?:er)?s?|assertions?|cases?|benchmarks?|migrations?|builds?|packages?|modules?|endpoints?|routes?|queries?|lines?|bytes?|tokens?|warnings?|errors?)\b|测试(?:套件|用例|集)?|单元测试|集成测试|端到端测试|检查(?:项)?|用例|文件|步骤|构建|套件|规格|断言|校验/iu
const tableExplicitTaskCompletionLabel =
  /^(?:(?:(?:all|total|overall|batch)\s+)?(?:(?:sub-?)?(?:tasks?|agents?)|items?|jobs?|children)\s+(?:completed?|finished|done)(?:\s+count)?|(?:(?:all|total|overall|batch)\s+)?(?:completed?|finished|done)\s+(?:(?:sub-?)?(?:tasks?|agents?)|items?|jobs?|children)(?:\s+count)?|(?:总|总计|共|累计)?(?:已(?:经)?|全部)?完成(?:的)?(?:子?任务|子代理|工作)(?:数|数量|总数|进度)?|(?:子?任务|子代理|工作)(?:已)?完成(?:数|数量|总数|进度)?)$/iu
const tableBareCompletionLabel =
  /^(?:(?:(?:all|total|overall|batch)\s+)?(?:completed?|finished)|(?:总|总计|共|累计)?(?:已(?:经)?|全部)?完成(?:数|数量|总数|进度)?)$/iu
const tableRatioValue =
  /^(\d+)\s*(?:\/|of|out\s+of)\s*(\d+)(?:\s*((?:sub-?)?(?:tasks?|agents?)|items?|jobs?|children|steps?|checks?|tests?|files?|(?:项|个)?(?:子?任务|子代理|工作|步骤|检查|测试)))?\.?$/iu
const tableCountValue =
  /^(\d+)(?:\s*(?:(?:sub-?)?(?:tasks?|agents?)|items?|jobs?|children|(?:个\s*(?:子?任务|子代理|工作)|项(?:\s*(?:子?任务|子代理|工作))?(?!\s*(?:步骤|检查|测试|文件)))))?\.?$/iu

type TableViolation = { code: string; detail: string }

function isPerTaskTableRow(
  cells: readonly string[],
  headers: readonly string[] | undefined,
  hasTaskMention: (value: string) => boolean,
): boolean {
  if (!tableExampleColumn.test(headers?.[0] ?? '') && hasTaskMention(cells[0] ?? '')) return true
  if (!headers) return false
  return cells.some(
    (cell, idx) => Boolean(headers[idx] && tableTaskIdHeader.test(headers[idx])) && hasTaskMention(cell),
  )
}

export function checkTableCompletionCounts(
  text: string,
  settled: number,
  total: number,
  hasTaskMention: (value: string) => boolean,
  errors: TableViolation[],
): void {
  const checkCell = (label: string, value: string) => {
    const ratio = tableRatioValue.exec(value)
    if (ratio) {
      if (ratio[3] && nonBatchUnit.test(ratio[3].trim())) return
      if (Number(ratio[1]) !== settled || Number(ratio[2]) !== total)
        errors.push({ code: 'FALSE_COMPLETION_CLAIM', detail: `${label}: ${value}` })
      return
    }
    const count = tableCountValue.exec(value)
    if (count && Number(count[1]) !== settled)
      errors.push({ code: 'FALSE_COMPLETION_CLAIM', detail: `${label}: ${value}` })
  }
  const lines = text.split('\n')
  let headers: string[] | undefined
  let caption: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (tableSeparatorRow.test(line)) continue
    const nextSep = tableSeparatorRow.test(lines[i + 1] ?? '')
    const trimmed = line.trim()
    if (!trimmed.includes('|') || (!trimmed.startsWith('|') && !headers && !nextSep)) {
      headers = undefined
      if (/^#{1,6}\s+/.test(trimmed)) caption = trimmed
      else if (/[:：]$/.test(trimmed)) caption = trimmed.split(/[.!?。！？]\s*/u).at(-1)
      else if (trimmed) caption = undefined
      continue
    }
    const stripped = trimmed.replace(/^\||\|$/g, '')
    const cells = stripped.split('|').map((c) => c.replace(/[*_`]/g, '').trim())
    if (cells.length < 2) {
      headers = undefined
      continue
    }
    if (nextSep) {
      headers = cells
      continue
    }
    if (isPerTaskTableRow(cells, headers, hasTaskMention)) continue
    const tableNonBatch = Boolean(
      headers?.some((h) => nonBatchTableCue.test(h)) || (caption && nonBatchTableCue.test(caption)),
    )
    for (let col = 0; col < cells.length; col++) {
      const header = headers?.[col] ?? ''
      const cell = cells[col] as string
      const rowNonBatch = cells.some((c, idx) => idx !== col && nonBatchTableCue.test(c))
      const headerExplicit = Boolean(header && tableExplicitTaskCompletionLabel.test(header))
      const headerBare = Boolean(header && !headerExplicit && tableBareCompletionLabel.test(header))
      if (cell && (headerExplicit || (headerBare && !tableNonBatch && !rowNonBatch))) checkCell(header, cell)
      const cellExplicit = tableExplicitTaskCompletionLabel.test(cell)
      const cellBare = !cellExplicit && tableBareCompletionLabel.test(cell)
      if (
        col < cells.length - 1 &&
        (cellExplicit || (cellBare && !tableNonBatch && !rowNonBatch)) &&
        !headerExplicit &&
        !headerBare &&
        !tableStatusColumn.test(header)
      )
        checkCell(cell, cells[col + 1] as string)
    }
  }
}
