/** @vitest-environment happy-dom */
import { resolve } from 'node:path'
import { settingsSections, workbenchNavigation, workbenchPanels } from '@agnes/web-client'
import { renderRegion, unmountRegion } from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { expect, it, vi } from 'vitest'
import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
import { registerJobsClientContribution } from '../src/client-modules/jobs.js'
import { registerSessionApprovalPanel } from '../src/workbench/approval-panel.js'
import { workbenchApproval } from '../src/workbench/approval-store.js'
import { Dock, renderWorkbench, unmountWorkbench, unmountWorkbenchSoon } from '../src/workbench/dock.js'
import { RIGHT_DEFAULT } from '../src/workbench/dock-size.js'
import { cycleTaskFocus } from '../src/workbench/focus.js'
import { mentionPanelPath } from '../src/workbench/mention-path.js'

it.each([
  ['C:\\work\\repo', 'c:/work/repo/src/中文 #%.ts', 'src/中文 #%.ts'],
  ['C:\\work\\repo\\', 'C:/work/repo', ''],
  ['C:\\', 'c:/src', 'src'],
  ['\\\\server\\share\\repo', '//server/share/repo/src', 'src'],
  ['\\\\server\\share', '//server/other/src', '//server/other/src'],
  ['C:/repo', 'D:/repo/src', 'D:/repo/src'],
  ['C:/repo', 'C:/repo-other/src', 'C:/repo-other/src'],
  ['C:/repo', 'C:/repo/../outside', 'C:/repo/../outside'],
  ['C:/Repo', 'C:/repo/src', 'C:/repo/src'],
  ['/repo', '/repo/a\\b', 'a\\b'],
  ['/', '/src', 'src'],
])('maps a mention from %s without changing the filesystem target', (root, path, expected) => {
  expect(mentionPanelPath(root, path)).toBe(expected)
})

it('restores focus on Escape, resizes with keys, retires registrations and detaches on unmount', () => {
  const css = readWebStyleSource(resolve(__dirname, '../public/style.css'))
  // A short dock gives the emulator a bounded viewport so fit can resize the PTY.
  const terminalJob = [...css.matchAll(/\.workbench-terminal-job \{([^}]*)\}/g)].at(-1)?.[1]
  expect(terminalJob).toContain('flex: 1;')
  expect(terminalJob).toContain('min-height: 0')
  expect(/\.workbench-terminal,\s*\.workbench-terminal-job \{([^}]*)\}/.exec(css)?.[1]).not.toContain(
    'height: 100%',
  )
  expect(css).toContain('@container (max-width: 560px)')
  expect(/\.workbench-terminal-bar \{([^}]*)\}/.exec(css)?.[1]).toContain('width: 168px')
  expect(css).toContain('flex-direction: row;')
  localStorage.clear()
  document.body.innerHTML =
    '<div class="workbench-split"><div id="controls"></div><aside id="workbench-right" hidden><div id="workbench-right-content"></div></aside><aside id="workbench-bottom" hidden><div id="workbench-bottom-content"></div></aside></div>'
  const host = document.getElementById('controls') as HTMLElement
  const first = workbenchPanels.register({
    id: 'test.first',
    order: 1,
    edge: 'right',
    titleKey: 'First',
    component: ({ context }) => (
      <>
        <p>First panel</p>
        <button
          type="button"
          data-testid="navigate-review"
          onClick={() => context.openPanel?.('test.second', { path: 'actual.txt' })}
        >
          Review
        </button>
      </>
    ),
  })
  const second = workbenchPanels.register({
    id: 'test.second',
    order: 2,
    edge: 'right',
    titleKey: 'Second',
    visibility: 'contextual',
    when: (context) => context.data === 'show',
    component: ({ context }) => <p>Second panel {(context.selection as { path?: string })?.path}</p>,
  })
  let replacement: (() => void) | undefined
  const plugins: Array<() => void> = []
  try {
    renderRegion(host, <Dock context={{ t: (key) => key }} />)
    expect(document.getElementById('workbench-tab-test.second')).toBeNull()
    renderRegion(host, <Dock context={{ t: (key) => key, data: 'show' }} />)
    const toggle = host.querySelector('[data-edge="right"]') as HTMLButtonElement
    expect(toggle.textContent).toBe('')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.querySelector('.workbench-toggle-pane')).not.toBeNull()
    flushSync(() => toggle.click())
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    const dock = document.getElementById('workbench-right') as HTMLElement
    expect(dock.hidden).toBe(false)
    flushSync(() => (dock.querySelector('[data-testid="navigate-review"]') as HTMLButtonElement).click())
    expect(dock.textContent).toContain('Second panel actual.txt')
    flushSync(() => (dock.querySelector('[role="tab"]') as HTMLButtonElement).click())
    const resize = dock.querySelector('hr') as HTMLElement
    expect(resize.getAttribute('aria-valuenow')).toBe(
      String(Math.min(RIGHT_DEFAULT, window.innerWidth - 420)),
    )
    flushSync(() => resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(
      document.querySelector<HTMLElement>('.workbench-split')?.style.getPropertyValue('--workbench-width'),
    ).toBe(`${Math.min(RIGHT_DEFAULT, window.innerWidth - 420) - 16}px`)
    // The limit comes from the window (happy-dom: 1024px wide), not from a fixed 480px ceiling.
    const width = () =>
      document.querySelector<HTMLElement>('.workbench-split')?.style.getPropertyValue('--workbench-width')
    expect(resize.getAttribute('aria-valuemax')).toBe(String(window.innerWidth - 420))
    for (let step = 0; step < 40; step++)
      flushSync(() => resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(width()).toBe(`${window.innerWidth - 420}px`)
    expect(resize.getAttribute('aria-valuenow')).toBe(String(window.innerWidth - 420))
    expect(JSON.parse(localStorage.getItem('agnes.workbench.layout.v1') ?? '{}').rightWidth).toBe(
      window.innerWidth - 420,
    )
    flushSync(() => resize.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(width()).toBe(`${Math.min(RIGHT_DEFAULT, window.innerWidth - 420)}px`)
    flushSync(() => resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(width()).toBe(`${Math.min(RIGHT_DEFAULT, window.innerWidth - 420) - 16}px`)
    const selected = dock.querySelector('[aria-selected="true"]') as HTMLButtonElement
    selected.focus()
    flushSync(() =>
      selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    )
    expect(dock.textContent).toContain('Second panel')
    flushSync(second)
    expect(dock.textContent).toContain('First panel')
    expect(() =>
      workbenchPanels.register({
        id: 'test.first',
        order: 1,
        edge: 'right',
        titleKey: 'Duplicate',
        component: () => null,
      }),
    ).toThrow('already registered')
    flushSync(first)
    flushSync(() => {
      replacement = workbenchPanels.register({
        id: 'test.first',
        order: 1,
        edge: 'right',
        titleKey: 'Replacement',
        component: () => <p>Replacement panel</p>,
      })
    })
    flushSync(first)
    expect(dock.textContent).toContain('Replacement panel')
    expect(host.querySelector('[data-edge="bottom"]')).toBeNull()
    flushSync(() => {
      for (let index = 0; index < 6; index++)
        plugins.push(
          workbenchPanels.register({
            id: `test.extra.${index}`,
            order: index + 10,
            edge: 'right',
            titleKey: `Extra ${index}`,
            component: () => <p>Extra content {index}</p>,
          }),
        )
      plugins.push(
        workbenchPanels.register({
          id: 'test.bottom',
          order: 1,
          edge: 'bottom',
          titleKey: 'Plugin bottom',
          component: () => <p>Bottom plugin content</p>,
        }),
      )
    })
    expect(dock.querySelectorAll('[role="tab"]')).toHaveLength(5)
    const firstTab = dock.querySelector('[role="tab"]') as HTMLButtonElement
    flushSync(() => firstTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(document.activeElement?.id).toBe('workbench-tab-test.extra.5')
    expect(dock.textContent).toContain('Extra content 5')
    expect(dock.querySelectorAll('[role="tab"]')).toHaveLength(5)
    flushSync(() => (host.querySelector('[data-edge="bottom"]') as HTMLButtonElement).click())
    expect(document.getElementById('workbench-bottom')?.textContent).toContain('Bottom plugin content')
    flushSync(() => plugins.at(-1)?.())
    expect(document.getElementById('workbench-bottom')?.hidden).toBe(true)
    expect(host.querySelector('[data-edge="bottom"]')).toBeNull()
    const consumedEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    consumedEscape.preventDefault()
    flushSync(() => dock.dispatchEvent(consumedEscape))
    expect(dock.hidden).toBe(false)
    flushSync(() => dock.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(dock.hidden).toBe(true)
    expect(document.activeElement).toBe(toggle)
    flushSync(() => toggle.click())
    expect(dock.hidden).toBe(false)
    unmountRegion(host)
    expect(dock.hidden).toBe(true)
    expect(dock.querySelector('[role="tabpanel"]')).toBeNull()
    expect(document.querySelector('.workbench-split')?.classList.contains('workbench-right-open')).toBe(false)
  } finally {
    unmountRegion(host)
    first()
    second()
    replacement?.()
    for (const remove of plugins) remove()
    document.body.replaceChildren()
    localStorage.clear()
  }
})

it('restores explicit dock visibility only for the same session, including new-chat remounts', () => {
  localStorage.clear()
  localStorage.setItem('agnes.workbench.layout.v1', JSON.stringify({ rightOpen: true, rightWidth: 540 }))
  document.body.innerHTML =
    '<div class="workbench-split"><div id="controls"></div><aside id="workbench-right" hidden><div id="workbench-right-content"></div></aside><aside id="workbench-bottom" hidden><div id="workbench-bottom-content"></div></aside></div>'
  const host = document.getElementById('controls')!
  const dock = document.getElementById('workbench-right')!
  let frame: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const remove = workbenchPanels.register({
    id: 'test.session-browser',
    edge: 'right',
    order: -100,
    titleKey: 'Browser',
    component: () => <p>Live browser</p>,
  })
  const renderSession = (id: string) => {
    renderWorkbench(host, { t: (key) => key, data: { session: { id } } })
    flushSync(() => frame?.(0))
  }
  try {
    renderSession('first')
    expect(dock.hidden).toBe(true) // Legacy global visibility cannot open a conversation's browser.
    expect(dock.textContent).not.toContain('Live browser')
    flushSync(() => {
      expect(workbenchNavigation.open('test.session-browser')).toBe(true)
    })
    expect(dock.hidden).toBe(false)
    unmountWorkbench(host)
    renderSession('first') // Same-session refresh retains the reader's explicit choice.
    expect(dock.hidden).toBe(false)
    renderSession('second') // Direct sidebar switch must also isolate visibility.
    expect(dock.hidden).toBe(true)
    expect(dock.textContent).not.toContain('Live browser')
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-edge="right"]')!.click())
    expect(dock.hidden).toBe(false)
    unmountWorkbench(host) // New-chat draft unmounts the workbench before the first send.
    renderSession('new-chat')
    expect(dock.hidden).toBe(true)
    renderSession('new-chat') // Ordinary reply refreshes do not open it.
    expect(dock.hidden).toBe(true)
    expect(JSON.parse(localStorage.getItem('agnes.workbench.layout.v1')!).rightWidth).toBe(540)
    flushSync(() => {
      expect(workbenchNavigation.open('test.session-browser')).toBe(true)
    })
    expect(dock.hidden).toBe(false) // Explicit links and controls still open the panel.
  } finally {
    unmountWorkbench(host)
    remove()
    vi.unstubAllGlobals()
    localStorage.clear()
    document.body.replaceChildren()
  }
})

it('cycles visible trace and plugin docks in both directions and leaves modal focus intact', () => {
  document.body.innerHTML = `
    <aside class="sidebar"><button id="sidebar-action">New session</button></aside>
    <section class="conversation-shell" hidden><button>Hidden conversation</button></section>
    <aside id="trace-panel"><select aria-label="Trace type"><option>All</option></select></aside>
    <aside id="workbench-right" hidden><button>Hidden dock</button></aside>
    <aside id="rightbar-panel"><button id="plugin-action">Plugin action</button></aside>
    <aside id="workbench-bottom"><button id="bottom-action">Terminal</button></aside>
    <form id="composer"><textarea aria-label="Task content"></textarea></form>`
  const geometry = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement,
  ) {
    return (this.closest('[hidden]') ? [] : [{}]) as unknown as DOMRectList
  })
  try {
    const selectors = [
      '#sidebar-action',
      '#trace-panel select',
      '#plugin-action',
      '#bottom-action',
      '#composer textarea',
    ]
    document.querySelector<HTMLElement>(selectors[0]!)!.focus()
    for (const reverse of [false, true]) {
      const expected = reverse ? [...selectors].reverse() : [...selectors.slice(1), selectors[0]!]
      for (const selector of expected) {
        cycleTaskFocus(new KeyboardEvent('keydown', { key: 'F6', shiftKey: reverse, cancelable: true }))
        expect(document.activeElement).toBe(document.querySelector(selector))
      }
    }
    const bottom = document.getElementById('workbench-bottom')!
    bottom.style.position = 'fixed'
    bottom.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') bottom.hidden = true
    })
    document.getElementById('bottom-action')!.focus()
    cycleTaskFocus(new KeyboardEvent('keydown', { key: 'F6', cancelable: true }))
    expect(bottom.hidden).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('#composer textarea'))
    const right = document.getElementById('workbench-right')!
    right.hidden = false
    right.style.position = 'absolute'
    right.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') right.hidden = true
    })
    right.querySelector('button')!.focus()
    cycleTaskFocus(new KeyboardEvent('keydown', { key: 'F6', cancelable: true }))
    expect(right.hidden).toBe(true)
    expect(document.activeElement).toBe(document.getElementById('plugin-action'))
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    try {
      right.hidden = false
      right.querySelector('button')!.focus()
      cycleTaskFocus(new KeyboardEvent('keydown', { key: 'F6', cancelable: true }))
      expect(right.hidden).toBe(false)
      expect(document.activeElement).toBe(document.getElementById('plugin-action'))
      cycleTaskFocus(new KeyboardEvent('keydown', { key: 'F6', shiftKey: true, cancelable: true }))
      expect(document.activeElement).toBe(right.querySelector('button'))
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    }
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.innerHTML = '<button>Close</button>'
    document.body.append(modal)
    const close = modal.querySelector('button')!
    close.focus()
    cycleTaskFocus(new KeyboardEvent('keydown', { key: 'F6', cancelable: true }))
    expect(document.activeElement).toBe(close)
  } finally {
    geometry.mockRestore()
    document.body.replaceChildren()
  }
})

it('batches controller refreshes and isolates a failed right panel from the bottom panel and controls', () => {
  localStorage.clear()
  document.body.innerHTML =
    '<div class="workbench-split"><div id="controls"></div><aside id="workbench-right" hidden><div id="workbench-right-content"></div></aside><aside id="workbench-bottom" hidden><div id="workbench-bottom-content"></div></aside></div>'
  const host = document.getElementById('controls') as HTMLElement
  let fail = false
  let frame: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
  const right = workbenchPanels.register({
    id: 'test.error-right',
    edge: 'right',
    order: -100,
    titleKey: 'Right',
    component: ({ context }) => {
      if (fail) throw new Error('synthetic right panel failure')
      return <p>Right {(context.data as { progress: number }).progress}</p>
    },
  })
  const bottom = workbenchPanels.register({
    id: 'test.safe-bottom',
    edge: 'bottom',
    order: -100,
    titleKey: 'Bottom',
    component: ({ context }) => <p>Bottom {(context.data as { progress: number }).progress}</p>,
  })
  try {
    renderWorkbench(host, { t: (key) => key, data: { progress: 0 } })
    flushSync(() => {
      host.querySelector<HTMLButtonElement>('[data-edge="right"]')?.click()
      host.querySelector<HTMLButtonElement>('[data-edge="bottom"]')?.click()
    })
    const rightHost = document.getElementById('workbench-right-content')!
    const bottomHost = document.getElementById('workbench-bottom-content')!
    expect(rightHost.textContent).toContain('Right 0')
    expect(bottomHost.textContent).toContain('Bottom 0')
    for (let progress = 1; progress <= 100; progress++)
      renderWorkbench(host, { t: (key) => key, data: { progress } })
    expect(bottomHost.textContent).toContain('Bottom 0')
    flushSync(() => frame?.(0))
    expect(bottomHost.textContent).toContain('Bottom 100')
    fail = true
    renderWorkbench(host, { t: (key) => key, data: { progress: 101 } })
    flushSync(() => frame?.(0))
    expect(rightHost.querySelector('[data-agnes-region-error="workbench-right"]')).not.toBeNull()
    expect(bottomHost.textContent).toContain('Bottom 101')
    expect(host.querySelector('[data-edge="right"]')).not.toBeNull()
    expect(rightHost.querySelector('[role=tab]')).not.toBeNull()
    const expand = rightHost.querySelector<HTMLButtonElement>('[aria-label="workbench.expand"]')
    const close = rightHost.querySelector<HTMLButtonElement>('[aria-label="workbench.close"]')
    expect(expand).not.toBeNull()
    expect(close).not.toBeNull()
    if (!expand || !close) throw new Error('Missing workbench chrome')
    flushSync(() => expand.click())
    expect(expand.getAttribute('aria-pressed')).toBe('true')
    flushSync(() => close.click())
    expect(document.getElementById('workbench-right')?.hidden).toBe(true)
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-edge="right"]')?.click())
    fail = false
    flushSync(() => rightHost.querySelector<HTMLButtonElement>('[data-agnes-region-error] button')?.click())
    expect(rightHost.textContent).toContain('Right 101')
  } finally {
    unmountWorkbench(host)
    right()
    bottom()
    diagnostics.mockRestore()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  }
})

it('shows a tab count beside the title and re-reads it when its source notifies', () => {
  localStorage.clear()
  document.body.innerHTML =
    '<div class="workbench-split"><div id="controls"></div><aside id="workbench-right" hidden><div id="workbench-right-content"></div></aside><aside id="workbench-bottom" hidden><div id="workbench-bottom-content"></div></aside></div>'
  const host = document.getElementById('controls') as HTMLElement
  const listeners = new Set<() => void>()
  let value: number | undefined = 3
  const remove = workbenchPanels.register({
    id: 'test.counted',
    order: 1,
    edge: 'right',
    titleKey: 'Changes',
    count: {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      read: (context) => (context.data === 'session' ? value : undefined),
    },
    component: () => <p>Counted</p>,
  })
  try {
    renderRegion(host, <Dock context={{ t: (key) => key, data: 'session' }} />)
    flushSync(() => (host.querySelector('[data-edge="right"]') as HTMLButtonElement).click())
    const tab = document.getElementById('workbench-tab-test.counted')
    expect(tab?.querySelector('[data-testid="workbench-tab-count-test.counted"]')?.textContent).toBe('3')
    value = 0
    flushSync(() => {
      for (const listener of listeners) listener()
    })
    expect(tab?.querySelector('.workbench-tab-count')).toBeNull()
    value = 12
    flushSync(() => {
      for (const listener of listeners) listener()
    })
    expect(tab?.textContent).toBe('Changes12')
  } finally {
    unmountRegion(host)
    remove()
    expect(listeners.size).toBe(0)
    localStorage.clear()
  }
})

it('registers and retires the shared jobs client contribution without owning a backend', () => {
  const release = registerJobsClientContribution()
  expect(workbenchPanels.get('terminal')?.titleKey).toBe('workbench.terminal.title')
  expect(settingsSections.get('background-jobs')?.runtimeCatalog).toBe(false)
  release()
  expect(workbenchPanels.get('terminal')).toBeUndefined()
  expect(settingsSections.get('background-jobs')).toBeUndefined()
})

it('defers a session-switch unmount past the current task and cancels it when the dock renders again', async () => {
  document.body.innerHTML =
    '<div class="workbench-split"><div id="controls"></div><aside id="workbench-right" hidden><div id="workbench-right-content"></div></aside><aside id="workbench-bottom" hidden><div id="workbench-bottom-content"></div></aside></div>'
  const host = document.getElementById('controls')!
  const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    renderWorkbench(host, { t: (key) => key, data: { session: { id: 'first' } } })
    const mounted = host.innerHTML
    expect(mounted).not.toBe('')
    // Switching sessions: the click task does not pay for tearing the dock down.
    unmountWorkbenchSoon(host)
    expect(host.innerHTML).toBe(mounted)
    await nextTask()
    expect(host.innerHTML).toBe('')
    // A dock rendered again before the deferred unmount runs stays mounted.
    renderWorkbench(host, { t: (key) => key, data: { session: { id: 'second' } } })
    unmountWorkbenchSoon(host)
    renderWorkbench(host, { t: (key) => key, data: { session: { id: 'second' } } })
    await nextTask()
    expect(host.innerHTML).not.toBe('')
  } finally {
    unmountWorkbench(host)
    document.body.replaceChildren()
  }
})

it('shows an approval dock without application tabs and focuses the sole conversation gate', () => {
  document.body.innerHTML =
    '<div class="workbench-split"><div id="controls"></div><aside id="workbench-right" hidden><div id="workbench-right-content"></div></aside><aside id="workbench-bottom" hidden><div id="workbench-bottom-content"></div></aside></div><div id="approval-content"><div data-approval-key="child-gate"><button data-approval-action="allow">Allow once</button></div></div>'
  const host = document.getElementById('controls')!
  const release = registerSessionApprovalPanel()
  try {
    renderWorkbench(host, { t: (key) => key, data: { session: { id: 'parent' } } })
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-edge="right"]')?.click())
    expect(document.getElementById('workbench-tab-approvals')).toBeNull()
    const confirm = vi.fn()
    flushSync(() =>
      workbenchApproval.set({
        key: 'child-gate',
        title: 'Human approval',
        summary: 'Role requirements · child parent/child · write docs/SRS.md · taint',
        impact: 'Write file',
        actions: [{ id: 'live:allow_once', label: 'Allow once', onSelect: confirm }],
        disabled: false,
      }),
    )
    const tab = document.getElementById('workbench-tab-approvals')!
    expect(tab).not.toBeNull()
    flushSync(() => tab.click())
    const panel = document.getElementById('workbench-right-content')!
    expect(panel.textContent).toContain('Role requirements · child parent/child · write docs/SRS.md · taint')
    expect(panel.querySelector('[data-approval-action]')).toBeNull()
    flushSync(() =>
      [...panel.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Go to confirmation')!
        .click(),
    )
    expect(document.activeElement).toBe(document.querySelector('[data-approval-action]'))
    expect(confirm).not.toHaveBeenCalled()
    flushSync(() => workbenchApproval.set(undefined))
    expect(document.getElementById('workbench-tab-approvals')).toBeNull()
  } finally {
    unmountWorkbench(host)
    release()
    workbenchApproval.set(undefined)
    localStorage.clear()
    document.body.replaceChildren()
  }
  expect(workbenchPanels.get('approvals')).toBeUndefined()
})

it('opens a panel at the selection a link carries', () => {
  localStorage.clear()
  document.body.innerHTML =
    '<div class="workbench-split"><div id="controls"></div><aside id="workbench-right" hidden><div id="workbench-right-content"></div></aside><aside id="workbench-bottom" hidden><div id="workbench-bottom-content"></div></aside></div>'
  const host = document.getElementById('controls') as HTMLElement
  const dock = document.getElementById('workbench-right') as HTMLElement
  const remove = workbenchPanels.register({
    id: 'test.terminal-job',
    order: -100,
    edge: 'right',
    titleKey: 'Terminal job',
    component: ({ context }) => <p>Job {(context.selection as { childId?: string } | undefined)?.childId}</p>,
  })
  try {
    renderWorkbench(host, { t: (key) => key, data: { session: { id: 'first' } } })
    flushSync(() => {
      expect(workbenchNavigation.open('test.terminal-job', { childId: 'c1' })).toBe(true)
    })
    expect(dock.hidden).toBe(false)
    expect(dock.textContent).toContain('Job c1')
  } finally {
    unmountWorkbench(host)
    remove()
    localStorage.clear()
    document.body.replaceChildren()
  }
})
