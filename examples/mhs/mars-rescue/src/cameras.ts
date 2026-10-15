import { CAMERA_SOURCES } from './devices.js'
import { MarsScene } from './scene.js'
import type { MarsSimulation } from './simulation.js'
import { DEVICE_IDS, type DeviceId, PLACES } from './world.js'

/** Profile-owned camera renderer: detached scene views do not interrupt model stills. */
export class MarsCameras {
  private scene: MarsScene | undefined
  private readonly canvas: HTMLCanvasElement
  private readonly encoders = new Map<string, VideoEncoder>()
  private readonly video = new Set<string>()
  private readonly keyframes = new Set<string>()
  private disposed = false
  private capturing = false
  private lastStill = -Infinity
  private lastKeyframe = 0
  error: string | undefined
  constructor(
    private readonly simulation: MarsSimulation,
    document: Document,
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = 640
    this.canvas.height = 360
    for (const id of DEVICE_IDS) {
      const device = simulation.device(id)
      device.onConfigure = async (sources) => {
        const desired = new Set(this.video)
        for (const [source, options] of Object.entries(sources)) {
          if (
            !source.endsWith('_video') ||
            typeof options !== 'object' ||
            options === null ||
            Array.isArray(options)
          )
            continue
          const key = `${id}/${source}`
          if (options.on === true) desired.add(key)
          else desired.delete(key)
        }
        if (desired.size > 2) throw new Error('video-camera-budget')
        for (const key of this.video)
          if (!desired.has(key)) {
            const encoder = this.encoders.get(key)
            if (encoder?.state !== 'closed') encoder?.close()
            this.encoders.delete(key)
          }
        this.video.clear()
        for (const key of desired) this.video.add(key)
      }
      device.onKeyframe = async (source) => {
        this.keyframes.add(`${id}/${source}`)
      }
    }
  }
  retry(): void {
    this.scene?.dispose()
    this.scene = undefined
    for (const encoder of this.encoders.values()) if (encoder.state !== 'closed') encoder.close()
    this.encoders.clear()
    this.error = undefined
  }
  async capture(now: number): Promise<void> {
    if (this.disposed || this.capturing) return
    this.capturing = true
    try {
      this.scene ??= new MarsScene(this.canvas, this.simulation)
      await this.scene.ready
      if (this.disposed) return
      const still = now - this.lastStill >= 1000,
        periodicKeyframe = now - this.lastKeyframe >= 1000
      if (still) this.lastStill = now
      if (periodicKeyframe) this.lastKeyframe = now
      for (const id of DEVICE_IDS)
        for (const source of CAMERA_SOURCES[id] ?? []) {
          if (this.disposed) return
          const key = `${id}/${source}_video`
          if (!still && !this.video.has(key)) continue
          this.render(id, source)
          if (still) {
            const blob = await new Promise<Blob>((resolve, reject) =>
              this.canvas.toBlob(
                (b) => (b ? resolve(b) : reject(new Error('camera-encode-failed'))),
                'image/png',
              ),
            )
            if (this.disposed) return
            this.simulation
              .device(id)
              .publish(source, { w: 640, h: 360 }, new Uint8Array(await blob.arrayBuffer()), 'image/png')
          }
          if (this.video.has(key)) await this.encode(id, source, key, now, periodicKeyframe)
        }
      this.error = undefined
    } catch {
      this.error = 'Camera unavailable. Retry the renderer; no image is fabricated.'
    } finally {
      this.capturing = false
    }
  }
  private render(id: DeviceId, source: string): void {
    const p = this.simulation.pose(id),
      fixed = id === 'cam-base' || id === 'lab-01'
    const preset = this.simulation.state('cam-base').preset
    const look =
      preset === 'field'
        ? PLACES.field
        : preset === 'dock'
          ? PLACES.dock
          : preset === 'pad'
            ? PLACES.pad
            : PLACES.habitat
    this.scene!.render({
      eye: [p.x, p.z + (source === 'hazcam' ? 0.6 : id === 'lab-01' ? 4 : fixed ? 12 : 2), -p.y],
      zoom: id === 'cam-base' ? Number(this.simulation.state(id).zoom) : 1,
      target:
        source === 'hazcam'
          ? [p.x + Math.cos(p.yaw) * 6, 0, -p.y - Math.sin(p.yaw) * 6]
          : id === 'lab-01'
            ? [PLACES.dock.x, 1, -PLACES.dock.y]
            : source === 'down'
              ? [p.x + 0.1, 0, -p.y]
              : fixed
                ? [look.x, 1, -look.y]
                : [p.x + Math.cos(p.yaw) * 25, p.z + 1, -p.y - Math.sin(p.yaw) * 25],
    })
  }
  private async encode(
    id: DeviceId,
    source: string,
    key: string,
    now: number,
    periodic: boolean,
  ): Promise<void> {
    if (typeof VideoEncoder === 'undefined') throw new Error('WebCodecs unavailable')
    let encoder = this.encoders.get(key)
    if (!encoder) {
      const config = {
        codec: 'avc1.42E01E',
        width: 640,
        height: 360,
        bitrate: 800000,
        framerate: 20,
        latencyMode: 'realtime' as const,
        avc: { format: 'annexb' as const },
      }
      if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error('H264 unavailable')
      if (this.disposed || !this.video.has(key)) return
      encoder = new VideoEncoder({
        output: (chunk) => {
          if (this.disposed || !this.video.has(key)) return
          const bytes = new Uint8Array(chunk.byteLength)
          chunk.copyTo(bytes)
          this.simulation
            .device(id)
            .publish(
              `${source}_video`,
              { w: 640, h: 360, key: chunk.type === 'key', codec: 'avc1.42E01E', timestamp: chunk.timestamp },
              bytes,
            )
        },
        error: () => {
          const failed = this.encoders.get(key)
          if (failed?.state !== 'closed') failed?.close()
          this.error = 'Video encoder unavailable. Retry video.'
          this.encoders.delete(key)
        },
      })
      try {
        encoder.configure(config)
      } catch (error) {
        if (encoder.state !== 'closed') encoder.close()
        throw error
      }
      this.encoders.set(key, encoder)
      this.keyframes.add(key)
    }
    if (encoder.encodeQueueSize > 2) {
      this.keyframes.add(key)
      return
    }
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round(now * 1000) })
    try {
      const requested = this.keyframes.delete(key)
      encoder.encode(frame, { keyFrame: periodic || requested })
    } finally {
      frame.close()
    }
  }
  dispose(): void {
    this.disposed = true
    this.scene?.dispose()
    this.scene = undefined
    for (const encoder of this.encoders.values()) if (encoder.state !== 'closed') encoder.close()
    this.encoders.clear()
    this.video.clear()
    for (const device of this.simulation.devices.values()) {
      device.onConfigure = undefined
      device.onKeyframe = undefined
    }
  }
}
