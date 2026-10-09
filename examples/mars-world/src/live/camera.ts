import type { Device, Source } from '@agnes/mhs/device'
import * as THREE from 'three'
import { every, type World } from './world.js'

/** Highest video rate; the hub's mhs/configure may ask for less. */
const VIDEO_HZ = 20
/** Longest time between keyframes, in seconds (VID-5: at most 2). */
const GOP_S = 1
/** Video bitrate range in kbit/s; before mhs/configure the lowest applies (MOS 8). */
const BITRATE_KBPS = [600, 2000]
/** An encoder nobody has wanted for this long is closed, to free it. */
const IDLE_MS = 5000
/** A picture still waiting this long after its turn to go out is stale and dropped (MOS 9). */
const STALE_MS = 300

export interface CameraOptions {
  /** Id of the still-image source; the video source is `<id>_video`. */
  id: string
  /** What the camera is and where it looks. */
  description: string
  /** Mount in the body frame (MHS 3.4): x forward, y left, z up in metres; roll, pitch, yaw in degrees. */
  mount: { xyz: [number, number, number]; rpy: [number, number, number] }
  size?: [number, number]
  /** The video is part of the device's default view. */
  default?: boolean
  /** Also stream live video (default true); false for a camera that only takes stills. */
  video?: boolean
}

/** Every camera's video, encoded only while its source is wanted. */
const feeds: VideoFeed[] = []
let ticking = false

/**
 * Gives `dev` a camera: a still `image` source (JPEG, 1 Hz) that a model can read, and a `video`
 * source (H.264, Annex B, MOS 7) for people to watch, both rendered from `camera` and only while
 * the hub wants them.
 */
export function addCamera(
  dev: Device,
  world: World,
  camera: THREE.PerspectiveCamera,
  options: CameraOptions,
  log: (line: string) => void,
): void {
  const [w, h] = options.size ?? [640, 360]
  camera.aspect = w / h
  // Far enough for the sky dome, which follows the camera.
  camera.far = 4000
  camera.updateProjectionMatrix()
  const hfov = Math.round(
    (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect) * 180) / Math.PI,
  )
  const fov_deg = [hfov, Math.round(camera.fov)]
  const still = dev.source(options.id, 'image', options.description, {
    hz: 1,
    mime: 'image/jpeg',
    encoding: 'rgb',
    size: [w, h],
    fov_deg,
    mount: options.mount,
  })
  every(
    1000,
    async () => {
      if (!still.wants()) return
      still.send({ w, h }, await world.snapshot(camera, w, h))
    },
    log,
  )
  if (options.video === false) return
  const video = dev.source(`${options.id}_video`, 'video', `${options.description}; live video`, {
    hz: VIDEO_HZ,
    codec: 'h264',
    profile: 'baseline',
    encoding: 'rgb',
    size: [w, h],
    fov_deg,
    bitrate_kbps: BITRATE_KBPS,
    gop_s: GOP_S,
    mount: options.mount,
    ...(options.default ? { default: true } : {}),
  })
  feeds.push(new VideoFeed(world, camera, video, w, h, log))
  if (!ticking) {
    ticking = true
    // One timer for every feed, fine enough that each keeps its own pace within a few ms.
    every(
      5,
      () => {
        const now = performance.now()
        for (const feed of feeds) feed.tick(now)
      },
      log,
    )
  }
}

/** An encoded picture waiting for its turn to go out. */
interface Chunk {
  key: boolean
  bytes: Uint8Array
  t: number
  /** When the picture was taken, on the page's clock (ms). */
  taken: number
}

/**
 * One camera's H.264 stream through the browser's WebCodecs encoder. Pictures are taken on a
 * steady clock at the source's rate and read back from the GPU without stalling the page; the
 * encoded ones go out in order, each as soon as the source's rate allows.
 */
class VideoFeed {
  private encoder: VideoEncoder | undefined
  private kbps = 0
  private hz = 0
  private lastKey = -Infinity
  private lastWanted = 0
  /** When the next picture is due, and when the one being read back was taken. */
  private due = 0
  private takenAt = 0
  private reading = false
  private readonly out: Chunk[] = []
  /** A picture was not sent: nothing but a keyframe may follow (VID-7). */
  private broken = true

  constructor(
    private readonly world: World,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly source: Source,
    private readonly w: number,
    private readonly h: number,
    private readonly log: (line: string) => void,
  ) {}

  tick(now: number): void {
    if (!this.source.on) {
      // Pictures taken before the source went off are stale by the time it is on again.
      this.out.length = 0
      this.reading = false
      this.broken = true
      if (this.encoder && now - this.lastWanted > IDLE_MS) this.close()
      return
    }
    this.lastWanted = now
    this.flush()
    const hz = this.source.hz ?? VIDEO_HZ
    const kbps = this.source.bitrateKbps ?? (BITRATE_KBPS[0] as number)
    if (!this.encoder || this.encoder.state === 'closed' || kbps !== this.kbps || hz !== this.hz)
      this.open(kbps, hz)
    const encoder = this.encoder as VideoEncoder
    if (this.reading) {
      const rows = this.world.collect(this.camera)
      if (!rows) return
      this.reading = false
      const key =
        this.broken || this.source.keyframeRequested || this.takenAt - this.lastKey >= GOP_S * 1000 - 500 / hz
      if (key) {
        this.lastKey = this.takenAt
        this.source.keyframeRequested = false
      }
      const frame = new VideoFrame(rows, {
        format: 'RGBA',
        codedWidth: this.w,
        codedHeight: this.h,
        timestamp: Math.round(this.takenAt * 1000),
      })
      encoder.encode(frame, { keyFrame: key })
      frame.close()
    }
    // The next picture, on time; one that cannot be taken now (the encoder is behind) waits a tick.
    if (now < this.due || encoder.encodeQueueSize > 1) return
    const period = 1000 / hz
    this.due = Math.max(this.due + period, now - period / 2)
    this.takenAt = now
    this.world.capture(this.camera, this.w, this.h)
    this.reading = true
  }

  private open(kbps: number, hz: number): void {
    this.close()
    this.kbps = kbps
    this.hz = hz
    this.encoder = new VideoEncoder({
      output: (chunk) => this.encoded(chunk),
      error: (e) => {
        this.log(`video ${this.source.id}: ${String(e)}`)
        this.close()
      },
    })
    this.encoder.configure({
      // Constrained baseline, level 3.1: no B-frames (VID-4), decodable everywhere.
      codec: 'avc1.42e01f',
      width: this.w,
      height: this.h,
      bitrate: kbps * 1000,
      framerate: hz,
      latencyMode: 'realtime',
      // Annex B with start codes; keyframes carry SPS and PPS (VID-2, VID-3).
      avc: { format: 'annexb' },
    })
    this.broken = true
  }

  private close(): void {
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close()
    this.encoder = undefined
    this.reading = false
    this.out.length = 0
    this.broken = true
  }

  private encoded(chunk: EncodedVideoChunk): void {
    const bytes = new Uint8Array(chunk.byteLength)
    chunk.copyTo(bytes)
    this.out.push({
      key: chunk.type === 'key',
      bytes,
      t: (performance.timeOrigin + chunk.timestamp / 1000) / 1000,
      taken: chunk.timestamp / 1000,
    })
    this.flush()
  }

  /**
   * Sends the encoded pictures in order, each once the source's rate allows. A picture that waited
   * longer than one period and STALE_MS (the encoder starting up, a stalled page) is dropped, so
   * the stream catches up instead of staying behind (MOS 9).
   */
  private flush(): void {
    const stale = 1000 / (this.source.hz ?? VIDEO_HZ) + STALE_MS
    while (this.out.length > 0 && this.source.wants()) {
      const { key, bytes, t, taken } = this.out.shift() as Chunk
      if (performance.now() - taken > stale) {
        this.broken = true
        continue
      }
      // After a lost picture, only a keyframe may go out; the next picture taken will be one.
      if (this.broken && !key) continue
      this.broken = !this.source.send({ key, w: this.w, h: this.h }, bytes, { t })
    }
    // Far behind: drop what waits and start again from a keyframe.
    if (this.out.length > 4) {
      this.out.length = 0
      this.broken = true
    }
  }
}
