/** @vitest-environment happy-dom */
import { createElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

type UiModule = {
  Button: (props: {
    children?: ReactElement | string
    type?: string
    ref?: { current: HTMLButtonElement | null }
  }) => ReactElement
  Field: (props: { label: string; children: ReactElement }) => ReactElement
  mountRegion(host: HTMLElement, element: ReactElement): () => void
  unmountRegion(host: HTMLElement): void
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('web-ui public component layer', () => {
  it('passes the document CSP nonce to Ant Design runtime styles', async () => {
    const ui = (await import('../src/index.js')) as unknown as UiModule
    const host = document.createElement('div')
    const meta = document.createElement('meta')
    meta.name = 'agnes-csp-nonce'
    meta.content = 'test-document-nonce'
    document.head.append(meta)
    document.body.append(host)

    const dispose = ui.mountRegion(host, createElement(ui.Button, null, 'Continue'))

    const styles = [...document.head.querySelectorAll<HTMLStyleElement>('style[data-css-hash]')]
    expect(styles.length).toBeGreaterThan(0)
    expect(styles.every((style) => style.nonce === meta.content)).toBe(true)
    dispose()
    meta.remove()
  })

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

    const reference = { current: null as HTMLButtonElement | null }
    const host = document.createElement('div')
    const dispose = ui.mountRegion(host, createElement(ui.Button, { ref: reference }, '插件'))
    expect(host.querySelector('button')?.textContent).toBe('插件')
    expect(reference.current).toBe(host.querySelector('button'))
    dispose()
    expect(ui.Field).toBeTypeOf('function')
  })
})
