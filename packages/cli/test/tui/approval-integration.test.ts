import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { presets as basePresets, seams as baseSeams } from '@agnes/base'
import { presets as codePresets, operations, PRESET_NAMES } from '@agnes/code'
import { createLocalEndpoint, createPrompterBridge } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import { createClient, TransportClosed } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { screenOf } from './harness.js'

it.each(['allow', 'reject', 'stop', 'disconnect', 'paged_allow'])(
  'actual write permission is decided by terminal input: %s',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-tui-approval-'))
    const content = mode === 'paged_allow' ? 'x'.repeat(300) : 'approved'
    const dimensions = mode === 'paged_allow' ? { columns: 40, rows: 12 } : { columns: 100, rows: 35 }
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
      script: [
        [
          {
            type: 'toolcall_end',
            via: 'native',
            call: {
              toolUseId: '',
              name: 'write',
              args: { path: 'receipt.txt', content },
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
    try {
      await client.workspace.add(root)
      const session = await client.session.new({ cwd: root })
      const term = new FakeTerminal(dimensions)
      app = new TuiApp({ session, term, header: 'Agnes' })
      await app.start()
      const result = app.submit('write the receipt').catch((error: unknown) => error)
      await vi.waitFor(
        async () =>
          expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).toContain(
            'Approval: write',
          ),
        { timeout: 10_000 },
      )
      const file = join(root, 'receipt.txt')
      expect(existsSync(file)).toBe(false)
      if (mode === 'paged_allow') {
        expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).not.toContain(
          '"path": "receipt.txt"',
        )
        for (let i = 0; i < 100; i++) {
          const screen = (await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')
          if (screen.includes('"path": "receipt.txt"')) break
          term.feed('\x1b[6~')
          await Promise.resolve()
        }
        expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).toContain(
          '"path": "receipt.txt"',
        )
        // FakeTerminal handles the key immediately; Renderer paints the new selection next microtask.
        term.feed('\x1b[A')
        await Promise.resolve()
        expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).toContain(
          'allow_always',
        )
        term.feed('\x1b[A')
        await Promise.resolve()
        expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).toContain('allow_once')
      } else {
        expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).toContain(
          '"path": "receipt.txt"',
        )
        expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).toContain(
          '"content": "approved"',
        )
      }
      if (mode === 'disconnect') await client.close()
      else if (mode === 'stop') await app.stop()
      else term.feed(mode === 'allow' ? '1' : '\r')
      const outcome = await result
      if (mode === 'disconnect') expect(outcome).toBeInstanceOf(TransportClosed)
      else expect(outcome).toBeUndefined()
      if (mode === 'allow' || mode === 'paged_allow') expect(readFileSync(file, 'utf8')).toBe(content)
      else expect(existsSync(file)).toBe(false)
      if (mode === 'allow') {
        await vi.waitFor(async () =>
          expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).toContain(
            '◆ 写入  write',
          ),
        )
        expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).not.toContain(
          'Arguments:',
        )
        term.feed('\x0f')
        await vi.waitFor(async () =>
          expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).toContain(
            'Arguments:',
          ),
        )
        expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).toContain(
          'receipt.txt',
        )
        expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).toContain('Result:')
        term.feed('\x0f')
        await vi.waitFor(async () =>
          expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).not.toContain(
            'Arguments:',
          ),
        )
      }
      if (mode !== 'stop') {
        await Promise.resolve()
        expect((await screenOf(term, dimensions.columns, dimensions.rows)).join('\n')).not.toContain(
          'Approval: write',
        )
      }
    } finally {
      await app?.stop()
      await client.close()
      await endpoint.close()
      await host.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
  // A real Host turn plus TUI paging: under a second alone, past the 5 s default on the Windows runner.
  30_000,
)
