import { Select as AntSelect, type SelectProps as AntSelectProps } from 'antd'

export type SelectProps<ValueType = unknown> = AntSelectProps<ValueType>

export function Select<ValueType = unknown>({ className, ...props }: SelectProps<ValueType>) {
  const classes = ['agnes-ui-select', className].filter(Boolean).join(' ')
  return <AntSelect<ValueType> {...props} className={classes} />
}
