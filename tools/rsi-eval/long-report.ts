// Report sections for long tasks and for what a learned lesson does on a fresh run:
//
// - Milestones: per-run curves of what was spent to each milestone, stopping where the run stopped, and
//   one point per run of milestones reached against dollars, as the paper draws them. Per arm and
//   milestone, how many runs reached it and the medians of those that did. No single "milestone every run
//   reached" rule: that collapses to the weakest run and hides an arm that fails more often.
// - Capped runs: listed apart, with where they stopped, and kept out of every mean.
// - Frozen: the frozen arm (refinement off, an `on` run's saved lessons from the start) against `off` and
//   the oracle, per session and for the whole run, over the sessions that completed and passed their checks.
// - Rule forgetting: per run, whether the trap was hit again after the first hit, later in the same session
//   (and of those, after a compaction) or in the second session.
import { sessionCost } from './metrics.js'
import { type Diff, pairedTaskBootstrap } from './stats.js'
import type { Arm, RunRecord } from './types.js'

type Options = { resamples?: number; seed?: number }

const median = (values: number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}
const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length
const finite = (value: number): number | null => (Number.isFinite(value) ? value : null)
const diffJson = (d: Diff) => ({
  estimate: finite(d.estimate),
  ci95: [finite(d.ci95[0]), finite(d.ci95[1])] as [number | null, number | null],
  tasks: d.tasks,
})
const groupBy = <T>(items: T[], key: (item: T) => string): Map<string, T[]> => {
  const out = new Map<string, T[]>()
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item])
  return out
}
const runName = (r: RunRecord): string => `${r.taskId}.${r.setting}.r${r.rep}`
const ARM_ORDER: readonly Arm[] = ['off', 'on', 'oracle', 'frozen']

// ------------------------------------------------------------------ milestones

export type RunStatus = 'completed' | 'capped' | 'milestone-failed' | 'timeout' | 'failed'

/** How a run ended, for the curves: a cap, a failed milestone, a timeout, another failure, or the end. */
export const runStatus = (r: RunRecord): RunStatus => {
  if (r.capped) return 'capped'
  if ((r.progress ?? []).some((p) => p.milestone !== undefined && p.passed === false))
    return 'milestone-failed'
  if (r.exit === 'timeout') return 'timeout'
  return r.exit === 'ok' ? 'completed' : 'failed'
}

/** The milestones a run passed, in order, up to the first that failed or was not reached. */
export const reachedMilestones = (r: RunRecord) => {
  const out: {
    milestone: string
    requests: number
    cost: number
    mainRequests: number
    toolCalls: number
  }[] = []
  for (const p of r.progress ?? []) {
    if (p.milestone === undefined) continue
    if (p.passed !== true) break
    out.push({
      milestone: p.milestone,
      requests: p.requests,
      cost: p.cost,
      mainRequests: p.mainRequests,
      toolCalls: p.toolCalls,
    })
  }
  return out
}

const runTotal = (r: RunRecord) => ({
  requests: (r.sessionCosts ?? []).reduce((sum, c) => sum + (c?.requests ?? 0), 0),
  cost: (r.sessionCosts ?? []).reduce((sum, c) => sum + (c?.cost ?? 0), 0),
})

export const milestonesReport = (records: RunRecord[]) => {
  const withMilestones = records.filter((r) => (r.progress ?? []).some((p) => p.milestone !== undefined))
  if (withMilestones.length === 0) return undefined
  const tasks = [...groupBy(withMilestones, (r) => r.taskId)].map(([taskId, runs]) => {
    // The task's milestones, in order, as its runs record them.
    const names: string[] = []
    for (const r of runs)
      for (const p of r.progress ?? [])
        if (p.milestone !== undefined && !names.includes(p.milestone)) names.push(p.milestone)
    const rows = runs
      .sort((a, b) => ARM_ORDER.indexOf(a.setting) - ARM_ORDER.indexOf(b.setting) || a.rep - b.rep)
      .map((r) => {
        const points = reachedMilestones(r)
        return {
          run: runName(r),
          arm: r.setting,
          rep: r.rep,
          status: runStatus(r),
          reached: points.length,
          points,
          total: runTotal(r),
        }
      })
    const byArm = Object.fromEntries(
      ARM_ORDER.filter((arm) => rows.some((row) => row.arm === arm)).map((arm) => {
        const armRows = rows.filter((row) => row.arm === arm)
        return [
          arm,
          names.map((milestone) => {
            const at = armRows.flatMap((row) => row.points.filter((p) => p.milestone === milestone))
            return {
              milestone,
              reached: at.length,
              of: armRows.length,
              medianRequests: median(at.map((p) => p.requests)),
              medianMainRequests: median(at.map((p) => p.mainRequests)),
              medianCost: median(at.map((p) => p.cost)),
            }
          }),
        ]
      }),
    )
    return { taskId, milestones: names, runs: rows, byArm }
  })
  return { tasks }
}

const usd = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(4))
const num = (value: number | null): string => (value === null ? 'n/a' : String(Math.round(value * 10) / 10))

export const milestonesMarkdown = (m: NonNullable<ReturnType<typeof milestonesReport>>): string[] => {
  const lines = [
    '### Milestones: what each run spent to each milestone',
    '',
    'Each row is one run, its curve stopping where the run stopped (a failed milestone, a cap, a timeout). A cell is the requests (all lanes) and dollars the run had spent when that milestone passed. Per arm and milestone: how many runs reached it, and the medians over those that did. The last table is one point per run: milestones reached against what the whole run cost.',
    '',
  ]
  for (const t of m.tasks) {
    lines.push(
      `#### ${t.taskId}`,
      '',
      `| run | status | ${t.milestones.join(' | ')} |`,
      `| --- | --- |${t.milestones.map(() => ' --- |').join('')}`,
    )
    for (const row of t.runs) {
      const cells = t.milestones.map((name) => {
        const p = row.points.find((x) => x.milestone === name)
        return p ? `${p.requests} req, $${p.cost.toFixed(4)}` : '-'
      })
      lines.push(`| ${row.run} | ${row.status} | ${cells.join(' | ')} |`)
    }
    lines.push(
      '',
      `| arm | ${t.milestones.join(' | ')} |`,
      `| --- |${t.milestones.map(() => ' --- |').join('')}`,
    )
    for (const [arm, cells] of Object.entries(t.byArm))
      lines.push(
        `| ${arm} | ${cells.map((c) => `${c.reached}/${c.of}; median ${num(c.medianRequests)} req (${num(c.medianMainRequests)} session work), $${usd(c.medianCost)}`).join(' | ')} |`,
      )
    lines.push(
      '',
      '| run | arm | milestones reached | requests, whole run | cost (USD), whole run | status |',
      '| --- | --- | --- | --- | --- | --- |',
    )
    for (const row of t.runs)
      lines.push(
        `| ${row.run} | ${row.arm} | ${row.reached} of ${t.milestones.length} | ${row.total.requests} | ${row.total.cost.toFixed(4)} | ${row.status} |`,
      )
    lines.push('')
  }
  return lines
}

// ------------------------------------------------------------------ capped runs

export const cappedReport = (records: RunRecord[]) => {
  const capped = records.filter((r) => r.capped)
  if (capped.length === 0) return undefined
  return {
    byArm: Object.fromEntries(ARM_ORDER.map((arm) => [arm, capped.filter((r) => r.setting === arm).length])),
    runs: capped.map((r) => ({
      run: runName(r),
      maxRequests: r.capped?.maxRequests ?? 0,
      session: r.capped?.session ?? 0,
      prompt: r.capped?.prompt ?? 0,
      milestonesReached: reachedMilestones(r).length,
    })),
  }
}

export const cappedMarkdown = (c: NonNullable<ReturnType<typeof cappedReport>>): string[] => [
  '### Capped runs',
  '',
  `Runs that reached their request cap and were stopped there: ${ARM_ORDER.map((arm) => `${arm} ${c.byArm[arm] ?? 0}`).join(', ')}. They are left out of every mean above; an arm that hits the cap more often is a result in itself.`,
  '',
  '| run | cap | stopped in | milestones reached |',
  '| --- | --- | --- | --- |',
  ...c.runs.map(
    (r) =>
      `| ${r.run} | ${r.maxRequests} | session ${r.session + 1}, prompt ${r.prompt + 1} | ${r.milestonesReached} |`,
  ),
  '',
]

// ------------------------------------------------------------------ frozen

/** A session that completed and passed every check of its prompts (the whole run for `session` undefined). */
const sessionComplete = (r: RunRecord, session?: number): boolean => {
  if (r.exit !== 'ok' || r.capped) return false
  const windows = r.windows.filter((w) => session === undefined || w.session === session)
  return windows.length > 0 && windows.every((w) => w.ran && w.checksPassed === true)
}

export const frozenReport = (records: RunRecord[], options: Options = {}) => {
  const frozen = records.filter((r) => r.setting === 'frozen')
  if (frozen.length === 0) return undefined
  const taskIds = new Set(frozen.map((r) => r.taskId))
  const pool = records.filter(
    (r) => taskIds.has(r.taskId) && (r.setting === 'off' || r.setting === 'frozen' || r.setting === 'oracle'),
  )
  const sessions = Math.max(...pool.map((r) => r.sessionCosts?.length ?? 0))
  const scopes: (number | undefined)[] = [...Array.from({ length: sessions }, (_, i) => i), undefined]
  const measure = (scope: number | undefined, pick: 'requests' | 'cost') => {
    const value = (r: RunRecord): number | undefined => {
      if (!sessionComplete(r, scope)) return undefined
      if (scope !== undefined) return sessionCost(r, scope)?.[pick]
      return (r.sessionCosts ?? []).reduce((sum, c) => sum + (c?.[pick] ?? 0), 0)
    }
    const byTask = [...groupBy(pool, (r) => r.taskId)].map(([taskId, runs]) => {
      const of = (arm: Arm) =>
        runs
          .filter((r) => r.setting === arm)
          .flatMap((r) => (value(r) === undefined ? [] : [value(r) as number]))
      return { taskId, off: of('off'), frozen: of('frozen'), oracle: of('oracle') }
    })
    const armMean = (arm: 'off' | 'frozen' | 'oracle') =>
      mean(byTask.filter((t) => t[arm].length > 0).map((t) => mean(t[arm]) as number))
    const paired = (b: 'frozen' | 'oracle') =>
      diffJson(
        pairedTaskBootstrap(
          byTask.map((t) => ({ taskId: t.taskId, on: t.off, off: t[b] })),
          options.resamples,
          options.seed,
        ),
      )
    return {
      mean: { off: armMean('off'), frozen: armMean('frozen'), oracle: armMean('oracle') },
      offMinusFrozen: paired('frozen'),
      offMinusOracle: paired('oracle'),
    }
  }
  const leftOut = Object.fromEntries(
    (['off', 'frozen', 'oracle'] as const).map((arm) => [
      arm,
      pool.filter((r) => r.setting === arm && !sessionComplete(r)).length,
    ]),
  )
  return {
    tasks: [...taskIds].sort(),
    runs: Object.fromEntries(
      (['off', 'frozen', 'oracle'] as const).map((arm) => [
        arm,
        pool.filter((r) => r.setting === arm).length,
      ]),
    ),
    leftOut,
    seeded: frozen.map((r) => ({ run: runName(r), ...(r.frozenFrom ?? {}) })),
    scopes: scopes.map((scope) => ({
      scope: scope === undefined ? 'whole run' : `session ${scope + 1}`,
      requests: measure(scope, 'requests'),
      cost: measure(scope, 'cost'),
    })),
  }
}

const fmtDiff = (d: ReturnType<typeof diffJson>, money: boolean): string =>
  d.estimate === null
    ? 'n/a'
    : `${money ? d.estimate.toFixed(4) : num(d.estimate)} (95% CI ${money ? usd(d.ci95[0]) : num(d.ci95[0])} to ${money ? usd(d.ci95[1]) : num(d.ci95[1])}; ${d.tasks} tasks)`

export const frozenMarkdown = (f: NonNullable<ReturnType<typeof frozenReport>>): string[] => {
  const lines = [
    '### Frozen lessons on a fresh run',
    '',
    "The frozen arm runs with refinement off and starts with exactly what an `on` run of the same task and repetition saved (its saved memory paragraphs, user memory sections and workspace skills). It has no review calls and no experience guidance, so it measures the lessons themselves. Against `off` (no lessons) and the oracle (the task's own note). Differences are off minus the other arm, positive when the other arm is cheaper. Only sessions that completed and passed their checks enter.",
    '',
    `Tasks: ${f.tasks.join(', ')}. Runs: off ${f.runs.off}, frozen ${f.runs.frozen}, oracle ${f.runs.oracle}; left out (did not complete or failed a check): off ${f.leftOut.off}, frozen ${f.leftOut.frozen}, oracle ${f.leftOut.oracle}.`,
    '',
    '| scope | measure | off | frozen | oracle | off minus frozen | off minus oracle |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const s of f.scopes) {
    for (const [name, m, money] of [
      ['requests', s.requests, false],
      ['cost (USD)', s.cost, true],
    ] as const)
      lines.push(
        `| ${s.scope} | ${name} | ${money ? usd(m.mean.off) : num(m.mean.off)} | ${money ? usd(m.mean.frozen) : num(m.mean.frozen)} | ${money ? usd(m.mean.oracle) : num(m.mean.oracle)} | ${fmtDiff(m.offMinusFrozen, money)} | ${fmtDiff(m.offMinusOracle, money)} |`,
      )
  }
  lines.push('', 'What each frozen run was seeded with:', '')
  for (const s of f.seeded) {
    const paragraphs = Object.values((s as { paragraphs?: Record<string, number> }).paragraphs ?? {}).reduce(
      (a, b) => a + b,
      0,
    )
    const skills = Object.values((s as { skills?: Record<string, string[]> }).skills ?? {}).flat()
    lines.push(
      `- ${s.run}: from ${(s as { runId?: string }).runId ?? '?'}; ${paragraphs} memory paragraphs, ${(s as { userSections?: number }).userSections ?? 0} user memory sections, skills: ${skills.length === 0 ? 'none' : skills.join(', ')}`,
    )
  }
  lines.push('')
  return lines
}

// ------------------------------------------------------------------ rule forgetting

export type Forgetting = {
  run: string
  arm: Arm
  /** The session of the first trap hit (zero-based), or null when the trap was never hit. */
  firstHitSession: number | null
  /** Hits after the first, in the same session. */
  againSameSession: number
  /** Of those, hits with a compaction between the first hit and them. */
  againAfterCompaction: number
  /** Hits in the second session after a first hit in the first; null without a second session or a first-session hit. */
  againInSession2: number | null
}

/**
 * Whether a run broke the trap rule again after it first hit it: later in the same session (and whether a
 * compaction came between), or in the second session. From the ledgers, with the same trap rule as the
 * other metrics: a failed run of an executing tool with the task's signature.
 */
export const ruleForgetting = (r: RunRecord): Forgetting | undefined => {
  const events = r.trapEvents
  if (!events) return undefined
  const first = events.find((e) => e.hits.length > 0)
  const firstSeq = first?.hits[0]
  const later = first ? first.hits.filter((seq) => seq > (firstSeq as number)) : []
  const afterCompaction = first
    ? later.filter((seq) => first.compactions.some((c) => c > (firstSeq as number) && c < seq)).length
    : 0
  const second = events.find((e) => e.session === 1)
  return {
    run: runName(r),
    arm: r.setting,
    firstHitSession: first ? first.session : null,
    againSameSession: later.length,
    againAfterCompaction: afterCompaction,
    againInSession2: first?.session === 0 && second ? second.hits.length : null,
  }
}

export const forgettingReport = (records: RunRecord[]) => {
  const rows = records
    .filter((r) => r.category !== 'workflow')
    .flatMap((r) => {
      const f = ruleForgetting(r)
      return f ? [f] : []
    })
  if (rows.length === 0) return undefined
  const byArm = Object.fromEntries(
    ARM_ORDER.filter((arm) => rows.some((row) => row.arm === arm)).map((arm) => {
      const armRows = rows.filter((row) => row.arm === arm)
      const hit = armRows.filter((row) => row.firstHitSession !== null)
      const withSecond = hit.filter((row) => row.againInSession2 !== null)
      return [
        arm,
        {
          runs: armRows.length,
          firstHit: hit.length,
          againSameSession: hit.filter((row) => row.againSameSession > 0).length,
          againAfterCompaction: hit.filter((row) => row.againAfterCompaction > 0).length,
          withSecondSession: withSecond.length,
          againInSession2: withSecond.filter((row) => (row.againInSession2 ?? 0) > 0).length,
        },
      ]
    }),
  )
  return { byArm, off: rows.filter((row) => row.arm === 'off') }
}

export const forgettingMarkdown = (f: NonNullable<ReturnType<typeof forgettingReport>>): string[] => {
  const lines = [
    '### Rule forgetting',
    '',
    "Whether a run broke the trap rule again after its first hit: later in the same session (and of those, after a compaction of the context), or in the second session. A trap hit is a failed run of the task's tool with its signature, as above. If `off` never breaks the rule again, there is nothing for a saved lesson to save. Workflow tasks are left out.",
    '',
    '| arm | runs | first hit | again, same session | again after a compaction | again in session 2 (of runs with one) |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const [arm, a] of Object.entries(f.byArm))
    lines.push(
      `| ${arm} | ${a.runs} | ${a.firstHit} | ${a.againSameSession} | ${a.againAfterCompaction} | ${a.againInSession2} of ${a.withSecondSession} |`,
    )
  lines.push(
    '',
    'Each off run:',
    '',
    '| run | first hit | again, same session | of those after a compaction | again in session 2 |',
    '| --- | --- | --- | --- | --- |',
  )
  for (const row of f.off)
    lines.push(
      `| ${row.run} | ${row.firstHitSession === null ? 'never' : `session ${row.firstHitSession + 1}`} | ${row.againSameSession} | ${row.againAfterCompaction} | ${row.againInSession2 === null ? 'n/a' : row.againInSession2} |`,
    )
  lines.push('')
  return lines
}
