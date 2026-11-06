import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HEAVY = /\.(?:e2e|slow)\.test\.(?:ts|tsx|jsx)$/
const BROWSER_HEAVY = [
  'packages/web/test/multi-tab-transport.e2e.test.ts',
  'tools/e2e-web/agent-sweep.e2e.test.ts',
]

/** Refuse missing or duplicate migration selections before they become Vitest filters. */
export function migratedHeavyFiles(files, exists = existsSync) {
  if (!files.length) throw new Error('Migrated heavy selection is empty')
  const duplicate = files.find((file, at) => files.indexOf(file) !== at)
  if (duplicate) throw new Error(`${duplicate} is listed more than once`)
  for (const file of files)
    if (!HEAVY.test(file) || !exists(file))
      throw new Error(`${file} is not a heavy test file in this checkout`)
  return files
}

/**
 * The heavy-tier files of one CI shard. Shard k of n (k < n) is the k-th list in
 * heavy-shards.json; the last shard is every other heavy file, so each heavy file runs in exactly
 * one shard and a new file needs no entry. A listed file that is missing or not heavy is refused.
 */
export function heavyShard(spec, lists, exists = existsSync, withoutBrowser = false) {
  const match = /^(\d+)\/(\d+)$/.exec(spec ?? '')
  const index = Number(match?.[1])
  const count = Number(match?.[2])
  if (!match || count !== lists.length + 1 || index < 1 || index > count)
    throw new Error(`expected --shard=k/${lists.length + 1}, got ${spec}`)
  const listed = lists.flat()
  const duplicate = listed.find((file, at) => listed.indexOf(file) !== at)
  if (duplicate) throw new Error(`${duplicate} is listed in more than one heavy shard`)
  for (const file of listed)
    if (!HEAVY.test(file) || !exists(file))
      throw new Error(`${file} is not a heavy test file in this checkout`)
  if (index < count) {
    const files = lists[index - 1].filter((file) => !withoutBrowser || !BROWSER_HEAVY.includes(file))
    if (!files.length) throw new Error('Selected heavy shard is empty')
    return { files }
  }
  return { exclude: [...new Set([...listed, ...(withoutBrowser ? BROWSER_HEAVY : [])])] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const spec = args.find((arg) => arg.startsWith('--shard='))?.slice('--shard='.length)
  const { lists } = JSON.parse(readFileSync(new URL('./heavy-shards.json', import.meta.url), 'utf8'))
  const shard = heavyShard(spec, lists, existsSync, args.includes('--without-browser'))
  const held = [process.env.AGNES_TEST_EXCLUDE ?? '', ...(shard.exclude ?? [])].filter(Boolean).join(',')
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--project',
      'heavy',
      ...args.filter((arg) => !arg.startsWith('--shard=') && arg !== '--without-browser'),
      ...(shard.files ?? []),
    ],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, AGNES_TEST_EXCLUDE: held },
    },
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
