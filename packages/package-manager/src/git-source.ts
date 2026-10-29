import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PackageError } from './errors.js'
import { checkCancelled } from './ports.js'
import type { ExecFn, PackageSource } from './sources.js'

const sourceError = (message: string, reason: string) =>
  new PackageError('E_DEP_MISSING', message, { detail: { reason } })

/** Resolve a public ref once, then fetch and verify exactly that immutable commit. */
export async function checkoutGitSource(
  ref: string,
  payload: string,
  cwd: string,
  exec: ExecFn,
  signal?: AbortSignal,
): Promise<PackageSource> {
  const raw = ref.slice(4)
  const split = raw.lastIndexOf('#')
  const url = split < 0 ? raw : raw.slice(0, split)
  const requested = split < 0 ? 'HEAD' : raw.slice(split + 1)
  let commit = requested
  mkdirSync(payload)
  const prefix = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.attributesFile=/dev/null',
    '-c',
    'protocol.file.allow=never',
  ]
  const git = async (args: string[]): Promise<{ stdout: string }> => {
    try {
      return await exec('git', [...prefix, ...args], { cwd })
    } catch {
      checkCancelled(signal)
      throw sourceError('Git source could not be downloaded or checked out', 'git-fetch')
    }
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    const refs = (
      await git([
        'ls-remote',
        '--',
        url,
        requested === 'HEAD' ? 'HEAD' : 'refs/heads/' + requested,
        'refs/tags/' + requested,
        'refs/tags/' + requested + '^{}',
      ])
    ).stdout
    const rows = refs
      .trim()
      .split('\n')
      .map((line) => line.split(/\s+/))
      .filter((row) => /^[a-f0-9]{40}$/.test(row[0] ?? ''))
    const selected = rows.find((row) => row[1]?.endsWith('^{}')) ?? rows[0]
    if (!selected?.[0] || (rows.length > 1 && !rows.some((row) => row[1]?.endsWith('^{}'))))
      throw sourceError('Git ref is unavailable or ambiguous; supply a commit', 'git-ref')
    commit = selected[0]
  }
  const resolvedSource: PackageSource = { type: 'git', ref: 'git:' + url + '#' + commit }
  await git(['init', '--quiet', payload])
  await git(['-C', payload, 'remote', 'add', 'origin', url])
  await git(['-C', payload, 'fetch', '--quiet', '--depth', '1', 'origin', commit])
  await git(['-C', payload, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'])
  const head = (await git(['-C', payload, 'rev-parse', 'HEAD'])).stdout.trim()
  if (head !== commit)
    throw new PackageError('E_LOCK_MISMATCH', 'git checkout differs from the pinned commit', {
      detail: { reason: 'commit' },
    })
  rmSync(join(payload, '.git'), { recursive: true, force: true })
  return resolvedSource
}
