/**
 * Pictures: `image` sources drawn on a canvas, newest frame only, at the next animation frame; and
 * `video` (H.264 Annex B) decoded with WebCodecs. Detections of the same camera (`of`) are drawn
 * on top, and bearing ticks when the source declares `fov_deg` (mhs-ui-design section 8).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Latest } from '../core/store.js'
import type { Source } from '../core/types.js'
import { t } from '../i18n/i18n.js'
import { useSource, useStore } from '../react/hooks.js'
import { Frame, type SourceProps, useLive } from './frame.js'

type Box = { label: string; conf: number; box: [number, number, number, number]; dist?: number }

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  source: Source,
  detections: { w: number; h: number; items: Box[] } | undefined,
) {
  // Pixels of the picture per pixel on screen, so text and lines keep their size at any scale.
  const k = w / Math.max(1, ctx.canvas.clientWidth || w)
  if (source.fov_deg) {
    const fov = source.fov_deg[0]
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.font = `${10 * k}px ui-monospace, monospace`
    ctx.lineWidth = k
    for (let deg = -Math.floor(fov / 2 / 10) * 10; deg <= fov / 2; deg += 10) {
      const x = w / 2 - (deg / fov) * w
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, (deg % 30 === 0 ? 10 : 5) * k)
      ctx.stroke()
      if (deg % 30 === 0) ctx.fillText(`${deg}°`, x + 2 * k, 20 * k)
    }
  }
  if (!detections) return
  const sx = w / detections.w
  const sy = h / detections.h
  ctx.lineWidth = 2 * k
  ctx.font = `${11 * k}px ui-sans-serif, sans-serif`
  for (const d of detections.items) {
    const [x1, y1, x2, y2] = d.box
    ctx.strokeStyle = '#4ee6a0'
    ctx.strokeRect(x1 * sx, y1 * sy, (x2 - x1) * sx, (y2 - y1) * sy)
    const label = `${d.label} ${Math.round(d.conf * 100)}%${d.dist !== undefined ? ` ${d.dist.toFixed(1)} m` : ''}`
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(x1 * sx, y1 * sy - 16 * k, ctx.measureText(label).width + 6 * k, 16 * k)
    ctx.fillStyle = '#4ee6a0'
    ctx.fillText(label, x1 * sx + 3 * k, y1 * sy - 4 * k)
  }
}

/** Draws the newest bitmap on the canvas once per animation frame. */
function useCanvas() {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const pending = useRef<ImageBitmap | VideoFrame | null>(null)
  const overlay = useRef<(ctx: CanvasRenderingContext2D, w: number, h: number) => void>(() => undefined)
  const raf = useRef(0)
  const draw = useCallback((frame: ImageBitmap | VideoFrame) => {
    pending.current?.close()
    pending.current = frame
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      const c = canvas.current
      const f = pending.current
      pending.current = null
      if (!c || !f) {
        f?.close()
        return
      }
      const w = 'displayWidth' in f ? f.displayWidth : f.width
      const h = 'displayHeight' in f ? f.displayHeight : f.height
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      }
      const ctx = c.getContext('2d')
      if (ctx) {
        ctx.drawImage(f, 0, 0, w, h)
        overlay.current(ctx, w, h)
      }
      f.close()
    })
  }, [])
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current)
      pending.current?.close()
    },
    [],
  )
  return { canvas, draw, overlay }
}

function useDetections(props: SourceProps, enabled: boolean) {
  const det = props.device.sources.find((s) => s.kind === 'detections' && s.of === props.source.id)
  const latest = useSource(props.device.id, det?.id ?? '', det ? (det.hz ?? 5) : 0, enabled && !!det)
  return latest?.item.data as { w: number; h: number; items: Box[] } | undefined
}

/** "front · 10 Hz · 1280×720" under a picture. */
function tagOf(props: SourceProps): string {
  const s = props.source
  return [s.id, s.hz ? `${s.hz} Hz` : '', s.size ? `${s.size[0]}×${s.size[1]}` : '']
    .filter(Boolean)
    .join(' · ')
}

export function ImageView(props: SourceProps) {
  const { ref, latest, off } = useLive(props.device, props.source, props.hz)
  const { canvas, draw, overlay } = useCanvas()
  const detections = useDetections(props, !props.compact)
  overlay.current = (ctx, w, h) =>
    props.compact ? undefined : drawOverlay(ctx, w, h, props.source, detections)
  useEffect(() => {
    const bytes = latest?.binary
    if (!bytes) return
    let live = true
    createImageBitmap(
      new Blob([bytes], { type: latest.item.mime ?? props.source.mime ?? 'image/jpeg' }),
    ).then(
      (bitmap) => (live ? draw(bitmap) : bitmap.close()),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [latest, draw, props.source.mime])
  return (
    <Frame {...props} latest={latest} off={off} setRef={ref}>
      {props.compact ? (
        <canvas ref={canvas} className="mhs-picture" />
      ) : (
        <div className="mhs-screen">
          <canvas ref={canvas} className="mhs-picture" />
          <span className="mhs-screen-tag">{tagOf(props)}</span>
        </div>
      )}
    </Frame>
  )
}

export function VideoView(props: SourceProps) {
  const store = useStore()
  const { ref, latest, off } = useLive(props.device, props.source, props.hz ?? props.source.hz ?? 30)
  const { canvas, draw, overlay } = useCanvas()
  const detections = useDetections(props, !props.compact)
  overlay.current = (ctx, w, h) =>
    props.compact ? undefined : drawOverlay(ctx, w, h, props.source, detections)
  const [unsupported] = useState(() => typeof VideoDecoder === 'undefined')
  useEffect(() => {
    if (unsupported) return
    let decoder: VideoDecoder | undefined
    let waitingKey = true
    const make = () => {
      decoder = new VideoDecoder({ output: draw, error: () => (waitingKey = true) })
      // No description: the stream is Annex B with its parameter sets in each keyframe.
      decoder.configure({ codec: 'avc1.42E01F', optimizeForLatency: true })
    }
    make()
    const off = store.onItem(props.device.id, props.source.id, (l: Latest) => {
      if (!l.binary || !decoder) return
      const key = Boolean((l.item.data as { key?: boolean } | undefined)?.key)
      if (decoder.state === 'closed') make()
      if (waitingKey && !key) return
      waitingKey = false
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: key ? 'key' : 'delta',
            timestamp: (l.item.time ?? 0) * 1e6,
            data: l.binary,
          }),
        )
      } catch {
        waitingKey = true
      }
    })
    return () => {
      off()
      if (decoder && decoder.state !== 'closed') decoder.close()
    }
  }, [store, props.device.id, props.source.id, draw, unsupported])
  return (
    <Frame {...props} latest={latest} off={off} setRef={ref}>
      {unsupported ? (
        <div className="mhs-note">{t('data.video.unsupported')}</div>
      ) : props.compact ? (
        <canvas ref={canvas} className="mhs-picture" />
      ) : (
        <div className="mhs-screen">
          <canvas ref={canvas} className="mhs-picture" />
        </div>
      )}
    </Frame>
  )
}
