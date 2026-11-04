// The checklist of the v2 smoke run: reads the run folders of one two-session task (arms off, on, oracle
// and frozen) and one workflow task (arm on), and says for each behaviour that only a real run can show
// whether it happened. Read only; no model call. `scripts/smoke-v2.sh` runs the runner and then this.
//
// A skill folder on disk is not enough: a skill counts as saved only when a later model request of the run
// offers it to the agent, in the skill catalogue of the request the host captured (`home/data/model-requests`).
//
// Usage: pnpm exec tsx tools/rsi-eval/smoke-check.ts --run-dir <out> --two-session <task> --workflow <task> [--rep 1] [--suite <dir>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGH_DIR } from '../../packages/protocol/src/constants.js'
import { readRunRecords } from './report.js'
import { defaultTasksDir, fixtureOf, loadSuite, workspaceName } from './suite.js'
import type { EvalTask } from './types.js'

export type Check = { name: string; status: 'PASS' | 'FAIL' | 'WARN'; detail: string }

type Row = {
  seq: number
  ts: string
  type: string
  lane: string | null
  origin: string | null
  data: unknown
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const ledger = (runDir: string, run: string, session: number): Row[] => {
  const file = join(runDir, run, 'sessions', `s${session}.events.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Row)
}

const dataOf = (row: Row): Record<string, unknown> => (isObject(row.data) ? row.data : {})

/** The workspace copies a run keeps (`work`, `work-b`). */
const workspaces = (runDir: string, run: string, task: EvalTask): string[] =>
  [...new Set(task.sessions.map((_, i) => workspaceName(fixtureOf(task, i))))].map((name) =>
    join(runDir, run, name),
  )

const skillFolders = (workspace: string): string[] => {
  const dir = join(workspace, AGH_DIR, 'skills')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
}

/** Every save receipt of kind skill in the run's ledgers: `outcome` and `reason`. */
const skillReceipts = (runDir: string, run: string, sessions: number) =>
  Array.from({ length: sessions }, (_, i) => ledger(runDir, run, i + 1))
    .flat()
    .filter((row) => row.type === 'x/core/refinement-save')
    .map(dataOf)
    .filter((d) => isObject(d.source) && d.source.kind === 'skill')
    .map((d) => ({ outcome: String(d.outcome), reason: d.reason === undefined ? '' : String(d.reason) }))

/** Skill saves: none refused `unavailable`, and a saved one is in the workspace. */
export const skillChecks = (runDir: string, runs: { id: string; task: EvalTask }[]): Check[] => {
  const receipts = runs.flatMap(({ id, task }) => skillReceipts(runDir, id, task.sessions.length))
  const unavailable = receipts.filter((r) => r.reason === 'unavailable').length
  const written = runs.flatMap(({ id, task }) =>
    workspaces(runDir, id, task).flatMap((w) => skillFolders(w).map((name) => `${id}: ${name}`)),
  )
  const installed = receipts.filter((r) => r.outcome === 'installed' || r.outcome === 'saved').length
  const counts = `${receipts.length} skill save receipts (${installed} installed, ${unavailable} refused unavailable)`
  return [
    {
      name: 'skill saves are not refused unavailable',
      status: unavailable === 0 ? 'PASS' : 'FAIL',
      detail: counts,
    },
    {
      name: `a saved skill is in the workspace ${AGH_DIR}/skills`,
      status: written.length > 0 ? 'PASS' : receipts.length === 0 ? 'WARN' : installed > 0 ? 'FAIL' : 'WARN',
      detail:
        written.length > 0
          ? written.join('; ')
          : receipts.length === 0
            ? 'the review proposed no skill in these runs; nothing to install (run again or look at the ledgers)'
            : installed > 0
              ? 'a receipt says installed but no skill folder exists'
              : 'every skill save was refused for another reason; see the receipts',
    },
  ]
}

/** Runs with refinement off never write a skill. */
export const offWritesNoSkill = (runDir: string, runs: { id: string; task: EvalTask }[]): Check => {
  const written = runs.flatMap(({ id, task }) =>
    workspaces(runDir, id, task).flatMap((w) => skillFolders(w).map((name) => `${id}: ${name}`)),
  )
  return {
    name: 'off and oracle runs write no skill',
    status: written.length === 0 ? 'PASS' : 'FAIL',
    detail: written.length === 0 ? `${runs.map((r) => r.id).join(', ')}` : written.join('; '),
  }
}

/** The workflow run of the first session is counted as finished by the metric. */
export const workflowCheck = (runDir: string, tasks: EvalTask[], run: string): Check => {
  const record = readRunRecords(runDir, new Map(tasks.map((task) => [task.id, task]))).find(
    (r) => `${r.taskId}.${r.setting}.r${r.rep}` === run,
  )
  const reuse = record?.workflowReuse
  return {
    name: 'a workflow run is counted as finished',
    status: reuse?.firstCompleted ? 'PASS' : 'FAIL',
    detail: reuse
      ? `first session finished a workflow run: ${reuse.firstCompleted}; saved workflow skill: ${reuse.saved}; second-session calls ${reuse.calls}, matching ${reuse.matching}`
      : `no record for ${run}`,
  }
}

const memoryIndexes = (runDir: string, run: string): string[] => {
  const root = join(runDir, run, 'home', 'memory', 'workspaces')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((name) => join(root, name, 'MEMORY.md'))
    .filter((file) => existsSync(file))
}

/** The oracle lesson is in the second session's workspace memory, only there, and written between the sessions. */
export const oracleMemoryChecks = (runDir: string, task: EvalTask, oracle: string, off: string): Check[] => {
  const note = task.trap.note.trim()
  const holding = memoryIndexes(runDir, oracle).filter((file) => readFileSync(file, 'utf8').includes(note))
  const offHolding = memoryIndexes(runDir, off).filter((file) => readFileSync(file, 'utf8').includes(note))
  const first = ledger(runDir, oracle, 1)
  const second = ledger(runDir, oracle, 2)
  const last = first.at(-1)?.ts
  const start = second.find((row) => row.type === 'session/start')?.ts
  const mtime = holding[0] ? statSync(holding[0]).mtimeMs : undefined
  const between =
    mtime !== undefined && last !== undefined && start !== undefined
      ? Date.parse(last) <= mtime + 1000 && mtime <= Date.parse(start) + 1000
      : false
  return [
    {
      name: 'oracle: the lesson is in the workspace memory, the off run has none',
      status: holding.length === 1 && offHolding.length === 0 ? 'PASS' : 'FAIL',
      detail: `oracle memory files holding it: ${holding.length}; off: ${offHolding.length}`,
    },
    {
      name: 'oracle: the lesson was written between the two sessions',
      status: between ? 'PASS' : 'FAIL',
      detail:
        mtime === undefined || last === undefined || start === undefined
          ? 'missing memory file or ledger'
          : `first session ends ${last}, memory written ${new Date(mtime).toISOString()}, second session starts ${start}`,
    },
  ]
}

/**
 * The first session of an oracle run is the first session of the off run: the same prompts, system
 * prompt, tool schema and context sections of the first request. The runs differ in the throwaway
 * workspace path and in the run id, so the request bodies cannot be compared byte for byte, and the
 * `environment` section (which holds the working directory, so its size depends on the path) is left out
 * of the comparison with everything that sums it, such as the request's total. The other sections are
 * compared by id and size.
 */
export const firstSessionCheck = (runDir: string, oracle: string, off: string): Check => {
  const facts = (run: string) => {
    const rows = ledger(runDir, run, 1)
    const start = rows.find((row) => row.type === 'session/start')
    const sent = rows.find((row) => row.type === 'request/sent')
    const breakdown = rows.find((row) => row.type === 'x/core/context-breakdown')
    const data = dataOf(breakdown ?? ({} as Row))
    const tokens =
      isObject(data.composition) && isObject(data.composition.tokens) ? data.composition.tokens : {}
    const sections = (Array.isArray(data.sections) ? data.sections : [])
      .filter((section): section is Record<string, unknown> => isObject(section))
      .filter((section) => section.id !== 'environment')
      .map((section) => [section.id, section.tokens])
    const prompts = rows
      .filter((row) => row.type === 'user/message' && row.origin !== 'system')
      .map((row) => JSON.stringify(dataOf(row).content))
    return {
      systemPrompt: isObject(dataOf(start ?? ({} as Row)).systemPrompt)
        ? (dataOf(start as Row).systemPrompt as Record<string, unknown>).hash
        : undefined,
      toolSchema: dataOf(sent ?? ({} as Row)).tool_schema_hash,
      sections,
      conversationTokens: tokens.conversation,
      prompts,
    }
  }
  const a = facts(oracle)
  const b = facts(off)
  const same =
    a.systemPrompt !== undefined &&
    a.toolSchema !== undefined &&
    a.sections.length > 0 &&
    a.prompts.length > 0 &&
    JSON.stringify(a) === JSON.stringify(b)
  return {
    name: 'oracle: the first session matches the off run',
    status: same ? 'PASS' : 'FAIL',
    detail: same
      ? `${a.prompts.length} prompts, same system prompt, tool schema and ${a.sections.length} context sections (the environment section, which holds the path, is not compared)`
      : `oracle ${JSON.stringify({ ...a, prompts: a.prompts.length })} vs off ${JSON.stringify({ ...b, prompts: b.prompts.length })}`,
  }
}

/** Said with the skill-offer checks when they fail. */
export const SKILL_OFFER_NOTE =
  'a saved skill must be offered to the agent from the next request; a skill folder alone is not a saved skill'

/** The skill names a request's instructions offer (`<available_skills>`, one `name<TAB>description` per line), if it has a catalogue. */
export const catalogueOf = (instructions: string): string[] | undefined => {
  const start = instructions.indexOf('<available_skills>')
  if (start < 0) return undefined
  const end = instructions.indexOf('</available_skills>', start)
  return instructions
    .slice(start + '<available_skills>'.length, end < 0 ? undefined : end)
    .split('\n')
    .map((line) => line.split('\t')[0]?.trim() ?? '')
    .filter((name) => name !== '')
}

/** The model requests the host captured for a run, oldest first, with the skills each one's instructions offered. */
const capturedRequests = (runDir: string, run: string): { at: number; skills: string[] | undefined }[] => {
  const root = join(runDir, run, 'home', 'data', 'model-requests')
  if (!existsSync(root)) return []
  const out: { at: number; skills: string[] | undefined }[] = []
  for (const store of readdirSync(root, { withFileTypes: true })) {
    if (!store.isDirectory()) continue
    const dir = join(root, store.name)
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.call.json')) continue
      const call = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        createdAt?: string
        systemHash?: string
      }
      const blob = join(dir, `${call.systemHash}.blob.json`)
      const instructions = existsSync(blob) ? JSON.parse(readFileSync(blob, 'utf8')) : undefined
      out.push({
        at: Date.parse(call.createdAt ?? ''),
        skills: typeof instructions === 'string' ? catalogueOf(instructions) : undefined,
      })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** The skills the run's workspace registries record as installed, with when. */
const installedSkills = (runDir: string, run: string): { name: string; at: number }[] => {
  const root = join(runDir, run, 'home', 'data', 'refinement', 'workspaces')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const registry = JSON.parse(readFileSync(join(root, name), 'utf8')) as {
        receipts?: { source?: { kind?: string }; outcome?: string; target?: { name?: string }; at?: number }[]
      }
      return (registry.receipts ?? []).flatMap((r) =>
        r.source?.kind === 'skill' && r.outcome === 'installed' && typeof r.target?.name === 'string'
          ? [{ name: r.target.name, at: r.at ?? 0 }]
          : [],
      )
    })
}

/**
 * A skill an `on` run installed is offered to the agent: it is in the catalogue of a model request the run
 * made after the install. WARN when no later request with a catalogue was captured (nothing to judge by).
 */
export const skillsOfferedCheck = (runDir: string, runs: string[]): Check => {
  const verdicts = runs.flatMap((run) => {
    const requests = capturedRequests(runDir, run).filter((r) => r.skills !== undefined)
    return installedSkills(runDir, run).map((skill) => {
      const later = requests.filter((r) => r.at > skill.at)
      const offered = later.some((r) => r.skills?.includes(skill.name))
      return { label: `${run}: ${skill.name}`, later: later.length, offered }
    })
  })
  const name = 'a skill an on run saved is offered in a later request of that run'
  if (verdicts.length === 0) return { name, status: 'WARN', detail: 'no on run recorded an installed skill' }
  const judged = verdicts.filter((v) => v.later > 0)
  const failed = judged.filter((v) => !v.offered)
  const detail = verdicts
    .map(
      (v) =>
        `${v.label}: ${v.later === 0 ? 'no later request was captured' : v.offered ? 'offered' : `not offered in any of ${v.later} later requests`}`,
    )
    .join('; ')
  if (failed.length > 0) return { name, status: 'FAIL', detail: `${detail} (${SKILL_OFFER_NOTE})` }
  return { name, status: judged.length === 0 ? 'WARN' : 'PASS', detail }
}

/** The skills a frozen run was seeded with are offered in its first request that has a catalogue. */
export const frozenSkillsOfferedCheck = (runDir: string, run: string): Check => {
  const name = 'a frozen run is offered the skills it was seeded with from its first request'
  const file = join(runDir, run, 'outcome.json')
  if (!existsSync(file)) return { name, status: 'WARN', detail: `no frozen run ${run}` }
  const outcome = JSON.parse(readFileSync(file, 'utf8')) as {
    frozenFrom?: { skills?: Record<string, string[]> }
  }
  const seeded = Object.values(outcome.frozenFrom?.skills ?? {}).flat()
  if (seeded.length === 0) return { name, status: 'WARN', detail: `${run} was seeded with no skill` }
  const first = capturedRequests(runDir, run).find((r) => r.skills !== undefined)
  if (!first)
    return { name, status: 'FAIL', detail: `no request of ${run} with a skill catalogue was captured` }
  const missing = seeded.filter((skill) => !first.skills?.includes(skill))
  return missing.length === 0
    ? { name, status: 'PASS', detail: `${seeded.join(', ')} offered from the first request` }
    : {
        name,
        status: 'FAIL',
        detail: `not offered in the first request: ${missing.join(', ')}; it offered ${first.skills?.join(', ') || 'nothing'} (${SKILL_OFFER_NOTE})`,
      }
}

export function smokeChecklist(input: {
  runDir: string
  /** A task of two or more sessions, run with the arms off, on, oracle and frozen. */
  twoSession: EvalTask
  /** A workflow task run with the arm on; the workflow checks are left out without one. */
  workflow?: EvalTask
  rep: number
}): Check[] {
  const id = (task: EvalTask, arm: string) => `${task.id}.${arm}.r${input.rep}`
  const t = input.twoSession
  const w = input.workflow
  return [
    ...skillChecks(input.runDir, [
      { id: id(t, 'on'), task: t },
      ...(w ? [{ id: id(w, 'on'), task: w }] : []),
    ]),
    offWritesNoSkill(input.runDir, [
      { id: id(t, 'off'), task: t },
      { id: id(t, 'oracle'), task: t },
    ]),
    skillsOfferedCheck(input.runDir, [id(t, 'on'), ...(w ? [id(w, 'on')] : [])]),
    frozenSkillsOfferedCheck(input.runDir, id(t, 'frozen')),
    ...(w ? [workflowCheck(input.runDir, [t, w], id(w, 'on'))] : []),
    ...oracleMemoryChecks(input.runDir, t, id(t, 'oracle'), id(t, 'off')),
    firstSessionCheck(input.runDir, id(t, 'oracle'), id(t, 'off')),
  ]
}

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const main = (): void => {
  const runDir = flag('--run-dir')
  const twoSession = flag('--two-session')
  const workflow = flag('--workflow')
  if (!runDir || !twoSession)
    throw new Error(
      'usage: smoke-check.ts --run-dir <out> --two-session <task> [--workflow <task>] [--rep 1] [--suite <dir>]',
    )
  const suite = flag('--suite')
  const tasks = new Map(
    loadSuite(suite ? resolve(suite) : defaultTasksDir, { minTasks: 1 }).map((task) => [task.id, task]),
  )
  const pick = (name: string): EvalTask => {
    const task = tasks.get(name)
    if (!task) throw new Error(`unknown task ${name}`)
    return task
  }
  const checks = smokeChecklist({
    runDir: resolve(runDir),
    twoSession: pick(twoSession),
    ...(workflow ? { workflow: pick(workflow) } : {}),
    rep: Number(flag('--rep') ?? '1'),
  })
  for (const c of checks) console.log(`${c.status.padEnd(4)}  ${c.name}\n      ${c.detail}`)
  const failed = checks.filter((c) => c.status === 'FAIL').length
  const warned = checks.filter((c) => c.status === 'WARN').length
  console.log(`\n${checks.length - failed - warned} passed, ${failed} failed, ${warned} warnings`)
  if (checks.some((c) => c.status === 'FAIL' && c.detail.includes(SKILL_OFFER_NOTE)))
    console.log(`The skill-offer checks failed: ${SKILL_OFFER_NOTE}.`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
