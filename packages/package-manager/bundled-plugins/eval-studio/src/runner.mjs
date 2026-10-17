import { createHash } from 'node:crypto'
import { runHeadless } from '@agnes/sdk'
import {
  bounded,
  COMPONENTS,
  canonical,
  dataset,
  datasetInputs,
  outputMatches,
  summarize,
} from './contract.mjs'
export const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex')
/** Caller supplies an explicitly authorized fixture-only SDK client; no discovery or home access.
 * openCase({case, signal, dataset}) -> {client,cwd,components,replay,seed,observe(),close()}.
 * observe returns {output,tools,effects}; components are the actual configured inputs, not labels.
 * The factory must enforce fixture-only tools, isolation, Loop/Skill pins and case budgets.
 */
export async function runEvaluation(raw, { variant, openCase, signal, judge }) {
  const d = dataset(raw)
  if (typeof variant !== 'string' || !variant || variant.length > 128) throw new Error('E_EVAL_VARIANT')
  const cases = []
  let cancelled = signal?.aborted ?? false
  for (const c of d.cases) {
    if (signal?.aborted) {
      cancelled = true
      break
    }
    const timer = AbortSignal.timeout(d.budget.wallMs)
    const caseSignal = AbortSignal.any([timer, ...(signal ? [signal] : [])])
    const started = performance.now()
    let env,
      tokens = null,
      observed = { output: '', tools: [], effects: [] },
      executed = 0
    const checks = { structure: 'fail', effects: 'fail', budget: 'unknown' }
    let judgment = { status: 'skipped', tokens: null, cost: null }
    let failure
    try {
      env = await openCase({ case: c, signal: caseSignal, dataset: d })
      caseSignal.throwIfAborted()
      if (
        env.effectPolicy !== 'fixture-only' ||
        env.replay !== d.replay ||
        env.seed !== d.seed ||
        !COMPONENTS.every((k) => digest(env.components[k]) === d.hashes[k])
      )
        throw new Error('E_EVAL_BINDING')
      const metrics = []
      const client = {
        async createSession(options) {
          const session = await env.client.createSession(options)
          return new Proxy(session, {
            get(target, key) {
              if (key === 'prompt')
                return (...args) => {
                  executed = 1
                  return target.prompt(...args)
                }
              const value = Reflect.get(target, key)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        },
      }
      const result = await runHeadless(client, {
        cwd: env.cwd,
        input: c.input,
        signal: caseSignal,
        drainMs: env.drainMs ?? Math.min(1000, d.budget.wallMs),
        write(record) {
          if (record.type === 'turn-metrics') metrics.push(record.metrics)
        },
      })
      const snapshot = bounded(await env.observe())
      observed = { output: snapshot.output, tools: snapshot.tools, effects: snapshot.effects }
      if (
        typeof observed.output !== 'string' ||
        !Array.isArray(observed.tools) ||
        !Array.isArray(observed.effects)
      )
        throw new Error('E_EVAL_OBSERVATION')
      tokens =
        metrics.length && metrics.every((m) => m.tokens !== null)
          ? metrics.reduce((n, m) => n + m.tokens.input + m.tokens.output, 0)
          : null
      checks.structure =
        result.eventsComplete &&
        result.reason === 'completed' &&
        !result.error &&
        outputMatches(observed.output, c.expected.output) &&
        c.expected.requiredTools.every((t) => observed.tools.includes(t))
          ? 'pass'
          : 'fail'
      checks.effects =
        observed.tools.every((t) => c.expected.allowedTools.includes(t)) &&
        canonical(observed.effects) === canonical(c.expected.effects)
          ? 'pass'
          : 'fail'
      checks.budget = caseSignal.aborted
        ? 'fail'
        : d.budget.tokens === null
          ? 'pass'
          : tokens === null
            ? 'unknown'
            : tokens <= d.budget.tokens
              ? 'pass'
              : 'fail'
      if (judge) {
        // Judge is an explicit independent call, never hidden in case-model usage.
        judgment = { status: 'unknown', tokens: null, cost: null }
        const value = bounded(await judge({ case: c, observation: observed, signal: caseSignal }))
        if (
          !['pass', 'fail', 'unknown'].includes(value.status) ||
          !(value.tokens === null || (Number.isSafeInteger(value.tokens) && value.tokens >= 0)) ||
          !(value.cost === null || (Number.isFinite(value.cost) && value.cost >= 0))
        )
          throw new Error('E_EVAL_JUDGE')
        judgment = value
      }
      caseSignal.throwIfAborted()
    } catch (error) {
      // Do not persist arbitrary adapter exceptions: they may contain private paths/requests.
      failure =
        error?.message === 'E_EVAL_BINDING'
          ? 'E_EVAL_BINDING'
          : caseSignal.aborted
            ? 'E_EVAL_CANCELLED'
            : 'E_EVAL_RUN'
      checks.structure = 'fail'
      if (caseSignal.aborted) checks.budget = 'fail'
    } finally {
      try {
        await env?.close()
      } catch {
        failure = 'E_EVAL_CLEANUP'
        checks.structure = 'fail'
      }
      if (caseSignal.aborted) checks.budget = 'fail'
    }
    cases.push({
      id: c.id,
      executed,
      checks,
      judge: judgment,
      tokens,
      cost: null,
      durationMs: Math.ceil(performance.now() - started),
      ...observed,
      ...(failure ? { error: failure } : {}),
    })
    if (signal?.aborted) {
      cancelled = true
      break
    }
  }
  // Keep a zero execution record for every case left unscheduled by cancellation.
  for (const c of d.cases) {
    if (cases.some((row) => row.id === c.id)) continue
    cases.push({
      id: c.id,
      executed: 0,
      checks: { structure: 'unknown', effects: 'unknown', budget: 'unknown' },
      judge: { status: 'skipped', tokens: null, cost: null },
      tokens: null,
      cost: null,
      durationMs: null,
      output: '',
      tools: [],
      effects: [],
      error: 'E_EVAL_NOT_RUN',
    })
  }
  return bounded({
    schemaVersion: 1,
    kind: 'agnes.eval',
    variant,
    dataset: d,
    datasetHash: digest(datasetInputs(d)),
    bindingHash: digest(d),
    cancelled,
    cases,
    ...summarize(d, cases, cancelled),
    evidence: 'runner-observed',
  })
}
