import type { SystemPromptSnapshot } from '@agnes/protocol'
import { Banner, Button, SettingsBlock, SettingsCode, SettingsItem, useUiText } from '@agnes/web-ui'
import { PROMPT_NAMESPACE } from './prompt-config.js'
import { promptCatalog } from './system-prompt-locale.js'

/** A failed conditional save keeps the editor's draft alongside the value actually saved. */
export function PromptConflictNotice({ current, reload }: { current: SystemPromptSnapshot; reload(): void }) {
  const { t } = useUiText(PROMPT_NAMESPACE, promptCatalog)
  const fields = [
    ['fullOverride', 'override'],
    ['personaPrefix', 'how'],
    ['replyStyle', 'style'],
    ['personaSuffix', 'suffix'],
  ] as const
  return (
    <div className="agnes-settings-stack">
      <Banner
        tone="warning"
        role="alert"
        data-testid="system-prompt-conflict"
        action={
          <Button size="small" data-testid="system-prompt-conflict-reload" onClick={reload}>
            {t('reloadSaved')}
          </Button>
        }
      >
        {t('revisionConflict')}
      </Banner>
      <SettingsBlock label={t('savedValue')} data-testid="system-prompt-conflict-saved">
        {fields.map(([key, label]) =>
          current.config[key] ? (
            <SettingsItem key={key} label={t(label)} stacked>
              <SettingsCode label={t(label)}>{current.config[key]}</SettingsCode>
            </SettingsItem>
          ) : null,
        )}
        {!fields.some(([key]) => current.config[key]) && <p>{t('noCustomPrompt')}</p>}
      </SettingsBlock>
    </div>
  )
}
