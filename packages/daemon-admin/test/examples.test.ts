import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentPlan,
  ClientModuleRosterRow,
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PackagePreview,
} from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { createAgentLaunches, createExamplePackages, type ExampleBackend } from '../src/packages/examples.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(parentVersion = '1.0.0') {
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
    agents: [
      {
        ref: '@agnes-example/demo#work',
        launch: {
          title: { en: launch.title },
          description: { en: 'Work' },
          preset: launch.preset,
        },
      },
    ],
    metadata: {
      displayName: 'Demo',
      summary: 'Demo',
      description: 'Demo',
      exampleOf: 'acme/parent',
    },
  } as unknown as PackageCatalogDescriptor
  const preview = {
    ...entry,
    capabilityHash: 'cap-1',
    dependencies: { 'acme/parent': parentVersion },
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
    remove: async (_review, _operation, check) => {
      await check()
      installed = []
    },
    owner: async () => ({ version: parentVersion, principal: 'synthetic-user', profile: 'test', row }),
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
    resolveAgent: async (ref) =>
      ({
        ref,
        launch: entry.agents![0]!.launch,
        digest: JSON.stringify(entry.agents),
        loop: { id: 'work', version: '1.0.0' },
        bundles: [ref],
        preset: 'safe',
        pages: [],
        compositionHash: 'tree',
        presetHash: 'preset',
        effectivePresetHash: 'effective',
        model: { route: 'demo', model: 'demo' },
        models: {},
        permission: { readOnly: false, tools: [], allow: [], deny: [] },
        sources: [],
      }) as AgentPlan,
    open: async (_launch, key) => {
      const session = sessions.get(key) ?? `session-${sessions.size + 1}`
      sessions.set(key, session)
      return session
    },
  }
  const create = () => createExamplePackages({ directory, backend })
  const call = (request: Record<string, unknown>) => create().call(row.rowId, request)
  return { row, entry, preview, backend, sessions, inputs, call, directory }
}
it.each(['1.0.0', '0.1.0-alpha.0'])(
  'reviews an exact %s parent pin, enables it and creates one durable session per operation',
  async (version) => {
    const f = fixture(version)
    expect(await f.call({ action: 'list' })).toMatchObject([
      { id: f.entry.id, installation: 'not-installed' },
    ])
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
    expect(f.inputs.size).toBe(0)
    // An interrupted launch has an uncertain receipt and must not be dispatched again.
    const state = JSON.parse(readFileSync(join(f.directory, 'operations.json'), 'utf8'))
    for (const operation of Object.values(state.operations) as { state: string; sessionId?: string }[])
      if (operation.sessionId) operation.state = 'running'
    writeFileSync(join(f.directory, 'operations.json'), JSON.stringify(state))
    await expect(f.call(request)).rejects.toThrow('OUTCOME_UNKNOWN')
    expect(f.sessions.size).toBe(1)
    expect(f.inputs.size).toBe(0)
    await expect(f.call({ ...request, launchTicket: 'different-ticket' })).rejects.toThrow('STALE')
    await f.call({ action: 'stop', exampleId: f.entry.id, operationId: 'stop-1' })
    expect(await f.call({ action: 'list' })).toMatchObject([
      { installation: 'disabled', runtime: { state: 'stopped' } },
    ])
    const removal = (await f.call({ action: 'inspect-remove', exampleId: f.entry.id })) as {
      reviewId: string
    }
    await expect(
      f.call({ action: 'remove', reviewId: review.reviewId, operationId: 'wrong-review' }),
    ).rejects.toThrow('DENIED')
    await f.call({ action: 'remove', reviewId: removal.reviewId, operationId: 'remove-1' })
    expect(await f.call({ action: 'list' })).toMatchObject([{ installation: 'not-installed' }])
    await expect(
      f.call({ action: 'stop', exampleId: 'foreign/example', operationId: 'stop-2' }),
    ).rejects.toThrow()
  },
)
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
  await expect(
    f.call({ action: 'enable', reviewId: review.reviewId, operationId: 'parent-disabled' }),
  ).rejects.toThrow('DENIED')
  await expect(f.call({ action: 'prepare', exampleId: f.entry.id, launchId: 'work' })).rejects.toThrow(
    'DENIED',
  )
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

it('returns the reviewed draft with the session and never submits it, including start retries', async () => {
  const f = fixture()
  const review = (await f.call({ action: 'inspect', exampleId: f.entry.id })) as { reviewId: string }
  await f.call({ action: 'enable', reviewId: review.reviewId, operationId: 'enable-draft' })
  const agent = f.entry.agents?.[0]
  if (!agent) throw new Error('fixture agent is missing')
  Object.assign(agent.launch, { prompt: { text: { en: 'Keep editable' }, mode: 'draft' } })
  const ticket = (await f.call({ action: 'prepare', exampleId: f.entry.id, launchId: 'work' })) as {
    launchTicket: string
  }
  const request = { action: 'start', launchTicket: ticket.launchTicket, operationId: 'draft-start' }
  const expected = { sessionId: 'session-1', draft: agent.launch.prompt }
  expect(await f.call(request)).toEqual(expected)
  expect(await f.call(request)).toEqual(expected)
  expect(f.sessions.size).toBe(1)
  expect(f.inputs.size).toBe(0)
})

it('ordinary agent review binds caller workspace and activation, refuses drift and expiry, and keeps draft retries idempotent', async () => {
  const f = fixture()
  let time = 1
  const caller = {
    principal: 'host-user',
    profile: 'test',
    workspace: '/synthetic/workspace',
    activation: 'host-1',
  }
  let plan = await f.backend.resolveAgent('acme/kit#work')
  plan = {
    ...plan,
    launch: { ...plan.launch, prompt: { mode: 'draft', text: { en: 'Review before sending' } } },
  }
  const backend = { caller: async () => caller, resolve: async () => plan, open: f.backend.open }
  const call = (request: Record<string, unknown>) =>
    createAgentLaunches({ directory: f.directory, backend, now: () => time }).call(request)
  const prepare = () => call({ action: 'prepare', agent: plan.ref }) as Promise<{ launchTicket: string }>
  const first = await prepare()
  const request = { action: 'start', launchTicket: first.launchTicket, operationId: 'host-start' }
  expect(await call(request)).toEqual({ sessionId: 'session-1', draft: plan.launch.prompt })
  expect(await call(request)).toEqual({ sessionId: 'session-1', draft: plan.launch.prompt })
  expect(f.sessions.size).toBe(1)
  expect(f.inputs.size).toBe(0)
  await expect(call({ ...request, launchTicket: 'different' })).rejects.toThrow('STALE')
  const drift = await prepare()
  plan = { ...plan, digest: 'changed-permission-or-model-or-source' }
  await expect(
    call({ action: 'start', launchTicket: drift.launchTicket, operationId: 'drift' }),
  ).rejects.toThrow('STALE')
  const expired = await prepare()
  time += 300_001
  await expect(
    call({ action: 'start', launchTicket: expired.launchTicket, operationId: 'expired' }),
  ).rejects.toThrow('STALE')
  const activation = await prepare()
  caller.activation = 'host-2'
  await expect(
    call({ action: 'start', launchTicket: activation.launchTicket, operationId: 'activation' }),
  ).rejects.toThrow('STALE')
  await expect(
    call({ action: 'enable', reviewId: first.launchTicket, operationId: 'escalate' }),
  ).rejects.toThrow('INVALID')
  const unknown = await prepare()
  backend.open = async () => {
    throw new Error('uncertain')
  }
  const retry = { action: 'start', launchTicket: unknown.launchTicket, operationId: 'unknown' }
  await expect(call(retry)).rejects.toThrow('OUTCOME_UNKNOWN')
  backend.open = f.backend.open
  await expect(call(retry)).rejects.toThrow('OUTCOME_UNKNOWN')
  expect(f.sessions.size).toBe(1)
})
