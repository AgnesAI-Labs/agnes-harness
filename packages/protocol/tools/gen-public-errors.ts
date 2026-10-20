import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGNES_ERRORS, JSONRPC_ERRORS } from '../src/errors.js'

type Copy = { reason: string; action: string }
type Entry = {
  const: string
  'x-public-error': {
    rpc: string
    messageKey: string
    copy: string
    reasons?: Record<string, string>
    boot?: boolean
    skillInstall?: boolean
  }
}

/** The cause schema is the sole allowlist and public-copy source for all error boundaries. */
export function writePublicErrors(pkg: string, check: boolean): number {
  const schema = JSON.parse(readFileSync(join(pkg, 'schema/app-server.json'), 'utf8'))
  const entries: Entry[] = schema.$defs.AppServerErrorCause.properties.code.anyOf
  const copy: Record<string, { en: Copy; 'zh-CN': Copy }> = schema['x-public-error-copy']
  const keys: string[] = schema.$defs.AppServerError.properties.data.properties.messageKey.enum
  for (const [key, localized] of Object.entries(copy))
    for (const locale of ['en', 'zh-CN'] as const)
      for (const field of ['reason', 'action'] as const) {
        const text = localized[locale]?.[field]
        if (!text || text.length > 512 || [...text].some((char) => char.charCodeAt(0) < 32))
          throw new Error(`Invalid public error copy: ${key}/${locale}/${field}`)
      }
  const seen = new Set<string>()
  const rows: string[] = []
  const reference = (key: string): string => {
    if (!Object.hasOwn(copy, key)) throw new Error(`Unknown public error copy: ${key}`)
    return `PUBLIC_ERROR_COPY[${JSON.stringify(key)}]`
  }
  for (const row of entries) {
    const metadata = row['x-public-error']
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(row.const) ||
      seen.has(row.const) ||
      !Object.hasOwn({ ...AGNES_ERRORS, ...JSONRPC_ERRORS }, metadata.rpc) ||
      !keys.includes(metadata.messageKey)
    )
      throw new Error(`Invalid public error contract: ${row.const}`)
    seen.add(row.const)
    const reasons = Object.entries(metadata.reasons ?? {}).map(([reason, key]) => {
      if (!/^[a-z][a-z0-9 /-]{0,127}$/.test(reason)) throw new Error(`Invalid public reason: ${reason}`)
      return `${JSON.stringify(reason)}: ${reference(key)}`
    })
    rows.push(
      `  ${JSON.stringify(row.const)}: { rpc: ${JSON.stringify(metadata.rpc)}, messageKey: ${JSON.stringify(metadata.messageKey)}, boot: ${metadata.boot === true}, skillInstall: ${metadata.skillInstall === true}, localized: ${reference(metadata.copy)}, reasons: { ${reasons.join(', ')} } },`,
    )
  }
  const messages = keys.map(
    (key) => `  ${JSON.stringify(key)}: ${reference(key.slice('appServer.errors.'.length))},`,
  )
  const source =
    '// generated from schema/app-server.json by tools/gen.ts — do not edit\n' +
    `const PUBLIC_ERROR_COPY = ${JSON.stringify(copy, null, 2)} as const\n` +
    `export const PUBLIC_ERROR_CONTRACT = {\n${rows.join('\n')}\n} as const\n` +
    `export const PUBLIC_ERROR_MESSAGES = {\n${messages.join('\n')}\n} as const\n`
  const output = join(pkg, 'gen/ts/public-errors.ts')
  if (existsSync(output) && readFileSync(output, 'utf8') === source) return 0
  if (check) {
    console.error('stale: gen/ts/public-errors.ts')
    return 1
  }
  writeFileSync(output, source)
  return 0
}
