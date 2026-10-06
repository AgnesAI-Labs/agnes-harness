/** @vitest-environment happy-dom */
import { createElement, type ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

type NotificationModule = {
  NotificationHost: (props: { onReady(notifier: Notifier): void }) => ReactElement
}
type Notifier = { notify(input: { text: string; kind?: 'error' | 'info' | 'warning' }): void }

const mounted: Root[] = []

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  document.body.replaceChildren()
  document.head.querySelector('meta[name="agnes-csp-nonce"]')?.remove()
})

/** 宿主侧拿到的是一个只有 notify 的对象，这里按 app.ts 的同一种用法挂载它。 */
async function mount(): Promise<Notifier> {
  const meta = document.createElement('meta')
  meta.name = 'agnes-csp-nonce'
  meta.content = 'test-document-nonce'
  document.head.append(meta)
  const { NotificationHost } = (await import('../src/index.js')) as unknown as NotificationModule
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mounted.push(root)
  let notifier: Notifier | undefined
  // 和 app.ts 一样同步提交：交接回调在挂载当帧就该拿到实例。
  flushSync(() =>
    root.render(
      createElement(NotificationHost, {
        onReady(ready: Notifier) {
          notifier = ready
        },
      }),
    ),
  )
  if (!notifier) throw new Error('the host never handed out a notifier')
  return notifier
}

const heads = (): string =>
  [...document.querySelectorAll<HTMLElement>('.agnes-ui-notification')]
    .map((node) => node.textContent ?? '')
    .join('\n')

describe('web-ui notification host', () => {
  it('announces the caller’s text as an alert the user can dismiss', async () => {
    const notifier = await mount()
    expect(heads()).toBe('')

    notifier.notify({ text: '一条消息最多添加 50 个附件。', kind: 'error' })
    await vi.waitFor(() => expect(heads()).toContain('一条消息最多添加 50 个附件。'))

    const notice = document.querySelector<HTMLElement>('.agnes-ui-notification')
    // 迁移前 #notice 带 role="alert"，屏幕阅读器会播报，通知要留住这一条。
    expect(notice?.getAttribute('role')).toBe('alert')
    // 配色走 antd 自己的类名，这里只确认 kind 传下去后落到了错误色上。
    expect(notice?.className).toContain('ant-notification-notice-error')
    const close = notice?.querySelector('button')
    expect(close, '通知必须能手动关掉').toBeDefined()
    close?.click()
    // happy-dom 不发 transitionend，关闭动画走不完，节点不会真的消失；这里只确认这次点击
    // 让通知进入了退场状态。
    await vi.waitFor(() => expect(notice?.className).toContain('ant-notification-fade-leave'))
  })

  it('states no severity when the caller gives none', async () => {
    const notifier = await mount()
    notifier.notify({ text: '部分历史事件缺失，正在重新同步。' })
    await vi.waitFor(() => expect(heads()).toContain('部分历史事件缺失'))
    // 缺省按中性处理：调用方没说这是错误，替它画成红叉就是另一回事了。
    expect(document.querySelector('.agnes-ui-notification')?.className).not.toContain(
      'ant-notification-notice-error',
    )
  })
})
