/**
 * The conversation's device cards (mhs-ui-design section 11): one view per brain tool in place of
 * the workbench's generic tool row. A card draws from the call's arguments, the structured facts
 * the plugin records with each result, and, while a job runs, the device's live entry in AgnesHub.
 * Nothing here knows a particular device or device tool.
 */
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { Bar, KindIcon } from '../controls/ui.js'
import { argsText, BRAIN_TOOLS, displayName, keyFields, untilText } from '../core/describe.js'
import type { Device, DeviceState, Health, HubEvent, Json, Position, Tool } from '../core/types.js'
import { elapsed, t, valueText, word } from '../i18n/i18n.js'
import { HealthText, PositionText } from '../layout/parts.js'
import { useDevice, useEvents, useLocale, useNav, useNow } from '../react/hooks.js'
import { FieldView } from '../widgets/fields.js'

/** The workbench's tool node (protocol: the `tool` UI node). */
export interface ToolNode {
  toolUseId: string
  name: string
  seq: number
  status: 'planned' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled'
  argsPreview?: string
  resultPreview?: string
  resultSeq?: number
}

export interface Picture {
  name?: string
  sha256: string
  size: number
  mime: string
}

/** What the host can do for cards: read a call's full result, and load an image the result holds. */
export interface CardHost {
  detail(node: ToolNode): Promise<{ structured?: Json; isError?: boolean } | undefined>
  image(picture: Picture): Promise<{ url: string; release(): void }>
  /** Shows a device in the panel (opening the dock if it is closed). */
  openDevice(id: string): void
}

export const CardHostContext = createContext<CardHost | null>(null)

export { BRAIN_TOOLS }

function parse(text: string | undefined): Json {
  if (!text) return {}
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? (value as Json) : {}
  } catch {
    return {}
  }
}

const cache = new Map<string, { structured?: Json; isError?: boolean }>()

/** The structured facts of a finished call, read once per result. */
function useDetail(node: ToolNode): Json | undefined {
  const host = useContext(CardHostContext)
  const key = `${node.toolUseId}/${node.resultSeq ?? ''}`
  const [detail, setDetail] = useState(() => cache.get(key))
  useEffect(() => {
    if (!host || node.resultSeq === undefined || cache.has(key)) {
      setDetail(cache.get(key))
      return
    }
    let live = true
    host.detail(node).then(
      (d) => {
        if (!d) return
        cache.set(key, d)
        if (live) setDetail(d)
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [host, key, node])
  return detail?.structured
}

type Tone = 'busy' | 'ok' | 'bad' | 'off'

function toneOf(node: ToolNode): Tone {
  if (node.status === 'completed') return 'ok'
  if (node.status === 'failed') return 'bad'
  if (node.status === 'cancelled') return 'off'
  return 'busy'
}

function DeviceChip(props: { id: string | undefined }) {
  const host = useContext(CardHostContext)
  const nav = useNav()
  const device = useDevice(props.id ?? '')
  if (!props.id) return null
  return (
    <button
      type="button"
      className="mhs-chip"
      title={device ? displayName(device) : props.id}
      onClick={() => {
        nav.open(props.id)
        host?.openDevice(props.id as string)
      }}
    >
      <KindIcon kind={device?.kind ?? ''} icon={device?.ui?.icon} />
      <code>{props.id}</code>
    </button>
  )
}

function Shell(props: {
  node: ToolNode
  tone: Tone
  device?: string | undefined
  verb: string
  what?: ReactNode
  status: ReactNode
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <article className="mhs-tcard" data-tone={props.tone} data-tool={props.node.name}>
      <header className="mhs-tcard-head">
        <span className="mhs-tcard-verb">{props.verb}</span>
        <DeviceChip id={props.device} />
        {props.what && <span className="mhs-tcard-what">{props.what}</span>}
        <span className="mhs-grow" />
        <span className="mhs-tcard-status">{props.status}</span>
        <button
          type="button"
          className="mhs-link mhs-tcard-more"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? t('card.hide') : t('card.details')}
        </button>
      </header>
      {props.children && <div className="mhs-tcard-body">{props.children}</div>}
      {open && (
        <div className="mhs-tcard-raw">
          <div>
            <span className="mhs-dim">{t('card.arguments')}</span>
            <pre>{props.node.argsPreview ?? '{}'}</pre>
          </div>
          {props.node.resultPreview && (
            <div>
              <span className="mhs-dim">{t('card.result')}</span>
              <pre>{props.node.resultPreview}</pre>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

function Thumbs(props: { pictures: Picture[] }) {
  const host = useContext(CardHostContext)
  const [urls, setUrls] = useState<string[]>([])
  useEffect(() => {
    if (!host) return
    const loaded: { release(): void }[] = []
    let live = true
    Promise.all(props.pictures.map((p) => host.image(p).catch(() => undefined))).then((all) => {
      for (const r of all) if (r) loaded.push(r)
      if (live) setUrls(all.filter((r): r is { url: string; release(): void } => !!r).map((r) => r.url))
    })
    return () => {
      live = false
      for (const r of loaded) r.release()
    }
  }, [host, props.pictures])
  if (urls.length === 0) return null
  return (
    <div className="mhs-thumbs">
      {urls.map((u) => (
        <img key={u} src={u} alt="" />
      ))}
    </div>
  )
}

/** Key numbers of a state snapshot, chosen the same way as on the device cards. */
function StateChips(props: { state: DeviceState | undefined; id: string }) {
  if (!props.state) return null
  const fields = keyFields({ state: props.state } as Device, 5)
  if (fields.length === 0) return null
  return (
    <div className="mhs-fields mhs-tcard-fields">
      {fields.map(([name, field]) => (
        <FieldView key={name} name={name} field={field} value={props.state?.values[name]} />
      ))}
    </div>
  )
}

function ListCard(props: { node: ToolNode }) {
  const data = useDetail(props.node)
  const devices =
    (data?.devices as { id: string; available: boolean; health: Health; jobs: { tool: string }[] }[]) ?? []
  return (
    <Shell
      node={props.node}
      tone={toneOf(props.node)}
      verb={t('card.list', { n: devices.length })}
      status={<Status node={props.node} />}
    >
      {devices.length > 0 && (
        <div className="mhs-tcard-list">
          {devices.map((d) => (
            <span key={d.id} className="mhs-tcard-row">
              <span
                className="mhs-dot"
                data-tone={
                  !d.available
                    ? 'off'
                    : d.health.level === 'ok'
                      ? 'ok'
                      : d.health.level === 'attention'
                        ? 'warn'
                        : 'bad'
                }
              />
              <DeviceChip id={d.id} />
              <span className="mhs-dim">
                {d.jobs.length ? d.jobs.map((j) => j.tool).join(', ') : t('device.idle')}
              </span>
            </span>
          ))}
        </div>
      )}
    </Shell>
  )
}

function ReadCard(props: { node: ToolNode }) {
  const args = parse(props.node.argsPreview)
  const data = useDetail(props.node)
  const device = (data?.device as string | undefined) ?? (args.device as string | undefined)
  const items = (data?.items as { source: string; text: string; error?: string }[] | undefined) ?? []
  const sources = (args.sources as string[] | undefined) ?? []
  return (
    <Shell
      node={props.node}
      tone={toneOf(props.node)}
      verb={t('card.read')}
      device={device}
      what={sources.length ? sources.join(', ') : undefined}
      status={<Status node={props.node} />}
    >
      {data && (
        <>
          <div className="mhs-tcard-line">
            {data.health ? <HealthText health={data.health as Health} /> : null}
            {data.position ? <PositionText position={data.position as Position} detail /> : null}
          </div>
          <StateChips state={data.state as DeviceState | undefined} id={device ?? ''} />
          {items.map((i) => (
            <div key={i.source} className="mhs-note" data-bad={i.error ? true : undefined}>
              {i.error ?? i.text}
            </div>
          ))}
          {Array.isArray(data.pictures) && <Thumbs pictures={data.pictures as Picture[]} />}
        </>
      )}
    </Shell>
  )
}

/** The ended job event of a call that returned `running`, found by the call's id. */
function endedEvent(events: HubEvent[], ref: string, job: string | undefined): HubEvent | undefined {
  return events.find(
    (e) =>
      e.type === 'job' && e.data.state === 'ended' && (e.data.ref === ref || (job && e.data.job === job)),
  )
}

function CallCard(props: { node: ToolNode }) {
  useLocale()
  const node = props.node
  const args = parse(node.argsPreview)
  const data = useDetail(node)
  const deviceId = (data?.device as string | undefined) ?? (args.device as string | undefined)
  const device = useDevice(deviceId ?? '')
  const events = useEvents()
  const now = useNow(1000)
  const toolName = String(args.tool ?? data?.tool ?? '')
  const decl = (device?.tools ?? []).find((x: Tool) => x.name === toolName)
  const live = (device?.jobs ?? []).find((j) => j.ref === node.toolUseId)
  const status = data?.status as string | undefined
  const ended =
    status === 'running' || !data
      ? endedEvent(events, node.toolUseId, data?.job as string | undefined)
      : undefined

  let tone: Tone = toneOf(node)
  let line: ReactNode
  let body: ReactNode = null
  if (live) {
    tone = live.state === 'paused' ? 'off' : 'busy'
    line = (
      <>
        {live.state === 'paused' ? t('tool.paused', { reason: '' }) : t('status.running')} ·{' '}
        {elapsed(now / 1000 - live.started)}
      </>
    )
    body = (
      <>
        {live.progress?.total ? <Bar done={live.progress.done ?? 0} total={live.progress.total} /> : null}
        {live.progress?.text && <div className="mhs-note">{live.progress.text}</div>}
      </>
    )
  } else if (ended) {
    const ok = ended.data.status === 'done'
    tone = ok ? 'ok' : 'bad'
    line = ok
      ? t('status.done')
      : `${word('status', String(ended.data.status))} · ${word('reason', String(ended.data.reason ?? ''))}`
    body = <div className="mhs-tcard-result">{ended.text}</div>
  } else if (data && status !== 'running') {
    const ok = status === 'done'
    const took =
      typeof data.ended === 'number' && typeof data.started === 'number'
        ? data.ended - data.started
        : undefined
    tone = ok ? 'ok' : 'bad'
    line = ok
      ? took !== undefined
        ? t('tool.done', { elapsed: elapsed(took) })
        : t('status.done')
      : `${word('status', status ?? 'error')} · ${word('reason', String(data.reason ?? ''), String(data.reason ?? ''))}`
    const pose = (data.after as { pose?: { x: number; y: number; yaw: number; ok: boolean } } | undefined)
      ?.pose
    body = (
      <>
        <div className="mhs-tcard-result">
          {typeof data.detail === 'string' ? data.detail : null}
          {Array.isArray(data.notes) && data.notes.length > 0 && (
            <span className="mhs-dim"> · {(data.notes as string[]).join('; ')}</span>
          )}
        </div>
        {pose && (
          <div className="mhs-note">
            {t('card.after')}:{' '}
            {t('position.at', { x: valueText(pose.x), y: valueText(pose.y), yaw: Math.round(pose.yaw) })}
          </div>
        )}
        <StateChips state={data.state as DeviceState | undefined} id={deviceId ?? ''} />
      </>
    )
  } else line = <Status node={node} />

  return (
    <Shell
      node={node}
      tone={tone}
      verb={t('card.call')}
      device={deviceId}
      what={
        <>
          <code className="mhs-tcard-tool">{decl?.ui?.label ?? toolName}</code>
          <span className="mhs-dim">
            {argsText(decl, (args.args as Json | undefined) ?? (data?.args as Json | undefined))}
          </span>
        </>
      }
      status={line}
    >
      {body}
    </Shell>
  )
}

function SetCard(props: { node: ToolNode }) {
  const args = parse(props.node.argsPreview)
  const data = useDetail(props.node)
  const deviceId = (data?.device as string | undefined) ?? (args.device as string | undefined)
  const asked = (args.values as Json | undefined) ?? {}
  const values = (data?.values as Json | undefined) ?? {}
  const before = (data?.before as Json | undefined) ?? {}
  const refused = (data?.refused as Record<string, string> | undefined) ?? {}
  return (
    <Shell
      node={props.node}
      tone={toneOf(props.node)}
      verb={t('card.set')}
      device={deviceId}
      status={<Status node={props.node} />}
    >
      <div className="mhs-tcard-list">
        {Object.keys(asked).map((name) => (
          <span key={name} className="mhs-tcard-row">
            <code>{name}</code>
            {name in before && <span className="mhs-dim">{valueText(before[name])} →</span>}
            <strong>{valueText(name in values ? values[name] : asked[name])}</strong>
            {refused[name] && (
              <span className="mhs-note mhs-note-bad">{t('set.refused', { reason: refused[name] })}</span>
            )}
          </span>
        ))}
      </div>
    </Shell>
  )
}

function StopCard(props: { node: ToolNode }) {
  const args = parse(props.node.argsPreview)
  const data = useDetail(props.node)
  const stopped = (data?.stopped as string[] | undefined) ?? []
  return (
    <Shell
      node={props.node}
      tone={props.node.status === 'failed' ? 'bad' : 'bad'}
      verb={args.device ? t('card.stop') : t('card.stop.all')}
      device={args.device as string | undefined}
      status={<Status node={props.node} />}
    >
      {data && (
        <div className="mhs-tcard-result">
          {stopped.length ? t('card.interrupted', { jobs: stopped.join(', ') }) : t('card.nothingMoving')}
        </div>
      )}
    </Shell>
  )
}

function WatchCard(props: { node: ToolNode }) {
  const args = parse(props.node.argsPreview)
  const data = useDetail(props.node)
  const events = useEvents()
  const watch = data?.watch as string | undefined
  const fired = watch ? events.find((e) => e.type === 'watch' && e.data.watch === watch) : undefined
  const until = (args.until as Json | undefined) ?? (data?.until as Json | undefined)
  return (
    <Shell
      node={props.node}
      tone={
        fired
          ? fired.data.matched
            ? 'ok'
            : 'off'
          : toneOf(props.node) === 'ok'
            ? 'busy'
            : toneOf(props.node)
      }
      verb={t('card.watch')}
      device={(data?.device as string | undefined) ?? (args.device as string | undefined)}
      what={until ? <code>{untilText(until)}</code> : undefined}
      status={fired ? fired.text : <Status node={props.node} />}
    >
      {typeof args.note === 'string' && <div className="mhs-note">{args.note}</div>}
    </Shell>
  )
}

function UnwatchCard(props: { node: ToolNode }) {
  const args = parse(props.node.argsPreview)
  return (
    <Shell
      node={props.node}
      tone={toneOf(props.node)}
      verb={t('card.unwatch')}
      what={<code>{String(args.watch ?? '')}</code>}
      status={<Status node={props.node} />}
    />
  )
}

function Status(props: { node: ToolNode }) {
  const s = props.node.status
  if (s === 'completed') return <>{t('status.done')}</>
  if (s === 'failed') return <>{t('status.error')}</>
  if (s === 'cancelled') return <>{t('reason.cancel')}</>
  return <>{t('card.waiting')}</>
}

/** The `tool.call.toolview` entry for one brain tool. */
export function ToolCard(props: { owner?: { block?: ToolNode } }) {
  useLocale()
  const node = props.owner?.block
  if (!node) return null
  switch (node.name) {
    case 'list_devices':
      return <ListCard node={node} />
    case 'read_device':
      return <ReadCard node={node} />
    case 'call_device':
      return <CallCard node={node} />
    case 'set_device':
      return <SetCard node={node} />
    case 'stop_device':
      return <StopCard node={node} />
    case 'watch_device':
      return <WatchCard node={node} />
    case 'unwatch_device':
      return <UnwatchCard node={node} />
    default:
      return null
  }
}
