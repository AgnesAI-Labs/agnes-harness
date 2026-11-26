import { externalChildren } from '@agnes/core-child-control/child/directory'
import { hasChildControl } from '@agnes/core-child-control/child/store'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { ChildAgentStatus, RecapFactSnapshot, SubtaskFactRecord } from '@agnes/extension-api'
import type { AssistantMessage } from '@agnes/protocol'
import { promptLanguage } from '../request/note-language.js'
import type { SessionImpl } from '../step/session.js'
import {
  composeRecapMarkdown,
  normalizeRecapLocale,
  type RecapLocale,
  renderDeterministicNarrative,
  renderTruthBase,
} from './recap-formatter.js'
import { buildRecapFactSnapshot } from './recap-snapshot.js'
import { ownedChildTree } from './sessions.js'

type Violation = { code: string; detail: string }
type Validation = { valid: boolean; violations: readonly Violation[] }

const universalCompletion = [
  /(?:全部|全都|均|都|所有(?:的)?(?:子?任务|工作|事项|步骤)?)(?:已经|现已|全部|成功|顺利|执行|处理|已|均|都|被|了|\s)*(?:完成|成功|搞定)/gu,
  /\b(?:all|both|each|every|everything|(?:the\s+)?(?:(?:entire|whole)\s+)?batch)(?:\s+(?:\d+|of|the|our|subtasks?|tasks?|work|items?|children|child|jobs?|steps?|assignments?))*\s+(?:(?:is|are|has|have|been|was|were|now|fully|successfully)\s+)*(?:completed?|done|succeeded|finished|successful)\b/giu,
  /\b(?:completed|finished)\s+(?:everything|all\s+(?:sub)?tasks)\b|\b(?:nothing|no (?:work|tasks?))\s+(?:remains?|left|outstanding)\b/giu,
]

const batchRatioAfter =
  /(\d+)\s*(?:\/|of|out of)\s*(\d+)\s*(?:((?:sub)?(?:tasks?|agents?)|items?|jobs?|children|steps?|checks?|tests?|files?|(?:项|个)?(?:子?任务|子代理|工作|步骤|检查|测试))\s*)?(?:(?:are|were|have\s+been)\s+)?(?:completed?|done|finished|succeeded|已完成|完成)/giu
const batchRatioBefore =
  /(?:已(?:经)?|共|总共|一共|累计)?完成(?:了)?(?:\s*(?:子?任务|子代理|工作|数量|总数))?\s*[:：—–=-]?\s*(\d+)\s*\/\s*(\d+)(?:\s*((?:项|个)?(?:子?任务|子代理|任务|步骤|检查|测试)))?/giu
const batchRatioBeforeEn =
  /\b(?:(?:(?:sub)?(?:tasks?|agents?)|items?|jobs?|children)\s+(?:completed?|finished|done)|(?:completed?|finished|done(?:\s+with)?)(?:\s+(?:(?:sub)?(?:tasks?|agents?)|items?|jobs?|children))?)(?:\s*[:：—–=-]\s*|\s+)(\d+)\s*(?:\/|of|out of)\s*(\d+)(?:\s+((?:sub)?(?:tasks?|agents?)|items?|jobs?|children|steps?|checks?|tests?|files?))?\b/giu
const batchCountBeforeEn =
  /\b(?:(?:(?:sub)?(?:tasks?|agents?)|items?|jobs?|children)\s+(?:completed?|finished|done)\s*[:：—–=-]\s*(\d+)(?!\s*(?:\/|of\b|out\s+of\b|%|ms\b|s\b|sec|min|(?:k|m|g|t)?b\b)|[-:/\d]|\.\d)|(?:completed?|finished|done(?:\s+with)?)(?:\s*[:：—–=-]\s*|\s+)(?:all\s+)?(\d+)\s+(?:(?:sub)?(?:tasks?|agents?)|items?|jobs?|children)\b|(?:completed?|finished)\s+(?:(?:sub)?(?:tasks?|agents?)|items?|jobs?|children)\s*[:：—–=-]\s*(\d+)(?!\s*(?:\/|of\b|out\s+of\b|%|ms\b|s\b|sec|min|(?:k|m|g|t)?b\b)|[-:/\d]|\.\d)|(?:completed?|finished)\s*[:：—–=-]\s*(\d+)(?!\s*(?:\/|of\b|out\s+of\b|%|ms\b|s\b|sec|min|(?:k|m|g|t)?b\b|steps?|checks?|tests?|files?|tokens?|lines?|bytes?)|[-:/\d]|\.\d))/giu
const batchCountAfterEn =
  /(?<![/\d.])\b(\d+)\s+((?:sub)?(?:tasks?|agents?)|items?|jobs?|children)\s+(?:(?:are|were|have\s+been|now|already|successfully)\s+)*(?:completed?|done|finished|succeeded)\b/giu
const batchCountBeforeZh =
  /(?:已(?:经)?|共|总共|一共|累计)?完成(?:了)?(?:\s*(?:子?任务|子代理|工作))?\s*[:：—–=-]?\s*(\d+)\s*(?:个\s*(?:子?任务|子代理|工作)|项(?:\s*(?:子?任务|子代理|工作))?(?!\s*(?:步骤|检查|测试|文件)))|(?:已(?:经)?|共|总共|一共|累计)?完成(?:了)?(?:\s*(?:子?任务|子代理|工作|数量|总数))?\s*[:：—–=-]\s*(\d+)(?!\s*(?:[/\d%个项步骤检查测试文件行秒]|分钟|小时|字节|字符|ms\b|s\b|sec|min|(?:k|m|g|t)?b\b)|[-:/\d]|\.\d)/gu
const batchCountAfterZh =
  /(?<![/\d.])(\d+)\s*(?:个\s*(?:子?任务|子代理|工作)|项(?:\s*(?:子?任务|子代理|工作))?(?!\s*(?:步骤|检查|测试|文件)))\s*(?:已(?:经)?|均已?|都已?|全部|顺利)?(?:完成|结束|搞定)/gu
const nonBatchUnit = /^(?:steps?|checks?|tests?|files?|(?:项|个)?(?:步骤|检查|测试))$/iu
const nonBatchUnitBefore = /(?:\b(?:steps?|checks?|tests?|files?)|步骤|检查|测试|文件)\s*$/iu
const batchHint = /\b(?:all|total|overall|batch)\b|全部|总共|整批/iu
const tableSeparatorRow = /^\s*\|?\s*:?-{2,}:?(?:\s*\|\s*:?-{2,}:?)+\s*\|?\s*$/u
const tableStatusColumn = /^(?:status|executionState|状态|执行态)$/iu
const tableCompletionLabel =
  /^(?:(?:(?:all|total|overall|batch)\s+)?(?:(?:sub-?)?(?:tasks?|agents?)|items?|jobs?|children)\s+(?:completed?|finished|done)(?:\s+count)?|(?:(?:all|total|overall|batch)\s+)?(?:completed?|finished|done)\s+(?:(?:sub-?)?(?:tasks?|agents?)|items?|jobs?|children)(?:\s+count)?|(?:(?:all|total|overall|batch)\s+)?(?:completed?|finished)|(?:总|总计|共|累计)?(?:已(?:经)?|全部)?完成(?:的)?(?:子?任务|子代理|工作)?(?:数|数量|总数|进度)?|(?:子?任务|子代理|工作)(?:已)?完成(?:数|数量|总数|进度)?)$/iu
const tableRatioValue =
  /^(\d+)\s*(?:\/|of|out\s+of)\s*(\d+)(?:\s*((?:sub-?)?(?:tasks?|agents?)|items?|jobs?|children|steps?|checks?|tests?|files?|(?:项|个)?(?:子?任务|子代理|工作|步骤|检查|测试)))?\.?$/iu
const tableCountValue =
  /^(\d+)(?:\s*(?:(?:sub-?)?(?:tasks?|agents?)|items?|jobs?|children|(?:个\s*(?:子?任务|子代理|工作)|项(?:\s*(?:子?任务|子代理|工作))?(?!\s*(?:步骤|检查|测试|文件)))))?\.?$/iu

function checkTableCompletionCounts(
  text: string,
  snapshot: RecapFactSnapshot,
  settled: number,
  total: number,
  errors: Violation[],
) {
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
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (tableSeparatorRow.test(line)) continue
    const nextSep = tableSeparatorRow.test(lines[i + 1] ?? '')
    const trimmed = line.trim()
    if (!trimmed.includes('|') || (!trimmed.startsWith('|') && !headers && !nextSep)) {
      headers = undefined
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
    if (mentions(line, snapshot.subtasks).length > 0) continue
    for (let col = 0; col < cells.length; col++) {
      const header = headers?.[col] ?? ''
      const cell = cells[col] as string
      if (header && cell && tableCompletionLabel.test(header)) checkCell(header, cell)
      if (
        col < cells.length - 1 &&
        tableCompletionLabel.test(cell) &&
        !tableCompletionLabel.test(header) &&
        !tableStatusColumn.test(header)
      )
        checkCell(cell, cells[col + 1] as string)
    }
  }
}

function checkRatioMatches(
  clause: string,
  refs: Mention[],
  settled: number,
  total: number,
  errors: Violation[],
) {
  const prose = clause.replace(/[*_`]/g, '').replace(/\s+/g, ' ')
  const uniqueTasks = [...new Map(refs.map((r) => [r.task.taskId, r.task])).values()]
  const hasBatchHint = batchHint.test(prose)
  const ratioSpans: Array<[number, number]> = []
  const checkRatio = (match: RegExpExecArray, numRaw: string, denRaw: string, unit: string | undefined) => {
    ratioSpans.push([match.index, match.index + match[0].length])
    const before = prose.slice(0, match.index)
    if (negated(before)) return
    const nonBatch =
      (unit ? nonBatchUnit.test(unit.trim()) : false) || (!unit && nonBatchUnitBefore.test(before))
    const num = Number(numRaw)
    const den = Number(denRaw)
    if (uniqueTasks.length > 0 && !hasBatchHint) {
      if (nonBatch) return
      const subTotal = uniqueTasks.length
      const subSettled = uniqueTasks.filter((t) => t.status === 'completed' || t.status === 'idle').length
      if ((num === subSettled && den === subTotal) || (num === settled && den === total)) return
      errors.push({ code: 'FALSE_COMPLETION_CLAIM', detail: match[0] })
      return
    }
    if (nonBatch && !hasBatchHint && total > 0) return
    if (num !== settled || den !== total) errors.push({ code: 'FALSE_COMPLETION_CLAIM', detail: match[0] })
  }
  for (const m of prose.matchAll(batchRatioAfter)) checkRatio(m, m[1] as string, m[2] as string, m[3])
  for (const m of prose.matchAll(batchRatioBefore)) checkRatio(m, m[1] as string, m[2] as string, m[3])
  for (const m of prose.matchAll(batchRatioBeforeEn)) checkRatio(m, m[1] as string, m[2] as string, m[3])

  const overlapsRatio = (start: number, end: number) => ratioSpans.some(([s, e]) => start < e && end > s)
  const checkCountOnly = (match: RegExpExecArray, numRaw: string) => {
    const start = match.index
    const end = start + match[0].length
    if (overlapsRatio(start, end)) return
    const before = prose.slice(0, start)
    if (negated(before) || nonBatchUnitBefore.test(before)) return
    const num = Number(numRaw)
    if (uniqueTasks.length > 0 && !hasBatchHint) {
      const subSettled = uniqueTasks.filter((t) => t.status === 'completed' || t.status === 'idle').length
      if (num === subSettled || num === settled) return
      errors.push({ code: 'FALSE_COMPLETION_CLAIM', detail: match[0] })
      return
    }
    if (num !== settled) errors.push({ code: 'FALSE_COMPLETION_CLAIM', detail: match[0] })
  }
  for (const m of prose.matchAll(batchCountBeforeEn))
    checkCountOnly(m, (m[1] ?? m[2] ?? m[3] ?? m[4]) as string)
  for (const m of prose.matchAll(batchCountAfterEn)) checkCountOnly(m, m[1] as string)
  for (const m of prose.matchAll(batchCountBeforeZh)) checkCountOnly(m, (m[1] ?? m[2]) as string)
  for (const m of prose.matchAll(batchCountAfterZh)) checkCountOnly(m, m[1] as string)
}

function completionChecks(text: string, snapshot: RecapFactSnapshot, errors: Violation[]) {
  const prose = text.replace(/[*_`]/g, '').replace(/\s+/g, ' ')
  if (snapshot.hasIncompleteWork || snapshot.counts.total === 0) {
    for (const pattern of universalCompletion)
      for (const m of prose.matchAll(pattern))
        if (!negated(prose.slice(0, m.index))) errors.push({ code: 'FALSE_COMPLETION_CLAIM', detail: m[0] })
  }
  const settled =
    snapshot.counts.completed + snapshot.subtasks.filter((task) => task.status === 'idle').length
  const total = snapshot.counts.total
  for (const clause of clauses(text)) {
    const refs = mentions(clause, snapshot.subtasks)
    checkRatioMatches(clause, refs, settled, total, errors)
  }
  checkTableCompletionCounts(text, snapshot, settled, total, errors)
}

const negative =
  /(?:\b(?:not|never|neither|cannot|can't|isn't|aren't|wasn't|weren't|hasn't|haven't|didn't|doesn't|don't)(?:\s+(?:yet|be|say|claim|that|been|all))*\s*|(?:没有|并非|并未|并不|未能|尚未|还没|不是|不能说|未|没)\s*)$/iu
const negated = (before: string) => negative.test(before)

const statuses: [ChildAgentStatus, RegExp][] = [
  ['completed', /\b(?:complete[d]?|done|finished|succeeded|successful)\b|(?:已(?:经)?|顺利)?完成/giu],
  [
    'waiting_approval',
    /\b(?:waiting_approval|(?:waiting (?:on|for)|pending|needs?|awaiting) (?:an? )?approval)\b|(?:等待|待|需要)审批/giu,
  ],
  ['paused', /\bpaused\b|暂停/giu],
  ['disconnected', /\bdisconnected\b|失联|断开/giu],
  ['failed', /\b(?:failed|failure)\b|失败/giu],
  ['cancelled', /\bcancell?ed\b|取消/giu],
  ['running', /\brunning\b|运行中|正在运行/giu],
  ['starting', /\bstarting\b|启动中/giu],
  ['interrupted', /\binterrupted\b|中断/giu],
  ['idle', /\bidle\b|空闲/giu],
]

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
type Mention = { task: SubtaskFactRecord; start: number; end: number }
function mentions(line: string, tasks: readonly SubtaskFactRecord[]): Mention[] {
  return tasks
    .flatMap((task) => {
      const pattern = new RegExp(`(?<![\\w./-])${escapePattern(task.taskId)}(?![\\w/-]|\\.\\w)`, 'gu')
      return [...line.matchAll(pattern)].map((m) => ({ task, start: m.index, end: m.index + m[0].length }))
    })
    .sort((a, b) => a.start - b.start)
}

function collectConjunctionOwners(line: string, previous: Mention[], owner: Mention): Mention[] {
  const owners = [owner]
  for (let i = previous.length - 2; i >= 0; i--) {
    const left = previous[i]
    if (!left) break
    if (!/^\s*[\]\x60]*\s*(?:and|与|和|、|&)\s*[[\x60]*\s*$/iu.test(line.slice(left.end, owners[0]?.start)))
      break
    owners.unshift(left)
  }
  return owners
}

function statusChecks(line: string, refs: Mention[], errors: Violation[], seen: Set<string>) {
  for (const [status, pattern] of statuses) {
    for (const match of line.matchAll(pattern)) {
      if (refs.some((r) => match.index >= r.start && match.index < r.end)) continue
      const before = line.slice(0, match.index)
      const previous = refs.filter((r) => r.end <= match.index)
      const owner = previous.at(-1) ?? refs[0]
      if (!owner) continue
      // "A and B completed" makes the same claim for both.
      const owners = collectConjunctionOwners(line, previous, owner)
      for (const { task } of owners) {
        const denied = negated(before)
        const matches = task.status === status || (task.status === 'idle' && status === 'completed')
        if (matches === denied)
          errors.push({ code: 'STATUS_MISMATCH', detail: `${task.taskId}: ${match[0]}` })
        else if (!denied) seen.add(task.taskId)
      }
    }
  }
}

const nonSubjectBeforeRef =
  /(?:\b(?:in|from|of|about|for|into|on)\s+(?:the\s+)?(?:(?:logs?|output|messages?|lines?|quotes?|text)\s+(?:of|for|from)\s+)?|(?:来自|关于|在)\s*)$/iu
const directModifierBeforeRef = /^\s*(?:的\s*)?(?:(?:sub)?(?:task|agent)|child|子任务|子代理)?\s*[[\x60]*$/iu
const metaExplanationCue =
  /\b(?:means?|translates?(?:\s+to|\s+as)?|translation|quoted?|log(?:ged|s)?|printed|output)\b|意思是|含义|翻译|日志/iu

const EN_DIRECT_LINK_TOKENS = new Set(
  "is was are were has have been be remains remain seems seem to now already currently still successfully fully just not never yet isn't aren't wasn't weren't hasn't haven't".split(
    ' ',
  ),
)

const ZH_DIRECT_LINK_TOKENS =
  '当前状态为 目前状态为 当前状态是 目前状态是 状态为 状态是 当前为 当前是 目前为 目前是 当前 目前 已经 现已 正在 仍在 还是 并未 尚未 没有 并非 不是 仍 已 都 均 也 是 为 未 没'.split(
    ' ',
  )

const MAX_DIRECT_LINK_CHARS = 80
const MAX_DIRECT_LINK_TOKENS = 8

/** Bounded O(n) check that `between` only contains a direct copula/adverb link from a ref to a status word. */
function isDirectAfterRef(between: string): boolean {
  if (between.length > MAX_DIRECT_LINK_CHARS) return false
  let rest = between.replace(/^[\s\]`)'"》」』”’）]+/u, '').trim()
  if (!rest) return true
  if (rest === ':' || rest === '：' || rest === '—' || rest === '–' || rest === '-' || rest === '->') {
    return true
  }
  rest = rest.replace(/^(?:[:：—–-]|->)\s*/u, '').trim()
  if (!rest) return true
  if (/^[a-z'\s]+$/iu.test(rest)) {
    const tokens = rest.toLowerCase().split(/\s+/)
    return tokens.length <= MAX_DIRECT_LINK_TOKENS && tokens.every((tok) => EN_DIRECT_LINK_TOKENS.has(tok))
  }
  let pos = 0
  for (let steps = 0; steps < MAX_DIRECT_LINK_TOKENS && pos < rest.length; steps++) {
    while (pos < rest.length && /\s/u.test(rest[pos] as string)) pos++
    if (pos >= rest.length) return true
    const matched = ZH_DIRECT_LINK_TOKENS.find((tok) => rest.startsWith(tok, pos))
    if (!matched) return false
    pos += matched.length
  }
  while (pos < rest.length && /\s/u.test(rest[pos] as string)) pos++
  return pos >= rest.length
}

const ordinaryConditionalEn =
  /(?:^|[\s(])(?:if|whether|when|whenever|once|unless|until|before|after|while|assume|assuming|suppose|supposing|pretend|imagine|given(?:\s+that)?|provided(?:\s+that)?|in\s+case(?:\s+that)?|on\s+the\s+assumption(?:\s+that)?|wait(?:ing)?\s+for)\b/iu
const ordinaryDirectiveEn =
  /^\s*(?:(?:and|or|then|next|first|also|just|always|please|kindly)\s+)*(?:(?:please|kindly|let's|let\s+us|try\s+to|remember\s+to|be\s+sure\s+to|make\s+sure\s+to|to|don't\s+forget\s+to)\s+|(?:you|we|they|one)\s+(?:should|must|need\s+to|have\s+to|ought\s+to|may\s+want\s+to|might\s+want\s+to)\s+|(?:need|needs|needed|have|has|had|want|wants|going)\s+to\s+)?(?:check|verify|confirm|validate|inspect|ensure|make\s+sure|see|determine|test|ask|find\s+out|tell\s+me|let\s+me\s+know)\b/iu
const ordinaryLeadingQuestionEn =
  /^\s*(?:is|are|was|were|has|have|did|does|do|can|could|will|would|should)\s+$/iu
const ordinaryConditionalZh =
  /(?:如果|若|假如|假设|假定|设想|要是|一旦|除非|只要|当|等到|等|待|直到|是否|有没有)/u
const ordinaryDirectiveZh =
  /^\s*(?:(?:(?:请|麻烦|先|请先|记得|务必|需要|需|要|应该|应当|应|去)\s*)+(?:检查|核查|核实|确认|验证|查看|排查|判断|确保|等待)(?!了)|(?:看看|看下|看一下|问一下|告诉我|(?:检查|核查|核实|确认|验证|查看|排查)一下))/u
const ordinaryTrailingNonAssertive =
  /^\s*(?:(?:了)?\s*(?:吗|么|呢|的话|之后|以后|后|时|再|才|就)(?:[\s。！？，,.!?]|$)|or\s+not\b)/iu
const ordinaryMarkdownPrefix =
  /^(?:\s*(?:>+\s*|(?:[-*+•]|(?:\(\d+\)|\d+[.)]))\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+))+/u
const ordinaryDeclarativeSubjectEn =
  /^(?:i|i'm|i've|i'd|i'll|he|she|it|this|that|here|there|confirmed|verified|checked|validated|already|happy|pleased|glad|able|writing|we\s+(?:are|were|have|had|can|could|will|would|did|do|ran|executed|checked|confirmed|verified|validated|just|already)|we're|we've|we'd|we'll)\b/iu
const ordinaryPurposeTailEn =
  /\b(?:in\s+order\s+)?to\s+(?:confirm|verify|check|validate|inspect|ensure|see|determine|make\s+sure|find\s+out)(?:\s+(?:that|whether|if))?\s*$/iu
const ordinaryFillerOnlyEn = /^(?:just|only|also|simply|merely|and|or|then|so)$/iu
const ordinaryDeclarativeSubjectZh = /^(?:我(?:们(?!应该|应当|应|需要|需|要))?|本人|目前|现已|已经|已|经)/u
const ordinaryPurposeTailZh =
  /(?:以|来|以便|为了|用于|用来)\s*(?:检查|核查|核实|确认|验证|查看|排查|判断|确保)(?!了)\s*$/u

function isNonAssertiveOrdinaryClause(clause: string, leading: string, afterMatch: string): boolean {
  if (/[?？]$/u.test(clause.trimEnd()) || ordinaryTrailingNonAssertive.test(afterMatch)) return true
  const norm = leading
    .replace(ordinaryMarkdownPrefix, '')
    .replace(/[*~]+/g, '')
    .replace(/(?<!\w)_+|_+(?!\w)/g, '')
    .trimStart()
  if (
    ordinaryLeadingQuestionEn.test(norm) ||
    ordinaryConditionalEn.test(norm) ||
    ordinaryConditionalZh.test(norm) ||
    ordinaryDirectiveEn.test(norm) ||
    ordinaryDirectiveZh.test(norm)
  )
    return true
  const enPurpose = ordinaryPurposeTailEn.exec(norm)
  if (enPurpose && enPurpose.index > 0) {
    const head = norm.slice(0, enPurpose.index).trim()
    if (
      head &&
      !ordinaryFillerOnlyEn.test(head) &&
      !ordinaryDeclarativeSubjectEn.test(head) &&
      !/\b(?:is|are|was|were|am|has|have|had)\s+(?:happy|pleased|glad|able|ready|writing|confirming)\b/iu.test(
        head,
      )
    )
      return true
  }
  return ordinaryPurposeTailZh.test(norm) && !ordinaryDeclarativeSubjectZh.test(norm)
}

function stripNonAssertiveSpans(text: string, knownIds: ReadonlySet<string>): string {
  // Remove fenced code blocks and markdown blockquotes.
  let cleaned = text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/^\s*>.*$/gm, ' ')
  // Unwrap inline code that solely names a known child ID; strip other inline code spans.
  cleaned = cleaned.replace(/`([^`\n]+)`/g, (_m, inner: string) =>
    knownIds.has(inner.trim()) ? inner.trim() : ' ',
  )
  // Strip quoted text (logs, translations, examples).
  cleaned = cleaned.replace(
    /"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|《[^》\n]*》/g,
    ' ',
  )
  return cleaned
}

function validateOrdinaryReply(text: string, snapshot: RecapFactSnapshot): Validation {
  const violations: Violation[] = []
  const knownIds = new Set(snapshot.subtasks.map((task) => task.taskId))
  const cleaned = stripNonAssertiveSpans(text, knownIds)
  for (const clause of cleaned.split(
    /\n+|[,，;；]|(?<=[。！？])|(?<=[.!?])\s+|\s+(?:but|however)\s+|但是|但/iu,
  )) {
    const refs = mentions(clause, snapshot.subtasks)
    if (refs.length === 0) continue
    for (const [status, pattern] of statuses) {
      for (const match of clause.matchAll(pattern)) {
        if (refs.some((r) => match.index >= r.start && match.index < r.end)) continue
        const before = clause.slice(0, match.index)
        const afterMatch = clause.slice(match.index + match[0].length)
        const previous = refs.filter((r) => r.end <= match.index)
        if (previous.length > 0) {
          const owner = previous.at(-1) as Mention
          const between = clause.slice(owner.end, match.index)
          if (!isDirectAfterRef(between)) continue
          const owners = collectConjunctionOwners(clause, previous, owner)
          const leading = clause.slice(0, owners[0]?.start ?? owner.start)
          if (nonSubjectBeforeRef.test(leading)) continue
          if (isNonAssertiveOrdinaryClause(clause, leading, afterMatch)) continue
          for (const { task } of owners) {
            const denied = negated(before)
            const matches = task.status === status || (task.status === 'idle' && status === 'completed')
            if (matches === denied)
              violations.push({ code: 'STATUS_MISMATCH', detail: `${task.taskId}: ${match[0]}` })
          }
          continue
        }
        const owner = refs[0] as Mention
        const between = clause.slice(match.index + match[0].length, owner.start)
        if (!directModifierBeforeRef.test(between) || metaExplanationCue.test(clause)) continue
        const leading = clause.slice(0, match.index)
        if (isNonAssertiveOrdinaryClause(clause, leading, clause.slice(owner.end))) continue
        const denied = negated(before)
        const matches =
          owner.task.status === status || (owner.task.status === 'idle' && status === 'completed')
        if (matches === denied)
          violations.push({ code: 'STATUS_MISMATCH', detail: `${owner.task.taskId}: ${match[0]}` })
      }
    }
  }
  return { valid: violations.length === 0, violations }
}

const missingBefore =
  /(?:\b(?:expected|missing|planned|not (?:generated|created|written|produced))(?:\s+(?:file|path|artifact))?|预期|计划|缺少|尚未生成|未生成|未写入)\s*[:：]?\s*$/iu
const missingAfter =
  /^\s*[\x60)'"\]]*\s*(?:(?:is|was|has|remains)\s+)?(?:missing|expected|(?:not|never)\s+(?:been\s+)?(?:generated|created|written|produced)|(?:尚未|未)(?:生成|写入)|缺失)/iu
const declaredFile = /\b(?:created|wrote|generated|produced|artifact|file|path)\s*[:=]?\s*$/iu
const namedFile = /^(?:README|Makefile|Dockerfile|LICENSE|NOTICE)$/u
const urlSchemePattern = /(?<![\w.-])(?:https?:\/\/|mailto:)/giu
const urlHardStop = /[\s<>[\]"'`\u3000-\u303f\uff00-\uffef]/u
// Take a whole quoted path or link target (including balanced parentheses in URLs) before unquoted tokens.
const pathTokens =
  /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s()]+(?:\([^\s()]*\)[^\s()]*)*))(?:\s+"[^"]*")?\s*\)|^\s*\[[^\]\n]+\]:\s*<?([^\s>]+)>?|[\x60"]([^\x60"\n]+)[\x60"]|\b(?:README|Makefile|Dockerfile|LICENSE|NOTICE)\b(?![./])|(?<![\w./\\-])(?:(?:[A-Za-z]:)?[/\\]|[\p{L}\p{N}_.@~+-]+[/\\])[\p{L}\p{N}_.@~%+\\/-]+|(?<![\w.-])[\p{L}\p{N}_@+-]*\.[\p{L}][\p{L}\p{N}_.+-]*/gu
const webUrl = /^(?:https?|mailto):/iu
const webDomainOrTicker =
  /^(?:[\p{L}\p{N}-]+\.)+(?:com|org|net|io|cn|gov|edu|co|ai|news|tv|uk|jp|hk|sg|de|fr|[A-Z])$/u
const fileExt = /\.(?:[a-zA-Z][a-zA-Z0-9]{1,7}|[chmrs])$/u
const rootedPath = /^(?:[A-Za-z]:[/\\]|\/|\.\.?\/)/u

type UrlSpan = { start: number; end: number; text: string }
function findBareUrls(line: string): UrlSpan[] {
  const spans: UrlSpan[] = []
  let lastEnd = 0
  for (const match of line.matchAll(urlSchemePattern)) {
    const start = match.index
    if (start < lastEnd) continue
    let i = start + match[0].length
    let parenDepth = 0
    while (i < line.length) {
      const ch = line[i] as string
      if (urlHardStop.test(ch)) break
      if (ch === '(') {
        parenDepth++
      } else if (ch === ')') {
        if (parenDepth === 0) break
        parenDepth--
      }
      i++
    }
    const raw = line.slice(start, i)
    const text = raw.replace(/[.,!?;:]+$/u, '')
    if (!text || text.length <= match[0].length) continue
    lastEnd = start + text.length
    spans.push({ start, end: lastEnd, text })
  }
  return spans
}

function looksLikeArtifactPath(token: string) {
  if (!token || /^\d+(?:\/\d+)+$/.test(token)) return false
  if (/\s/.test(token)) return (rootedPath.test(token) || /[/\\]/.test(token)) && fileExt.test(token)
  if (rootedPath.test(token)) return true
  return fileExt.test(token)
}
function artifactChecks(line: string, refs: Mention[], snapshot: RecapFactSnapshot, errors: Violation[]) {
  const urlSpans = findBareUrls(line)
  const reportedUrls = new Set<number>()
  for (const match of line.matchAll(pathTokens)) {
    const start = match.index
    const end = start + match[0].length
    const link = match[1] ?? match[2] ?? match[3]
    if (!link) {
      const urlIdx = urlSpans.findIndex((span) => start < span.end && end > span.start)
      if (urlIdx >= 0) {
        const span = urlSpans[urlIdx] as UrlSpan
        const urlBefore = line.slice(0, span.start)
        if (declaredFile.test(urlBefore) && !reportedUrls.has(urlIdx)) {
          reportedUrls.add(urlIdx)
          errors.push({ code: 'FABRICATED_ARTIFACT', detail: span.text })
        }
        continue
      }
    }
    const token = link ?? match[4] ?? match[0].replace(/[.!?]+$/, '')
    const before = line.slice(0, start)
    const claimed = declaredFile.test(before)
    if (!claimed && (webUrl.test(token) || (!link && webDomainOrTicker.test(token)))) continue
    if (!link && !looksLikeArtifactPath(token) && !namedFile.test(token) && !claimed) continue
    if (!link && !claimed && /^\d+\/\d+$/.test(token)) continue
    if (!link && refs.some((r) => r.task.taskId === token || (start >= r.start && end <= r.end))) continue
    const after = line.slice(end)
    const assertsWrite =
      /^\s*(?:(?:was|is|has been)\s+)?(?:written|created|generated|produced|exists)\b|^\s*已(?:生成|写入)/iu
    if (!assertsWrite.test(after) && (missingBefore.test(before) || missingAfter.test(after))) continue
    const base = token.split(/[/\\]/).at(-1)
    const owners = snapshot.subtasks.filter((t) => t.artifacts.some((a) => a.path.split('/').at(-1) === base))
    const sameName = owners.length > 1
    const owner = refs.filter((r) => r.start < end).at(-1)?.task ?? refs[0]?.task
    const exact = snapshot.allowedArtifactPaths.includes(token)
    const owned = owner?.artifacts.some((a) => a.path === token)
    const duplicatePath = owners.filter((t) => t.artifacts.some((a) => a.path === token)).length > 1
    if (sameName && (token === base || duplicatePath) && (!owner || !owners.includes(owner)))
      errors.push({ code: 'AMBIGUOUS_SAME_NAME_ARTIFACT', detail: token })
    else if (owner && exact && !owned)
      errors.push({ code: 'STATUS_MISMATCH', detail: `${owner.taskId}: ${token}` })
    if (!exact && (link || claimed || token !== base || !sameName || !owner || !owners.includes(owner)))
      errors.push({ code: 'FABRICATED_ARTIFACT', detail: token })
  }
}

function clauses(text: string) {
  // Keep filename dots, URLs and markdown targets intact. "but" starts a new assertion and negation scope.
  return text.split(/[\n;；。！？，]|(?<=[.!?])\s+|\s+(?:but|however)\s+|但是|但(?=全部|所有)/iu)
}

function stripTruthBase(
  text: string,
  snapshot: RecapFactSnapshot,
): { includesTruth: boolean; narrative: string } {
  for (const loc of ['en', 'zh-CN'] as const) {
    const truth = renderTruthBase(snapshot, loc)
    if (text === truth || text.endsWith(`\n${truth}`)) {
      return { includesTruth: true, narrative: text.slice(0, -truth.length) }
    }
  }
  return { includesTruth: false, narrative: text }
}

export function validateRecapOutput(text: string, snapshot: RecapFactSnapshot): Validation {
  const violations: Violation[] = []
  const { includesTruth, narrative } = stripTruthBase(text, snapshot)
  completionChecks(narrative, snapshot, violations)
  const seen = new Set<string>()
  for (const line of clauses(narrative)) {
    const refs = mentions(line, snapshot.subtasks)
    artifactChecks(line, refs, snapshot, violations)
    statusChecks(line, refs, violations, seen)
  }
  if (!includesTruth)
    for (const task of snapshot.subtasks) {
      if (
        ((task.status !== 'completed' && task.status !== 'idle') || 'providerId' in task) &&
        !seen.has(task.taskId)
      )
        violations.push({ code: 'MISSING_INCOMPLETE_ITEM', detail: task.taskId })
    }
  return { valid: violations.length === 0, violations }
}

export function guardParentRecapReply(replyText: string, snapshot: RecapFactSnapshot, locale?: string) {
  const { valid, violations } = validateRecapOutput(replyText, snapshot)
  return {
    replyText: valid
      ? replyText
      : composeRecapMarkdown(snapshot, renderDeterministicNarrative(snapshot, locale), locale),
    recapExitViolations: violations,
  }
}

const HARD_EXIT_VIOLATIONS = new Set(
  'FALSE_COMPLETION_CLAIM FABRICATED_ARTIFACT STATUS_MISMATCH AMBIGUOUS_SAME_NAME_ARTIFACT'.split(' '),
)

type RecapScope = 'recap' | 'delegation' | 'ordinary'

const promptClauseSplit = /[\n;；。！？，,]|\s+[—–-]{1,2}\s+|(?<=[.!?])(?:\s+|$)/u
const fullTreeNegationBefore =
  /(?:\b(?:do\s+not|don't|does\s+not|doesn't|never|not|avoid|skip|stop|without|instead\s+of|rather\s+than|no\s+need\s+to|should\s+not|shouldn't|must\s+not|mustn't|need\s+not|needn't)(?:\s+(?:please|try\s+to|attempt\s+to|need\s+to|go\s+ahead\s+and|just|actually|really|ever|also|re-?))*\s*|(?:不要|别|请勿|切勿|勿|不必|不用|无需|不需要|不需|不能|不可|跳过|避免|而不是|而非|不是要|并非要|不)(?:再|去|先|要|把)?\s*)$/iu
const metaLocationBefore =
  /(?:\bin\s+(?:the\s+|this\s+|our\s+)?(?:codebase|repo|repository|source|docs?|documentation)\b|(?:在)?(?:代码库|源码|文档)(?:里|中|内))/iu
const metaModifierAfter =
  /^\s*(?:(?:'s|’s)\s+)?(?:(?:status\s+)?(?:vocabulary|schema|codebase|docs?|documentation|architecture|implementation|types?|interfaces?|definitions?)\b|(?:documented\s+)?in\s+(?:the\s+|this\s+|our\s+)?(?:codebase|repo|repository|source|docs?|documentation)\b|(?:的)?(?:状态)?(?:代码库|源码|文档|词汇|架构|接口|定义|类型|实现))/iu

const requestedChildRecap = [
  /^(?:please\s+)?(?:use\s+subagent_recap\s+(?:to\s+)?)?(?:recap|summari[sz]e|review)\s+(?:(?:all|my|our|the|these|current)\s+)*(?:subtasks?|subagents?)(?:\s+(?:status|results?|outcomes?))?[.?!]?$/iu,
  /^(?:are|have|did)\s+(?:(?:all|both|my|our|the|these)\s+)+(?:subtasks?|subagents?)\s+(?:been\s+)?(?:complete[d]?|done|finished|succeed(?:ed)?)[.?!]?$/iu,
  /\b(?:recap|summari[sz]e|review|report(?:\s+on)?|check(?:\s+on)?|list|show(?:\s+me)?|give\s+(?:me\s+)?(?:a\s+)?(?:recap|summary|status|update)\s+(?:of|on)|status\s+of)\s+(?:all|both|every|each)(?:\s+of)?(?:\s+(?:my|our|the|these|current|running|delegated))*\s+(?:sub-?tasks?|sub-?agents?|child(?:ren|\s+(?:tasks?|agents?))|delegated\s+(?:tasks?|work))\b/iu,
  /\b(?:are|have|did)\s+(?:all|both|every)(?:\s+of)?(?:\s+(?:my|our|the|these|current|delegated))*\s+(?:sub-?tasks?|sub-?agents?|child(?:ren|\s+(?:tasks?|agents?)))\s+(?:been\s+)?(?:complete[d]?|done|finished|succeed(?:ed)?)\b/iu,
  /^(?:请|帮我)?(?:调用\s*subagent_recap\s*(?:来|以)?\s*)?(?:回顾|总结|汇总)(?:一下|当前|所有|全部|这些)*(?:子任务|子代理)(?:的)?(?:状态|结果|进度)?[。？！]?$/u,
  /^(?:现在)?(?:所有|全部)?(?:子任务|子代理)(?:都|均|已经|已)*(?:完成|结束)(?:了)?(?:吗|没有)?[。？！?]?$/u,
  /(?:回顾|总结|汇总|汇报|核查|查看|列出)(?:一下|当前|目前)*(?:所有|全部|各个|每个)(?:的)?(?:子任务|子代理|委派任务)/u,
  /把(?:所有|全部)(?:的)?(?:子任务|子代理|委派任务)(?:的(?:状态|结果|进度|情况))?(?:都)?(?:回顾|总结|汇总|汇报)/u,
  /(?:所有|全部)(?:的)?(?:子任务|子代理|委派任务)(?:都|均|已经|已)*(?:完成|结束)(?:了)?(?:吗|没有)/u,
]

const enRecapPromptPrefix = /^Use\s+subagent_recap\b/iu
const enChildKeyArg = /\bchildKey\s*[:=]?\s*(?:(["'`])([^"'`\s]+)\1|([^\s"'`,)）]+))/iu
const enSubagentTarget = /\bsubagent\s+(?:(["'`])([^"'`\s]+)\1|([^\s"'`,)）]+))/iu
const zhRecapPromptPrefix = /^请调用\s*subagent_recap\b/u
const zhChildKeyArg = /childKey\s*[:：=]?\s*(?:(["'`「『“])([^"'`」』”\s]+)["'`」』”]|([^\s"'`，。,)）]+))/u
const zhSubagentTarget =
  /子代理(?:\s+(?:(["'`「『“])([^"'`」』”\s]+)["'`」』”]|([^\s"'`，。,)）]+))|(["'`「『“])([^"'`」』”\s]+)["'`」』”])/u
const recapVerbCue = /\b(?:recap|summari[sz]e|review|report(?:\s+on)?|subagent_recap)\b|回顾|总结|汇总|汇报/iu
const recapClauseVerb = /(?:\b(?:recap|summari[sz]e|review|report(?:\s+on)?)\b|回顾|总结|汇总|汇报)/giu
const directTargetBridge =
  /^\s*(?:(?:only|just|the|this|that|single|sub-?task|sub-?agent|child|task|status|results?|outcomes?|of|for)\s+|(?:只|仅|单独|专门|一下|当前|子任务|子代理|任务|的|状态|结果|进度)\s*)*["'`「『“]?$/iu

const cleanUnquotedTarget = (raw: string | undefined) =>
  raw?.replace(/[.,;:!?。，；：！？]+$/u, '').trim() || undefined
const promptClauses = (input: string) =>
  input
    .split(promptClauseSplit)
    .map((c) => c.trim())
    .filter(Boolean)

function hasAffirmativeFullTreePrompt(input: string): boolean {
  for (const clause of promptClauses(input)) {
    for (const pattern of requestedChildRecap) {
      const m = pattern.exec(clause)
      if (!m) continue
      const before = clause.slice(0, m.index)
      if (
        !fullTreeNegationBefore.test(before) &&
        !metaLocationBefore.test(before) &&
        !metaModifierAfter.test(clause.slice(m.index + m[0].length))
      )
        return true
    }
  }
  return false
}

function naturalSingleTargetFromPrompt(input: string, knownIds: readonly string[]): string | undefined {
  if (!knownIds.length) return undefined
  const sorted = [...knownIds].sort((a, b) => b.length - a.length)
  const matched = new Set<string>()
  for (const clause of promptClauses(input)) {
    const hits: Array<{ id: string; start: number; end: number }> = []
    for (const id of sorted) {
      const re = new RegExp(`(?<![\\w./-])${escapePattern(id)}(?![\\w/-]|\\.\\w)`, 'gu')
      for (const m of clause.matchAll(re)) {
        const end = m.index + m[0].length
        if (!hits.some((h) => m.index < h.end && end > h.start)) hits.push({ id, start: m.index, end })
      }
    }
    if (!hits.length) continue
    for (const vm of clause.matchAll(recapClauseVerb)) {
      const verbEnd = vm.index + vm[0].length
      if (fullTreeNegationBefore.test(clause.slice(0, vm.index))) continue
      if (
        hits.some(
          (h) =>
            (h.start >= verbEnd && directTargetBridge.test(clause.slice(verbEnd, h.start))) ||
            (h.end <= vm.index && /把\s*["'`「『“]?$/u.test(clause.slice(0, h.start))),
        )
      )
        for (const h of hits) matched.add(h.id)
    }
  }
  return matched.size === 1 ? [...matched][0] : undefined
}

const pickTarget = (m: RegExpExecArray | null) =>
  m ? (m[2] ?? m[5] ?? cleanUnquotedTarget(m[3])) : undefined

function singleChildTargetFromPrompt(input: string, knownIds: readonly string[] = []): string | undefined {
  const trimmed = input.trim()
  if (enRecapPromptPrefix.test(trimmed))
    return pickTarget(enChildKeyArg.exec(trimmed) ?? enSubagentTarget.exec(trimmed))
  if (zhRecapPromptPrefix.test(trimmed))
    return pickTarget(zhChildKeyArg.exec(trimmed) ?? zhSubagentTarget.exec(trimmed))
  if (!recapVerbCue.test(trimmed)) return undefined
  const key = zhChildKeyArg.exec(trimmed) ?? enChildKeyArg.exec(trimmed)
  return key ? pickTarget(key) : naturalSingleTargetFromPrompt(trimmed, knownIds)
}

function renderAmbiguousTargetNotice(
  targetChildKey: string,
  candidates: readonly string[],
  loc: RecapLocale,
) {
  const list = candidates.map((c) => `- \`${c}\``)
  const zh = loc === 'zh-CN'
  return [
    zh
      ? `无法回顾目标 \`${targetChildKey}\`：该 childKey 存在歧义（E_CHILD_AMBIGUOUS），匹配到多个子任务。`
      : `Cannot recap target \`${targetChildKey}\`: this childKey is ambiguous (E_CHILD_AMBIGUOUS) and matches multiple subtasks.`,
    ...(list.length ? ['', zh ? '匹配候选：' : 'Matching candidates:', ...list] : []),
    '',
    zh ? '请使用上述精确的 childKey 重新请求。' : 'Please retry with one of the exact childKey values above.',
  ].join('\n')
}

async function inspectRecapTurn(parent: SessionImpl, turnStartSeq: number, knownIdsHint?: readonly string[]) {
  const [trigger] = await parent.scan({ fromSeq: turnStartSeq, toSeq: turnStartSeq, lane: parent.lane })
  const input = messageText((trigger?.data as { content?: AssistantMessage['content'] } | undefined)?.content)
  const trimmedInput = input.trim()
  const storage = parent.d.log.storage
  const affirmativeFullTree = hasChildControl(storage) && hasAffirmativeFullTreePrompt(trimmedInput)
  const knownIds =
    knownIdsHint ??
    (!affirmativeFullTree && hasChildControl(storage) && recapVerbCue.test(trimmedInput)
      ? await knownChildIds(parent)
      : [])
  const promptTarget = singleChildTargetFromPrompt(trimmedInput, affirmativeFullTree ? [] : knownIds)
  const explicitFullTreePrompt = !promptTarget && affirmativeFullTree
  let scope: RecapScope = promptTarget || explicitFullTreePrompt ? 'recap' : 'ordinary'

  let sawRecapTool = false
  let sawFullTreeRecap = false
  const toolTargets = new Set<string>()
  for await (const rows of scanPages((query) => parent.scan(query), {
    type: 'tool/call',
    fromSeq: turnStartSeq,
    toSeq: parent.lastSeq,
    lane: parent.lane,
  })) {
    for (const row of rows) {
      const data = row.data as { name?: string; args?: { childKey?: unknown } }
      const name = data.name
      if (name === 'subagent_recap') {
        scope = 'recap'
        sawRecapTool = true
        const key = typeof data.args?.childKey === 'string' ? data.args.childKey.trim() : ''
        if (key) toolTargets.add(key)
        else sawFullTreeRecap = true
      } else if (
        scope === 'ordinary' &&
        name &&
        /^(?:subagent_(?:fork|spawn|collect|cancel|pause|resume|close|send_message))$/.test(name)
      )
        scope = 'delegation'
    }
  }
  // User intent pins the validation scope: an explicit full-tree request is never narrowed by a single-child tool call,
  // and an explicit single-child prompt keeps its requested target even without a subagent_recap tool call.
  const toolTarget =
    sawRecapTool && !sawFullTreeRecap && toolTargets.size === 1 ? [...toolTargets][0] : undefined
  const targetChildKey = explicitFullTreePrompt ? undefined : (promptTarget ?? toolTarget)
  return {
    scope,
    ...(targetChildKey ? { targetChildKey } : {}),
    explicitSingleTarget: Boolean(promptTarget),
    triggerText: input,
  }
}

/** Restrict recap checks to tool use and assertions about actual delegated work. */
export const recapTurnScope = async (parent: SessionImpl, turnStartSeq: number): Promise<RecapScope> =>
  (await inspectRecapTurn(parent, turnStartSeq)).scope

const messageText = (content?: AssistantMessage['content']) =>
  (content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('')

async function knownChildIds(parent: SessionImpl): Promise<string[]> {
  const storage = parent.d.log.storage
  if (!hasChildControl(storage)) return []
  const localIds: string[] = []
  for await (const record of ownedChildTree(storage, parent.key)) localIds.push(record.childKey)
  const owners = [parent.key, ...localIds]
  const externalIds = owners.flatMap((owner) => externalChildren(owner).map((x) => x.listing.id))
  return [...new Set([...localIds, ...externalIds])]
}

export type GuardRecapOptions = { childKey?: string; locale?: RecapLocale }

/** Gate the committed reply; ordinary answers are outside recap validation. */
export async function guardSessionRecapExit(
  parent: SessionImpl,
  replyText: string,
  turnStartSeq: number,
  scope?: RecapScope,
  options: GuardRecapOptions = {},
) {
  const storage = parent.d.log.storage
  if (!hasChildControl(storage)) return { text: replyText }
  const ids = await knownChildIds(parent)
  const turn = await inspectRecapTurn(parent, turnStartSeq, ids)
  const effectiveScope = scope ?? turn.scope
  const targetChildKey = options.childKey ?? turn.targetChildKey
  const explicitSingleTarget = Boolean(options.childKey || turn.explicitSingleTarget)
  const locale =
    options.locale ?? normalizeRecapLocale(promptLanguage(turn.triggerText) ?? promptLanguage(replyText))
  const knownChild = ids.some((id) => replyText.includes(id))
  const recapClaim =
    effectiveScope === 'delegation' &&
    /\b(?:sub[ -]?tasks?|sub[ -]?agents?|delegated (?:tasks?|work)|child (?:agents?|tasks?))\b|子任务|子代理|委派任务/iu.test(
      replyText,
    )
  if (effectiveScope !== 'recap' && (!ids.length || (!knownChild && !recapClaim))) return { text: replyText }

  let snapshot: RecapFactSnapshot
  try {
    snapshot = await buildRecapFactSnapshot(parent, {
      ...(effectiveScope === 'recap' && targetChildKey ? { childKey: targetChildKey } : {}),
      locale,
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'E_CHILD_AMBIGUOUS') {
      if (explicitSingleTarget && targetChildKey) {
        const rawCandidates = 'candidates' in error && Array.isArray(error.candidates) ? error.candidates : []
        const candidates = rawCandidates.filter((item): item is string => typeof item === 'string')
        return {
          text: renderAmbiguousTargetNotice(targetChildKey, candidates, locale),
          event: parent.ev(
            'x/core/recap-exit-guard',
            { violations: [{ code: 'AMBIGUOUS_TARGET_CHILD', detail: targetChildKey }] },
            { ignorable: true },
          ),
        }
      }
      snapshot = await buildRecapFactSnapshot(parent, { locale })
    } else {
      throw error
    }
  }
  const { violations } =
    effectiveScope === 'ordinary'
      ? validateOrdinaryReply(replyText, snapshot)
      : validateRecapOutput(replyText, snapshot)
  if (
    !violations.some(
      (v) =>
        effectiveScope === 'recap' || (HARD_EXIT_VIOLATIONS.has(v.code) && v.code !== 'FABRICATED_ARTIFACT'),
    )
  )
    return { text: replyText }
  return {
    text: composeRecapMarkdown(snapshot, renderDeterministicNarrative(snapshot, locale), locale),
    event: parent.ev('x/core/recap-exit-guard', { violations }, { ignorable: true }),
  }
}

export async function guardRecapMessage(
  parent: SessionImpl,
  content: AssistantMessage['content'],
  turnStartSeq: number,
  scope?: RecapScope,
  options?: GuardRecapOptions,
) {
  const reply = messageText(content)
  if (!reply) return { content }
  const guarded = await guardSessionRecapExit(parent, reply, turnStartSeq, scope, options)
  if (!guarded.event) return { content }
  return { content: [{ type: 'text' as const, text: guarded.text }], event: guarded.event }
}
