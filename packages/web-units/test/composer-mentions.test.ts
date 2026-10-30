/** @vitest-environment happy-dom */
import { createRegionRenderer, type RegionRenderer } from '@agnes/web-ui'
import { act, createElement, createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComposerProps } from '../src/composer/contracts.js'
import { type DraftMention, mentionTokens } from '../src/composer/file-mentions.js'
import { skillMentionTokens } from '../src/composer/skill-mentions.js'
import {
  Composer,
  type ComposerDependencies,
  type ComposerHandle,
  type ComposerView,
} from '../src/composer.js'
import { webUnitsLocaleCatalog } from '../src/locales/index.js'
import { createComposerReferences, withFolders } from '../src/reference-picker.js'

const dependencies: ComposerDependencies = {
  translate: (key, vars) =>
    (webUnitsLocaleCatalog['zh-CN'][key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
      vars && Object.hasOwn(vars, name) ? String(vars[name]) : match,
    ),
  ModelPicker: () => null,
  PermissionPicker: () => null,
  UsagePanel: () => null,
  isSubmitShortcut: (event) => event.key === 'Enter' && !event.shiftKey,
}

const ROOT = '/work/WorkLLM'
const view: ComposerView = {
  cancel: { disabled: true, hidden: true, label: '停止' },
  connected: true,
  configured: true,
  hasSession: true,
  hint: { kind: 'shortcut', text: '' },
  input: { disabled: false, placeholder: '' },
  loading: false,
  model: { accessibleName: 'model', disabled: false, label: 'model', options: [], pending: false },
  permission: { disabled: false, pending: false, selected: 'workspace' },
  sending: false,
  send: { disabled: false, label: '发送', mode: 'idle', title: '发送' },
  stopping: false,
  usage: undefined,
  workspace: { disabled: false, label: 'WorkLLM', title: ROOT, visible: false, root: ROOT },
}

const regions: RegionRenderer[] = []
function mount(overrides: Partial<ComposerProps> = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  const region = createRegionRenderer(host)
  regions.push(region)
  const handle = createRef<ComposerHandle>()
  const props = {
    onCancel: vi.fn(),
    onDraftChange: vi.fn(),
    onError: vi.fn(),
    onSubmit: vi.fn(),
    onWorkspace: vi.fn(),
    onModelSelect: async () => false,
    onPermissionSelect: async () => false,
    ...overrides,
  }
  region.render(createElement(Composer, { ...props, ref: handle, dependencies, initialView: view }))
  region.flush()
  const prompt = host.querySelector<HTMLTextAreaElement>('#prompt')
  if (!prompt || !handle.current) throw new Error('composer did not mount')
  return { host, handle: handle.current, prompt, props }
}
function type(prompt: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(prompt, value)
  prompt.setSelectionRange(value.length, value.length)
  prompt.dispatchEvent(new Event('input', { bubbles: true }))
}
const press = (prompt: HTMLTextAreaElement, key: string) =>
  prompt.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

afterEach(() => {
  for (const region of regions.splice(0)) region.unmount()
  document.body.replaceChildren()
})

const report = { path: `${ROOT}/fde-output/3-report.md`, name: '3-report.md', directory: false }
const portal = { path: `${ROOT}/boot portal.html`, name: 'boot portal.html', directory: false }
const folder = { path: `${ROOT}/fde-output`, name: 'fde-output', directory: true }

describe('file chips in the draft', () => {
  it('inserts a chip at the caret and sends a link to the real path with the readable anchor', async () => {
    const { host, handle, prompt } = mount()
    type(prompt, '看看这个')
    await vi.waitFor(() => expect(prompt.value).toBe('看看这个'))
    act(() => {
      prompt.setSelectionRange(2, 2)
      handle.mention(portal)
    })
    await vi.waitFor(() => expect(handle.getDraft()).toBe('看看  @boot portal.html  这个'))
    const chip = await vi.waitFor(() => {
      const found = host.querySelector<HTMLElement>('[data-testid="composer-file-mention"]')
      expect(found).toBeTruthy()
      return found as HTMLElement
    })
    // The chip shows the type icon and name; the full local path shows on hover.
    expect(chip.textContent).toContain('boot portal.html')
    expect(chip.textContent).not.toContain('@')
    expect(chip.title).toBe(portal.path)
    expect(chip.querySelector('svg')).toBeTruthy()
    expect(handle.getAttachmentBlocks()).toEqual([
      {
        type: 'resource_link',
        uri: 'file:///work/WorkLLM/boot%20portal.html',
        name: 'boot portal.html',
      },
    ])
  })

  it('names a folder with the folder MIME type and icon', async () => {
    const { host, handle } = mount()
    act(() => handle.mention(folder))
    await vi.waitFor(() => expect(handle.getDraft()).toBe('@fde-output  '))
    expect(host.querySelector('[data-testid="composer-file-mention"]')?.getAttribute('data-directory')).toBe(
      'true',
    )
    expect(handle.getAttachmentBlocks()).toEqual([
      {
        type: 'resource_link',
        uri: 'file:///work/WorkLLM/fde-output',
        name: 'fde-output',
        mimeType: 'inode/directory',
      },
    ])
  })

  it('takes a chip whole with Backspace or Delete, and with its remove button', async () => {
    const { host, handle, prompt } = mount()
    act(() => handle.mention(report))
    await vi.waitFor(() => expect(handle.getDraft()).toBe('@3-report.md  '))
    const token = mentionTokens(handle.getDraft(), [{ ...report, label: report.name }])[0]!
    prompt.setSelectionRange(token.start, token.start)
    press(prompt, 'ArrowRight')
    expect(prompt.selectionStart).toBe(token.end)
    prompt.setSelectionRange(token.end, token.end)
    press(prompt, 'ArrowLeft')
    expect(prompt.selectionStart).toBe(token.start)
    // Caret right after the chip's text: Backspace removes all of it.
    prompt.setSelectionRange(12, 12)
    press(prompt, 'Backspace')
    await vi.waitFor(() => expect(handle.getDraft()).toBe('  '))
    expect(handle.getAttachmentBlocks()).toEqual([])

    act(() => handle.mention(report))
    await vi.waitFor(() => expect(handle.getDraft()).toContain('@3-report.md'))
    const start = handle.getDraft().indexOf('@')
    prompt.setSelectionRange(start, start)
    press(prompt, 'Delete')
    await vi.waitFor(() => expect(handle.getDraft()).not.toContain('@3-report.md'))

    act(() => handle.mention(report))
    const remove = await vi.waitFor(() => {
      const found = host.querySelector<HTMLElement>('[data-testid="composer-file-mention-remove"]')
      expect(found?.getAttribute('aria-label')).toBe('移除 3-report.md')
      return found as HTMLElement
    })
    remove.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    await vi.waitFor(() => expect(handle.getDraft()).not.toContain('@3-report.md'))
    expect(handle.getAttachmentBlocks()).toEqual([])
  })

  it('reports a newly inserted file reference before React has rendered it', () => {
    const { handle } = mount()
    act(() => handle.mention(report))
    expect(handle.getDraftReferences()).toEqual({ files: [report], skills: [] })
  })

  it('drops a chip whose text was deleted, keeps one link per file and clears after sending', async () => {
    const { handle, prompt } = mount()
    act(() => handle.mention(report))
    act(() => handle.mention(portal))
    await vi.waitFor(() => expect(handle.getDraft()).toBe('@3-report.md  @boot portal.html  '))
    type(prompt, '只要 @boot portal.html 和 @boot portal.html')
    expect(handle.getAttachmentBlocks().map((block) => 'name' in block && block.name)).toEqual([
      'boot portal.html',
    ])
    act(() => handle.clearImageBlocks())
    expect(handle.getAttachmentBlocks()).toEqual([])
  })

  it('gives back its chips when a failed send restores the draft and its blocks', async () => {
    const { handle } = mount()
    act(() => handle.setDraft('再看 @3-report.md'))
    act(() =>
      handle.restoreAttachmentBlocks([
        {
          type: 'resource_link',
          uri: 'file:///work/WorkLLM/fde-output/3-report.md',
          name: '3-report.md',
        },
      ]),
    )
    await vi.waitFor(() =>
      expect(handle.getAttachmentBlocks()).toEqual([
        {
          type: 'resource_link',
          uri: 'file:///work/WorkLLM/fde-output/3-report.md',
          name: '3-report.md',
        },
      ]),
    )
  })

  it('tells two files with the same name apart by their folder', () => {
    const one = { ...report, label: '3-report.md' } satisfies DraftMention
    const two = { ...report, path: `${ROOT}/other/3-report.md`, label: 'other/3-report.md' }
    expect(
      mentionTokens('@3-report.md 和 @other/3-report.md', [one, two]).map((token) => token.mention.path),
    ).toEqual([one.path, two.path])
    // `@3-report.md.bak` is not a chip.
    expect(mentionTokens('@3-report.md.bak', [one])).toEqual([])
  })
})

describe('skill chips in the draft', () => {
  it('renders saved file and skill references when a draft is restored', async () => {
    const { host, handle } = mount({
      initialDraft: '@3-report.md  $review-notes  ',
      initialDraftReferences: {
        files: [report],
        skills: [{ name: 'review-notes', description: 'Review project notes' }],
      },
    })
    await vi.waitFor(() => expect(host.querySelector('[data-testid="composer-file-mention"]')).toBeTruthy())
    expect(host.querySelector('[data-testid="composer-skill-mention"]')).toBeTruthy()
    expect(handle.getDraftReferences()).toEqual({
      files: [report],
      skills: [{ name: 'review-notes', description: 'Review project notes' }],
    })
  })

  it('only decorates complete selected skill names', () => {
    expect(skillMentionTokens('用 $review-notes 和 $review-notes.bak', ['review-notes'])).toEqual([
      { start: 2, end: 15, name: 'review-notes' },
    ])
  })

  it('renders a selected skill as a sparkle marker while preserving its explicit draft text', async () => {
    const { host, handle, prompt } = mount({
      skills: { list: async () => [{ name: 'review-notes', description: 'Review project notes' }] },
    })
    type(prompt, '$review')
    const option = await vi.waitFor(() => {
      const found = host.querySelector<HTMLButtonElement>('[data-testid="skill-option"]')
      expect(found).toBeTruthy()
      return found as HTMLButtonElement
    })
    expect(option.textContent).toContain('review-notes')
    expect(option.textContent).not.toContain('$review-notes')
    act(() => option.click())
    await vi.waitFor(() => expect(handle.getDraft()).toBe('$review-notes  '))
    const chip = await vi.waitFor(() => {
      const found = host.querySelector<HTMLElement>('[data-testid="composer-skill-mention"]')
      expect(found).toBeTruthy()
      return found as HTMLElement
    })
    expect(chip.textContent).toContain('review-notes')
    expect(chip.textContent).not.toContain('$')
    expect(chip.querySelector('svg')).toBeTruthy()
    act(() => chip.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="composer-skill-detail"]')).toBeTruthy(),
    )
    const token = skillMentionTokens(handle.getDraft(), ['review-notes'])[0]!
    prompt.setSelectionRange(token.start, token.start)
    press(prompt, 'ArrowRight')
    expect(prompt.selectionStart).toBe(token.end)
    prompt.setSelectionRange(token.end, token.end)
    press(prompt, 'ArrowLeft')
    expect(prompt.selectionStart).toBe(token.start)
    press(prompt, 'Delete')
    await vi.waitFor(() => expect(handle.getDraft()).toBe('  '))
  })
})

describe('@ picker', () => {
  it('lists matching folders ahead of files', () => {
    expect(
      withFolders(
        {
          items: [
            { source: 'file', id: 'fde-output/crm/3-report.md', label: 'fde-output/crm/3-report.md' },
            { source: 'session', id: 's1', label: 'fde 会话' },
          ],
          truncated: false,
        },
        'fde',
      ).items.map((item) => `${item.source}:${item.id}`),
    ).toEqual(['folder:fde-output', 'file:fde-output/crm/3-report.md', 'session:s1'])
  })

  it('turns a chosen workspace file into a chip in place of the typed @query', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const references = createComposerReferences(async () => ({
        items: [{ source: 'file', id: 'fde-output/3-report.md', label: 'fde-output/3-report.md' }],
        truncated: false,
      }))
      const { host, handle, prompt, props } = mount({ references })
      type(prompt, '总结 @rep')
      await vi.advanceTimersByTimeAsync(150)
      const options = await vi.waitFor(() => {
        const found = [...host.querySelectorAll<HTMLElement>('[data-testid="reference-option"]')]
        expect(found.length).toBe(1)
        return found
      })
      // Up and down move, Enter picks: the keyboard stays in the textarea.
      press(prompt, 'ArrowDown')
      press(prompt, 'Enter')
      // The next Enter submits even before React commits the picker closing.
      press(prompt, 'Enter')
      expect(props.onSubmit).toHaveBeenCalledTimes(1)
      expect(options).toHaveLength(1)
      await vi.waitFor(() => expect(handle.getDraft()).toBe('总结  @3-report.md  '))
      // A file is a chip and a link, not a content reference.
      expect(references.getSnapshot()).toEqual([])
      expect(handle.getAttachmentBlocks()).toEqual([
        {
          type: 'resource_link',
          uri: 'file:///work/WorkLLM/fde-output/3-report.md',
          name: '3-report.md',
        },
      ])
      // Typing after the chip does not reopen the picker on the chip's own `@`.
      type(prompt, '总结 @3-report.md 里的结论')
      await vi.advanceTimersByTimeAsync(150)
      expect(host.querySelector('.reference-popup')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('voice handle', () => {
  it('inserts text at the caret like a paste and reports the draft', async () => {
    const { handle, prompt, props } = mount()
    type(prompt, 'abcd')
    await vi.waitFor(() => expect(prompt.value).toBe('abcd'))
    act(() => {
      prompt.setSelectionRange(2, 2)
      handle.insertText?.('你好')
    })
    await vi.waitFor(() => expect(handle.getDraft()).toBe('ab你好cd'))
    expect(props.onDraftChange).toHaveBeenLastCalledWith('ab你好cd')
  })

  it('submits once like the send button even right after an insert, and not when send is disabled', async () => {
    const { handle, props } = mount()
    let sent: boolean | undefined
    act(() => {
      handle.insertText?.('hi')
      sent = handle.submit?.()
    })
    expect(sent).toBe(true)
    await vi.waitFor(() => expect(props.onSubmit).toHaveBeenCalledTimes(1))
    // The host's submit reads the draft the insert produced, not the previous one.
    expect(handle.getDraft()).toBe('hi')
    act(() => handle.render({ ...view, send: { ...view.send, disabled: true } }))
    act(() => {
      sent = handle.submit?.()
    })
    expect(sent).toBe(false)
    act(() => handle.render(view))
    act(() => {
      handle.setDraft('  ')
      sent = handle.submit?.()
    })
    expect(sent).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('renders beforeSend immediately before send and hides it when read-only', () => {
    const { host, handle } = mount({ slots: { beforeSend: createElement('span', { id: 'voice-slot' }) } })
    expect(host.querySelector('#send')?.previousElementSibling?.id).toBe('voice-slot')
    act(() => handle.render({ ...view, readOnly: true }))
    expect(host.querySelector('#voice-slot')).toBeNull()
  })
})
