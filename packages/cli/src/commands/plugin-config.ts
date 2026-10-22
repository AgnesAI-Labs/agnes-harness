import type { PluginConfigEntry, PluginConfigSnapshot } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import { newPackageCommandId } from '../tui/package-admin.js'
import type { ParsedArgs } from '../types.js'
import { oneLine } from './sessions-manage.js'
import { readJson } from './triggers.js'

type Obj = Record<string, unknown>
const REDACTED = '[redacted]'
const SECRET_KEY = /secret|password|token|credential|api.?key/i
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Follow local `#/...` references; anything unresolvable is an empty schema. */
function deref(root: Obj, node: unknown): Obj {
  let n = node
  for (let i = 0; i < 8 && isObj(n) && typeof n.$ref === 'string' && n.$ref.startsWith('#/'); i++)
    n = n.$ref
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (at, key) => (isObj(at) ? at[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined),
        root,
      )
  return isObj(n) ? n : {}
}

/** The node itself plus every allOf/anyOf/oneOf branch: a value is secret if any branch says so. */
function branches(root: Obj, node: unknown, depth = 0): Obj[] {
  const self = deref(root, node)
  if (depth > 6) return [self]
  const nested = ['allOf', 'anyOf', 'oneOf'].flatMap((k) =>
    Array.isArray(self[k]) ? (self[k] as unknown[]) : [],
  )
  return [self, ...nested.flatMap((n) => branches(root, n, depth + 1))]
}

const isSecretNode = (n: Obj): boolean =>
  n['x-secret'] === true || n.writeOnly === true || n.format === 'credential-reference'

/**
 * The daemon returns configuration values as stored, so the CLI hides credentials itself: a value is
 * replaced when its schema is marked x-secret/writeOnly/credential-reference, or its key looks like a
 * credential (the same key rule the daemon applies to the audit trail). Empty values carry nothing.
 */
export function redactConfig(root: Obj, schema: unknown, value: unknown, depth = 0): unknown {
  if (value === '' || value === null || value === undefined) return value
  if (depth > 24) return REDACTED
  const nodes = branches(root, schema)
  if (nodes.some(isSecretNode)) return REDACTED
  if (Array.isArray(value))
    return value.map((item) =>
      nodes.reduce<unknown>(
        (v, n) => redactConfig(root, Array.isArray(n.items) ? undefined : n.items, v, depth + 1),
        item,
      ),
    )
  if (!isObj(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (SECRET_KEY.test(key)) return [key, child === '' ? child : REDACTED]
      const candidates = nodes.map(
        (n) => (isObj(n.properties) ? n.properties[key] : undefined) ?? n.additionalProperties,
      )
      return [key, candidates.reduce<unknown>((v, c) => redactConfig(root, c, v, depth + 1), child)]
    }),
  )
}

/** The snapshot as it may be shown: entry values and audit before/after never carry a credential. */
export function redactSnapshot(s: PluginConfigSnapshot): PluginConfigSnapshot {
  const schemas = new Map(s.entries.map((e) => [e.rowId, e.schema]))
  const hide = (schema: unknown, value: unknown) => redactConfig(isObj(schema) ? schema : {}, schema, value)
  return {
    ...s,
    entries: s.entries.map((e) => ({ ...e, value: hide(e.schema, e.value) as PluginConfigEntry['value'] })),
    audit: s.audit.map((a) => ({
      ...a,
      before: hide(schemas.get(a.rowId), a.before) as typeof a.before,
      after: hide(schemas.get(a.rowId), a.after) as typeof a.after,
    })),
  }
}

function schemaSummary(schema: unknown): string {
  if (!isObj(schema)) return schema === false ? 'rejects every value' : 'any value'
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  const props = isObj(schema.properties) ? Object.entries(schema.properties) : []
  const fields = props.map(([k, v]) => {
    const secret = branches(schema, v).some(isSecretNode)
    const t = isObj(v) && typeof v.type === 'string' ? v.type : 'any'
    return `${oneLine(k)}${required.has(k) ? '*' : ''}:${t}${secret ? ' (secret)' : ''}`
  })
  return `${typeof schema.type === 'string' ? schema.type : 'any'}${fields.length ? ` {${fields.join(', ')}}` : ''}`
}

const issueLine = (i: { path: string; code: string }): string =>
  `${oneLine(i.path || '/')}\t${oneLine(i.code)}`

/** `agh plugins config get|validate|set <pluginId> [<rowId>]`; the value comes from --file, never from argv. */
export async function pluginConfigCommand(
  p: ParsedArgs,
  client: NodeClient,
  write: (t: string) => void,
): Promise<number> {
  const [, action, id, rowArg, ...extra] = p.positional
  const profile = p.profile ?? 'local-dev'
  const usage = 'usage: agh plugins config get <pluginId> | validate|set <pluginId> [<rowId>] --file <file|->'
  if (!['get', 'validate', 'set'].includes(action ?? '') || !id || extra.length) throw new UsageError(usage)
  if (action === 'get' && rowArg !== undefined) throw new UsageError(usage)
  const out = (value: unknown, text: string) => write(p.json ? `${JSON.stringify(value)}\n` : text)
  if (action !== 'get' && !p.file) throw new UsageError('the value needs --file <file|->')
  // Read and parse the input first: invalid JSON must not cost a request.
  const value =
    action === 'get' ? undefined : (readJson(p.file as string, 'the value') as PluginConfigEntry['value'])
  const snapshot = await client.packages.config.get({ profile, id })
  if (action === 'get') {
    const shown = redactSnapshot(snapshot)
    const lines = [`${oneLine(id)}\trevision ${oneLine(snapshot.revision)}`]
    for (const [at, entry] of shown.entries.entries()) {
      const stored = snapshot.entries[at] as PluginConfigEntry
      const { issues } = await client.packages.config.validate({
        profile,
        id,
        rowId: stored.rowId,
        value: stored.value,
      })
      lines.push(
        `${oneLine(entry.rowId)}\treload ${entry.reload}\t${issues.length ? `invalid (${issues.length} issues)` : 'valid'}`,
        `  value ${oneLine(JSON.stringify(entry.value))}`,
        `  schema ${schemaSummary(entry.schema)}`,
        ...issues.map((i) => `  issue ${issueLine(i)}`),
      )
    }
    lines.push(`audit ${shown.audit.length} entries`)
    out(shown, `${lines.join('\n')}\n`)
    return ExitCode.OK
  }
  const rows = snapshot.entries.map((e) => e.rowId)
  const rowId = rowArg ?? (rows.length === 1 ? rows[0] : undefined)
  if (rowId === undefined || !rows.includes(rowId))
    throw new UsageError(
      `${rows.length ? `choose a row: ${rows.map(oneLine).join(', ')}` : 'plugin declares no configuration'}; ${usage}`,
    )
  const { issues } = await client.packages.config.validate({ profile, id, rowId, value: value as never })
  if (action === 'validate' || issues.length) {
    out({ issues }, issues.length ? `${issues.map(issueLine).join('\n')}\n` : 'valid\n')
    if (issues.length && action === 'set' && !p.json) write('not saved\n')
    return issues.length ? ExitCode.ERROR : ExitCode.OK
  }
  const result = await client.packages.config.save({
    profile,
    id,
    rowId,
    value: value as never,
    expectedRevision: snapshot.revision,
    clientId: await client.clientId(),
    commandId: newPackageCommandId('config'),
  })
  const head = result.ok
    ? 'saved'
    : `not saved: ${result.reason}${result.refusalReason ? ` ${oneLine(result.refusalReason)}` : ''}`
  out(
    result,
    `${head}\t${oneLine(rowId)}\treload ${result.reload}\n${result.issues.map((i) => `${issueLine(i)}\n`).join('')}`,
  )
  return result.ok ? ExitCode.OK : ExitCode.ERROR
}
