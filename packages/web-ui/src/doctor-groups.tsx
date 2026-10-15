import type { DoctorResult } from '@agnes/protocol/gen/app-server'
import type { ReactNode } from 'react'
import type { Translate } from './locales/index.js'
import { Button } from './ui/button.js'
import { Icon } from './ui/icon.js'

type Check = DoctorResult['checks'][number]
type State = Check['status'] | 'unavailable' | 'pending'
type CheckItem = {
  id: string
  name: string
  status: State
  value: string
  hint: string | undefined
  fix: string
  destination: string | undefined
}
export type DoctorWorker = { text: string; status: Exclude<State, 'pending'> }
const GROUPS = [
  { id: 'environment', icon: 'activity', checks: ['node', 'native', 'worker'] },
  { id: 'data', icon: 'lock-keyhole', checks: ['home', 'permissions', 'credentials', 'disk'] },
  { id: 'isolation', icon: 'shield', checks: ['sandbox', 'mcp'] },
  { id: 'connection', icon: 'link', checks: ['connection', 'accounts', 'plugins'] },
] as const
const DESTINATIONS: Partial<Record<Check['id'], string>> = {
  accounts: 'model',
  credentials: 'credentials',
  plugins: 'plugins',
  mcp: 'mcp',
  sandbox: 'isolation',
}

/** Compact, read-only doctor results. The settings owner supplies state and navigation. */
export function DoctorGroups({
  report,
  busy,
  worker,
  workerLabel,
  node,
  t,
  locale,
  onNavigate,
  onProbe,
  footer,
}: {
  report?: DoctorResult | undefined
  busy: boolean
  worker?: DoctorWorker | undefined
  workerLabel: string
  node?: string | undefined
  t: Translate
  locale: string
  footer?: ReactNode
  onProbe?(): void
  onNavigate(destination: string): void
}) {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  const space = (bytes: number) => t('doctor.spaceUnit', { value: number.format(bytes / 1024 ** 3) })
  const checks: Check[] =
    report?.checks ??
    GROUPS.flatMap((group) =>
      group.checks
        .filter((id) => id !== 'worker')
        .map((id) => ({ id, status: 'ok', fixHintKey: `doctor.fix.${id}` }) satisfies Check),
    )
  const items: CheckItem[] = checks.map((check) => {
    const values: string[] = []
    if (check.id === 'node' && node) values.push(node)
    if (check.count !== undefined) values.push(t('doctor.count', { count: number.format(check.count) }))
    if (check.availableBytes !== undefined && check.totalBytes !== undefined)
      values.push(
        t('doctor.space', { available: space(check.availableBytes), total: space(check.totalBytes) }),
      )
    if (check.id === 'accounts' && check.probed === true) values.push(t('doctor.probed'))
    if (check.status !== 'ok') values.push(t(`doctor.status.${check.status}`))
    return {
      id: check.id,
      name: t(`doctor.check.${check.id}`),
      status: check.status,
      value: values.join(' · '),
      hint: check.id === 'accounts' && check.probed === false ? t('doctor.notProbed') : undefined,
      fix: t(check.fixHintKey),
      destination: DESTINATIONS[check.id],
    }
  })
  items.push({
    id: 'worker',
    name: workerLabel,
    status: worker?.status ?? 'unavailable',
    value: worker?.status === 'ok' ? '' : (worker?.text ?? ''),
    hint: undefined,
    fix: t('doctor.fix.connection'),
    destination: undefined,
  })
  return (
    <>
      <div className="agnes-doctor-card" data-checking={busy}>
        <div className="agnes-doctor-groups">
          {GROUPS.map((group) => {
            const rows = items.filter((item) => group.checks.some((id) => id === item.id))
            const applicable = rows.filter((item) => item.status !== 'unavailable')
            return (
              <section
                key={group.id}
                className="agnes-doctor-group"
                data-doctor-group={group.id}
                aria-label={t(`doctor.group.${group.id}`)}
              >
                <h4>
                  <Icon name={group.icon} />
                  {t(`doctor.group.${group.id}`)}
                  <small
                    data-testid="doctor-group-count"
                    data-tone={
                      applicable.some((item) => item.status === 'warn' || item.status === 'fail')
                        ? 'warn'
                        : 'ok'
                    }
                  >
                    {busy
                      ? '…'
                      : `${applicable.filter((item) => item.status === 'ok').length}/${applicable.length}`}
                  </small>
                </h4>
                <ul>
                  {rows.map((item) => {
                    const state = busy ? 'pending' : item.status
                    const status = busy
                      ? t('doctor.loading')
                      : item.status === 'unavailable'
                        ? item.value
                        : t(`doctor.status.${item.status}`)
                    return (
                      <li
                        key={item.id}
                        data-testid={`doctor-check-${item.id}`}
                        data-state={state}
                        title={item.hint}
                      >
                        <span className="agnes-doctor-dot" aria-hidden="true" />
                        <span>{item.name}</span>
                        {item.id === 'accounts' && onProbe && (
                          <Button
                            type="text"
                            size="small"
                            className="agnes-doctor-probe"
                            data-testid="doctor-probe-accounts"
                            disabled={busy}
                            onClick={onProbe}
                          >
                            {t('doctor.test')}
                          </Button>
                        )}
                        <span className="agnes-doctor-sr">{status}</span>
                        {item.value && (
                          <span
                            className="agnes-doctor-value"
                            data-testid="doctor-check-value"
                            aria-hidden={busy || undefined}
                          >
                            {item.value}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
        {footer}
      </div>
      {!busy &&
        items
          .filter((item) => item.status === 'warn' || item.status === 'fail')
          .map((item) => (
            <div key={item.id} className="agnes-doctor-fix" data-state={item.status} data-testid="doctor-fix">
              <Icon name="triangle-alert" />
              <div>
                <b>
                  {item.name} · {t(`doctor.status.${item.status}`)}
                </b>
                <p>{item.fix}</p>
              </div>
              {item.destination && (
                <a
                  href={`?settings=${item.destination}`}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                    event.preventDefault()
                    if (item.destination) onNavigate(item.destination)
                  }}
                >
                  {t(`doctor.open.${item.destination}`)} ›
                </a>
              )}
            </div>
          ))}
    </>
  )
}
