// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, type ReactNode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { SegmentedTabs } from '../src/controls.js'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SOURCE = join(process.cwd(), 'packages/superagent-ui/src')
it("imports no Agnes package at run time but the page's own web-ui, only React and type declarations", () => {
  for (const name of readdirSync(SOURCE)) {
    const source = readFileSync(join(SOURCE, name), 'utf8')
    for (const match of source.matchAll(/^import (type )?[^'"]*from '(@agnes\/[^']+)'/gm))
      expect({ name, from: match[2], typeOnly: !!match[1] || match[2] === '@agnes/web-ui' }).toMatchObject({
        typeOnly: true,
      })
  }
})

it('imports each module of the panel only from modules that do not import it back', () => {
  const dir = SOURCE
  const graph = new Map(
    readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => [
        name,
        [...readFileSync(join(dir, name), 'utf8').matchAll(/^import [^'"]*from '\.\/([\w-]+\.tsx?)'/gm)].map(
          (match) => match[1]!,
        ),
      ]),
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

async function render(node: ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(node)
  })
  return {
    container,
    unmount: () =>
      act(() => {
        root.unmount()
        container.remove()
      }),
  }
}

it('emits the active tab again on a click, so a detail page can return to its list', async () => {
  const seen: string[] = []
  function Harness() {
    const [value, setValue] = useState<'a' | 'b'>('a')
    return (
      <SegmentedTabs
        id="t"
        label="pages"
        value={value}
        onChange={(next) => {
          seen.push(next)
          setValue(next)
        }}
        items={(['a', 'b'] as const).map((item) => ({ value: item, label: item }))}
      />
    )
  }
  const view = await render(<Harness />)
  const tab = (name: string) => {
    const element = view.container.querySelector<HTMLElement>(`#t-tab-${name}`)
    if (!element) throw new Error(`No tab ${name}`)
    return element
  }
  await act(async () => {
    tab('b').click()
  })
  await act(async () => {
    tab('b').click()
  })
  expect(seen).toEqual(['b', 'b'])
  expect(tab('b').getAttribute('aria-selected')).toBe('true')
  view.unmount()
})
