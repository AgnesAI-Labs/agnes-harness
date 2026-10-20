import {
  CHILD_ENGINE_CAPABILITIES,
  type ChildEngineSettings,
  childEngineSettingsError,
  DISABLED_CHILD_ENGINES,
} from '@agnes/protocol'
import {
  Button,
  configIssues,
  fallbackT,
  reportSuccess,
  SchemaConfigFields,
  SchemaControl,
  SettingsCode,
  SettingsDetails,
  SettingsGroup,
  SettingsItem,
  SettingsTechnicalDetails,
  StatusMessage,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { captureRequest, useRequestScope } from './async-request.js'
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
  const lifetime = useRequestScope(api, canSave)
  const [draft, setDraft] = useState<ChildEngineSettings>(structuredClone(DISABLED_CHILD_ENGINES))
  const [revision, setRevision] = useState(0)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState('')
  const [saved, setSaved] = useState('')
  const [loaded, setLoaded] = useState('')
  const [busy, setBusy] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes retire pending callbacks and reset their UI state.
  useEffect(() => {
    let cancelled = false
    setBusy(false)
    setReady(false)
    setStatus('')
    setSaved('')
    if (!api) {
      setStatus('engine.unavailable')
      return
    }
    void api.childEngines().then(
      (state) => {
        if (cancelled) return
        setDraft(state.engines)
        setLoaded(JSON.stringify(state.engines))
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
  }, [api, canSave])
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
  const dirty = ready && JSON.stringify(draft) !== loaded
  const save = () => {
    if (busy || !ready) return
    const invalid = ENGINES.some((id) => configIssues(childEngineConfigSchema(id), engine(id)).length > 0)
    const error = invalid ? 'command' : childEngineSettingsError(draft)
    if (error) {
      setStatus(error === 'allow' ? 'engine.allowRequired' : 'engine.commandRequired')
      return
    }
    if (!api) {
      setStatus('engine.unavailable')
      return
    }
    const request = captureRequest(lifetime)
    setBusy(true)
    void api.saveChildEngines({ revision, engines: draft }).then(
      (state) => {
        if (!request.isCurrent()) return
        setBusy(false)
        setRevision(state.revision)
        setDraft(state.engines)
        setLoaded(JSON.stringify(state.engines))
        setSaved(JSON.stringify(state.engines))
        setStatus('')
        reportSuccess(
          'child-engines',
          state.effect === 'restart-required' ? fallbackT('ui.settingsSaved') : t('engine.saved'),
          state.effect === 'restart-required'
            ? { kind: 'restart-required', message: fallbackT('ui.restartRequired') }
            : undefined,
        )
      },
      (error: unknown) => {
        if (!request.isCurrent()) return
        setBusy(false)
        setStatus(
          failureCode(error) === 'CONFIG_REVISION_CONFLICT' ? 'engine.conflict' : 'engine.unavailable',
        )
      },
    )
  }
  return (
    <div className="capability-panel" data-testid="child-engines">
      {ENGINES.map((id) => {
        const current = engine(id)
        const protocol = id === 'sdk' ? draft.sdk.protocol : 'sdk'
        const capability = flags(id, protocol)
        const schema = childEngineConfigSchema(id)
        return (
          <SettingsGroup
            key={id}
            role="group"
            data-testid={`child-engine-${id}`}
            aria-labelledby={`child-engine-${id}-title`}
          >
            <SettingsItem
              icon="terminal"
              label={t(`engine.${id}`)}
              labelId={`child-engine-${id}-title`}
              description={
                current.enabled ? (
                  <span translate="no">{[current.command, ...current.args].join(' ')}</span>
                ) : (
                  t('engine.off')
                )
              }
            >
              <SchemaControl
                schema={schema.properties!.enabled!}
                value={current.enabled}
                disabled={!canSave || !ready || busy}
                t={t}
                onChange={(value) => replace(id, { enabled: value === true })}
              />
            </SettingsItem>
            {current.enabled && (
              <div className="capability-engine-fields">
                <SchemaConfigFields
                  schema={{
                    ...schema,
                    required: [],
                    properties: Object.fromEntries(
                      Object.entries(schema.properties ?? {}).filter(([key]) => key !== 'enabled'),
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
                    if (
                      typeof next.command === 'string' &&
                      Array.isArray(next.args) &&
                      Array.isArray(next.allow)
                    )
                      replace(id, {
                        command: next.command,
                        args: next.args,
                        allow: next.allow,
                        ...(id === 'sdk' ? { protocol: next.protocol === 'acp' ? 'acp' : 'sdk' } : {}),
                      })
                  }}
                />
                <p className="capability-engine-flags" data-testid={`child-engine-${id}-capabilities`}>
                  {t('engine.capabilities')}:{' '}
                  {Object.entries(capability)
                    .map(([name, on]) => `${t(`cap.${name}`)}: ${t(on ? 'yes' : 'no')}`)
                    .join(' · ')}
                </p>
              </div>
            )}
          </SettingsGroup>
        )
      })}
      <div className="capability-save">
        {status && (
          <StatusMessage
            kind="error"
            data-testid="child-engine-status"
            action={{ label: t('engine.save'), onSelect: save, busy }}
          >
            {t(status)}
          </StatusMessage>
        )}
        <Button
          appearance="primary"
          data-testid="child-engine-save"
          disabled={!canSave || !ready || busy || !dirty}
          loading={busy}
          onClick={save}
        >
          {t('engine.save')}
        </Button>
      </div>
      <SettingsDetails compact title={t('engine.more')} data-testid="child-engine-more">
        <p>{t('enginesHelp')}</p>
        <p>{t('engine.restart')}</p>
      </SettingsDetails>
      {saved && (
        <SettingsTechnicalDetails title={t('engine.document')}>
          <SettingsCode label={t('engine.document')} data-testid="child-engine-document">
            {saved}
          </SettingsCode>
        </SettingsTechnicalDetails>
      )}
    </div>
  )
}
