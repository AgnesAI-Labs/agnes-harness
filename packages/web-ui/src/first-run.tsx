import type { ConfigSnapshot } from '@agnes/protocol'
import type { DoctorResult } from '@agnes/protocol/gen/app-server'
import type { Translate } from './locales/index.js'
import { SettingsList, SettingsRow, SettingsState } from './settings-layout.js'
import { Button } from './ui/button.js'
import { Dialog } from './ui/dialog.js'
import { Field } from './ui/field.js'
import { Select } from './ui/select.js'
import { StateLights } from './ui/state-lights.js'

const steps = ['welcome', 'account', 'model', 'examples', 'ready'] as const
export function FirstRunGuide({
  open,
  step,
  snapshot,
  accountId,
  model,
  busy,
  error,
  t,
  onStep,
  onAccount,
  onModel,
  onAdd,
  onExamples,
  onContinue,
  onSkip,
}: {
  open: boolean
  step: number
  snapshot?: ConfigSnapshot | undefined
  accountId: string
  model: string
  busy: boolean
  error: string
  t: Translate
  onStep(step: number): void
  onAccount(id: string): void
  onModel(id: string): void
  onAdd(): void
  onExamples(): void
  onContinue(): void
  onSkip(): void
}) {
  const key = steps[step] ?? 'welcome'
  const accounts =
    snapshot?.accounts?.filter((account) => account.enabled && account.credentialConfigured) ?? []
  const account = accounts.find((account) => account.accountId === accountId)
  return (
    <Dialog
      open={open}
      title={t(`firstRun.${key}`)}
      footer={null}
      width={640}
      centered
      onCancel={onSkip}
      closable={false}
      className="agnes-first-run"
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
              <span aria-hidden="true">{index + 1}</span>
              <span className="visually-hidden">{t(`firstRun.${name}`)}</span>
            </li>
          ))}
        </ol>
        <p>{t(`firstRun.${key}Help`)}</p>
        {step === 1 && (
          <Button data-testid="first-run-add" onClick={onAdd} disabled={busy}>
            {t('firstRun.add')}
          </Button>
        )}
        {step === 2 && (
          <div className="agnes-first-run-fields">
            <Field label={t('firstRun.accountLabel')}>
              <Select
                data-testid="first-run-account"
                aria-label={t('firstRun.accountLabel')}
                value={accountId}
                options={accounts.map((account) => ({ value: account.accountId, label: account.label }))}
                onChange={onAccount}
                disabled={busy}
              />
            </Field>
            <Field label={t('firstRun.modelLabel')}>
              <Select
                data-testid="first-run-model"
                aria-label={t('firstRun.modelLabel')}
                value={model}
                options={account?.models.map((model) => ({ value: model.id, label: model.name })) ?? []}
                onChange={onModel}
                disabled={busy}
              />
            </Field>
          </div>
        )}
        {step === 3 && (
          <Button data-testid="first-run-examples" onClick={onExamples} disabled={busy}>
            {t('firstRun.review')}
          </Button>
        )}
        {busy && <SettingsState tone="loading">{t('firstRun.loading')}</SettingsState>}
        {error && <SettingsState tone="error">{error}</SettingsState>}
        <div className="agnes-first-run-actions">
          <Button type="text" data-testid="first-run-skip" onClick={onSkip}>
            {t('firstRun.skip')}
          </Button>
          <div>
            {step > 0 && (
              <Button onClick={() => onStep(step - 1)} disabled={busy}>
                {t('firstRun.back')}
              </Button>
            )}
            <Button
              type="primary"
              data-testid="first-run-next"
              loading={busy}
              disabled={(step === 1 && !accounts.length) || (step === 2 && (!account || !model))}
              onClick={onContinue}
            >
              {t(step === 0 ? 'firstRun.begin' : step === 4 ? 'firstRun.start' : 'firstRun.next')}
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
}: {
  t: Translate
  onDetails(): void
  onDismiss(): void
}) {
  return (
    <aside className="agnes-doctor-notice" data-testid="doctor-notice" role="status">
      <p>{t('doctor.banner')}</p>
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
            <StateLights
              states={[
                {
                  label: t(`doctor.check.${check.id}`),
                  value: t(`doctor.status.${check.status}`),
                  tone: check.status === 'fail' ? 'bad' : check.status,
                },
              ]}
            />
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
