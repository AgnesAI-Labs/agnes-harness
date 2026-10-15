import { Button } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { record, text } from './model.js'
import { ActionFeedback, useAction, useMhs } from './react.js'

/** Accept a bounded PCM16 WAV, preserving the audio samples exactly. */
export function pcmWav(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number) => new TextDecoder().decode(bytes.subarray(at, at + 4))
  if (
    bytes.length < 44 ||
    bytes.length > (1 << 20) + 4096 ||
    tag(0) !== 'RIFF' ||
    tag(8) !== 'WAVE' ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    throw new Error('invalid-wav')
  let rate = 0,
    channels = 0,
    pcm: Uint8Array | undefined
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at + 4, true),
      end = at + 8 + size
    if (end > bytes.length) throw new Error('invalid-wav')
    if (tag(at) === 'fmt ') {
      if (size < 16 || view.getUint16(at + 8, true) !== 1 || view.getUint16(at + 22, true) !== 16)
        throw new Error('pcm16-required')
      channels = view.getUint16(at + 10, true)
      rate = view.getUint32(at + 12, true)
      if (
        view.getUint16(at + 20, true) !== channels * 2 ||
        view.getUint32(at + 16, true) !== rate * channels * 2
      )
        throw new Error('invalid-pcm-format')
    }
    if (tag(at) === 'data') pcm = bytes.slice(at + 8, end)
    at = end + (size % 2)
  }
  if (
    !pcm?.length ||
    pcm.length > 1 << 20 ||
    channels < 1 ||
    channels > 8 ||
    rate < 1 ||
    rate > 384000 ||
    pcm.length % (channels * 2)
  )
    throw new Error('invalid-pcm')
  return { rate, channels, pcm }
}
export function ClipSender({ device, onSent }: { device: string; onSent(id: string): void }) {
  const { client, t } = useMhs(),
    action = useAction()
  const [clip, setClip] = useState<{
    id: string
    rate: number
    channels: number
    pcm: Uint8Array
    sha256: string
  }>()
  const proposed = useRef<typeof clip>(undefined),
    sentOperation = useRef(''),
    onSentRef = useRef(onSent),
    readGeneration = useRef(0)
  onSentRef.current = onSent
  useEffect(
    () => () => {
      readGeneration.current++
    },
    [],
  )
  const [error, setError] = useState(''),
    [sent, setSent] = useState(false)
  useEffect(() => {
    const receipt = action.receipt
    if (
      !clip ||
      proposed.current !== clip ||
      receipt?.operationId === sentOperation.current ||
      receipt?.state !== 'completed' ||
      text(record(receipt.output).operationId) !== receipt.operationId
    )
      return
    sentOperation.current = receipt.operationId
    const abort = new AbortController()
    let confirmed = false
    void client
      .stream(
        'clip',
        {},
        (frame) => {
          if (text(record(frame).state) === 'sent') {
            confirmed = true
            onSentRef.current(clip.id)
            setSent(true)
          }
        },
        abort.signal,
        receipt.operationId,
      )
      .then(async ({ stream, close }) => {
        stream.onDisconnect(() => {
          if (!confirmed && !abort.signal.aborted) setError('clip-unconfirmed')
        })
        for (let offset = 0; offset < clip.pcm.length; offset += 2048) {
          abort.signal.throwIfAborted()
          if (stream.send(clip.pcm.subarray(offset, offset + 2048)) !== 'accepted') {
            close()
            throw new Error('clip-send-failed')
          }
          if (offset + 2048 < clip.pcm.length)
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                clearTimeout(timer)
                reject(new Error('clip-aborted'))
              }
              const timer = setTimeout(() => {
                abort.signal.removeEventListener('abort', onAbort)
                resolve()
              }, 40)
              abort.signal.addEventListener('abort', onAbort, { once: true })
            })
        }
        // Sent means bytes dispatched; tool completion remains the device's receipt.
      })
      .catch(() => {
        if (!abort.signal.aborted) setError('clip-send-failed')
      })
    return () => abort.abort()
  }, [action.receipt, clip, client])
  return (
    <fieldset>
      <label>
        {t('clipFile')}
        <input
          type="file"
          accept="audio/wav,.wav"
          disabled={action.busy || action.pending}
          onChange={(e) => {
            const file = e.target.files?.[0],
              generation = ++readGeneration.current
            setClip(undefined)
            setSent(false)
            setError('')
            if (!file) return
            if (file.size > (1 << 20) + 4096) {
              setError(t('failed'))
              return
            }
            void file
              .arrayBuffer()
              .then(async (buffer) => {
                const parsed = pcmWav(new Uint8Array(buffer))
                const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(parsed.pcm)))
                if (generation !== readGeneration.current) return
                setClip({
                  ...parsed,
                  id: crypto.randomUUID(),
                  sha256: [...sha].map((v) => v.toString(16).padStart(2, '0')).join(''),
                })
              })
              .catch(() => setError(t('failed')))
          }}
        />
      </label>
      <Button
        disabled={!clip || action.busy || action.pending || sent}
        onClick={() => {
          if (clip) {
            proposed.current = clip
            void action.run('clip', {
              device,
              params: {
                id: clip.id,
                rate: clip.rate,
                channels: clip.channels,
                bytes: clip.pcm.length,
                sha256: clip.sha256,
              },
            })
          }
        }}
      >
        {t('sendClip')}
      </Button>
      {error && <p role="alert">{t('failed')}</p>}
      {sent && <p role="status">{t('clipSent')}</p>}
      <ActionFeedback action={action} />
    </fieldset>
  )
}
