/** Colours for canvas drawing: CSS colours read back as red, green and blue. */
export type Rgb = [number, number, number]

/** A CSS colour as red, green and blue, read back through the canvas, which normalises it. */
export function rgbOf(ctx: CanvasRenderingContext2D, color: string, fallback: Rgb): Rgb {
  ctx.fillStyle = '#000000'
  ctx.fillStyle = color
  const v = String(ctx.fillStyle)
  if (v.startsWith('#') && v.length === 7)
    return [1, 3, 5].map((i) => Number.parseInt(v.slice(i, i + 2), 16)) as Rgb
  const m = v.match(/\d+(\.\d+)?/g)
  return m && m.length >= 3 ? (m.slice(0, 3).map(Number) as Rgb) : fallback
}

export const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r}, ${g}, ${b}, ${a})`

/** `a` moved towards `b` by `k` (0 to 1). */
export const mix = (a: Rgb, b: Rgb, k: number): Rgb =>
  a.map((v, i) => Math.round(v + ((b[i] as number) - v) * k)) as Rgb
