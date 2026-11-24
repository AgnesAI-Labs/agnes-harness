import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { normalize } from './tokenize.js'

const abbreviations: Record<string, string> = {
  pg: 'postgresql',
  k8s: 'kubernetes',
  ts: 'typescript',
  js: 'javascript',
  db: 'database',
  ci: 'continuous integration',
  pr: 'pull request',
  auth: 'authentication',
  env: 'environment',
  cfg: 'config',
  repo: 'repository',
  fn: 'function',
  impl: 'implementation',
  doc: 'documentation',
  ws: 'websocket',
  sql: 'structured query language',
  api: 'application programming interface',
  sdk: 'software development kit',
  cli: 'command line interface',
  ui: 'user interface',
  llm: 'large language model',
  jwt: 'json web token',
  oauth: 'open authorization',
  rpc: 'remote procedure call',
  grpc: 'grpc remote procedure calls',
  mcp: 'model context protocol',
  cdn: 'content delivery network',
  orm: 'object relational mapping',
  crud: 'create read update delete',
  dns: 'domain name system',
  tls: 'transport layer security',
  ssh: 'secure shell',
  http: 'hypertext transfer protocol',
}

export type AliasMap = ReadonlyMap<string, readonly string[]>

function aliases(custom: Record<string, unknown> = {}): AliasMap {
  const result = new Map<string, string[]>()
  const add = (a: string, b: string) => {
    const existing = result.get(a) ?? []
    if (!existing.includes(b)) existing.push(b)
    result.set(a, existing)
  }
  for (const [key, value] of [...Object.entries(abbreviations), ...Object.entries(custom)]) {
    for (const alternative of Array.isArray(value) ? value : [value]) {
      if (typeof alternative !== 'string') continue
      const a = normalize(key).trim()
      const b = normalize(alternative).trim()
      if (!a || !b || a.length > 128 || b.length > 128) continue
      add(a, b)
      add(b, a)
    }
  }
  return result
}

export const technicalAliases = aliases()

/** Optional JSON object mapping terms to a spelling or an array of spellings. */
export function loadAliases(root: string): AliasMap {
  const path = join(root, 'aliases.json')
  const stat = statSync(path, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size > 256 * 1024) return technicalAliases
  try {
    const custom: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (custom && typeof custom === 'object' && !Array.isArray(custom))
      return aliases(custom as Record<string, unknown>)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  return technicalAliases
}
