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
 * converting keeps the text as ordinary memory. Shown only when the index holds saved paragraphs. With
 * `layer: 'user'`, the same for the lessons promoted to user memory, read in every workspace that turns
 * user memory on: renew and withdraw only (withdrawing stops the same content being written again).
 */
export function SavedParagraphsBlock(props: {
  cwd: string
  canSave: boolean
  locale: string
  t: Text
  /** MEMORY.md changed (withdraw or convert): the open file should be read again. */
  onFileChanged(): void
  /**
   * The task experience promoted to user memory instead of the workspace's: renew and withdraw only, and
   * whether this workspace reads user memory (`readsUser`).
   */
  layer?: 'user'
  readsUser?: boolean
}) {
  const { cwd, canSave, locale, t } = props
  const user = props.layer === 'user'
  const [paragraphs, setParagraphs] = useState<SavedParagraph[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  useEffect(() => {
    const abort = new AbortController()
    setParagraphs([])
    setError(undefined)
    void memoryRequest(
      { cwd, saved: { action: 'list', ...(user ? { layer: 'user' } : {}) } },
      abort.signal,
    ).then(
      (result) => {
        if (!abort.signal.aborted) setParagraphs(result.saved?.paragraphs ?? [])
      },
      (failure) => {
        if (!abort.signal.aborted) setError(errorEnvelope(failure))
      },
    )
    return () => abort.abort()
  }, [cwd, user])
  const act = async (action: Exclude<SavedParagraphRequest['action'], 'list'>, paragraphId: string) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await memoryRequest({
        cwd,
        saved: { action, paragraphId, ...(user ? { layer: 'user' as const } : {}) },
      })
      setParagraphs(result.saved?.paragraphs ?? [])
      if (action !== 'renew' && !user) props.onFileChanged()
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
    <SettingsBlock
      label={t(user ? 'saved.user.title' : 'saved.title')}
      data-testid={user ? 'memory-user-saved' : 'memory-saved'}
    >
      <p className="agnes-settings-note">{t(user ? 'saved.user.help' : 'saved.help')}</p>
      {user && (
        <p className="agnes-settings-note" data-testid="memory-user-read">
          {t(props.readsUser ? 'saved.user.read' : 'saved.user.unread')}
        </p>
      )}
      {Boolean(error) && (
        <Banner tone="error" role="alert" data-testid="memory-saved-error">
          {appServerErrorMessage(error, locale) ?? t('failed')}
        </Banner>
      )}
      {paragraphs.map((paragraph) => (
        <SettingsItem
          key={paragraph.id}
          data-testid={user ? 'memory-user-saved-paragraph' : 'memory-saved-paragraph'}
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
          {!user && (
            <Button
              size="small"
              data-testid="memory-saved-convert"
              disabled={!canSave || busy}
              onClick={() => void act('convert', paragraph.id)}
            >
              {t('saved.convert')}
            </Button>
          )}
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
