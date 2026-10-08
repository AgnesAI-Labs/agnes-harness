import { createElement, type HTMLAttributes, type ReactNode } from 'react'

/** One card surface; payloads and session state remain owned by the host and extension. */
export function ConversationCardLayout({
  as = 'article',
  variant = 'card',
  title,
  actions,
  state = 'ready',
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  as?: 'article' | 'section' | 'form'
  variant?: 'card' | 'plain'
  title?: ReactNode
  actions?: ReactNode
  state?: 'ready' | 'loading' | 'empty' | 'error' | 'disabled'
}) {
  return createElement(
    as,
    {
      ...props,
      className: [
        variant === 'card' && 'conversation-native-card',
        'agnes-conversation-card',
        props.className,
      ]
        .filter(Boolean)
        .join(' '),
      'data-card-state': state,
      'data-card-variant': variant,
      'aria-busy': state === 'loading' || undefined,
    },
    title || actions ? (
      <header className="agnes-conversation-card-heading">
        {title && <h3>{title}</h3>}
        {actions}
      </header>
    ) : null,
    children,
  )
}
