import type { VoicePort } from '@agnes/web-client'
import { Button, Icon } from '@agnes/web-ui'
import { type ReactElement, useSyncExternalStore } from 'react'
import { useVoiceText } from './voice-locale.js'

/** Reads a final reply aloud; the same button stops it, and resumes playback the browser blocked. */
export function ReadAloudButton({
  voice,
  nodeId,
  text,
}: {
  voice: VoicePort
  nodeId: string
  text: string
}): ReactElement | null {
  const { reading } = useSyncExternalStore(voice.state.subscribe, voice.state.getSnapshot)
  const t = useVoiceText()
  if (!reading.visible) return null
  const mine = reading.nodeId === nodeId && reading.phase !== 'idle'
  const blocked = mine && reading.phase === 'blocked'
  const label = blocked ? t('voice.clickToPlay') : mine ? t('voice.stop') : t('voice.read')
  return (
    <Button
      htmlType="button"
      appearance="ghost"
      size="small"
      className="turn-action voice-read"
      data-testid="voice-read"
      data-phase={mine ? reading.phase : 'idle'}
      aria-label={label}
      title={label}
      icon={<Icon name={mine && !blocked ? 'square' : 'volume-2'} size={16} />}
      onClick={() => (blocked ? voice.resumePlayback() : voice.toggleReading(nodeId, text))}
    >
      {blocked ? <span className="voice-read-label">{label}</span> : null}
    </Button>
  )
}
