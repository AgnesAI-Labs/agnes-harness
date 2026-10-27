import type { VoiceComposer, VoicePort, VoiceUnavailable } from '@agnes/web-client'
import { Button, Icon, type IconName, Popover } from '@agnes/web-ui'
import { type ReactElement, useEffect, useSyncExternalStore } from 'react'
import { useVoiceText } from './voice-locale.js'

/** Reasons the side-model settings can fix; the others (page, tab, connection) cannot. */
const CONFIGURABLE = new Set<VoiceUnavailable>(['no-account', 'credential-missing', 'ambiguous', 'no-model'])

function VoiceButton({
  testId,
  icon,
  label,
  level,
  reason,
  inactive = false,
  pressed,
  onClick,
  onConfigure,
}: {
  testId: string
  icon: IconName
  label: string
  level: number
  reason?: VoiceUnavailable | undefined
  /** Not usable right now for a passing reason (the conversation is busy); no explanation needed. */
  inactive?: boolean
  pressed?: boolean
  onClick(): void
  onConfigure(): void
}): ReactElement {
  const t = useVoiceText()
  const blocked = reason !== undefined || inactive
  const button = (
    <Button
      htmlType="button"
      appearance="ghost"
      size="small"
      className="composer-voice-button"
      data-testid={testId}
      data-level={level}
      aria-label={label}
      aria-disabled={blocked || undefined}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      title={reason ? undefined : label}
      icon={<Icon name={icon} size={16} />}
      onClick={() => {
        if (!blocked) onClick()
      }}
    />
  )
  if (!reason) return button
  // A disabled control still explains itself on hover or click, with the way to fix it.
  return (
    <Popover
      trigger={['hover', 'click']}
      placement="top"
      content={
        <span className="voice-reason">
          <span>{t(`voice.reason.${reason}`)}</span>
          {CONFIGURABLE.has(reason) && (
            <Button appearance="link" size="small" data-testid="voice-configure" onClick={onConfigure}>
              {t('voice.configure')}
            </Button>
          )}
        </span>
      }
    >
      {button}
    </Popover>
  )
}

/** The mic (dictation) and wave (voice conversation) buttons beside send, with their status line. */
export function VoiceComposerButtons({
  voice,
  composer,
}: {
  voice: VoicePort
  composer: VoiceComposer
}): ReactElement | null {
  const state = useSyncExternalStore(voice.state.subscribe, voice.state.getSnapshot)
  const t = useVoiceText()
  useEffect(() => voice.bindComposer(composer), [voice, composer])
  const { dictation, conversation, notice } = state
  if (!dictation.visible && !conversation.visible) return null
  const talking = conversation.phase !== 'idle'
  const micIcon: IconName =
    dictation.phase === 'recording' ? 'square' : dictation.phase === 'transcribing' ? 'loader-circle' : 'mic'
  const micLabel =
    dictation.phase === 'recording'
      ? t('voice.micStop')
      : dictation.phase === 'transcribing'
        ? t('voice.phase.transcribing')
        : t('voice.mic')
  const status = talking
    ? t(`voice.phase.${conversation.phase}`)
    : dictation.phase === 'recording'
      ? t('voice.seconds', { seconds: dictation.seconds })
      : dictation.phase === 'transcribing'
        ? t('voice.phase.transcribing')
        : ''
  return (
    <span className="composer-voice">
      {dictation.visible && (
        <VoiceButton
          testId="voice-mic"
          icon={micIcon}
          label={micLabel}
          level={talking ? conversation.level : dictation.level}
          reason={dictation.disabled}
          // In a conversation the mic only interrupts the reading; a transcription is not interrupted.
          inactive={(talking && conversation.phase !== 'reading') || dictation.phase === 'transcribing'}
          onClick={voice.toggleDictation}
          onConfigure={voice.openSettings}
        />
      )}
      {conversation.visible && (
        <VoiceButton
          testId="voice-wave"
          icon="audio-lines"
          label={talking ? t('voice.waveStop') : t('voice.wave')}
          level={conversation.level}
          reason={talking ? undefined : conversation.disabled}
          pressed={talking}
          onClick={voice.toggleConversation}
          onConfigure={voice.openSettings}
        />
      )}
      <span className="composer-voice-status">{status}</span>
      <span className="composer-voice-notice" role="status" data-testid="voice-notice">
        {notice ? t(`voice.notice.${notice.key}`) : ''}
      </span>
    </span>
  )
}
