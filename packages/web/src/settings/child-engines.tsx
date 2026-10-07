import {
  CHILD_ENGINE_CAPABILITIES,
  type ChildEngineSettings,
  childEngineSettingsError,
  DISABLED_CHILD_ENGINES,
  parseChildEngineSettings,
} from '@agnes/base/child-engines'
import { Button } from '@agnes/web-ui'
import { useState } from 'react'

const STORAGE_KEY = 'agnes.child-engines'
type Text = (key: string) => string
type EngineId = 'codex' | 'claude-code' | 'sdk'
const ENGINES: readonly EngineId[] = ['codex', 'claude-code', 'sdk']

function load(): ChildEngineSettings {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw
      ? parseChildEngineSettings(JSON.parse(raw) as unknown)
      : structuredClone(DISABLED_CHILD_ENGINES)
  } catch {
    return structuredClone(DISABLED_CHILD_ENGINES)
  }
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

export function ChildEnginesPanel({ canSave, t }: { canSave: boolean; t: Text }) {
  const [draft, setDraft] = useState<ChildEngineSettings>(load)
  const [status, setStatus] = useState('')
  const [saved, setSaved] = useState('')
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
    <div data-testid="child-engines">
      <p>{t('enginesHelp')}</p>
      {ENGINES.map((id) => {
        const current = engine(id)
        const protocol = id === 'sdk' ? draft.sdk.protocol : 'sdk'
        const capability = flags(id, protocol)
        return (
          <article
            key={id}
            className="runtime-card"
            data-testid={`child-engine-${id}`}
            aria-labelledby={`child-engine-${id}-title`}
          >
            <h3 id={`child-engine-${id}-title`}>{t(`engine.${id}`)}</h3>
            <label>
              <input
                type="checkbox"
                data-testid={`child-engine-${id}-enabled`}
                checked={current.enabled}
                disabled={!canSave}
                onChange={(event) => replace(id, { enabled: event.target.checked })}
              />{' '}
              {t('engine.enabled')}
            </label>
            <label>
              {t('engine.command')}
              <input
                data-testid={`child-engine-${id}-command`}
                aria-label={`${t(`engine.${id}`)} ${t('engine.command')}`}
                value={current.command}
                disabled={!canSave}
                onChange={(event) => replace(id, { command: event.target.value })}
              />
            </label>
            <label>
              {t('engine.args')}
              <textarea
                data-testid={`child-engine-${id}-args`}
                aria-label={`${t(`engine.${id}`)} ${t('engine.args')}`}
                value={current.args.join('\n')}
                disabled={!canSave}
                onChange={(event) => replace(id, { args: lines(event.target.value) })}
              />
            </label>
            <label>
              {t('engine.allow')}
              <textarea
                data-testid={`child-engine-${id}-allow`}
                aria-label={`${t(`engine.${id}`)} ${t('engine.allow')}`}
                value={current.allow.join('\n')}
                disabled={!canSave}
                onChange={(event) => replace(id, { allow: lines(event.target.value) })}
              />
            </label>
            {id === 'sdk' && (
              <label>
                {t('engine.protocol')}
                <select
                  data-testid="child-engine-sdk-protocol"
                  aria-label={t('engine.protocol')}
                  value={draft.sdk.protocol}
                  disabled={!canSave}
                  onChange={(event) =>
                    replace('sdk', { protocol: event.target.value === 'acp' ? 'acp' : 'sdk' })
                  }
                >
                  <option value="sdk">SDK</option>
                  <option value="acp">ACP</option>
                </select>
              </label>
            )}
            <h4>{t('engine.capabilities')}</h4>
            <ul data-testid={`child-engine-${id}-capabilities`}>
              {Object.entries(capability).map(([name, on]) => (
                <li key={name}>
                  {t(`cap.${name}`)}: {t(on ? 'yes' : 'no')}
                </li>
              ))}
            </ul>
          </article>
        )
      })}
      <p>{t('engine.restart')}</p>
      {status && (
        <p role={status === 'engine.saved' ? 'status' : 'alert'} data-testid="child-engine-status">
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
        disabled={!canSave}
        onClick={() => {
          const error = childEngineSettingsError(draft)
          if (error) {
            setStatus(error === 'allow' ? 'engine.allowRequired' : 'engine.commandRequired')
            return
          }
          const document = JSON.stringify(draft)
          sessionStorage.setItem(STORAGE_KEY, document)
          setSaved(document)
          setStatus('engine.saved')
        }}
      >
        {t('engine.save')}
      </Button>
    </div>
  )
}
