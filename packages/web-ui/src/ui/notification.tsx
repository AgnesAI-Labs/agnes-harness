import { notification as antNotification } from 'antd'
import { useLayoutEffect } from 'react'

export type NoticeKind = 'error' | 'info' | 'warning'

export type NotifyInput = Readonly<{ text: string; kind?: NoticeKind }>

/** 宿主只拿到这一个方法，不接触 antd 的通知实例。 */
export type Notifier = Readonly<{ notify(input: NotifyInput): void }>

export type NotificationHostProps = Readonly<{ onReady(notifier: Notifier): void }>

// 默认值集中在这里：6 秒比 antd 默认的 4.5 秒宽一点，错误信息通常更长。closable 与 role 也是
// antd 的默认值，显式写出来是因为这两条是硬要求：提示必须能手动关掉，且要保留 #notice 原有的
// role="alert"，不能变成静默更新。
//
// placement 取右上角，与方案文档写的 bottomLeft 相反：方案的理由是贴近触发它的回形针，用户
// 在真实浏览器里看过一眼后改成了右上角，也就是 antd 的默认值。这里是复核后的结论，不是漏改。
const DEFAULTS = { placement: 'topRight', duration: 6 } as const

/**
 * 通知浮层的挂载点。组件只负责渲染 contextHolder 并把实例交出去；文案与配色都由调用方给，
 * 这里不组装任何面向用户的字符串，也就不需要语言包。
 *
 * `useNotification` 的实例要等组件提交后才可用，所以用 layout effect 交出：宿主在挂载后的
 * 同一帧就拿到，不必等 paint。
 */
export function NotificationHost({ onReady }: NotificationHostProps) {
  const [api, contextHolder] = antNotification.useNotification(DEFAULTS)

  useLayoutEffect(() => {
    onReady({
      notify({ text, kind }) {
        api.open({
          title: text,
          // 没声明严重程度时按中性处理：只有调用方知道这是错误还是提示，猜成错误会画出红叉。
          type: kind ?? 'info',
          closable: true,
          role: 'alert',
          className: 'agnes-ui-notification',
        })
      },
    })
  }, [api, onReady])

  return contextHolder
}
