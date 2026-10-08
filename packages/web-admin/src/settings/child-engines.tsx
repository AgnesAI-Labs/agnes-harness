import {
  CHILD_ENGINE_CAPABILITIES,
  type ChildEngineSettings,
  childEngineSettingsError,
  DISABLED_CHILD_ENGINES,
} from '@agnes/base/child-engines'
import { Button, configIssues, SchemaConfigFields, SchemaControl, SettingsCard } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { childEngineConfigSchema } from './config-schemas.js'

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
              <SchemaControl
                schema={childEngineConfigSchema(id).properties!.enabled!}
                value={current.enabled}
                disabled={!canSave || !ready || busy}
                t={t}
                onChange={(value) => replace(id, { enabled: value === true })}
              />{' '}
              {t('engine.enabled')}
            </label>
            <SchemaConfigFields
              schema={{
                ...childEngineConfigSchema(id),
                required: [],
                properties: Object.fromEntries(
                  Object.entries(childEngineConfigSchema(id).properties ?? {}).filter(
                    ([key]) => key !== 'enabled',
                  ),
                ),
              }}
              value={{
                command: current.command,
                args: current.args,
                allow: current.allow,
                ...(id === 'sdk' ? { protocol: draft.sdk.protocol } : {}),
              }}
              t={t}
              disabled={!canSave || !ready || busy}
              onChange={(next) => {
                if (typeof next.command === 'string' && Array.isArray(next.args) && Array.isArray(next.allow))
                  replace(id, {
                    command: next.command,
                    args: next.args,
                    allow: next.allow,
                    ...(id === 'sdk' ? { protocol: next.protocol === 'acp' ? 'acp' : 'sdk' } : {}),
                  })
              }}
            />
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
          const invalid = ENGINES.some(
            (id) => configIssues(childEngineConfigSchema(id), engine(id)).length > 0,
          )
          const error = invalid ? 'command' : childEngineSettingsError(draft)
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
