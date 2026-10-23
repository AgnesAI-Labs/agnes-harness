import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { BusyInput } from '../src/busy-input.js'
import { type ClipboardImagePort, pasteClipboardImage } from '../src/clipboard-image.js'
import { Editor } from '../src/editor.js'

const uploaded: Array<{ mode: number; regular: boolean }> = []
vi.mock('../src/attachment-upload.js', () => ({
  uploadLocalAttachment: async (_session: unknown, _cwd: string, path: string) => {
    const info = statSync(path)
    uploaded.push({ mode: info.mode & 0o777, regular: info.isFile() })
    return { type: 'attachment', id: 'att-1' }
  },
}))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agh-clip-'))
  uploaded.length = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function harness(port: ClipboardImagePort) {
  const session = { id: 's1' }
  const notices: Array<[string, string]> = []
  const editor = new Editor({ onSubmit: () => {} })
  const busyInput = new BusyInput({
    session: () => app.session,
    locale: () => 'en',
    notice: (text, tone = 'info') => notices.push([text, tone]),
    restore: (draft) => editor.setText(draft),
  })
  const app = {
    locale: 'en',
    session,
    attachmentSignal: new AbortController().signal,
    statusBar: { setNotice: (text: string, tone: string) => notices.push([text, tone]) },
    renderer: { requestRender: () => {} },
    editor,
    busyInput,
    o: { externalEditor: { env: {}, tmpDir: dir }, clipboard: port },
  } as unknown as TuiApp
  return { app, notices, editor, busyInput }
}

const withImage: ClipboardImagePort = {
  readImage: async (file) => {
    writeFileSync(file, PNG)
    return { ok: true }
  },
}

describe('clipboard image paste', () => {
  it('uploads a private copy, shows a chip, sends the image only while the chip is in the text, and cleans up', async () => {
    const { app, notices, editor, busyInput } = harness(withImage)
    await pasteClipboardImage(app)
    expect(editor.text).toBe('[Image #1]')
    expect(notices.at(-1)?.[1]).toBe('success')
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0]?.regular).toBe(true)
    // Windows privacy is an ACL contract, checked at the CLI/native boundary, not POSIX mode bits.
    if (process.platform !== 'win32') expect(uploaded[0]?.mode).toBe(0o600)
    expect(readdirSync(dir)).toEqual([])
    expect(busyInput.takeKept('look at [Image #1]')).toEqual([{ type: 'attachment', id: 'att-1' }])
    await pasteClipboardImage(app)
    expect(busyInput.takeKept('the chip was deleted')).toEqual([])
  })

  it.each([
    ['nothing on the clipboard', { ok: false, reason: 'empty' }, 'warning', /no image/i],
    ['a tool that is missing', { ok: false, reason: 'unavailable', tool: 'xclip' }, 'error', /xclip/],
    ['a read that timed out', { ok: false, reason: 'timeout' }, 'error', /timed out/],
  ] as const)('says why for %s and uploads nothing', async (_name, result, tone, text) => {
    const { app, notices, editor } = harness({ readImage: async () => result })
    await pasteClipboardImage(app)
    expect(notices.at(-1)?.[1]).toBe(tone)
    expect(notices.at(-1)?.[0]).toMatch(text)
    expect(editor.text).toBe('')
    expect(uploaded).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses bytes that are not a PNG', async () => {
    const { app, notices } = harness({
      readImage: async (file) => {
        writeFileSync(file, 'not an image at all')
        return { ok: true }
      },
    })
    await pasteClipboardImage(app)
    expect(notices.at(-1)?.[0]).toMatch(/no image/i)
    expect(uploaded).toEqual([])
  })

  it.each([false, true])(
    'restores failed image drafts only in the original session (switched=%s)',
    async (switched) => {
      const { app, editor, busyInput } = harness(withImage)
      await pasteClipboardImage(app)
      let attempts = 0
      Object.assign(app.session, {
        followUp: async () => {
          attempts++
          if (switched) Object.assign(app, { session: { id: 's2' } })
          throw new Error('not sent')
        },
        client: { journal: { pending: async () => [] } },
      })
      const draft = editor.expanded()
      const blocks = busyInput.takeKept(draft)
      editor.clear()
      await busyInput.queue(blocks, draft, 'followUp')
      expect(attempts).toBe(2)
      expect(editor.text).toBe(switched ? '' : '[Image #1]')
      expect(busyInput.takeKept(editor.expanded())).toEqual(switched ? [] : blocks)
      // Removing a restored chip must still remove its image from the next send.
      if (!switched) {
        const block = blocks[0]
        if (!block) throw new Error('missing clipboard image')
        busyInput.attach('[Image #1]', block, app.session.id)
        await busyInput.queue(busyInput.takeKept(draft), draft, 'followUp')
        expect(busyInput.takeKept('chip removed')).toEqual([])
      }
    },
  )

  it.each(
    ['UNCERTAIN', 'OUTCOME_UNKNOWN', 'needs-confirmation']
      .flatMap((state) => [[state, false] as const, [state, true] as const])
      .concat([
        ['transport-error', true],
        ['journal-error', true],
      ]),
  )('never restores or resends an image when submission is %s (during check=%s)', async (state, checking) => {
    const { app, editor, busyInput } = harness(withImage)
    await pasteClipboardImage(app)
    let attempts = 0
    let commandId = ''
    const unknown = () =>
      state === 'needs-confirmation' ? { submission: { state } } : { data: { code: state } }
    Object.assign(app.session, {
      followUp: async (_blocks: unknown, options: { commandId: string }) => {
        attempts++
        commandId = options.commandId
        throw checking ? new Error('response lost') : unknown()
      },
      client: {
        journal: {
          pending: async () => {
            if (state === 'journal-error') throw new Error('journal unavailable')
            return [{ commandId }]
          },
        },
      },
      checkCommand: async () => {
        if (state === 'transport-error') throw new Error('transport unavailable')
        throw unknown()
      },
    })
    const draft = editor.expanded()
    const blocks = busyInput.takeKept(draft)
    editor.clear()
    await busyInput.queue(blocks, draft, 'followUp')
    expect(attempts).toBe(checking ? 2 : 1)
    expect(editor.text).toBe('')
    expect(busyInput.takeKept(draft)).toEqual([])
  })
})
