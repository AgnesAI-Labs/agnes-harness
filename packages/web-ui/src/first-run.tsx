import type { DoctorResult } from '@agnes/protocol/gen/app-server'
import { useLayoutEffect, useRef, useState } from 'react'
import type { Translate } from './locales/index.js'
import { SettingsInput, SettingsList, SettingsRow, SettingsState } from './settings-layout.js'
import { Badge } from './ui/badge.js'
import { Button } from './ui/button.js'
import { Dialog } from './ui/dialog.js'
import { Disclosure } from './ui/disclosure.js'
import { Field } from './ui/field.js'
import { Icon } from './ui/icon.js'

const steps = ['account', 'workspace', 'ready'] as const
/** The stable account region remains owned by its native controller, including OAuth cleanup. */
function InlineAccount({ attach }: { attach(host: HTMLElement): () => void }) {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    let cancelled = false
    let detach: (() => void) | undefined
    queueMicrotask(() => {
      if (!cancelled && host.current) detach = attach(host.current)
    })
    return () => {
      cancelled = true
      queueMicrotask(() => detach?.())
    }
  }, [attach])
  return <div ref={host} data-testid="first-run-connection" />
}
export function FirstRunGuide({
  open,
  step,
  connecting,
  accountReady,
  demo,
  workspace,
  busy,
  picking,
  error,
  t,
  attachAccount,
  onAdd,
  onDemo,
  onWorkspace,
  onCancelPick,
  onExamples,
  onStep,
  onContinue,
  onSkip,
}: {
  open: boolean
  step: number
  connecting: boolean
  accountReady: boolean
  demo: boolean
  workspace: string
  busy: boolean
  picking: boolean
  error: string
  t: Translate
  attachAccount(host: HTMLElement): () => void
  onAdd(): void
  onDemo(): void
  onWorkspace(path?: string): void
  onCancelPick(): void
  onExamples(): void
  onStep(step: number): void
  onContinue(): void
  onSkip(): void
}) {
  const key = steps[step] ?? 'account'
  const [path, setPath] = useState('')
  return (
    <Dialog
      open={open}
      title={t('firstRun.welcome')}
      footer={null}
      width={560}
      centered
      onCancel={onSkip}
      closable={false}
      className="agnes-first-run"
      rootClassName="agnes-first-run-layer"
      mask={{ closable: false }}
    >
      <section data-testid="first-run-guide" data-step={key} aria-label={t(`firstRun.${key}`)}>
        <p className="field-hint">{t('firstRun.step', { step: step + 1, total: steps.length })}</p>
        <ol className="agnes-setup-progress" aria-label={t('firstRun.progress')}>
          {steps.map((name, index) => (
            <li
              key={name}
              aria-current={index === step ? 'step' : undefined}
              data-complete={index < step}
              title={t(`firstRun.${name}`)}
            >
              <span className="agnes-setup-progress-dot" aria-hidden="true">
                {index < step ? '✓' : index + 1}
              </span>
              <span className="agnes-setup-progress-label">{t(`firstRun.${name}`)}</span>
            </li>
          ))}
        </ol>
        <h3 className="agnes-first-run-heading">{t(`firstRun.${key}`)}</h3>
        <p className="agnes-first-run-lead">{t(`firstRun.${key}Help`)}</p>
        {step === 0 && (
          <>
            <div className="agnes-settings-actions agnes-first-run-choices">
              <Button data-testid="first-run-add" aria-pressed={connecting} onClick={onAdd} disabled={busy}>
                {t('firstRun.add')}
              </Button>
              <Button
                hidden={accountReady}
                data-testid="first-run-demo"
                aria-pressed={demo}
                onClick={onDemo}
                disabled={busy}
              >
                {t('firstRun.demo')}
              </Button>
            </div>
            {connecting && <InlineAccount attach={attachAccount} />}
            {demo && <p className="field-hint">{t('firstRun.demoHelp')}</p>}
          </>
        )}
        {step === 1 && (
          <>
            {workspace && <p data-testid="first-run-workspace">{workspace}</p>}
            <Button
              data-testid="first-run-workspace-pick"
              onClick={() => onWorkspace()}
              disabled={busy || picking}
            >
              <Icon name="folder" />
              {t('firstRun.chooseWorkspace')}
            </Button>
            {picking && (
              <SettingsState tone="empty" data-testid="first-run-picking">
                {t('firstRun.pickerOpened')}{' '}
                <Button appearance="link" data-testid="first-run-pick-cancel" onClick={onCancelPick}>
                  {t('firstRun.pickerCancel')}
                </Button>
              </SettingsState>
            )}
            <Disclosure variant="plain" summary={t('firstRun.manualWorkspace')}>
              <Field label={t('firstRun.workspacePath')}>
                <SettingsInput
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  disabled={busy}
                />
              </Field>
              <Button onClick={() => onWorkspace(path)} disabled={busy || !path.trim()}>
                {t('firstRun.useWorkspace')}
              </Button>
            </Disclosure>
          </>
        )}
        {step === 2 && (
          <>
            <p>{t('firstRun.prompt')}</p>
            {demo && <p data-testid="first-run-demo-next">{t('firstRun.demoNext')}</p>}
            <Button appearance="link" data-testid="first-run-examples" onClick={onExamples} disabled={busy}>
              {t('firstRun.review')}
            </Button>
          </>
        )}
        {busy && <SettingsState tone="loading">{t('firstRun.loading')}</SettingsState>}
        {error && <SettingsState tone="error">{error}</SettingsState>}
        <div className="agnes-first-run-actions">
          <Button appearance="ghost" data-testid="first-run-skip" onClick={onSkip}>
            {t('firstRun.skip')}
          </Button>
          <div>
            {step > 0 && (
              <Button onClick={() => onStep(step - 1)} disabled={busy}>
                {t('firstRun.back')}
              </Button>
            )}
            <Button
              appearance="primary"
              data-testid="first-run-next"
              loading={busy}
              disabled={(step === 0 && !connecting && !demo && !accountReady) || (step === 1 && !workspace)}
              disabledReason={t(step === 1 ? 'firstRun.workspaceHelp' : 'firstRun.accountHelp')}
              onClick={onContinue}
            >
              {t(
                step === 2
                  ? 'firstRun.start'
                  : step === 0 && connecting
                    ? 'firstRun.verify'
                    : 'firstRun.next',
              )}
            </Button>
          </div>
        </div>
      </section>
    </Dialog>
  )
}
export function DoctorNotice({
  t,
  onDetails,
  onDismiss,
  count,
}: {
  t: Translate
  onDetails(): void
  onDismiss(): void
  count: number
}) {
  return (
    <aside className="agnes-doctor-notice" data-testid="doctor-notice" role="status">
      <p>{t('doctor.banner', { count })}</p>
      <Button onClick={onDetails}>{t('doctor.details')}</Button>
      <Button type="text" onClick={onDismiss} aria-label={t('doctor.dismiss')}>
        ×
      </Button>
    </aside>
  )
}
export function DoctorChecks({ report, t, locale }: { report: DoctorResult; t: Translate; locale: string }) {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  const space = (bytes: number) => t('doctor.spaceUnit', { value: number.format(bytes / 1024 ** 3) })
  return (
    <SettingsList data-testid="doctor-checks">
      {report.checks.map((check) => (
        <SettingsRow
          key={check.id}
          title={t(`doctor.check.${check.id}`)}
          data-testid={`doctor-check-${check.id}`}
          description={check.status === 'ok' ? undefined : t(check.fixHintKey)}
          actions={
            <Badge tone={check.status === 'fail' ? 'bad' : check.status}>
              {t(`doctor.status.${check.status}`)}
            </Badge>
          }
        >
          {check.count !== undefined && (
            <p className="field-hint">{t('doctor.count', { count: number.format(check.count) })}</p>
          )}
          {check.availableBytes !== undefined && check.totalBytes !== undefined && (
            <p className="field-hint" data-testid="doctor-space">
              {t('doctor.space', { available: space(check.availableBytes), total: space(check.totalBytes) })}
            </p>
          )}
          {check.id === 'accounts' && check.probed === false && (
            <p className="field-hint">{t('doctor.notProbed')}</p>
          )}
        </SettingsRow>
      ))}
    </SettingsList>
  )
}
