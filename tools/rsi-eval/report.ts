// Aggregate report over evaluation runs. Output holds only aggregate numbers and structure fields:
// no message bodies, tool output, prompt text or absolute paths.
//
// Usage: pnpm exec tsx tools/rsi-eval/report.ts --run-dir <out> --config <run-config.json> [--suite <dir>]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGH_DIR } from '../../packages/protocol/src/constants.js'
import { type CaptureResult, captureMetric } from './capture.js'
import { runMetrics, sessionCost, toRunRecord, type UsageSummary, workflowReuseMetric } from './metrics.js'
import { type Diff, pairedTaskBootstrap } from './stats.js'
import { fixtureOf, workspaceName } from './suite.js'
import type { Arm, EvalTask, RunConfig, RunOutcome, RunRecord, SessionCost, UsageRow } from './types.js'
import { readSkillTexts } from './workflow-reuse.js'

export type ReportOptions = {
  resamples?: number
  seed?: number
  /** The run configuration, for the report header: what model, upstream and prices the run used. */
  run?: Pick<RunConfig, 'provider' | 'api' | 'upstream' | 'model' | 'prices' | 'pricesAssumed'>
}

type DiffJson = {
  estimate: number | null
  ci95: [number | null, number | null]
  tasks: number
  excludedRuns: number
}

const finite = (value: number): number | null => (Number.isFinite(value) ? value : null)
const diffJson = (diff: Diff): DiffJson => ({
  estimate: finite(diff.estimate),
  ci95: [finite(diff.ci95[0]), finite(diff.ci95[1])],
  tasks: diff.tasks,
  excludedRuns: diff.excludedRuns,
})

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length

const groupBy = <T>(items: T[], key: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const list = groups.get(key(item)) ?? []
    list.push(item)
    groups.set(key(item), list)
  }
  return groups
}

/**
 * How many runs have no value for a metric (the trap never failed in a session that could repeat it) and
 * how many tasks are left without any value, per arm. Those runs and tasks do not enter the difference.
 */
export type Exclusion = { runs: number; tasks: number; of: number }
const exclusionOf = (perTask: (number | null)[][]): Exclusion => ({
  runs: perTask.reduce((sum, values) => sum + values.filter((v) => v === null).length, 0),
  tasks: perTask.filter((values) => values.every((v) => v === null)).length,
  of: perTask.reduce((sum, values) => sum + values.length, 0),
})

const bySetting = (records: RunRecord[], setting: Arm): RunRecord[] =>
  records.filter((r) => r.setting === setting)

const DIRECTIONS = {
  repeatErrorDrop:
    'off minus on, in recurrence rate (share of prompts after the first trap hit that hit it again). Positive means refinement lowers repeat errors.',
  crossSessionReuse:
    'on minus off, in the share of cross-session runs whose first session hit the trap and whose second session never did. Positive means refinement helps the second session. Only cross-session tasks; runs whose first session never hit the trap are excluded.',
  crossWorkspaceReuse:
    'on minus off, in the share of cross-workspace runs whose first session hit the trap and whose second session, in another workspace, never did. Positive means what refinement learned in one workspace helps in another. Only cross-workspace tasks; runs whose first session never hit the trap are excluded.',
  workflowReuse:
    "Share of the second session's `workflow` calls (a new session in the same workspace) whose definition, normalised, equals one the first session saved as a skill in that workspace. Per setting, not a difference. Only workflow tasks; runs whose first session never completed a `workflow` run are excluded, runs where the workspace holds no skill with a workflow definition count as nothing saved, or as save refused when the host refused the workspace save.",
  costOverhead:
    '(on minus off) divided by off, per task then averaged. Positive means refinement costs more; 0.25 is 25 percent more.',
  secondSession:
    "What the second session of a two-session task costs (model requests, tokens, dollars; every lane of its ledger, the review calls included), per arm: off, on, and oracle (off plus the task's own lesson written to memory before that session). Differences are off minus the other arm, so positive means the other arm is cheaper. Capture rate = sum of (off minus on) over sum of (off minus oracle), over the tasks whose off-minus-oracle 95% interval lies above 0; the others are counted as no headroom. Single-session and workflow tasks do not enter.",
} as const

const CRITERION_1_RULE = 'repeat-error difference (off minus on) is above 0 and its 95% interval excludes 0'

const overheadDiff = (
  records: RunRecord[],
  pick: (r: RunRecord) => number,
  options: ReportOptions,
): { diff: Diff; skippedTasks: number; pooled: number | null } => {
  let skippedTasks = 0
  const perTask: { taskId: string; on: number[]; off: number[] }[] = []
  for (const [taskId, runs] of groupBy(records, (r) => r.taskId)) {
    const on = mean(bySetting(runs, 'on').map(pick))
    const off = mean(bySetting(runs, 'off').map(pick))
    if (on === null || off === null || off <= 0) {
      skippedTasks++
      continue
    }
    perTask.push({ taskId, on: [(on - off) / off], off: [0] })
  }
  const onAll = mean(bySetting(records, 'on').map(pick))
  const offAll = mean(bySetting(records, 'off').map(pick))
  const pooled = onAll === null || offAll === null || offAll <= 0 ? null : (onAll - offAll) / offAll
  return { diff: pairedTaskBootstrap(perTask, options.resamples, options.seed), skippedTasks, pooled }
}

const sumRefine = (records: RunRecord[]) => ({
  auto: records.reduce((sum, r) => sum + r.refine.auto, 0),
  user: records.reduce((sum, r) => sum + r.refine.user, 0),
  self: records.reduce((sum, r) => sum + r.refine.self, 0),
  appliedEdits: records.reduce((sum, r) => sum + r.refine.appliedEdits, 0),
})

const exitDistribution = (records: RunRecord[]) => ({
  ok: records.filter((r) => r.exit === 'ok').length,
  error: records.filter((r) => r.exit === 'error').length,
  timeout: records.filter((r) => r.exit === 'timeout').length,
})

const settingSummary = (records: RunRecord[]) => ({
  runs: records.length,
  completion: mean(records.map((r) => runMetrics(r).completion)),
  refine: sumRefine(records),
  harnessLookups: records.reduce((sum, r) => sum + r.harnessLookups, 0),
  compactions: records.reduce((sum, r) => sum + r.compactions, 0),
  usage: {
    requests: records.reduce((sum, r) => sum + r.usage.requests, 0),
    unknownRequests: records.reduce((sum, r) => sum + r.usage.unknown, 0),
    tokens: records.reduce((sum, r) => sum + r.usage.tokens, 0),
    costUsd: records.reduce((sum, r) => sum + r.usage.costUsd, 0),
  },
  exit: exitDistribution(records),
})

/** Reuse of saved workflow definitions in one setting's workflow runs. */
const workflowReuseSummary = (runs: RunRecord[]) => {
  const metrics = runs.map((r) => ({ taskId: r.taskId, metric: workflowReuseMetric(r) }))
  const counted = metrics.flatMap(({ metric }) => (metric && !metric.excluded ? [metric] : []))
  const calls = counted.reduce((sum, m) => sum + m.calls, 0)
  const matching = counted.reduce((sum, m) => sum + m.matching, 0)
  const reusedRuns = counted.filter((m) => m.reused).length
  const perTask = [...groupBy(metrics, (m) => m.taskId).values()].map((list) =>
    list.map(({ metric }) => (metric === null || metric.excluded ? null : metric.reused ? 1 : 0)),
  )
  return {
    runs: metrics.length,
    excluded: exclusionOf(perTask),
    nothingSaved: counted.filter((m) => m.nothingSaved).length,
    saveRefused: counted.filter((m) => m.saveRefused !== undefined).length,
    withoutCall: counted.filter((m) => m.calls === 0).length,
    calls,
    matchingCalls: matching,
    reuseRate: calls === 0 ? null : matching / calls,
    reusedRuns,
    runRate: counted.length === 0 ? null : reusedRuns / counted.length,
  }
}

const secondSessionMeasure = (r: CaptureResult) => ({
  mean: r.means,
  offMinusOn: diffJson(r.offMinusOn),
  offMinusOracle: diffJson(r.offMinusOracle),
  captureRate: r.capture.rate,
  included: r.capture.included,
  noHeadroom: r.capture.noHeadroom,
  tooFewRuns: r.capture.tooFewRuns,
  noOnRuns: r.capture.noOnRuns,
})

const SECOND_SESSION_MEASURES = ['requests', 'tokens', 'cost'] as const
type Measure = (typeof SECOND_SESSION_MEASURES)[number]

type SecondSessionRuns = { record: RunRecord; cost: SessionCost }

/**
 * The second session of the two-session tasks, per arm, and the capture rate. Only runs with a recorded
 * cost for their second session enter (a single-session task has none; workflow tasks are left out).
 */
const secondSessionReport = (records: RunRecord[], options: ReportOptions) => {
  const runs: SecondSessionRuns[] = records.flatMap((record) => {
    const cost = record.category === 'workflow' ? undefined : sessionCost(record, 1)
    return cost ? [{ record, cost }] : []
  })
  if (runs.length === 0) return undefined
  const byTask = groupBy(runs, (r) => r.record.taskId)
  const measure = (name: Measure): CaptureResult =>
    captureMetric(
      [...byTask].map(([taskId, list]) => {
        const values = (arm: Arm) => list.filter((r) => r.record.setting === arm).map((r) => r.cost[name])
        return { taskId, off: values('off'), on: values('on'), oracle: values('oracle') }
      }),
      options,
    )
  const arms = (arm: Arm) => runs.filter((r) => r.record.setting === arm).length
  const measures = Object.fromEntries(
    SECOND_SESSION_MEASURES.map((name) => [name, secondSessionMeasure(measure(name))]),
  ) as Record<Measure, ReturnType<typeof secondSessionMeasure>>
  return {
    direction: DIRECTIONS.secondSession,
    tasks: byTask.size,
    runs: { off: arms('off'), on: arms('on'), oracle: arms('oracle') },
    lowerBoundRuns: runs.filter((r) => r.cost.lowerBound).length,
    measures,
  }
}

type TrapCell = { runs: number; hit: number }
const trapCell = (runs: RunRecord[]): TrapCell => ({
  runs: runs.length,
  hit: runs.filter((r) => r.windows.some((w) => w.session === 0 && w.ran && w.trapHit)).length,
})

/**
 * How often the first session hit the trap, per arm and per task. A task whose first session never hits it
 * leaves nothing for refinement to repeat or avoid, and shows up here as a task with no hit. Workflow tasks
 * are left out: their commands run in child sessions, so a hit is not defined for them.
 */
const firstSessionTrapReport = (records: RunRecord[]) => {
  const runs = records.filter(
    (r) => r.category !== 'workflow' && r.windows.some((w) => w.session === 0 && w.ran),
  )
  const arms = ['on', 'off', 'oracle'] as const
  const byArm = Object.fromEntries(arms.map((arm) => [arm, trapCell(bySetting(runs, arm))])) as Record<
    (typeof arms)[number],
    TrapCell
  >
  const tasks = [...groupBy(runs, (r) => r.taskId)].map(([taskId, list]) => ({
    taskId,
    ...(Object.fromEntries(arms.map((arm) => [arm, trapCell(bySetting(list, arm))])) as Record<
      (typeof arms)[number],
      TrapCell
    >),
  }))
  return {
    byArm,
    tasks,
    noHit: tasks.filter((t) => t.on.hit + t.off.hit + t.oracle.hit === 0).map((t) => t.taskId),
  }
}

const systemReport = (records: RunRecord[], options: ReportOptions) => {
  const on = bySetting(records, 'on')
  const off = bySetting(records, 'off')
  const recurrence = (runs: RunRecord[]): (number | null)[] => runs.map((r) => runMetrics(r).recurrence)

  const perTask = (select: (runs: RunRecord[]) => (number | null)[], from: RunRecord[]) =>
    [...groupBy(from, (r) => r.taskId)].map(([taskId, runs]) => ({
      taskId,
      on: select(bySetting(runs, 'on')),
      off: select(bySetting(runs, 'off')),
    }))

  // Metric 1: the diff is off minus on, so the arrays are swapped. Workflow tasks are left out: their
  // trap failures happen in member sessions, whose ledgers are not recorded, so a trap hit is not
  // defined for them. They are counted below, not dropped silently.
  const trapRecords = records.filter((r) => r.category !== 'workflow')
  const leftOut = {
    on: bySetting(records, 'on').length - bySetting(trapRecords, 'on').length,
    off: bySetting(records, 'off').length - bySetting(trapRecords, 'off').length,
  }
  const drop = pairedTaskBootstrap(
    perTask(recurrence, trapRecords).map((t) => ({ taskId: t.taskId, on: t.off, off: t.on })),
    options.resamples,
    options.seed,
  )

  // Metric 2: cross-session tasks only, avoided = 1 and not avoided = 0.
  const binary = (avoided: boolean | null): number | null => (avoided === null ? null : avoided ? 1 : 0)
  const avoidedOf = (runs: RunRecord[]): (number | null)[] =>
    runs.map((r) => binary(runMetrics(r).crossSessionAvoided))
  const cross = records.filter((r) => r.category === 'cross-session')
  const reuse = pairedTaskBootstrap(perTask(avoidedOf, cross), options.resamples, options.seed)

  // Metric 2, cross-workspace: reported on its own, never pooled with cross-session.
  const avoidedElsewhereOf = (runs: RunRecord[]): (number | null)[] =>
    runs.map((r) => binary(runMetrics(r).crossWorkspaceAvoided))
  const elsewhere = records.filter((r) => r.category === 'cross-workspace')
  const reuseElsewhere = pairedTaskBootstrap(
    perTask(avoidedElsewhereOf, elsewhere),
    options.resamples,
    options.seed,
  )
  const definedMean = (values: (number | null)[]): number | null =>
    mean(values.filter((v): v is number => v !== null))

  const tokens = overheadDiff(records, (r) => r.usage.tokens, options)
  const cost = overheadDiff(records, (r) => r.usage.costUsd, options)

  const exclusion = (select: (runs: RunRecord[]) => (number | null)[], from: RunRecord[]) => ({
    on: exclusionOf([...groupBy(bySetting(from, 'on'), (r) => r.taskId).values()].map(select)),
    off: exclusionOf([...groupBy(bySetting(from, 'off'), (r) => r.taskId).values()].map(select)),
  })

  const workflowRuns = records.filter((r) => r.workflowReuse !== undefined)

  const second = secondSessionReport(records, options)
  const firstTrap = firstSessionTrapReport(records)

  const lower = drop.ci95[0]
  const criterion1 = drop.tasks > 0 && drop.estimate > 0 && lower > 0

  return {
    runs: { on: on.length, off: off.length },
    tasks: new Set(records.map((r) => r.taskId)).size,
    repeatErrorDrop: {
      direction: DIRECTIONS.repeatErrorDrop,
      recurrenceOn: definedMean(recurrence(bySetting(trapRecords, 'on'))),
      recurrenceOff: definedMean(recurrence(bySetting(trapRecords, 'off'))),
      difference: diffJson(drop),
      excluded: exclusion(recurrence, trapRecords),
      ...(leftOut.on + leftOut.off === 0 ? {} : { workflowRunsLeftOut: leftOut }),
    },
    crossSessionReuse: {
      direction: DIRECTIONS.crossSessionReuse,
      avoidedOn: definedMean(avoidedOf(bySetting(cross, 'on'))),
      avoidedOff: definedMean(avoidedOf(bySetting(cross, 'off'))),
      difference: diffJson(reuse),
      excluded: exclusion(avoidedOf, cross),
    },
    crossWorkspaceReuse: {
      direction: DIRECTIONS.crossWorkspaceReuse,
      avoidedOn: definedMean(avoidedElsewhereOf(bySetting(elsewhere, 'on'))),
      avoidedOff: definedMean(avoidedElsewhereOf(bySetting(elsewhere, 'off'))),
      difference: diffJson(reuseElsewhere),
      excluded: exclusion(avoidedElsewhereOf, elsewhere),
      autoOnlyRuns: elsewhere.filter((r) => r.setting === 'on' && r.alignment === 'auto-only').length,
    },
    ...(workflowRuns.length === 0
      ? {}
      : {
          workflowReuse: {
            direction: DIRECTIONS.workflowReuse,
            on: workflowReuseSummary(bySetting(workflowRuns, 'on')),
            off: workflowReuseSummary(bySetting(workflowRuns, 'off')),
          },
        }),
    costOverhead: {
      direction: DIRECTIONS.costOverhead,
      tokens: { relative: diffJson(tokens.diff), pooled: tokens.pooled, skippedTasks: tokens.skippedTasks },
      costUsd: { relative: diffJson(cost.diff), pooled: cost.pooled, skippedTasks: cost.skippedTasks },
    },
    firstSessionTrap: firstTrap,
    ...(second ? { secondSession: second } : {}),
    criterion1: {
      rule: CRITERION_1_RULE,
      metric: 'repeatErrorDrop',
      pass: criterion1,
      evaluable: drop.tasks > 0,
    },
    settings: { on: settingSummary(on), off: settingSummary(off) },
  }
}

type SystemReport = ReturnType<typeof systemReport>

const fmt = (value: number | null, digits = 3): string => (value === null ? 'n/a' : value.toFixed(digits))
const fmtDiff = (d: DiffJson): string =>
  `${fmt(d.estimate)} (95% CI ${fmt(d.ci95[0])} to ${fmt(d.ci95[1])}; ${d.tasks} tasks; ${d.excludedRuns} runs excluded for an undefined value)`

const fmtExcluded = (e: { on: Exclusion; off: Exclusion }): string =>
  `Excluded for an undefined value (no real first failure to repeat or avoid): on ${e.on.runs} of ${e.on.of} runs, ${e.on.tasks} tasks left without a value; off ${e.off.runs} of ${e.off.of} runs, ${e.off.tasks} tasks left without a value.`

const workflowReuseMarkdown = (w: NonNullable<SystemReport['workflowReuse']>): string[] => {
  const side = (name: string, s: typeof w.on): string[] => [
    `- ${name}: reuse rate ${fmt(s.reuseRate)} (${s.matchingCalls} of ${s.calls} second-session workflow calls); runs that reused at least once ${fmt(s.runRate)} (${s.reusedRuns} of ${s.runs - s.excluded.runs} counted runs); nothing saved in ${s.nothingSaved} runs; save refused by the host in ${s.saveRefused} runs; no workflow call in the second session in ${s.withoutCall} runs.`,
    `- ${name}, excluded because the first session never completed a workflow run: ${s.excluded.runs} of ${s.excluded.of} runs, ${s.excluded.tasks} tasks left without a value.`,
  ]
  return [
    '### 2c. Workflow reuse',
    '',
    `Direction: ${w.direction}`,
    '',
    ...side('On', w.on),
    ...side('Off', w.off),
    '',
  ]
}

const fmtMean = (value: number | null, measure: Measure): string =>
  value === null ? 'n/a' : measure === 'cost' ? value.toFixed(4) : value.toFixed(1)
const fmtMeasureDiff = (d: DiffJson, measure: Measure): string =>
  d.estimate === null
    ? 'n/a (no task has runs of both arms)'
    : `${fmtMean(d.estimate, measure)} (95% CI ${fmtMean(d.ci95[0], measure)} to ${fmtMean(d.ci95[1], measure)}; ${d.tasks} tasks)`

const secondSessionMarkdown = (s: NonNullable<SystemReport['secondSession']>): string[] => {
  const lines = [
    '### 4. Second-session cost and capture rate',
    '',
    `Direction: ${s.direction}`,
    '',
    `${s.tasks} two-session tasks; runs with a recorded second session: ${s.runs.off} off, ${s.runs.on} on, ${s.runs.oracle} oracle.`,
    '',
    '| measure | off | on | oracle | off minus on | off minus oracle | capture rate |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const name of SECOND_SESSION_MEASURES) {
    const m = s.measures[name]
    lines.push(
      `| ${name} | ${fmtMean(m.mean.off, name)} | ${fmtMean(m.mean.on, name)} | ${fmtMean(m.mean.oracle, name)} | ${fmtMeasureDiff(m.offMinusOn, name)} | ${fmtMeasureDiff(m.offMinusOracle, name)} | ${m.captureRate === null ? 'n/a' : m.captureRate.toFixed(3)} |`,
    )
  }
  lines.push('')
  for (const name of s.runs.oracle === 0 ? [] : SECOND_SESSION_MEASURES) {
    const m = s.measures[name]
    const list = (ids: string[]) => (ids.length === 0 ? 'none' : ids.join(', '))
    lines.push(
      `- ${name}: capture rate over ${m.included.length} tasks. No headroom (the hand-written lesson does not save: off minus oracle interval not above 0), counted and left out: ${m.noHeadroom.length} (${list(m.noHeadroom)}). Too few off or oracle runs to judge: ${m.tooFewRuns.length} (${list(m.tooFewRuns)}). Headroom but no refinement run: ${m.noOnRuns.length} (${list(m.noOnRuns)}).`,
    )
  }
  lines.push('')
  if (s.runs.oracle === 0)
    lines.push(
      'No oracle runs: the oracle column and the capture rate need runs with `--arms off,on,oracle`.',
      '',
    )
  if (s.lowerBoundRuns > 0)
    lines.push(
      `${s.lowerBoundRuns} runs have a second session whose child sessions (or an unpriced request) are not in its ledger, so their figures are lower bounds.`,
      '',
    )
  lines.push(
    'Refinement is run as the Prime runs are: one manual review after every prompt, so the on column costs more than real use would.',
    '',
  )
  return lines
}

const trapMarkdown = (t: SystemReport['firstSessionTrap']): string[] => {
  const cell = (c: TrapCell): string => (c.runs === 0 ? '-' : `${c.hit}/${c.runs}`)
  const hasOracle = t.byArm.oracle.runs > 0
  const lines = [
    '### First-session trap hits',
    '',
    "Runs whose first session hit the trap (a failed run of the task's tool with its signature), out of the runs of that task and arm. A run whose first session never hits it has nothing for refinement to repeat or avoid and is excluded from metrics 1 and 2. Workflow tasks are left out (their commands run in child sessions).",
    '',
    `- Rate: on ${cell(t.byArm.on)}, off ${cell(t.byArm.off)}${hasOracle ? `, oracle ${cell(t.byArm.oracle)}` : ''}`,
    `- Tasks whose first session never hit the trap in any run: ${t.noHit.length === 0 ? 'none' : `${t.noHit.length} (${t.noHit.join(', ')})`}`,
    '',
    `| task | on | off |${hasOracle ? ' oracle |' : ''}`,
    `| --- | --- | --- |${hasOracle ? ' --- |' : ''}`,
    ...t.tasks.map(
      (row) =>
        `| ${row.taskId} | ${cell(row.on)} | ${cell(row.off)} |${hasOracle ? ` ${cell(row.oracle)} |` : ''}`,
    ),
    '',
  ]
  return lines
}

const infraMarkdown = (x: NonNullable<InfraExcluded>): string[] => [
  `Runs the upstream ended, not the task (quota, credentials, rate limit, server error), left out of every metric below: on ${x.on}, off ${x.off}, oracle ${x.oracle}.${
    Object.keys(x.reasons).length === 0
      ? ''
      : ` Reasons: ${Object.entries(x.reasons)
          .map(([reason, n]) => `${reason} x${n}`)
          .join(', ')}.`
  } They are redone when the run is started again.`,
  '',
]

const systemMarkdown = (name: string, r: SystemReport, infra?: InfraExcluded): string[] => {
  const verdict = !r.criterion1.evaluable
    ? 'NOT EVALUABLE (no paired tasks)'
    : r.criterion1.pass
      ? 'PASS'
      : 'FAIL'
  const lines = [
    `## ${name}`,
    '',
    `${r.tasks} tasks; runs: ${r.runs.on} on, ${r.runs.off} off.`,
    '',
    ...(infra ? infraMarkdown(infra) : []),
    ...trapMarkdown(r.firstSessionTrap),
    '### 1. Repeat-error drop',
    '',
    `Direction: ${r.repeatErrorDrop.direction}`,
    '',
    `- Recurrence on: ${fmt(r.repeatErrorDrop.recurrenceOn)}; off: ${fmt(r.repeatErrorDrop.recurrenceOff)}`,
    `- Difference (off minus on): ${fmtDiff(r.repeatErrorDrop.difference)}`,
    `- ${fmtExcluded(r.repeatErrorDrop.excluded)}`,
    ...(r.repeatErrorDrop.workflowRunsLeftOut
      ? [
          `- Workflow runs left out of this metric: on ${r.repeatErrorDrop.workflowRunsLeftOut.on}, off ${r.repeatErrorDrop.workflowRunsLeftOut.off}. Their members run in child sessions whose commands are not recorded, so a trap hit is not defined for them; the pass criterion below does not include them.`,
        ]
      : []),
    '',
    '### 2. Cross-session reuse',
    '',
    `Direction: ${r.crossSessionReuse.direction}`,
    '',
    `- Avoided on: ${fmt(r.crossSessionReuse.avoidedOn)}; off: ${fmt(r.crossSessionReuse.avoidedOff)}`,
    `- Difference (on minus off): ${fmtDiff(r.crossSessionReuse.difference)}`,
    `- ${fmtExcluded(r.crossSessionReuse.excluded)}`,
    '',
    '### 2b. Cross-workspace reuse',
    '',
    `Direction: ${r.crossWorkspaceReuse.direction}`,
    '',
    `- Avoided on: ${fmt(r.crossWorkspaceReuse.avoidedOn)}; off: ${fmt(r.crossWorkspaceReuse.avoidedOff)}`,
    `- Difference (on minus off): ${fmtDiff(r.crossWorkspaceReuse.difference)}`,
    `- ${fmtExcluded(r.crossWorkspaceReuse.excluded)}`,
    ...(r.crossWorkspaceReuse.autoOnlyRuns > 0
      ? [
          `- Alignment: ${r.crossWorkspaceReuse.autoOnlyRuns} on runs are auto-only: no user-initiated user-level save was sent at the end of the first session (Prime sends /refine --global there), so only automatic promotion could carry anything to the second workspace. This difference is not trigger-aligned with Prime's.`,
        ]
      : []),
    '',
    ...(r.workflowReuse ? workflowReuseMarkdown(r.workflowReuse) : []),
    '### 3. Cost overhead',
    '',
    `Direction: ${r.costOverhead.direction}`,
    '',
    `- Tokens, mean per-task overhead: ${fmtDiff(r.costOverhead.tokens.relative)}; pooled ${fmt(r.costOverhead.tokens.pooled)}; ${r.costOverhead.tokens.skippedTasks} tasks skipped (no off baseline)`,
    `- Cost, mean per-task overhead: ${fmtDiff(r.costOverhead.costUsd.relative)}; pooled ${fmt(r.costOverhead.costUsd.pooled)}; ${r.costOverhead.costUsd.skippedTasks} tasks skipped (no off baseline)`,
    '',
    ...(r.secondSession ? secondSessionMarkdown(r.secondSession) : []),
    '### Pass criterion (1)',
    '',
    `Rule: ${r.criterion1.rule}.`,
    '',
    `Verdict: ${verdict}`,
    '',
    '### Run structure',
    '',
    '| | on | off |',
    '| --- | --- | --- |',
  ]
  const rows: [string, (s: SystemReport['settings']['on']) => string][] = [
    ['runs', (s) => String(s.runs)],
    ['completion (checks passed / prompts)', (s) => fmt(s.completion)],
    ['refine runs, auto', (s) => String(s.refine.auto)],
    ['refine runs, user', (s) => String(s.refine.user)],
    ['refine runs, self', (s) => String(s.refine.self)],
    ['applied edits', (s) => String(s.refine.appliedEdits)],
    ['harness lookups', (s) => String(s.harnessLookups)],
    ['compactions', (s) => String(s.compactions)],
    ['model requests', (s) => String(s.usage.requests)],
    ['requests with unknown usage', (s) => String(s.usage.unknownRequests)],
    ['tokens', (s) => String(s.usage.tokens)],
    ['cost (USD)', (s) => s.usage.costUsd.toFixed(4)],
    ['exit ok / error / timeout', (s) => `${s.exit.ok} / ${s.exit.error} / ${s.exit.timeout}`],
  ]
  for (const [label, get] of rows) lines.push(`| ${label} | ${get(r.settings.on)} | ${get(r.settings.off)} |`)
  lines.push('')
  if (r.settings.on.usage.unknownRequests + r.settings.off.usage.unknownRequests > 0) {
    lines.push(
      'Requests with unknown usage are counted, not priced; token and cost totals are lower bounds.',
      '',
    )
  }
  return lines
}

/** The runs of a system that the upstream ended, per arm, with the reasons; none when there are none. */
type InfraExcluded = { on: number; off: number; oracle: number; reasons: Record<string, number> } | undefined
const infraExcluded = (records: RunRecord[]): InfraExcluded => {
  const failed = records.filter((r) => r.infraFailed)
  if (failed.length === 0) return undefined
  const reasons: Record<string, number> = {}
  for (const r of failed)
    reasons[r.infraFailed?.reason ?? '?'] = (reasons[r.infraFailed?.reason ?? '?'] ?? 0) + 1
  return {
    on: bySetting(failed, 'on').length,
    off: bySetting(failed, 'off').length,
    oracle: bySetting(failed, 'oracle').length,
    reasons,
  }
}

const money = (value: number): string => String(value)

/** The report header lines for the run configuration: model, route, upstream (without credentials) and prices. */
const runMarkdown = (run: NonNullable<ReportOptions['run']>): string[] => {
  let upstream = run.upstream
  try {
    const url = new URL(run.upstream)
    upstream = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    /* not a URL: shown as given */
  }
  const p = run.prices
  return [
    `Run: model ${run.model} through route ${run.provider} (${run.api}) at ${upstream}.`,
    '',
    `Prices per million tokens, USD: input ${money(p.input)}, output ${money(p.output)}, cache read ${money(p.cacheRead)}, cache write ${money(p.cacheWrite)}.${run.pricesAssumed ? " ASSUMED: these prices are a stand-in, not the provider's price list, so every cost figure below is only as good as that assumption." : ''}`,
    '',
  ]
}

export const buildReport = (
  records: RunRecord[],
  options: ReportOptions = {},
): { json: object; markdown: string } => {
  const systems: Record<string, SystemReport> = {}
  const excluded: Record<string, NonNullable<InfraExcluded>> = {}
  for (const [system, all] of groupBy(records, (r) => r.system)) {
    // A run the upstream ended says nothing about the system under test: no metric sees it.
    systems[system] = systemReport(
      all.filter((r) => !r.infraFailed),
      options,
    )
    const infra = infraExcluded(all)
    if (infra) excluded[system] = infra
  }
  const run = options.run && {
    ...options.run,
    upstream: (() => {
      try {
        const url = new URL(options.run.upstream)
        return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
      } catch {
        return options.run.upstream
      }
    })(),
  }
  const json = {
    ...(run ? { run } : {}),
    directions: DIRECTIONS,
    criterion1Rule: CRITERION_1_RULE,
    ...(Object.keys(excluded).length === 0 ? {} : { infraExcluded: excluded }),
    systems,
  }
  const markdown = [
    '# Evaluation report',
    '',
    ...(options.run ? runMarkdown(options.run) : []),
    'Aggregate numbers only. Each metric states its own direction; they are not all "on minus off".',
    '',
    "A trap hit is a command run that failed with the task's signature (on stderr, or in the output of a run that exited non-zero). Reading the tool's source or docs never counts.",
    '',
    ...Object.entries(systems).flatMap(([name, report]) => systemMarkdown(name, report, excluded[name])),
  ].join('\n')
  return { json, markdown: `${markdown}\n` }
}

/**
 * A run that was redone after the upstream ended it has its model traffic under `<id>~a<N>` for the Nth
 * redo; the run's usage is that of its latest attempt, so the failed attempt's spend is not counted into the
 * run that replaced it.
 */
export const latestAttempts = (usage: Map<string, UsageSummary>): Map<string, UsageSummary> => {
  const latest = new Map<string, { n: number; summary: UsageSummary }>()
  for (const [key, summary] of usage) {
    const found = /^(.+)~a(\d+)$/.exec(key)
    if (!found) continue
    const base = found[1] as string
    const n = Number(found[2])
    if (n > (latest.get(base)?.n ?? 0)) latest.set(base, { n, summary })
  }
  const out = new Map(usage)
  for (const [base, { summary }] of latest) out.set(base, summary)
  return out
}

/**
 * Every run folder of `runDir` that has an outcome, as a record with the current metric rules. Reads
 * only: nothing is written to the folder. A session file path in an outcome that no longer exists (the
 * folder was moved) is looked up by file name under the run's own `sessions` folder.
 */
export const readRunRecords = (
  runDir: string,
  tasks: Map<string, EvalTask>,
  usage: Map<string, UsageSummary> = new Map(),
): RunRecord[] => {
  const records: RunRecord[] = []
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    const file = join(runDir, entry.name, 'outcome.json')
    if (!entry.isDirectory() || !existsSync(file)) continue
    const outcome = JSON.parse(readFileSync(file, 'utf8')) as RunOutcome
    const task = tasks.get(outcome.runId.replace(/\.(on|off|oracle)\.r\d+$/, ''))
    if (!task) throw new Error(`run ${outcome.runId} has no matching task in the suite`)
    const readFile = (path: string): string => {
      const candidates = [
        resolve(runDir, path),
        resolve(runDir, outcome.runId, path),
        resolve(runDir, outcome.runId, 'sessions', basename(path)),
      ]
      return readFileSync(candidates.find((p) => existsSync(p)) ?? (candidates[0] as string), 'utf8')
    }
    const savedSkills = join(runDir, entry.name, workspaceName(fixtureOf(task, 0)), AGH_DIR, 'skills')
    records.push(
      toRunRecord(task, outcome, latestAttempts(usage), {
        readFile,
        system: outcome.system ?? 'prime',
        readSavedSkills: () => readSkillTexts(savedSkills),
      }),
    )
  }
  return records
}

// ---- CLI ----

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const readUsageRows = (file: string): UsageRow[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as UsageRow)
    : []

const main = async (): Promise<void> => {
  const runDirArg = flag('--run-dir')
  const configArg = flag('--config')
  if (!runDirArg || !configArg)
    throw new Error('usage: report.ts --run-dir <out> --config <run-config.json> [--suite <dir>]')
  const runDir = resolve(runDirArg)
  const config = JSON.parse(readFileSync(resolve(configArg), 'utf8')) as RunConfig

  const { summarizeUsage } = await import('./usage-proxy.js')
  const { loadSuite, defaultTasksDir } = await import('./suite.js')
  // The report only looks tasks up by id; suite completeness is the runner's concern, so the floor is 1.
  const suiteDir = flag('--suite')
  const tasks = new Map(
    loadSuite(suiteDir ? resolve(suiteDir) : defaultTasksDir, { minTasks: 1 }).map((t) => [t.id, t]),
  )
  const usage = summarizeUsage(readUsageRows(join(runDir, 'usage.jsonl')), config.prices) as Map<
    string,
    UsageSummary
  >

  const records = readRunRecords(runDir, tasks, usage)

  const report = buildReport(records, { run: config })
  writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report.json, null, 2)}\n`)
  writeFileSync(join(runDir, 'report.md'), report.markdown)
  console.log(`wrote report.json and report.md for ${records.length} runs`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
