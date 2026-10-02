import { expect, it } from 'vitest'
import { createRuntimeStateStore } from '../src/runtime/providers/state.js'
import { RuntimeStateDatabase } from '../src/runtime/state/transactions.js'
import { interactionStateFixture } from './runtime-state-interaction-read-fixture.js'

it('reads actual State preparation and response through cold immutable proofs with no query writes', async () => {
  const f = await interactionStateFixture()
  const pending = await f.prepareApproval()
  const before = f.count()
  const notices = f.commits.length
  expect(await f.store.readInteraction(pending.interactionId, f.context)).toEqual(pending)
  expect(await f.store.readInteractionResponseStatus('missing-response', f.context)).toEqual({
    responseId: 'missing-response',
    status: 'not-accepted',
    interactionId: null,
    version: null,
    result: null,
    error: null,
  })
  const page = await f.store.pendingInteractions({ scope: f.readScope }, f.context)
  expect(page.items).toEqual([pending])
  expect(page.complete).toBe(true)
  expect(f.count()).toEqual(before)
  expect(f.commits.length).toBe(notices)
  const response = await f.resolveApproval(pending.interactionId)
  expect(response.status).toBe('accepted')
  const after = f.count()
  const cold = new RuntimeStateDatabase({
    file: f.file,
    authority: { authorityId: 'authority', tenantId: 'tenant', authorityEpoch: 1 },
    now: () => Date.parse('2026-04-01T00:00:00.000Z'),
    interactionRead: f.readOwner,
  })
  try {
    expect(await cold.readInteraction(pending.interactionId, f.context)).toEqual(response.result)
    expect(await cold.readInteractionResponseStatus('response', f.context)).toMatchObject({
      status: 'applied',
      responseId: 'response',
      result: response.result,
    })
    expect((await cold.pendingInteractions({ scope: f.readScope }, f.context)).items).toEqual([])
    expect(f.count()).toEqual(after)
  } finally {
    cold.close()
  }
})
it('refuses incomplete State response realm rather than fabricating absence', async () => {
  const f = await interactionStateFixture()
  const before = f.count()
  f.partialRealm()
  await expect(f.store.readInteractionResponseStatus('missing-response', f.context)).rejects.toMatchObject({
    failure: { detailCode: 'interaction_unavailable' },
  })
  expect(f.count()).toEqual(before)
})
it('does not borrow approval mutation qualification for an authenticated historical reader', async () => {
  const f = await interactionStateFixture()
  const pending = await f.prepareApproval()
  await f.resolveApproval(pending.interactionId)
  const cold = new RuntimeStateDatabase({
    file: f.file,
    authority: { authorityId: 'authority', tenantId: 'tenant', authorityEpoch: 1 },
    now: () => Date.parse('2026-04-01T00:00:00.000Z'),
    interactionRead: f.readOwner,
  })
  try {
    expect((await cold.readInteractionResponseStatus('response', f.context)).status).toBe('applied')
    f.auth.revoke()
    await expect(cold.readInteraction(pending.interactionId, f.context)).rejects.toThrow('reader identity')
  } finally {
    cold.close()
  }
})
it('refuses a corrupt actual immutable interaction source without appending query commits', async () => {
  const f = await interactionStateFixture(),
    pending = await f.prepareApproval(),
    before = f.count()
  f.owner.db
    .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=?')
    .run('{}', `interaction:${pending.interactionId}`)
  await expect(f.store.readInteraction(pending.interactionId, f.context)).rejects.toMatchObject({
    failure: { detailCode: 'integrity' },
  })
  expect(f.count()).toEqual(before)
})
it('rechecks response realm completeness before the read transaction returns absence', async () => {
  const f = await interactionStateFixture(),
    before = f.count()
  let checks = 0
  f.readOwner.responseRealmComplete = () => ++checks === 1
  await expect(f.store.readInteractionResponseStatus('missing-response', f.context)).rejects.toMatchObject({
    failure: { detailCode: 'interaction_unavailable' },
  })
  expect(f.count()).toEqual(before)
})
it('explicitly refuses workspace pages without a complete production membership source', async () => {
  const f = await interactionStateFixture()
  const workspaceScope = {
    kind: 'workspace' as const,
    installationId: 'installation',
    runtimeId: 'runtime',
    workspaceId: 'workspace',
  }
  const source = { ...f.readOwner, current: () => ({ binding: 'fixture-reader', scope: workspaceScope }) }
  const cold = new RuntimeStateDatabase({
    file: f.file,
    authority: { authorityId: 'authority', tenantId: 'tenant', authorityEpoch: 1 },
    interactionRead: source,
  })
  try {
    await expect(cold.pendingInteractions({ scope: workspaceScope }, f.context)).rejects.toMatchObject({
      failure: { detailCode: 'interaction_unavailable' },
    })
  } finally {
    cold.close()
  }
})
it('protects the original State connection from writes by a defective read source and restores normal mode', async () => {
  const f = await interactionStateFixture(),
    before = f.count()
  const current = f.readOwner.current.bind(f.readOwner)
  f.readOwner.current = (context) => {
    f.owner.db.prepare('UPDATE runtime_record_heads SET min_reader=999 WHERE record_id=?').run('run:run')
    return current(context)
  }
  await expect(f.store.readInteractionResponseStatus('missing-response', f.context)).rejects.toThrow(
    /readonly/,
  )
  expect(
    f.owner.db.prepare('SELECT min_reader FROM runtime_record_heads WHERE record_id=?').get('run:run'),
  ).toMatchObject({ min_reader: 2 })
  expect(f.owner.db.prepare('PRAGMA query_only').get()).toMatchObject({ query_only: 0 })
  expect(f.count()).toEqual(before)
  f.readOwner.current = current
  expect((await f.store.readInteractionResponseStatus('missing-response', f.context)).status).toBe(
    'not-accepted',
  )
})

it('maps query resync to its frozen retry advice and retains explicit valid owner errors', async () => {
  const f = await interactionStateFixture()
  const provider = createRuntimeStateStore({
    file: f.file,
    authority: { authorityId: 'authority', tenantId: 'tenant', authorityEpoch: 1 },
    now: () => Date.parse('2026-04-01T00:00:00.000Z'),
    interactionRead: f.readOwner,
  })
  try {
    expect(
      await provider.pendingInteractions({ scope: f.readScope, cursor: 'tampered' }, f.context),
    ).toMatchObject({
      ok: false,
      error: { code: 'conflict', detailCode: 'resync_required', retryAdvice: { kind: 'retry_read' } },
    })
    expect(await provider.readInteraction('missing', f.context)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', detailCode: 'not_found' },
    })
    const refusal = {
      code: 'denied',
      detailCode: 'permission_denied',
      message: 'current reader denied',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'reader-refusal',
    }
    f.readOwner.current = () => {
      throw refusal
    }
    expect(await provider.readInteractionResponseStatus('missing-response', f.context)).toEqual({
      ok: false,
      error: refusal,
    })
    f.readOwner.current = () => {
      throw { code: 'denied' }
    }
    expect(await provider.readInteractionResponseStatus('missing-response', f.context)).toMatchObject({
      ok: false,
      error: { code: 'internal', detailCode: 'fault' },
    })
  } finally {
    provider.close()
  }
})
