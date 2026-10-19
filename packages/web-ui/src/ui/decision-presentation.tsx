import type { DecisionSpec } from '@agnes/protocol'

export type DecisionPresentation = NonNullable<DecisionSpec['presentation']>[string]

const evidencePath = (value: string) =>
  value.startsWith('/') &&
  !value.startsWith('//') &&
  [...value].every((char) => char !== '\\' && char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127)

/** Resolve a persisted presentation; never translate or shorten its bound response value. */
export function decisionPresentation(
  entries: DecisionSpec['presentation'],
  locale = typeof document === 'undefined' ? 'en' : document.documentElement.lang,
): DecisionPresentation | undefined {
  return [locale, locale.split('-')[0] ?? locale, 'en']
    .map((key) => (entries && Object.hasOwn(entries, key) ? entries[key] : undefined))
    .find((entry) => entry !== undefined)
}

/** Only same-origin paths are links, including when viewing records from an older runtime. */
export function DecisionFields({ view }: { view: DecisionPresentation }) {
  return (
    <dl className="agh-decision-fields">
      {view.fields.map((field, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: persisted decision fields are immutable and cannot reorder.
        <div key={index}>
          <dt>{field.label}</dt>
          <dd>
            {field.href && evidencePath(field.href) ? <a href={field.href}>{field.value}</a> : field.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
