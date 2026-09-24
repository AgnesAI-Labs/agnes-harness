import { detectDependencyCycle, persistSecretRef } from './dependency-graph.js'
import type { PluginRow } from './plugin-row.js'

const SECRET_KEYS = /(?:secret|token|password|credential|apikey)$/i

function walkSecrets(value: unknown, path: string): void {
  if (typeof value === 'string') {
    const secretScheme = ['secret', '://'].join('')
    if (value.startsWith('secret:') && !value.startsWith(secretScheme)) {
      throw new Error(`E_SECRET_REF: ${path} must persist ${secretScheme} references`)
    }
    if (SECRET_KEYS.test(path.split('.').at(-1) ?? '')) persistSecretRef(value)
    return
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) walkSecrets(item, `${path}[${index}]`)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) walkSecrets(nested, path ? `${path}.${key}` : key)
  }
}

/** Reject dependency cycles and plaintext secrets before a target may be published. */
export function assertPublishableRows(rows: readonly Readonly<PluginRow>[]): void {
  const nodes = rows.map((row) => row.id)
  const edges = rows.flatMap((row) => (row.inject ?? []).map((to) => ({ from: row.id, to })))
  const cycle = detectDependencyCycle(nodes, edges)
  if (cycle) throw new Error(`E_DEPENDENCY_CYCLE: ${cycle.join(' -> ')}`)
  for (const row of rows) {
    if (row.id.startsWith('policy:') && !row.plugin.startsWith('builtin:')) {
      throw new Error(`E_POLICY_BUILTIN: ${row.id} may only be provided by a builtin factory`)
    }
    if (row.config !== undefined) walkSecrets(row.config, row.id)
  }
}
