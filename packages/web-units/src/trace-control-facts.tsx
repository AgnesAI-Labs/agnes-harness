import type { SessionControlFact } from '@agnes/protocol/gen/agnes-v1'
import { Disclosure } from '@agnes/web-ui'
import { type TraceMessageKey, traceText } from './trace-locale.js'

/** The session control decisions recorded for this trace, collapsed until the reader asks. */
export function TraceControlFacts({ facts }: { facts: readonly SessionControlFact[] }) {
  return (
    <Disclosure
      className="trace-control-facts"
      data-testid="control-facts"
      summary={traceText('trace.controls.title')}
    >
      <ol>
        {facts.map((fact) => (
          <li key={fact.seq} data-testid="control-fact">
            <span>{`${traceText(`trace.controls.${fact.action}` as TraceMessageKey)} · ${traceText(`trace.controls.${fact.outcome}` as TraceMessageKey)} · ${fact.actor.id}`}</span>
            <time dateTime={fact.ts}>{fact.ts}</time>
            <pre>{JSON.stringify(fact.details, null, 2)}</pre>
          </li>
        ))}
      </ol>
    </Disclosure>
  )
}
