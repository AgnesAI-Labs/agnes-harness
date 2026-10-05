import type { ComparisonCreateParams } from '@agnes/protocol'

export type ComparisonPendingInput = { inputId: string; text: string }
export type ComparisonCreation = { params: ComparisonCreateParams; firstInput?: ComparisonPendingInput }
export type ComparisonEntry = {
  id: string
  pending?: ComparisonPendingInput
  creation?: ComparisonCreation
  draft?: string
}

const latestKey = 'agnes-web-comparison'
const entryKey = (id: string) => `${latestKey}:${id}`

function decode(raw: string | null): ComparisonEntry | undefined {
  if (raw === null) return undefined
  try {
    const value = JSON.parse(raw) as ComparisonEntry
    if (!value || typeof value.id !== 'string' || !value.id) throw new Error()
    for (const input of [value.pending, value.creation?.firstInput])
      if (input && (typeof input.inputId !== 'string' || !input.inputId || typeof input.text !== 'string'))
        throw new Error()
    if (value.creation) {
      const p = value.creation.params
      if (
        !p ||
        p.requestId !== value.id ||
        typeof p.cwd !== 'string' ||
        typeof p.left?.runtime !== 'string' ||
        typeof p.right?.runtime !== 'string'
      )
        throw new Error()
    }
    if (value.draft !== undefined && typeof value.draft !== 'string') throw new Error()
    return value
  } catch {
    throw new Error('保存的对比提交记录无法读取；请保留浏览器数据并核对历史，不能当作未提交重新创建。')
  }
}

/** Browser recovery intent only; the server comparison and lane ledgers remain authoritative. */
export function readComparisonEntry(id?: string): ComparisonEntry | undefined {
  if (id) {
    const entry = decode(sessionStorage.getItem(entryKey(id)))
    if (entry) {
      if (entry.id !== id) throw new Error('保存的对比身份不匹配。')
      return entry
    }
  }
  const latest = decode(sessionStorage.getItem(latestKey))
  return !id || latest?.id === id ? latest : undefined
}

/** Must succeed before sending creation/input, so reload never loses the retry identity. */
export function writeComparisonEntry(entry: ComparisonEntry): void {
  const raw = JSON.stringify(entry)
  sessionStorage.setItem(entryKey(entry.id), raw)
  sessionStorage.setItem(latestKey, raw)
}

export function forgetComparisonEntry(id: string): void {
  sessionStorage.removeItem(entryKey(id))
  if (readComparisonEntry()?.id === id) sessionStorage.removeItem(latestKey)
}

export function clearLatestComparisonEntry(): void {
  sessionStorage.removeItem(latestKey)
}
