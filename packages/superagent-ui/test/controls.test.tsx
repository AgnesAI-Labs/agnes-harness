// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { Modal, SegmentedTabs } from '../src/controls.js'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SOURCE = join(process.cwd(), 'packages/superagent-ui/src')
it('imports no Agnes package at run time, only React and type declarations', () => {
  for (const name of readdirSync(SOURCE)) {
    const source = readFileSync(join(SOURCE, name), 'utf8')
    for (const match of source.matchAll(/^import (type )?[^'"]*from '(@agnes\/[^']+)'/gm)) expect({ name, from: match[2], typeOnly: !!match[1] }).toMatchObject({ typeOnly: true })
  }
})

it('imports each module of the panel only from modules that do not import it back', () => {
  const dir = SOURCE
  const graph = new Map(
    readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => [name, [...readFileSync(join(dir, name), 'utf8').matchAll(/^import [^'"]*from '\.\/([\w-]+\.tsx?)'/gm)].map((match) => match[1]!)]),
  )
  const done = new Set<string>(),
    cycles: string[] = []
  const visit = (name: string, path: string[]): void => {
    if (path.includes(name)) {
      cycles.push([...path.slice(path.indexOf(name)), name].join(' → '))
      return
    }
    if (done.has(name)) return
    for (const next of graph.get(name) ?? []) visit(next, [...path, name])
    done.add(name)
  }
  for (const name of graph.keys()) visit(name, [])
  expect(cycles).toEqual([])
})

it('describes the services in a module the panel can type against, which imports types only', () => {
  const source = readFileSync(join(process.cwd(), 'packages/superagent/src/runtime/panel-api.ts'), 'utf8')
  expect([...source.matchAll(/^import (type )?/gm)].every((match) => match[1])).toBe(true)
})

it('closes the dialog on Escape and returns focus to the opener', async () => {
  function Harness() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          open
        </button>
        <Modal open={open} onClose={() => setOpen(false)} title="Title" closeLabel="Close">
          body
        </Modal>
      </>
    )
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness />)
  })
  const opener = container.querySelector('button')!
  opener.focus()
  await act(async () => {
    opener.click()
  })
  expect(document.activeElement?.getAttribute('role')).toBe('dialog')
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(opener)
  act(() => {
    root.unmount()
  })
})

it('keeps the focus inside the dialog when its parent re-renders, and Tab and Shift+Tab wrap within it', async () => {
  let rerender = () => {}
  function Harness() {
    const [, setCount] = useState(0)
    rerender = () => setCount((count) => count + 1)
    // Pass a new inline onClose on each render (as polling parents do) to verify the effect does not reset focus.
    return (
      <Modal open onClose={() => {}} title="Title" closeLabel="Close" footer={<button type="button">last</button>}>
        <input aria-label="first field" />
      </Modal>
    )
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness />)
  })
  const field = document.querySelector<HTMLInputElement>('[aria-label="first field"]')!
  field.focus()
  await act(async () => {
    rerender()
  })
  expect(document.activeElement).toBe(field)
  const [close, , last] = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="dialog"] input')]
  const tab = (shiftKey = false) =>
    act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true }))
    })
  last!.focus()
  await tab()
  expect(document.activeElement).toBe(close)
  await tab(true)
  expect(document.activeElement).toBe(last)
  act(() => {
    root.unmount()
  })
})

it('moves the tab selection with arrow keys and wraps at the ends', async () => {
  const seen: string[] = []
  function Harness() {
    const [value, setValue] = useState<'a' | 'b' | 'c'>('a')
    return (
      <SegmentedTabs
        label="pages"
        value={value}
        onChange={(next) => {
          seen.push(next)
          setValue(next)
        }}
        items={(['a', 'b', 'c'] as const).map((item) => ({
          value: item,
          label: item,
          id: `t-${item}`,
          panelId: 'p',
        }))}
      />
    )
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness />)
  })
  const list = container.querySelector('[role="tablist"]')!
  await act(async () => {
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  })
  await act(async () => {
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  })
  expect(seen).toEqual(['c', 'a'])
  expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe('a')
  act(() => {
    root.unmount()
  })
})
