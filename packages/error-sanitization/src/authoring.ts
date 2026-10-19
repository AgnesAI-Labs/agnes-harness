import { DEFAULT_RULES, redactText } from './redact.js'
import { looksLikeSecret } from './secret-shapes.js'

const hints = {
  'conflicting-write-path': 'A path cannot be in both files and remove. / 同一路径不能同时写入和删除。',
  'missing-remove-path':
    'Remove only a path present in the current candidate. / 只能删除当前候选中存在的路径。',
  'unknown-theme-token': 'Use a supported semantic theme token. / 请使用受支持的语义主题 token。',
  'invalid-field': 'Correct this field using the package contract. / 请按插件合同修正此字段。',
  'missing-required-file':
    'Read the candidate and preserve the complete file tree. / 读取候选并保留完整文件树。',
  'no-progress':
    'Read the diagnostics or read the same candidate before editing again. / 请先阅读诊断或重新读取同一候选。',
} as const
export type AuthoringDiagnostic = {
  code: keyof typeof hints
  path: string
  field: string
  name: string
  hint: string
}
export function safePackagePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 240 &&
    /^(?:\.\/)?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(value) &&
    !value.split('/').includes('..') &&
    !looksLikeSecret(value)
  )
}
/** Rebuild allowlisted fields; never forward arbitrary validator messages, hints or stacks. */
export function safeAuthoringDiagnostics(value: unknown): AuthoringDiagnostic[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 16).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const { code, path, field, name } = item
    if (
      typeof code !== 'string' ||
      !Object.hasOwn(hints, code) ||
      !safePackagePath(path) ||
      typeof field !== 'string' ||
      field.length > 160 ||
      !/^[A-Za-z0-9_.$[\]-]*$/.test(field) ||
      typeof name !== 'string' ||
      name.length > 240 ||
      !/^[A-Za-z0-9_./-]*$/.test(name) ||
      (name && !safePackagePath(name)) ||
      looksLikeSecret(field)
    )
      return []
    return [{ code: code as keyof typeof hints, path, field, name, hint: hints[code as keyof typeof hints] }]
  })
}
export function authoringDiagnosticText(value: unknown): string {
  return safeAuthoringDiagnostics(value)
    .map((d) => {
      const reason =
        d.code === 'unknown-theme-token'
          ? `unsupported token ${d.name}`
          : d.code === 'missing-required-file'
            ? `complete file tree is missing ${d.name}`
            : d.code
      return `${reason} (${d.path}, ${d.field}). ${d.hint}`
    })
    .join('\n')
}
/** Bound after redaction so truncation cannot expose the prefix of a credential or private path. */
export function safeAuthoringOutput(value: string, maxBytes = 16384, directory?: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal escape sequences from untrusted test output.
  let text = value.slice(0, 262144).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  if (directory) {
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(directory)
    const path = (windows ? directory.replace(/\\/g, '/') : directory).replace(/\/$/, '')
    // Stay browser-safe: encode only the known candidate directory, never arbitrary output.
    const urlPath = path.startsWith('//') ? path.slice(2) : path.startsWith('/') ? path : `/${path}`
    const url = `file://${encodeURI(urlPath).replace(/[?#]/g, encodeURIComponent)}`
    const prefixes = [url, `file://${path}`, path, directory.replace(/[\\/]$/, '')]
    // Node's TAP reporter quotes Windows locations with doubled backslashes.
    if (windows) prefixes.push(directory.replace(/[\\/]$/, '').replace(/\\/g, '\\\\'))
    for (const prefix of new Set(prefixes)) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const separator = windows ? '[\\\\/]+' : '/'
      const pattern = new RegExp(
        `${escaped}${separator}(?:node_modules${separator}\\.authoring-tests${separator})?([^\\s'"<>]*)`,
        windows ? 'gi' : 'g',
      )
      text = text.replace(
        pattern,
        (_match, relative: string) => `./${windows ? relative.replace(/\\+/g, '/') : relative}`,
      )
    }
  }
  let stackIndent: number | undefined
  text = redactText(text, DEFAULT_RULES)
    .text.replace(/(?:file:\/\/|[A-Za-z]:[\\/]|\/|\\\\)[^\s'"<>]+/g, (path, offset, source) =>
      offset > 0 && /[A-Za-z0-9_.]/.test(source[offset - 1]) ? path : '[REDACTED:path]',
    )
    .split('\n')
    .map((line) => (looksLikeSecret(line) ? '[REDACTED:secret]' : line))
    .filter((line) => {
      if (/^\s*stack:/.test(line)) {
        stackIndent = line.length - line.trimStart().length
        return false
      }
      if (stackIndent !== undefined && (!line.trim() || line.length - line.trimStart().length > stackIndent))
        return false
      stackIndent = undefined
      return !/^\s*at\s/.test(line)
    })
    .join('\n')
    .split('')
    .filter(
      (char) => char === '\n' || char === '\t' || (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    )
    .join('')
  const marker = '\n[truncated]'
  if (new TextEncoder().encode(text).length <= maxBytes && value.length <= 262144) return text
  const bytes = new TextEncoder().encode(text)
  let end = Math.min(bytes.length, maxBytes - new TextEncoder().encode(marker).length)
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.subarray(0, end)) + marker
}

/** Prefer failure names/assertions and locations over passing TAP chatter. */
export function authoringFailureSummary(output: string): string {
  const safe = safeAuthoringOutput(output)
  const lines = safe.split('\n')
  const failures = lines.flatMap((line, index) => {
    if (
      /^\s*(?:not ok\b|CompileError:|(?:error|name|code|location|failureType|expected|actual|operator):)/.test(
        line,
      )
    )
      return lines.slice(index, index + (/(?:error|expected|actual):/.test(line) ? 5 : 1))
    return []
  })
  const selected = [...new Set(failures)].join('\n') || safe
  return safeAuthoringOutput(
    selected + (safe.includes('[truncated]') && !selected.includes('[truncated]') ? '\n[truncated]' : ''),
    3072,
  )
}
