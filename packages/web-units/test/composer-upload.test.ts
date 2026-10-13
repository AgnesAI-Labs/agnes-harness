/** @vitest-environment happy-dom */

import { userImagePolicy } from '@agnes/protocol'
import { webUiLocaleCatalog } from '@agnes/web-ui'
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Composer,
  type ComposerDependencies,
  type ComposerHandle,
  type ComposerView,
} from '../src/composer.js'
import { attachmentErrorNotice } from '../src/composer-errors.js'
import type {
  ComposerUploadChannel,
  ComposerUploadInput,
  ComposerUploadTarget,
} from '../src/composer-upload.js'
import { webUnitsLocaleCatalog } from '../src/locales/index.js'

const translate: ComposerDependencies['translate'] = (key, vars) => {
  const template = webUnitsLocaleCatalog.en[key] ?? webUiLocaleCatalog.en[key] ?? key
  return vars
    ? template.replace(/\{(\w+)\}/g, (m, name: string) =>
        Object.hasOwn(vars, name) ? String(vars[name]) : m,
      )
    : template
}

const view: ComposerView = {
  imagePolicy: userImagePolicy({ input: ['text', 'image'] }),
  cancel: { disabled: true, hidden: true, label: 'Stop' },
  connected: true,
  configured: true,
  hasSession: true,
  hint: { kind: 'shortcut', text: '' },
  input: { disabled: false, placeholder: '' },
  loading: false,
  model: { accessibleName: 'model', disabled: false, label: 'model', options: [], pending: false },
  permission: { disabled: false, pending: false, selected: 'workspace' },
  sending: false,
  send: { disabled: false, label: 'Send', mode: 'idle', title: 'Send' },
  stopping: false,
  usage: undefined,
  workspace: { disabled: false, label: 'workspace', title: 'workspace' },
}

const PNG_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const pngBytes = Uint8Array.from(atob(PNG_DATA), (c) => c.charCodeAt(0))
const pngFile = () => new File([pngBytes], 'shot.png', { type: 'image/png' })
const zipFile = (size = 2048) => new File([new Uint8Array(size)], 'data.zip', { type: 'application/zip' })
const sha = (c: string) => c.repeat(64)

const paste = (files: File[]) => {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
      getData: () => '',
    },
  })
  return event
}

/** A target whose uploads finish only when the test says so. */
function controlledTarget() {
  const calls: Array<{
    input: ComposerUploadInput
    uploadId?: string
    signal?: AbortSignal
    resolve(value: unknown): void
    reject(error: unknown): void
  }> = []
  const target: ComposerUploadTarget = {
    sessionId: 'session-a',
    maxBytes: 2 * 1024 ** 3,
    maxConcurrent: 4,
    upload: (input, o) =>
      new Promise((resolve, reject) => {
        o.onProgress?.(Math.floor(input.bytes.size / 2), input.bytes.size)
        calls.push({
          input,
          ...(o.uploadId ? { uploadId: o.uploadId } : {}),
          ...(o.signal ? { signal: o.signal } : {}),
          resolve: resolve as (value: unknown) => void,
          reject,
        })
      }),
  }
  return { target, calls }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

async function mount(
  upload: ComposerUploadChannel | undefined,
  extra: Partial<ComposerDependencies> = {},
  initialView: ComposerView = view,
) {
  const handle = createRef<ComposerHandle>()
  const errors: string[] = []
  const downscaleImage = vi.fn(async (file: File) => file)
  const makeThumbnail = vi.fn(async () => new Blob([new Uint8Array(40)], { type: 'image/jpeg' }))
  const dependencies: ComposerDependencies = {
    translate,
    createModelPicker: () => ({ destroy() {}, render() {} }),
    createPermissionPicker: () => ({ destroy() {}, render() {} }),
    createUsagePanel: () => () => undefined,
    isSubmitShortcut: () => false,
    resize: () => undefined,
    downscaleImage,
    makeThumbnail,
    ...extra,
  }
  await act(async () => {
    root.render(
      createElement(Composer, {
        ref: handle,
        dependencies,
        initialView,
        onCancel() {},
        onDraftChange() {},
        onError: (error) => errors.push((error as Error).message),
        onModelSelect: async () => false,
        onPermissionSelect: async () => false,
        onSubmit() {},
        onWorkspace() {},
        ...(upload ? { upload } : {}),
      }),
    )
  })
  const add = async (files: File[]) => {
    await act(async () => {
      host.querySelector('textarea')?.dispatchEvent(paste(files))
    })
    // Let the reads and the upload queue settle.
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
  }
  const settle = async () =>
    act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
  return { handle, errors, add, settle, downscaleImage, makeThumbnail }
}

const pngRef = {
  type: 'image',
  mimeType: 'image/png',
  attachment: { sha256: sha('a'), bytes: pngBytes.length },
  width: 1,
  height: 1,
  name: 'shot.png',
}
const zipRef = {
  type: 'file',
  mimeType: 'application/zip',
  name: 'data.zip',
  attachment: { sha256: sha('b'), bytes: 2048 },
}
const thumbRef = { sha256: sha('c'), bytes: 40, width: 1, height: 1 }

describe('composer uploads', () => {
  it('uploads an image (downscaled, with a thumbnail) and a file by reference', async () => {
    const { target, calls } = controlledTarget()
    const m = await mount({ open: async () => target })
    await m.add([pngFile(), zipFile()])
    expect(m.downscaleImage).toHaveBeenCalledOnce()
    expect(calls.map((c) => [c.input.name, c.input.purpose])).toEqual([
      ['shot.png', undefined],
      ['data.zip', undefined],
    ])
    expect(m.handle.current?.hasPendingImages()).toBe(true)
    expect(m.handle.current?.getAttachmentBlocks()).toEqual([])
    expect(host.querySelectorAll('[data-upload-progress]')).toHaveLength(2)

    await act(async () => calls[0]?.resolve(pngRef))
    await m.settle()
    expect(m.makeThumbnail).toHaveBeenCalledOnce()
    expect(calls[2]?.input).toMatchObject({ purpose: 'thumbnail', mimeType: 'image/jpeg' })
    expect(m.handle.current?.hasPendingImages()).toBe(true)
    await act(async () => calls[2]?.resolve(thumbRef))
    await act(async () => calls[1]?.resolve(zipRef))
    await m.settle()
    expect(m.handle.current?.hasPendingImages()).toBe(false)
    expect(m.handle.current?.getAttachmentBlocks()).toEqual([{ ...pngRef, thumbnail: thumbRef }, zipRef])
    // Nothing inline: the image bytes are not part of the message.
    expect(m.handle.current?.getImageBlocks()).toEqual([])
    expect(host.querySelectorAll('[data-upload-progress]')).toHaveLength(0)
  })

  it('drops a cancelled upload from the list and stops it', async () => {
    const { target, calls } = controlledTarget()
    const m = await mount({ open: async () => target })
    await m.add([zipFile(), new File([new Uint8Array(10)], 'notes.txt', { type: 'text/plain' })])
    expect(calls).toHaveLength(2)
    const remove = host.querySelectorAll<HTMLButtonElement>('[data-remove-image]')[0]
    await act(async () => remove?.click())
    await m.settle()
    expect(calls[0]?.signal?.aborted).toBe(true)
    expect(host.querySelectorAll('figure')).toHaveLength(1)
    await act(async () => calls[1]?.resolve({ ...zipRef, name: 'notes.txt', mimeType: 'text/plain' }))
    await m.settle()
    expect(m.handle.current?.getAttachmentBlocks()).toEqual([
      { ...zipRef, name: 'notes.txt', mimeType: 'text/plain' },
    ])
    expect(m.handle.current?.hasPendingImages()).toBe(false)
  })

  it('offers a retry after a failure that resumes the same upload', async () => {
    const { target, calls } = controlledTarget()
    const m = await mount({ open: async () => target })
    await m.add([zipFile()])
    await act(async () => calls[0]?.reject(Object.assign(new Error('connection lost'), { uploadId: 'u-1' })))
    await m.settle()
    expect(m.errors).toEqual(['“data.zip” could not be uploaded.'])
    // A failed attachment holds the send back until it is retried or removed.
    expect(m.handle.current?.hasPendingImages()).toBe(true)
    const retry = host.querySelector<HTMLButtonElement>('[data-upload-retry]')
    expect(retry?.textContent).toBe('Retry')
    await act(async () => retry?.click())
    await m.settle()
    expect(calls[1]?.uploadId).toBe('u-1')
    await act(async () => calls[1]?.resolve(zipRef))
    await m.settle()
    expect(m.handle.current?.getAttachmentBlocks()).toEqual([zipRef])
  })

  it('names a refusal the daemon gave the upload', async () => {
    const { target, calls } = controlledTarget()
    const m = await mount({ open: async () => target })
    await m.add([zipFile()])
    await act(async () =>
      calls[0]?.reject({
        message: 'SEMANTIC_REJECTED',
        data: { code: 'UPLOAD_QUOTA', reason: 'UPLOAD_QUOTA' },
      }),
    )
    await m.settle()
    expect(m.errors).toEqual([translate('composer.upload.quota')])
  })

  it('keeps attachments inline when the channel does not open, refusing one over 8 MiB', async () => {
    const m = await mount({ open: async () => undefined })
    await m.add([zipFile(8 * 1024 * 1024 + 1)])
    expect(m.errors).toEqual([translate('composer.upload.unavailableLarge')])
    await m.add([zipFile(16)])
    expect(m.handle.current?.getAttachmentBlocks()).toEqual([
      { type: 'file', mimeType: 'application/zip', name: 'data.zip', data: btoa('\0'.repeat(16)) },
    ])
  })

  it('keeps attachments added before a session exists, unread and uncapped, until the send uploads them', async () => {
    const { target, calls } = controlledTarget()
    const m = await mount({ open: async () => 'deferred' })
    await m.add([zipFile(20 * 1024 * 1024), pngFile()])
    expect(m.errors).toEqual([])
    expect(calls).toHaveLength(0)
    expect(m.handle.current?.hasDeferredUploads()).toBe(true)
    // Not pending: the send uploads them.
    expect(m.handle.current?.hasPendingImages()).toBe(false)
    expect(m.handle.current?.getAttachmentBlocks()).toEqual([])
    // Switching into the session the send created keeps them.
    await act(async () => m.handle.current?.sessionChanged())
    expect(host.querySelectorAll('figure')).toHaveLength(2)
    let sent: Promise<readonly unknown[]> | undefined
    await act(async () => {
      sent = m.handle.current?.uploadDeferred(target)
    })
    await m.settle()
    expect(calls.map((c) => c.input.name)).toEqual(['data.zip', 'shot.png'])
    await act(async () =>
      calls[0]?.resolve({ ...zipRef, attachment: { sha256: sha('b'), bytes: 20 * 1024 * 1024 } }),
    )
    await act(async () => calls[1]?.resolve(pngRef))
    await m.settle()
    await act(async () => calls[2]?.resolve(thumbRef))
    expect(await sent).toEqual([
      { ...zipRef, attachment: { sha256: sha('b'), bytes: 20 * 1024 * 1024 } },
      { ...pngRef, thumbnail: thumbRef },
    ])
    expect(m.handle.current?.hasDeferredUploads()).toBe(false)
  })

  it('shows an attachment waiting for its session as waiting, not as an upload at 0%', async () => {
    const { target, calls } = controlledTarget()
    const m = await mount({ open: async () => 'deferred' })
    await m.add([zipFile()])
    expect(host.querySelector('[data-upload-progress]')).toBeNull()
    expect(host.querySelector('[data-upload-waiting]')?.textContent).toBe(
      translate('composer.upload.waitingShort'),
    )
    await act(async () => {
      void m.handle.current?.uploadDeferred(target)
    })
    await m.settle()
    expect(calls).toHaveLength(1)
    expect(host.querySelector('[data-upload-waiting]')).toBeNull()
    expect(host.querySelector('[data-upload-progress]')).not.toBeNull()
  })

  it('names the upload limit when a file is over it', async () => {
    const { target } = controlledTarget()
    const m = await mount({ open: async () => ({ ...target, maxBytes: 3 * 1024 * 1024 }) })
    await m.add([zipFile(4 * 1024 * 1024)])
    expect(m.errors).toEqual([translate('composer.upload.tooLargeLimit', { limit: '3 MiB' })])
    expect(m.errors[0]).toContain('3 MiB')
  })

  it('does not promise a 100 MiB total for files that upload', () => {
    expect(translate('composer.attachment.hint')).not.toContain('100 MiB total')
    expect(translate('composer.attachment.hint')).toContain('8 MiB')
  })

  it.each([
    ['ATTACHMENT_TIMEOUT', 'composer.attachment.storeTimeout'],
    ['ATTACHMENT_UNAVAILABLE', 'composer.attachment.storeUnavailable'],
    ['ATTACHMENT_TOO_LARGE', 'composer.attachment.storeTooLarge'],
  ])('gives the send-time refusal %s its own sentence in both languages', (code, key) => {
    expect(attachmentErrorNotice({ data: { code }, message: 'x (-32011)' })?.key).toBe(key)
    for (const language of ['en', 'zh-CN'] as const) {
      const text = webUnitsLocaleCatalog[language][key]
      expect(text).toBeTruthy()
      expect(text).not.toMatch(/-?\d{5}|[A-Z]{4,}_[A-Z_]+/)
    }
  })

  it('drops the uploads of a session the user leaves, cancelling those still running', async () => {
    const { target, calls } = controlledTarget()
    const m = await mount({ open: async () => target })
    await m.add([zipFile(), new File([new Uint8Array(10)], 'notes.txt', { type: 'text/plain' })])
    await act(async () => calls[1]?.resolve({ ...zipRef, name: 'notes.txt' }))
    await m.settle()
    await act(async () => m.handle.current?.sessionChanged())
    await m.settle()
    expect(calls[0]?.signal?.aborted).toBe(true)
    expect(host.querySelectorAll('figure')).toHaveLength(0)
    expect(m.handle.current?.getAttachmentBlocks()).toEqual([])
    expect(m.handle.current?.hasPendingImages()).toBe(false)
  })

  it('sends a PNG added while the model takes no images as a file', async () => {
    const { target, calls } = controlledTarget()
    const m = await mount(
      { open: async () => target },
      {},
      { ...view, imagePolicy: userImagePolicy({ input: ['text'] }) },
    )
    await m.add([pngFile()])
    expect(m.downscaleImage).not.toHaveBeenCalled()
    await act(async () => calls[0]?.resolve(pngRef))
    await m.settle()
    expect(calls).toHaveLength(1)
    expect(m.handle.current?.getAttachmentBlocks()).toEqual([
      { type: 'file', mimeType: 'image/png', name: 'shot.png', attachment: pngRef.attachment },
    ])
  })

  it('tells the server to drop a failed upload the user removes', async () => {
    const { target, calls } = controlledTarget()
    const cancel = vi.fn(async () => undefined)
    const m = await mount({ open: async () => ({ ...target, cancel }) })
    await m.add([zipFile()])
    await act(async () => calls[0]?.reject(Object.assign(new Error('lost'), { uploadId: 'u-7' })))
    await m.settle()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-remove-image]')?.click())
    await m.settle()
    expect(cancel).toHaveBeenCalledWith('u-7')
    expect(m.handle.current?.hasPendingImages()).toBe(false)
  })

  it('maps the daemon’s attachment refusals to sentences', () => {
    const refusal = (code: string) => attachmentErrorNotice({ data: { code } })?.key
    expect(refusal('ATTACHMENT_NOT_AUTHORIZED')).toBe('composer.upload.notAuthorized')
    expect(refusal('UPLOAD_QUOTA')).toBe('composer.upload.quota')
    expect(refusal('UPLOAD_SIZE_LIMIT')).toBe('composer.upload.tooLarge')
    expect(refusal('ATTACHMENT_MISSING')).toBe('composer.upload.missing')
    expect(refusal('ATTACHMENT_IMAGE_TOO_LARGE')).toBe('composer.image.overBudget')
    expect(attachmentErrorNotice({ data: { code: 'ATTACHMENT_MISSING', name: 'a.zip' } })).toEqual({
      key: 'composer.upload.missingNamed',
      vars: { name: 'a.zip' },
    })
    expect(refusal('INTERNAL')).toBeUndefined()
  })
})
