/**
 * The frame around every data widget, and the five states each must show (mhs-ui-design 7.4):
 * no data yet, switched off, stale, device offline, read error.
 */
import { type ReactNode, useState } from 'react'
import type { Latest } from '../core/store.js'
import type { Device, Source } from '../core/types.js'
import { ago, t, word } from '../i18n/i18n.js'
import { useNow, useSource, useStore, useVisible } from '../react/hooks.js'

export interface SourceProps {
  device: Device
  source: Source
  /** Items per second this view wants; small previews ask for less. */
  hz?: number
  compact?: boolean
}

/** Subscribes while the element is visible; returns the newest item and a ref for the element. */
export function useLive(device: Device, source: Source, hz?: number) {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const visible = useVisible(element)
  const off = device.off?.includes(source.id) ?? false
  const rate = Math.min(hz ?? source.hz ?? 1, source.hz ?? hz ?? 1)
  const latest = useSource(device.id, source.id, rate, visible && device.online && !off)
  return { ref: setElement, latest, off }
}

export function Frame(props: {
  device: Device
  source: Source
  latest: Latest | undefined
  off: boolean
  setRef: (el: HTMLElement | null) => void
  children: ReactNode
  tools?: ReactNode
  compact?: boolean
  /** Draws the body without data, and says nothing about waiting or age (a listen button). */
  idle?: boolean
}) {
  const { device, source, latest, off } = props
  const store = useStore()
  const now = useNow(1000)
  const period = source.hz ? 1 / source.hz : 1
  const age = latest ? (now - latest.at) / 1000 + (latest.item.age ?? 0) : undefined
  const stale = age !== undefined && age > Math.max(2 * period, 1.5)
  let note: ReactNode = null
  if (!device.online) note = <span className="mhs-note">{t('data.offline')}</span>
  else if (off)
    note = (
      <span className="mhs-note">
        {t('data.offByHand')}{' '}
        {source.switchable && (
          <button
            type="button"
            className="mhs-link"
            onClick={() => store.configure(device.id, source.id, true).catch(() => undefined)}
          >
            {t('data.turnOn')}
          </button>
        )}
      </span>
    )
  else if (latest?.item.error) note = <span className="mhs-note mhs-note-bad">{latest.item.error}</span>
  else if (props.idle) note = null
  else if (!latest) note = <span className="mhs-note">{t('data.waiting')}</span>
  else if (stale && age !== undefined) note = <span className="mhs-note">{ago(age)}</span>
  const body = props.idle || (latest && !latest.item.error) ? props.children : null
  // A preview is always a screen of the same size, with what is missing written on it.
  if (props.compact)
    return (
      <div
        className="mhs-screen mhs-preview"
        data-stale={(stale && !props.idle) || !device.online || undefined}
        ref={props.setRef}
      >
        {body}
        {note && <div className="mhs-preview-note">{note}</div>}
      </div>
    )
  return (
    <section
      className="mhs-widget"
      data-stale={(stale && !props.idle) || !device.online || undefined}
      ref={props.setRef}
    >
      <header className="mhs-widget-head">
        <span className="mhs-widget-title">{source.ui?.label ?? source.description}</span>
        <span className="mhs-widget-meta">
          <code>{source.id}</code> · {word('kind', source.kind)}
        </span>
        {props.tools}
      </header>
      <div className="mhs-widget-body">{body}</div>
      {note && <div className="mhs-widget-note">{note}</div>}
    </section>
  )
}
