// Reuse of a saved workflow definition: what session 1 saved as a skill, and what session 2 ran.
// Definitions are compared after normalising whitespace; the workflow's own name is not part of it.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const squash = (text: string): string => text.trim().replace(/\s+/g, ' ')

const byName = (a: { name: string; task: string }, b: { name: string; task: string }): number => {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  if (a.task !== b.task) return a.task < b.task ? -1 : 1
  return 0
}

/**
 * The comparable form of a workflow definition (`stages`: each with a `name` and `members` of
 * `name` and `task`), or undefined when `value` is not one. Stage order is kept: stages run one after
 * the other. Members of one stage run in parallel, so their order is not part of the definition.
 */
export const normalizeDefinition = (value: unknown): string | undefined => {
  if (!isObject(value) || !Array.isArray(value.stages) || value.stages.length === 0) return undefined
  const stages: { name: string; members: { name: string; task: string }[] }[] = []
  for (const stage of value.stages) {
    if (!isObject(stage) || typeof stage.name !== 'string' || !Array.isArray(stage.members)) return undefined
    const members: { name: string; task: string }[] = []
    for (const member of stage.members) {
      if (!isObject(member) || typeof member.name !== 'string' || typeof member.task !== 'string')
        return undefined
      members.push({ name: squash(member.name), task: squash(member.task) })
    }
    if (members.length === 0) return undefined
    stages.push({ name: squash(stage.name), members: members.sort(byName) })
  }
  return JSON.stringify(stages)
}

const JSON_FENCE = /```json[^\S\n]*\n([\s\S]*?)```/g

/** The normalised definitions in the fenced `json` blocks of skill files; a block that is not one is skipped. */
export const savedDefinitions = (skillTexts: string[]): string[] => {
  const found: string[] = []
  for (const text of skillTexts) {
    for (const block of text.matchAll(JSON_FENCE)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(block[1] ?? '')
      } catch {
        continue
      }
      const definition = normalizeDefinition(parsed)
      if (definition !== undefined) found.push(definition)
    }
  }
  return found
}

/** The `SKILL.md` texts under a workspace's `.agh/skills/<name>/`; none when the folder is not there. */
export const readSkillTexts = (skillsDir: string): string[] => {
  if (!existsSync(skillsDir)) return []
  const texts: string[] = []
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const file = join(skillsDir, entry.name, 'SKILL.md')
    if (entry.isDirectory() && existsSync(file)) texts.push(readFileSync(file, 'utf8'))
  }
  return texts
}

export type WorkflowCalls = {
  /** The definition of every `workflow` call that started a run and was executed, in order. */
  calls: string[]
  /** The definition of every run that ended completed, whether the call that finished it started or resumed it. */
  completed: string[]
}

const isMainLane = (lane: unknown): boolean =>
  lane === null || lane === undefined || lane === '' || lane === 'main'

/** The text of a tool result's `content`: a string, or the `text` of the blocks tagged `text`. */
const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) =>
      isObject(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
    )
    .join('\n')
}

const UNKNOWN_OUTCOME = 'TOOL_OUTCOME_UNKNOWN'
const RUN_ROW = 'x/agnes/workflow/run'
const WORKFLOW_ORIGIN = 'ext:agnes/workflow'

/**
 * Whether a workflow run record, as the tool's own run rows give it, is a finished run: its status is
 * `completed` and every member is `completed`.
 */
const runFinished = (run: Json): boolean =>
  run.status === 'completed' &&
  Array.isArray(run.stages) &&
  run.stages.length > 0 &&
  run.stages.every(
    (stage) =>
      isObject(stage) &&
      Array.isArray(stage.members) &&
      stage.members.length > 0 &&
      stage.members.every((member) => isObject(member) && member.status === 'completed'),
  )

/**
 * The `workflow` tool calls of a session's ledger rows (the rows of the session file, every lane). Only
 * a call that was executed counts: the tool answers an executed call with the run (`runId`, `status`,
 * its stages); a call that was refused or denied, or that failed before a run began, answers with an
 * error text and is skipped. A call that resumes a run (`runId`, no `stages`) carries no definition of
 * its own: it takes the definition of the run it resumes, adds no call, and completes the run when it
 * finishes it.
 *
 * Unknown outcome. In an unattended session the tool's closing step (showing the run as a surface) is
 * refused after the run has ended, so the call is answered `TOOL_OUTCOME_UNKNOWN` although the run ran
 * to its end. The run record the tool wrote to the ledger before that (`x/agnes/workflow/run` rows,
 * the last one for the call) is the evidence then: the call counts as a finished run exactly when that
 * record is `completed` with every member `completed`. A call with no run record, or whose record is
 * anything else (interrupted, failed, a member still running), is not counted as finished.
 */
export const scanWorkflowRows = (rows: readonly unknown[]): WorkflowCalls => {
  const pending = new Map<string, { definition: string | undefined; runId: string | undefined }>()
  const runs = new Map<string, string>()
  const records = new Map<string, Json>()
  const finished = new Set<string>()
  const calls: string[] = []
  const completed: string[] = []
  for (const row of rows) {
    if (!isObject(row) || !isMainLane(row.lane)) continue
    const data = isObject(row.data) ? row.data : {}
    if (row.type === RUN_ROW) {
      if (row.origin === WORKFLOW_ORIGIN && typeof data.toolUseId === 'string')
        records.set(data.toolUseId, data)
    } else if (row.type === 'tool/call' && data.name === 'workflow' && typeof data.toolUseId === 'string') {
      const args = isObject(data.args) ? data.args : {}
      pending.set(data.toolUseId, {
        definition: normalizeDefinition(args),
        runId: typeof args.runId === 'string' ? args.runId : undefined,
      })
    } else if (row.type === 'tool/result' && typeof data.toolUseId === 'string') {
      const call = pending.get(data.toolUseId)
      if (!call) continue
      let answer: Json | undefined
      let ended: boolean
      if (data.code === UNKNOWN_OUTCOME) {
        const record = records.get(data.toolUseId)
        if (!record || typeof record.id !== 'string') continue
        answer = { ...record, runId: record.id }
        ended = runFinished(record)
      } else {
        let parsed: unknown
        try {
          parsed = JSON.parse(resultText(data.content))
        } catch {
          continue
        }
        if (!isObject(parsed)) continue
        answer = parsed
        ended = parsed.status === 'completed' && data.isError !== true
      }
      if (typeof answer.runId !== 'string' || typeof answer.status !== 'string') continue
      const definition =
        call.definition ?? runs.get(call.runId ?? answer.runId) ?? normalizeDefinition(answer)
      if (definition === undefined) continue
      if (call.definition !== undefined) calls.push(definition)
      runs.set(answer.runId, definition)
      if (ended && !finished.has(answer.runId)) {
        finished.add(answer.runId)
        completed.push(definition)
      }
    }
  }
  return { calls, completed }
}

const parseRows = (jsonl: string): unknown[] => {
  const rows: unknown[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* a line that is not a row */
    }
  }
  return rows
}

/** The `workflow` tool calls of one AGH session file (one ledger row per line); see `scanWorkflowRows`. */
export const parseAghWorkflowCalls = (jsonl: string): WorkflowCalls => scanWorkflowRows(parseRows(jsonl))

/** Whether the session's ledger rows hold at least one `workflow` run that ran to its end. */
export const workflowRunCompleted = (rows: readonly unknown[]): boolean =>
  scanWorkflowRows(rows).completed.length > 0
