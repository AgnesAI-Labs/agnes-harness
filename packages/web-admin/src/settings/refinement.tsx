import type {
  RefinementModelOption,
  RefinementModelsResult,
  RefinementSettings,
  RefinementSettingsSaveResult,
  RefinementSettingsSnapshot,
} from '@agnes/protocol'
import { CREDENTIALS_CHANGED } from '@agnes/resource-control-web/credentials-api'
import { settingsSections } from '@agnes/web-client'
import {
  Banner,
  Button,
  fallbackT,
  reportSuccess,
  SettingsBlock,
  SettingsInput,
  SettingsItem,
  SettingsSelect,
  StateSwitch,
  useAutosave,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { REFINEMENT_SETTINGS_NAMESPACE, refinementSettingsCatalog } from './refinement-locale.js'
import { type SavedSkillsApi, SavedSkillsBlock } from './refinement-skills.js'
import { failureCode } from './side-models/model.js'

/** The daemon's refinement switch: read it with its revision, save it against that revision. */
export type RefinementSettingsApi = {
  createKey(label: string, value: string): Promise<string>
  read(): Promise<RefinementSettingsSnapshot>
  models(): Promise<RefinementModelsResult>
  save(settings: RefinementSettings, expectedRevision: string): Promise<RefinementSettingsSaveResult>
  /** The skills task experience saved in a workspace; absent where the connection cannot reach them. */
  savedSkills?: SavedSkillsApi
}

const sameSettings = (a: RefinementSettings, b: RefinementSettings) =>
  a.enabled === b.enabled &&
  a.mode === b.mode &&
  a.credentialRef === b.credentialRef &&
  a.model === b.model &&
  a.baseUrl === b.baseUrl

/** This viewer has dismissed the one-time notice about saving to the workspace (browser storage only). */
const NOTICE_KEY = 'agnes.refinement.workspace-notice'
const noticeDismissed = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(NOTICE_KEY) === 'dismissed'
  } catch {
    return false
  }
}
const dismissNotice = (): void => {
  try {
    globalThis.localStorage?.setItem(NOTICE_KEY, 'dismissed')
  } catch {
    // Without browser storage the notice only stays closed for this visit.
  }
}
/**
 * The experience-refinement section: the master switch (off by default), how reviews start, what
 * turning it on allows and what to expect. Every change saves itself against the revision last read;
 * a conflicting save reloads the section.
 */
export function RefinementSettingsPanel({ api }: { api: RefinementSettingsApi }) {
  const { t } = useUiText(REFINEMENT_SETTINGS_NAMESPACE, refinementSettingsCatalog)
  const [snapshot, setSnapshot] = useState<RefinementSettingsSnapshot>()
  const [failed, setFailed] = useState(false)
  const [reads, setReads] = useState(0)
  const [conflict, setConflict] = useState(false)
  const [generation, setGeneration] = useState(0)
  // Shown once, to a profile that had refinement on when this section was first read: saving to the
  // workspace now takes effect without asking again. Turning it on here shows the grants instead.
  const [notice, setNotice] = useState<boolean>()
  useEffect(() => {
    const refresh = () => setReads((count) => count + 1)
    window.addEventListener(CREDENTIALS_CHANGED, refresh)
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener(CREDENTIALS_CHANGED, refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads is an explicit retry.
  useEffect(() => {
    let live = true
    setFailed(false)
    void api.read().then(
      (value) => {
        if (!live) return
        setSnapshot(value)
        setNotice((shown) => shown ?? (value.settings.enabled && !noticeDismissed()))
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [api, reads])
  if (!snapshot || failed)
    return (
      <div className="refinement-settings" data-testid="refinement-settings">
        <SettingsBlock state={failed ? 'error' : 'loading'} onReload={() => setReads((count) => count + 1)} />
      </div>
    )
  return (
    <div className="refinement-settings" data-testid="refinement-settings">
      {notice && (
        <Banner
          tone="info"
          data-testid="refinement-workspace-notice"
          dismissLabel={t('refinement.notice.dismiss')}
          onDismiss={() => {
            dismissNotice()
            setNotice(false)
          }}
        >
          {t('refinement.notice')}
        </Banner>
      )}
      {conflict && (
        <Banner tone="warning" data-testid="refinement-conflict">
          {t('refinement.conflict')}
        </Banner>
      )}
      <RefinementFields
        key={`${generation}-${snapshot.revision}-${Boolean(snapshot.credentialMissing)}`}
        api={api}
        snapshot={snapshot}
        t={t}
        onSaved={() => setConflict(false)}
        onConflict={(fresh) => {
          setSnapshot(fresh)
          setGeneration((count) => count + 1)
          setConflict(true)
        }}
      />
      {api.savedSkills && <SavedSkillsBlock api={api.savedSkills} />}
    </div>
  )
}

type Text = (key: string, vars?: Record<string, string | number>) => string

const modelFailureText = {
  REFINEMENT_KEY_INVALID: 'refinement.model.invalidKey',
  REFINEMENT_KEY_MISSING: 'refinement.key.missing',
  REFINEMENT_MODEL_UNAVAILABLE: 'refinement.model.unavailable',
  REFINEMENT_MODELS_UNAVAILABLE: 'refinement.model.error',
} as const

type ModelCatalogue = { ref: string; baseUrl: string | undefined } & (
  | { models: RefinementModelOption[] }
  | { error: string }
)

function modelFailure(error: unknown): string | undefined {
  const code = failureCode(error)
  return code && Object.hasOwn(modelFailureText, code)
    ? modelFailureText[code as keyof typeof modelFailureText]
    : undefined
}

function RefinementFields(props: {
  api: RefinementSettingsApi
  snapshot: RefinementSettingsSnapshot
  t: Text
  onSaved(): void
  onConflict(fresh: RefinementSettingsSnapshot): void
}) {
  const { api, snapshot, t } = props
  const [stored, setStored] = useState(snapshot.settings)
  const [keyInput, setKeyInput] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  const [creatingKey, setCreatingKey] = useState(false)
  const [keyError, setKeyError] = useState(false)
  const [missing, setMissing] = useState(snapshot.credentialMissing === true)
  const credentialRef = missing ? undefined : stored.credentialRef
  const { baseUrl } = stored
  const endpoints = snapshot.endpoints ?? []
  const [catalogue, setCatalogue] = useState<ModelCatalogue>()
  const [modelReads, setModelReads] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: modelReads retries; a fresh snapshot rechecks credential changes.
  useEffect(() => {
    if (!credentialRef) return
    let live = true
    setCatalogue(undefined)
    void api.models().then(
      ({ models }) => {
        if (live) setCatalogue({ ref: credentialRef, baseUrl, models })
      },
      (error) => {
        if (live)
          setCatalogue({
            ref: credentialRef,
            baseUrl,
            error: modelFailure(error) ?? 'refinement.model.error',
          })
      },
    )
    return () => {
      live = false
    }
  }, [api, credentialRef, baseUrl, modelReads, snapshot])
  // Read when a save is sent, so a save queued behind another one uses the revision the first returned.
  const revision = useRef(snapshot.revision)
  const autosave = useAutosave<RefinementSettings>({
    stored,
    equal: sameSettings,
    onSaved: () => {
      props.onSaved()
      reportSuccess('settings:refinement', fallbackT('ui.settingsSaved'))
    },
    save: async (next) => {
      try {
        const saved = await api.save(next, revision.current)
        revision.current = saved.revision
        setStored(next)
        if (next.credentialRef !== stored.credentialRef) setMissing(false)
      } catch (error) {
        // The conflict error names no current state: read it again and show it. The edit that lost is
        // dropped, and the save ends as a failure, not a success: a success would clear the banner
        // just raised and say "Settings saved." about a change that was thrown away.
        if (failureCode(error) === 'CONFIG_INVALID_INPUT') {
          const fresh = await api.read()
          if (fresh.credentialMissing) props.onConflict(fresh)
          throw error
        }
        const feedback = modelFailure(error)
        if (feedback && credentialRef) setCatalogue({ ref: credentialRef, baseUrl, error: feedback })
        if (failureCode(error) !== 'CONFIG_REVISION_CONFLICT') throw error
        props.onConflict(await api.read())
        throw error
      }
    },
  })
  const settings = autosave.value ?? stored
  const binding = settings.credentialRef !== stored.credentialRef
  const locked = creatingKey || binding
  const result = catalogue?.ref === credentialRef && catalogue?.baseUrl === baseUrl ? catalogue : undefined
  const models = result && 'models' in result ? result.models : undefined
  const modelError = result && 'error' in result ? result.error : undefined
  const canEnable = models?.some(({ id }) => id === stored.model) === true
  const firstModel = models?.[0]?.id
  const { set: saveSettings, busy, failed } = autosave
  useEffect(() => {
    if (firstModel && !canEnable && !locked && !busy && !failed)
      saveSettings({ ...stored, model: firstModel }, 'now')
  }, [firstModel, canEnable, locked, busy, failed, stored, saveSettings])
  const modelStatus = !credentialRef
    ? 'refinement.model.needsKey'
    : (modelError ??
      (models
        ? firstModel
          ? 'refinement.model.hint'
          : 'refinement.model.empty'
        : 'refinement.model.loading'))
  const change = (patch: Partial<Pick<RefinementSettings, 'enabled' | 'mode' | 'model'>>) => {
    if (!credentialRef || locked || busy) return
    const { enabled = stored.enabled, mode = stored.mode, model = stored.model } = patch
    if (enabled) {
      if (model) saveSettings({ ...stored, enabled, mode, credentialRef, model }, 'now')
    } else {
      saveSettings({ ...stored, enabled, mode, credentialRef, ...(model ? { model } : {}) }, 'now')
    }
  }
  const saveKey = async () => {
    if (!keyInput.trim() || locked || autosave.busy) return
    setCreatingKey(true)
    setKeyError(false)
    try {
      const credentialRef = await api.createKey(t('refinement.key.label'), keyInput.trim())
      setKeyInput('')
      setEditingKey(false)
      // Verify the new binding before learning can be turned back on.
      saveSettings({ ...stored, enabled: false, credentialRef }, 'now')
    } catch {
      setKeyError(true)
    } finally {
      setCreatingKey(false)
    }
  }
  return (
    <>
      <SettingsBlock
        label={t('refinement.group.main')}
        aria-busy={autosave.busy}
        failed={autosave.failed}
        onRetry={autosave.retry}
      >
        {endpoints.length > 0 && (
          <SettingsItem label={t('refinement.endpoint')} description={t('refinement.endpoint.hint')}>
            <SettingsSelect
              id="refinement-endpoint"
              data-testid="refinement-endpoint"
              aria-label={t('refinement.endpoint')}
              value={settings.baseUrl ?? endpoints[0]}
              disabled={locked || busy || endpoints.length === 1}
              onChange={(event) => {
                const next = event.target.value
                if (!locked && !busy && endpoints.includes(next))
                  saveSettings(
                    next === baseUrl ? stored : { ...stored, baseUrl: next, enabled: false },
                    'now',
                  )
              }}
            >
              {endpoints.map((url) => (
                <option key={url} value={url}>
                  {url}
                </option>
              ))}
            </SettingsSelect>
          </SettingsItem>
        )}
        <SettingsItem
          label={t('refinement.key')}
          description={t(
            missing
              ? 'refinement.key.missing'
              : credentialRef
                ? 'refinement.key.ready'
                : 'refinement.key.hint',
          )}
        >
          {credentialRef && !editingKey ? (
            <Button disabled={locked || autosave.busy} onClick={() => setEditingKey(true)}>
              {t('refinement.key.replace')}
            </Button>
          ) : (
            <>
              <SettingsInput
                id="refinement-service-key"
                type="password"
                aria-label={t('refinement.key')}
                autoComplete="new-password"
                spellCheck={false}
                value={keyInput}
                disabled={locked}
                onChange={(event) => setKeyInput(event.target.value)}
              />
              <Button disabled={locked || autosave.busy || !keyInput.trim()} onClick={() => void saveKey()}>
                {t('refinement.key.save')}
              </Button>
            </>
          )}
        </SettingsItem>
        {keyError && <Banner tone="error">{t('refinement.key.error')}</Banner>}
        <SettingsItem label={t('refinement.model')} description={t(modelStatus)}>
          <SettingsSelect
            id="refinement-model"
            data-testid="refinement-model"
            aria-label={t('refinement.model')}
            value={models?.some(({ id }) => id === settings.model) ? settings.model : ''}
            disabled={!firstModel || locked || busy}
            onChange={(event) => change({ model: event.target.value })}
          >
            <option value="" disabled>
              {t('refinement.model.placeholder')}
            </option>
            {models?.map(({ id, name }) => (
              <option key={id} value={id}>
                {name === id ? id : `${name} (${id})`}
              </option>
            ))}
          </SettingsSelect>
          {(modelError || models?.length === 0) && (
            <Button disabled={locked || busy} onClick={() => setModelReads((count) => count + 1)}>
              {t('refinement.model.retry')}
            </Button>
          )}
        </SettingsItem>
        <SettingsItem
          label={t('refinement.enabled')}
          description={t('refinement.enabled.hint')}
          info={t('refinement.enabled.info')}
        >
          <StateSwitch
            id="refinement-enabled"
            testId="refinement-enabled"
            label={t('refinement.enabled')}
            checked={stored.enabled}
            disabled={locked || busy || (!stored.enabled && !canEnable)}
            onToggle={(enabled) => {
              if (!enabled || canEnable) change({ enabled })
            }}
          />
        </SettingsItem>
        <SettingsItem label={t('refinement.mode')} description={t('refinement.mode.hint')}>
          <SettingsSelect
            id="refinement-mode"
            data-testid="refinement-mode"
            aria-label={t('refinement.mode')}
            disabled={!stored.enabled || locked || busy}
            value={settings.mode}
            onChange={(event) => change({ mode: event.target.value === 'auto' ? 'auto' : 'manual' })}
          >
            <option value="manual">{t('refinement.mode.manual')}</option>
            <option value="auto">{t('refinement.mode.auto')}</option>
          </SettingsSelect>
        </SettingsItem>
      </SettingsBlock>
      <SettingsBlock label={t('refinement.group.allows')} data-testid="refinement-permissions">
        {(['install', 'skill', 'memory', 'user'] as const).map((name) => (
          <SettingsItem
            key={name}
            data-testid={`refinement-allows-${name}`}
            label={t(`refinement.allows.${name}`)}
            description={t(`refinement.allows.${name}.hint`)}
          />
        ))}
        <SettingsItem
          data-testid="refinement-allows-undo"
          label={t('refinement.allows.undo')}
          description={t('refinement.allows.undo.hint')}
        />
      </SettingsBlock>
      <SettingsBlock label={t('refinement.group.notes')}>
        <SettingsItem
          data-testid="refinement-approvals"
          label={t('refinement.approvals')}
          description={t('refinement.approvals.hint')}
        />
        <SettingsItem
          data-testid="refinement-cost"
          label={t('refinement.cost')}
          description={t('refinement.cost.hint')}
        />
      </SettingsBlock>
    </>
  )
}

/** Installed with the web client, which owns the settings calls; the section needs no runtime catalog. */
export function registerRefinementSettingsSection(api: RefinementSettingsApi): () => void {
  return settingsSections.register({
    id: 'refinement',
    group: 'general',
    order: 21,
    icon: 'sparkles',
    runtimeCatalog: false,
    titleKey: 'settings-shell.refinement',
    groupTitleKey: 'settings-shell.group.general',
    component: () => <RefinementSettingsPanel api={api} />,
  })
}
