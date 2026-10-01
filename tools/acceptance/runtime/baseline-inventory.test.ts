import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildInventory,
  entryProblems,
  IMPLEMENTATION_BASELINE,
  INVENTORY_CLASSES,
  type Inventory,
  type InventoryEntry,
  inventoryDifferences,
  serializeInventory,
} from './inventory.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('baseline behavior inventory', () => {
  it('reads the implementation start twice as the same bytes', { timeout: 180_000 }, () => {
    const first = buildInventory(root, IMPLEMENTATION_BASELINE)
    const second = buildInventory(root, IMPLEMENTATION_BASELINE)
    expect(serializeInventory(first)).toBe(serializeInventory(second))
    expect(first.baseline).toBe(IMPLEMENTATION_BASELINE)
    expect(inventoryDifferences(first, second)).toEqual([])
    for (const name of INVENTORY_CLASSES) expect(first.counts[name]).toBeGreaterThan(0)
    expect(symbols(first)).toEqual(
      expect.arrayContaining([
        '_agnes/v1/session.rename',
        '_agnes/v1/session.archive',
        '_agnes/v1/computerUse.status',
        '_agnes/v1/resources.list',
        'initialize',
        'runAcp',
        '/help',
        'dingtalk',
        'SessionMeta.title',
        'index.html',
        'session_start',
        'HOOK_TABLE',
        'x/host/session-title',
        'session_preferences.title',
      ]),
    )
    for (const name of INVENTORY_CLASSES) expect(first.discovery[name].digest).toContain('sha256')
    expect(first.entries.some((entry) => entry.path.endsWith('-driver-backend.ts'))).toBe(true)
    expect(first.entries.every((entry) => entry.disposition === 'preserve')).toBe(true)
  })

  it('follows a fixture tree and rejects a frozen or altered inventory', { timeout: 60_000 }, () => {
    const fixture = writeFixture()
    try {
      expect(() => buildInventory(fixture, IMPLEMENTATION_BASELINE)).toThrow(
        new RegExp(`${IMPLEMENTATION_BASELINE}[\\s\\S]*full checkout \\(fetch-depth: 0\\)`),
      )
      const committed = buildInventory(fixture, 'HEAD')
      const before = committed.counts.test
      writeFileSync(join(fixture, 'packages/core/test/extra.test.ts'), 'export {}\n')
      expect(buildInventory(fixture, 'HEAD').counts.test).toBe(before)
      commit(fixture, 'add another test')
      const grown = buildInventory(fixture, 'HEAD')
      expect(grown.counts.test).toBe(before + 1)
      expect(inventoryDifferences(grown, grown)).toEqual([])

      const missing = clone(grown)
      missing.entries = missing.entries.slice(1)
      expect(inventoryDifferences(missing, grown).join('\n')).toContain('missing entry')

      const forged = clone(grown)
      const sample = forged.entries[0]
      if (!sample) throw new Error('fixture inventory is empty')
      forged.entries = [
        ...forged.entries,
        { ...sample, id: 'forged|missing.ts|nope', path: 'missing.ts', symbol: 'nope' },
      ]
      expect(inventoryDifferences(forged, grown).join('\n')).toContain('forged entry')

      const digested = clone(grown)
      const target = digested.entries[0]
      if (!target) throw new Error('fixture inventory is empty')
      target.digest = '0'.repeat(64)
      expect(inventoryDifferences(digested, grown).join('\n')).toContain('digest mismatch')

      const bare = { ...target, disposition: 'unset' } as unknown as InventoryEntry
      expect(entryProblems(bare).join('\n')).toContain('missing a preserve or map disposition')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('does not keep historical entry totals in the generator', () => {
    const directory = dirname(fileURLToPath(import.meta.url))
    const sources = ['git-at.ts', 'ast.ts', 'sources.ts', 'inventory.ts', 'record-baseline-inventory.ts']
    const text = sources.map((name) => readFileSync(join(directory, name), 'utf8')).join('\n')
    expect(text).not.toMatch(/\b1310\b/)
    expect(text).not.toMatch(/\b76\b/)
  })
})

function symbols(inventory: Inventory): string[] {
  return inventory.entries.map((entry) => entry.symbol)
}

function clone(inventory: Inventory): Inventory {
  return JSON.parse(serializeInventory(inventory)) as Inventory
}

function writeFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'baseline-inventory-'))
  const files: Record<string, string> = {
    'vitest.shared.ts':
      "const exclude = ['**/dist/**']\nexport default { test: { projects: [{ test: { include: ['**/*.test.ts'] } }] } }\n",
    'packages/protocol/src/methods.ts': [
      "export type MethodName = '_agnes/v1/session.rename' | 'initialize' | '_agnes/v1/computerUse.status' | '_agnes/v1/config.get'",
      'export const METHODS = {',
      "  '_agnes/v1/session.rename': { kind: 'request' },",
      "  initialize: { kind: 'request' },",
      "  '_agnes/v1/computerUse.status': { kind: 'request' },",
      "  '_agnes/v1/config.get': { kind: 'request' },",
      '}\n',
    ].join('\n'),
    'packages/cli/src/args.ts': [
      "const COMMANDS = new Set<string>(['doctor', 'acp', 'computer-use', 'resources', 'serve'])",
      "const FORWARDED = new Set<string>(['serve'])",
      "const VALUE_FLAGS = Object.assign(Object.create(null), { '--cwd': 'cwd' })",
      "const BOOL_FLAGS = Object.assign(Object.create(null), { '--json': 'json' })",
      "const ENUMS = Object.assign(Object.create(null), { mode: ['text', 'json'] })\n",
    ].join('\n'),
    'packages/cli/src/commands/doctor.ts': "export const DOCTOR_SECTIONS = ['platform'] as const\n",
    'packages/cli/src/bin.ts': "type DaemonCommand = 'start' | 'status' | 'stop'\n",
    'packages/cli/src/commands/computer-use.ts':
      "export function validateRescue(action: string): void {\n  if (!['status', 'install'].includes(action)) throw new Error('usage')\n}\n",
    'packages/cli/src/modes/acp.ts': 'export async function runAcp(): Promise<number> {\n  return 0\n}\n',
    'packages/resource-control-cli/src/resources.ts': [
      "const VALUE_FLAGS = new Set(['--profile'])",
      "const FORBIDDEN_SECRET_FLAGS = new Set(['--token'])",
      'export function run(parsed: { action: string }): void {',
      "  if (parsed.action === 'list') return",
      '}\n',
    ].join('\n'),
    'packages/web-server/src/server.ts': [
      "export const WORKSPACE_PICKER_PATH = '/api/workspace-picker'",
      "const FILES = new Set(['index.html'])",
      'export function page(pathname: string): string {',
      "  return pathname === '/' ? 'index.html' : 'missing'",
      '}\n',
    ].join('\n'),
    'packages/cli-tui/src/commands.ts':
      "export const SLASH_COMMANDS = [{ name: '/help', description: 'help' }]\n",
    'packages/channels/src/adapters/demo/channel.json': '{"id":"demo"}\n',
    'packages/channels/src/runner/commands.ts': "export type CommandName = 'help' | 'status'\n",
    'packages/host/src/computer-use/example-driver-backend.ts': 'export const backend = true\n',
    'packages/host/src/computer-use/computer-use-driver-lock.json': '{}\n',
    'packages/protocol/schema/profile.json': '{"properties":{"computerUse":{"type":"object"}}}\n',
    'packages/protocol/schema/agnes-v1.json':
      '{"$defs":{"SessionMeta":{"properties":{"title":{"type":"string"},"archived":{"type":"boolean"}}}}}\n',
    'packages/resource-control-contracts/package.json':
      '{"name":"@agnes/resource-control-contracts","exports":{".":"./src/index.ts"}}\n',
    'packages/worker-runtime/src/main.ts':
      "const workerKind = 'session'\nif (workerKind !== 'session' && workerKind !== 'service') throw new Error('invalid')\n",
    'packages/core/test/sample.test.ts': 'export {}\n',
    'packages/extension-api/package.json':
      '{"name":"@agnes/extension-api","exports":{".":"./src/index.ts"}}\n',
    'packages/extension-api/src/index.ts': 'export const HOOK_TABLE = { session_start: true }\n',
    'packages/protocol/schema/hooks.json': '{"x-agnes-hook-table":{"session_start":{"mode":"parallel"}}}\n',
    'packages/host/src/adapters/ddl.ts':
      'export const DDL = [`CREATE TABLE IF NOT EXISTS sessions (session_key TEXT PRIMARY KEY, created_at TEXT NOT NULL)`]\n',
    'packages/daemon/src/storage/session-preferences.ts':
      'export const SQL = `CREATE TABLE IF NOT EXISTS session_preferences (session_key TEXT PRIMARY KEY, title TEXT, archived INTEGER NOT NULL DEFAULT 0)`\n',
    'packages/protocol/schema/session-v1.json':
      '{"$defs":{"EventEnvelope":{"properties":{"type":{"anyOf":[{"enum":["session/start"]},{"pattern":"^x\\\\/(?:host\\\\/session-title|[a-z0-9-]+)$"}]}}}}}\n',
  }
  for (const [path, text] of Object.entries(files)) {
    const file = join(directory, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  git(directory, ['init'])
  commit(directory, 'fixture')
  return directory
}

function commit(directory: string, message: string): void {
  git(directory, ['add', '-A'])
  git(directory, [
    '-c',
    'user.name=inventory',
    '-c',
    'user.email=inventory@example.com',
    'commit',
    '-m',
    message,
  ])
}

function git(directory: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`)
}
