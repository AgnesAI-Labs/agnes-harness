import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createLocalEndpoint } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import { createClient, memoryJournal } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { runTui } from '../src/modes/tui.js'
import type { Booted } from '../src/types.js'
import { say } from './boot-host.js'
import { FAKE_SESSION_ID, type FakeEndpoint, scriptedEndpoint } from './fake-endpoint.js'

async function booted(endpoint: FakeEndpoint): Promise<Booted> {
  const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
  return {
    client,
    profileName: 'local-dev',
    resolvedProfileHash: 'h',
    bootMs: 1,
    form: 'local',
    close: () => client.close(),
  }
}

function tuiIO() {
  const stdin = Object.assign(new PassThrough(), {
    setRawMode: (_raw: boolean) => undefined,
  })
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
  return {
    stdin,
    stdout,
    env: { NO_COLOR: '1' },
    cwd: '/w',
    registerCancel: (_cancel: () => Promise<void>) => undefined,
    // End just after the first successful draw. This keeps the test focused on session setup,
    // rather than having an interactive terminal loop hold it open.
    signal: () => 'SIGTERM' as const,
  }
}

describe('runTui model selection', () => {
  it('renders the profile branding returned through the SDK contract', async () => {
    const endpoint = scriptedEndpoint().on('_agnes/v1/apis.list', () => ({
      profile: {
        name: 'local-dev',
        resolvedProfileHash: 'h',
        presets: { default: 'standard', allowed: ['standard'] },
        branding: { accent: '#00875A', mark: 'acme', selfLabel: 'Acme Workbench' },
      },
      families: [],
    }))
    const io = tuiIO()
    let rendered = ''
    io.stdout.on('data', (chunk) => {
      rendered += String(chunk)
    })

    await expect(runTui(await booted(endpoint), parseArgs([]), io)).resolves.toBe(143)
    expect(rendered).toContain('Acme Workbench ·ᴗ·')
    expect(rendered).toContain('local-dev · (default)')
    expect(rendered).toContain('acme · local-dev · (default)')
    expect(rendered).not.toContain('Agnes AI')
  })

  it('propagates AGNES_LOCALE and LANG through runTui into the rendered status chrome', async () => {
    const renderWith = async (env: NodeJS.ProcessEnv): Promise<string> => {
      const endpoint = scriptedEndpoint().on('_agnes/v1/session.projectUI', () => ({
        sessionId: FAKE_SESSION_ID,
        generation: 1,
        upto: 0,
        opState: {
          turn: 1,
          step: 2,
          phase: 'parked',
          parked: { ticket: 'tk-abcdefgh', expiresAt: '2026-09-12T00:00:00.000Z' },
        },
        turns: [],
        nodes: [],
      }))
      const io = tuiIO()
      io.env = { ...io.env, ...env }
      let rendered = ''
      io.stdout.on('data', (chunk) => {
        rendered += String(chunk)
      })
      await expect(runTui(await booted(endpoint), parseArgs([]), io)).resolves.toBe(143)
      await endpoint.close()
      return rendered
    }

    const fromLang = await renderWith({ LANG: 'zh_CN.UTF-8' })
    expect(fromLang).toContain('挂起 tk-abcde…')
    const explicitEnglish = await renderWith({ AGNES_LOCALE: 'en', LANG: 'zh_CN.UTF-8' })
    expect(explicitEnglish).toContain('parked tk-abcde…')
    expect(explicitEnglish).not.toContain('挂起 tk-abcde…')
  })

  it('does not replay a stale workspace queue after restart and sends the next message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-tui-restart-'))
    const { host } = await createTestHost({
      dataDir: dir,
      script: [say('fresh answer one'), say('fresh answer two')],
    })
    const endpoint = createLocalEndpoint(host, { pollMs: 5 })
    const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
    let raw = false
    try {
      // This is the session shape old CLI launches reused. Leave a next-turn item in it exactly as
      // the reported failure did, then start the real TUI in the same cwd.
      await client.workspace.add(dir)
      const stale = await client.session.new({ cwd: dir })
      await stale.followUp('stale queued message')

      const stdin = Object.assign(new PassThrough(), {
        setRawMode: (value: boolean) => {
          raw = value
        },
      })
      const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
      let rendered = ''
      stdout.on('data', (chunk) => {
        rendered += String(chunk)
      })
      const running = runTui(
        {
          client,
          profileName: host.profile.name,
          resolvedProfileHash: host.profile.hash ?? 'h',
          bootMs: 1,
          form: 'local',
          close: () => client.close(),
        },
        parseArgs([]),
        {
          stdin,
          stdout,
          env: { NO_COLOR: '1' },
          cwd: dir,
          registerCancel: () => undefined,
          signal: () => undefined,
        },
      )

      await vi.waitFor(() => expect(raw).toBe(true))
      for (const char of 'fresh prompt one') stdin.write(char)
      stdin.write('\r')
      for (const char of 'fresh prompt two') stdin.write(char)
      stdin.write('\r')
      await vi.waitFor(() => expect(rendered).toContain('fresh answer two'))
      expect(rendered).toContain('fresh prompt one')
      expect(rendered).toContain('fresh prompt two')
      expect(rendered).not.toContain('stale queued message')

      stdin.write('\x03')
      stdin.write('\x03')
      await expect(running).resolves.toBe(0)
    } finally {
      await client.close()
      await endpoint.close()
      await host.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates a fresh conversation instead of reopening the workspace singleton', async () => {
    const endpoint = scriptedEndpoint().on('_agnes/v1/session.projectUI', () => ({
      sessionId: FAKE_SESSION_ID,
      generation: 1,
      upto: 0,
      opState: null,
      turns: [],
      nodes: [],
    }))

    await expect(runTui(await booted(endpoint), parseArgs([]), tuiIO())).resolves.toBe(143)

    const call = endpoint.calls.find((entry) => entry.method === 'session/new')
    expect(call?.params).toMatchObject({
      cwd: '/w',
      _meta: {
        'ai.agnes.harness': {
          sessionKey: expect.stringMatching(/^agnes:local:local-dev:cli:session:[0-9a-f-]{36}$/),
        },
      },
    })
  })

  it('sets a chosen model on a new session before starting the app', async () => {
    const endpoint = scriptedEndpoint()
      .on('_agnes/v1/session.setModel', () => ({ effectiveFromSeq: 1 }))
      .on('_agnes/v1/session.projectUI', () => ({
        sessionId: FAKE_SESSION_ID,
        generation: 1,
        upto: 0,
        opState: null,
        turns: [],
        nodes: [],
      }))

    await expect(
      runTui(await booted(endpoint), parseArgs(['--model', 'primary=chosen-route/chosen-model']), tuiIO()),
    ).resolves.toBe(143)

    const call = endpoint.calls.find((entry) => entry.method === '_agnes/v1/session.setModel')
    expect(call?.params).toMatchObject({
      sessionId: FAKE_SESSION_ID,
      slot: 'primary',
      route: 'chosen-route',
      model: 'chosen-model',
    })
    expect(
      endpoint.calls.findIndex((entry) => entry.method === '_agnes/v1/session.setModel'),
    ).toBeGreaterThan(endpoint.calls.findIndex((entry) => entry.method === 'session/new'))
  })

  it('does not rewrite the historical model of a resumed session', async () => {
    const endpoint = scriptedEndpoint()
      .on('_agnes/v1/session.setModel', () => ({ effectiveFromSeq: 1 }))
      .on('_agnes/v1/session.projectUI', () => ({
        sessionId: FAKE_SESSION_ID,
        generation: 1,
        upto: 0,
        opState: null,
        turns: [],
        nodes: [],
      }))

    await expect(
      runTui(
        await booted(endpoint),
        parseArgs(['--resume', FAKE_SESSION_ID, '--model', 'primary=chosen-route/chosen-model']),
        tuiIO(),
      ),
    ).resolves.toBe(143)

    expect(endpoint.calls.map((entry) => entry.method)).toContain('session/load')
    expect(endpoint.calls.map((entry) => entry.method)).not.toContain('_agnes/v1/session.setModel')
  })

  it('--continue loads the most recently active session in this directory', async () => {
    const endpoint = scriptedEndpoint()
      .on('_agnes/v1/session.list', () => ({
        items: [
          { sessionId: FAKE_SESSION_ID, createdAt: 't', lastSeq: 1, generation: 1, preset: 'standard' },
        ],
      }))
      .on('_agnes/v1/session.projectUI', () => ({
        sessionId: FAKE_SESSION_ID,
        generation: 1,
        upto: 0,
        opState: null,
        turns: [],
        nodes: [],
      }))

    await expect(runTui(await booted(endpoint), parseArgs(['--continue']), tuiIO())).resolves.toBe(143)

    expect(endpoint.calls.find((entry) => entry.method === 'session/load')?.params).toMatchObject({
      sessionId: FAKE_SESSION_ID,
    })
    expect(endpoint.calls.map((entry) => entry.method)).not.toContain('session/new')
  })
})
