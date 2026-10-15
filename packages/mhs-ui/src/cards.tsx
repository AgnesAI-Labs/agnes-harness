import type { ConversationCardInput } from '@agnes/web-client'
import { Button } from '@agnes/web-ui'
import { jsonText, record, TOOL_NAMES, type ToolRecord, text, toolsFrom } from './model.js'
import { Stop, useMhs, useSnapshot } from './react.js'
import { usedDeviceIds } from './store.js'
export function ToolCard({ call, onRecord }: { call: ToolRecord; onRecord?: () => void }) {
  const { t, openDevice } = useMhs()
  return (
    <article className="mhs-tool-card">
      <header>
        <strong>{call.name}</strong>
        <Button appearance="link" disabled={!call.device} onClick={() => openDevice(call.device)}>
          {call.device || '—'}
        </Button>
        <span>{call.state || '—'}</span>
        {onRecord && <Button onClick={onRecord}>{t('details')}</Button>}
      </header>
      <details>
        <summary>{t('details')}</summary>
        <pre>{jsonText(call.args)}</pre>
        <pre>{jsonText(call.result)}</pre>
      </details>
    </article>
  )
}
export function cardCall(card: ConversationCardInput): ToolRecord | undefined {
  const data = record(card.data),
    node = record(data.node ?? record(data.owner).block ?? data.block)
  if (!TOOL_NAMES.includes(text(node.name) as (typeof TOOL_NAMES)[number])) return undefined
  return toolsFrom([node])[0]
}
export function SessionDevices() {
  const snapshot = useSnapshot(),
    { t, openDevice } = useMhs(),
    ids = usedDeviceIds(snapshot.calls),
    devices = snapshot.devices.filter((d) => ids.has(d.id))
  return (
    <section className="mhs-session">
      <header>
        <h3>
          {t('mhs.devices')} · {ids.size}
        </h3>
        <Stop />
      </header>
      {!snapshot.sessionId ? (
        <p>{t('noSession')}</p>
      ) : ids.size === 0 ? (
        <p>{t('noUsed')}</p>
      ) : (
        <>
          {devices.map((d) => (
            <article key={d.id} className="mhs-box">
              <Button appearance="link" onClick={() => openDevice(d.id)}>
                {d.name}
              </Button>
              <p>
                {t(d.available ? 'online' : 'offline')} · {d.health}
              </p>
              <Stop device={d.id} />
            </article>
          ))}
          {[...ids]
            .filter((id) => !devices.some((d) => d.id === id))
            .map((id) => (
              <article key={id} className="mhs-box">
                <Button onClick={() => openDevice(id)}>{id}</Button>
                <p>{t('unavailable')}</p>
                <Stop device={id} />
              </article>
            ))}
          {snapshot.calls.map((call) => (
            <ToolCard key={call.id} call={call} />
          ))}
        </>
      )}
    </section>
  )
}
