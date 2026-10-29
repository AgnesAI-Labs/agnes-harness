import { type ReactNode, useState } from 'react'
import type { Translate } from '../../locales/index.js'
import { CopyButton } from '../../ui/copy-button.js'
import { ActivityIcon, ActivityRow } from './activity-row.js'
import type { ConversationMessagesProps } from './context.js'

/** A loop step's result: what the step is called and the record it produced. */
export type ProcessStepResult = { name: string; data: Readonly<Record<string, unknown>> }

const SUMMARY_LIMIT = 120
const LABEL_KEYS = ['name', 'title', 'label', 'id']

/** `approve-plan` reads as "Approve plan" unless the step is one the product names itself. */
export function processStepLabel(name: string, t: Translate): string {
  const key = `step.stage.${name}`
  const known = t(key)
  if (known !== key) return known
  const words = name.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function valueLine(key: string, value: unknown, t: Translate): string | undefined {
  if (typeof value === 'string')
    return value
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)
  if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${String(value)}`
  if (Array.isArray(value)) return t('step.items', { n: value.length })
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const named = LABEL_KEYS.flatMap((label) =>
      typeof record[label] === 'string' || typeof record[label] === 'number' ? [String(record[label])] : [],
    )
    if (named.length) return [...new Set(named)].slice(0, 2).join(' · ')
    const entries = Object.entries(record)
    if (entries.length === 1 && entries[0]) return valueLine(entries[0][0], entries[0][1], t)
    return t('step.fields', { n: entries.length })
  }
  return undefined
}

/** One line that says what the step produced, never the record itself. */
export function processStepSummary(data: Readonly<Record<string, unknown>>, t: Translate): string {
  const line = Object.entries(data)
    .flatMap(([key, value]) => {
      const text = valueLine(key, value, t)
      return text ? [text] : []
    })
    .join(' · ')
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line
}

/** Prose reads as prose; anything structured is shown as source. */
const prose = (value: unknown): value is string =>
  typeof value === 'string' && (value.includes('\n') || value.length > 80)

export function ProcessStep({
  nodeId,
  step,
  props,
}: {
  nodeId: string
  step: ProcessStepResult
  props: Omit<ConversationMessagesProps, 'nodes' | 'turns' | 'visibleNodeIds'>
}) {
  const t = props.t
  const [open, setOpen] = useState(false)
  const summary = processStepSummary(step.data, t)
  const field = (key: string, value: unknown): ReactNode => {
    const code = JSON.stringify(value, null, 2)
    return (
      <section key={key} className="process-step-field">
        <header className="process-step-key">
          <span>{processStepLabel(key, t)}</span>
          <CopyButton
            className="process-step-copy"
            label={t('step.copy')}
            copiedLabel={t('step.copied')}
            text={typeof value === 'string' ? value : code}
          />
        </header>
        {prose(value) ? (
          <div className="process-step-prose">
            {props.renderMarkdown
              ? props.renderMarkdown(value, 'body', { nodeId: `${nodeId}:${key}`, streaming: false })
              : value}
          </div>
        ) : (
          <pre className="process-step-code">{typeof value === 'string' ? value : code}</pre>
        )}
      </section>
    )
  }
  return (
    <>
      <ActivityRow
        className="process-step-row"
        testId="process-step"
        icon={<ActivityIcon name="step" />}
        verb={processStepLabel(step.name, t)}
        target={summary}
        tooltip={summary}
        expanded={open}
        onToggle={() => setOpen((value) => !value)}
      />
      <div className="process-step-detail" data-testid="process-step-detail" hidden={!open}>
        {Object.entries(step.data).map(([key, value]) => field(key, value))}
      </div>
    </>
  )
}
