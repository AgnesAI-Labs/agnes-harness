import { isAbsolute, relative, resolve } from 'node:path'
import { looksLikeSecret } from '@agnes/error-sanitization'
import type { ObservabilitySession } from '@agnes/extension-api'
import { type ObservabilityConfig, resolveHeaders } from './config.js'

const sensitive = /secret|password|authorization|credential|api.?key|cookie|token/i
const normalizedPath = (value: string): string => {
  const path = value.replaceAll('\\', '/')
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path
}
/** Bounded copy of public event content. No filesystem or secret-store reads. */
export function exportContent(
  value: unknown,
  config: ObservabilityConfig,
  context: ObservabilitySession,
): string {
  const roots = (context.privateRoots ?? [])
    .filter(Boolean)
    .map((root) => normalizedPath(root).replace(/\/+$/, '') || '/')
  const references = context.workspace
    ? roots.map((root) => normalizedPath(relative(context.workspace!, root))).filter(Boolean)
    : []
  const privateText = (text: string) => {
    const normalized = normalizedPath(text)
    return (
      roots.some((root) => root && normalized.includes(root)) ||
      references.some((reference) => normalized.includes(reference)) ||
      (context.workspace &&
        !isAbsolute(text) &&
        roots.some((root) => {
          const path = normalizedPath(resolve(context.workspace!, text))
          return path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
        }))
    )
  }
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0,
    chars = 0
  while (pending.length) {
    const entry = pending.pop()!
    if (++nodes > 256 || entry.depth > 8) return '<omitted>'
    if (typeof entry.value === 'string') {
      chars += entry.value.length
      if (chars > 16384 || privateText(entry.value)) return '<omitted>'
    } else if (entry.value && typeof entry.value === 'object') {
      for (const key in entry.value) {
        if (!Object.hasOwn(entry.value, key)) continue
        chars += key.length
        if (pending.length + nodes > 256 || chars > 16384 || privateText(key)) return '<omitted>'
        pending.push({ value: (entry.value as Record<string, unknown>)[key], depth: entry.depth + 1 })
      }
    }
  }
  try {
    const json = JSON.stringify(value) ?? 'null'
    if (json.length > 16384) return '<omitted>'
    const secrets = [
      ...Object.values(resolveHeaders(config)),
      ...Object.entries(process.env).flatMap(([name, secret]) =>
        sensitive.test(name) && secret ? [secret] : [],
      ),
    ].flatMap((secret) => [secret, secret.replace(/^(?:Bearer|Basic)\s+/i, '')])
    const secretText = (text: string) =>
      looksLikeSecret(text) ||
      secrets.some((secret) => text.includes(secret)) ||
      /\bBearer\s+\S+|\b(?:password|secret|api[_-]?key|token)\s*[:=]\s*\S+/i.test(text)
    // A key can itself contain a credential. Withhold the object rather than preserve that key.
    const scrubbed = JSON.stringify(JSON.parse(json), (key, item: unknown) => {
      if (secretText(key)) throw new Error('Content omitted')
      if (sensitive.test(key) || (typeof item === 'string' && secretText(item))) return '<redacted>'
      return item
    })
    return scrubbed.length <= 4096 ? scrubbed : '<omitted>'
  } catch {
    return '<omitted>'
  }
}
