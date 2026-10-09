/**
 * A top-down radar of a `scan` source, placed by its mount, with range rings from `range_m` and the
 * body outline from `profile.size_m`; and a listener for `audio` sources (16-bit PCM through Web Audio).
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '../controls/ui.js'
import type { Latest } from '../core/store.js'
import { t } from '../i18n/i18n.js'
import { useStore } from '../react/hooks.js'
import { Frame, type SourceProps, useLive } from './frame.js'

export function ScanView(props: SourceProps) {
  const { ref, latest, off } = useLive(props.device, props.source, props.hz ?? 5)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const c = canvas.current
    const data = latest?.item.data as
      | { angle_min: number; angle_inc: number; ranges: (number | null)[] }
      | undefined
    if (!c || !data) return
    const size = c.clientWidth || 280
    const dpr = window.devicePixelRatio || 1
    c.width = size * dpr
    c.height = size * dpr
    const ctx = c.getContext('2d') as CanvasRenderingContext2D
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const max =
      props.source.range_m?.[1] ?? Math.max(1, ...data.ranges.filter((r): r is number => r !== null))
    const scale = size / 2 / max
    ctx.fillStyle = '#0d1217'
    ctx.fillRect(0, 0, size, size)
    ctx.translate(size / 2, size / 2)
    ctx.strokeStyle = 'rgba(140,170,190,0.18)'
    ctx.fillStyle = 'rgba(140,170,190,0.5)'
    ctx.font = '10px ui-monospace, monospace'
    const ringStep = max > 8 ? 2 : max > 3 ? 1 : 0.5
    for (let r = ringStep; r <= max; r += ringStep) {
      ctx.beginPath()
      ctx.arc(0, 0, r * scale, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillText(`${r} m`, 2, -r * scale + 10)
    }
    const body = props.device.profile?.size_m
    if (body) {
      ctx.strokeStyle = 'rgba(140,170,190,0.7)'
      ctx.strokeRect((-body[1] / 2) * scale, (-body[0] / 2) * scale, body[1] * scale, body[0] * scale)
    }
    // Sensor frame to screen: x forward is up, y left is left.
    const [mx, my] = props.source.mount?.xyz ?? [0, 0, 0]
    const myaw = ((props.source.mount?.rpy?.[2] ?? 0) * Math.PI) / 180
    ctx.fillStyle = '#4ee6a0'
    data.ranges.forEach((r, i) => {
      if (r === null) return
      const a = ((data.angle_min + i * data.angle_inc) * Math.PI) / 180 + myaw
      const fx = mx + r * Math.cos(a)
      const fy = my + r * Math.sin(a)
      ctx.fillRect(-fy * scale - 1, -fx * scale - 1, 2, 2)
    })
  }, [latest, props.source, props.device.profile])
  return (
    <Frame {...props} latest={latest} off={off} setRef={ref}>
      <canvas ref={canvas} className="mhs-radar" />
    </Frame>
  )
}

export function AudioView(props: SourceProps) {
  const store = useStore()
  const [on, setOn] = useState(false)
  const { ref, latest, off } = useLive(props.device, props.source, on ? (props.source.hz ?? 50) : 0)
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!on) return
    const rate = props.source.rate ?? 16000
    const channels = props.source.channels ?? 1
    const audio = new AudioContext({ sampleRate: rate })
    let at = 0
    const stop = store.onItem(props.device.id, props.source.id, (l: Latest) => {
      if (!l.binary) return
      const pcm = new Int16Array(l.binary)
      const frames = Math.floor(pcm.length / channels)
      if (frames === 0) return
      const buffer = audio.createBuffer(channels, frames, rate)
      let peak = 0
      for (let ch = 0; ch < channels; ch++) {
        const out = buffer.getChannelData(ch)
        for (let i = 0; i < frames; i++) {
          const v = (pcm[i * channels + ch] as number) / 32768
          out[i] = v
          peak = Math.max(peak, Math.abs(v))
        }
      }
      setLevel(peak)
      const node = audio.createBufferSource()
      node.buffer = buffer
      node.connect(audio.destination)
      // Keep a little slack so small gaps do not click; never fall further behind than 0.5 s.
      at = Math.max(at, audio.currentTime + 0.05)
      if (at - audio.currentTime > 0.5) at = audio.currentTime + 0.05
      node.start(at)
      at += buffer.duration
    })
    return () => {
      stop()
      void audio.close()
    }
  }, [on, store, props.device.id, props.source])
  return (
    <Frame {...props} latest={latest} off={off} setRef={ref} idle={!on}>
      <div className="mhs-audio">
        <Button small kind={on ? 'primary' : 'plain'} onClick={() => setOn(!on)}>
          {on ? t('data.mute') : t('data.listen')}
        </Button>
        <span className="mhs-gauge">
          <span style={{ width: `${Math.round(level * 100)}%` }} />
        </span>
      </div>
    </Frame>
  )
}
