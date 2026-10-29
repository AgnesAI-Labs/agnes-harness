import {
  appServerErrorMessage,
  Banner,
  fallbackT,
  IconButton,
  minutePresets,
  reportSuccess,
  Select,
  SettingsBlock,
  SettingsChips,
  SettingsCode,
  SettingsDrill,
  SettingsExpand,
  SettingsItem,
  SettingsPresetSelect,
  StateSwitch,
  trackPageRequest,
  useAutosave,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { captureRequest } from './async-request.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from './locales.js'

type Config = {
  rulesEnabled: boolean
  timeEnabled: boolean
  timeZone: string
  customSkillRoots: string[]
  refreshIntervalMs: number
  maxBytes: number
  maxSourceBytes: number
  instructionFiles: string[]
  localInstructionFiles: string[]
}
type Snapshot = {
  config: Config
  workspaces: { path: string; available: boolean }[]
  rules?: { files: { path: string; scope: string; content: string; trust: string }[]; skipped: string[] }
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
function validSnapshot(value: unknown): value is Snapshot {
  const snapshot = object(value)
  const config = object(snapshot?.config)
  if (
    !config ||
    typeof config.rulesEnabled !== 'boolean' ||
    typeof config.timeEnabled !== 'boolean' ||
    typeof config.timeZone !== 'string' ||
    !['refreshIntervalMs', 'maxBytes', 'maxSourceBytes'].every(
      (key) => typeof config[key] === 'number' && Number.isFinite(config[key]),
    ) ||
    !['customSkillRoots', 'instructionFiles', 'localInstructionFiles'].every((key) => strings(config[key])) ||
    !Array.isArray(snapshot?.workspaces) ||
    !snapshot.workspaces.every((entry) => {
      const workspace = object(entry)
      return typeof workspace?.path === 'string' && typeof workspace.available === 'boolean'
    })
  )
    return false
  if (snapshot.rules === undefined) return true
  const rules = object(snapshot.rules)
  return (
    !!rules &&
    strings(rules.skipped) &&
    Array.isArray(rules.files) &&
    rules.files.every((entry) => {
      const file = object(entry)
      return !!file && ['path', 'scope', 'content', 'trust'].every((key) => typeof file[key] === 'string')
    })
  )
}
export async function contextRequest(
  input: { cwd?: string; config?: Config },
  fetcher = fetch,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const response = await fetcher('/api/context', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined
    throw Object.assign(new Error('context unavailable'), { envelope: body?.error })
  }
  const value: unknown = await response.json()
  if (!validSnapshot(value)) throw new Error('invalid context response')
  return value
}
const REFRESH_MINUTES = [1, 5, 10, 30] as const

/** Every IANA zone the browser knows, with the configured one kept even when it is not listed. */
function timeZones(current: string): string[] {
  const listed = (() => {
    try {
      return (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
    } catch {
      return []
    }
  })()
  return [...new Set([current, ...listed].filter(Boolean))]
}

const sameConfig = (a: Config, b: Config) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Context in Runtime configuration: project rules and the current time as switches, the time zone as a searchable
 * list with the computer's own zone marked Auto, the refresh as presets (Custom keeps any other
 * value), and the skill folders as chips. Each change saves itself. The rule files a workspace
 * loads are a subpage.
 */
export function ContextPanel({ canSave }: { canSave: boolean }) {
  // Permission changes start a new autosave owner as well as a new read lifetime.
  return <ContextSettings key={String(canSave)} canSave={canSave} />
}

function ContextSettings({ canSave }: { canSave: boolean }) {
  const { t } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [rulesError, setRulesError] = useState<unknown>(false)
  const [reads, setReads] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads is an explicit retry.
  useEffect(() => {
    let current = true
    const abort = new AbortController()
    lifetime.current = abort
    setBusy(true)
    setReadFailed(false)
    void trackPageRequest(contextRequest({}, fetch, abort.signal))
      .then((value) => {
        if (current) setSnapshot(value)
      })
      .catch(() => {
        if (current) setReadFailed(true)
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
      abort.abort()
    }
  }, [reads, canSave])
  const config = useAutosave<Config>({
    resourceKey: 'settings:context',
    onSaved: () => reportSuccess('settings:context', fallbackT('ui.settingsSaved')),
    stored: snapshot?.config,
    equal: sameConfig,
    save: async (next) => {
      const request = captureRequest(lifetime)
      if (!request.isCurrent()) return
      const value = await contextRequest({ ...(cwd ? { cwd } : {}), config: next }, fetch, request.signal)
      if (request.isCurrent()) setSnapshot(value)
    },
  })
  async function readRules(workspace: string) {
    if (busy) return
    const request = captureRequest(lifetime)
    setBusy(true)
    setRulesError(false)
    try {
      const value = await contextRequest({ cwd: workspace }, fetch, request.signal)
      if (request.isCurrent()) setSnapshot(value)
    } catch (error) {
      if (request.isCurrent()) setRulesError((error as { envelope?: unknown })?.envelope ?? true)
    } finally {
      if (request.isCurrent()) setBusy(false)
    }
  }
  const value = config.value
  const locked = !canSave || !value
  const workspaces = snapshot?.workspaces.filter((entry) => entry.available) ?? []
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const zoneLabel = (zone: string) => (zone === localZone ? `${zone}${t('contextAuto')}` : zone)
  const minutes = (count: number) => t('contextMinutes', { count })
  const edit = (next: Partial<Config>) => value && config.set({ ...value, ...next })
  return (
    <SettingsBlock
      label={t('context')}
      data-testid="context-panel"
      aria-busy={busy || config.busy}
      failed={config.failed}
      onRetry={config.retry}
      state={readFailed ? 'error' : busy && !snapshot ? 'loading' : undefined}
      onReload={() => setReads((count) => count + 1)}
    >
      {value && (
        <>
          <SettingsItem
            label={t('contextRules')}
            description={t('contextRulesHint')}
            info={t('contextScopeHelp')}
          >
            <StateSwitch
              id="context-rules-enabled"
              testId="context-rules-enabled"
              label={t('contextRules')}
              disabled={locked}
              checked={value.rulesEnabled}
              onToggle={(checked) => edit({ rulesEnabled: checked })}
            />
          </SettingsItem>
          <SettingsItem label={t('contextTime')} info={t('contextTimeHint')}>
            <StateSwitch
              id="context-time-enabled"
              testId="context-time-enabled"
              label={t('contextTime')}
              disabled={locked}
              checked={value.timeEnabled}
              onToggle={(checked) => edit({ timeEnabled: checked })}
            />
          </SettingsItem>
          <SettingsItem label={t('contextZone')}>
            <Select<string>
              id="context-zone"
              data-testid="context-zone"
              aria-label={t('contextZone')}
              showSearch
              disabled={locked || !value.timeEnabled}
              value={value.timeZone}
              popupMatchSelectWidth={false}
              onChange={(zone) => edit({ timeZone: zone })}
              options={timeZones(value.timeZone).map((zone) => ({ value: zone, label: zoneLabel(zone) }))}
            />
          </SettingsItem>
          <SettingsItem label={t('contextInterval')}>
            <SettingsPresetSelect
              id="context-interval"
              data-testid="context-interval"
              label={t('contextInterval')}
              allowDefault={false}
              disabled={locked || !value.timeEnabled}
              value={value.refreshIntervalMs}
              presets={[
                { value: 0, label: t('contextEveryRequest') },
                ...minutePresets(REFRESH_MINUTES, minutes),
              ]}
              unit={t('contextMinuteUnit')}
              scale={60_000}
              onChange={(next) => next !== undefined && edit({ refreshIntervalMs: next })}
            />
          </SettingsItem>
          <SettingsItem label={t('contextRoots')} info={t('contextRootsHint')}>
            <SettingsChips
              data-testid="context-skill-roots"
              label={t('contextRoots')}
              placeholder={t('contextRootsAdd')}
              disabled={locked}
              values={value.customSkillRoots}
              onChange={(next) => edit({ customSkillRoots: next })}
            />
          </SettingsItem>
        </>
      )}
      {snapshot && (
        <SettingsDrill
          id="context-rules"
          data-testid="context-rules-view"
          label={t('contextLoaded')}
          description={t('contextScopeHelp')}
          actions={
            <IconButton
              name="refresh-cw"
              label={t('contextRefresh')}
              data-testid="context-refresh"
              disabled={busy || !cwd}
              onClick={() => void readRules(cwd)}
            />
          }
        >
          {Boolean(rulesError) && (
            <Banner tone="error" role="alert">
              {appServerErrorMessage(rulesError, document.documentElement.lang) ?? t('contextFailed')}
            </Banner>
          )}
          <SettingsBlock>
            <SettingsItem label={t('contextChoose')}>
              <Select<string>
                id="context-workspace"
                data-testid="context-workspace"
                aria-label={t('contextChoose')}
                disabled={busy || !workspaces.length}
                value={cwd || null}
                placeholder={workspaces.length ? t('contextChoose') : t('contextNoWorkspace')}
                popupMatchSelectWidth={false}
                onChange={(next) => {
                  setCwd(next)
                  void readRules(next)
                }}
                options={workspaces.map((entry) => ({ value: entry.path, label: entry.path }))}
              />
            </SettingsItem>
          </SettingsBlock>
          {snapshot.rules && (
            <SettingsBlock data-testid="context-rule-files">
              {!snapshot.rules.files.length && <SettingsItem label={t('contextNoRules')} />}
              {snapshot.rules.files.map((file) => (
                <SettingsExpand
                  key={file.path}
                  label={<span translate="no">{file.path}</span>}
                  value={`${file.scope} · ${file.trust}`}
                >
                  <SettingsCode label={file.path} copy={file.content}>
                    {file.content}
                  </SettingsCode>
                </SettingsExpand>
              ))}
            </SettingsBlock>
          )}
          {!!snapshot.rules?.skipped.length && (
            <p className="agnes-settings-note">
              {t('contextSkipped')}: {snapshot.rules.skipped.join(', ')}
            </p>
          )}
        </SettingsDrill>
      )}
    </SettingsBlock>
  )
}
