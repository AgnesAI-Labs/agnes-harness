import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ClientModuleRosterRow,
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PackagePreview,
} from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { createExamplePackages, type ExampleBackend } from '../src/packages/examples.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agh-example-'))
  roots.push(directory)
  const row: ClientModuleRosterRow = {
    rowId: 'web:acme/parent',
    moduleName: 'parent',
    packageId: 'acme/parent',
    enabled: true,
    phase: 'ready',
    binding: {
      lifetime: 'profile',
      owner: 'web:acme/parent',
      packageId: 'acme/parent',
      integrity: 'p1',
      profileId: 'test',
      activationId: 'activation-1',
      availability: 'active',
    },
  }
  const launch = {
    id: 'work',
    kind: 'business-agent' as const,
    title: 'Work',
    bundle: 'demo',
    preset: 'safe',
    prompt: 'Inspect synthetic data.',
  }
  const entry = {
    id: '@agnes-example/demo',
    version: '1.0.0',
    integrity: 'hash-1',
    sourceId: 'official-examples',
    source: { type: 'file', ref: 'file:./bundled-examples/fde/code-review' },
    compatibility: 'supported',
    license: 'Apache-2.0',
    contributions: [],
    metadata: {
      displayName: 'Demo',
      summary: 'Demo',
      description: 'Demo',
      category: 'example',
      exampleOf: 'acme/parent',
      launches: [launch],
    },
  } as unknown as PackageCatalogDescriptor
  const preview = {
    ...entry,
    capabilityHash: 'cap-1',
    dependencies: { 'acme/parent': '*' },
    blockers: [],
    warnings: [],
  } as unknown as PackagePreview
  let installed: PackageInstalledDescriptor[] = []
  const sessions = new Map<string, string>(),
    inputs = new Set<string>()
  const backend: ExampleBackend = {
    runtime: async () => ({ state: 'running' }),
    stop: async () => {
      installed = installed.map((item) => ({ ...item, desired: 'installed-disabled', actual: 'not-running' }))
    },
    owner: async () => ({ version: '1.0.0', principal: 'synthetic-user', profile: 'test', row }),
    catalog: async () => [entry],
    installed: async () => installed,
    inspect: async () => preview,
    enable: async (_review, _operation, check) => {
      await check()
      installed = [
        {
          ...preview,
          trusted: true,
          desired: 'enabled',
          actual: 'running',
        } as unknown as PackageInstalledDescriptor,
      ]
    },
    validateLaunch: async () => {},
    open: async (_launch, key) => {
      const session = sessions.get(key) ?? `session-${sessions.size + 1}`
      sessions.set(key, session)
      return session
    },
    prompt: async (_session, _prompt, command) => {
      inputs.add(command)
    },
  }
  const create = () => createExamplePackages({ directory, backend })
  const call = (request: Record<string, unknown>) => create().call(row.rowId, request)
  return { row, entry, preview, backend, sessions, inputs, call, directory }
}
it('reviews only the calling host local payload, enables it and creates one durable session per operation', async () => {
  const f = fixture()
  expect(await f.call({ action: 'list' })).toMatchObject([{ id: f.entry.id, installation: 'not-installed' }])
  const review = (await f.call({ action: 'inspect', exampleId: f.entry.id })) as { reviewId: string }
  await f.call({ action: 'enable', reviewId: review.reviewId, operationId: 'enable-1' })
  expect(await f.call({ action: 'list' })).toMatchObject([
    { installation: 'enabled', runtime: { state: 'running' } },
  ])
  const ticket = (await f.call({ action: 'prepare', exampleId: f.entry.id, launchId: 'work' })) as {
    launchTicket: string
  }
  const request = { action: 'start', launchTicket: ticket.launchTicket, operationId: 'launch-1' }
  expect(await f.call(request)).toEqual({ sessionId: 'session-1' })
  expect(await f.call(request)).toEqual({ sessionId: 'session-1' })
  expect(f.sessions.size).toBe(1)
  expect(f.inputs.size).toBe(1)
  // A crash after admission but before receipt persistence can repeat both steps safely.
  const state = JSON.parse(readFileSync(join(f.directory, 'operations.json'), 'utf8'))
  for (const operation of Object.values(state.operations) as { state: string; sessionId?: string }[])
    if (operation.sessionId) operation.state = 'running'
  writeFileSync(join(f.directory, 'operations.json'), JSON.stringify(state))
  expect(await f.call(request)).toEqual({ sessionId: 'session-1' })
  expect(f.sessions.size).toBe(1)
  expect(f.inputs.size).toBe(1)
  await expect(f.call({ ...request, launchTicket: 'different-ticket' })).rejects.toThrow('STALE')
  await f.call({ action: 'stop', exampleId: f.entry.id, operationId: 'stop-1' })
  expect(await f.call({ action: 'list' })).toMatchObject([
    { installation: 'disabled', runtime: { state: 'stopped' } },
  ])
  await expect(
    f.call({ action: 'stop', exampleId: 'foreign/example', operationId: 'stop-2' }),
  ).rejects.toThrow()
})
it('refuses changed hashes, cross-parent examples, stale activation, undeclared launches and admin-shaped inputs', async () => {
  const f = fixture()
  const review = (await f.call({ action: 'inspect', exampleId: f.entry.id })) as { reviewId: string }
  f.entry.integrity = 'changed'
  await expect(
    f.call({ action: 'enable', reviewId: review.reviewId, operationId: 'enable-1' }),
  ).rejects.toThrow('STALE')
  f.entry.integrity = 'hash-1'
  if (f.entry.metadata) f.entry.metadata.exampleOf = 'other/parent'
  expect(await f.call({ action: 'list' })).toEqual([])
  await expect(f.call({ action: 'inspect', exampleId: f.entry.id })).rejects.toThrow('DENIED')
  if (f.entry.metadata) f.entry.metadata.exampleOf = 'acme/parent'
  if (f.row.binding) f.row.binding.activationId = 'activation-2'
  await expect(
    f.call({ action: 'enable', reviewId: review.reviewId, operationId: 'enable-2' }),
  ).rejects.toThrow('STALE')
  await expect(f.call({ action: 'install', source: 'https://example.invalid' })).rejects.toThrow('INVALID')
  await expect(f.call({ action: 'list', approved: true })).rejects.toThrow('INVALID')
  f.row.enabled = false
  await expect(f.call({ action: 'list' })).rejects.toThrow('DENIED')
})
it('retains an unknown dispatch result and does not replay it', async () => {
  const f = fixture()
  const review = (await f.call({ action: 'inspect', exampleId: f.entry.id })) as { reviewId: string }
  f.backend.enable = async () => {
    throw new Error('synthetic uncertain activation')
  }
  const request = { action: 'enable', reviewId: review.reviewId, operationId: 'enable-unknown' }
  await expect(f.call(request)).rejects.toThrow('OUTCOME_UNKNOWN')
  expect(await f.call({ action: 'read', operationId: 'enable-unknown' })).toMatchObject({ state: 'unknown' })
  f.backend.enable = async () => {
    throw new Error('should never run')
  }
  await expect(f.call(request)).rejects.toThrow('OUTCOME_UNKNOWN')
  f.backend.enable = async () => {
    throw new Error('E_PACKAGE_STATE')
  }
  await expect(f.call({ ...request, operationId: 'known-failure' })).rejects.toThrow('E_PACKAGE_STATE')
  expect(await f.call({ action: 'read', operationId: 'known-failure' })).toMatchObject({
    state: 'failed',
    code: 'E_PACKAGE_STATE',
  })
})
