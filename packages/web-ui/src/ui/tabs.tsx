import { Tabs as AntTabs, type TabsProps as AntTabsProps } from 'antd'
import { useEffect, useState } from 'react'

export type TabsProps = AntTabsProps

export function Tabs({ className, ...props }: TabsProps) {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 767px)').matches
      : false,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 767px)')
    const update = () => setNarrow(media.matches)
    media.addEventListener('change', update)
    update()
    return () => media.removeEventListener('change', update)
  }, [])
  const classes = ['agnes-ui-tabs', className].filter(Boolean).join(' ')
  return (
    <AntTabs
      {...props}
      {...(narrow && props.tabBarGutter === undefined ? { tabBarGutter: 4 } : {})}
      className={classes}
      onMouseDownCapture={(event) => {
        props.onMouseDownCapture?.(event)
        // rc-tabs scrolls the strip on focus. Keep the pointer target still until click selects it.
        if (
          !event.defaultPrevented &&
          event.target instanceof Element &&
          event.target.closest('.ant-tabs-tab-btn[role="tab"]')
        )
          event.preventDefault()
      }}
      onTabClick={(key, event) => {
        props.onTabClick?.(key, event)
        const target = event.currentTarget as HTMLElement
        const tab = target.matches('[role="tab"]')
          ? target
          : target.querySelector<HTMLElement>('[role="tab"]')
        tab?.focus({ preventScroll: true })
      }}
    />
  )
}
