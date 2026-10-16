import { describe, expect, it } from 'vitest'
import { BatchEngine, Repository } from '../src/index.js'
import { FakeExecutor, id, inputs, reference, spec, testStore } from './fakes.js'

const harness = () => {
  const store = testStore(),
    executor = new FakeExecutor(),
    repo = new Repository(store)
  let now = 1000
  return {
    store,
    repo,
    executor,
    engine: new BatchEngine(repo, executor, () => now),
    advance: () => {
      now += 2000
    },
  }
}
describe('durable batch business state', () => {
  it('binds two inputs to distinct children, refuses cross-item and frame reads, and resumes without duplicate work', async () => {
    const h = harness()
    await h.engine.begin(id, spec, inputs)
    expect(await h.engine.tick(id)).toMatchObject({
      status: 'completed',
      successes: 2,
      spent: 0.5,
      reserved: 0,
    })
    const [first, second] = [...h.executor.receipts.values()]
    const a = [...h.executor.requests.values()][0]!
    expect(h.executor.read(first!.key, first!, a.input.artifact!)).toBe('a.txt')
    expect(() => h.executor.read(first!.key, second!, a.input.artifact!)).toThrow('E_INPUT_DENIED')
    expect(() => h.executor.read(first!.key, first!, inputs[1]!.artifact)).toThrow('E_INPUT_DENIED')
    expect(() => h.executor.read(first!.key, { ...first!, frame: 'forged' }, a.input.artifact!)).toThrow(
      'E_INPUT_DENIED',
    )
    await new BatchEngine(new Repository(h.store), h.executor).resume(id)
    expect(h.executor.executions).toBe(2)
    await expect(h.engine.begin(id, spec, inputs)).resolves.toMatchObject({ status: 'completed' })
    await expect(h.engine.begin(id, { ...spec, prompt: 'changed' }, inputs)).rejects.toMatchObject({
      code: 'E_BATCH_ID_CONFLICT',
    })
  })
  it('recovers a response lost after acceptance using the same durable key', async () => {
    const h = harness()
    h.executor.loseReply = true
    await h.engine.begin(id, spec, inputs)
    await expect(h.engine.tick(id)).rejects.toThrow('lost response')
    expect(await h.repo.status(id)).toMatchObject({ settled: 0, reserved: 1 })
    expect(await new BatchEngine(new Repository(h.store), h.executor).resume(id)).toMatchObject({
      status: 'completed',
      spent: 0.5,
    })
    expect(h.executor.executions).toBe(2)
  })
  it('retains an unknown outcome and budget reservation until an authoritative terminal receipt arrives', async () => {
    const h = harness()
    h.executor.reply = () => ({ state: 'unknown', charged: 0.2 })
    await h.engine.begin(id, spec, inputs)
    expect(await h.engine.tick(id)).toMatchObject({
      status: 'unknown',
      spent: 0.2,
      reserved: 0.8,
      uncertain: 1,
    })
    await h.engine.resume(id)
    expect(h.executor.executions).toBe(1)
    const receipt = [...h.executor.receipts.values()][0]!
    Object.assign(receipt, { state: 'completed', charged: 0.3, inputRead: true, text: 'ok' })
    h.executor.reply = () => ({ state: 'completed', charged: 0.25, inputRead: true, text: 'ok' })
    expect(await h.engine.resume(id)).toMatchObject({ status: 'completed', spent: 0.55, uncertain: 0 })
  })
  it('reserves hard ceilings across concurrency, accounts cancellation and stops at the batch limit', async () => {
    const h = harness()
    h.executor.reply = (r) => ({ state: 'running', charged: r.ceiling / 2 })
    await h.engine.begin(id, { ...spec, budget: 1.5 }, [
      ...inputs,
      { ...inputs[0]!, name: 'c.txt', ...reference(inputs[0]!.digest, 1, 'c.txt') },
    ])
    expect(await h.engine.tick(id)).toMatchObject({ status: 'running', spent: 0.75, reserved: 0.75 })
    expect([...h.executor.requests.values()].map((r) => r.ceiling)).toEqual([1, 0.5])
    expect(await h.engine.cancel(id)).toMatchObject({
      status: 'cancelled',
      spent: 0.75,
      reserved: 0,
      settled: 3,
    })
    expect((await h.repo.page(id)).map((i) => i.state)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    await h.engine.resume(id)
    expect(h.executor.executions).toBe(2)
  })
  it('uses a bounded repair in the same child and stops consecutive invalid results without storing model text in errors', async () => {
    const h = harness()
    h.executor.reply = () => ({
      state: 'completed',
      charged: 0.25,
      text: 'untrusted \u001b[31m malicious',
      inputRead: true,
    })
    await h.engine.begin(
      id,
      {
        ...spec,
        concurrency: 1,
        failureLimit: 1,
        schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } },
      },
      inputs,
    )
    await h.engine.tick(id)
    expect(await h.engine.tick(id)).toMatchObject({ status: 'failed', spent: 0.5, failures: 1 })
    const requests = [...h.executor.requests.values()]
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.ceiling)).toEqual([1, 0.75])
    expect(requests[1]!.child).toBe([...h.executor.receipts.values()][0]!.child)
    expect((await h.repo.page(id))[0]).toMatchObject({ state: 'invalid', error: 'invalid_output' })
  })
  it('bounds stored output, reconciles simultaneous recovery, and allows cancellation after dispatch authority is revoked', async () => {
    const h = harness()
    const engine = new BatchEngine(h.repo, h.executor, () => 1000, 14)
    await engine.begin(id, { ...spec, maxRepairs: 0 }, inputs)
    await Promise.all([engine.tick(id), engine.tick(id)])
    expect(await h.repo.status(id)).toMatchObject({
      status: 'completed',
      successes: 1,
      resultBytes: 13,
      spent: 0.5,
    })
    expect((await h.repo.page(id)).filter((item) => item.error === 'stored_result_limit')).toHaveLength(1)
    expect(h.executor.executions).toBe(2)
    const active = harness()
    active.executor.reply = () => ({ state: 'running', charged: 0.1 })
    await active.engine.begin(id, spec, inputs)
    await active.engine.tick(id)
    active.executor.authority.immutableInputOnly = false
    expect(await active.engine.cancel(id)).toMatchObject({ status: 'cancelled', spent: 0.2, reserved: 0 })
  })
  it.each([
    'immutableInputOnly',
    'durableIdempotency',
    'hardBudget',
    'terminalBilling',
    'bindingReceipts',
  ] as const)('refuses absent %s authority before persistence or dispatch', async (key) => {
    const h = harness()
    h.executor.authority[key] = false
    if (key === 'hardBudget' || key === 'terminalBilling') Object.assign(h.executor, { sessionBacked: true })
    await expect(h.engine.begin(id, spec, inputs)).rejects.toMatchObject({
      code: 'E_BATCH_AUTHORITY_UNAVAILABLE',
    })
    expect((await h.store.scan({ prefix: '', limit: 1 })).rows).toHaveLength(0)
  })
  it('refuses forged receipt binding and over-ceiling billing without settling success', async () => {
    for (const forged of [
      { inputDigest: 'forged' },
      { charged: 2 },
      { child: '' },
      { session: 'other' },
      { lane: 'other' },
    ]) {
      const h = harness()
      if ('charged' in forged) Object.assign(h.executor, { sessionBacked: true })
      h.executor.reply = () => ({ state: 'completed', charged: 0.25, text: 'ok', inputRead: true, ...forged })
      await h.engine.begin(id, spec, inputs)
      await expect(h.engine.tick(id)).rejects.toThrow()
      expect(await h.repo.status(id)).toMatchObject({ settled: 0, spent: 0, reserved: 1 })
    }
  })
  it('cancels at the persisted deadline and keeps the charged amount', async () => {
    const h = harness()
    h.executor.reply = () => ({ state: 'running', charged: 0.25 })
    await h.engine.begin(id, { ...spec, concurrency: 1 }, inputs)
    await h.engine.tick(id)
    h.advance()
    const m = await h.engine.tick(id)
    expect(m.spent).toBe(0.5)
    expect((await h.repo.page(id))[0]).toMatchObject({ state: 'failed', error: 'deadline_exceeded' })
  })
})
