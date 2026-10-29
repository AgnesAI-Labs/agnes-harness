/** @vitest-environment happy-dom */
import type { WorkspaceEntry } from '@agnes/protocol'
import { mountRegion } from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composerWorkspaceView } from '../src/app/composer-controller.js'
import { draftWorkspace } from '../src/app/workspace-controller.js'
import { WorkspacePickerControl } from '../src/workspace-picker-control.js'
import { enT, zhT } from './helpers/locale.js'

const row = (name: string, extra: Partial<WorkspaceEntry> = {}): WorkspaceEntry => ({
  path: `/work/${name}`,
  name,
  lastUsedAt: null,
  sessionCount: 0,
  available: true,
  ...extra,
})
const chats = row('chats', { path: '/data/chats', kind: 'chats' })
const project = row('WorkLLM')
const other = row('agnes-harness')

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
})

describe('draft workspace', () => {
  it('never defaults to the chats workspace unless nothing else is available', () => {
    expect(draftWorkspace([chats, project], undefined)).toBe(project)
    expect(draftWorkspace([chats, { ...project, available: false }], undefined)).toBe(chats)
    // A chat stays a chat: 「新对话」 from an open chat starts another one.
    expect(draftWorkspace([chats, project], chats)).toBe(chats)
    expect(draftWorkspace([chats, project], chats, other)).toBe(other)
  })

  it('shows the chats draft as 「选择工作区」 and offers × only when the chats workspace exists', () => {
    const view = (selected: WorkspaceEntry | undefined, rows: WorkspaceEntry[]) =>
      composerWorkspaceView({ selected, rows, current: false, drafting: true, disabled: false, t: zhT })
    expect(view(project, [chats, project])).toMatchObject({
      label: 'WorkLLM',
      path: '/work/WorkLLM',
      clearable: true,
      choices: [project],
    })
    expect(view(project, [project]).clearable).toBe(false)
    const chat = view(chats, [chats, project])
    expect(chat).toMatchObject({ label: '选择工作区', root: '/data/chats', chats: true })
    expect(chat.path).toBeUndefined()
    expect(chat.clearable).toBeUndefined()
  })
})

describe('composer workspace picker', () => {
  function render(chip: Partial<Parameters<typeof WorkspacePickerControl>[0]['workspace']> = {}, t = zhT) {
    const host = document.createElement('div')
    document.body.append(host)
    const onSelect = vi.fn()
    const onWorkspace = vi.fn()
    cleanups.push(
      mountRegion(
        host,
        <WorkspacePickerControl
          workspace={{
            label: 'WorkLLM',
            title: '/work/WorkLLM',
            root: project.path,
            disabled: false,
            clearable: true,
            choices: [project, other],
            ...chip,
          }}
          hidden={false}
          onWorkspace={onWorkspace}
          onSelect={onSelect}
          t={t}
        />,
      ),
    )
    const trigger = () => document.getElementById('composer-workspace') as HTMLButtonElement
    const open = async () => {
      flushSync(() => trigger().click())
      await vi.waitFor(() => expect(document.querySelector('.workspace-picker-panel')).not.toBeNull())
      return document.querySelector('.workspace-picker-panel') as HTMLElement
    }
    return { host, onSelect, onWorkspace, trigger, open }
  }

  it.each([zhT, enT])('leaves the workspace with ×, labelled for assistive technology', async (t) => {
    const { host, onSelect } = render({}, t)
    const clear = host.querySelector<HTMLButtonElement>('.composer-workspace-clear')
    expect(clear?.getAttribute('aria-label')).toBe(t('composer.workspace.clear'))
    flushSync(() => clear?.click())
    expect(onSelect).toHaveBeenCalledWith('chats')
  })

  it('searches, switches on one click and hands 「新建工作区…」 to the full dialog', async () => {
    const { onSelect, onWorkspace, trigger, open } = render()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    let panel = await open()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    const names = () => [...panel.querySelectorAll('.workspace-option-name')].map((node) => node.textContent)
    expect(names()).toEqual(['WorkLLM', 'agnes-harness'])
    const search = panel.querySelector('input') as HTMLInputElement
    expect(search.placeholder).toBe('搜索工作区')
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(search, 'agnes')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(names()).toEqual(['agnes-harness'])
    flushSync(() => panel.querySelector<HTMLButtonElement>('.workspace-option')?.click())
    expect(onSelect).toHaveBeenCalledWith(other)
    await vi.waitFor(() => expect(trigger().getAttribute('aria-expanded')).toBe('false'))
    panel = await open()
    const create = panel.querySelector<HTMLButtonElement>('.workspace-picker-create')
    expect(create?.textContent).toBe('新建工作区…')
    flushSync(() => create?.click())
    expect(onWorkspace).toHaveBeenCalledOnce()
  })

  it('reads as 「选择工作区」 with no × while the draft is a chat', () => {
    const { host, trigger } = render({ label: '选择工作区', chats: true, clearable: false })
    expect(trigger().dataset.chats).toBe('true')
    expect(host.querySelector('.composer-workspace-clear')).toBeNull()
  })
})
