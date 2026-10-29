import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client } from '@agnes/sdk'
import { expect, it } from 'vitest'
import type { LocalBackend } from './backend.js'
import { localClientExamples } from './client-examples.js'

it('prepares an explicit installed example outside default Host bundles while refusing foreign bundles and presets', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agh-launch-facade-'))
  const parent = { id: 'acme/parent', version: '1.0.0', trusted: true, desired: 'enabled', blockers: [] }
  const launch = {
    id: 'work',
    kind: 'business-agent',
    title: 'Work',
    bundle: 'acme/demo#work',
    preset: 'safe',
    prompt: 'Inspect synthetic data.',
  }
  const example = {
    id: 'acme/demo',
    version: '1.0.0',
    integrity: 'hash-1',
    capabilityHash: 'cap-1',
    trusted: true,
    desired: 'enabled',
    actual: 'running',
    blockers: [],
    dependencies: { 'acme/parent': '1.0.0' },
    compatibility: 'supported',
    source: { type: 'file', ref: 'file:./bundled-examples/demo' },
    metadata: { exampleOf: parent.id },
    agents: [
      { ref: launch.bundle, launch: { title: { en: 'Work' }, description: { en: 'Work' }, preset: 'safe' } },
    ],
    presentation: { presets: [{ bundle: launch.bundle, id: launch.preset }] },
  }
  const row = {
    rowId: 'web:acme/parent',
    packageId: parent.id,
    enabled: true,
    phase: 'ready',
    binding: {
      lifetime: 'profile',
      availability: 'active',
      owner: 'web:acme/parent',
      packageId: parent.id,
      integrity: 'parent-1',
      profileId: 'test',
      activationId: 'one',
    },
  }
  const bundle = { id: launch.bundle, sourcePackage: example.id }
  const catalog = [bundle]
  const preset = example.presentation.presets[0]
  if (!preset) throw new Error('Missing fixture preset')
  // The default Host has no example bundle. Only the installed catalog is valid for a new
  // explicit selection; using sessionSelection.runtime here used to turn this request into 403.
  const client = {
    clientId: async () => 'synthetic-user',
    agents: {
      resolve: async (ref: string) => {
        if (ref !== bundle.id || bundle.sourcePackage !== example.id || preset.id !== 'safe')
          throw new Error('CAPABILITY_DENIED')
        return { ref, launch: example.agents[0]!.launch, preset: 'safe', bundles: [ref], digest: 'reviewed' }
      },
    },
    call: async () => ({ bundles: [] }),
    request: async () => ({ revision: 0, bundles: [], catalog }),
    clientModules: { list: async () => ({ rows: [row] }) },
    packages: {
      list: async () => ({ packages: [parent, example] }),
      catalog: { list: async () => ({ items: [example], nextCursor: null }) },
      inspect: async () => ({ operationId: 'inspect' }),
      operation: { get: async () => ({ state: 'completed', preview: example }) },
    },
  } as unknown as Client
  const backend = { scope: { profile: 'test', daemonDir: directory } } as LocalBackend
  const facade = localClientExamples(backend, client, async () => {})
  const prepare = () => facade.call(row.rowId, { action: 'prepare', exampleId: example.id, launchId: 'work' })
  try {
    expect(await prepare()).toMatchObject({
      launchTicket: expect.any(String),
      presentation: { bundle: launch.bundle, preset: launch.preset },
    })
    bundle.sourcePackage = 'acme/foreign'
    await expect(prepare()).rejects.toThrow('CAPABILITY_DENIED')
    bundle.sourcePackage = example.id
    bundle.id = 'acme/foreign#work'
    await expect(prepare()).rejects.toThrow('CAPABILITY_DENIED')
    bundle.id = launch.bundle
    preset.id = 'different'
    await expect(prepare()).rejects.toThrow('CAPABILITY_DENIED')
    preset.id = launch.preset
    row.enabled = false
    await expect(prepare()).rejects.toThrow('CAPABILITY_DENIED')
    row.enabled = true
    example.agents[0]!.ref = 'acme/demo#undeclared'
    await expect(prepare()).rejects.toThrow('CAPABILITY_DENIED')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
