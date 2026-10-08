import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const marker = 'packages/cli/dist/local/.e2e-build.json'
export async function sourceHash() {
  const files = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      'packages',
      'tools/build-local.ts',
      'tools/third-party-notices.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'patches',
    ],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .sort()
  const hash = createHash('sha256').update(process.version).update(process.platform).update(process.arch)
  for (const file of files) {
    if (/\.(test|spec)\.|\/test[s]?\//.test(file)) continue
    hash
      .update(file)
      .update('\0')
      .update(await readFile(file))
  }
  return hash.digest('hex')
}
export async function canReuse(hash) {
  try {
    return JSON.parse(await readFile(marker, 'utf8')).hash === hash
  } catch {
    return false
  }
}
export async function recordBuild(hash) {
  await writeFile(
    marker,
    JSON.stringify({ hash, node: process.version, platform: process.platform, arch: process.arch }),
  )
}
