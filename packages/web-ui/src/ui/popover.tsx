import { Popover as AntPopover, type PopoverProps } from 'antd'

/** Shared anchored surface; the owning picker supplies its state and keyboard behavior. */
export function Popover(props: PopoverProps) {
  return (
    <AntPopover
      {...props}
      rootClassName={['agnes-ui-popover', props.rootClassName].filter(Boolean).join(' ')}
    />
  )
}
