import {
  Button,
  DecisionFields,
  type DecisionPresentation,
  Disclosure,
  fallbackT,
  SettingsInput,
} from '@agnes/web-ui'
import {
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
  presentation?: DecisionPresentation
  /** Says a plugin rewrote the summary and gives the original; read right after the summary. */
  rewritten?: string
  title: string
  impact: string
  /** Risk level behind the impact wording; colours it. The wording itself always states the risk. */
  risk?: 'destructive' | 'always' | 'budget' | 'unknown'
  /** Says that part of the call is not shown; rendered before the preview so it is read first. */
  warning?: string
  preview?: string
  actions: readonly ApprovalAction[]
  /** Who asked, as one plain-text line under the title. */
  origin?: string
  /** What «always allow» keeps, as plain text; `title` holds the whole list when `text` is folded. */
  stores?: { text: string; title?: string }
  /** Durable approvals only: the live path has no channel for a reason, so it never sets this. */
  rejectWithReason?: {
    label: string
    inputLabel: string
    submitLabel: string
    cancelLabel: string
    maxLength: number
    onSubmit(reason: string): void
  }
  disabled: boolean
  /**
   * Presentation marker; the supplied actions remain authoritative. `reconcile`: Core asks whether a
   * call that lost its result ran. `answered`: already answered, waiting for the Agent to continue.
   */
  kind?: 'plan' | 'reconcile' | 'answered'
}

export interface ApprovalHandle {
  render(view: ApprovalView | undefined): void
  /** Bring the pending approval into view and put focus on its first available decision. */
  focus(): void
}

export interface ApprovalProps {
  initialView?: ApprovalView
  contentId?: string
  detail?: ReactNode
}

function focusApproval(content: HTMLDivElement | null): void {
  const card = content?.querySelector<HTMLElement>('[data-approval-key]')
  card?.scrollIntoView?.({ block: 'nearest' })
  ;(card?.querySelector<HTMLButtonElement>('[data-approval-action]:not(:disabled)') ?? card)?.focus()
}

/** Own state, so a new approval (a new keyed card) always starts collapsed. */
function RejectWithReason({
  reject,
  disabled,
}: {
  reject: NonNullable<ApprovalView['rejectWithReason']>
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    if (open) input.current?.focus()
    else if (wasOpen.current) opener.current?.focus()
    wasOpen.current = open
  }, [open])
  const close = () => {
    setOpen(false)
    setReason('')
  }
  const submit = () => {
    if (disabled) return
    reject.onSubmit(reason.trim())
    close()
  }
  if (!open)
    return (
      <Button
        ref={opener}
        htmlType="button"
        data-testid="approval-reject-reason-open"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {reject.label}
      </Button>
    )
  return (
    <>
      <SettingsInput
        ref={input}
        surface="surface"
        type="text"
        className="approval-reason-input"
        data-testid="approval-reason-input"
        aria-label={reject.inputLabel}
        maxLength={reject.maxLength}
        value={reason}
        disabled={disabled}
        onChange={(event) => setReason(event.target.value)}
        onKeyDown={(event) => {
          // An IME uses Enter and Esc to finish or cancel a composition, not to submit.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}
      />
      <Button htmlType="button" data-testid="approval-reason-submit" disabled={disabled} onClick={submit}>
        {reject.submitLabel}
      </Button>
      <Button htmlType="button" data-testid="approval-reason-cancel" onClick={close}>
        {reject.cancelLabel}
      </Button>
    </>
  )
}

export const Approval = forwardRef<ApprovalHandle, ApprovalProps>(function Approval(
  { initialView, detail, contentId = 'approval-content' }: ApprovalProps,
  ref: ForwardedRef<ApprovalHandle>,
) {
  const [view, setView] = useState<ApprovalView | undefined>(initialView)
  const content = useRef<HTMLDivElement>(null)
  const committedView = useRef(initialView)
  const pendingRender = useRef(false)
  const requestedFocus = useRef(false)

  const focusedAction = useRef<string | undefined>(undefined)
  const actionButtons = useRef(new Map<string, HTMLButtonElement>())

  useImperativeHandle(
    ref,
    () => ({
      render(next) {
        const active = document.activeElement
        if (next === undefined) {
          focusedAction.current = undefined
          requestedFocus.current = false
        } else if (active instanceof HTMLButtonElement && content.current?.contains(active)) {
          focusedAction.current = active.dataset.approvalAction
          // Blur before disabling: disabled native controls cannot reliably release focus later.
          if (next.disabled) active.blur()
        }
        pendingRender.current = committedView.current !== next
        setView(next)
      },
      focus() {
        if (pendingRender.current) requestedFocus.current = true
        else focusApproval(content.current)
      },
    }),
    [],
  )

  useLayoutEffect(() => {
    pendingRender.current = false
    committedView.current = view
    if (requestedFocus.current) {
      requestedFocus.current = false
      focusedAction.current = undefined
      focusApproval(content.current)
      return
    }
    const actionId = focusedAction.current
    if (!actionId || !view || view.disabled) return
    const button = actionButtons.current.get(actionId)
    if (!button || button.disabled) return
    button.focus()
    focusedAction.current = undefined
  }, [view])

  return (
    <div
      ref={content}
      id={contentId}
      style={{ display: 'contents' }}
      data-agnes-region-owner="builtin"
      data-agnes-region-unit="approval"
    >
      {view ? (
        // biome-ignore lint/a11y/useSemanticElements: preserve the existing approval region host.
        <div
          key={view.key}
          data-approval-key={view.key}
          data-testid={view.kind === 'plan' ? 'plan-approval-card' : 'approval-card'}
          data-risk={view.risk}
          {...(view.kind ? { 'data-kind': view.kind } : {})}
          role="region"
          tabIndex={-1}
          aria-label={view.title}
        >
          <h2>{view.title}</h2>
          {view.origin !== undefined && (
            <p className="approval-origin" data-testid="approval-origin">
              {view.origin}
            </p>
          )}
          <p className="approval-summary-text">{view.summary}</p>
          {view.presentation && <DecisionFields view={view.presentation} />}
          {view.rewritten !== undefined && (
            <p className="approval-warning" data-testid="approval-rewritten">
              {view.rewritten}
            </p>
          )}
          <p className="approval-impact">{view.impact}</p>
          {detail}
          {view.warning !== undefined && <p className="approval-warning">{view.warning}</p>}
          {view.preview !== undefined && (
            <Disclosure variant="plain" summary={fallbackT('ui.technicalDetails')}>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll the full arguments. */}
              <pre tabIndex={0} data-testid="approval-preview">
                {view.preview}
              </pre>
            </Disclosure>
          )}
          <div className="approval-actions">
            {view.actions.map((action) => (
              <Button
                key={action.id}
                htmlType="button"
                data-approval-action={action.id}
                data-testid="approval-action"
                disabled={view.disabled}
                onClick={action.onSelect}
                ref={(button: HTMLButtonElement | null) => {
                  if (button) actionButtons.current.set(action.id, button)
                  else actionButtons.current.delete(action.id)
                }}
              >
                {action.label}
              </Button>
            ))}
            {view.rejectWithReason && (
              <RejectWithReason reject={view.rejectWithReason} disabled={view.disabled} />
            )}
          </div>
          {view.stores !== undefined && (
            <p className="approval-stores" data-testid="approval-stores" title={view.stores.title}>
              {view.stores.text}
            </p>
          )}
        </div>
      ) : undefined}
    </div>
  )
})
