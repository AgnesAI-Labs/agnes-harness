import { externalChildren } from '@agnes/core-child-control/child/directory'
import { hasChildControl } from '@agnes/core-child-control/child/store'
import type { ChildAgentStatus, RecapFactSnapshot, SubtaskFactRecord } from '@agnes/extension-api'
import type { SessionImpl } from '../step/session.js'
import { composeRecapMarkdown, renderDeterministicNarrative, renderTruthBase } from './recap-formatter.js'
import { buildRecapFactSnapshot } from './recap-snapshot.js'

type Violation = { code: string; detail: string }
type Validation = { valid: boolean; violations: readonly Violation[] }

const universalCompletion = [
  /(?:全部|全都|均|都|所有(?:的)?(?:子?任务|工作|事项|步骤)?)(?:已经|现已|全部|成功|顺利|执行|处理|已|均|都|被|了|\s)*(?:完成|成功|结束|搞定)/gu,
  /\b(?:all|both|each|every|everything|(?:the\s+)?(?:(?:entire|whole)\s+)?batch)(?:\s+(?:\d+|of|the|our|subtasks?|tasks?|work|items?|children|child|jobs?|steps?|assignments?))*\s+(?:(?:is|are|has|have|been|was|were|now|fully|successfully)\s+)*(?:completed?|done|succeeded|finished|successful)\b/giu,
  /\b(?:completed|finished)\s+(?:everything|all\s+(?:sub)?tasks)\b|\b(?:nothing|no (?:work|tasks?))\s+(?:remains?|left|outstanding)\b/giu,
]
function completionChecks(text: string, snapshot: RecapFactSnapshot, errors: Violation[]) {
  const prose = text.replace(/[*_`]/g, '').replace(/\s+/g, ' ')
  for (const pattern of universalCompletion)
    for (const m of prose.matchAll(pattern))
      if (!negated(prose.slice(0, m.index))) errors.push({ code: 'FALSE_COMPLETION_CLAIM', detail: m[0] })
  for (const m of prose.matchAll(
    /(\d+)\s*(?:\/|of|out of)\s*(\d+)\s*(?:(?:sub)?tasks?\s+)?(?:completed?|done|已完成)/giu,
  ))
    if (Number(m[1]) > snapshot.counts.completed && !negated(prose.slice(0, m.index)))
      errors.push({ code: 'FALSE_COMPLETION_CLAIM', detail: m[0] })
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

function statusChecks(line: string, refs: Mention[], errors: Violation[], seen: Set<string>) {
  for (const [status, pattern] of statuses) {
    for (const match of line.matchAll(pattern)) {
      if (refs.some((r) => match.index >= r.start && match.index < r.end)) continue
      const before = line.slice(0, match.index)
      const previous = refs.filter((r) => r.end <= match.index)
      const owner = previous.at(-1) ?? refs[0]
      if (!owner) continue
      // "A and B completed" makes the same claim for both.
      const owners = [owner]
      for (let i = previous.length - 2; i >= 0; i--) {
        const left = previous[i]
        if (!left) break
        if (
          !/^\s*[\]\x60]*\s*(?:and|与|和|、|&)\s*[[\x60]*\s*$/iu.test(line.slice(left.end, owners[0]?.start))
        )
          break
        owners.unshift(left)
      }
      for (const { task } of owners) {
        const denied = negated(before)
        if ((task.status === status) === denied)
          errors.push({ code: 'STATUS_MISMATCH', detail: `${task.taskId}: ${match[0]}` })
        else if (!denied) seen.add(task.taskId)
      }
    }
  }
}

const missingBefore =
  /(?:\b(?:expected|missing|planned|not (?:generated|created|written|produced))(?:\s+(?:file|path|artifact))?|预期|计划|缺少|尚未生成|未生成|未写入)\s*[:：]?\s*$/iu
const missingAfter =
  /^\s*[\x60)'"\]]*\s*(?:(?:is|was|has|remains)\s+)?(?:missing|expected|(?:not|never)\s+(?:been\s+)?(?:generated|created|written|produced)|(?:尚未|未)(?:生成|写入)|缺失)/iu
const declaredFile = /\b(?:created|wrote|generated|produced|artifact|file|path)\s*[:=]?\s*$/iu
const namedFile = /^(?:README|Makefile|Dockerfile|LICENSE|NOTICE)$/u
// Take a whole quoted path or link target before looking for ordinary unquoted file tokens.
const pathTokens =
  /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)|^\s*\[[^\]\n]+\]:\s*<?([^\s>]+)>?|[\x60"]([^\x60"\n]+)[\x60"]|\b(?:README|Makefile|Dockerfile|LICENSE|NOTICE)\b(?![./])|(?<![\w./\\-])(?:(?:[A-Za-z]:)?[/\\]|[\p{L}\p{N}_.@~+-]+[/\\])[\p{L}\p{N}_.@~%+\\/-]+|(?<![\w.-])[\p{L}\p{N}_@+-]*\.[\p{L}][\p{L}\p{N}_.+-]*/gu
function isPath(value: string) {
  return /[/\\]|\.[\p{L}]/u.test(value)
}
function artifactChecks(line: string, refs: Mention[], snapshot: RecapFactSnapshot, errors: Violation[]) {
  for (const match of line.matchAll(pathTokens)) {
    const link = match[1] ?? match[2] ?? match[3]
    const token = link ?? match[4] ?? match[0].replace(/[.!?]+$/, '')
    const before = line.slice(0, match.index)
    const claimed = declaredFile.test(before)
    if (!link && !isPath(token) && !namedFile.test(token) && !claimed) continue
    if (!link && !claimed && /^\d+\/\d+$/.test(token)) continue
    const start = match.index
    const end = start + match[0].length
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

export function validateRecapOutput(text: string, snapshot: RecapFactSnapshot): Validation {
  const violations: Violation[] = []
  const truth = renderTruthBase(snapshot)
  const includesTruth = text === truth || text.endsWith(`\n${truth}`)
  const narrative = includesTruth ? text.slice(0, -truth.length) : text
  if (snapshot.hasIncompleteWork) completionChecks(narrative, snapshot, violations)
  const seen = new Set<string>()
  for (const line of clauses(narrative)) {
    const refs = mentions(line, snapshot.subtasks)
    artifactChecks(line, refs, snapshot, violations)
    statusChecks(line, refs, violations, seen)
  }
  if (!includesTruth)
    for (const task of snapshot.subtasks) {
      if ((task.status !== 'completed' || 'providerId' in task) && !seen.has(task.taskId))
        violations.push({ code: 'MISSING_INCOMPLETE_ITEM', detail: task.taskId })
    }
  return { valid: violations.length === 0, violations }
}

export function guardParentRecapReply(replyText: string, snapshot: RecapFactSnapshot) {
  const { valid, violations } = validateRecapOutput(replyText, snapshot)
  return {
    replyText: valid ? replyText : composeRecapMarkdown(snapshot, renderDeterministicNarrative(snapshot)),
    recapExitViolations: violations,
  }
}

const HARD_EXIT_VIOLATIONS = new Set([
  'FALSE_COMPLETION_CLAIM',
  'FABRICATED_ARTIFACT',
  'STATUS_MISMATCH',
  'AMBIGUOUS_SAME_NAME_ARTIFACT',
])

/** Parent final-reply exit gate: intercepts redline hallucinations or dropped items after subagent_recap. */
export async function guardSessionRecapExit(parent: SessionImpl, replyText: string, turnStartSeq: number) {
  const storage = parent.d.log.storage
  const hasLocal = hasChildControl(storage) && (await storage.listByParent(parent.key)).length > 0
  if (!hasLocal && externalChildren(parent.key).length === 0) return { text: replyText }
  const snapshot = await buildRecapFactSnapshot(parent)
  if (!snapshot.subtasks.length) return { text: replyText }
  const { valid, violations } = validateRecapOutput(replyText, snapshot)
  if (valid) return { text: replyText }
  let enforce = violations.some((v) => HARD_EXIT_VIOLATIONS.has(v.code))
  if (!enforce) {
    const calls = await parent.scan({
      type: 'tool/call',
      fromSeq: turnStartSeq,
      lane: parent.lane,
      limit: 64,
    })
    enforce = calls.some((row) => (row.data as { name?: string }).name === 'subagent_recap')
  }
  if (!enforce) return { text: replyText }
  return {
    text: composeRecapMarkdown(snapshot, renderDeterministicNarrative(snapshot)),
    event: parent.ev(
      'x/core/recap-exit-guard',
      { violations: violations.map((v) => ({ code: v.code, detail: v.detail })) },
      { ignorable: true },
    ),
  }
}
