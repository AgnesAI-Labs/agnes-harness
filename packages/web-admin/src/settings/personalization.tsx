import type { SystemPromptConfig } from '@agnes/protocol'
import {
  Banner,
  Button,
  createDocumentLocaleSource,
  fallbackT,
  reportSuccess,
  Segmented,
  SettingsBlock,
  SettingsExpand,
  SettingsInput,
  SettingsItem,
  SettingsTextArea,
  UiLocaleProvider,
  type UiLocaleSource,
  useAutosave,
  useSettingsSubpages,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { MemoryPanel } from './memory.js'
import {
  browserPromptApi,
  canEditPrompt,
  PROMPT_NAMESPACE,
  type PromptApi,
  samePromptConfig,
  useCanSave,
  usePromptSnapshot,
  useShown,
  withInstructions,
} from './prompt-config.js'
import { PromptConflictNotice } from './prompt-conflict.js'
import { promptCatalog } from './system-prompt-locale.js'

type Instruction = 'personaPrefix' | 'personaSuffix' | 'replyStyle'
type Style = 'default' | 'concise' | 'detailed' | 'custom'

/** The fixed texts Concise and Detailed write, in either language, so a saved one reads back as its choice. */
const STYLE_TEXTS: Readonly<Record<'concise' | 'detailed', readonly string[]>> = {
  concise: [promptCatalog.en.conciseText ?? '', promptCatalog['zh-CN'].conciseText ?? ''],
  detailed: [promptCatalog.en.detailedText ?? '', promptCatalog['zh-CN'].detailedText ?? ''],
}
export function replyStyleChoice(text: string | undefined): Style {
  if (!text?.trim()) return 'default'
  if (STYLE_TEXTS.concise.includes(text)) return 'concise'
  if (STYLE_TEXTS.detailed.includes(text)) return 'detailed'
  return 'custom'
}

/**
 * Personalization on the General page: what the user wants the agent to do (a borderless text area), the
 * reply style (Default / Concise / Detailed / Custom, all written to the one reply-style field) and the closing
 * instruction in a subpage. Each edit saves itself; only a failure shows, at the group label. While
 * a full replacement prompt is in use, or the connection may not save, everything is read-only.
 */
export function CustomInstructions({
  api = browserPromptApi,
  permission = canEditPrompt,
  eager = false,
  onRunConfiguration,
}: {
  api?: PromptApi
  /** Whether this connection may save; the default asks the daemon the page is served by. */
  permission?: () => Promise<boolean>
  /** Read at once instead of waiting for the group to be on screen. */
  eager?: boolean
  /** Opens the run configuration's full-replacement subpage. */
  onRunConfiguration?: () => void
}) {
  const { t } = useUiText(PROMPT_NAMESPACE, promptCatalog)
  const [ref, shown] = useShown(eager)
  const { snapshot, busy, failed, conflict, save, reload } = usePromptSnapshot(api, shown)
  const canSave = useCanSave(shown, permission)
  const config = useAutosave<SystemPromptConfig>({
    stored: snapshot?.config,
    onSaved: () => reportSuccess('personalization', fallbackT('ui.settingsSaved')),
    // Only the instructions are written, onto the latest configuration; a replacement stored meanwhile
    // refuses the save and keeps the draft.
    save: (next) => save((latest) => withInstructions(latest, next), false),
    equal: samePromptConfig,
  })
  const [customOpen, setCustomOpen] = useState(false)
  const value = config.value ?? {}
  const replaced = !!snapshot?.config.fullOverride
  const locked = !canSave || replaced || !snapshot
  const edit = (name: Instruction, text: string, when: 'now' | 'idle') => {
    const next = { ...value }
    if (text) next[name] = text
    else delete next[name]
    config.set(next, when)
  }
  const style = customOpen ? 'custom' : replyStyleChoice(value.replyStyle)
  const suffix = value.personaSuffix?.trim()
  const subpages = useSettingsSubpages()
  const [closingOpen, setClosingOpen] = useState(false)
  // An old deep link still names the closing-instructions subpage; show the row in place instead.
  useEffect(() => {
    if (!subpages.stack.includes('closing-instructions')) return
    subpages.back()
    setClosingOpen(true)
  }, [subpages.stack, subpages.back])
  return (
    <div ref={ref} id="settings-subsection-custom-instructions" tabIndex={-1}>
      {replaced && (
        <Banner
          tone="info"
          action={
            onRunConfiguration && (
              <Button size="small" data-testid="custom-instructions-run-config" onClick={onRunConfiguration}>
                {t('openRunConfig')}
              </Button>
            )
          }
        >
          {t('replaced')}
        </Banner>
      )}
      {conflict && <PromptConflictNotice current={conflict} reload={reload} />}
      <SettingsBlock
        label={t('personalization')}
        data-testid="custom-instructions"
        aria-busy={busy || config.busy}
        failed={config.failed}
        onRetry={config.retry}
        state={failed && !snapshot ? 'error' : busy && !snapshot ? 'loading' : undefined}
        onReload={reload}
      >
        <SettingsTextArea
          presentation="plain"
          className="agnes-settings-bare"
          id="custom-instructions-how"
          data-testid="system-prompt-personaPrefix"
          aria-label={t('how')}
          rows={4}
          maxLength={8192}
          placeholder={t('howPlaceholder')}
          value={value.personaPrefix ?? ''}
          disabled={locked}
          onChange={(event) => edit('personaPrefix', event.currentTarget.value, 'idle')}
          onBlur={config.flush}
        />
        <SettingsItem label={t('style')}>
          <Segmented<Style>
            label={t('style')}
            testId="system-prompt-replyStyle-choice"
            value={style}
            disabled={locked}
            options={[
              { value: 'default', label: t('styleDefault') },
              { value: 'concise', label: t('styleConcise') },
              { value: 'detailed', label: t('styleDetailed') },
              { value: 'custom', label: t('styleCustom') },
            ]}
            onChange={(next) => {
              setCustomOpen(next === 'custom')
              if (next === 'default') edit('replyStyle', '', 'now')
              else if (next === 'concise' || next === 'detailed') edit('replyStyle', t(`${next}Text`), 'now')
              else if (replyStyleChoice(value.replyStyle) !== 'custom') edit('replyStyle', '', 'now')
            }}
          />
        </SettingsItem>
        {style === 'custom' && (
          <SettingsItem label={t('styleCustomLabel')}>
            <SettingsInput
              id="custom-instructions-style"
              data-testid="system-prompt-replyStyle"
              aria-label={t('styleCustomLabel')}
              maxLength={8192}
              placeholder={t('stylePlaceholder')}
              value={value.replyStyle ?? ''}
              disabled={locked}
              onChange={(event) => edit('replyStyle', event.currentTarget.value, 'idle')}
              onBlur={config.flush}
            />
          </SettingsItem>
        )}
        <SettingsExpand
          id="settings-subsection-closing-instructions"
          data-settings-expand
          data-testid="custom-instructions-closing"
          label={t('suffix')}
          hint={t('suffixHelp')}
          value={suffix ? <span className="agnes-settings-value-text">{suffix}</span> : t('notSet')}
          open={closingOpen}
          onOpenChange={setClosingOpen}
        >
          <SettingsTextArea
            id="custom-instructions-closing"
            data-testid="system-prompt-personaSuffix"
            aria-label={t('suffix')}
            rows={6}
            maxLength={8192}
            placeholder={t('suffixPlaceholder')}
            value={value.personaSuffix ?? ''}
            disabled={locked}
            onChange={(event) => edit('personaSuffix', event.currentTarget.value, 'idle')}
            onBlur={config.flush}
          />
        </SettingsExpand>
      </SettingsBlock>
      {snapshot && !canSave && !replaced && <p className="agnes-settings-note">{t('readOnly')}</p>}
    </div>
  )
}

/**
 * Personalization and Memory on the General page. Neither is behind the advanced switch; memory is read only
 * once the page is on screen.
 */
export function Personalization({
  api = browserPromptApi,
  permission = canEditPrompt,
  onRunConfiguration,
}: {
  api?: PromptApi
  permission?: () => Promise<boolean>
  onRunConfiguration?: () => void
}) {
  const [ref, shown] = useShown(false)
  const canSave = useCanSave(shown, permission)
  return (
    <div
      id="settings-subsection-personalization"
      tabIndex={-1}
      className="agnes-settings-personalization"
      data-testid="settings-personalization"
    >
      <CustomInstructions
        api={api}
        permission={permission}
        {...(onRunConfiguration ? { onRunConfiguration } : {})}
      />
      <div ref={ref} id="settings-subsection-memory" tabIndex={-1} data-testid="personalization-memory">
        {shown && <MemoryPanel canSave={canSave} />}
      </div>
    </div>
  )
}

let documentLocale: UiLocaleSource | undefined

/** What the settings dialog adds to its General page, with the language the document is in. */
export function SettingsGeneralExtras() {
  documentLocale ??= createDocumentLocaleSource({}).source
  return (
    <UiLocaleProvider source={documentLocale}>
      <Personalization
        onRunConfiguration={() =>
          document
            .getElementById('config-form')
            ?.dispatchEvent(
              new CustomEvent('agnes:settings-route', { detail: 'system-prompt', bubbles: true }),
            )
        }
      />
    </UiLocaleProvider>
  )
}
