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
  /(?:已(?:经)?|共)?完成(?:了)?\s*(\d+)\s*\/\s*(\d+)(?:\s*((?:项|个)?(?:子?任务|子代理|任务|步骤|检查|测试)))?/giu
const nonBatchUnit = /^(?:steps?|checks?|tests?|files?|(?:项|个)?(?:步骤|检查|测试))$/iu
const batchHint = /\b(?:all|total|overall|batch)\b|全部|总共|整批/iu

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
  const check = (match: RegExpExecArray, numRaw: string, denRaw: string, unit: string | undefined) => {
    if (negated(prose.slice(0, match.index))) return
    const num = Number(numRaw)
    const den = Number(denRaw)
    if (uniqueTasks.length > 0 && !hasBatchHint) {
      if (unit && nonBatchUnit.test(unit.trim())) return
      const subTotal = uniqueTasks.length
      const subSettled = uniqueTasks.filter((t) => t.status === 'completed' || t.status === 'idle').length
      if ((num === subSettled && den === subTotal) || (num === settled && den === total)) return
      errors.push({ code: 'FALSE_COMPLETION_CLAIM', detail: match[0] })
      return
    }
    if (unit && nonBatchUnit.test(unit.trim()) && !hasBatchHint && total > 0 && !snapshotHasUnit(unit)) return
    if (num !== settled || den !== total) errors.push({ code: 'FALSE_COMPLETION_CLAIM', detail: match[0] })
  }
  for (const m of prose.matchAll(batchRatioAfter)) check(m, m[1] as string, m[2] as string, m[3])
  for (const m of prose.matchAll(batchRatioBefore)) check(m, m[1] as string, m[2] as string, m[3])
}

function snapshotHasUnit(unit: string) {
  return !nonBatchUnit.test(unit.trim())
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
}

const negative =
  /(?:\b(?:not|never|neither|cannot|can't|isn't|aren't|hasn't|haven't)(?:\s+(?:yet|be|say|claim|that|been))*\s*|(?:没有|并非|并未|并不|未能|尚未|还没|不是|不能说|未|没)\s*)$/iu
function negated(before: string) {
  return negative.test(before)
}

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

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
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
const directAfterRef =
  /^\s*[\]\x60)'"]*\s*(?:[:：—–-]\s*|(?:(?:is|was|are|were|has|have|remains?|seems?\s+to\s+be)\s+(?:now\s+|already\s+|currently\s+|still\s+|successfully\s+|fully\s+|not\s+|never\s+|yet\s+)*|(?:already|now|currently|still|successfully|fully|just|not|never)\s+)+|(?:(?:当前|目前)?(?:状态)?(?:为|是)|已经|现已|正在|仍在|仍|已|都|均|也|还是|是|并未|尚未|没有|并非|不是|未|没)\s*)*$/iu
const directModifierBeforeRef = /^\s*(?:的\s*)?(?:(?:sub)?(?:task|agent)|child|子任务|子代理)?\s*[[\x60]*$/iu
const metaExplanationCue =
  /\b(?:means?|translates?(?:\s+to|\s+as)?|translation|quoted?|log(?:ged|s)?|printed|output)\b|意思是|含义|翻译|日志/iu

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
  for (const clause of cleaned.split(/[\n;；。！？,，]|(?<=[.!?])\s+|\s+(?:but|however)\s+|但是|但/iu)) {
    const refs = mentions(clause, snapshot.subtasks)
    if (refs.length === 0) continue
    for (const [status, pattern] of statuses) {
      for (const match of clause.matchAll(pattern)) {
        if (refs.some((r) => match.index >= r.start && match.index < r.end)) continue
        const before = clause.slice(0, match.index)
        const previous = refs.filter((r) => r.end <= match.index)
        if (previous.length > 0) {
          const owner = previous.at(-1) as Mention
          const between = clause.slice(owner.end, match.index)
          if (!directAfterRef.test(between)) continue
          const owners = collectConjunctionOwners(clause, previous, owner)
          const leading = clause.slice(0, owners[0]?.start ?? owner.start)
          if (nonSubjectBeforeRef.test(leading)) continue
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
const bareUrlPattern = /(?<![\w.-])(?:https?:\/\/|mailto:)[^\s<>()[\]"'`\u3000-\u303f\uff00-\uffef]+/giu
// Take a whole quoted path or link target before looking for ordinary unquoted file tokens.
const pathTokens =
  /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)|^\s*\[[^\]\n]+\]:\s*<?([^\s>]+)>?|[\x60"]([^\x60"\n]+)[\x60"]|\b(?:README|Makefile|Dockerfile|LICENSE|NOTICE)\b(?![./])|(?<![\w./\\-])(?:(?:[A-Za-z]:)?[/\\]|[\p{L}\p{N}_.@~+-]+[/\\])[\p{L}\p{N}_.@~%+\\/-]+|(?<![\w.-])[\p{L}\p{N}_@+-]*\.[\p{L}][\p{L}\p{N}_.+-]*/gu
const webUrl = /^(?:https?|mailto):/iu
const webDomainOrTicker =
  /^(?:[\p{L}\p{N}-]+\.)+(?:com|org|net|io|cn|gov|edu|co|ai|news|tv|uk|jp|hk|sg|de|fr|[A-Z])$/u
const fileExt = /\.(?:[a-zA-Z][a-zA-Z0-9]{1,7}|[chmrs])$/u
const rootedPath = /^(?:[A-Za-z]:[/\\]|\/|\.\.?\/)/u

type UrlSpan = { start: number; end: number; text: string }
function findBareUrls(line: string): UrlSpan[] {
  const spans: UrlSpan[] = []
  for (const match of line.matchAll(bareUrlPattern)) {
    const text = match[0].replace(/[.,!?;:]+$/u, '')
    if (!text) continue
    spans.push({ start: match.index, end: match.index + text.length, text })
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

const HARD_EXIT_VIOLATIONS = new Set([
  'FALSE_COMPLETION_CLAIM',
  'FABRICATED_ARTIFACT',
  'STATUS_MISMATCH',
  'AMBIGUOUS_SAME_NAME_ARTIFACT',
])

type RecapScope = 'recap' | 'delegation' | 'ordinary'

const requestedChildRecap = [
  /^(?:please\s+)?(?:recap|summari[sz]e|review)\s+(?:(?:all|my|our|the|these|current)\s+)*(?:subtasks?|subagents?)(?:\s+(?:status|results?|outcomes?))?[.?!]?$/iu,
  /^(?:are|have|did)\s+(?:(?:all|both|my|our|the|these)\s+)+(?:subtasks?|subagents?)\s+(?:been\s+)?(?:complete[d]?|done|finished|succeed(?:ed)?)[.?!]?$/iu,
  /^(?:请|帮我)?(?:回顾|总结|汇总)(?:一下|当前|所有|这些)*(?:子任务|子代理)(?:的)?(?:状态|结果|进度)?[。？！]?$/u,
  /^(?:现在)?(?:所有|全部)?(?:子任务|子代理)(?:都|均|已经|已)*(?:完成|结束)(?:了)?(?:吗|没有)?[。？！?]?$/u,
]

const singleChildRecapEn =
  /^Use subagent_recap\b.*?\b(?:childKey\s*[:=]?\s*["'`]?([^\s"'`,.)）]+)|subagent\s+([^\s"'`,]+?)\.?)(?:\s|\)|$)/iu
const singleChildRecapZh =
  /^请调用\s*subagent_recap.*?(?:childKey\s*[:：=]?\s*["'`]?([^\s"'`,)）]+)|子代理\s*([^\s"'`，。]+))/u

function singleChildTargetFromPrompt(input: string): string | undefined {
  const trimmed = input.trim()
  const en = singleChildRecapEn.exec(trimmed)
  if (en) return en[1] ?? en[2]
  const zh = singleChildRecapZh.exec(trimmed)
  if (zh) return zh[1] ?? zh[2]
  return undefined
}

async function inspectRecapTurn(
  parent: SessionImpl,
  turnStartSeq: number,
): Promise<{ scope: RecapScope; targetChildKey?: string; triggerText: string }> {
  const [trigger] = await parent.scan({ fromSeq: turnStartSeq, toSeq: turnStartSeq, lane: parent.lane })
  const input = messageText((trigger?.data as { content?: AssistantMessage['content'] } | undefined)?.content)
  const promptTarget = singleChildTargetFromPrompt(input)
  let scope: RecapScope = promptTarget ? 'recap' : 'ordinary'
  const storage = parent.d.log.storage
  if (
    scope === 'ordinary' &&
    requestedChildRecap.some((pattern) => pattern.test(input.trim())) &&
    hasChildControl(storage) &&
    ((await storage.listByParent(parent.key)).length > 0 || externalChildren(parent.key).length > 0)
  )
    scope = 'recap'

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
      ) {
        scope = 'delegation'
      }
    }
  }
  const targetChildKey = sawRecapTool
    ? !sawFullTreeRecap && toolTargets.size === 1
      ? [...toolTargets][0]
      : undefined
    : promptTarget
  return { scope, ...(targetChildKey ? { targetChildKey } : {}), triggerText: input }
}

/** Restrict recap checks to tool use and assertions about actual delegated work. */
export async function recapTurnScope(parent: SessionImpl, turnStartSeq: number): Promise<RecapScope> {
  return (await inspectRecapTurn(parent, turnStartSeq)).scope
}

function messageText(content?: AssistantMessage['content']) {
  return (content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('')
}

async function knownChildIds(parent: SessionImpl): Promise<string[]> {
  const storage = parent.d.log.storage
  if (!hasChildControl(storage)) return []
  const localIds: string[] = []
  for await (const record of ownedChildTree(storage, parent.key)) localIds.push(record.childKey)
  const owners = [parent.key, ...localIds]
  const externalIds = owners.flatMap((owner) => externalChildren(owner).map((x) => x.listing.id))
  return [...new Set([...localIds, ...externalIds])]
}

export type GuardRecapOptions = {
  childKey?: string
  locale?: RecapLocale
}

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
  const turn = await inspectRecapTurn(parent, turnStartSeq)
  const effectiveScope = scope ?? turn.scope
  const targetChildKey = options.childKey ?? turn.targetChildKey
  const locale =
    options.locale ?? normalizeRecapLocale(promptLanguage(turn.triggerText) ?? promptLanguage(replyText))
  const knownChild = ids.some((id) => replyText.includes(id))
  const recapClaim =
    effectiveScope === 'delegation' &&
    /\b(?:sub[ -]?tasks?|sub[ -]?agents?|delegated (?:tasks?|work)|child (?:agents?|tasks?))\b|子任务|子代理|委派任务/iu.test(
      replyText,
    )
  if (effectiveScope !== 'recap' && (!ids.length || (!knownChild && !recapClaim))) return { text: replyText }

  const snapshot = await buildRecapFactSnapshot(parent, {
    ...(effectiveScope === 'recap' && targetChildKey ? { childKey: targetChildKey } : {}),
    locale,
  })
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
