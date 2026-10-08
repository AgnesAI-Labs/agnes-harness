import {
  CHILD_ENGINE_CAPABILITIES,
  type ChildEngineSettings,
  childEngineSettingsError,
  DISABLED_CHILD_ENGINES,
} from '@agnes/base/child-engines'
import { Button, Field, SettingsCard, SettingsInput, SettingsSelect, SettingsTextArea } from '@agnes/web-ui'
import { useEffect, useState } from 'react'

type Text = (key: string) => string
type EngineId = 'codex' | 'claude-code' | 'sdk'
const ENGINES: readonly EngineId[] = ['codex', 'claude-code', 'sdk']

export type ChildEnginesClient = {
  childEngines(): Promise<{
    revision: number
    engines: ChildEngineSettings
    effect?: 'new-sessions' | 'restart-required'
  }>
  saveChildEngines(input: { revision: number; engines: ChildEngineSettings }): Promise<{
    revision: number
    engines: ChildEngineSettings
    effect?: 'new-sessions' | 'restart-required'
  }>
}

function failureCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const details = 'details' in error ? (error as { details?: { code?: unknown } }).details : undefined
  if (typeof details?.code === 'string') return details.code
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function flags(id: EngineId, protocol: 'sdk' | 'acp') {
  const key = id === 'sdk' && protocol === 'acp' ? 'acp' : id
  return CHILD_ENGINE_CAPABILITIES[key]
}

export function ChildEnginesPanel({
  api,
  canSave,
  t,
}: {
  api?: ChildEnginesClient | undefined
  canSave: boolean
  t: Text
}) {
  const [draft, setDraft] = useState<ChildEngineSettings>(structuredClone(DISABLED_CHILD_ENGINES))
  const [revision, setRevision] = useState(0)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    if (!api) {
      setStatus('engine.unavailable')
      return
    }
    void api.childEngines().then(
      (state) => {
        if (cancelled) return
        setDraft(state.engines)
        setRevision(state.revision)
        setReady(true)
      },
      () => {
        if (!cancelled) setStatus('engine.unavailable')
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])
  const update = (next: ChildEngineSettings) => {
    setDraft(next)
    setStatus('')
  }
  const engine = (id: EngineId) =>
    id === 'claude-code' ? draft.claudeCode : id === 'sdk' ? draft.sdk : draft.codex
  const replace = (
    id: EngineId,
    patch: Partial<ChildEngineSettings['codex']> & { protocol?: 'sdk' | 'acp' },
  ) => {
    if (id === 'claude-code') update({ ...draft, claudeCode: { ...draft.claudeCode, ...patch } })
    else if (id === 'codex') update({ ...draft, codex: { ...draft.codex, ...patch } })
    else update({ ...draft, sdk: { ...draft.sdk, ...patch } })
  }
  return (
    <SettingsCard data-testid="child-engines">
      <p>{t('enginesHelp')}</p>
      {ENGINES.map((id) => {
        const current = engine(id)
        const protocol = id === 'sdk' ? draft.sdk.protocol : 'sdk'
        const capability = flags(id, protocol)
        return (
          <SettingsCard
            key={id}
            className="runtime-card"
            data-testid={`child-engine-${id}`}
            aria-labelledby={`child-engine-${id}-title`}
          >
            <h3 id={`child-engine-${id}-title`}>{t(`engine.${id}`)}</h3>
            <label className="agnes-settings-checkbox" htmlFor={`child-engine-${id}-enabled`}>
              <SettingsInput
                type="checkbox"
                id={`child-engine-${id}-enabled`}
                data-testid={`child-engine-${id}-enabled`}
                checked={current.enabled}
                disabled={!canSave || !ready || busy}
                onChange={(event) => replace(id, { enabled: event.target.checked })}
              />{' '}
              {t('engine.enabled')}
            </label>
            <Field label={t('engine.command')}>
              <SettingsInput
                data-testid={`child-engine-${id}-command`}
                aria-label={`${t(`engine.${id}`)} ${t('engine.command')}`}
                value={current.command}
                disabled={!canSave || !ready || busy}
                onChange={(event) => replace(id, { command: event.target.value })}
              />
            </Field>
            <Field label={t('engine.args')}>
              <SettingsTextArea
                data-testid={`child-engine-${id}-args`}
                aria-label={`${t(`engine.${id}`)} ${t('engine.args')}`}
                value={current.args.join('\n')}
                disabled={!canSave || !ready || busy}
                onChange={(event) => replace(id, { args: lines(event.target.value) })}
              />
            </Field>
            <Field label={t('engine.allow')}>
              <SettingsTextArea
                data-testid={`child-engine-${id}-allow`}
                aria-label={`${t(`engine.${id}`)} ${t('engine.allow')}`}
                value={current.allow.join('\n')}
                disabled={!canSave || !ready || busy}
                onChange={(event) => replace(id, { allow: lines(event.target.value) })}
              />
            </Field>
            {id === 'sdk' && (
              <Field label={t('engine.protocol')}>
                <SettingsSelect
                  data-testid="child-engine-sdk-protocol"
                  aria-label={t('engine.protocol')}
                  value={draft.sdk.protocol}
                  disabled={!canSave || !ready || busy}
                  onChange={(event) =>
                    replace('sdk', { protocol: event.target.value === 'acp' ? 'acp' : 'sdk' })
                  }
                >
                  <option value="sdk">{t('engine.sdkProtocol')}</option>
                  <option value="acp">{t('engine.acpProtocol')}</option>
                </SettingsSelect>
              </Field>
            )}
            <h4>{t('engine.capabilities')}</h4>
            <ul data-testid={`child-engine-${id}-capabilities`}>
              {Object.entries(capability).map(([name, on]) => (
                <li key={name}>
                  {t(`cap.${name}`)}: {t(on ? 'yes' : 'no')}
                </li>
              ))}
            </ul>
          </SettingsCard>
        )
      })}
      <p>{t('engine.restart')}</p>
      {status && (
        <p
          role={status === 'engine.saved' || status === 'engine.savedRestart' ? 'status' : 'alert'}
          data-testid="child-engine-status"
        >
          {t(status)}
        </p>
      )}
      {saved && (
        <section aria-label={t('engine.document')}>
          <pre data-testid="child-engine-document">{saved}</pre>
        </section>
      )}
      <Button
        data-testid="child-engine-save"
        disabled={!canSave || !ready || busy}
        loading={busy}
        onClick={() => {
          if (busy || !ready) return
          const error = childEngineSettingsError(draft)
          if (error) {
            setStatus(error === 'allow' ? 'engine.allowRequired' : 'engine.commandRequired')
            return
          }
          if (!api) {
            setStatus('engine.unavailable')
            return
          }
          setBusy(true)
          void api.saveChildEngines({ revision, engines: draft }).then(
            (state) => {
              setBusy(false)
              setRevision(state.revision)
              setDraft(state.engines)
              setSaved(JSON.stringify(state.engines))
              setStatus(state.effect === 'restart-required' ? 'engine.savedRestart' : 'engine.saved')
            },
            (error: unknown) => {
              setBusy(false)
              setStatus(
                failureCode(error) === 'CONFIG_REVISION_CONFLICT' ? 'engine.conflict' : 'engine.unavailable',
              )
            },
          )
        }}
      >
        {t('engine.save')}
      </Button>
    </SettingsCard>
  )
}
