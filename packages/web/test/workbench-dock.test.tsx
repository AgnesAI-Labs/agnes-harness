/** @vitest-environment happy-dom */
import { workbenchPanels } from '@agnes/web-client'
import { renderRegion, unmountRegion } from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { expect, it } from 'vitest'
import { Dock } from '../src/workbench/dock.js'

it('restores focus on Escape, resizes with keys, retires registrations and detaches on unmount', () => {
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
    component: ({ context }) => <p>Second panel {(context.selection as { path?: string })?.path}</p>,
  })
  let replacement: (() => void) | undefined
  try {
    renderRegion(host, <Dock context={{ t: (key) => key }} />)
    const toggle = host.querySelector('[data-edge="right"]') as HTMLButtonElement
    flushSync(() => toggle.click())
    const dock = document.getElementById('workbench-right') as HTMLElement
    expect(dock.hidden).toBe(false)
    flushSync(() => (dock.querySelector('[data-testid="navigate-review"]') as HTMLButtonElement).click())
    expect(dock.textContent).toContain('Second panel actual.txt')
    flushSync(() => (dock.querySelector('[role="tab"]') as HTMLButtonElement).click())
    const resize = dock.querySelector('hr') as HTMLElement
    flushSync(() => resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(
      document.querySelector<HTMLElement>('.workbench-split')?.style.getPropertyValue('--workbench-width'),
    ).toBe('304px')
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
    document.body.replaceChildren()
    localStorage.clear()
  }
})
