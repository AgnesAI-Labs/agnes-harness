import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { BusyInput } from '../src/busy-input.js'
import { type ClipboardImagePort, pasteClipboardImage } from '../src/clipboard-image.js'
import { attachDroppedImages } from '../src/dropped-images.js'
import { Editor } from '../src/editor.js'
import { PASTE_END, PASTE_START } from '../src/keys.js'

const uploaded: Array<{ mode: number; regular: boolean }> = []
const uploadedPaths: string[] = []
let failUpload = false
vi.mock('../src/attachment-upload.js', () => ({
  uploadLocalAttachment: async (_session: unknown, _cwd: string, path: string) => {
    if (failUpload) throw new Error('ATTACHMENT_BYTES')
    uploadedPaths.push(path)
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
  uploadedPaths.length = 0
  failUpload = false
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function harness(port: ClipboardImagePort, remote = false) {
  const session = { id: 's1' }
  const notices: Array<[string, string]> = []
  const editor = new Editor({ onSubmit: () => {}, onPasteText: (text) => attachDroppedImages(app, text) })
  const busyInput = new BusyInput({
    session: () => app.session,
    locale: () => 'en',
    notice: (text, tone = 'info') => notices.push([text, tone]),
    restore: (draft) => editor.setText(draft),
  })
  const app = {
    locale: 'en',
    session,
    cwd: dir,
    attachmentSignal: new AbortController().signal,
    statusBar: { setNotice: (text: string, tone: string) => notices.push([text, tone]) },
    renderer: { requestRender: () => {} },
    editor,
    busyInput,
    o: { externalEditor: { env: {}, tmpDir: dir }, clipboard: port, remote },
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

  it('attaches the file itself when the clipboard holds a copied image file', async () => {
    const file = join(dir, 'copied.png')
    writeFileSync(file, PNG)
    const { app, editor } = harness({ readImage: async () => ({ ok: true, file }) })
    await pasteClipboardImage(app)
    expect(editor.text).toBe('[Image #1]')
    expect(uploadedPaths).toEqual([file])
  })

  describe('dropped image paths', () => {
    const drop = (editor: Editor, text: string) => editor.handleInput(`${PASTE_START}${text}${PASTE_END}`)
    const image = (name: string) => {
      const file = join(dir, name)
      writeFileSync(file, PNG)
      return file
    }

    it.each([
      ['an absolute path', 'a.png', (f: string) => f],
      ['a quoted path', 'my pics/a b.png', (f: string) => `'${f}'`],
      ['a file URL', 'my pics/a b.png', (f: string) => pathToFileURL(f).href],
      ['a path with escaped spaces', 'my pics/a b.png', (f: string) => f.replaceAll(' ', '\\ ')],
    ])('turns %s into a chip and an attachment', async (_name, name, form) => {
      mkdirSync(join(dir, 'my pics'))
      const file = image(name)
      const { editor, busyInput } = harness(withImage)
      drop(editor, form(file))
      await vi.waitFor(() => expect(editor.text).toBe('[Image #1]'))
      expect(uploadedPaths).toEqual([file])
      expect(busyInput.takeKept('[Image #1]')).toEqual([{ type: 'attachment', id: 'att-1' }])
    })

    it('attaches several paths, and follows a symlink to a regular file', async () => {
      const a = image('a.png')
      const link = join(dir, 'link.webp')
      symlinkSync(a, link)
      const { editor } = harness(withImage)
      drop(editor, `${a}\n${link}`)
      await vi.waitFor(() => expect(editor.text).toBe('[Image #1][Image #2]'))
    })

    it.each([
      ['a non-image file', () => image('a.txt')],
      ['a missing file', () => join(dir, 'missing.png')],
      ['a directory', () => dir],
      ['text with a path', () => `look at ${image('b.png')}`],
    ])('leaves %s as pasted text', (_name, text) => {
      const { editor } = harness(withImage)
      const pasted = text()
      drop(editor, pasted)
      expect(editor.text).toBe(pasted)
      expect(uploadedPaths).toEqual([])
    })

    it('stays text under --connect', () => {
      const file = image('c.png')
      const { editor } = harness(withImage, true)
      drop(editor, file)
      expect(editor.text).toBe(file)
      expect(uploadedPaths).toEqual([])
    })

    it('keeps the path in the draft when the upload fails', async () => {
      const file = image('d.png')
      failUpload = true
      const { editor, notices } = harness(withImage)
      drop(editor, file)
      await vi.waitFor(() => expect(editor.text).toBe(file))
      expect(notices.at(-1)?.[1]).toBe('error')
    })
  })
})
