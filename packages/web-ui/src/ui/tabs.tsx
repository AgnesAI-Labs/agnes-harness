import { Tabs as AntTabs, type TabsProps as AntTabsProps } from 'antd'

export type TabsProps = AntTabsProps

export function Tabs({ className, ...props }: TabsProps) {
  const classes = ['agnes-ui-tabs', className].filter(Boolean).join(' ')
  return (
    <AntTabs
      {...props}
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
