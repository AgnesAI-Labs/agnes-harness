import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { presets as basePresets } from '@agnes/base'
import { presets as codePresets, operations, PRESET_NAMES } from '@agnes/code'
import { createLocalEndpoint, createPrompterBridge } from '@agnes/daemon/local'
import { baseSeamFactories, createTestHost } from '@agnes/host/testkit'
import { createClient } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { screenOf } from './harness.js'

/** A real in-process daemon (real Host, real checkpoint seam) with a model that writes one file. */
it.each(['overwrite', 'create'])(
  'the model writes a file (%s), /undo previews, /undo confirm restores it and a replay changes nothing',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-undo-flow-'))
    const bridge = createPrompterBridge()
    const file = join(root, 'report.txt')
    if (mode === 'overwrite') writeFileSync(file, 'before')
    const { host } = await createTestHost({
      dataDir: root,
      packageDirs: { '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)) },
      packages: {
        '@agnes/base': {
          seams: { approval: baseSeamFactories.approval, checkpoint: baseSeamFactories.checkpoint },
          presets: basePresets,
        },
        '@agnes/code': { operations },
      },
      presets: {
        ...codePresets,
        standard: { ...codePresets.standard, name: 'standard', approval: { command_policy: [] } },
      },
      allowed: [...PRESET_NAMES],
      prompter: (request, options) => bridge.prompter.ask(request, options),
      script: [
        ...(mode === 'overwrite'
          ? [
              [
                {
                  type: 'toolcall_end' as const,
                  via: 'native' as const,
                  call: { toolUseId: '', name: 'read', args: { path: 'report.txt' }, ordinal: 0 },
                },
                { type: 'done' as const, reason: 'toolUse' as const },
              ],
            ]
          : []),
        [
          {
            type: 'toolcall_end',
            via: 'native',
            call: {
              toolUseId: '',
              name: 'write',
              args: { path: 'report.txt', content: 'after' },
              ordinal: 0,
            },
          },
          { type: 'done', reason: 'toolUse' },
        ],
        [
          { type: 'text_delta', delta: 'finished' },
          { type: 'done', reason: 'stop' },
        ],
      ],
    })
    const endpoint = createLocalEndpoint(host, { pollMs: 5 })
    bridge.bind(endpoint.prompter)
    const client = createClient({ transport: { kind: 'inproc', endpoint } })
    let app: TuiApp | undefined
    const screen = async (term: FakeTerminal) => {
      // Replay one captured byte stream: awaiting every render separately can outlive waitFor's
      // deadline and report a frame captured before the async preview completed.
      const captured = new FakeTerminal({ columns: 100, rows: 35 })
      captured.write(term.writes.join(''))
      return (await screenOf(captured, 100, 35)).join('\n')
    }
    try {
      await client.workspace.add(root)
      const session = await client.session.new({ cwd: root })
      const term = new FakeTerminal({ columns: 100, rows: 35 })
      app = new TuiApp({ session, term, header: 'Agnes' })
      await app.start()
      const turn = app.submit('write the report').catch((error: unknown) => error)
      await vi.waitFor(async () => expect(await screen(term)).toContain('Approval: Write file'), {
        timeout: 10_000,
      })
      // Approval keys count only after the card has sat untouched for 600 ms (approval-settle.ts).
      await new Promise((resolve) => setTimeout(resolve, 700))
      term.feed('1')
      expect(await turn).toBeUndefined()
      expect(readFileSync(file, 'utf8')).toBe('after')

      if (mode === 'create') {
        term.feed('/undo')
        term.feed('\r')
      } else {
        // Await the public command before replaying the terminal in the SDK retry scenario.
        // The create scenario still exercises preview and confirmation through real key input.
        await app.runInput('/undo')
      }
      await vi.waitFor(async () => expect(await screen(term)).toContain('Turn 1 changed 1 file(s)'))
      expect(readFileSync(file, 'utf8')).toBe('after')

      let first: unknown
      if (mode === 'create') {
        // The TUI path: the preview above, then the confirmation.
        term.feed('/undo confirm')
        term.feed('\r')
        await vi.waitFor(() => expect(existsSync(file)).toBe(false))
        await vi.waitFor(async () => expect(await screen(term)).toContain('Undid the file changes of turn 1'))
        await expect(session.undo(1)).rejects.toMatchObject({ data: { code: 'UNDO_ALREADY_DONE' } })
      } else {
        // One commandId is answered once and applied once, however often it is retried.
        first = await session.undo(1, { commandId: 'undo-e2e' })
        expect(first).toMatchObject({ turn: 1, restored: ['report.txt'], failed: [], conflicts: [] })
        expect(readFileSync(file, 'utf8')).toBe('before')
        writeFileSync(file, 'edited later')
        expect(await session.undo(1, { commandId: 'undo-e2e' })).toEqual(first)
        expect(readFileSync(file, 'utf8')).toBe('edited later')
      }
      expect(await session.undoPreview()).toMatchObject({ undoable: false, files: [] })
      expect(await session.undoPreview(1)).toMatchObject({ undoable: false, blockedBy: 'already-undone' })
      const nodes = (await session.projectUI()).nodes
      expect(nodes).toContainEqual(
        expect.objectContaining({ kind: 'workspace-undo', turn: 1, restored: 1, failed: 0, conflicts: 0 }),
      )
    } finally {
      try {
        await app?.stop()
      } finally {
        try {
          await client.close()
        } finally {
          try {
            await endpoint.close()
          } finally {
            await host.close()
            rmSync(root, { recursive: true, force: true })
          }
        }
      }
    }
  },
  30_000,
)
