import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const root = new URL('../../bundled-plugins/eval-studio/', import.meta.url)
const runner = await import(new URL('src/runner.mjs', root).href)
const contract = await import(new URL('src/contract.mjs', root).href)
const offline = await import(new URL('src/offline.mjs', root).href)
const run = async (variant = 'baseline', extra: Record<string, unknown> = {}) => {
  const fixture = offline.syntheticDataset(variant)
  return runner.runEvaluation(fixture.dataset, {
    variant,
    openCase: offline.offlineFactory({ components: fixture.components, ...extra }),
  })
}
it('runs the SDK against scripted fixtures and distinguishes structure, steps, refused effects and unknown usage', async () => {
  const baseline = await run()
  expect(baseline).toMatchObject({
    status: 'pass',
    executed: 1,
    total: 1,
    cases: [{ executed: 1, tokens: 5, checks: { structure: 'pass', effects: 'pass', budget: 'pass' } }],
  })
  for (const variant of ['missing-step', 'wrong-output', 'unauthorized']) {
    const candidate = await run(variant)
    expect(candidate).toMatchObject({ status: 'fail', executed: 1 })
    expect(contract.compare(baseline, candidate).differences).toHaveLength(1)
    if (variant === 'unauthorized')
      expect(candidate.cases[0]).toMatchObject({ effects: [], checks: { effects: 'fail' } })
  }
  expect(await run('baseline', { omitUsage: true })).toMatchObject({
    status: 'fail',
    cases: [{ tokens: null, checks: { budget: 'unknown' } }],
  })
  const structured = offline.syntheticDataset()
  structured.components.model.reply.output = '{"count":1,"status":"ready"}'
  structured.dataset.hashes.model = runner.digest(structured.components.model)
  structured.dataset.cases[0].expected.output = { json: { status: 'ready', count: 1 } }
  const structuredResult = await runner.runEvaluation(structured.dataset, {
    variant: 'json',
    openCase: offline.offlineFactory({ components: structured.components }),
  })
  expect(structuredResult.status).toBe('pass')
  expect(contract.outputMatches('{"status":null}', { json: { status: 'ready' } })).toBe(false)
  expect(contract.report({ ...baseline, passed: 500 })).toMatchObject({
    passed: 1,
    evidence: 'imported-unverified',
  })
})
it('fails empty datasets, rejects mismatched bindings before prompt, stops scheduling on cancel and separates explicit judge cost', async () => {
  const { dataset, components } = offline.syntheticDataset()
  const empty = await runner.runEvaluation(
    { ...dataset, cases: [] },
    {
      variant: 'empty',
      openCase: () => {
        throw new Error('must not run')
      },
    },
  )
  expect(empty).toMatchObject({ status: 'fail', executed: 0 })
  const mismatch = await runner.runEvaluation(dataset, {
    variant: 'mismatch',
    openCase: offline.offlineFactory({ components: { ...components, pins: ['tampered'] } }),
  })
  expect(mismatch).toMatchObject({ executed: 0, cases: [{ error: 'E_EVAL_BINDING' }] })
  const controller = new AbortController()
  let opened = 0,
    closed = 0
  const open = offline.offlineFactory({ components })
  const cancelOpen = offline.offlineFactory({ components, onRequest: () => controller.abort() })
  const cancelled = await runner.runEvaluation(
    { ...dataset, cases: [...dataset.cases, { ...dataset.cases[0], id: 'second' }] },
    {
      variant: 'cancel',
      signal: controller.signal,
      async openCase(args: unknown) {
        opened++
        const env = await cancelOpen(args)
        const close = env.close
        env.close = async () => {
          closed++
          await close()
        }
        return env
      },
    },
  )
  expect({
    opened,
    closed,
    cancelled: cancelled.cancelled,
    executed: cancelled.executed,
    status: cancelled.status,
  }).toEqual({ opened: 1, closed: 1, cancelled: true, executed: 1, status: 'fail' })
  expect(cancelled.cases[0].error).toBe('E_EVAL_CANCELLED')
  expect(cancelled.cases[1]).toMatchObject({ executed: 0, error: 'E_EVAL_NOT_RUN', tokens: null })
  const limited = await runner.runEvaluation(
    { ...dataset, budget: { ...dataset.budget, tokens: 1 } },
    { variant: 'limited', openCase: open },
  )
  expect(limited.cases[0].checks.budget).toBe('fail')
  const failedJudge = await runner.runEvaluation(dataset, {
    variant: 'judge-failed',
    openCase: open,
    judge: async () => {
      throw new Error('private trace must not persist')
    },
  })
  expect(failedJudge).toMatchObject({
    status: 'fail',
    cases: [{ error: 'E_EVAL_RUN', judge: { status: 'unknown', cost: null } }],
  })
  expect(JSON.stringify(failedJudge)).not.toContain('private trace')
  const judged = await runner.runEvaluation(dataset, {
    variant: 'judge',
    openCase: open,
    judge: async () => ({ status: 'pass', tokens: 8, cost: 0.02 }),
  })
  expect(judged.cases[0]).toMatchObject({ tokens: 5, judge: { tokens: 8, cost: 0.02, status: 'pass' } })
  expect(contract.compare(await run(), judged)).toMatchObject({ kind: 'agnes.eval.comparison' })
  expect(() => contract.compare(awaitInvalid(), judged)).toThrow()
  function awaitInvalid() {
    return { ...judged, dataset: { ...dataset, cases: [] } }
  }
})
it('uses the public replay adapter for strict mismatch refusal and explicit sequence replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agh-eval-trace-'))
  try {
    let request: unknown
    await run('baseline', {
      onRequest: (value: unknown) => {
        request = value
      },
    })
    const traceFile = join(dir, 'trace.jsonl')
    const events = [
      { type: 'text_delta', delta: JSON.stringify(offline.replyFor('baseline')) },
      {
        type: 'usage',
        tokens: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
      },
      { type: 'done', reason: 'stop' },
    ]
    const transcript = {
      schemaVersion: 1,
      sessionKey: 'synthetic',
      index: 0,
      request,
      events,
      complete: true,
    }
    await writeFile(traceFile, JSON.stringify(transcript), { mode: 0o600 })
    for (const mode of ['strict', 'sequence']) {
      const { dataset, components } = offline.syntheticDataset('baseline', mode, [transcript])
      const good = await runner.runEvaluation(dataset, {
        variant: mode,
        openCase: offline.offlineFactory({ components, replay: mode, traceFile }),
      })
      expect(good.status).toBe('pass')
      const changed = { ...dataset, cases: [{ ...dataset.cases[0], input: 'Different input' }] }
      const result = await runner.runEvaluation(changed, {
        variant: mode,
        openCase: offline.offlineFactory({ components, replay: mode, traceFile }),
      })
      expect(result.status).toBe(mode === 'strict' ? 'fail' : 'pass')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('accepts bounded imported data, refuses malformed/forged totals and publishes only through the session artifact port', async () => {
  const { main } = await import(new URL('index.mjs', root).href)
  let tool: import('@agnes/extension-api').ToolDef | undefined
  main.apply({
    tools: {
      register(value: import('@agnes/extension-api').ToolDef) {
        tool = value
      },
    },
  })
  if (!tool) throw new Error('Tool missing')
  const baseline = await run()
  let saved = ''
  const context = {
    signal: new AbortController().signal,
    artifacts: {
      async put(bytes: Uint8Array) {
        saved = new TextDecoder().decode(bytes)
        return { sha256: 'a'.repeat(64), size: bytes.length, mime: 'application/json' }
      },
    },
  }
  const result = await tool.execute(
    { kind: 'report', json: JSON.stringify({ ...baseline, status: 'pass', executed: 999 }) },
    context as never,
  )
  expect(result.isError).toBeUndefined()
  expect(JSON.parse(saved)).toMatchObject({ executed: 1, evidence: 'imported-unverified' })
  expect(await tool.execute({ kind: 'report', json: '{}' }, context as never)).toMatchObject({
    isError: true,
  })
  expect(() => contract.dataset('x'.repeat(1048577))).toThrow('E_EVAL_SIZE')
  expect(() =>
    contract.dataset({ ...baseline.dataset, cases: [...baseline.dataset.cases, ...baseline.dataset.cases] }),
  ).toThrow('E_EVAL_SCHEMA')
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  expect(pkg.name).toBe('@agnes/eval-studio')
})
