export const MODEL_NAMES = [
  'rover',
  'suit',
  'moon_rock_01',
  'moon_rock_03',
  'moon_rock_05',
  'moon_rock_07',
  'namaqualand_boulder_02',
] as const
export type ModelName = (typeof MODEL_NAMES)[number]
/** The package snapshot verifies hashes. Only these fixed same-origin offline assets are loaded. */
export async function loadModels(signal: AbortSignal): Promise<Map<ModelName, Float32Array>> {
  return new Map(
    await Promise.all(
      MODEL_NAMES.map(async (name) => {
        const response = await fetch(new URL(`../assets/${name}.bin`, import.meta.url), { signal })
        if (!response.ok) throw new Error('model-asset-unavailable')
        const buffer = await response.arrayBuffer()
        if (buffer.byteLength > 32 * 1024 * 1024 || buffer.byteLength % 72 !== 0)
          throw new Error('invalid-model-asset')
        const values = new Float32Array(buffer),
          lo = [Infinity, Infinity, Infinity],
          hi = [-Infinity, -Infinity, -Infinity]
        for (let i = 0; i < values.length; i += 6)
          for (let k = 0; k < 3; k++) {
            const v = values[i + k]!
            if (!Number.isFinite(v)) throw new Error('invalid-model-asset')
            lo[k] = Math.min(lo[k]!, v)
            hi[k] = Math.max(hi[k]!, v)
          }
        const size = Math.max(...hi.map((v, k) => v - lo[k]!)) || 1
        for (let i = 0; i < values.length; i += 6)
          for (let k = 0; k < 3; k++)
            values[i + k] = (values[i + k]! - (k === 1 ? lo[k]! : (hi[k]! + lo[k]!) / 2)) / size
        return [name, values] as const
      }),
    ),
  )
}
