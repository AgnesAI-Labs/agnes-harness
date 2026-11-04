import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HEAVY = /\.(?:e2e|slow)\.test\.(?:ts|tsx|jsx)$/

/**
 * The heavy-tier files of one CI shard. Shard k of n (k < n) is the k-th list in
 * heavy-shards.json; the last shard is every other heavy file, so each heavy file runs in exactly
 * one shard and a new file needs no entry. A listed file that is missing or not heavy is refused.
 */
export function heavyShard(spec, lists, exists = existsSync) {
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
  return index < count ? { files: lists[index - 1] } : { exclude: listed }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const spec = args.find((arg) => arg.startsWith('--shard='))?.slice('--shard='.length)
  const { lists } = JSON.parse(readFileSync(new URL('./heavy-shards.json', import.meta.url), 'utf8'))
  const shard = heavyShard(spec, lists)
  const held = [process.env.AGNES_TEST_EXCLUDE ?? '', ...(shard.exclude ?? [])].filter(Boolean).join(',')
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--project',
      'heavy',
      ...args.filter((arg) => !arg.startsWith('--shard=')),
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
