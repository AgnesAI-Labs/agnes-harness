import { createElement, forwardRef, type SVGProps } from 'react'
import { icons, type IconName } from './icons.js'

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'name'> & {
  name: IconName
  size?: 16 | 18 | 20 | 48
}
/** Icons inherit text color and remain decorative; label the surrounding control. */
export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { name, size = 16, className, ...props },
  ref,
) {
  return (
    <svg
      {...props}
      ref={ref}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-agnes-region="icon"
      data-size={size}
      className={['icon', 'agh-icon', className].filter(Boolean).join(' ')}
    >
      {icons[name].map(([tag, attributes], index) => createElement(tag, { ...attributes, key: index }))}
    </svg>
  )
})
