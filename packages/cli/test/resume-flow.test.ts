import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { operations } from '@agnes/code'
import { createTestHost } from '@agnes/host/testkit'
import type { Actor, InferenceEvent } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { bootLocal } from '../src/boot/local.js'
import { runPrint } from '../src/modes/print.js'
import { TuiApp } from '../src/tui/app.js'
import { FakeTerminal } from '../src/tui/terminal.js'
import { testDeps } from './boot-host.js'
import { screenOf } from './tui/harness.js'

const REQUESTER: Actor = { id: 'requester', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const APPROVER: Actor = { id: 'approver', org: 'local', role: 'admin', deptPath: [], attrs: {} }

function printIo(cwd: string) {
  const stdout = new PassThrough()
  const stderr = Object.assign(new PassThrough(), { isTTY: false })
  let out = ''
  let err = ''
  stdout.on('data', (chunk: Buffer) => {
    out += String(chunk)
  })
  stderr.on('data', (chunk: Buffer) => {
    err += String(chunk)
  })
  return {
    stdout,
    stderr,
    stdin: Object.assign(Readable.from([]), { isTTY: true }),
    cwd,
    out: () => out,
    err: () => err,
  }
}

/** The approval service is an allowed test seam; every layer around it is the real product chain. */
function parkedApproval(): {
  seam: {
    ask(request: { requestId: string; bindingHash: string }): Promise<{ ticket: string; expiresAt: string }>
    resume(ticket: string): Promise<{
      requestId: string
      bindingHash: string
      expiresAt: string
    } | null>
  }
  ticket: string
} {
  const ticket = '0123456789abcdef0123456789abcdef'
  let stored: { requestId: string; bindingHash: string; expiresAt: string } | null = null
  return {
    ticket,
    seam: {
      async ask(request) {
        const expiresAt = new Date(Date.now() + 60_000).toISOString()
        stored = { requestId: request.requestId, bindingHash: request.bindingHash, expiresAt }
        return { ticket, expiresAt }
      },
      async resume(got) {
        if (got !== ticket || !stored) return null
        const receipt = stored
        stored = null
        return receipt
      },
    },
  }
}

const toolCall = (): InferenceEvent[] => [
  {
    type: 'toolcall_end',
    via: 'native',
    call: {
      toolUseId: '',
      name: 'shell',
      args: { command: 'rm -rf tmp' },
      ordinal: 0,
    },
  },
  { type: 'done', reason: 'toolUse' },
]

const completion = (): InferenceEvent[] => [
  { type: 'text_delta', delta: 'approved continuation completed' },
  { type: 'done', reason: 'stop' },
]

describe('parked approval across the CLI one-shot boundary', () => {
  it('print reports the durable ticket and a reopened TUI decides it through Host/daemon/SDK/core', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-resume-flow-'))
    const approval = parkedApproval()
    let opens = 0
    const createHostImpl = async () => {
      const current = opens++
      return (
        await createTestHost({
          dataDir: home,
          packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
          packages: { '@agnes/code': { operations } },
          seams: {
            approval: approval.seam,
            principals: {
              resolve: async (_credential, surface) => (surface === 'approval' ? APPROVER : REQUESTER),
            },
          },
          script: current === 0 ? [toolCall()] : [completion()],
        })
      ).host
    }

    let first: Awaited<ReturnType<typeof bootLocal>> | undefined
    let second: Awaited<ReturnType<typeof bootLocal>> | undefined
    let app: TuiApp | undefined
    try {
      first = await bootLocal(parseArgs(['-p', 'clean']), testDeps(home, { createHostImpl }))
      const output = printIo(home)
      expect(await runPrint(first, parseArgs(['-p', 'clean']), output)).toBe(3)
      const match = /ticket=(\S+) session=(\S+)/.exec(output.out())
      expect(match?.[1]).toBe(approval.ticket)
      expect(output.err()).toContain('turn ended: parked (exit 3)')
      const sessionId = match?.[2]
      expect(sessionId).toEqual(expect.any(String))
      await first.close()
      first = undefined

      second = await bootLocal(
        parseArgs(['--resume', sessionId as string]),
        testDeps(home, { createHostImpl }),
      )
      const session = await second.client.session.load(sessionId as string, { cwd: home })
      const term = new FakeTerminal({ columns: 100, rows: 30 })
      app = new TuiApp({ session, term, header: 'Agnes' })
      await app.start()
      await vi.waitFor(async () =>
        expect((await screenOf(term, 100, 30)).join('\n')).toContain('Awaiting approval: shell'),
      )
      term.feed('1')
      await vi.waitFor(async () => {
        const timeline = await session.projectUI(undefined, { surface: 'tui' })
        expect(timeline.nodes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'approval',
              state: 'decided',
              decision: expect.objectContaining({ verdict: 'allowed-once' }),
            }),
          ]),
        )
      })
      await vi.waitFor(async () =>
        expect((await screenOf(term, 100, 30)).join('\n')).toContain('allowed-once'),
      )

      // A decision row alone is not a resumed tool. Queueing a fresh prompt exercises the real
      // SDK -> daemon -> reopened HostSession run path; Core must service the already-approved
      // continuation first, settle its tool effect, and finish that turn without consuming the
      // new prompt as if it were the approval continuation.
      const resumed = await session.prompt([
        { type: 'text', text: 'queued only after the approved continuation' },
      ])
      expect(resumed.reason).toBe('completed')
      const timeline = await session.projectUI(undefined, { surface: 'tui' })
      expect(timeline.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'tool',
            name: 'shell',
            status: expect.not.stringMatching('running'),
          }),
          expect.objectContaining({ kind: 'assistant', text: 'approved continuation completed' }),
        ]),
      )
    } finally {
      await app?.stop()
      await second?.close()
      await first?.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
