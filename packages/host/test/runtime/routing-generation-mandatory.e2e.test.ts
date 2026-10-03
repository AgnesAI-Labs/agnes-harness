import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routingInputSchema } from '@agnes/extension-api/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import { composePolicies } from '../../../core/src/runtime/policy/decision-composition.js'
import { policyInput } from '../../../core/test/runtime/policy-fixture.js'
import { recoverRoutingSelection, routingRecoverySeed } from './fixtures/routing-recovery-source.js'

it('keeps the original issued prepared source and executing attempt while another catalog generation is prepared', async () => {
  const { createPreparedModelSourceFixture, preparedSourceDigest } = await import(
    './fixtures/prepared-model-source.js'
  )
  let started!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => {
    started = resolve
  })
  const responseGate = new Promise<void>((resolve) => {
    release = resolve
  })
  let exits = 0
  const remote = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = validateRuntime('JsonValue', JSON.parse(body))
    if (!parsed.ok || !parsed.value || Array.isArray(parsed.value) || typeof parsed.value !== 'object')
      throw Error('Actual model HTTP input missing')
    exits++
    started()
    await responseGate
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(
      `data: ${JSON.stringify({ id: 'concurrent-response', object: 'chat.completion.chunk', created: 1, model: parsed.value.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'original generation response' }, finish_reason: null }] })}\n\n`,
    )
    response.write(
      `data: ${JSON.stringify({ id: 'concurrent-response', object: 'chat.completion.chunk', created: 1, model: parsed.value.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`,
    )
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve))
  const address = remote.address()
  if (!address || typeof address === 'string') throw Error('Actual HTTP fixture not listening')
  const directory = mkdtempSync(join(tmpdir(), 'routing-concurrent-generation-'))
  const fixture = await createPreparedModelSourceFixture(
    directory,
    'default',
    `http://127.0.0.1:${address.port}/v1`,
  )
  let pending: ReturnType<typeof fixture.invoke> | undefined
  try {
    const first = await fixture.prepare('original in-flight request', 1)
    const originalAction = preparedSourceDigest(fixture.readAction(first.actionId))
    const originalSource = fixture.sourceDB
      .prepare('SELECT body,digest FROM prepared_sources WHERE id=?')
      .get(first.prepared.preparedId)
    let completed = false
    pending = fixture.invoke(first).then((result) => {
      completed = true
      return result
    })
    await reached
    expect(completed).toBe(false)
    const next = await fixture.prepare('concurrent new catalog request', 2, first.reference)
    expect(completed).toBe(false)
    expect(exits).toBe(1)
    expect(next.actionId).not.toBe(first.actionId)
    expect(next.prepared.target.catalogRevision).toBe(2)
    expect(next.prepared.target.priceVersion).toBe('fixture-price-2')
    expect(first.prepared.target.catalogRevision).toBe(1)
    expect(first.prepared.target.priceVersion).toBe('fixture-price-1')
    expect(preparedSourceDigest(fixture.readAction(first.actionId))).toBe(originalAction)
    expect(
      fixture.sourceDB
        .prepare('SELECT body,digest FROM prepared_sources WHERE id=?')
        .get(first.prepared.preparedId),
    ).toEqual(originalSource)
    release()
    const result = await pending
    expect(result.outcome, JSON.stringify(result)).toBe('succeeded')
    const saved = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'))
    const frame = validateRuntime('ActionFrame', saved.frame)
    expect(frame.ok).toBe(true)
    if (!frame.ok || frame.value.input.kind !== 'inline') throw Error('Original saved frame missing')
    const invocation = validateRuntime('ModelAdapterInvokeRequest', frame.value.input.value)
    if (!invocation.ok) throw Error('Original saved model invocation missing')
    expect(frame.value.actionId).toBe(first.actionId)
    expect(invocation.value.preparedCallRef).toEqual(first.reference)
    expect(frame.value.requestIdentity?.requestDigest).toBe(first.prepared.inputDigest)
    expect(frame.value.requestIdentity?.idempotencyKey).toBe('external-1')
    expect(result.usage).toHaveLength(1)
    expect(result.usage[0]?.attemptId).toBe(frame.value.attemptId)
    expect(result.usage[0]?.actionId).toBe(first.actionId)
    expect(exits).toBe(1)
  } finally {
    release()
    await pending
    await fixture.close()
    await new Promise<void>((resolve) => remote.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
}, 30000)

it('keeps a mandatory deny out of real routing candidates despite an allow contributor and higher configured priority', async () => {
  const request = policyInput()
  const contributors = [
    {
      id: 'mandatory-deny',
      after: [],
      mandatory: true,
      evaluate: () => ({ decision: 'deny' as const, reasonCodes: ['restricted_mandatory_route'] }),
    },
    {
      id: 'allow-after-deny',
      after: ['mandatory-deny'],
      mandatory: false,
      evaluate: () => ({ decision: 'allow' as const, reasonCodes: ['restricted_allow_route'] }),
    },
  ]
  const decision = composePolicies(request, contributors)
  expect(decision.decision).toBe('deny')
  expect(decision.reasonCodes).toEqual(['restricted_mandatory_route', 'restricted_allow_route'])
  const seed = routingRecoverySeed('default')
  if (seed.input.kind !== 'inline') throw Error('Original routing source missing')
  const parsed = validateRuntime('RoutingSelectInput', seed.input.value)
  if (!parsed.ok || !parsed.value.allowedRoutes[0]) throw Error('Original route absent')
  const safe = parsed.value.allowedRoutes[0]
  const deniedRoute = { ...safe, routeId: 'denied-priority', model: 'denied-expensive-model' }
  // The restricted publisher applies the original mandatory composition to the candidate.
  // This consumer does not install a production policy or grant issuer.
  const candidates = [deniedRoute, safe].filter(
    (route) => route.routeId !== deniedRoute.routeId || decision.decision === 'allow',
  )
  const input = routingInputSchema.encode({ ...parsed.value, allowedRoutes: candidates })
  if (!input.ok) throw Error('Official routing input codec refused')
  const selected = await recoverRoutingSelection({
    ...seed,
    priority: [deniedRoute.routeId, safe.routeId],
    input: input.value,
  })
  expect(selected.route.route).toEqual(safe)
  expect(selected.route.route.routeId).not.toBe(deniedRoute.routeId)
  const none = routingInputSchema.encode({
    ...parsed.value,
    allowedRoutes: candidates.filter((route) => route.routeId === deniedRoute.routeId),
  })
  if (!none.ok) throw Error('Official empty-candidate codec refused')
  await expect(
    recoverRoutingSelection({ ...seed, priority: [deniedRoute.routeId], input: none.value }),
  ).rejects.toThrow()
})
