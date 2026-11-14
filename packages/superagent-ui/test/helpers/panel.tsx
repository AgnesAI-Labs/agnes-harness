/** DOM rendering and interaction helpers for panel tests. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, vi } from 'vitest'
import { App } from '../../src/app.js'
import { zh } from '../../src/locales.js'
import type { T } from '../../src/text.js'
import { server, services, usePanelServer } from './panel-server.js'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

export const translator = (dictionary: Record<string, string>): T =>
  ((key: string, params?: Record<string, unknown>) => {
    const template = dictionary[key] ?? key
    return params
      ? template.replace(/\{(\w+)\}/g, (match, name: string) =>
          name in params ? String(params[name]) : match,
        )
      : template
  }) as T
function Panel({ t }: { t: T }) {
  return (
    <App
      t={t}
      openSession={async (id) => {
        server.opened.push(id)
      }}
      services={services}
    />
  )
}
let root: Root | undefined
let container: HTMLElement | undefined
function unmount() {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
}
export const installPanel = () => usePanelServer(unmount)

/** Flush pending fake-server responses and React state updates. */
export async function settle() {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(server.pending).toBe(0)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
export async function mount(dictionary: Record<string, string> = zh) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<Panel t={translator(dictionary)} />)
  })
  await settle()
}
export async function remount(dictionary: Record<string, string> = zh) {
  unmount()
  await mount(dictionary)
}

export const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const CONTROLS = 'button, [role="button"], [role="tab"], [role="switch"], a'
export function find(name: string, selector = CONTROLS): HTMLElement {
  const match = all(selector).find(
    (element) => element.textContent?.trim() === name || element.getAttribute('aria-label') === name,
  )
  if (!match) throw new Error(`No ${selector} named ${name}`)
  return match
}
export const tab = (name: string) => find(name, '[role="tab"]')
export async function click(target: string | HTMLElement) {
  const element = typeof target === 'string' ? find(target) : target
  await act(async () => {
    element.click()
  })
  await settle()
}
export async function type(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    )
  })
  await settle()
}
/** The page's text without its stylesheet. */
export const text = () =>
  [...document.body.querySelectorAll('style')].reduce(
    (all, style) => all.replace(style.textContent ?? '', ''),
    document.body.textContent ?? '',
  )
export function field<E extends HTMLElement>(label: string): E {
  const labelled = (element: HTMLElement) =>
    !!element.id &&
    all('label').some(
      (item) => (item as HTMLLabelElement).htmlFor === element.id && item.textContent === label,
    )
  const match = all('input, textarea, select').find(
    (element) => element.getAttribute('aria-label') === label || labelled(element),
  )
  if (!match) throw new Error(`No field ${label}`)
  return match as unknown as E
}
export const at = (route: object) =>
  sessionStorage.setItem('superagent/route', JSON.stringify({ route, stack: [] }))
/** Whether a field cannot be edited: disabled itself, or inside a disabled fieldset (happy-dom does not match `:disabled` through one). */
export const disabled = (element: Element) =>
  element.matches(':disabled') || !!element.closest('fieldset[disabled]')
