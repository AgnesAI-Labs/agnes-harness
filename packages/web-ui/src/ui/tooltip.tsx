import { Tooltip as AntTooltip, type TooltipProps as AntTooltipProps } from 'antd'

export type TooltipProps = AntTooltipProps

/**
 * 悬停说明的包装。基础类走 `rootClassName`：antd 的 Tooltip 不消费 `className`（它落在 restProps 里，
 * 不是弹层根类），和 Button/Tabs 那几个原语的挂法不同。
 */
export function Tooltip({ rootClassName, ...props }: TooltipProps) {
  const classes = ['agnes-ui-tooltip', rootClassName].filter(Boolean).join(' ')
  return <AntTooltip {...props} rootClassName={classes} />
}
