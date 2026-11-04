// How often the first session hit the trap, per arm and per task. A task whose first session never hits it
// leaves nothing for refinement to repeat or avoid, and shows up here as a task with no hit. Workflow tasks
// are left out: their commands run in child sessions, so a hit is not defined for them.
import type { RunRecord } from './types.js'

type TrapCell = { runs: number; hit: number }
const ARMS = ['on', 'off', 'oracle', 'frozen'] as const
type Arms = Record<(typeof ARMS)[number], TrapCell>

const trapCell = (runs: RunRecord[]): TrapCell => ({
  runs: runs.length,
  hit: runs.filter((r) => r.windows.some((w) => w.session === 0 && w.ran && w.trapHit)).length,
})
const cells = (runs: RunRecord[]): Arms =>
  Object.fromEntries(ARMS.map((arm) => [arm, trapCell(runs.filter((r) => r.setting === arm))])) as Arms

export const firstSessionTrapReport = (records: RunRecord[]) => {
  const runs = records.filter(
    (r) => r.category !== 'workflow' && r.windows.some((w) => w.session === 0 && w.ran),
  )
  const byTask = new Map<string, RunRecord[]>()
  for (const r of runs) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r])
  const tasks = [...byTask].map(([taskId, list]) => ({ taskId, ...cells(list) }))
  return {
    byArm: cells(runs),
    tasks,
    noHit: tasks.filter((t) => ARMS.every((arm) => t[arm].hit === 0)).map((t) => t.taskId),
  }
}

export const trapMarkdown = (t: ReturnType<typeof firstSessionTrapReport>): string[] => {
  const cell = (c: TrapCell): string => (c.runs === 0 ? '-' : `${c.hit}/${c.runs}`)
  // The arms of the first suite always show; the others only when they ran.
  const shown = ARMS.filter((arm) => arm === 'on' || arm === 'off' || t.byArm[arm].runs > 0)
  return [
    '### First-session trap hits',
    '',
    "Runs whose first session hit the trap (a failed run of the task's tool with its signature), out of the runs of that task and arm. A run whose first session never hits it has nothing for refinement to repeat or avoid and is excluded from metrics 1 and 2. Workflow tasks are left out (their commands run in child sessions).",
    '',
    `- Rate: ${shown.map((arm) => `${arm} ${cell(t.byArm[arm])}`).join(', ')}`,
    `- Tasks whose first session never hit the trap in any run: ${t.noHit.length === 0 ? 'none' : `${t.noHit.length} (${t.noHit.join(', ')})`}`,
    '',
    `| task | ${shown.join(' | ')} |`,
    `|${shown.map(() => ' --- |').join('')} --- |`,
    ...t.tasks.map((row) => `| ${row.taskId} | ${shown.map((arm) => cell(row[arm])).join(' | ')} |`),
    '',
  ]
}
