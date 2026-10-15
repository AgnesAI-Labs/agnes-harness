import { useEffect, useState } from 'react'
import { type Sample, sampleFrom } from './media.js'
import { array, type Device, number, record, text } from './model.js'
import { useMhs } from './react.js'

export function gridBounds(sample: Sample): [number, number, number, number] {
  const bytes = sample.bytes,
    resolution = number(sample.data.resolution),
    origin = array(sample.data.origin)
  if (
    !bytes ||
    bytes.length < 24 ||
    bytes[0] !== 137 ||
    bytes[1] !== 80 ||
    bytes[2] !== 78 ||
    bytes[3] !== 71 ||
    resolution <= 0 ||
    origin.length !== 2 ||
    !origin.every((v) => typeof v === 'number' && Number.isFinite(v))
  )
    throw new Error('invalid-grid')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    w = view.getUint32(16),
    h = view.getUint32(20)
  if (w < 1 || h < 1 || w * h > 16_777_216) throw new Error('invalid-grid')
  return [
    number(origin[0]),
    number(origin[1]),
    number(origin[0]) + w * resolution,
    number(origin[1]) + h * resolution,
  ]
}
/** Only grid sources belonging to this map are projected; no URL is accepted from a device. */
export function MapGrid({
  map,
  device,
  source,
  xy,
}: {
  map: string
  device: Device
  source: string
  xy(x: number, y: number): [number, number]
}) {
  const { client } = useMhs(),
    [image, setImage] = useState<{ url: string; bounds: [number, number, number, number] }>()
  useEffect(() => {
    const abort = new AbortController()
    let url = ''
    void client
      .stream(
        'media',
        { device: device.id, source },
        (frame) => {
          try {
            const sample = sampleFrom(frame)
            if (sample.device !== device.id || sample.source !== source || sample.data.id !== map) return
            const bounds = gridBounds(sample),
              next = URL.createObjectURL(new Blob([sample.bytes!.slice().buffer], { type: 'image/png' }))
            if (url) URL.revokeObjectURL(url)
            url = next
            setImage({ url, bounds })
          } catch {
            /* Invalid samples never replace the last valid bounded grid. */
          }
        },
        abort.signal,
      )
      .catch(() => {})
    return () => {
      abort.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [client, device.id, source, map])
  if (!image) return null
  const [x0, y0, x1, y1] = image.bounds,
    [x, y] = xy(x0, y1),
    [right, bottom] = xy(x1, y0)
  return (
    <image
      href={image.url}
      x={x}
      y={y}
      width={right - x}
      height={bottom - y}
      preserveAspectRatio="none"
      aria-label={`${map} occupancy`}
    />
  )
}
export function gridSources(devices: readonly Device[], map: string) {
  return devices
    .filter((d) => d.online && d.position.map === map)
    .flatMap((device) =>
      device.sources
        .filter(
          (s) =>
            s.kind === 'grid' &&
            (device.sourceStates[text(s.id)] === true || s.default !== false) &&
            record(s.ui).hidden !== true,
        )
        .map((source) => ({ device, source: text(source.id) })),
    )
}
