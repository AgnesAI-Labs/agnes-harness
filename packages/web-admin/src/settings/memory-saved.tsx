import type { SavedParagraph, SavedParagraphRequest } from '@agnes/protocol/gen/app-server'
import { appServerErrorMessage, Banner, Button, SettingsBlock, SettingsItem } from '@agnes/web-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { memoryRequest } from './memory-api.js'
import { analyzeExpiry, useDeadlineTick } from './memory-expiry.js'

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
export function SavedParagraphsBlock(
  props: {
    cwd: string
    refreshKey: string
    indexContent?: string | undefined
    canSave: boolean
    locale: string
    t: Text
    /** MEMORY.md changed (withdraw or convert): the open file should be read again. */
    onFileChanged(): void
  } & ({ layer?: 'workspace'; memoryOff: boolean } | { layer: 'user'; readsUser: boolean }),
) {
  const { cwd, canSave, locale, t, refreshKey, indexContent } = props
  const user = props.layer === 'user'
  const [paragraphs, setParagraphs] = useState<SavedParagraph[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const earliest = useMemo(() => {
    const now = Date.now()
    let next = indexContent ? analyzeExpiry(indexContent, now).earliest : undefined
    for (const paragraph of paragraphs) {
      for (const deadline of [paragraph.reviewAfter, analyzeExpiry(paragraph.text, now).earliest]) {
        if (deadline !== undefined && deadline > now) next = Math.min(next ?? deadline, deadline)
      }
    }
    return next
  }, [paragraphs, indexContent])
  const tick = useDeadlineTick(earliest)
  const listing = useRef<AbortController | undefined>(undefined)
  // MemoryPanel keys each block by workspace and layer. Keep its rows visible during a refresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and tick invalidate the host listing.
  useEffect(() => {
    const abort = new AbortController()
    listing.current = abort
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
  }, [cwd, user, refreshKey, tick])
  const act = async (action: Exclude<SavedParagraphRequest['action'], 'list'>, paragraphId: string) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await memoryRequest({
        cwd,
        saved: { action, paragraphId, ...(user ? { layer: 'user' as const } : {}) },
      })
      listing.current?.abort()
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
    let key = `saved.${paragraph.validity}`
    if (paragraph.validity === 'valid') {
      if (user && !props.readsUser) key = 'saved.user.validUnread'
      else if (!user && props.memoryOff) key = 'saved.validOff'
      else if (paragraph.hidden) key = user ? 'saved.user.hidden' : 'saved.hidden'
    }
    return [
      t(key, { date: when }),
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
      {!user && props.memoryOff && (
        <p className="agnes-settings-note" data-testid="memory-saved-off">
          {t('saved.off')}
        </p>
      )}
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
