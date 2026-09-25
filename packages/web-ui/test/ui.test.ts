/** @vitest-environment happy-dom */
import { createElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

type UiModule = {
  Button: (props: { children?: ReactElement | string; type?: string }) => ReactElement
  Field: (props: { label: string; children: ReactElement }) => ReactElement
  mountRegion(host: HTMLElement, element: ReactElement): () => void
  unmountRegion(host: HTMLElement): void
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('web-ui public component layer', () => {
  it('mounts and unmounts a React region through its lifecycle contract', async () => {
    const ui = (await import('../src/index.js')) as unknown as UiModule
    const host = document.createElement('div')
    document.body.append(host)

    const dispose = ui.mountRegion(host, createElement('span', { 'data-testid': 'content' }, 'ready'))

    expect(host.querySelector('[data-testid="content"]')?.textContent).toBe('ready')
    dispose()
    expect(host.childElementCount).toBe(0)
    ui.unmountRegion(host)
  })

  it('exports host primitives without exposing antd to consumers', async () => {
    const ui = (await import('../src/index.js')) as unknown as UiModule

    expect(ui.Button).toBeTypeOf('function')
    expect(ui.Field).toBeTypeOf('function')
  })
})
