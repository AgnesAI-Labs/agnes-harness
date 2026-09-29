import { Tabs as AntTabs, type TabsProps as AntTabsProps } from 'antd'

export type TabsProps = AntTabsProps

export function Tabs({ className, ...props }: TabsProps) {
  const classes = ['agnes-ui-tabs', className].filter(Boolean).join(' ')
  return <AntTabs {...props} className={classes} />
}
