import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestHost } from '@agnes/host/testkit'
import { expect, it } from 'vitest'
import { admissionOwnerFixture, admissionRequest } from './fixtures/runtime-admission-owner.js'

it('closes a failed installation and does not publish its runtime bindings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'entry-ready-'))
  const owner = admissionOwnerFixture({ readyFailure: true })
  try {
    await expect(
      createTestHost({ dataDir: root, script: [], runtimeAdmissionInstallation: owner.installation }),
    ).rejects.toThrow()
    expect(owner.events).toContainEqual({ method: 'close' })
    expect(owner.events.some((event) => event.method === 'state.createRun')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('aborts and drains a live admission before closing its owner, and never mints a bootstrap context for it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'entry-close-'))
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const owner = admissionOwnerFixture({
    onCreate: (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
        entered()
      }),
  })
  const { host } = await createTestHost({
    dataDir: root,
    script: [],
    runtimeAdmissionInstallation: owner.installation,
  })
  try {
    const identity = host.runtimeServices.dependencies.get({
      contract: 'agh.identity',
      major: 1,
      logicalName: 'default',
      scope: 'runtime',
      features: [],
      optional: false,
    })
    expect(identity.ok).toBe(true)
    if (!identity.ok) throw Error('identity binding missing')
    expect(() => host.runtimeServices.contextFor(identity.value.binding)).toThrow(
      'original local-owner context',
    )
    const pending = host.runtimeServices.runAdmission({ operation: 'create', request: admissionRequest })
    await Promise.race([
      started,
      pending.then((reply) => {
        throw Error(`admission did not reach State: ${JSON.stringify(reply)}`)
      }),
    ])
    await host.close()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(owner.events.slice(-2).map((event) => event.method)).toEqual(['connection.close', 'close'])
    expect(
      await host.runtimeServices.runAdmission({ operation: 'status', request: admissionRequest.ticketId }),
    ).toMatchObject({ ok: false })
    expect(owner.events.some((event) => event.method === 'admission.confirm')).toBe(false)
  } finally {
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
})
