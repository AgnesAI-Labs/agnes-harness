import { useEffect, useRef, useState } from 'react'
import type { Translate } from '../locales/index.js'

async function blobBase64(url: string, signal: AbortSignal): Promise<string> {
  if (!url.startsWith('blob:')) throw Error('PDF blob required')
  const response = await fetch(url, { signal, credentials: 'omit' })
  if (!response.ok || !response.body) throw Error('PDF blob unavailable')
  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  let size = 0,
    binary = ''
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) return btoa(binary)
      size += value.byteLength
      if (size > 1024 * 1024) throw Error('PDF preview limit')
      for (let i = 0; i < value.length; i += 8192)
        binary += String.fromCharCode(...value.subarray(i, i + 8192))
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Native PDF viewers cannot run inside the cloud frame's inherited sandbox. */
export function PdfPreviewFrame({
  base64,
  resourceUrl,
  title,
  t,
}: {
  base64: string
  resourceUrl: string
  title: string
  t: Translate
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const previous = t('doc.pdfPrevious'),
    next = t('doc.pdfNext'),
    failure = t('doc.pdfFailed')
  const titleRef = useRef(title)
  titleRef.current = title
  const [failed, setFailed] = useState(false)
  const blobSource = base64 ? '' : resourceUrl
  useEffect(() => {
    setFailed(false)
    const controller = new AbortController()
    let live = true,
      ready = false,
      content = base64
    const timer = setTimeout(() => {
      controller.abort()
      setFailed(true)
    }, 15000)
    const send = () => {
      if (live && ready && content)
        frame.current?.contentWindow?.postMessage(
          { type: 'agnes-pdf-data', base64: content, title: titleRef.current, previous, next, failure },
          '*',
        )
    }
    const receive = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || event.source !== target) return
      if (event.data?.type === 'agnes-pdf-ready') {
        ready = true
        send()
      } else if (event.data?.type === 'agnes-pdf-rendered') clearTimeout(timer)
      else if (event.data?.type === 'agnes-pdf-error') {
        clearTimeout(timer)
        setFailed(true)
      }
    }
    window.addEventListener('message', receive)
    if (!base64)
      void blobBase64(blobSource, controller.signal)
        .then((value) => {
          if (!live || controller.signal.aborted) return
          content = value
          send()
        })
        .catch(() => {
          if (!live || controller.signal.aborted) return
          clearTimeout(timer)
          setFailed(true)
        })
    return () => {
      live = false
      controller.abort()
      clearTimeout(timer)
      window.removeEventListener('message', receive)
    }
  }, [base64, blobSource, previous, next, failure])
  return failed ? (
    <p role="alert">{t('doc.pdfFailed')}</p>
  ) : (
    <iframe
      key={`${base64 || resourceUrl}:${failure}`}
      ref={frame}
      src="/__agnes/pdf-preview"
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
    />
  )
}
