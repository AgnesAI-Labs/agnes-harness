import { PassThrough, Readable } from 'node:stream'
import { createClient, memoryJournal } from '@agnes/sdk'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { UsageError } from '../src/errors.js'
import { refuseWhatCannotBeHonoured, runPrint } from '../src/modes/print.js'
import { runTui } from '../src/modes/tui.js'
import type { Booted } from '../src/types.js'
import { FAKE_SESSION_ID, type FakeEndpoint, scriptedEndpoint } from './fake-endpoint.js'

// Deep Bug Hunt M-15. Oracle: print.ts's own refusal message "--preset cannot be applied to a resumed
// session: session/load takes no preset", and print.ts:77 / tui.ts:31 treating `resume <id>` exactly
// like `--resume <id>`. Tests assert the correct behaviour; a failure reproduces the defect.

async function booted(ep: FakeEndpoint): Promise<Booted> {
  const client = createClient({ transport: { kind: 'inproc', endpoint: ep }, journal: memoryJournal() })
  return {
    client,
    profileName: 'local-dev',
    resolvedProfileHash: 'h',
    bootMs: 1,
    form: 'local',
    close: () => client.close(),
  }
}

// Ends runTui right after its first draw, as tui-mode.test.ts does.
function tuiIO() {
  return {
    stdin: Object.assign(new PassThrough(), { setRawMode: (_raw: boolean) => undefined }),
    stdout: Object.assign(new PassThrough(), { columns: 80, rows: 24 }),
    env: { NO_COLOR: '1' },
    cwd: '/w',
    registerCancel: (_cancel: () => Promise<void>) => undefined,
    signal: () => 'SIGTERM' as const,
  }
}

function io() {
  return {
    stdout: new PassThrough(),
    stderr: Object.assign(new PassThrough(), { isTTY: false }),
    stdin: Object.assign(Readable.from([]), { isTTY: true }),
    cwd: '/w',
  }
}

describe('dbh M-15: `resume <id> --preset` refusal', () => {
  it('control: `--resume <id> --preset` is refused by the pure check', () => {
    expect(() =>
      refuseWhatCannotBeHonoured(parseArgs(['--resume', FAKE_SESSION_ID, '--preset', 'standard'])),
    ).toThrow(UsageError)
  })

  it('`resume <id> --preset` is refused by the pure check, like --resume', () => {
    expect(() =>
      refuseWhatCannotBeHonoured(parseArgs(['resume', FAKE_SESSION_ID, '--preset', 'standard'])),
    ).toThrow(UsageError)
  })

  it('control: runPrint refuses `--resume <id> --preset` before any session/load', async () => {
    const ep = scriptedEndpoint()
    const e = await runPrint(
      await booted(ep),
      parseArgs(['-p', 'q', '--resume', FAKE_SESSION_ID, '--preset', 'standard']),
      io(),
    ).catch((x: unknown) => x)
    expect(e).toMatchObject({ name: 'UsageError', code: 2 })
    expect(ep.calls.some((c) => c.method === 'session/load')).toBe(false)
  })

  it('runPrint refuses `resume <id> --preset` before any session/load (differential with --resume)', async () => {
    const ep = scriptedEndpoint()
    const outcome = await runPrint(
      await booted(ep),
      parseArgs(['resume', FAKE_SESSION_ID, '-p', 'q', '--preset', 'standard']),
      io(),
    ).then(
      (code) => ({ code }),
      (x: unknown) => ({ error: x }),
    )
    const loaded = ep.calls.filter((c) => c.method === 'session/load')
    expect({ outcome, loadCalls: loaded.length, loadParams: loaded[0]?.params }).toMatchObject({
      outcome: { error: { name: 'UsageError', code: 2 } },
      loadCalls: 0,
    })
  })

  it('runTui refuses `resume <id> --preset` before it takes the screen or opens a session', async () => {
    const ep = scriptedEndpoint()
    const tui = tuiIO()
    let written = ''
    tui.stdout.on('data', (chunk) => {
      written += String(chunk)
    })
    const outcome = await runTui(
      await booted(ep),
      parseArgs(['resume', FAKE_SESSION_ID, '--preset', 'standard']),
      tui,
    ).then(
      (code) => ({ code }),
      (x: unknown) => ({ error: x }),
    )
    const opened = ep.calls.filter((c) => c.method === 'session/load' || c.method === 'session/new')
    expect({ outcome, opened: opened.length, written }).toMatchObject({
      outcome: { error: { name: 'UsageError', code: 2 } },
      opened: 0,
      written: '',
    })
  })
})

describe('dbh M-15 preserved: `resume <id>` without --preset', () => {
  it('runPrint loads that session and sends the rest as the prompt', async () => {
    const ep = scriptedEndpoint()
    const code = await runPrint(await booted(ep), parseArgs(['resume', FAKE_SESSION_ID, '-p', 'go on']), io())
    const methods = ep.calls.map((c) => c.method)
    expect({
      code,
      loaded: methods.includes('session/load'),
      created: methods.includes('session/new'),
    }).toEqual({
      code: 0,
      loaded: true,
      created: false,
    })
    expect(ep.calls.find((c) => c.method === 'session/load')?.params).toMatchObject({
      sessionId: FAKE_SESSION_ID,
    })
    expect(JSON.stringify(ep.calls.find((c) => c.method === 'session/prompt')?.params)).toContain('"go on"')
  })

  it('runTui loads that session', async () => {
    const ep = scriptedEndpoint().on('_agnes/v1/session.projectUI', () => ({
      sessionId: FAKE_SESSION_ID,
      generation: 1,
      upto: 0,
      opState: null,
      turns: [],
      nodes: [],
    }))
    await expect(runTui(await booted(ep), parseArgs(['resume', FAKE_SESSION_ID]), tuiIO())).resolves.toBe(143)
    const methods = ep.calls.map((c) => c.method)
    expect({ loaded: methods.includes('session/load'), created: methods.includes('session/new') }).toEqual({
      loaded: true,
      created: false,
    })
    expect(ep.calls.find((c) => c.method === 'session/load')?.params).toMatchObject({
      sessionId: FAKE_SESSION_ID,
    })
  })
})
