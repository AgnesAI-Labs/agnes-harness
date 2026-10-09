/**
 * One device (mhs-ui-design 13.1): the header with availability, health, position, what it is doing
 * and Stop; then picture, drive, actions, state, ranging, position, telemetry, sound, text, tools,
 * source switches and activity. Sections follow `ui.group` and `ui.order` when the device gives them.
 */
import { type ReactNode, useState } from 'react'
import { Drive } from '../controls/drive.js'
import { type RequestPick, StateControl, ToolForm } from '../controls/tools.js'
import { Button, Chevron, Toggle } from '../controls/ui.js'
import {
  displayName,
  paramsOf,
  primaryImage,
  SECTIONS,
  sectionOf,
  tone,
  visibleFields,
} from '../core/describe.js'
import type { Device, Source } from '../core/types.js'
import { ago, t, word } from '../i18n/i18n.js'
import { useDevice, useEvents, useLocale, useNav, useNow, useStore } from '../react/hooks.js'
import { FieldView } from '../widgets/fields.js'
import { MapView, type Pick } from '../widgets/map.js'
import { DRAWN_ELSEWHERE, widgetFor } from '../widgets/registry.js'
import { Availability, Doing, HealthText, PositionText, StopButton } from './parts.js'

function Section(props: { id: string; children: ReactNode; label?: string | undefined }) {
  return (
    <section className="mhs-section" data-section={props.id}>
      <h3>{props.label ?? word('device.section', props.id)}</h3>
      {props.children}
    </section>
  )
}

function SourceWidget(props: { device: Device; source: Source }) {
  const w = widgetFor(props.source)
  const C = w.component
  return (
    <div className="mhs-cell" data-cols={w.size.cols} style={{ minWidth: Math.min(w.size.minPx, 260) }}>
      <C device={props.device} source={props.source} />
    </div>
  )
}

function Pictures(props: { device: Device; sources: Source[] }) {
  const first = primaryImage(props.device)
  const [main, setMain] = useState(first?.id)
  const shown = props.sources.find((s) => s.id === main) ?? props.sources[0]
  if (!shown) return null
  return (
    <div className="mhs-pictures">
      <SourceWidget device={props.device} source={shown} />
      {props.sources.length > 1 && (
        <div className="mhs-picture-tabs">
          {props.sources.map((s) => (
            <Button
              key={s.id}
              small
              kind={s.id === shown.id ? 'primary' : 'plain'}
              onClick={() => setMain(s.id)}
            >
              {s.ui?.label ?? s.id}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function Activity(props: { device: string }) {
  const events = useEvents()
  const now = useNow(5000)
  const mine = events
    .filter((e) => e.device === props.device)
    .slice(-30)
    .reverse()
  if (mine.length === 0) return <p className="mhs-dim">{t('device.noActivity')}</p>
  return (
    <ol className="mhs-events">
      {mine.map((e) => (
        <li key={e.id} data-level={e.level}>
          <span className="mhs-event-type">{word('event', e.type)}</span>
          <span className="mhs-event-text">{e.text}</span>
          <span className="mhs-dim">{ago(now / 1000 - e.time)}</span>
        </li>
      ))}
    </ol>
  )
}

function Switches(props: { device: Device }) {
  const store = useStore()
  const switchable = props.device.sources.filter((s) => s.switchable)
  if (switchable.length === 0) return null
  return (
    <Section id="sources">
      <div className="mhs-switches">
        {switchable.map((s) => {
          const on = !(props.device.off ?? []).includes(s.id)
          return (
            <div key={s.id} className="mhs-switch-row">
              <Toggle
                on={on}
                label={s.id}
                disabled={store.conn !== 'open'}
                onChange={(v) => void store.configure(props.device.id, s.id, v).catch(() => undefined)}
              />
              <code>{s.id}</code> <span className="mhs-dim">{s.ui?.label ?? s.description}</span>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

export function DevicePage(props: { id: string }) {
  useLocale()
  const nav = useNav()
  const d = useDevice(props.id)
  const [pick, setPick] = useState<Pick | undefined>()
  if (!d)
    return (
      <div className="mhs-page">
        <Button kind="ghost" small onClick={() => nav.open(undefined)}>
          <Chevron dir="left" /> {t('device.back')}
        </Button>
        <p className="mhs-dim">{t('device.offline')}</p>
      </div>
    )
  const requestPick: RequestPick = (mode, onPick) =>
    setPick({
      mode,
      onPick: (v) => {
        onPick(v)
        setPick(undefined)
      },
    })
  const sources = d.sources
    .filter((s) => !s.ui?.hidden && !DRAWN_ELSEWHERE.has(s.kind))
    .sort((a, b) => (a.ui?.order ?? 0) - (b.ui?.order ?? 0))
  const bySection = new Map<string, Source[]>()
  for (const s of sources) bySection.set(sectionOf(s), [...(bySection.get(sectionOf(s)) ?? []), s])
  const tools = (d.tools ?? []).filter((tool) => !tool.ui?.hidden)
  const quick = tools.filter(
    (tool) => tool.ui?.group === 'manual' || paramsOf(tool).every(([, , req]) => !req),
  )
  const formed = tools.filter((tool) => !quick.includes(tool))
  const fields = visibleFields(d)
  const hasPlace = d.position !== undefined || d.sources.some((s) => s.kind === 'pose' || s.kind === 'grid')
  const extraGroups = [...bySection.keys()].filter((g) => !(SECTIONS as readonly string[]).includes(g))
  const order = [...SECTIONS.slice(0, -1), ...extraGroups, 'activity']

  const blocks: Record<string, ReactNode> = {
    picture: bySection.get('picture')?.length ? (
      <Section id="picture" key="picture">
        <Pictures device={d} sources={bySection.get('picture') ?? []} />
      </Section>
    ) : null,
    drive: d.manual ? (
      <Section id="drive" key="drive">
        <Drive device={d} />
      </Section>
    ) : null,
    actions: quick.length ? (
      <Section id="actions" key="actions">
        <div className="mhs-tools">
          {quick.map((tool) => (
            <ToolForm key={tool.name} device={d} tool={tool} requestPick={requestPick} />
          ))}
        </div>
      </Section>
    ) : null,
    state: fields.length ? (
      <Section id="state" key="state">
        <div className="mhs-fields">
          {fields.map(([name, field]) =>
            field.writable ? (
              <StateControl key={name} device={d} name={name} field={field} value={d.state.values[name]} />
            ) : (
              <FieldView key={name} name={name} field={field} value={d.state.values[name]} />
            ),
          )}
        </div>
        {typeof d.state.values.problem === 'string' && (
          <p className="mhs-note mhs-note-bad">{d.state.values.problem}</p>
        )}
        {Array.isArray(d.state.values.faults) && d.state.values.faults.length > 0 && (
          <p className="mhs-note mhs-note-bad">
            {(d.state.values.faults as unknown[]).map(String).join('; ')}
          </p>
        )}
      </Section>
    ) : null,
    place:
      hasPlace || bySection.get('place')?.length ? (
        <Section id="place" key="place">
          {hasPlace && <MapView device={d} pick={pick} />}
          {pick && (
            <Button small kind="ghost" onClick={() => setPick(undefined)}>
              {t('tool.cancel')}
            </Button>
          )}
          <div className="mhs-grid">
            {(bySection.get('place') ?? []).map((s) => (
              <SourceWidget key={s.id} device={d} source={s} />
            ))}
          </div>
        </Section>
      ) : null,
    tools: formed.length ? (
      <Section id="tools" key="tools">
        <div className="mhs-tools">
          {formed.map((tool) => (
            <ToolForm
              key={tool.name}
              device={d}
              tool={tool}
              requestPick={hasPlace ? requestPick : undefined}
            />
          ))}
        </div>
      </Section>
    ) : null,
    sources: <Switches key="sources" device={d} />,
    activity: (
      <Section id="activity" key="activity">
        <Activity device={d.id} />
      </Section>
    ),
  }
  for (const g of order)
    if (!(g in blocks) && bySection.get(g)?.length)
      blocks[g] = (
        <Section id={g} key={g} label={(SECTIONS as readonly string[]).includes(g) ? undefined : g}>
          <div className="mhs-grid">
            {(bySection.get(g) ?? []).map((s) => (
              <SourceWidget key={s.id} device={d} source={s} />
            ))}
          </div>
        </Section>
      )

  return (
    <div className="mhs-page">
      <header className="mhs-page-head" data-tone={tone(d)}>
        <Button kind="ghost" small onClick={() => nav.open(undefined)}>
          <Chevron dir="left" /> {t('device.back')}
        </Button>
        <div className="mhs-page-title">
          <h2 className="mhs-mark">{displayName(d)}</h2>
          <code>{d.id}</code>
          <span className="mhs-dim">{d.model ?? d.kind}</span>
          <span className="mhs-grow" />
          <StopButton device={d.id} small={false} />
        </div>
        <div className="mhs-page-status">
          <Availability device={d} />
          <HealthText health={d.health} all />
          {d.position && <PositionText position={d.position} detail />}
        </div>
        <Doing device={d} />
      </header>
      {order.map((g) => blocks[g] ?? null)}
    </div>
  )
}
