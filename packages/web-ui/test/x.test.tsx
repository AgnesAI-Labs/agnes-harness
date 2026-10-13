/** @vitest-environment happy-dom */
import * as x from '@agnes/web-ui/x'
import { afterEach, expect, it } from 'vitest'
import { createRegionRenderer, unmountApplication } from '../src/antd-root.js'

const { Bubble, Conversations, XProvider } = x

afterEach(() => {
  unmountApplication(document)
  document.head.replaceChildren()
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
})

function mount(children: React.ReactNode) {
  const meta = document.createElement('meta')
  meta.name = 'agnes-csp-nonce'
  meta.content = 'test-nonce'
  document.head.append(meta)
  const host = document.createElement('div')
  document.body.append(host)
  const region = createRegionRenderer(host)
  region.render(children)
  region.flush()
  return host
}

it('exposes presentational components without the chat runtime, diagram or highlighter', () => {
  expect(Object.keys(x).sort()).toEqual([
    'Actions',
    'Attachments',
    'Bubble',
    'Conversations',
    'FileCard',
    'Prompts',
    'Sender',
    'Sources',
    'Suggestion',
    'Think',
    'ThoughtChain',
    'Welcome',
    'XProvider',
  ])
})

it('styles the X subtree at runtime under the document nonce, vendor layer and shared theme key', async () => {
  const host = mount(
    <XProvider>
      <Bubble content="hello" />
    </XProvider>,
  )
  const bubble = host.querySelector('.ant-bubble')
  expect(bubble?.textContent).toContain('hello')
  // The bridge in tokens.css remaps variables declared on this class.
  expect(bubble?.classList.contains('agnes-theme')).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const styles = [...document.querySelectorAll<HTMLStyleElement>('style[data-css-hash]')]
  const own = styles.filter((style) => style.textContent?.includes('.ant-bubble'))
  expect(own.length).toBeGreaterThan(0)
  for (const style of styles) {
    expect(style.nonce || style.getAttribute('nonce')).toBe('test-nonce')
    expect(style.textContent?.trimStart().startsWith('@layer vendor {')).toBe(true)
  }
})

it('keeps the application locale for X strings and Ant Design strings together', () => {
  document.documentElement.lang = 'zh-CN'
  const host = mount(
    <XProvider>
      <Conversations items={[]} creation={{}} />
    </XProvider>,
  )
  expect(host.textContent).toContain('新对话')
})
