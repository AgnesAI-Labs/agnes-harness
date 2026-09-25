import { Button as AntButton, type ButtonProps as AntButtonProps } from 'antd'
import type { ReactNode } from 'react'

export type ButtonProps = AntButtonProps

export function Button({ className, children, ...props }: ButtonProps & { children?: ReactNode }) {
  const classes = ['agnes-ui-button', className].filter(Boolean).join(' ')
  return (
    <AntButton {...props} className={classes}>
      {children}
    </AntButton>
  )
}
