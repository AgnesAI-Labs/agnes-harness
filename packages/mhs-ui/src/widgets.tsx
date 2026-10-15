import { Button } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { type Sample, sampleFrom, VideoView } from './media.js'
import { array, type Data, type Device, jsonText, number, record, text } from './model.js'
import { ActionFeedback, useAction, useMhs } from './react.js'

function Picture({ sample, kind, dropped }: { sample: Sample | undefined; kind: string; dropped: number }) {
  const { t } = useMhs(),
    canvas = useRef<HTMLCanvasElement>(null),
    decoder = useRef<VideoView>(),
    [url, setUrl] = useState(''),
    [failed, setFailed] = useState(false)
  useEffect(() => {
    if (kind !== 'video' || !canvas.current) return
    const v = new VideoView(canvas.current, () => setFailed(true))
    decoder.current = v
    return () => {
      v.close()
      decoder.current = undefined
    }
  }, [kind])
  useEffect(() => {
    if (dropped > 0) decoder.current?.dropped()
  }, [dropped])
  useEffect(() => {
    if (!sample?.bytes) return
    if (kind === 'video') {
      decoder.current?.push(sample)
      return
    }
    if (!['image/png', 'image/jpeg'].includes(sample.mime)) {
      setFailed(true)
      return
    }
    const next = URL.createObjectURL(new Blob([sample.bytes.slice().buffer], { type: sample.mime }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [sample, kind])
  return (
    <>
      {failed && <p role="status">{t('unsupported')}</p>}
      {kind === 'video' ? (
        <canvas ref={canvas} aria-label="Video" />
      ) : url ? (
        <img src={url} alt="Device observation" />
      ) : (
        <p>{t('waiting')}</p>
      )}
    </>
  )
}
function Audio({ sample }: { sample: Sample | undefined }) {
  const { t } = useMhs(),
    [listen, setListen] = useState(false),
    [unsupported, setUnsupported] = useState(false),
    audio = useRef<AudioContext>(),
    sources = useRef(new Set<AudioBufferSourceNode>())
  useEffect(() => {
    if (!listen || typeof AudioContext === 'undefined') return
    const context = new AudioContext()
    audio.current = context
    void context.resume().catch(() => setUnsupported(true))
    return () => {
      for (const source of sources.current) source.stop()
      sources.current.clear()
      audio.current = undefined
      void context.close().catch(() => {})
    }
  }, [listen])
  useEffect(() => {
    if (!listen || !sample?.bytes || !audio.current) return
    const context = audio.current
    // MOS audio is interleaved little-endian signed PCM16, with rate/channels in metadata.
    const channels = number(sample.data.channels),
      rate = number(sample.data.rate)
    if (
      !Number.isInteger(channels) ||
      channels < 1 ||
      channels > 8 ||
      rate < 8000 ||
      rate > 384000 ||
      sample.bytes.length % (channels * 2) !== 0
    ) {
      setUnsupported(true)
      return
    }
    if (sources.current.size >= 2) return
    const count = sample.bytes.length / (channels * 2),
      buffer = context.createBuffer(channels, count, rate),
      view = new DataView(sample.bytes.buffer, sample.bytes.byteOffset, sample.bytes.byteLength)
    for (let channel = 0; channel < channels; channel++) {
      const out = buffer.getChannelData(channel)
      for (let i = 0; i < count; i++) out[i] = view.getInt16((i * channels + channel) * 2, true) / 32768
    }
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    sources.current.add(source)
    source.onended = () => sources.current.delete(source)
    try {
      source.start()
    } catch {
      setUnsupported(true)
    }
    return () => {}
  }, [listen, sample])
  return (
    <>
      <Button disabled={typeof AudioContext === 'undefined'} onClick={() => setListen((v) => !v)}>
        {t(listen ? 'mute' : 'listen')}
      </Button>
      {unsupported && <p>{t('unsupported')}</p>}
    </>
  )
}
export function Observation({ source, device }: { source: Data; device: Device }) {
  const { client, t } = useMhs(),
    [sample, setSample] = useState<Sample>(),
    [error, setError] = useState(false),
    [stale, setStale] = useState(false),
    [dropped, setDropped] = useState(0),
    [confirmedOff, setConfirmedOff] = useState<boolean>(),
    requestedOff = useRef(false),
    action = useAction()
  // Only a confirmed backend source-state projection may label a source as off.
  const configured = record(device.state.sources)[text(source.id)],
    off = configured === false || (configured === undefined && (confirmedOff ?? source.default === false)),
    kind = text(source.kind)
  useEffect(() => {
    const receipt = action.receipt
    if (receipt?.state === 'completed' && record(record(receipt.output).outcome).status === 'done')
      setConfirmedOff(requestedOff.current)
  }, [action.receipt])
  useEffect(() => {
    setSample(undefined)
    setError(false)
    setStale(false)
    if (off || !device.online) return
    const abort = new AbortController()
    let last = 0
    const timer = setInterval(() => setStale(last > 0 && Date.now() - last > 10_000), 1000)
    void client
      .stream(
        'media',
        { device: device.id, source: text(source.id) },
        (frame) => {
          try {
            const next = sampleFrom(frame)
            if (next.device !== device.id || next.source !== source.id) return
            last = next.at
            setSample(next)
            setStale(Date.now() - last > 10_000)
          } catch {
            setError(true)
          }
        },
        abort.signal,
      )
      .then(({ stream }) => {
        stream.onDisconnect(() => setError(true))
        stream.onDrop(() => {
          setStale(true)
          setDropped((n) => n + 1)
        })
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true)
      })
    return () => {
      abort.abort()
      clearInterval(timer)
    }
  }, [client, device.id, device.online, source.id, off])
  const points = array(sample?.data.ranges ?? sample?.data.points),
    values = sample?.data ?? {}
  return (
    <section className="mhs-observation">
      <header>
        <h4>{text(source.description) || text(source.id)}</h4>
        {source.switchable === true && (
          <Button
            loading={action.busy}
            disabled={!device.available || action.pending}
            onClick={() => {
              requestedOff.current = !off
              void action.run('configure', {
                device: device.id,
                params: { sources: { [text(source.id)]: { on: off } } },
              })
            }}
          >
            {t(off ? 'turnOn' : 'sourceOff')}
          </Button>
        )}
      </header>
      {off ? (
        <p>{t('sourceOff')}</p>
      ) : !device.online ? (
        <p>{t('offline')}</p>
      ) : (
        <>
          {(error || stale) && <p role="status">{t(error ? 'unavailable' : 'stale')}</p>}
          {!sample && <p>{t('waiting')}</p>}
          {['image', 'video'].includes(kind) ? (
            <Picture sample={sample} kind={kind} dropped={dropped} />
          ) : kind === 'audio' ? (
            <Audio sample={sample} />
          ) : kind === 'scan' ? (
            <svg viewBox="-100 -100 200 200" role="img" aria-label={text(source.description)}>
              {points.slice(0, 2048).map((p, i) => {
                const angle = number(sample?.data.angle_min) + i * number(sample?.data.angle_inc)
                const a = array(p)
                const x = a.length ? number(a[0]) : number(p) * Math.cos(angle),
                  y = a.length ? number(a[1]) : number(p) * Math.sin(angle)
                return <circle key={String(angle)} cx={x} cy={-y} r="1" />
              })}
            </svg>
          ) : (
            <Values kind={kind} data={values} />
          )}
        </>
      )}
      <ActionFeedback action={action} />
    </section>
  )
}
function Values({ kind, data }: { kind: string; data: Data }) {
  const history = useRef<number[]>([]),
    v = Object.values(data).find((x) => typeof x === 'number')
  if (typeof v === 'number') {
    history.current = [...history.current, v].slice(-40)
  }
  if (['text', 'transcript'].includes(kind)) return <pre>{text(data.text) || jsonText(data)}</pre>
  return (
    <>
      <dl>
        {Object.entries(data).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{typeof v === 'object' ? jsonText(v) : String(v)}</dd>
          </div>
        ))}
      </dl>
      {kind === 'values' && history.current.length > 1 && (
        <svg viewBox="0 0 100 30" role="img" aria-label="Trend">
          <polyline
            points={history.current
              .map(
                (v, i) =>
                  `${(i / (history.current.length - 1)) * 100},${28 - ((v - Math.min(...history.current)) / (Math.max(...history.current) - Math.min(...history.current) || 1)) * 26}`,
              )
              .join(' ')}
          />
        </svg>
      )}
    </>
  )
}
