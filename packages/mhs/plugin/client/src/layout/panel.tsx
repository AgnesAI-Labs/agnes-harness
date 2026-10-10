/**
 * The Devices panel, the same in every host: a header (online count, how many need attention,
 * what the brain is doing, Stop all) over the overview or one device's page.
 */

import { type ReactNode, useState } from 'react'
import { Segmented } from '../controls/ui.js'
import { t } from '../i18n/i18n.js'
import { useConn, useDevices, useLocale, useNav } from '../react/hooks.js'
import { DevicePage } from './device-page.js'
import { Flow } from './flow.js'
import { Overview } from './overview.js'
import { StopButton } from './parts.js'
import { WorldView } from './world.js'

export interface Brain {
  thinking: boolean
  /** The device of the brain's last device call while a turn runs. */
  device?: string | undefined
}

type View = 'devices' | 'flow' | 'activity' | 'world'

/** `activity` is the brain's calls in the current conversation; only a host with a session has it. */
export function Panel(props: { brain?: Brain; actions?: ReactNode; activity?: ReactNode }) {
  useLocale()
  const conn = useConn()
  const devices = useDevices()
  const nav = useNav()
  const [saved, setViewState] = useState<View>(() => {
    try {
      const v = localStorage.getItem('mhs.view')
      return v === 'devices' || v === 'activity' || v === 'world' ? v : 'flow'
    } catch {
      return 'flow'
    }
  })
  const view: View = saved === 'activity' && !props.activity ? 'flow' : saved
  const views: View[] = props.activity
    ? ['devices', 'flow', 'activity', 'world']
    : ['devices', 'flow', 'world']
  const setView = (v: View) => {
    setViewState(v)
    try {
      localStorage.setItem('mhs.view', v)
    } catch {
      // Private windows remember nothing.
    }
  }
  const online = devices.filter((d) => d.available).length
  const attention = devices.filter((d) => d.health.level !== 'ok').length
  return (
    <div className="mhs-panel">
      <header className="mhs-panel-head">
        <strong className="mhs-panel-title">{t('app.title')}</strong>
        <span className="mhs-head-count" title={t('overview.online', { n: online, total: devices.length })}>
          {online}/{devices.length}
        </span>
        {attention > 0 && (
          <span className="mhs-head-count mhs-warn-text" title={t('overview.attention', { n: attention })}>
            ▲ {attention}
          </span>
        )}
        {props.brain?.thinking && (
          <button
            type="button"
            className="mhs-brain"
            disabled={!props.brain.device}
            onClick={() => props.brain?.device && nav.open(props.brain.device)}
          >
            <span className="mhs-brain-pulse" />
            {props.brain.device ? t('overview.brain', { device: props.brain.device }) : '…'}
          </button>
        )}
        <span className="mhs-grow" />
        <span className="mhs-head-actions">
          <Segmented
            value={t(`view.${view}`)}
            options={views.map((v) => t(`view.${v}`))}
            onChange={(label) => setView(views.find((v) => t(`view.${v}`) === label) ?? 'flow')}
          />
          <StopButton label={t('overview.stopAll')} small={false} />
          {props.actions}
        </span>
      </header>
      {conn !== 'open' && (
        <div className="mhs-banner" data-conn={conn}>
          <strong>{conn === 'connecting' ? t('conn.connecting') : t('conn.closed')}</strong>
          {conn === 'closed' && <span> {t('conn.closed.hint')}</span>}
        </div>
      )}
      <div className="mhs-panel-body" data-disabled={conn !== 'open' || undefined}>
        {view === 'activity' && !nav.device ? (
          props.activity
        ) : view === 'world' && !nav.device ? (
          <WorldView />
        ) : view === 'flow' && !nav.device ? (
          <Flow brain={props.brain} />
        ) : nav.device ? (
          <DevicePage id={nav.device} />
        ) : (
          <Overview />
        )}
      </div>
    </div>
  )
}
