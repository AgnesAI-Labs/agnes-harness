// Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified.
import type { Candidate, CompiledQuestions, ConsumedHead, Decision, JsonObject, Phase } from './types.js'
import { DEFAULT_ARGUMENTS, LLM_PARAMETERS } from './types.js'

export type ChoiceAnswer = { choice: string; confidence: number; probabilities: Record<string, number> }
export type DecodeResult = { ok: true; decision: Decision } | { ok: false; reason: string }

const PHASE_TOP = 4
const ACTION_TOP = 5
const MAX_PROGRESS = 3

type UnknownRecord = { [key: string]: unknown }

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function own(record: UnknownRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

// `path` is the targetParam of `read`, the only multi-target tool (profile.ts).
/** Every argument of a batch must be shared except the target path. */
const TARGET_PATH = 'path'

function sameExceptPath(a: JsonObject, b: JsonObject): boolean {
  const rest = (args: JsonObject) => Object.entries(args).filter(([key]) => key !== TARGET_PATH)
  const left = rest(a)
  const right = rest(b)
  return (
    left.length === right.length &&
    left.every(([key, value]) => Object.hasOwn(b, key) && JSON.stringify(b[key]) === JSON.stringify(value))
  )
}

function inUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** A choice answer is usable only if it is a legal argmax over the full distribution. */
export function validateChoice(answer: unknown, ids: readonly string[]): ChoiceAnswer | null {
  if (!isRecord(answer)) return null
  const choice = own(answer, 'choice')
  const confidence = own(answer, 'confidence')
  const probabilities = own(answer, 'probabilities')
  if (typeof choice !== 'string' || !ids.includes(choice) || !inUnit(confidence)) return null
  if (!isRecord(probabilities)) return null
  const keys = Object.keys(probabilities)
  if (keys.length !== ids.length || !ids.every((id) => Object.hasOwn(probabilities, id))) return null
  const values: number[] = []
  for (const key of keys) {
    const value = probabilities[key]
    if (!inUnit(value)) return null
    values.push(value)
  }
  const sum = values.reduce((total, value) => total + value, 0)
  if (!(Math.abs(sum - 1) < 0.02)) return null
  const chosen = probabilities[choice] as number
  if (chosen < Math.max(...values) - 1e-6) return null
  return { choice, confidence, probabilities: probabilities as Record<string, number> }
}

function ranked(probabilities: Record<string, number>, count: number): Array<readonly [string, number]> {
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key, value]) => [key, value] as const)
}

function criteriaIds(c: CompiledQuestions, head: string): string[] | null {
  const question = c.questions[head]
  if (!isRecord(question)) return null
  const criteria = question.criteria
  return isRecord(criteria) ? Object.keys(criteria) : null
}

function answerFor(answers: UnknownRecord, c: CompiledQuestions, head: string): ChoiceAnswer | null {
  const ids = criteriaIds(c, head)
  return ids === null ? null : validateChoice(own(answers, head), ids)
}

function metaScore(answers: UnknownRecord, key: string, field: string, max: number): number | null {
  const meta = own(answers, key)
  if (!isRecord(meta)) return null
  const value = own(meta, field)
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null
}

function consumedChoice(role: ConsumedHead['role'], head: string, answer: ChoiceAnswer): ConsumedHead {
  return { role, head, selected: answer.choice, confidence: answer.confidence, deterministic: false }
}

function consumedFixed(role: ConsumedHead['role'], selected: string): ConsumedHead {
  return { role, head: null, selected, confidence: null, deterministic: true }
}

/** Reads only the heads on the consumed path: phase, then the action, then the target. */
export function decodeAnswers(answers: unknown, c: CompiledQuestions): DecodeResult {
  if (!isRecord(answers)) return { ok: false, reason: 'Jev answers must be an object.' }

  const phaseAnswer = answerFor(answers, c, 'phase')
  if (phaseAnswer === null) return { ok: false, reason: 'Invalid answer for the phase head.' }
  const phase = phaseAnswer.choice as Phase
  const consumed: ConsumedHead[] = [consumedChoice('phase', 'phase', phaseAnswer)]

  let op: string
  let actionTop: Array<readonly [string, number]>
  const actionHead = c.actionHeads[phase]
  if (actionHead !== undefined) {
    const actionAnswer = answerFor(answers, c, actionHead)
    if (actionAnswer === null) return { ok: false, reason: `Invalid answer for the ${actionHead} head.` }
    op = actionAnswer.choice
    consumed.push(consumedChoice('action', actionHead, actionAnswer))
    actionTop = ranked(actionAnswer.probabilities, ACTION_TOP)
  } else {
    const fixed = c.actionConstants[phase]
    if (fixed === undefined) return { ok: false, reason: `No action is available for phase ${phase}.` }
    op = fixed
    consumed.push(consumedFixed('action', op))
    actionTop = [[op, 1]]
  }

  const branch = `${phase}/${op}`
  const candidates = ownEntry(c.targetCandidates, branch) ?? []
  let targetConfidence: number | null = null
  let targetRole: ConsumedHead['role'] = 'target'
  const selected: Candidate[] = []

  // With a mode head, "many" is settled by the member heads; no inclusion falls back to the target head.
  const modeHead = ownEntry(c.modeHeads, branch)
  if (modeHead !== undefined) {
    const modeAnswer = answerFor(answers, c, modeHead)
    if (modeAnswer === null) return { ok: false, reason: `Invalid answer for the ${modeHead} head.` }
    consumed.push(consumedChoice('target_mode', modeHead, modeAnswer))
    if (modeAnswer.choice === 'many') {
      const heads = ownEntry(c.memberHeads, branch)
      const max = ownEntry(c.multiTargetMax, branch)
      if (heads === undefined || max === undefined)
        return { ok: false, reason: `No members are available for ${branch}.` }
      const confidences: number[] = []
      for (const candidate of candidates) {
        const head = ownEntry(heads, candidate.key)
        if (head === undefined)
          return { ok: false, reason: `No member head is available for ${candidate.key}.` }
        const memberAnswer = answerFor(answers, c, head)
        if (memberAnswer === null) return { ok: false, reason: `Invalid answer for the ${head} head.` }
        consumed.push(consumedChoice('target_member', head, memberAnswer))
        confidences.push(memberAnswer.confidence)
        if (memberAnswer.choice === 'include') selected.push(candidate)
      }
      if (selected.length > max)
        return {
          ok: false,
          reason: `Jev selected ${selected.length} targets for ${op}; multi-target mode allows at most ${max}.`,
        }
      if (selected.length === 0) targetRole = 'target_fallback'
      else targetConfidence = Math.min(...confidences)
    }
  }

  let target: string | string[]
  let bindingMode: Decision['bindingMode']
  let args: JsonObject
  let batch: JsonObject[] | undefined
  const [first] = selected
  if (first !== undefined && selected.length >= 2) {
    if (!selected.every((item) => sameExceptPath(first.args, item.args)))
      return { ok: false, reason: 'Batch invocation candidates have incompatible arguments.' }
    target = selected.map((item) => item.key)
    bindingMode = 'observed'
    args = structuredClone(first.args)
    batch = selected.map((item) => structuredClone(item.args))
  } else {
    let key: string
    if (first !== undefined) key = first.key
    else {
      const targetHead = ownEntry(c.targetHeads, branch)
      if (targetHead !== undefined) {
        const targetAnswer = answerFor(answers, c, targetHead)
        if (targetAnswer === null) return { ok: false, reason: `Invalid answer for the ${targetHead} head.` }
        key = targetAnswer.choice
        targetConfidence = targetAnswer.confidence
        consumed.push(consumedChoice(targetRole, targetHead, targetAnswer))
      } else {
        const fixed = ownEntry(c.targetConstants, branch)
        if (fixed === undefined) return { ok: false, reason: `No target is available for ${branch}.` }
        key = fixed
        consumed.push(consumedFixed('target', key))
      }
    }
    target = key
    if (key === LLM_PARAMETERS) {
      bindingMode = 'llm_parameters'
      args = {}
    } else if (key === DEFAULT_ARGUMENTS) {
      const defaults = ownEntry(c.defaults, op)
      if (defaults === undefined) return { ok: false, reason: `${op} has no default arguments.` }
      bindingMode = 'defaults'
      args = structuredClone(defaults)
    } else {
      const observed = candidates.find((candidate) => candidate.key === key)
      if (observed === undefined) return { ok: false, reason: `Unsupported target ${key} for ${op}.` }
      bindingMode = 'observed'
      args = structuredClone(observed.args)
    }
  }

  const stochastic = consumed.flatMap((item) => (item.confidence === null ? [] : [item.confidence]))
  const pathConfidences = consumed.flatMap((item) =>
    (item.role === 'phase' || item.role === 'action') && item.confidence !== null ? [item.confidence] : [],
  )

  return {
    ok: true,
    decision: {
      phase,
      op,
      target,
      bindingMode,
      args,
      ...(batch === undefined ? {} : { batch }),
      confidence: Math.min(...stochastic),
      operationPathConfidence: Math.min(...pathConfidences),
      targetConfidence,
      ambiguity: metaScore(answers, 'meta_ambiguity', 'noul', 1),
      progress: metaScore(answers, 'meta_progress', 'score', MAX_PROGRESS),
      phaseTop: ranked(phaseAnswer.probabilities, PHASE_TOP),
      actionTop,
      consumed,
    },
  }
}
