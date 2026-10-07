import type { PackageOperationGetParams } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { runPluginDevelopmentCommand } from '../src/commands/plugins.js'
import { runPackageCommand } from '../src/commands/package.js'

const profile = 'local-dev'
const source = { type: 'npm' as const, ref: 'npm:example@1.0.0' }
const integrity = `sha256-${'a'.repeat(64)}`
const preview = {
  id: 'example',
  version: '1.0.0',
  source,
  integrity,
  license: 'MIT',
  provenance: { source, integrity, signatureVerified: false },
  contributions: [],
  capabilityDiff: {
    added: [],
    removed: [],
    runtimeSupportRemoved: [],
    dependenciesAdded: [],
    serviceGrantsAdded: [],
  },
  dependencies: {},
  warnings: [],
  blockers: [],
}

function operation(kind: 'inspect' | 'install', installed = false) {
  return {
    operationId: kind,
    profile,
    operation: kind,
    state: 'completed' as const,
    progress: 100,
    startedAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...(kind === 'inspect' ? { preview } : {}),
    ...(installed
      ? {
          installed: {
            id: 'example',
            version: '1.0.0',
            source,
            integrity,
            trusted: false,
            desired: 'installed-disabled' as const,
            actual: 'not-running' as const,
            contributions: [],
            blockers: [],
          },
        }
      : {}),
  }
}

function client(): { value: NodeClient; installs: () => number } {
  let installCalls = 0
  return {
    value: {
      async clientId() {
        return 'cli-client'
      },
      packages: {
        catalog: {
          async list() {
            return { items: [], nextCursor: null }
          },
          async get() {
            throw new Error('unused')
          },
        },
        async list() {
          return { packages: [] }
        },
        async inspect() {
          return { operationId: 'inspect', profile }
        },
        async install() {
          installCalls++
          return { operationId: 'install', profile }
        },
        async trust() {
          throw new Error('unused')
        },
        async enable() {
          throw new Error('unused')
        },
        async disable() {
          throw new Error('unused')
        },
        async update() {
          throw new Error('unused')
        },
        async rollback() {
          throw new Error('unused')
        },
        async remove() {
          throw new Error('unused')
        },
        operation: {
          async get(params: PackageOperationGetParams) {
            return params.operationId === 'inspect' ? operation('inspect') : operation('install', true)
          },
          async cancel() {
            throw new Error('unused')
          },
          async subscribe() {
            throw new Error('unused')
          },
        },
      },
    } as unknown as NodeClient,
    installs: () => installCalls,
  }
}

describe('package command', () => {
  it('binds install confirmation to preview integrity and leaves the result disabled/untrusted', async () => {
    const fixture = client()
    const written: string[] = []
    await runPackageCommand(parseArgs(['install', source.ref]), fixture.value, {
      write: (line) => written.push(line),
      confirm: async (value) => value.integrity === integrity,
    })
    expect(fixture.installs()).toBe(1)
    expect(written.join('\n')).toContain('Installation will remain disabled and untrusted.')
    expect(written.join('\n')).toContain('desired installed-disabled; actual not-running; trusted false')
  })

  it('does not install after a rejected preview confirmation', async () => {
    const fixture = client()
    const written: string[] = []
    await runPackageCommand(parseArgs(['package', 'add', source.ref]), fixture.value, {
      write: (line) => written.push(line),
      confirm: async () => false,
    })
    expect(fixture.installs()).toBe(0)
    expect(written.join('')).toContain('Installation cancelled.')
  })
})

it.each([
  ['plugins', 'reload', 'example'],
  ['dev', './plugin'],
])('reloads the inspected local revision for %s through atomic package activation', async (...args) => {
  const local = { type: 'file' as const, ref: 'file:./plugin' }
  const installed = {
    ...operation('install', true).installed!,
    source: local,
    trusted: true,
    desired: 'enabled',
    actual: 'running',
    actualIntegrity: integrity,
  }
  const next = {
    ...preview,
    source: local,
    integrity: `sha256-${'b'.repeat(64)}`,
    capabilityHash: 'c'.repeat(64),
  }
  const update = vi.fn(async (_params: unknown) => ({ operationId: 'update', profile }))
  const rpc = {
    clientId: async () => 'cli-client',
    packages: {
      list: async () => ({ packages: [installed] }),
      inspect: async () => ({ operationId: 'inspect', profile }),
      update,
      operation: {
        get: async ({ operationId }: PackageOperationGetParams) =>
          operationId === 'inspect'
            ? { ...operation('inspect'), preview: next }
            : { ...operation('install'), operation: 'update' },
      },
    },
  } as unknown as NodeClient
  const output: string[] = []
  await runPluginDevelopmentCommand(parseArgs(args), rpc, (text) => output.push(text))
  expect(update.mock.calls[0]?.[0]).toMatchObject({
    id: 'example',
    source: local,
    expectedIntegrity: next.integrity,
    activation: {
      expectedInstalledIntegrity: integrity,
      expectedActiveIntegrity: integrity,
      trust: { integrity: next.integrity, capabilityHash: next.capabilityHash },
    },
  })
  expect(output.join('')).toContain('existing sessions keep their generation')
  installed.desired = 'installed-disabled'
  await expect(
    runPluginDevelopmentCommand(parseArgs(['plugins', 'reload', 'example']), rpc, () => {}),
  ).rejects.toThrow('E_PLUGIN_RELOAD_DISABLED')
})

it('routes discovery-owned local reload through the existing activation effect', async () => {
  const enable = vi.fn(async (_params: unknown) => ({ operationId: 'enable', profile }))
  const installed = {
    ...operation('install', true).installed!,
    source: { type: 'local', ref: 'local:workspace/example' },
    trusted: true,
    desired: 'enabled',
    actual: 'running',
  }
  const rpc = {
    clientId: async () => 'cli-client',
    packages: {
      list: async () => ({ packages: [installed] }),
      enable,
      operation: { get: async () => ({ ...operation('install'), operation: 'enable', installed }) },
    },
  } as unknown as NodeClient
  await runPluginDevelopmentCommand(parseArgs(['plugins', 'reload', 'example']), rpc, () => {})
  expect(enable.mock.calls[0]?.[0]).toMatchObject({ profile, id: 'example', clientId: 'cli-client' })
})
