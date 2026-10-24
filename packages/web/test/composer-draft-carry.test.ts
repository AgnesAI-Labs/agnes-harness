/** @vitest-environment happy-dom */

import { attachmentLink, userImagePolicy } from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'
import { Composer, type ComposerDependencies, type ComposerHandle, type ComposerView } from '@agnes/web-units'
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionBindingOwner } from '../src/app/session-owner.js'
import { createSubmissionController } from '../src/app/submission-controller.js'
import { ComposerDrafts } from '../src/composer-drafts.js'

let host: HTMLDivElement
let root: Root
let originalCreateObjectURL: PropertyDescriptor | undefined
let originalRevokeObjectURL: PropertyDescriptor | undefined

const dependencies: ComposerDependencies = {
  translate: (key, vars) => {
    if (!vars) return key
    return key.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.hasOwn(vars, name) ? String(vars[name]) : match,
    )
  },
  ModelPicker: () => null,
  PermissionPicker: () => null,
  UsagePanel: () => null,
  isSubmitShortcut: () => false,
}

const draftView: ComposerView = {
  imagePolicy: userImagePolicy({ input: ['text', 'image'] }),
  cancel: { disabled: true, hidden: true, label: '停止' },
  connected: true,
  configured: true,
  hasSession: false,
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
const pngFile = () => new File([Uint8Array.from(pngBytes)], 'one.png', { type: 'image/png' })

const imagePasteEvent = (files: File[]) => {
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

const response = (value: unknown) => ({ ok: true, json: async () => value }) as Response

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  // 与 composer-images 用例相同的上传桩：限额、开始上传即返回附件引用，不碰真实服务器。
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method)
        return response({
          limits: { maxBytes: 1024 * 1024, chunkBytes: 512 * 1024, allowedMimeTypes: [] },
        })
      const body = JSON.parse(String(init.body)) as {
        operation: string
        uploadId: string
        name: string
        mimeType: string
        size: number
      }
      if (body.operation === 'start')
        return response({
          attachment: attachmentLink(
            { sha256: 'a'.repeat(64), size: body.size, mime: body.mimeType },
            body.name,
            { receiptId: body.uploadId, image: { width: 1, height: 1 } },
          ),
        })
      return response({})
    }),
  )
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

it('keeps typed text when an upload opens the session and persists it under the new key', async () => {
  const handle = createRef<ComposerHandle>()
  const storage = new Map<string, string>()
  const persistent = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value)
    },
  }
  const drafts = new ComposerDrafts(persistent, 'http://synthetic')
  let opened = false
  await act(async () =>
    root.render(
      createElement(Composer, {
        ref: handle,
        dependencies,
        initialDraft: '',
        initialView: draftView,
        // 与 app.ts 的 selectComposerDraft 一致：新会话建立时把草稿迁移过去，再清掉旧的附件代次。
        prepareUploadSession: async () => {
          const id = 'opened-session'
          if (!opened) {
            opened = true
            handle.current?.setDraft(drafts.select('profile', id, handle.current.getDraft(), { carry: true }))
            handle.current?.clearImageBlocks()
            handle.current?.render({ ...draftView, hasSession: true })
          }
          return id
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
  const text = '技能提示词：检查发布'
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, text)
  await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })))
  expect(handle.current?.getDraft()).toBe(text)

  await act(async () => input.dispatchEvent(imagePasteEvent([pngFile()])))
  await vi.waitFor(() => expect(handle.current?.getAttachmentBlocks()).toHaveLength(1))

  expect(opened).toBe(true)
  // 上传预建会话后文字仍在输入框里，附件也出现在同一条草稿上。
  expect(handle.current?.getDraft()).toBe(text)
  expect(input.value).toBe(text)
  expect(host.querySelector('[data-testid="attachment-ready"]')).not.toBeNull()
  // 刷新页面会新建实例，只能从新会话 key 的存储里读回文字。
  expect(new ComposerDrafts(persistent, 'http://synthetic').select('profile', 'opened-session', '')).toBe(
    text,
  )
})

it('asks the attachment session to carry the draft into the new session key', async () => {
  const binding = new SessionBindingOwner()
  const created = { id: 'created' } as Session
  const opened: { carryDraft?: boolean; preserveSending?: boolean }[] = []
  const context = {
    current: undefined,
    draftingNew: true,
    selectedWorkspace: { path: '/synthetic/work', available: true },
    sessionPending: false,
    sessionBinding: binding,
    renderControls() {},
    draftLoopAvailable: () => true,
    loopCatalogPending: false,
    draftBundles: [],
    draftSessionRequest: () => ({}),
    client: { session: { new: async () => created } },
    open: async (_id: string, options: { carryDraft?: boolean; preserveSending?: boolean }) => {
      opened.push(options)
      binding.attach(binding.capture(), { session: created })
    },
    t: (key: string) => key,
    settingsText: (key: string) => key,
  } as unknown as Parameters<typeof createSubmissionController>[0]
  await expect(createSubmissionController(context).prepareAttachmentSession()).resolves.toBe('created')
  // carry 把文字写进新会话 key；preserveSending 同时保留提交快照，两者叠加时 carry 生效。
  expect(opened).toEqual([expect.objectContaining({ carryDraft: true, preserveSending: true })])
})
