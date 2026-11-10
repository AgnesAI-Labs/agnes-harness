// Aggregate report over evaluation runs. Output holds only aggregate numbers and structure fields:
// no message bodies, tool output, prompt text or absolute paths.
//
// Usage: pnpm exec tsx tools/rsi-eval/report.ts --run-dir <out> --config <run-config.json> [--suite <dir>] [--headroom-dir <pilot out>]
// --headroom-dir: the folder of a pilot (off and oracle runs) that decides which tasks have headroom for the
// capture rate. It must not hold runs of the run being reported.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGH_DIR } from '../../packages/protocol/src/constants.js'
import { type BlockedExcluded, blockedExcluded, blockedMarkdown } from './blocked.js'
import { type CaptureResult, captureMetric } from './capture.js'
import { type InfraExcluded, infraExcluded, infraMarkdown } from './infra.js'
import { longMarkdown, longSections } from './long-report.js'
import {
  laterSessionsCost,
  runMetrics,
  toRunRecord,
  type UsageSummary,
  workflowReuseMetric,
} from './metrics.js'
import { type Diff, pairedTaskBootstrap } from './stats.js'
import { fixtureOf, workspaceName } from './suite.js'
import { firstSessionTrapReport, trapMarkdown } from './trap-report.js'
import type { Arm, EvalTask, RunConfig, RunOutcome, RunRecord, SessionCost, UsageRow } from './types.js'
import { readSkillTexts } from './workflow-reuse.js'

export type ReportOptions = {
  resamples?: number
  seed?: number
  /**
   * A pilot's runs (`--headroom-dir`): their `off` and `oracle` second sessions decide which tasks have
   * headroom, so that the runs the capture rate sums are not the runs it was selected on.
   */
  headroomRecords?: RunRecord[]
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
    "What the sessions after the first cost together (the second session of a two-session task; sessions 2 to N of a long task of N sessions) in model requests, tokens and dollars (every lane of their ledgers, the review calls included), per arm: off, on, and oracle (off plus the task's own lesson written to memory before the second session). Differences are off minus the other arm, so positive means the other arm is cheaper. Capture rate = sum of (off minus on) over sum of (off minus oracle), over the tasks whose off-minus-oracle 95% interval lies above 0; the others are counted as no headroom. Single-session and workflow tasks do not enter.",
} as const

const CRITERION_1_RULE =
  'capture rate of requests after the first session (off minus on over off minus oracle) is above 0 and its 95% interval excludes 0'
/** The rule before the capture rate, still computed and shown next to it, for comparison only. */
const PREVIOUS_CRITERION_1_RULE =
  'repeat-error difference (off minus on) is above 0 and its 95% interval excludes 0'

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
  numerator: r.capture.numerator,
  denominator: r.capture.denominator,
  captureCi95: r.capture.ci95,
  validResamples: r.capture.validResamples,
  resamples: r.capture.resamples,
  headroomSource: r.capture.headroomSource,
  includedMeans: r.capture.includedMeans,
  included: r.capture.included,
  noHeadroom: r.capture.noHeadroom,
  tooFewRuns: r.capture.tooFewRuns,
  noOnRuns: r.capture.noOnRuns,
})

/** The cost measures of a second session: all lanes, and the session's own work without the review calls. */
const SECOND_SESSION_MEASURES = [
  'requests',
  'tokens',
  'cost',
  'requestsMain',
  'tokensMain',
  'costMain',
] as const
type Measure = (typeof SECOND_SESSION_MEASURES)[number]
const baseOf = (measure: Measure): 'requests' | 'tokens' | 'cost' =>
  measure.replace(/Main$/, '') as 'requests' | 'tokens' | 'cost'
const pickMeasure = (measure: Measure, c: SessionCost): number =>
  measure.endsWith('Main') ? c[baseOf(measure)] - c.refinement[baseOf(measure)] : c[baseOf(measure)]

/** Why a run's second session is not counted into the second-session means; none means it is. */
const LEFT_OUT_REASONS = ['never-reached', 'timeout', 'exit-error', 'checks-failed'] as const
type LeftOut = (typeof LEFT_OUT_REASONS)[number]
const LEFT_OUT_TEXT: Record<LeftOut, string> = {
  'never-reached': 'the run never reached a session after the first',
  timeout: 'the run timed out',
  'exit-error': 'a session ended without completing',
  'checks-failed': 'a check of a session after the first failed, or one was not reached',
}

/**
 * Only a second session that ran to its end and passed its checks says what completing the task costs: one
 * that stopped early looks cheap, one that timed out looks dear.
 */
const secondSessionStatus = (record: RunRecord): LeftOut | undefined => {
  if (!laterSessionsCost(record)) return 'never-reached'
  if (record.exit === 'timeout') return 'timeout'
  if (record.exit !== 'ok') return 'exit-error'
  const later = record.windows.filter((w) => w.session >= 1)
  if (later.length === 0 || later.some((w) => !w.ran || w.checksPassed !== true)) return 'checks-failed'
  return undefined
}

/**
 * The second session of the two-session tasks, per arm, and the capture rate. Single-session tasks have no
 * second session and workflow tasks no oracle arm: neither enters. Only second sessions that completed and
 * passed their checks enter the means and the rate; the others are counted per arm and reason.
 * `options.headroomRecords` (a pilot's runs) decide which tasks have headroom, when given.
 */
const secondSessionReport = (records: RunRecord[], options: ReportOptions) => {
  const eligible = records.filter((r) => r.category !== 'workflow' && r.sessionCosts !== undefined)
  const withSecond = eligible.filter((r) => laterSessionsCost(r) !== undefined || r.exit !== 'ok')
  if (!eligible.some((r) => laterSessionsCost(r) !== undefined)) return undefined
  const counted = withSecond.filter((r) => secondSessionStatus(r) === undefined)
  const arms: Arm[] = ['off', 'on', 'oracle']
  const leftOut = Object.fromEntries(
    arms.map((arm) => [
      arm,
      Object.fromEntries(
        LEFT_OUT_REASONS.map((reason) => [
          reason,
          withSecond.filter((r) => r.setting === arm && secondSessionStatus(r) === reason).length,
        ]),
      ),
    ]),
  ) as Record<Arm, Record<LeftOut, number>>
  const headroomRuns = (options.headroomRecords ?? []).filter(
    (r) =>
      !r.infraFailed &&
      r.category !== 'workflow' &&
      (r.setting === 'off' || r.setting === 'oracle') &&
      laterSessionsCost(r) !== undefined &&
      secondSessionStatus(r) === undefined,
  )
  const separate = options.headroomRecords !== undefined
  const byTask = groupBy(counted, (r) => r.taskId)
  const taskIds = [...new Set(withSecond.map((r) => r.taskId))].sort()
  const measure = (name: Measure): CaptureResult =>
    captureMetric(
      taskIds.map((taskId) => {
        const list = byTask.get(taskId) ?? []
        const values = (arm: Arm) =>
          list
            .filter((r) => r.setting === arm)
            .map((r) => pickMeasure(name, laterSessionsCost(r) as SessionCost))
        const pilot = (arm: Arm) =>
          headroomRuns
            .filter((r) => r.taskId === taskId && r.setting === arm)
            .map((r) => pickMeasure(name, laterSessionsCost(r) as SessionCost))
        return {
          taskId,
          off: values('off'),
          on: values('on'),
          oracle: values('oracle'),
          ...(separate ? { headroom: { off: pilot('off'), oracle: pilot('oracle') } } : {}),
        }
      }),
      options,
    )
  const measures = Object.fromEntries(
    SECOND_SESSION_MEASURES.map((name) => [name, secondSessionMeasure(measure(name))]),
  ) as Record<Measure, ReturnType<typeof secondSessionMeasure>>
  const onRuns = counted.filter((r) => r.setting === 'on')
  const perRun = (pick: (c: SessionCost) => number): number | null =>
    onRuns.length === 0
      ? null
      : onRuns.reduce((sum, r) => sum + pick(laterSessionsCost(r) as SessionCost), 0) / onRuns.length
  return {
    direction: DIRECTIONS.secondSession,
    tasks: taskIds.length,
    runs: Object.fromEntries(
      arms.map((arm) => [arm, counted.filter((r) => r.setting === arm).length]),
    ) as Record<Arm, number>,
    leftOut,
    lowerBoundRuns: counted.filter((r) => laterSessionsCost(r)?.lowerBound).length,
    headroomRuns: separate ? headroomRuns.length : null,
    reviewOverhead: {
      runs: onRuns.length,
      requests: perRun((c) => c.refinement.requests),
      tokens: perRun((c) => c.refinement.tokens),
      cost: perRun((c) => c.refinement.cost),
    },
    measures,
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

  const previous = drop.tasks > 0 && drop.estimate > 0 && drop.ci95[0] > 0
  const rate = second?.measures.requests
  const rateCi = rate?.captureCi95 ?? null
  const evaluable = rate !== undefined && rate.captureRate !== null && rateCi !== null
  const criterion1 = evaluable && (rate.captureRate as number) > 0 && (rateCi as [number, number])[0] > 0

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
      metric: 'secondSession.requests.captureRate',
      pass: criterion1,
      evaluable,
    },
    previousCriterion1: {
      rule: PREVIOUS_CRITERION_1_RULE,
      metric: 'repeatErrorDrop',
      pass: previous,
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
  value === null ? 'n/a' : baseOf(measure) === 'cost' ? value.toFixed(4) : value.toFixed(1)
const fmtMeasureDiff = (d: DiffJson, measure: Measure): string =>
  d.estimate === null
    ? 'n/a (no task has runs of both arms)'
    : `${fmtMean(d.estimate, measure)} (95% CI ${fmtMean(d.ci95[0], measure)} to ${fmtMean(d.ci95[1], measure)}; ${d.tasks} tasks)`

const MEASURE_LABEL: Record<Measure, string> = {
  requests: 'requests, all lanes',
  tokens: 'tokens, all lanes',
  cost: 'cost (USD), all lanes',
  requestsMain: 'requests, session work only',
  tokensMain: 'tokens, session work only',
  costMain: 'cost (USD), session work only',
}

const fmtCapture = (m: ReturnType<typeof secondSessionMeasure>, measure: Measure): string => {
  if (m.captureRate === null) return 'n/a'
  const interval =
    m.captureCi95 === null
      ? 'no interval (too few resamples had a task with headroom)'
      : `95% CI ${m.captureCi95[0].toFixed(2)} to ${m.captureCi95[1].toFixed(2)}`
  return `${m.captureRate.toFixed(3)} = ${fmtMean(m.numerator, measure)} / ${fmtMean(m.denominator, measure)} over ${m.included.length} of ${m.included.length + m.noHeadroom.length + m.tooFewRuns.length + m.noOnRuns.length} tasks; ${interval}`
}

const secondSessionMarkdown = (s: NonNullable<SystemReport['secondSession']>): string[] => {
  const list = (ids: string[]) => (ids.length === 0 ? 'none' : ids.join(', '))
  const lines = [
    '### 4. Cost after the first session and capture rate',
    '',
    `Direction: ${s.direction}`,
    '',
    `${s.tasks} two-session tasks. Second sessions counted (completed, checks passed): ${s.runs.off} off, ${s.runs.on} on, ${s.runs.oracle} oracle.`,
    '',
    '| measure | off | on | oracle | off minus on | off minus oracle | capture rate |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const name of SECOND_SESSION_MEASURES) {
    const m = s.measures[name]
    lines.push(
      `| ${MEASURE_LABEL[name]} | ${fmtMean(m.mean.off, name)} | ${fmtMean(m.mean.on, name)} | ${fmtMean(m.mean.oracle, name)} | ${fmtMeasureDiff(m.offMinusOn, name)} | ${fmtMeasureDiff(m.offMinusOracle, name)} | ${fmtCapture(m, name)} |`,
    )
  }
  if (s.runs.oracle > 0) {
    lines.push(
      '',
      'The columns off, on and oracle are means over every task that has runs of that arm; off minus on and off minus oracle are over the tasks that have both. The capture rate is over the tasks with headroom only (below), so its columns differ:',
      '',
    )
    for (const name of SECOND_SESSION_MEASURES) {
      const m = s.measures[name]
      lines.push(
        `- ${MEASURE_LABEL[name]}, over the ${m.included.length} tasks of the capture rate: off ${fmtMean(m.includedMeans.off, name)}, on ${fmtMean(m.includedMeans.on, name)}, oracle ${fmtMean(m.includedMeans.oracle, name)}.`,
      )
    }
  }
  lines.push('')
  if (s.runs.oracle === 0) {
    lines.push(
      'No oracle runs: the oracle column and the capture rate need runs with `--arms off,on,oracle`.',
      '',
    )
  } else {
    const m = s.measures.requests
    lines.push(
      m.headroomSource === 'separate'
        ? `Headroom (whether the hand-written lesson saves anything for a task) was decided on separate runs: ${s.headroomRuns} off and oracle second sessions of a pilot. The sums above use this run's own off, on and oracle runs.`
        : 'Headroom and the rate use the SAME off runs: a task passes the headroom test more easily when its off runs happened to be expensive, and the same expensive runs then raise off minus on. With a small headroom the rate is therefore optimistic. Give the report a separate pilot (`--headroom-dir`) to decide headroom on other runs.',
      '',
      `Tasks without headroom (off minus oracle interval not above 0), counted and left out of the rate, for requests, all lanes: ${m.noHeadroom.length} (${list(m.noHeadroom)}). Too few off or oracle runs to decide: ${m.tooFewRuns.length} (${list(m.tooFewRuns)}). Headroom but no refinement run: ${m.noOnRuns.length} (${list(m.noOnRuns)}). The lists for the other measures can differ.`,
      '',
      `The interval of the rate resamples tasks and the runs within each arm and decides headroom again in every resample (${m.validResamples} of ${m.resamples} resamples had a task with headroom). With three runs per arm it is wide.`,
      '',
    )
  }
  const out = (['off', 'on', 'oracle'] as const).map(
    (arm) =>
      `${arm}: ${LEFT_OUT_REASONS.map((reason) => `${s.leftOut[arm][reason]} ${LEFT_OUT_TEXT[reason]}`).join(', ')}`,
  )
  lines.push(
    `Runs whose second session is left out of the means and the rate, per arm: ${out.join('; ')}.`,
    '',
  )
  const o = s.reviewOverhead
  if (o.runs > 0)
    lines.push(
      `Review calls of the on arm in the second session (refinement lane, included in the all-lanes rows and left out of the session-work rows): ${fmtMean(o.requests, 'requests')} requests, ${fmtMean(o.tokens, 'tokens')} tokens and ${fmtMean(o.cost, 'cost')} USD per run, over ${o.runs} runs. Refinement is run as the Prime runs are, one manual review after every prompt, so this is more than real use would cost; compare the session-work rows for the effect of the saved lesson alone.`,
      '',
    )
  if (s.lowerBoundRuns > 0)
    lines.push(
      `${s.lowerBoundRuns} runs have a second session whose child sessions (or an unpriced request) are not in its ledger, so their figures are lower bounds.`,
      '',
    )
  return lines
}

const systemMarkdown = (
  name: string,
  r: SystemReport,
  infra?: InfraExcluded,
  blocked?: BlockedExcluded,
): string[] => {
  const verdictOf = (c: SystemReport['criterion1'], none: string) =>
    !c.evaluable ? `NOT EVALUABLE (${none})` : c.pass ? 'PASS' : 'FAIL'
  const verdict = verdictOf(r.criterion1, 'no capture rate with an interval')
  const lines = [
    `## ${name}`,
    '',
    `${r.tasks} tasks; runs: ${r.runs.on} on, ${r.runs.off} off.`,
    '',
    ...(infra ? infraMarkdown(infra) : []),
    ...(blocked ? blockedMarkdown(blocked) : []),
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
    `Old rule, for comparison only: ${r.previousCriterion1.rule}. Verdict under it: ${verdictOf(r.previousCriterion1, 'no paired tasks')}.`,
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

/** The report header line for runs whose on arm was left to refinement's own triggers. */
export const TRIGGERS_HEADER =
  "Some on runs were driven by refinement's own triggers only (`--on-protocol triggers`): they sent no manual review and none of the end-of-session saves, neither the workflow task's save to the workspace nor the cross-workspace task's save to user memory. What reached their second session came from automatic saves alone, so their workflow reuse and cross-workspace results are not comparable with runs that sent those saves."

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
  const systems: Record<string, SystemReport & ReturnType<typeof longSections>> = {}
  const excluded: Record<string, NonNullable<InfraExcluded>> = {}
  const blockedRuns: Record<string, NonNullable<BlockedExcluded>> = {}
  for (const [system, all] of groupBy(records, (r) => r.system)) {
    // A run the upstream ended says nothing about the system under test: no metric sees it. A capped run
    // is a result, but not one a mean can hold: it is listed apart and enters only the milestone curves.
    // A run the host's verifier blocked was stopped by the harness, not its task: no metric sees it either.
    const counted = all.filter((r) => !r.infraFailed && !r.blocked)
    systems[system] = {
      ...systemReport(
        counted.filter((r) => !r.capped),
        options,
      ),
      ...longSections(counted, options),
    }
    const infra = infraExcluded(all)
    if (infra) excluded[system] = infra
    const blocked = blockedExcluded(all)
    if (blocked) blockedRuns[system] = blocked
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
    previousCriterion1Rule: PREVIOUS_CRITERION_1_RULE,
    ...(Object.keys(excluded).length === 0 ? {} : { infraExcluded: excluded }),
    ...(Object.keys(blockedRuns).length === 0 ? {} : { blockedExcluded: blockedRuns }),
    systems,
  }
  const markdown = [
    '# Evaluation report',
    '',
    ...(options.run ? runMarkdown(options.run) : []),
    ...(records.some((r) => r.setting === 'on' && r.onProtocol === 'triggers') ? [TRIGGERS_HEADER, ''] : []),
    'Aggregate numbers only. Each metric states its own direction; they are not all "on minus off".',
    '',
    "A trap hit is a command run that failed with the task's signature (on stderr, or in the output of a run that exited non-zero). Reading the tool's source or docs never counts.",
    '',
    ...Object.entries(systems).flatMap(([name, report]) => [
      ...systemMarkdown(name, report, excluded[name], blockedRuns[name]),
      ...longMarkdown(report),
    ]),
  ].join('\n')
  return { json, markdown: `${markdown}\n` }
}

/**
 * The runs that decide headroom must not be runs of the report itself: a pilot's runs copied into the full
 * run's folder would be the same runs doing both. Two records with the same id and the same start time are
 * the same run.
 */
export const assertSeparateRuns = (records: RunRecord[], pilot: RunRecord[]): void => {
  const started = new Map(records.map((r) => [`${r.taskId}.${r.setting}.r${r.rep}`, r.startedAt]))
  for (const r of pilot) {
    const id = `${r.taskId}.${r.setting}.r${r.rep}`
    if (r.startedAt !== undefined && started.get(id) === r.startedAt)
      throw new Error(
        `run ${id} is in both the report's folder and the headroom folder (same start time): the headroom runs must not be reused in the run they decide for`,
      )
  }
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
    const task = tasks.get(outcome.runId.replace(/\.(on|off|oracle|frozen)\.r\d+$/, ''))
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
    throw new Error(
      'usage: report.ts --run-dir <out> --config <run-config.json> [--suite <dir>] [--headroom-dir <pilot out>]',
    )
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

  const headroomDirArg = flag('--headroom-dir')
  let headroomRecords: RunRecord[] | undefined
  if (headroomDirArg) {
    const headroomDir = resolve(headroomDirArg)
    if (headroomDir === runDir) throw new Error('--headroom-dir must be another folder than --run-dir')
    headroomRecords = readRunRecords(headroomDir, tasks)
    assertSeparateRuns(records, headroomRecords)
  }
  const report = buildReport(records, { run: config, ...(headroomRecords ? { headroomRecords } : {}) })
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
