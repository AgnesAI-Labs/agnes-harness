// Recomputes the repeat-error numbers of finished runs with the current trap rule (a hit is a failed
// run of the task's tool, not a read of its source). Read only: it never writes into a run folder and
// makes no model call. Use it to see which tasks still carry signal after the rule changed.
//
// Usage: pnpm exec tsx tools/rsi-eval/recompute.ts --run-dir <out> [--suite <dir>] [--json <file>]
// A run folder does not keep its task files and a prompt window is found by the prompt's exact text, so
// `--suite` must be the task directory the runs were made with (for older runs, a checkout of that
// version's tasks), not the current one. A run that ended cleanly with prompts that never matched is
// reported as a warning.
// Prints a markdown table (per task: sessions with a real first failure and sessions where it recurs,
// per arm) and the aggregate headline. `--json` writes the same numbers to a file outside the run folder.
import { writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildReport, readRunRecords } from './report.js'
import type { EvalTask, PromptWindow, RunRecord } from './types.js'

export type ArmCounts = { runs: number; sessions: number; firstFailure: number; recurs: number }
export type TaskRow = { taskId: string; on: ArmCounts; off: ArmCounts }

const sessionsOf = (record: RunRecord): PromptWindow[][] => {
  const sessions = new Map<number, PromptWindow[]>()
  for (const window of record.windows)
    sessions.set(window.session, [...(sessions.get(window.session) ?? []), window])
  return [...sessions.values()].map((list) => [...list].sort((a, b) => a.prompt - b.prompt))
}

const emptyArm = (): ArmCounts => ({ runs: 0, sessions: 0, firstFailure: 0, recurs: 0 })

/** Per task and arm: sessions that ran, sessions with a real first failure, and those that hit it again. */
export const taskRows = (records: RunRecord[]): TaskRow[] => {
  const rows = new Map<string, TaskRow>()
  for (const record of records) {
    // Oracle and frozen runs have their own sections in the report; this table is the on/off pair.
    if (record.setting !== 'on' && record.setting !== 'off') continue
    const row = rows.get(record.taskId) ?? { taskId: record.taskId, on: emptyArm(), off: emptyArm() }
    rows.set(record.taskId, row)
    const arm = row[record.setting]
    arm.runs++
    for (const windows of sessionsOf(record)) {
      const ran = windows.filter((w) => w.ran)
      if (ran.length === 0) continue
      arm.sessions++
      const first = ran.findIndex((w) => w.trapHit)
      if (first < 0) continue
      arm.firstFailure++
      if (ran.slice(first + 1).some((w) => w.trapHit)) arm.recurs++
    }
  }
  return [...rows.values()].sort((a, b) => a.taskId.localeCompare(b.taskId))
}

export const tableMarkdown = (rows: TaskRow[]): string => {
  const lines = [
    '| task | on: sessions | on: real first failure | on: recurs | off: sessions | off: real first failure | off: recurs |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  const total = { on: emptyArm(), off: emptyArm() }
  for (const row of rows) {
    lines.push(
      `| ${row.taskId} | ${row.on.sessions} | ${row.on.firstFailure} | ${row.on.recurs} | ${row.off.sessions} | ${row.off.firstFailure} | ${row.off.recurs} |`,
    )
    for (const arm of ['on', 'off'] as const)
      for (const key of ['runs', 'sessions', 'firstFailure', 'recurs'] as const)
        total[arm][key] += row[arm][key]
  }
  lines.push(
    `| all | ${total.on.sessions} | ${total.on.firstFailure} | ${total.on.recurs} | ${total.off.sessions} | ${total.off.firstFailure} | ${total.off.recurs} |`,
  )
  return lines.join('\n')
}

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const main = async (): Promise<void> => {
  const runDirArg = flag('--run-dir')
  if (!runDirArg) throw new Error('usage: recompute.ts --run-dir <out> [--suite <dir>] [--json <file>]')
  const runDir = resolve(runDirArg)
  const jsonOut = flag('--json')
  if (jsonOut && !relative(runDir, resolve(jsonOut)).startsWith('..'))
    throw new Error('--json must point outside the run folder: recompute never writes into it')

  const { loadSuite, defaultTasksDir } = await import('./suite.js')
  const suiteDir = flag('--suite')
  // Run folders keep the task ids of the suite they ran; load them all without the suite floor.
  const tasks = new Map<string, EvalTask>(
    loadSuite(suiteDir ? resolve(suiteDir) : defaultTasksDir, { minTasks: 1 }).map((t) => [t.id, t]),
  )
  const records = readRunRecords(runDir, tasks)
  // A run the upstream ended says nothing about the system under test (the report counts and names them).
  const rows = taskRows(records.filter((r) => !r.infraFailed))
  const unmatched = records.filter((r) => r.exit === 'ok' && r.windows.some((w) => !w.ran)).length
  if (unmatched > 0)
    console.error(
      `warning: ${unmatched} runs ended cleanly but some prompts of the suite were never found in their sessions; --suite is probably not the task directory these runs used`,
    )
  const report = buildReport(records)
  console.log(`# Recomputed from ${records.length} runs in ${runDirArg}\n`)
  console.log(tableMarkdown(rows))
  console.log()
  console.log(report.markdown)
  if (jsonOut) writeFileSync(resolve(jsonOut), `${JSON.stringify({ rows, report: report.json }, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
