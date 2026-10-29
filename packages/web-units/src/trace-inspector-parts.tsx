import { Button, CopyButton, IconButton } from '@agnes/web-ui'
import { type ReactNode, useState } from 'react'
import { traceText } from './trace-locale.js'

/** A block longer than this opens folded; the whole text stays in the document either way. */
const FOLD_LINES = 16
const FOLD_CHARS = 1200

/** A titled group inside the inspector. */
export function TraceCard({
  title,
  action,
  children,
  testId,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  testId?: string
}) {
  return (
    <section className="trace-card" data-testid={testId}>
      <header className="trace-card-head">
        <h3 className="trace-card-title">{title}</h3>
        {action}
      </header>
      {children}
    </section>
  )
}

/** A label and its value, one row of a card's grid. */
export function TraceField({ label, value }: { label: string; value: string }) {
  return (
    <div className="trace-field">
      <dt className="trace-field-label">{label}</dt>
      <dd className="trace-field-value">{value}</dd>
    </div>
  )
}

/** Monospace text with a copy action; long text folds to a few lines until it is asked for. */
export function TraceCode({
  label,
  value,
  copyLabel,
  copyValue,
  className,
}: {
  label: string
  value: string
  copyLabel?: string
  /** What the copy action writes when it differs from what is shown. */
  copyValue?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const long = value.length > FOLD_CHARS || value.split('\n', FOLD_LINES + 1).length > FOLD_LINES
  return (
    <figure className="trace-code" data-folded={long && !open ? 'true' : undefined}>
      <figcaption className="trace-code-head">
        <span className="trace-code-label">{label}</span>
        <CopyButton
          className="trace-code-copy"
          label={copyLabel ?? traceText('trace.code.copy')}
          copiedLabel={traceText('trace.code.copied')}
          text={copyValue ?? value}
        />
      </figcaption>
      <pre className={['trace-pre', className].filter(Boolean).join(' ')}>{value}</pre>
      {long ? (
        <Button
          appearance="ghost"
          size="small"
          htmlType="button"
          className="trace-code-fold"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {traceText(open ? 'trace.code.less' : 'trace.code.more')}
        </Button>
      ) : null}
    </figure>
  )
}

/** A full-size image over the trace; Escape closes it and focus stays on its close button. */
export function TraceLightbox({
  image,
  root,
  close,
}: {
  image: { src: string; alt: string }
  root: HTMLElement
  close(): void
}) {
  return (
    <div
      className="trace-lightbox"
      role="dialog"
      aria-modal={true}
      aria-label={image.alt}
      onKeyDown={(event: { key: string; preventDefault: () => void }) => {
        if (event.key === 'Escape') close()
        if (event.key === 'Tab') {
          event.preventDefault()
          root.querySelector<HTMLButtonElement>('.trace-lightbox-close')?.focus()
        }
      }}
    >
      <IconButton
        name="x"
        className="trace-lightbox-close"
        label={traceText('trace.lightbox.close')}
        onClick={close}
      />
      <img src={image.src} alt={image.alt} />
    </div>
  )
}
