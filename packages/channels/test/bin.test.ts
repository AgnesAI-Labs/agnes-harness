import { EventEmitter } from 'node:events'
import { constants, readFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { type ChannelMainDeps, type ChannelMainIO, main } from '../src/bin.js'
import { ChannelError } from '../src/errors.js'
import { loadManifest } from '../src/manifest.js'
import type { RunnerConfig } from '../src/runner/config.js'
import type { Runner } from '../src/runner/runner.js'
import { createFakeClient, FakeChannel } from '../testkit/index.js'

const manifestPath = fileURLToPath(new URL('../src/adapters/dingtalk/channel.json', import.meta.url))

it.each(['unix:', 'ws://', 'wss://', 'https://host'])(
  'rejects invalid --connect %s before reading secrets',
  async (target) => {
    const output = io()
    const dependencies = await deps()
    expect(
      await main(['dingtalk', '--config', 'runner.yaml', '--connect', target], output.value, dependencies),
    ).toBe(2)
    expect(dependencies.loadSecrets).not.toHaveBeenCalled()
    expect(output.stderr.join('')).toContain('--connect must be unix:<path> or ws[s]://<host>')
  },
)

it.each([
  ['unix:\\\\.\\pipe\\agnes-test', { kind: 'unix', path: '\\\\.\\pipe\\agnes-test' }],
  ['unix:/tmp/agnes.sock', { kind: 'unix', path: '/tmp/agnes.sock' }],
  ['wss://host/ws', { kind: 'ws', url: 'wss://host/ws' }],
])('passes parsed --connect %s to the client', async (target, connect) => {
  const output = io()
  const dependencies = await deps()
  expect(
    await main(
      ['dingtalk', '--config', 'runner.yaml', '--connect', target as string],
      output.value,
      dependencies,
    ),
  ).toBe(-1)
  expect(dependencies.createClient).toHaveBeenCalledWith(expect.objectContaining({ connect }), 'dingtalk')
})

it('rejects a remote --connect override instead of silently ignoring localDaemon', async () => {
  const output = io()
  const dependencies = await deps({
    loadConfig: vi.fn(async () => ({
      ...config,
      connect: { kind: 'unix' as const, path: '\\\\.\\pipe\\agnes-test' },
      localDaemon: { profile: 'local-dev' },
    })),
  })
  expect(
    await main(
      ['dingtalk', '--config', 'runner.yaml', '--connect', 'wss://host/ws'],
      output.value,
      dependencies,
    ),
  ).toBe(2)
  expect(dependencies.createClient).not.toHaveBeenCalled()
  expect(dependencies.loadSecrets).not.toHaveBeenCalled()
  expect(output.stderr.join('')).toContain('localDaemon requires')
})

const config: RunnerConfig = {
  channel: 'dingtalk',
  connect: { kind: 'unix', path: '/tmp/agnes.sock' },
  tenant: 'tenant',
  agent: 'agent',
  credentialsFile: '/private/dingtalk.env',
  allowFrom: [],
  requireMention: true,
  ackReaction: 'group-mentions',
  workspace: '/workspace',
  outbound: { costLine: true },
  directory: { sync: false },
  healthz: { enabled: false, port: 9877 },
}

function io() {
  const stdout: string[] = []
  const stderr: string[] = []
  const exits: number[] = []
  const signals = new EventEmitter()
  const value: ChannelMainIO = {
    stdout: { write: (chunk) => stdout.push(chunk) },
    stderr: { write: (chunk) => stderr.push(chunk) },
    signals,
    exit: (code) => exits.push(code),
  }
  return { value, stdout, stderr, exits, signals }
}

async function deps(overrides: Partial<ChannelMainDeps> = {}): Promise<ChannelMainDeps> {
  return {
    loadConfig: vi.fn(async () => structuredClone(config)),
    loadManifest: vi.fn(loadManifest),
    loadSecrets: vi.fn(async () => ({ clientId: 'client-id', clientSecret: 'super-secret' })),
    createAdapter: vi.fn(async () => new FakeChannel()),
    createClient: vi.fn(() => createFakeClient()),
    createRunner: vi.fn(() => runner()),
    verifyLive: vi.fn(async () => 0),
    ...overrides,
  }
}

function runner(overrides: Partial<Runner> = {}): Runner {
  return {
    start: vi.fn(async () => undefined),
    stopIntake: vi.fn(),
    stop: vi.fn(async () => undefined),
    status: () => ({ channel: 'connected', daemon: 'connected', sessions: 0, degraded: [] }),
    cache: {} as Runner['cache'],
    inbound: {} as Runner['inbound'],
    directorySupported: false,
    onEvent() {},
    ...overrides,
  }
}

describe('agnes-channel executable', () => {
  it('is exposed by package.json as an executable source with a shebang', async () => {
    const packagePath = new URL('../package.json', import.meta.url)
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { bin?: Record<string, string> }
    expect(packageJson.bin).toEqual({ 'agnes-channel': './src/bin.ts' })
    const binPath = new URL('../src/bin.ts', import.meta.url)
    expect(readFileSync(binPath, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env -S pnpm exec tsx')
    await expect(access(binPath, constants.X_OK)).resolves.toBeUndefined()
  })

  it('verify loads config, manifest and credentials without opening a daemon or channel', async () => {
    const output = io()
    const dependencies = await deps()
    await expect(
      main(['dingtalk', '--config', 'runner.yaml', '--verify'], output.value, dependencies),
    ).resolves.toBe(0)

    expect(dependencies.loadConfig).toHaveBeenCalledWith('runner.yaml')
    expect(dependencies.loadManifest).toHaveBeenCalledExactlyOnceWith(manifestPath)
    expect(dependencies.loadSecrets).toHaveBeenCalledOnce()
    expect(dependencies.createAdapter).not.toHaveBeenCalled()
    expect(dependencies.createClient).not.toHaveBeenCalled()
    expect(output.stdout).toEqual(['ok: dingtalk 0.1.0\n'])
  })

  it('applies CLI overrides, starts the runner and drains it on a signal', async () => {
    vi.stubEnv('AGNES_CHANNEL_STATE_DIR', '/var/lib/agnes/channels')
    const output = io()
    const active = runner()
    let received: RunnerConfig | undefined
    const dependencies = await deps({
      createClient: vi.fn((value) => {
        received = structuredClone(value)
        return createFakeClient()
      }),
      createRunner: vi.fn(() => active),
    })
    try {
      await expect(
        main(
          [
            'dingtalk',
            '--config',
            'runner.yaml',
            '--connect',
            'wss://daemon.example/ws',
            '--tenant',
            'other-tenant',
            '--agent',
            'other-agent',
          ],
          output.value,
          dependencies,
        ),
      ).resolves.toBe(-1)
    } finally {
      vi.unstubAllEnvs()
    }

    expect(received).toMatchObject({
      connect: { kind: 'ws', url: 'wss://daemon.example/ws' },
      tenant: 'other-tenant',
      agent: 'other-agent',
    })
    expect(dependencies.createRunner).toHaveBeenCalledWith(
      expect.objectContaining({ refsPath: join('/var/lib/agnes/channels', 'dingtalk', 'refs.sqlite') }),
    )
    expect(active.start).toHaveBeenCalledOnce()
    output.signals.emit('SIGTERM')
    await vi.waitFor(() => expect(active.stop).toHaveBeenCalledOnce())
    expect(active.stopIntake).toHaveBeenCalledOnce()
    expect(active.stop).toHaveBeenCalledWith({ drainMs: 5_000 })
    expect(output.exits).toEqual([0])
  })

  it('delegates live verification arguments without claiming that an enterprise run passed', async () => {
    const output = io()
    const verifyLive = vi.fn(async () => 1)
    const dependencies = await deps({ verifyLive })
    await expect(
      main(
        ['dingtalk', '--config', 'runner.yaml', '--verify-live', '--chat', 'cid1', '--simulate-disconnect'],
        output.value,
        dependencies,
      ),
    ).resolves.toBe(1)
    expect(verifyLive).toHaveBeenCalledWith([
      '--config',
      'runner.yaml',
      '--chat',
      'cid1',
      '--simulate-disconnect',
    ])
  })

  it('prints one redacted ChannelError line and returns 2 when startup fails', async () => {
    const output = io()
    const dependencies = await deps({
      createRunner: vi.fn(() =>
        runner({
          start: vi.fn(async () => {
            throw new ChannelError('E_CONNECT_FAILED', 'super-secret was rejected')
          }),
        }),
      ),
    })
    await expect(main(['dingtalk', '--config', 'runner.yaml'], output.value, dependencies)).resolves.toBe(2)
    expect(output.stderr).toEqual(['E_CONNECT_FAILED: *** was rejected\n'])
  })
})
