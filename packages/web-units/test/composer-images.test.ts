/** @vitest-environment happy-dom */

import { userImagePolicy } from '@agnes/protocol'
import { decodeSafeImageBytes, USER_MESSAGE_IMAGE_LIMITS } from '@agnes/protocol-validation'
import { webUiLocaleCatalog } from '@agnes/web-ui'
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Composer,
  type ComposerDependencies,
  type ComposerHandle,
  type ComposerView,
  downscaleImageFile,
} from '../src/composer.js'
import { webUnitsLocaleCatalog } from '../src/locales/index.js'
import * as uploads from '../src/file-upload.js'

let host: HTMLDivElement
let root: Root
let originalCreateObjectURL: PropertyDescriptor | undefined
let originalRevokeObjectURL: PropertyDescriptor | undefined

const dependencies: ComposerDependencies = {
  // 组件从语言目录取词，桩要返回真实文案而不是 key 本身。composer 的词条在 web-units 自己的
  // 目录里，web-ui 的目录没有，只查后者会拿到原始 key。
  translate: (key, vars) => {
    const template = webUnitsLocaleCatalog['zh-CN'][key] ?? webUiLocaleCatalog['zh-CN'][key] ?? key
    if (!vars) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.hasOwn(vars, name) ? String(vars[name]) : match,
    )
  },
  createModelPicker: () => ({ destroy() {}, render() {} }),
  createPermissionPicker: () => ({ destroy() {}, render() {} }),
  createUsagePanel: () => () => undefined,
  isSubmitShortcut: () => false,
  resize: () => undefined,
}

const view: ComposerView = {
  imagePolicy: userImagePolicy({ input: ['text', 'image'] }),
  cancel: { disabled: true, hidden: true, label: '停止' },
  connected: true,
  configured: true,
  hasSession: true,
  hint: { kind: 'shortcut', text: 'Enter 发送，Shift+Enter 换行' },
  input: { disabled: false, placeholder: '描述你想完成的事…' },
  loading: false,
  model: { accessibleName: 'model', disabled: false, label: 'model', options: [], pending: false },
  permission: { disabled: false, pending: false, selected: 'workspace' },
  sending: false,
  send: { disabled: false, label: '发送', mode: 'idle', title: '发送' },
  stopping: false,
  usage: undefined,
  workspace: { disabled: false, label: 'workspace', title: 'workspace' },
}

const PNG_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const pngBytes = Uint8Array.from(atob(PNG_DATA), (character) => character.charCodeAt(0))
const pngFile = (name = 'one.png', bytes: Uint8Array = pngBytes) =>
  new File([Uint8Array.from(bytes)], name, { type: 'image/png' })
const imagePasteEvent = (files: File[], text = '') => {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  })
  return event
}

beforeEach(async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps a batch through upload session opening, stores references and cleans a removed file', async () => {
  const handle = createRef<ComposerHandle>()
  const cancelled = vi.spyOn(uploads, 'cancelFileUpload').mockResolvedValue(undefined)
  vi.spyOn(uploads, 'fileUploadLimits').mockResolvedValue({
    maxBytes: 1024,
    chunkBytes: 4,
    allowedMimeTypes: [],
  })
  vi.spyOn(uploads, 'uploadFile').mockImplementation(
    async (file, _session, id, _limits, signal, progress) => {
      signal.throwIfAborted()
      progress({ loaded: file.size, total: file.size, phase: 'verifying' })
      return {
        type: 'resource_link',
        name: file.name,
        mimeType: file.type,
        uri: `agnes-upload://${'a'.repeat(64)}/${'b'.repeat(64)}/${file.size}/${id}`,
      }
    },
  )
  await act(async () =>
    root.render(
      createElement(Composer, {
        ref: handle,
        dependencies,
        initialView: view,
        prepareUploadSession: async () => {
          // The real shell clears attachment state when it publishes the newly opened session.
          handle.current?.clearImageBlocks()
          return 'owned-session'
        },
        onCancel() {},
        onDraftChange() {},
        onError() {},
        onModelSelect: async () => false,
        onPermissionSelect: async () => false,
        onSubmit() {},
        onWorkspace() {},
      }),
    ),
  )
  const input = host.querySelector('textarea')
  if (!input) throw new Error('missing composer input')
  await act(async () =>
    input.dispatchEvent(
      imagePasteEvent([
        new File(['one'], 'contract.txt', { type: 'text/plain' }),
        new File(['two'], 'scan.pdf', { type: 'application/pdf' }),
      ]),
    ),
  )
  await vi.waitFor(() => expect(handle.current?.getAttachmentBlocks()).toHaveLength(2))
  expect(handle.current?.getAttachmentBlocks().every((block) => block.type === 'resource_link')).toBe(true)
  expect(cancelled).not.toHaveBeenCalled()
  cancelled.mockRejectedValue(new Error('cleanup unavailable'))
  const remove = host.querySelector<HTMLButtonElement>('[data-testid="attachment-remove"]')
  await act(async () => remove?.click())
  expect(handle.current?.getAttachmentBlocks()).toHaveLength(1)
  expect(cancelled).toHaveBeenCalledWith('owned-session', expect.any(String))
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="attachment-upload"]')?.getAttribute('data-state')).toBe(
      'failed',
    ),
  )
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="attachment-upload-dismiss"]')?.click(),
  )
  expect(host.querySelector('[data-testid="attachment-upload"]')?.getAttribute('data-state')).toBe('failed')
  cancelled.mockResolvedValue(undefined)
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="attachment-upload-retry"]')?.click(),
  )
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="attachment-upload"]')?.getAttribute('data-state')).toBe(
      'cancelled',
    ),
  )
})

it.each([
  [false, true, true],
  [true, true, true],
  [true, false, true],
  [true, true, false],
])('handles JPEG trailing data %s, decoding %s, encoding %s', async (trailing, decodable, encodable) => {
  const bytes = Uint8Array.of(
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    11,
    8,
    0,
    1,
    0,
    1,
    1,
    1,
    0x11,
    0,
    0xff,
    0xda,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    1,
    2,
    3,
    0xff,
    0xd9,
  )
  const file = new File([bytes, ...(trailing ? [new Uint8Array(24)] : [])], 'photo.jpg', {
    type: 'image/jpeg',
  })
  const close = vi.fn()
  vi.stubGlobal('createImageBitmap', async () => {
    if (!decodable) throw new Error('invalid JPEG')
    return { width: 1, height: 1, close }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage() {},
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
    callback(encodable ? new Blob([bytes], { type: 'image/jpeg' }) : null),
  )
  const result = await downscaleImageFile(file, view.imagePolicy)
  expect(result === file).toBe(!trailing || !decodable || !encodable)
  expect(result.name).toBe('photo.jpg')
  const resultBytes = new Uint8Array(await result.arrayBuffer())
  const decode = () =>
    decodeSafeImageBytes({ bytes: resultBytes, mimeType: result.type }, USER_MESSAGE_IMAGE_LIMITS)
  if (trailing && (!decodable || !encodable)) expect(decode).toThrow(/trailing bytes/)
  else expect(decode()).toMatchObject({ mime: 'image/jpeg', width: 1, height: 1 })
  if (decodable) expect(close).toHaveBeenCalledOnce()
  else expect(close).not.toHaveBeenCalled()
})

describe('composer image attachments', () => {
  it('validates every restored block before creating preview URLs', async () => {
    const handle = createRef<ComposerHandle>()
    await act(async () => {
      root.render(
        createElement(Composer, {
          ref: handle,
          dependencies,
          initialView: view,
          onCancel() {},
          onDraftChange() {},
          onError() {},
          onModelSelect: async () => false,
          onPermissionSelect: async () => false,
          onSubmit() {},
          onWorkspace() {},
        }),
      )
    })

    await act(async () => {
      handle.current?.restoreImageBlocks([
        { type: 'image', mimeType: 'image/png', data: btoa(String.fromCharCode(...pngBytes.slice(0, 8))) },
        { type: 'image', mimeType: 'image/gif' as 'image/png', data: 'R0lGODlh' },
      ])
    })

    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(handle.current?.getImageBlocks()).toEqual([])

    await act(async () => {
      handle.current?.restoreImageBlocks([
        { type: 'image', mimeType: 'image/png', data: btoa(String.fromCharCode(...pngBytes.slice(0, 8))) },
      ])
    })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(handle.current?.getImageBlocks()).toEqual([])
  })

  it('turns a pasted PNG into a message block and releases its preview when removed', async () => {
    const handle = createRef<ComposerHandle>()
    const onError = vi.fn()
    await act(async () => {
      root.render(
        createElement(Composer, {
          ref: handle,
          dependencies,
          initialView: view,
          onCancel() {},
          onDraftChange() {},
          onError,
          onModelSelect: async () => false,
          onPermissionSelect: async () => false,
          onSubmit() {},
          onWorkspace() {},
        }),
      )
    })

    expect(host.querySelector('#composer-add-image')).toBeNull()
    const prompt = host.querySelector<HTMLTextAreaElement>('#prompt')
    if (!prompt) throw new Error('composer input is missing')

    await act(async () => {
      prompt.dispatchEvent(imagePasteEvent([pngFile()]))
      await vi.waitFor(() => expect(handle.current?.getImageBlocks()).toHaveLength(1))
    })

    expect(handle.current?.getImageBlocks()).toHaveLength(1)
    const [image] = handle.current?.getImageBlocks() ?? []
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(host.querySelector<HTMLImageElement>('.composer-image-preview img')?.src).toBe('blob:preview')
    expect(onError).not.toHaveBeenCalled()

    await act(async () => host.querySelector<HTMLButtonElement>('[data-remove-image]')?.click())
    expect(handle.current?.getImageBlocks()).toHaveLength(0)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')

    await act(async () => handle.current?.restoreImageBlocks(image ? [image] : []))
    expect(handle.current?.getImageBlocks()).toHaveLength(1)
    await act(async () => root.unmount())
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    root = createRoot(host)
  })

  it('hands an incoming image to the downscaler and reads the scaled result', async () => {
    const handle = createRef<ComposerHandle>()
    const onError = vi.fn()
    // 缩放器的返回值必须是被读取、被预览的那一份，否则用户看到和发出的不是同一张图。
    const scaled = pngFile('scaled.png', pngBytes)
    const downscaleImage = vi.fn(async (_file: File) => scaled)
    await act(async () => {
      root.render(
        createElement(Composer, {
          ref: handle,
          dependencies: { ...dependencies, downscaleImage },
          initialView: view,
          onCancel() {},
          onDraftChange() {},
          onError,
          onModelSelect: async () => false,
          onPermissionSelect: async () => false,
          onSubmit() {},
          onWorkspace() {},
        }),
      )
    })

    const prompt = host.querySelector<HTMLTextAreaElement>('#prompt')
    if (!prompt) throw new Error('composer input is missing')

    await act(async () => {
      prompt.dispatchEvent(imagePasteEvent([pngFile()]))
      await vi.waitFor(() => expect(handle.current?.getImageBlocks()).toHaveLength(1))
    })

    expect(downscaleImage).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).toHaveBeenCalledWith(scaled)
    expect(onError).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    root = createRoot(host)
  })

  it('skips the downscaler when the host does not inject one', async () => {
    const handle = createRef<ComposerHandle>()
    const onError = vi.fn()
    await act(async () => {
      root.render(
        createElement(Composer, {
          ref: handle,
          dependencies,
          initialView: view,
          onCancel() {},
          onDraftChange() {},
          onError,
          onModelSelect: async () => false,
          onPermissionSelect: async () => false,
          onSubmit() {},
          onWorkspace() {},
        }),
      )
    })

    const prompt = host.querySelector<HTMLTextAreaElement>('#prompt')
    if (!prompt) throw new Error('composer input is missing')
    const original = pngFile()
    await act(async () => {
      prompt.dispatchEvent(imagePasteEvent([original]))
      await vi.waitFor(() => expect(handle.current?.getImageBlocks()).toHaveLength(1))
    })

    // 缺省路径按原图发送，行为与加入缩放之前一致。
    expect(URL.createObjectURL).toHaveBeenCalledWith(original)
    expect(onError).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    root = createRoot(host)
  })

  it('accepts pasted text and images plus dropped images', async () => {
    const handle = createRef<ComposerHandle>()
    const draftChanges = vi.fn()
    await act(async () => {
      root.render(
        createElement(Composer, {
          ref: handle,
          dependencies,
          initialView: view,
          onCancel() {},
          onDraftChange: draftChanges,
          onError() {},
          onModelSelect: async () => false,
          onPermissionSelect: async () => false,
          onSubmit() {},
          onWorkspace() {},
        }),
      )
    })
    const prompt = host.querySelector<HTMLTextAreaElement>('#prompt')
    const form = host.querySelector<HTMLFormElement>('#composer')
    if (!prompt || !form) throw new Error('composer form is missing')
    const clipboardFile = pngFile('clipboard.png')
    const itemFile = pngFile('clipboard.png')
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        files: [clipboardFile],
        items: [{ kind: 'file', getAsFile: () => itemFile }],
        getData: (type: string) => (type === 'text/plain' ? 'pasted text' : ''),
      },
    })

    await act(async () => {
      prompt.dispatchEvent(pasteEvent)
      await vi.waitFor(() => expect(handle.current?.getImageBlocks()).toHaveLength(1))
    })
    expect(pasteEvent.defaultPrevented).toBe(true)
    expect(prompt.value).toBe('pasted text')
    expect(draftChanges).toHaveBeenCalledWith('pasted text')

    const dropped = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(dropped, 'dataTransfer', { value: { files: [pngFile('dropped.png')] } })
    await act(async () => {
      form.dispatchEvent(dropped)
      await vi.waitFor(() => expect(handle.current?.getImageBlocks()).toHaveLength(2))
    })
    expect(dropped.defaultPrevented).toBe(true)
  })

  it('ignores a file read that finishes after the attachment state is cleared', async () => {
    const handle = createRef<ComposerHandle>()
    await act(async () => {
      root.render(
        createElement(Composer, {
          ref: handle,
          dependencies,
          initialView: view,
          onCancel() {},
          onDraftChange() {},
          onError() {},
          onModelSelect: async () => false,
          onPermissionSelect: async () => false,
          onSubmit() {},
          onWorkspace() {},
        }),
      )
    })
    const prompt = host.querySelector<HTMLTextAreaElement>('#prompt')
    if (!prompt) throw new Error('composer input is missing')
    const file = pngFile()
    let finishRead!: (bytes: ArrayBuffer) => void
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: () => new Promise<ArrayBuffer>((resolve) => (finishRead = resolve)),
    })
    await act(async () => prompt.dispatchEvent(imagePasteEvent([file])))
    expect(handle.current?.hasPendingImages()).toBe(true)

    await act(async () => handle.current?.clearImageBlocks())
    const bytes = pngBytes
    finishRead(bytes.buffer as ArrayBuffer)
    await act(async () => {
      await vi.waitFor(() => expect(handle.current?.hasPendingImages()).toBe(false))
      await Promise.resolve()
    })

    expect(handle.current?.getImageBlocks()).toEqual([])
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('accepts other file types while refusing invalid and oversized images', async () => {
    const handle = createRef<ComposerHandle>()
    const onError = vi.fn()
    await act(async () => {
      root.render(
        createElement(Composer, {
          ref: handle,
          dependencies,
          initialView: view,
          onCancel() {},
          onDraftChange() {},
          onError,
          onModelSelect: async () => false,
          onPermissionSelect: async () => false,
          onSubmit() {},
          onWorkspace() {},
        }),
      )
    })
    const prompt = host.querySelector<HTMLTextAreaElement>('#prompt')
    if (!prompt) throw new Error('composer input is missing')
    for (const file of [
      new File(['x'], 'file.gif', { type: 'image/gif' }),
      pngFile('truncated.png', pngBytes.slice(0, 8)),
      pngFile('large.png', new Uint8Array(USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage + 1)),
    ]) {
      await act(async () => prompt.dispatchEvent(imagePasteEvent([file])))
    }

    await vi.waitFor(() => expect(handle.current?.hasPendingImages()).toBe(false))
    expect(onError).toHaveBeenCalledTimes(2)
    expect(handle.current?.getImageBlocks()).toEqual([])
    expect(handle.current?.getAttachmentBlocks()).toMatchObject([
      { type: 'file', mimeType: 'image/gif', name: 'file.gif' },
    ])
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('keeps documents, video and empty files beside a model-limited image and restores their exact bytes', async () => {
    const handle = createRef<ComposerHandle>()
    const onError = vi.fn()
    await act(async () =>
      root.render(
        createElement(Composer, {
          ref: handle,
          dependencies,
          initialView: {
            ...view,
            imagePolicy: userImagePolicy({ input: ['image'], inputLimits: { images: { maxPerRequest: 1 } } }),
          },
          onCancel() {},
          onDraftChange() {},
          onError,
          onModelSelect: async () => false,
          onPermissionSelect: async () => false,
          onSubmit() {},
          onWorkspace() {},
        }),
      ),
    )
    const files = [
      pngFile(),
      new File(['你好'], 'note.md'),
      new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }),
      new File([new Uint8Array([0, 1, 2])], 'movie.mp4', { type: 'video/mp4' }),
      new File([], '<img onerror=evil>.txt', { type: 'text/plain' }),
    ]
    const picker = host.querySelector<HTMLInputElement>('input[type=file]')
    expect(picker?.accept).toBe('')
    await act(async () => {
      host.querySelector('textarea')?.dispatchEvent(imagePasteEvent(files))
      await vi.waitFor(() => expect(handle.current?.getAttachmentBlocks()).toHaveLength(5))
    })
    const blocks = handle.current?.getAttachmentBlocks() ?? []
    expect(blocks[1]).toEqual({
      type: 'file',
      name: 'note.md',
      mimeType: 'application/octet-stream',
      data: Buffer.from('你好').toString('base64'),
    })
    expect(blocks[4]).toMatchObject({ type: 'file', data: '' })
    expect(host.querySelectorAll('.composer-file-preview')).toHaveLength(4)
    expect(host.querySelectorAll('.composer-file-preview img')).toHaveLength(0)
    await act(async () => {
      handle.current?.clearImageBlocks()
      handle.current?.restoreAttachmentBlocks(blocks)
    })
    expect(handle.current?.getAttachmentBlocks()).toEqual(blocks)
    expect(onError).not.toHaveBeenCalled()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="移除附件 3"]')?.click())
    expect(
      handle.current
        ?.getAttachmentBlocks()
        .some((block) => block.type === 'file' && block.name === 'report.pdf'),
    ).toBe(false)
  })

  it('enforces the attachment count across concurrent batches including empty files', async () => {
    const handle = createRef<ComposerHandle>()
    const onError = vi.fn()
    await act(async () =>
      root.render(
        createElement(Composer, {
          ref: handle,
          dependencies,
          initialView: view,
          onCancel() {},
          onDraftChange() {},
          onError,
          onModelSelect: async () => false,
          onPermissionSelect: async () => false,
          onSubmit() {},
          onWorkspace() {},
        }),
      ),
    )
    await act(async () => {
      for (const count of [30, 25])
        host
          .querySelector('textarea')
          ?.dispatchEvent(
            imagePasteEvent(
              Array.from({ length: count }, (_, index) => new File([], `${count}-${index}.txt`)),
            ),
          )
      await vi.waitFor(() => expect(handle.current?.hasPendingImages()).toBe(false))
    })
    expect(handle.current?.getAttachmentBlocks()).toHaveLength(50)
    expect(onError.mock.calls.every(([error]) => error.message.includes('50'))).toBe(true)
    expect(host.querySelector('#composer-attach')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('accepts a large source image once downscaling brings it under the per-image limit', async () => {
    const handle = createRef<ComposerHandle>()
    const onError = vi.fn()
    // 源图 12 MiB，缩放后体积更小，缩放后却是张合法小图。闸门必须按缩放后的结果判，
    // 否则大截图会在能被缩小之前就被拒掉——缩放功能对最需要它的场景反而无效。
    const source = new File([new Uint8Array(12 * 1024 * 1024)], 'screenshot.png', { type: 'image/png' })
    const scaled = pngFile('screenshot.png', pngBytes)
    const downscaleImage = vi.fn(async () => scaled)
    await act(async () => {
      root.render(
        createElement(Composer, {
          ref: handle,
          dependencies: { ...dependencies, downscaleImage },
          initialView: view,
          onCancel() {},
          onDraftChange() {},
          onError,
          onModelSelect: async () => false,
          onPermissionSelect: async () => false,
          onSubmit() {},
          onWorkspace() {},
        }),
      )
    })

    const prompt = host.querySelector<HTMLTextAreaElement>('#prompt')
    if (!prompt) throw new Error('composer input is missing')
    await act(async () => {
      prompt.dispatchEvent(imagePasteEvent([source]))
      await vi.waitFor(() => expect(handle.current?.getImageBlocks()).toHaveLength(1))
    })

    expect(downscaleImage).toHaveBeenCalledWith(source, view.imagePolicy)
    expect(URL.createObjectURL).toHaveBeenCalledWith(scaled)
    expect(onError).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    root = createRoot(host)
  })

  it('rejects an image that is still over the per-image limit after downscaling', async () => {
    const handle = createRef<ComposerHandle>()
    const onError = vi.fn()
    const oversized = pngFile('still-big.png', new Uint8Array(USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage + 1))
    const downscaleImage = vi.fn(async () => oversized)
    await act(async () => {
      root.render(
        createElement(Composer, {
          ref: handle,
          dependencies: { ...dependencies, downscaleImage },
          initialView: view,
          onCancel() {},
          onDraftChange() {},
          onError,
          onModelSelect: async () => false,
          onPermissionSelect: async () => false,
          onSubmit() {},
          onWorkspace() {},
        }),
      )
    })

    const prompt = host.querySelector<HTMLTextAreaElement>('#prompt')
    if (!prompt) throw new Error('composer input is missing')
    await act(async () => {
      prompt.dispatchEvent(imagePasteEvent([pngFile()]))
      await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    })

    expect(onError.mock.calls[0]?.[0]?.message).toBe('单条消息中的附件合计不能超过 100 MiB。')
    expect(handle.current?.getImageBlocks()).toEqual([])
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    root = createRoot(host)
  })

  it('counts the aggregate limit from the downscaled sizes, not the sources', async () => {
    const handle = createRef<ComposerHandle>()
    const onError = vi.fn()
    // 三张源图合计 12 MiB，缩放后各自只剩几十字节：应当全部收下。
    const sources = [0, 1, 2].map(
      (index) => new File([new Uint8Array(4 * 1024 * 1024)], `source-${index}.png`, { type: 'image/png' }),
    )
    const downscaleImage = vi.fn(async (file: File) => pngFile(file.name, pngBytes))
    await act(async () => {
      root.render(
        createElement(Composer, {
          ref: handle,
          dependencies: { ...dependencies, downscaleImage },
          initialView: view,
          onCancel() {},
          onDraftChange() {},
          onError,
          onModelSelect: async () => false,
          onPermissionSelect: async () => false,
          onSubmit() {},
          onWorkspace() {},
        }),
      )
    })

    const prompt = host.querySelector<HTMLTextAreaElement>('#prompt')
    if (!prompt) throw new Error('composer input is missing')
    await act(async () => {
      prompt.dispatchEvent(imagePasteEvent(sources))
      await vi.waitFor(() => expect(handle.current?.getImageBlocks()).toHaveLength(3))
    })

    expect(downscaleImage).toHaveBeenCalledTimes(3)
    expect(onError).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    root = createRoot(host)
  })
})

it('uses the picker and paste limits, retains drafts across model changes, and clears the picker for reuse', async () => {
  const handle = createRef<ComposerHandle>()
  const onError = vi.fn()
  const limitedView = {
    ...view,
    imagePolicy: userImagePolicy({ input: ['image'], inputLimits: { images: { maxPerMessage: 1 } } }),
  }
  await act(async () =>
    root.render(
      createElement(Composer, {
        ref: handle,
        dependencies,
        initialView: limitedView,
        onCancel() {},
        onDraftChange() {},
        onError,
        onModelSelect: async () => false,
        onPermissionSelect: async () => false,
        onSubmit() {},
        onWorkspace() {},
      }),
    ),
  )
  const picker = host.querySelector<HTMLInputElement>('input[type=file]')
  const attach = host.querySelector<HTMLButtonElement>('#composer-attach')
  if (!picker || !attach) throw new Error('missing image picker')
  const click = vi.spyOn(picker, 'click')
  await act(async () => attach.click())
  expect(click).toHaveBeenCalledOnce()
  Object.defineProperty(picker, 'files', { configurable: true, value: [pngFile(), pngFile('two.png')] })
  await act(async () => {
    picker.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(handle.current?.getImageBlocks()).toHaveLength(1))
  })
  expect(picker.value).toBe('')
  expect(onError.mock.calls[0]?.[0].message).toContain('1')
  expect(attach.getAttribute('aria-disabled')).toBe('false')
  onError.mockClear()
  await act(async () => attach.click())
  expect(click).toHaveBeenCalledTimes(2)
  expect(onError).not.toHaveBeenCalled()
  await act(async () =>
    handle.current?.render({ ...view, imagePolicy: userImagePolicy({ input: ['text'] }) }),
  )
  expect(handle.current?.getImageBlocks()).toHaveLength(1)
  await act(async () => attach.click())
  expect(click).toHaveBeenCalledTimes(3)
  await act(async () => {
    host.querySelector('textarea')?.dispatchEvent(imagePasteEvent([pngFile()]))
    await vi.waitFor(() => expect(handle.current?.getAttachmentBlocks()).toHaveLength(2))
  })
  expect(handle.current?.getImageBlocks()).toHaveLength(1)
  expect(handle.current?.getAttachmentBlocks()[1]).toMatchObject({ type: 'file', mimeType: 'image/png' })
  expect(onError).not.toHaveBeenCalled()
})

// Valid, highly compressed 1456 × 1456 PNG: bytes fit, aggregate pixels can still overflow.
const LARGE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAABbAAAAWwAQAAAACko1oWAAABGUlEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALo2EQwAASTxhM8AAAAASUVORK5CYII='
it.each([
  ['five small images without a model count cap', PNG_DATA, 5, 5],
  ['four large images exceeding aggregate pixels', LARGE_PNG, 4, 3],
  ['concurrent batches exceeding aggregate pixels', LARGE_PNG, 4, 3],
] as const)('keeps a valid restorable batch: %s', async (_label, data, count, accepted) => {
  const handle = createRef<ComposerHandle>()
  const onError = vi.fn()
  await act(async () =>
    root.render(
      createElement(Composer, {
        ref: handle,
        dependencies,
        initialView: view,
        onCancel() {},
        onDraftChange() {},
        onError,
        onModelSelect: async () => false,
        onPermissionSelect: async () => false,
        onSubmit() {},
        onWorkspace() {},
      }),
    ),
  )
  const files = Array.from({ length: count }, (_, i) =>
    pngFile(
      `${i}.png`,
      Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    ),
  )
  await act(async () => {
    for (const batch of _label.startsWith('concurrent') ? [files.slice(0, 2), files.slice(2)] : [files])
      host.querySelector('textarea')?.dispatchEvent(imagePasteEvent(batch))
    await vi.waitFor(() => expect(handle.current?.hasPendingImages()).toBe(false))
  })
  const composer = handle.current
  if (!composer) throw new Error('missing composer')
  const images = composer.getImageBlocks()
  expect(images).toHaveLength(accepted)
  if (count > accepted) expect(onError.mock.calls[0]?.[0].message).toContain('像素')
  else expect(onError).not.toHaveBeenCalled()
  await act(async () => composer.restoreImageBlocks(images))
  expect(composer.getImageBlocks()).toEqual(images)
  await act(async () => composer.restoreImageBlocks([{ type: 'image', data: 'bad', mimeType: 'image/png' }]))
  expect(composer.getImageBlocks()).toEqual(images)
})
