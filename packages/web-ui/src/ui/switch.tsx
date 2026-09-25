import { Switch as AntSwitch, type SwitchProps as AntSwitchProps } from 'antd'

export type SwitchProps = AntSwitchProps

export function Switch({ className, ...props }: SwitchProps) {
  const classes = ['agnes-ui-switch', className].filter(Boolean).join(' ')
  return <AntSwitch {...props} className={classes} />
}
