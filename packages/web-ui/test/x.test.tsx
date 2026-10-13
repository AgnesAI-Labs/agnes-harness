/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import * as x from '@agnes/web-ui/x'
import { afterEach, expect, it } from 'vitest'
import { createRegionRenderer, unmountApplication } from '../src/antd-root.js'

const {
  Actions,
  Attachments,
  Bubble,
  Conversations,
  Prompts,
  Sender,
  Think,
  ThoughtChain,
  Welcome,
  XProvider,
} = x

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

it('bridges every colour variable the X components generate to semantic tokens', async () => {
  mount(
    <XProvider>
      <Bubble content="hello" placement="end" />
      <Bubble.List items={[{ key: 'a', role: 'user', content: 'x' }]} />
      <Sender />
      <Conversations items={[{ key: '1', label: 'a', group: 'g' }]} groupable creation={{}} />
      <ThoughtChain items={[{ key: 'k', title: 't', status: 'success', collapsible: true, content: 'c' }]} />
      <Think title="t">x</Think>
      <Actions items={[{ key: 'copy', label: 'copy' }]} />
      <Welcome title="t" description="d" />
      <Prompts items={[{ key: 'p', label: 'l' }]} />
      <Attachments items={[]} />
    </XProvider>,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const css = [...document.querySelectorAll('style[data-css-hash]')]
    .map((style) => style.textContent ?? '')
    .join('\n')
  const bridge = readFileSync(new NodeURL('../src/tokens.css', import.meta.url), 'utf8')
  const own =
    /(--ant-(?:bubble|sender|conversations|thought-chain|think|actions|welcome|prompts|attachments|input)-[a-z0-9-]+):([^;}]+)/g
  const literal = /#[0-9a-f]{3,8}\b|rgba?\(/i
  const generated = [...css.matchAll(own)].filter((match) => literal.test(match[2] ?? ''))
  expect(generated.length).toBeGreaterThan(20)
  const unbridged = [...new Set(generated.map((match) => match[1] ?? ''))]
    .filter((name) => !bridge.includes(`${name}: `))
    .sort()
  expect(unbridged).toEqual([])
})
