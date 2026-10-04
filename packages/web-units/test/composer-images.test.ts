/** @vitest-environment happy-dom */

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

let host: HTMLDivElement
let root: Root
let originalCreateObjectURL: PropertyDescriptor | undefined
let originalRevokeObjectURL: PropertyDescriptor | undefined

const dependencies: ComposerDependencies = {
  // 组件从语言目录取词，桩要返回真实文案而不是 key 本身。
  translate: (key, vars) => {
    const template = webUiLocaleCatalog['zh-CN'][key] ?? key
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

  it('rejects unsupported and oversized files before creating previews', async () => {
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
      pngFile(
        'large.png',
        Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(1024 * 1024).fill(1)]),
      ),
    ]) {
      await act(async () => prompt.dispatchEvent(imagePasteEvent([file])))
    }

    expect(onError).toHaveBeenCalledTimes(3)
    expect(handle.current?.getImageBlocks()).toEqual([])
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
