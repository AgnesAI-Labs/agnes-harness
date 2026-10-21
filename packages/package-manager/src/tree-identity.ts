import { type BigIntStats, lstatSync, readdirSync, statfsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { mapFileChecks } from './file-read-pool.js'
import { treeVerificationError } from './tree-verification-error.js'

type NodeIdentity = Readonly<{ path: string; stamp: string; children?: readonly string[] }>
export type TreeIdentity = Readonly<{
  root: string
  nodes: readonly NodeIdentity[]
  bytes: number
  latestChangeMs: number
  cacheable: boolean
}>

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const fail = (): never => {
  throw treeVerificationError('tree-changed')
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
function stamp(stat: BigIntStats): string {
  if (stat.isSymbolicLink()) throw treeVerificationError('symlink')
  if (!stat.isFile() && !stat.isDirectory()) throw treeVerificationError('special-entry')
  return [stat.mode, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':')
}
function reusable(stat: BigIntStats): boolean {
  return (
    stat.ino !== 0n &&
    stat.mtimeNs !== 0n &&
    stat.ctimeNs % 1_000_000n !== 0n &&
    (!stat.isFile() || stat.nlink === 1n)
  )
}

/** Conservative per-volume allowlist; BigInt timestamp representation alone proves no precision. */
export function supportsTreeIdentity(directory: string): boolean {
  try {
    const type = statfsSync(directory, { bigint: true }).type
    return process.platform === 'darwin' // guards-allow-platform: file-identity volume adapter.
      ? type === 0x1an
      : process.platform === 'linux' && (type === 0xef53n || type === 0x58465342n) // guards-allow-platform: file-identity volume adapter.
  } catch (error) {
    if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return false
    throw error
  }
}

export function treeIdentitySync(directory: string): TreeIdentity {
  const lexical = resolve(directory)
  const first = lstatSync(lexical)
  if (first.isSymbolicLink()) throw treeVerificationError('symlink')
  if (!first.isDirectory()) throw treeVerificationError('not-directory')
  const root = nativeRealpathSync(lexical),
    nodes: NodeIdentity[] = []
  let latestChangeMs = 0
  let bytes = 0,
    cacheable = true
  const walk = (path: string): void => {
    const stat = lstatSync(path, { bigint: true }),
      identity = stamp(stat)
    latestChangeMs = Math.max(
      latestChangeMs,
      Number((stat.ctimeNs + 999_999n) / 1_000_000n),
      Number((stat.mtimeNs + 999_999n) / 1_000_000n),
    )
    if (!contained(root, nativeRealpathSync(path))) fail()
    cacheable &&= reusable(stat)
    const children = stat.isDirectory() ? readdirSync(path).sort(compare) : undefined
    nodes.push({ path: relative(root, path), stamp: identity, ...(children ? { children } : {}) })
    if (children) for (const name of children) walk(join(path, name))
    else bytes += Number(stat.size)
  }
  walk(root)
  nodes.sort((a, b) => compare(a.path, b.path))
  // Every file, including ones observed before later IO, is checked again. Directory-only final
  // checks would miss same-size writes with restored mtime and changed ctime in an earlier file.
  for (const node of nodes) {
    const path = join(root, node.path)
    if (stamp(lstatSync(path, { bigint: true })) !== node.stamp || !contained(root, nativeRealpathSync(path)))
      fail()
    if (node.children && JSON.stringify(readdirSync(path).sort(compare)) !== JSON.stringify(node.children))
      fail()
  }
  const final = lstatSync(lexical, { bigint: true })
  if (final.isSymbolicLink()) throw treeVerificationError('symlink')
  if (!final.isDirectory()) throw treeVerificationError('not-directory')
  if (nativeRealpathSync(lexical) !== root || stamp(final) !== nodes[0]?.stamp) fail()
  return { root, nodes, bytes, cacheable, latestChangeMs }
}

export async function treeIdentity(directory: string): Promise<TreeIdentity> {
  const lexical = resolve(directory),
    first = await fs.lstat(lexical)
  if (first.isSymbolicLink()) throw treeVerificationError('symlink')
  if (!first.isDirectory()) throw treeVerificationError('not-directory')
  const root = await fs.realpath(lexical),
    nodes: NodeIdentity[] = []
  let latestChangeMs = 0
  let bytes = 0,
    cacheable = true
  const visit = async (path: string): Promise<string[]> => {
    const stat = await fs.lstat(path, { bigint: true }),
      identity = stamp(stat)
    latestChangeMs = Math.max(
      latestChangeMs,
      Number((stat.ctimeNs + 999_999n) / 1_000_000n),
      Number((stat.mtimeNs + 999_999n) / 1_000_000n),
    )
    if (!contained(root, await fs.realpath(path))) fail()
    cacheable &&= reusable(stat)
    const children = stat.isDirectory() ? (await fs.readdir(path)).sort(compare) : undefined
    nodes.push({ path: relative(root, path), stamp: identity, ...(children ? { children } : {}) })
    if (!children) bytes += Number(stat.size)
    return children?.map((name) => join(path, name)) ?? []
  }
  const queue = [root]
  while (queue.length) {
    const children = await Promise.all(queue.splice(0, 4).map(visit))
    queue.push(...children.flat())
  }
  nodes.sort((a, b) => compare(a.path, b.path))
  await mapFileChecks(nodes, async (node) => {
    const path = join(root, node.path)
    if (
      stamp(await fs.lstat(path, { bigint: true })) !== node.stamp ||
      !contained(root, await fs.realpath(path))
    )
      fail()
    if (
      node.children &&
      JSON.stringify((await fs.readdir(path)).sort(compare)) !== JSON.stringify(node.children)
    )
      fail()
  })
  const final = await fs.lstat(lexical, { bigint: true })
  if (final.isSymbolicLink()) throw treeVerificationError('symlink')
  if (!final.isDirectory()) throw treeVerificationError('not-directory')
  if ((await fs.realpath(lexical)) !== root || stamp(final) !== nodes[0]?.stamp) fail()
  return { root, nodes, bytes, cacheable, latestChangeMs }
}

export function sameTreeIdentity(a: TreeIdentity, b: TreeIdentity): boolean {
  return a.root === b.root && JSON.stringify(a.nodes) === JSON.stringify(b.nodes)
}
