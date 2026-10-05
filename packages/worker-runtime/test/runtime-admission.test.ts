import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestHost } from '@agnes/host/testkit'
import { expect, it } from 'vitest'
import { admissionOwnerFixture, admissionRequest } from './fixtures/runtime-admission-owner.js'
import { loopOwnerFixture } from './fixtures/runtime-loop-owner.js'

it('keeps the empty installation service root and its admission-only compatibility shape', async () => {
  const root = mkdtempSync(join(tmpdir(), 'entry-empty-'))
  const { host } = await createTestHost({ dataDir: root, script: [] })
  try {
    expect(Object.keys(host.runtimeServices).sort()).toEqual([
      'contextFor',
      'dependencies',
      'runAdmission',
      'usageLedger',
    ])
    for (const contract of ['agh.tools', 'agh.context', 'agh.loop']) {
      expect(
        host.runtimeServices.dependencies.get({
          contract,
          major: 1,
          logicalName: 'default',
          scope: 'run',
          features: [],
          optional: false,
        }),
      ).toMatchObject({ ok: false, error: { detailCode: 'service_not_registered' } })
    }
  } finally {
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('selects installed factory bindings in the one root without issuing bootstrap identities for them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'entry-selected-'))
  const owner = admissionOwnerFixture()
  const loop = await loopOwnerFixture('state')
  const { host } = await createTestHost({
    dataDir: root,
    script: [],
    runtimeAdmissionInstallation: {
      ...owner.installation,
      loop: loop.installation,
    },
  })
  try {
    for (const binding of [
      loop.installation.tools.definition.executor,
      loop.installation.context.binding,
      loop.installation.loop.binding,
    ]) {
      expect(
        host.runtimeServices.dependencies.get({
          contract: binding.contract,
          major: 1,
          logicalName: binding.logicalName,
          scope: 'run',
          features: [],
          optional: false,
        }),
      ).toMatchObject({ ok: true, value: { binding } })
      expect(() => host.runtimeServices.contextFor(binding)).toThrow('original run-owner context')
    }
  } finally {
    await host.close()
    await loop.close()
    rmSync(root, { recursive: true, force: true })
  }
})

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
