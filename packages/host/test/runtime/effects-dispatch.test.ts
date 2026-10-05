import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { dispatchCommittedEffect, EffectUncertain } from '../../../core/src/runtime/effects/dispatch.js'
import { createEffectsAuthorityFixture } from './fixtures/effects-authority.js'

it('dispatches one genuine restricted leaf against the original durable State admission and intakes the receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'effects-invoke-'))
  const f = await createEffectsAuthorityFixture(join(directory, 'state.sqlite'))
  try {
    expect(f.db.record(`action:${f.db.actionId}`).value.state).toBe('prepared')
    expect(() => f.db.record('attempt:attempt')).toThrow('Original record absent')
    const result = await dispatchCommittedEffect(
      f.authority,
      { committedActionRef: f.ticket.original.action, expectedWriterEpoch: 1, expectedAuthorityEpoch: 1 },
      f.context,
      () => {},
    )
    expect(result.status).toBe('settled')
    expect(result.receiptRef?.receiptId).toBe('receipt')
    expect(f.requests()).toBe(1)
    expect(f.db.record('attempt:attempt').value.externalRequests).toHaveLength(1)
    expect(f.db.record('receipt:receipt').value.receipt).toBeDefined()
  } finally {
    f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('concurrent dispatches against one original State admission perform at most one physical request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'effects-concurrent-'))
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await createEffectsAuthorityFixture(join(directory, 'state.sqlite'), () => blocked)
  const request = {
    committedActionRef: f.ticket.original.action,
    expectedWriterEpoch: 1,
    expectedAuthorityEpoch: 1,
  }
  try {
    const one = dispatchCommittedEffect(f.authority, request, f.context, () => {})
    const two = dispatchCommittedEffect(f.authority, request, f.context, () => {})
    release()
    const results = await Promise.allSettled([one, two])
    expect(f.requests()).toBe(1)
    expect(results.some((r) => r.status === 'fulfilled' && r.value.status === 'settled')).toBe(true)
    expect(f.db.record('attempt:attempt').value.externalRequests).toHaveLength(1)
  } finally {
    release()
    f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('revocation after durable mark_running blocks the physical port', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'effects-revoked-'))
  const f = await createEffectsAuthorityFixture(join(directory, 'state.sqlite'))
  const original = f.authority.markRunning
  f.authority.markRunning = async (...args) => {
    await original(...args)
    f.revoke()
  }
  try {
    await expect(
      dispatchCommittedEffect(
        f.authority,
        { committedActionRef: f.ticket.original.action, expectedWriterEpoch: 1, expectedAuthorityEpoch: 1 },
        f.context,
        () => {},
      ),
    ).rejects.toThrow()
    expect(f.requests()).toBe(0)
    expect(f.db.record('attempt:attempt').value.externalRequests).toHaveLength(1)
  } finally {
    f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('lost physical response stays uncertain and never resends the original attempt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'effects-lost-response-'))
  const f = await createEffectsAuthorityFixture(join(directory, 'state.sqlite'), async () => {
    throw Error('physical response lost')
  })
  const request = {
    committedActionRef: f.ticket.original.action,
    expectedWriterEpoch: 1,
    expectedAuthorityEpoch: 1,
  }
  try {
    await expect(dispatchCommittedEffect(f.authority, request, f.context, () => {})).rejects.toBeInstanceOf(
      EffectUncertain,
    )
    expect(f.db.record('attempt:attempt').value.state).toBe('running')
    expect(f.requests()).toBe(1)
    await expect(dispatchCommittedEffect(f.authority, request, f.context, () => {})).rejects.toBeInstanceOf(
      EffectUncertain,
    )
    expect(f.requests()).toBe(1)
  } finally {
    f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('refuses an invalid owner clock before any physical request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'effects-invalid-clock-'))
  const f = await createEffectsAuthorityFixture(join(directory, 'state.sqlite'))
  f.authority.now = () => 'invalid-clock'
  try {
    await expect(
      dispatchCommittedEffect(
        f.authority,
        { committedActionRef: f.ticket.original.action, expectedWriterEpoch: 1, expectedAuthorityEpoch: 1 },
        f.context,
        () => {},
      ),
    ).rejects.toThrow()
    expect(f.requests()).toBe(0)
  } finally {
    f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
