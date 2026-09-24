import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createLocalEndpoint } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import { createClient, type JsonRpcMessage, memoryJournal, type RpcEndpoint } from '@agnes/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { runTui } from '../src/modes/tui.js'
import { FAKE_SESSION_ID, scriptedEndpoint } from './fake-endpoint.js'

// Deep Bug Hunt M-05. Oracles: misc-commands.test.ts:365-368 ("the process's actual cwd and the --cwd
// flag's value can differ, and only the flag should win (matching every other command in bin.ts)");
// runTui opens its initial session with io.cwd (= p.cwd ?? io.cwd from bin.ts); daemon's session/load
// ID_CONFLICT contract for a session reopened under a different workspace. Tests assert the correct
// behaviour; a failure reproduces the defect.

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmp.push(d)
  return d
}

function ttyIO(cwd: string) {
  let raw = false
  let rendered = ''
  const stdin = Object.assign(new PassThrough(), {
    setRawMode: (value: boolean) => {
      raw = value
    },
  })
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30 })
  stdout.on('data', (chunk) => {
    rendered += String(chunk)
  })
  return {
    io: {
      stdin,
      stdout,
      env: { NO_COLOR: '1' },
      cwd,
      registerCancel: () => undefined,
      signal: () => undefined,
    },
    raw: () => raw,
    rendered: () => rendered,
    type: (text: string) => {
      for (const ch of text) stdin.write(ch)
      stdin.write('\r')
    },
  }
}

describe('dbh M-05: TUI slash session commands honour the launch --cwd', () => {
  it('/new opens its session in the --cwd workspace, like the initial session (FakeEndpoint)', async () => {
    const workspace = scratch('dbh-m05-cwd-')
    expect(process.cwd()).not.toBe(workspace)
    const endpoint = scriptedEndpoint().on('_agnes/v1/session.projectUI', () => ({
      sessionId: FAKE_SESSION_ID,
      generation: 1,
      upto: 0,
      opState: null,
      turns: [],
      nodes: [],
    }))
    const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
    const t = ttyIO(workspace)
    const running = runTui(
      {
        client,
        profileName: 'local-dev',
        resolvedProfileHash: 'h',
        bootMs: 1,
        form: 'local',
        close: () => client.close(),
      },
      parseArgs(['--cwd', workspace]),
      t.io,
    )
    try {
      await vi.waitFor(() => expect(t.raw()).toBe(true))
      const newCalls = () => endpoint.calls.filter((c) => c.method === 'session/new')
      // Control: the initial session uses the launch cwd.
      expect(newCalls()[0]?.params).toMatchObject({ cwd: workspace })
      t.type('/new')
      await vi.waitFor(() => expect(newCalls().length).toBe(2), { timeout: 3000 })
      expect((newCalls()[1]?.params as { cwd: string } | undefined)?.cwd).toBe(workspace)
    } finally {
      t.io.stdin.write('\x03')
      t.io.stdin.write('\x03')
      await running.catch(() => undefined)
      await client.close()
    }
  })

  it('a /resume picker choice loads its session in the --cwd workspace (FakeEndpoint)', async () => {
    const workspace = scratch('dbh-m05-picker-')
    expect(realpathSync(process.cwd())).not.toBe(realpathSync(workspace))
    const other = 'agnes:local:default:cli:session:other'
    const endpoint = scriptedEndpoint()
      .on('_agnes/v1/session.projectUI', (params) => ({
        sessionId: (params as { sessionId: string }).sessionId,
        generation: 1,
        upto: 0,
        opState: null,
        turns: [],
        nodes: [],
      }))
      .on('_agnes/v1/session.list', () => ({
        items: [
          {
            sessionId: other,
            createdAt: '2026-09-16T02:00:00Z',
            lastSeq: 0,
            generation: 1,
            preset: 'standard',
            title: 'Other work',
          },
        ],
      }))
    const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
    const t = ttyIO(workspace)
    const running = runTui(
      {
        client,
        profileName: 'local-dev',
        resolvedProfileHash: 'h',
        bootMs: 1,
        form: 'local',
        close: () => client.close(),
      },
      parseArgs(['--cwd', workspace]),
      t.io,
    )
    try {
      await vi.waitFor(() => expect(t.raw()).toBe(true))
      t.type('/resume')
      await vi.waitFor(() => expect(t.rendered()).toContain('Other work'), { timeout: 3000 })
      t.io.stdin.write('\r')
      const loads = () => endpoint.calls.filter((c) => c.method === 'session/load')
      await vi.waitFor(() => expect(loads().length).toBe(1), { timeout: 3000 })
      const params = loads()[0]?.params as { sessionId: string; cwd: string }
      expect(params.sessionId).toBe(other)
      expect(realpathSync(params.cwd)).toBe(realpathSync(workspace))
    } finally {
      t.io.stdin.write('\x03')
      t.io.stdin.write('\x03')
      await running.catch(() => undefined)
      await client.close()
    }
  })

  it('@ completion lists entries of the --cwd workspace (FakeEndpoint)', async () => {
    const workspace = scratch('dbh-m05-complete-')
    writeFileSync(join(workspace, 'dbh-m05-marker.txt'), '')
    expect(realpathSync(process.cwd())).not.toBe(realpathSync(workspace))
    const endpoint = scriptedEndpoint().on('_agnes/v1/session.projectUI', () => ({
      sessionId: FAKE_SESSION_ID,
      generation: 1,
      upto: 0,
      opState: null,
      turns: [],
      nodes: [],
    }))
    const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
    const t = ttyIO(workspace)
    const running = runTui(
      {
        client,
        profileName: 'local-dev',
        resolvedProfileHash: 'h',
        bootMs: 1,
        form: 'local',
        close: () => client.close(),
      },
      parseArgs(['--cwd', workspace]),
      t.io,
    )
    try {
      await vi.waitFor(() => expect(t.raw()).toBe(true))
      for (const ch of '@dbh-m05-mark') t.io.stdin.write(ch)
      t.io.stdin.write('\t')
      t.io.stdin.write('\r')
      const prompts = () => endpoint.calls.filter((c) => c.method === 'session/prompt')
      await vi.waitFor(() => expect(prompts().length).toBe(1), { timeout: 3000 })
      const params = prompts()[0]?.params as { prompt: Array<{ type: string; name?: string }> } | undefined
      const links = params?.prompt.filter((b) => b.type === 'resource_link').map((b) => b.name)
      expect(links).toEqual(['dbh-m05-marker.txt'])
    } finally {
      t.io.stdin.write('\x03')
      t.io.stdin.write('\x03')
      await running.catch(() => undefined)
      await client.close()
    }
  })

  it('/resume <id> of a session created in the --cwd workspace succeeds (real daemon endpoint + host)', async () => {
    const dataDir = scratch('dbh-m05-data-')
    // createTestHost fences its sandbox at dataDir, so the workspace is the data directory itself.
    const workspace = dataDir
    expect(realpathSync(process.cwd())).not.toBe(realpathSync(workspace))
    const { host } = await createTestHost({ dataDir, script: [] })
    const real = createLocalEndpoint(host, { pollMs: 5 })
    const loads: Array<{ params: unknown; response: unknown }> = []
    const recording: RpcEndpoint = {
      handle: async (msg: JsonRpcMessage) => {
        const response = await real.handle(msg)
        if ((msg as { method?: string }).method === 'session/load')
          loads.push({ params: (msg as { params?: unknown }).params, response })
        return response
      },
      get notifications() {
        return real.notifications
      },
      close: () => real.close(),
    }
    const client = createClient({
      transport: { kind: 'inproc', endpoint: recording },
      journal: memoryJournal(),
    })
    let running: Promise<number> | undefined
    const t = ttyIO(workspace)
    try {
      await client.workspace.add(workspace)
      const earlier = await client.session.new({ cwd: workspace })
      const earlierId = earlier.id
      await earlier.detach().catch(() => undefined)

      running = runTui(
        {
          client,
          profileName: host.profile.name,
          resolvedProfileHash: host.profile.hash ?? 'h',
          bootMs: 1,
          form: 'local',
          close: () => client.close(),
        },
        parseArgs(['--cwd', workspace]),
        t.io,
      )
      await vi.waitFor(() => expect(t.raw()).toBe(true))
      t.type(`/resume ${earlierId}`)
      await vi.waitFor(() => expect(loads.length).toBe(1), { timeout: 5000 })
      const load = loads[0] as { params: { cwd: string }; response: { error?: { data?: { code?: string } } } }
      expect({
        loadCwd: realpathSync(load.params.cwd),
        error: load.response.error?.data?.code ?? null,
      }).toEqual({ loadCwd: realpathSync(workspace), error: null })
    } finally {
      t.io.stdin.write('\x03')
      t.io.stdin.write('\x03')
      await running?.catch(() => undefined)
      await client.close()
      await real.close()
      await host.close()
    }
  })

  it('control: the same session reopened through runTui --resume (io.cwd) loads without ID_CONFLICT', async () => {
    const dataDir = scratch('dbh-m05-data-ctl-')
    const workspace = dataDir
    const { host } = await createTestHost({ dataDir, script: [] })
    const real = createLocalEndpoint(host, { pollMs: 5 })
    const loads: Array<{ params: unknown; response: unknown }> = []
    const recording: RpcEndpoint = {
      handle: async (msg: JsonRpcMessage) => {
        const response = await real.handle(msg)
        if ((msg as { method?: string }).method === 'session/load')
          loads.push({ params: (msg as { params?: unknown }).params, response })
        return response
      },
      get notifications() {
        return real.notifications
      },
      close: () => real.close(),
    }
    const client = createClient({
      transport: { kind: 'inproc', endpoint: recording },
      journal: memoryJournal(),
    })
    let running: Promise<number> | undefined
    const t = ttyIO(workspace)
    try {
      await client.workspace.add(workspace)
      const earlier = await client.session.new({ cwd: workspace })
      const earlierId = earlier.id
      await earlier.detach().catch(() => undefined)
      running = runTui(
        {
          client,
          profileName: host.profile.name,
          resolvedProfileHash: host.profile.hash ?? 'h',
          bootMs: 1,
          form: 'local',
          close: () => client.close(),
        },
        parseArgs(['--cwd', workspace, '--resume', earlierId]),
        t.io,
      )
      await vi.waitFor(() => expect(loads.length).toBe(1), { timeout: 5000 })
      const load = loads[0] as { params: { cwd: string }; response: { error?: unknown } }
      expect(realpathSync(load.params.cwd)).toBe(realpathSync(workspace))
      expect(load.response.error).toBeUndefined()
      await vi.waitFor(() => expect(t.raw()).toBe(true))
    } finally {
      t.io.stdin.write('\x03')
      t.io.stdin.write('\x03')
      await running?.catch(() => undefined)
      await client.close()
      await real.close()
      await host.close()
    }
  })
})
