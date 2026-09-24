import {
  createElement,
  type ForwardedRef,
  forwardRef,
  type ReactNode,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

export interface ApprovalAction {
  id: string
  label: string
  onSelect(): void
}

export interface ApprovalView {
  key: string
  summary: string
  title: string
  impact: string
  preview?: string
  actions: readonly ApprovalAction[]
  disabled: boolean
}

export interface ApprovalHandle {
  render(view: ApprovalView | undefined): void
}

export interface ApprovalProps {
  initialView?: ApprovalView
  detail?: ReactNode
}

export const Approval = forwardRef<ApprovalHandle, ApprovalProps>(function Approval(
  { initialView, detail }: ApprovalProps,
  ref: ForwardedRef<ApprovalHandle>,
) {
  const [view, setView] = useState<ApprovalView | undefined>(initialView)
  const content = useRef<HTMLDivElement>(null)
  const focusedAction = useRef<string | undefined>(undefined)
  const actionButtons = useRef(new Map<string, HTMLButtonElement>())

  useImperativeHandle(
    ref,
    () => ({
      render(next) {
        const active = document.activeElement
        if (next === undefined) {
          focusedAction.current = undefined
        } else if (active instanceof HTMLButtonElement && content.current?.contains(active)) {
          focusedAction.current = active.dataset.approvalAction
        }
        setView(next)
      },
    }),
    [],
  )

  useLayoutEffect(() => {
    const actionId = focusedAction.current
    if (!actionId || !view || view.disabled) return
    const button = actionButtons.current.get(actionId)
    if (!button || button.disabled) return
    button.focus()
    focusedAction.current = undefined
  }, [view])

  return createElement(
    'div',
    {
      ref: content,
      id: 'approval-content',
      style: { display: 'contents' },
      'data-agnes-region-owner': 'builtin',
      'data-agnes-region-unit': 'approval',
    },
    view
      ? createElement(
          'div',
          { key: view.key, 'data-approval-key': view.key },
          createElement('h2', null, view.title),
          createElement('p', null, view.summary),
          createElement('p', { className: 'approval-impact' }, view.impact),
          detail,
          ...(view.preview === undefined ? [] : [createElement('pre', { key: 'preview' }, view.preview)]),
          createElement(
            'div',
            { className: 'approval-actions' },
            ...view.actions.map((action) =>
              createElement(
                'button',
                {
                  key: action.id,
                  type: 'button',
                  'data-approval-action': action.id,
                  disabled: view.disabled,
                  onClick: action.onSelect,
                  ref: (button: HTMLButtonElement | null) => {
                    if (button) actionButtons.current.set(action.id, button)
                    else actionButtons.current.delete(action.id)
                  },
                },
                action.label,
              ),
            ),
          ),
        )
      : undefined,
  )
})
