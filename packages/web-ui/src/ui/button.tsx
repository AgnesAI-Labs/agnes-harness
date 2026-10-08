import { Button as AntButton, type ButtonProps as AntButtonProps } from 'antd'
import { forwardRef, type ReactNode } from 'react'

export type ButtonProps = AntButtonProps

export const Button = forwardRef<HTMLButtonElement, ButtonProps & { children?: ReactNode }>(function Button(
  { className, children, ...props },
  ref,
) {
  const classes = ['agnes-ui-button', className].filter(Boolean).join(' ')
  return (
    <AntButton ref={ref} {...props} className={classes}>
      {children}
    </AntButton>
  )
})
