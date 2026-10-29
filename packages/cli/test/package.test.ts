import { join, sep } from 'node:path'
import { Writable } from 'node:stream'
import { parseSource } from '@agnes/package-manager'
import type { PackageOperationGetParams } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { reportCommandFailure } from '../src/command-failure.js'
import { runPackageCommand } from '../src/commands/package.js'
import { runPluginDevelopmentCommand } from '../src/commands/plugins.js'

const profile = 'local-dev'
const source = { type: 'npm' as const, ref: 'npm:example@1.0.0' }
const integrity = `sha256-${'a'.repeat(64)}`
const preview = {
  id: 'example',
  version: '1.0.0',
  source,
  integrity,
  capabilityHash: 'b'.repeat(64),
  declaredCapabilities: { exec: ['node'] },
  license: 'MIT',
  provenance: { source, integrity, signatureVerified: false },
  provides: ['tool' as const],
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

function operation(kind: 'inspect' | 'install' | 'trust' | 'enable' | 'update', installed = false) {
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

function client(options: { installed?: unknown[]; preview?: unknown; updated?: unknown } = {}): {
  value: NodeClient
  installs: () => number
  trusts: unknown[]
  enables: unknown[]
  updates: unknown[]
} {
  let installCalls = 0
  const trusts: unknown[] = []
  const enables: unknown[] = []
  const updates: unknown[] = []
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
          return {
            packages: options.installed ?? [
              { ...preview, trusted: false, desired: 'installed-disabled', actual: 'not-running' },
            ],
          }
        },
        async inspect() {
          return { operationId: 'inspect', profile }
        },
        async install() {
          installCalls++
          return { operationId: 'install', profile }
        },
        async trust(params: unknown) {
          trusts.push(params)
          return { operationId: 'trust', profile }
        },
        async enable(params: unknown) {
          enables.push(params)
          return { operationId: 'enable', profile }
        },
        async disable() {
          throw new Error('unused')
        },
        async update(params: unknown) {
          updates.push(params)
          return { operationId: 'update', profile }
        },
        async rollback() {
          throw new Error('unused')
        },
        async remove() {
          throw new Error('unused')
        },
        operation: {
          async get(params: PackageOperationGetParams) {
            return params.operationId === 'inspect'
              ? { ...operation('inspect'), preview: options.preview ?? preview }
              : params.operationId === 'update'
                ? { ...operation('update'), installed: options.updated }
                : params.operationId === 'trust'
                  ? operation('trust')
                  : params.operationId === 'enable'
                    ? operation('enable')
                    : operation('install', true)
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
    trusts,
    enables,
    updates,
  }
}

describe('package command', () => {
  it.each(['status', 'list'])(
    'prints parseable JSON for package %s --json including empty inventory',
    async (action) => {
      const fixture = client()
      for (const packages of [(await fixture.value.packages.list({ profile })).packages, []]) {
        vi.spyOn(fixture.value.packages, 'list').mockResolvedValue({ packages })
        const written: string[] = []
        await runPackageCommand(parseArgs(['package', action, '--json']), fixture.value, {
          write: (text) => written.push(text),
          confirm: async () => false,
        })
        expect(JSON.parse(written.join(''))).toEqual({ packages })
      }
    },
  )

  it('binds install to the preview and activates only the reviewed plugins add version', async () => {
    for (const argv of [
      ['install', source.ref],
      ['plugins', 'add', source.ref, '--yes'],
      ['install', './插件 space'],
      ['install', `.${sep}插件 space`],
      ['install', join(process.cwd(), '插件 space')],
      ['install', `file:${join(process.cwd(), '插件 space')}`],
      ['install', `path:${join(process.cwd(), '插件 space')}`],
    ]) {
      const fixture = client({ installed: [] })
      const inspect = vi.spyOn(fixture.value.packages, 'inspect').mockImplementation(async (input) => {
        expect(parseSource(input.source.ref)).toEqual(input.source)
        return { operationId: 'inspect', profile }
      })
      const written: string[] = []
      await runPackageCommand(parseArgs(argv), fixture.value, {
        write: (line) => written.push(line),
        confirm: async (value) => value.integrity === integrity,
      })
      expect(fixture.installs()).toBe(1)
      expect(inspect).toHaveBeenCalledOnce()
      expect(written.join('\n')).toContain(`capabilityHash ${preview.capabilityHash}`)
      expect(written.join('\n')).toContain('declared capabilities {"exec":["node"]}')
      expect(written.join('\n')).toContain('blockers none')
      expect(written.join('\n')).toContain('contributions tool')
      expect(written.join('\n')).toContain('desired installed-disabled; actual not-running; trusted false')
      if (argv[0] === 'plugins') {
        expect(written.join('\n').match(/install, trust and enable this reviewed version/g)).toHaveLength(1)
        expect(written.join('\n')).not.toContain('Installation will remain disabled and untrusted.')
        expect(fixture.trusts).toEqual([
          expect.objectContaining({
            expectedIntegrity: integrity,
            capabilityHash: preview.capabilityHash,
          }),
        ])
        expect(fixture.enables).toEqual([expect.objectContaining({ expectedInstalledIntegrity: integrity })])
      } else {
        expect(written.join('\n')).toContain('Installation will remain disabled and untrusted.')
        expect(fixture.trusts).toEqual([])
        expect(fixture.enables).toEqual([])
      }
    }
  })

  it('does not install after a rejected preview confirmation', async () => {
    const fixture = client({ installed: [] })
    const written: string[] = []
    await runPackageCommand(parseArgs(['package', 'add', source.ref]), fixture.value, {
      write: (line) => written.push(line),
      confirm: async () => false,
    })
    expect(fixture.installs()).toBe(0)
    expect(written.join('')).toContain('Installation cancelled.')
  })
})

describe('plugins add on an installed package', () => {
  const oldIntegrity = `sha256-${'c'.repeat(64)}`
  const installed = {
    ...operation('install', true).installed!,
    version: '0.9.0',
    integrity: oldIntegrity,
    trusted: true,
    desired: 'enabled' as const,
    actual: 'running' as const,
  }
  const running = { ...installed, version: '1.0.0', integrity }
  const run = async (argv: string[], options: Parameters<typeof client>[0], confirm = async () => true) => {
    const fixture = client(options)
    const written: string[] = []
    const result = runPackageCommand(parseArgs(argv), fixture.value, {
      write: (line) => written.push(line),
      confirm,
    })
    return { fixture, written, result }
  }
  const noWrites = (f: ReturnType<typeof client>) => {
    expect(f.installs()).toBe(0)
    expect(f.updates).toEqual([])
    expect(f.trusts).toEqual([])
    expect(f.enables).toEqual([])
  }

  it.each([
    ['upgrade with a capability change', '0.9.0', ['exec:node'], 'update example 0.9.0 → 1.0.0\n'],
    ['downgrade', '1.1.0', [], 'update example 1.1.0 → 1.0.0 (downgrade)'],
  ])('updates, trusts and enables the reviewed version: %s', async (_name, from, added, line) => {
    const next = { ...preview, capabilityDiff: { ...preview.capabilityDiff, added } }
    const { fixture, written, result } = await run(['plugins', 'add', source.ref, '--yes'], {
      installed: [{ ...installed, version: from }],
      preview: next,
      updated: { ...running, version: '1.0.0' },
    })
    await result
    expect(fixture.installs()).toBe(0)
    expect(fixture.updates).toEqual([
      expect.objectContaining({
        id: 'example',
        source,
        expectedIntegrity: integrity,
        activation: {
          expectedInstalledIntegrity: oldIntegrity,
          expectedActiveIntegrity: oldIntegrity,
          trust: { integrity, capabilityHash: preview.capabilityHash },
        },
      }),
    ])
    const text = written.join('\n')
    expect(text).toContain(line)
    expect(text).toContain(added.length ? 'capabilities added: exec:node' : 'capabilities unchanged')
    expect(text).toContain('update, trust and enable this reviewed version')
    expect(text).toContain('desired enabled; actual running; trusted true')
  })

  it('does nothing when the same version already runs', async () => {
    const { fixture, written, result } = await run(
      ['plugins', 'add', source.ref],
      {
        installed: [running],
      },
      async () => false,
    )
    await result
    noWrites(fixture)
    expect(written.join('\n')).toContain('nothing to do')
  })

  it.each([
    ['untrusted', { trusted: false, desired: 'installed-disabled', actual: 'not-running' }, 1, 1],
    ['failed', { actual: 'failed' }, 0, 1],
    ['disabled', { desired: 'installed-disabled', actual: 'not-running' }, 0, 1],
  ])('repairs the same version when it is %s', async (_name, state, trusts, enables) => {
    const { fixture, written, result } = await run(['plugins', 'add', source.ref, '--yes'], {
      installed: [{ ...running, ...state }],
    })
    await result
    expect(written.join('\n')).toContain('Confirmation will trust and enable this reviewed version.')
    expect(written.join('\n')).not.toContain('remain disabled and untrusted')
    expect(fixture.updates).toEqual([])
    expect(fixture.trusts).toHaveLength(trusts)
    expect(fixture.enables).toEqual(
      Array.from({ length: enables }, () =>
        expect.objectContaining({ expectedInstalledIntegrity: integrity }),
      ),
    )
  })

  it.each([
    [
      'restart-required',
      { ...installed, actual: 'restart-required' },
      preview,
      'E_GENERATION_RESTART_REQUIRED',
    ],
    [
      'blockers',
      installed,
      { ...preview, blockers: [{ code: 'dependency', references: ['dep'] }] },
      'blockers',
    ],
  ])('refuses without writing: %s', async (_name, current, next, message) => {
    const { fixture, result } = await run(['plugins', 'add', source.ref, '--yes'], {
      installed: [current],
      preview: next,
    })
    await expect(result).rejects.toThrow(message)
    noWrites(fixture)
  })

  it('cancels without writing when the update is not confirmed', async () => {
    const { fixture, written, result } = await run(
      ['plugins', 'add', source.ref],
      { installed: [installed] },
      async () => false,
    )
    await result
    noWrites(fixture)
    expect(written.join('')).toContain('cancelled')
  })

  it('fails with the reason when the updated version does not start', async () => {
    const { fixture, result } = await run(['plugins', 'add', source.ref, '--yes'], {
      installed: [installed],
      updated: { ...running, actual: 'failed', actualReason: 'factory exploded' },
    })
    await expect(result).rejects.toThrow(/factory exploded[\s\S]*agh plugins status/)
    expect(fixture.updates).toHaveLength(1)
  })

  it.each([['install'], ['package', 'add']])('points legacy `agh %s` at plugins add', async (...argv) => {
    const { fixture, result } = await run([...argv, source.ref, '--yes'], { installed: [installed] })
    await expect(result).rejects.toThrow(/already installed.*agh plugins add/)
    noWrites(fixture)
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

it('explains a dev folder outside the workspace without inspecting or activating it', async () => {
  const rpc = { packages: { list: async () => ({ packages: [] }) } } as unknown as NodeClient
  let error: unknown
  try {
    await runPluginDevelopmentCommand(
      parseArgs(['dev', '/isolated-home/plugins/example', '--cwd', '/workspace']),
      rpc,
      () => {},
    )
  } catch (failure) {
    error = failure
  }
  let message = ''
  const stderr = new Writable({
    write(chunk, _encoding, done) {
      message += String(chunk)
      done()
    },
  })
  expect(reportCommandFailure(error, 'dev', { env: {}, stderr })).toBe(1)
  expect(message).toContain('E_PLUGIN_RELOAD_SOURCE_SCOPE')
  expect(message).toContain('outside the workspace')
  expect(message).toContain('agh dev')
  expect(message).toContain('agh plugins reload')
  expect(message).not.toContain('/isolated-home')
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

it('trusts the installed hashes with --yes and refuses wrong hashes with expected/given values', async () => {
  for (const command of ['package', 'plugins']) {
    const fixture = client()
    const written: string[] = []
    const io = {
      write: (text: string) => written.push(text),
      confirm: async () => {
        throw new Error('must not prompt')
      },
    }
    await runPackageCommand(parseArgs([command, 'trust', 'example', '--yes']), fixture.value, io)
    expect(fixture.trusts).toEqual([
      expect.objectContaining({ expectedIntegrity: integrity, capabilityHash: preview.capabilityHash }),
    ])
    const wrong = 'c'.repeat(64)
    await expect(
      runPackageCommand(
        parseArgs([command, 'trust', 'example', integrity, wrong, '--yes']),
        fixture.value,
        io,
      ),
    ).rejects.toThrow(
      `expected integrity=${integrity} capabilityHash=${preview.capabilityHash}; given integrity=${integrity} capabilityHash=${wrong}`,
    )
    expect(fixture.trusts).toHaveLength(1)
    await runPackageCommand(parseArgs([command, 'enable', 'example', '--yes']), fixture.value, io)
    expect(fixture.enables).toEqual([expect.objectContaining({ expectedInstalledIntegrity: integrity })])
    expect(written.join('')).toContain('Requested capabilities: {"exec":["node"]}')
  }
})
