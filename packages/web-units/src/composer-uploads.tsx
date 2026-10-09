import type { UploadedAttachment } from '@agnes/protocol'
import { useEffect, useRef, useState } from 'react'
import {
  cancelFileUpload,
  FileUploadFailure,
  fileUploadLimits,
  type UploadProgress,
  uploadFile,
} from './file-upload.js'
import type { Translate } from './locales/index.js'

type Entry = UploadProgress & {
  id: string
  file: File
  controller: AbortController
  sessionId?: string
  state: 'waiting' | 'uploading' | 'verifying' | 'failed' | 'cancelled' | 'ready'
  error?: string
  preparing?: boolean
}
export function useComposerUploads(
  prepare: (() => Promise<string>) | undefined,
  ready: (attachment: UploadedAttachment, id: string, size: number) => void,
  changed: (() => void) | undefined,
  t: Translate,
) {
  const [entries, setEntries] = useState<Entry[]>([])
  const current = useRef<Entry[]>([])
  const tail = useRef<Promise<void>>(Promise.resolve())
  const alive = useRef(true)
  const publish = () => {
    if (!alive.current) return
    setEntries([...current.current])
    changed?.()
  }
  const cancel = async (entry: Entry) => {
    entry.controller.abort()
    try {
      if (entry.sessionId) await cancelFileUpload(entry.sessionId, entry.id)
      entry.state = 'cancelled'
      delete entry.error
    } catch {
      entry.state = 'failed'
      entry.error = t('composer.upload.cleanupFailed')
    }
    publish()
  }
  const run = (entry: Entry, preparation?: Promise<string>) => {
    tail.current = tail.current
      .catch(() => undefined)
      .then(async () => {
        if (entry.controller.signal.aborted || !alive.current) return
        try {
          if (!prepare) throw new FileUploadFailure('UPLOAD_UNAVAILABLE')
          if (!entry.sessionId) {
            entry.preparing = true
            try {
              entry.sessionId = await (preparation ?? prepare())
            } finally {
              entry.preparing = false
            }
          }
          entry.controller.signal.throwIfAborted()
          const limits = await fileUploadLimits(entry.sessionId, entry.controller.signal)
          const attachment = await uploadFile(
            entry.file,
            entry.sessionId,
            entry.id,
            limits,
            entry.controller.signal,
            (progress) => {
              Object.assign(entry, progress, { state: progress.phase })
              publish()
            },
          )
          entry.state = 'ready'
          if (alive.current && !entry.controller.signal.aborted) ready(attachment, entry.id, entry.total)
        } catch (error) {
          if (entry.controller.signal.aborted) {
            await cancel(entry)
          } else {
            entry.state = 'failed'
            entry.error =
              error instanceof FileUploadFailure
                ? t(
                    error.code === 'UPLOAD_SIZE_LIMIT'
                      ? 'composer.upload.sizeLimit'
                      : error.code === 'UPLOAD_TYPE_LIMIT'
                        ? 'composer.upload.typeLimit'
                        : 'composer.upload.failed',
                    error.detail,
                  )
                : t('composer.upload.failed')
          }
        }
        publish()
      })
  }
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      for (const entry of current.current) {
        if (entry.state !== 'cancelled') void cancelRef.current(entry)
      }
    }
  }, [])
  return {
    available: !!prepare,
    pending: () =>
      current.current.some((entry) => ['waiting', 'uploading', 'verifying'].includes(entry.state)),
    count: () =>
      current.current.filter((entry) => entry.state !== 'cancelled' && entry.state !== 'ready').length,
    add(files: readonly File[]) {
      if (files.length === 0) return
      const batch: Entry[] = []
      const preparation = Promise.resolve()
        .then(() => {
          if (!prepare) throw new FileUploadFailure('UPLOAD_UNAVAILABLE')
          return prepare()
        })
        .then((sessionId) => {
          for (const entry of batch) {
            entry.sessionId = sessionId
            entry.preparing = false
          }
          publish()
          return sessionId
        })
      void preparation.catch(() => {
        for (const entry of batch) entry.preparing = false
      })
      for (const file of files) {
        const entry: Entry = {
          id: crypto.randomUUID(),
          file,
          loaded: 0,
          total: file.size,
          phase: 'uploading',
          state: 'waiting',
          controller: new AbortController(),
          preparing: true,
        }
        current.current.push(entry)
        batch.push(entry)
        run(entry, preparation)
      }
      publish()
    },
    clear() {
      // Opening the session requested by this upload clears the ordinary composer attachments.
      // The preparation callback checks selection ownership before returning its session identity.
      for (const entry of current.current) if (entry.state !== 'ready' && !entry.preparing) void cancel(entry)
      current.current = current.current.filter((entry) => entry.preparing && !entry.controller.signal.aborted)
      publish()
    },
    remove(id: string, uri?: string, name = '', size = 0) {
      const entry = current.current.find((entry) => entry.id === id)
      if (entry) void cancel(entry)
      else if (uri && prepare) {
        const restored: Entry = {
          id: uri.split('/').at(-1) ?? '',
          file: new File([], name),
          loaded: size,
          total: size,
          phase: 'verifying',
          state: 'ready',
          controller: new AbortController(),
        }
        current.current.push(restored)
        void prepare()
          .then((sessionId) => {
            restored.sessionId = sessionId
            return cancel(restored)
          })
          .catch(() => {
            restored.controller.abort()
            restored.state = 'failed'
            restored.error = t('composer.upload.cleanupFailed')
            publish()
          })
      }
    },
    chips: entries
      .filter((entry) => entry.state !== 'ready')
      .map((entry) => {
        const percent = entry.total === 0 ? 100 : Math.floor((entry.loaded * 100) / entry.total)
        const active = ['waiting', 'uploading', 'verifying'].includes(entry.state)
        return (
          <figure
            className="composer-file-preview composer-upload"
            key={entry.id}
            data-testid="attachment-upload"
            data-state={entry.state}
          >
            <span title={entry.file.name}>{entry.file.name}</span>
            <small role="status" aria-live="polite" data-testid="attachment-upload-status">
              {entry.error ?? t(`composer.upload.${entry.state}`)} · {entry.loaded.toLocaleString()} /{' '}
              {entry.total.toLocaleString()} B · {percent}%
            </small>
            {active && (
              <progress
                max={entry.total || 1}
                value={entry.loaded}
                aria-label={t('composer.upload.progress', { name: entry.file.name })}
                data-testid="attachment-upload-progress"
              />
            )}
            {active && (
              <button
                type="button"
                data-testid="attachment-upload-cancel"
                aria-label={t('composer.upload.cancelName', { name: entry.file.name })}
                onClick={() => {
                  void cancel(entry)
                }}
              >
                {t('composer.upload.cancel')}
              </button>
            )}
            {entry.state === 'failed' && (
              <button
                type="button"
                data-testid="attachment-upload-retry"
                onClick={() => {
                  if (entry.controller.signal.aborted) {
                    void cancel(entry)
                    return
                  }
                  entry.state = 'waiting'
                  delete entry.error
                  publish()
                  run(entry)
                }}
              >
                {t('composer.upload.retry')}
              </button>
            )}
            {!active && (
              <button
                type="button"
                data-testid="attachment-upload-dismiss"
                aria-label={t('composer.upload.dismiss')}
                onClick={() => {
                  void cancel(entry).then(() => {
                    if (entry.state === 'cancelled') {
                      current.current = current.current.filter((item) => item !== entry)
                      publish()
                    }
                  })
                }}
              >
                ×
              </button>
            )}
          </figure>
        )
      }),
  }
}
