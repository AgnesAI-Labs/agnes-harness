/** @vitest-environment happy-dom */

import type { ShellSnapshot } from '@agnes/extension-api/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWorkbenchShell,
  type WorkbenchHost,
  type WorkbenchRegions,
} from '../../src/runtime/providers/workbench-shell.js'
import { createLegacyShellServices } from '../../src/runtime/services/legacy-shell-services.js'
import { createShellSwitcher, type ShellSwitcher } from '../../src/runtime/shell-state.js'
import { mountRenderedIndex, mountWorkbench, resetWebDom } from '../web-dom-fixture.js'

const SNAPSHOT: ShellSnapshot = {
  sessionId: null,
  catalogRevision: 0,
  conversation: null,
  views: [],
  pending: [],
  connection: 'offline',
  cursor: null,
}
const switches: ShellSwitcher[] = []

afterEach(async () => {
  for (const shells of switches.splice(0)) await shells.dispose()
  resetWebDom()
})

/** The ids every id reference in `root` names: labels, ARIA relations and in-page links. */
function references(root: HTMLElement): string[] {
  const names = ['for', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-activedescendant']
  return [...root.querySelectorAll('*')].flatMap((node) => [
    ...names.flatMap((name) => node.getAttribute(name)?.split(/\s+/).filter(Boolean) ?? []),
    ...(node.getAttribute('href')?.startsWith('#') ? [node.getAttribute('href')?.slice(1) ?? ''] : []),
  ])
}

/** A host that mounts no regions; it records the draft the shell hands over. */
function fakeHost(notices: HTMLElement[], draft = { value: '' }) {
  const mounted: WorkbenchRegions[] = []
  const host: WorkbenchHost = {
    notices,
    async mount(regions) {
      mounted.push(regions)
      return {
        translate: (key) => (key === 'index-shell.tabTrace' ? '轨迹' : key),
        draft: () => draft.value,
        setDraft: (value) => {
          draft.value = value
        },
        dispose: async () => undefined,
      }
    },
  }
  return { host, mounted, draft }
}

function page() {
  document.documentElement.innerHTML =
    '<head></head><body><p id="notice" role="alert"></p><div id="agnes-shell"></div></body>'
  const shells = createShellSwitcher({
    surface: document.getElementById('agnes-shell') as HTMLElement,
    services: createLegacyShellServices({ open: async () => undefined }),
    snapshot: () => SNAPSHOT,
  })
  switches.push(shells)
  return { shells, notice: document.getElementById('notice') as HTMLElement }
}

describe('built-in workbench shell', () => {
  it('lays out two workbenches in one document, each with ids and references of its own', async () => {
    await mountRenderedIndex()
    const surface = document.createElement('div')
    document.body.append(surface)
    switches.push((await mountWorkbench(surface)).shells)
    await vi.waitFor(() => expect(document.querySelectorAll('.empty-state-heading')).toHaveLength(2))

    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
    const workbenches = [...document.querySelectorAll<HTMLElement>('[data-agnes-workbench]')]
    expect(workbenches).toHaveLength(2)
    for (const root of workbenches) {
      const named = references(root)
      expect(named.length).toBeGreaterThan(5)
      for (const id of named) expect(root.contains(document.getElementById(id)), id).toBe(true)
      const prompt = root.querySelector('.composer-prompt')
      expect(root.querySelector(`label[for="${prompt?.id}"]`)).not.toBeNull()
    }
  })

  it('carries the draft and the page notices into the workbench that replaces it', async () => {
    const { shells, notice } = page()
    const first = fakeHost([notice], { value: 'half-written reply' })
    expect(await shells.switchTo(() => createWorkbenchShell(first.host))).toEqual({
      ok: true,
      value: undefined,
    })
    const [old] = first.mounted
    expect(notice.previousElementSibling).toBe(old?.topbar)
    expect(old?.traceTab.textContent).toBe('轨迹')

    const second = fakeHost([notice])
    expect(await shells.switchTo(() => createWorkbenchShell(second.host))).toEqual({
      ok: true,
      value: undefined,
    })
    const [next] = second.mounted
    expect(second.draft.value).toBe('half-written reply')
    expect(notice.previousElementSibling).toBe(next?.topbar)
    expect(old?.main.isConnected).toBe(false)
    expect(next?.main.id).not.toBe(old?.main.id)
    expect(document.querySelectorAll('[data-agnes-workbench]')).toHaveLength(1)
  })

  it('refuses the switch and gives everything back when the host cannot mount its regions', async () => {
    const { shells, notice } = page()
    const shell = createWorkbenchShell({
      notices: [notice],
      mount: async () => {
        throw new Error('no regions today')
      },
    })
    const result = await shells.switchTo(() => shell)
    expect(result).toMatchObject({
      ok: false,
      error: { detailCode: 'shell_candidate_failed', message: expect.stringContaining('no regions today') },
    })
    expect(shells.current()).toBeUndefined()
    expect(notice.isConnected).toBe(true)
    expect(notice.closest('[data-agnes-workbench], main')).toBeNull()
    expect(document.querySelector('main, [data-agnes-workbench]')).toBeNull()
  })
})
