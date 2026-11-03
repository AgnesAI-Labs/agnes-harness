import type { SavedParagraph, SavedParagraphRequest } from '@agnes/protocol/gen/app-server'
import { appServerErrorMessage, Banner, Button, SettingsBlock, SettingsItem } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { memoryRequest } from './memory-api.js'

type Text = (key: string, vars?: Record<string, string | number>) => string
const errorEnvelope = (error: unknown) => (error as { envelope?: unknown })?.envelope ?? true

/** The first line of a saved paragraph names it; the whole text stays in the memory file. */
const title = (text: string) => {
  const first =
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? ''
  return first.length > 80 ? `${first.slice(0, 79)}…` : first
}

/**
 * Saved task experience in the workspace memory index, beside the editor: each paragraph with whether the
 * agent sees it and its review date, and a person's three actions on it. Renewing starts a new 30-day
 * period; withdrawing cuts it from the file and stops automatic and model saves of the same content;
 * converting keeps the text as ordinary memory. Shown only when the index holds saved paragraphs.
 */
export function SavedParagraphsBlock(props: {
  cwd: string
  canSave: boolean
  locale: string
  t: Text
  /** MEMORY.md changed (withdraw or convert): the open file should be read again. */
  onFileChanged(): void
}) {
  const { cwd, canSave, locale, t } = props
  const [paragraphs, setParagraphs] = useState<SavedParagraph[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  useEffect(() => {
    const abort = new AbortController()
    setParagraphs([])
    setError(undefined)
    void memoryRequest({ cwd, saved: { action: 'list' } }, abort.signal).then(
      (result) => {
        if (!abort.signal.aborted) setParagraphs(result.saved?.paragraphs ?? [])
      },
      (failure) => {
        if (!abort.signal.aborted) setError(errorEnvelope(failure))
      },
    )
    return () => abort.abort()
  }, [cwd])
  const act = async (action: Exclude<SavedParagraphRequest['action'], 'list'>, paragraphId: string) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await memoryRequest({ cwd, saved: { action, paragraphId } })
      setParagraphs(result.saved?.paragraphs ?? [])
      if (action !== 'renew') props.onFileChanged()
    } catch (failure) {
      setError(errorEnvelope(failure))
    } finally {
      setBusy(false)
    }
  }
  if (!paragraphs.length && !error) return null
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
  const status = (paragraph: SavedParagraph) => {
    const when = paragraph.reviewAfter === undefined ? '' : date.format(paragraph.reviewAfter)
    return [
      t(`saved.${paragraph.validity}`, { date: when }),
      paragraph.initiator ? t('saved.by', { who: t(`saved.initiator.${paragraph.initiator}`) }) : '',
    ]
      .filter(Boolean)
      .join(' ')
  }
  return (
    <SettingsBlock label={t('saved.title')} data-testid="memory-saved">
      <p className="agnes-settings-note">{t('saved.help')}</p>
      {Boolean(error) && (
        <Banner tone="error" role="alert" data-testid="memory-saved-error">
          {appServerErrorMessage(error, locale) ?? t('failed')}
        </Banner>
      )}
      {paragraphs.map((paragraph) => (
        <SettingsItem
          key={paragraph.id}
          data-testid="memory-saved-paragraph"
          label={<span translate="no">{title(paragraph.text)}</span>}
          description={status(paragraph)}
        >
          {paragraph.reviewAfter !== undefined && (
            <Button
              size="small"
              data-testid="memory-saved-renew"
              disabled={!canSave || busy}
              onClick={() => void act('renew', paragraph.id)}
            >
              {t('saved.renew')}
            </Button>
          )}
          <Button
            size="small"
            data-testid="memory-saved-convert"
            disabled={!canSave || busy}
            onClick={() => void act('convert', paragraph.id)}
          >
            {t('saved.convert')}
          </Button>
          <Button
            size="small"
            data-testid="memory-saved-withdraw"
            disabled={!canSave || busy}
            onClick={() => void act('withdraw', paragraph.id)}
          >
            {t('saved.withdraw')}
          </Button>
        </SettingsItem>
      ))}
    </SettingsBlock>
  )
}
