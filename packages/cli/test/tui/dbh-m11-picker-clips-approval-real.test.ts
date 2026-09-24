// Deep Bug Hunt M-11, second independent dynamic source (adversarial-tester, group B).
// Real SDK + local daemon endpoint + core + @agnes/base approval seam + @agnes/code `write` tool.
// Observation is the real side effect (the file the approved write creates), not an RPC record.
// Assertions describe CORRECT behaviour: a failure on the current code is the reproduction.
// Oracle: INV-14 / permission-modal.test.ts "blocks unseen positive choices".
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stampFor } from '@agnes/ai/testkit'
import { presets as basePresets, seams as baseSeams } from '@agnes/base'
import { presets as codePresets, operations, PRESET_NAMES } from '@agnes/code'
import { createLocalEndpoint, createPrompterBridge } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import type { InferenceEvent, RequestBody } from '@agnes/protocol'
import { createClient } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/tui/app.js'
import { freshTuiSessionKey } from '../../src/tui/session-key.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { screenOf } from './harness.js'

const COLS = 80
const ROWS = 24
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function scenario(openPicker: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'dbh-m11-real-'))
  let calls = 0
  let armed = false
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const turns: InferenceEvent[][] = [
    [
      { type: 'text_delta', delta: 'hello back' },
      { type: 'done', reason: 'stop' },
    ],
    [
      {
        type: 'toolcall_end',
        via: 'native',
        call: {
          toolUseId: '',
          name: 'write',
          args: { path: 'receipt.txt', content: 'approved' },
          ordinal: 0,
        },
      },
      { type: 'done', reason: 'toolUse' },
    ],
    [
      { type: 'text_delta', delta: 'finished' },
      { type: 'done', reason: 'stop' },
    ],
  ]
  const bridge = createPrompterBridge()
  const { host } = await createTestHost({
    dataDir: root,
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)) },
    packages: {
      '@agnes/base': { seams: { approval: baseSeams.approval }, presets: basePresets },
      '@agnes/code': { operations },
    },
    presets: {
      ...codePresets,
      standard: { ...codePresets.standard, name: 'standard', approval: { command_policy: [] } },
    },
    allowed: [...PRESET_NAMES],
    prompter: (request, options) => bridge.prompter.ask(request, options),
    provider: {
      models: () => [],
      async *infer(req: RequestBody) {
        const n = armed ? ++calls : 0
        yield {
          type: 'sent',
          stamp: stampFor(req),
        }
        if (n === 0) {
          yield { type: 'text_delta', delta: 'setup' }
          yield { type: 'done', reason: 'stop' }
          return
        }
        // The second inference (the write request) waits so the user can open /resume meanwhile.
        if (n === 2) await gate
        for (const event of turns[Math.min(n, turns.length) - 1] ?? []) yield event
      },
    },
  })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  bridge.bind(endpoint.prompter)
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  // /resume and /new resolve against process.cwd(); the test host only trusts its dataDir.
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
  let app: TuiApp | undefined
  try {
    // Enough other durable sessions for the picker to reach its maximum height.
    await client.workspace.add(root)
    for (let i = 0; i < 18; i++) {
      const other = await client.session.new({ cwd: root, sessionKey: freshTuiSessionKey('dbh') })
      await other.prompt(`other ${i}`).catch(() => undefined)
    }
    const session = await client.session.new({ cwd: root, sessionKey: freshTuiSessionKey('dbh-main') })
    armed = true
    const term = new FakeTerminal({ columns: COLS, rows: ROWS })
    app = new TuiApp({ session, term, profile: 'local-dev', preset: 'standard' })
    await app.start()
    const screen = async () => (await screenOf(term, COLS, ROWS)).join('\n')
    await app.submit('hello')
    await vi.waitFor(async () => expect(await screen()).toContain('hello back'))
    term.feed('write the receipt')
    term.feed('\r')
    await vi.waitFor(() => expect(calls).toBe(2))
    if (openPicker) {
      term.feed('/resume')
      term.feed('\r')
      await vi.waitFor(async () => expect(await screen()).toContain('Select Session'), { timeout: 5_000 })
    }
    release()
    const modal = app as unknown as { modal: { handleInput(data: string): boolean; questions: unknown[] } }
    await vi.waitFor(() => expect(modal.modal.questions.length).toBe(1), { timeout: 5_000 })
    await vi.waitFor(async () => expect(await screen()).toMatch(/\d\. reject_once/))
    const before = await screen()
    term.feed('1')
    await sleep(800)
    return {
      allowOnceOnScreen: before.includes('allow_once'),
      pickerOnScreen: before.includes('Select Session'),
      usageRowOnScreen: before.includes('Σ'),
      written: existsSync(join(root, 'receipt.txt')),
      screen: before,
    }
  } finally {
    release()
    cwd.mockRestore()
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
}

it('[control/real] no picker: allow_once is visible and digit 1 performs the approved write', async () => {
  const seen = await scenario(false)
  expect(seen.allowOnceOnScreen, seen.screen).toBe(true)
  expect(seen.written, seen.screen).toBe(true)
}, 30_000)

it('[M-11/real] picker open: digit 1 performs the write only when allow_once is on screen', async () => {
  const seen = await scenario(true)
  // Before the fix the picker clipped allow_once off the top and digit 1 still wrote the file.
  expect(seen.written, `${JSON.stringify({ ...seen, screen: undefined })}\n${seen.screen}`).toBe(
    seen.allowOnceOnScreen,
  )
}, 30_000)
