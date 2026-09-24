import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { locateSkillEntry, skillRoots } from '@agnes/base'
import { AGH_DIR, type SkillDescriptor } from '@agnes/protocol'
import { deleteSkillEntrySync, skillDeletionPath, syncDirectorySync } from '@agnes/system-node'
import { scanSkills } from './skill-bootstrap.js'
import { readSkillCache, writeSkillCache } from './skill-lkg-storage.js'

const fail = () => {
  throw new Error('SKILL_DELETE_REFUSED')
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex')

/** Never accepts a path from an RPC caller. Identity is derived from the trusted root inventory. */
export async function removeFilesystemSkill(input: {
  descriptor: SkillDescriptor
  cwd?: string | undefined
  osHomeDir: string
  agnesHomeDir?: string | undefined
  stateDirectory?: string
  validateOnly?: boolean
}): Promise<void> {
  const { descriptor, cwd, osHomeDir } = input
  const agnesHomeDir = input.agnesHomeDir ?? join(osHomeDir, AGH_DIR)
  const root = skillRoots({ workspaceRoot: cwd ?? agnesHomeDir, osHomeDir, agnesHomeDir }).find(
    (item) => item.rootKey === descriptor.sourceIdentity.rootKey,
  )
  if (!root || (root.scope === 'workspace' && (!cwd || root.workspaceKey !== descriptor.workspaceId))) fail()
  if (!root) return
  const checkChain = (target: string) => {
    if (!isAbsolute(target)) fail()
    for (let cursor = target; ; cursor = dirname(cursor)) {
      const stat = lstatSync(cursor)
      if (stat.isSymbolicLink()) fail()
      if (dirname(cursor) === cursor) break
    }
    if (relative(realpathSync(target), target) !== '') fail()
  }
  const listing = {
    list: async (path: string) =>
      readdirSync(path, { withFileTypes: true }).map((item) => ({
        name: item.name,
        kind: item.isDirectory() ? ('dir' as const) : item.isFile() ? ('file' as const) : ('other' as const),
      })),
  }
  const located = await locateSkillEntry(listing, root, descriptor.resourceId)
  // An identical replay after a successful filesystem deletion is harmless.
  if (!located) return
  // Only a real Skill directory is deleted here; a single-file or linked Skill is removed by hand.
  if (located.kind !== 'dir') fail()
  const rootPath = skillDeletionPath(resolve(located.dirPath))
  checkChain(rootPath)
  const target = join(rootPath, located.name)
  if (dirname(target) !== rootPath || target === rootPath) fail()
  checkChain(target)
  const ticket = join(
    input.stateDirectory ?? join(agnesHomeDir, 'data', 'skill-deletions'),
    `${digest(descriptor.resourceId + descriptor.revision)}.json`,
  )
  type Node = { path: string; dev: string; ino: string; directory: boolean; size: number; mtimeMs: number }
  let nodes: Node[]
  let saved: string | undefined
  try {
    saved = await readSkillCache(ticket)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (saved !== undefined) {
    const plan = JSON.parse(saved) as { resourceId: string; revision: string; nodes: Node[] }
    if (
      plan.resourceId !== descriptor.resourceId ||
      plan.revision !== descriptor.revision ||
      !Array.isArray(plan.nodes) ||
      !plan.nodes.length ||
      plan.nodes.length > 4096
    )
      fail()
    nodes = plan.nodes
    for (const node of nodes) {
      if (
        !node ||
        typeof node.path !== 'string' ||
        typeof node.directory !== 'boolean' ||
        ![node.dev, node.ino].every((value) => typeof value === 'string' && /^\d{1,20}$/.test(value)) ||
        ![node.size, node.mtimeMs].every(Number.isFinite)
      )
        fail()
      const part = relative(target, node.path)
      if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) fail()
    }
    if (nodes[0]?.path !== target || !nodes[0].directory) fail()
  } else {
    if (descriptor.stale) fail()
    const scan = await scanSkills(cwd, undefined, undefined, osHomeDir, agnesHomeDir)
    const found = scan.roots
      .flatMap((item) => item.candidates)
      .find((item) => item.resourceId === descriptor.resourceId)
    if (scan.failedRoots.includes(root.rootKey) || found?.revision !== descriptor.revision) fail()
    nodes = []
    const collect = (path: string, depth: number) => {
      if (depth > 32 || nodes.length >= 4096) fail()
      const part = relative(target, path)
      if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) fail()
      checkChain(path)
      const stat = lstatSync(path)
      if (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) fail()
      const identity = lstatSync(path, { bigint: true })
      nodes.push({
        path,
        dev: identity.dev.toString(),
        ino: identity.ino.toString(),
        directory: stat.isDirectory(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      })
      if (stat.isDirectory()) for (const item of readdirSync(path)) collect(join(path, item), depth + 1)
    }
    collect(target, 0)
  }
  const directories = new Map(nodes.filter((node) => node.directory).map((node) => [node.path, node]))
  const checkDirectory = (path: string, allowMissing: boolean) => {
    const expected = directories.get(path)
    if (!expected) fail()
    let stat: import('node:fs').BigIntStats
    try {
      stat = lstatSync(path, { bigint: true })
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!stat.isDirectory() || stat.dev.toString() !== expected?.dev || stat.ino.toString() !== expected?.ino)
      fail()
  }
  // Validate ancestors first, before any destructive work (including resumed deletion).
  for (const path of [...directories.keys()].sort((a, b) => a.length - b.length))
    checkDirectory(path, path !== target)
  if (input.validateOnly) return
  if (saved === undefined) {
    // Persist only identities, never file contents. This is crash recovery, not a recycle bin.
    await writeSkillCache(
      ticket,
      JSON.stringify({ resourceId: descriptor.resourceId, revision: descriptor.revision, nodes }),
    )
  }
  syncDirectorySync(dirname(ticket))
  for (const node of nodes.reverse()) {
    let stat: import('node:fs').Stats
    try {
      stat = lstatSync(node.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    // Recheck the surviving parent chain before each item; no quadratic whole-tree rescans.
    const parents: string[] = []
    for (let path = dirname(node.path); node.path !== target; path = dirname(path)) {
      parents.unshift(path)
      if (path === target) break
      if (parents.length > 32 || dirname(path) === path) fail()
    }
    for (const path of parents) checkDirectory(path, false)
    checkChain(node.path)
    const identity = lstatSync(node.path, { bigint: true })
    if (
      identity.dev.toString() !== node.dev ||
      identity.ino.toString() !== node.ino ||
      stat.isDirectory() !== node.directory ||
      (!node.directory && (stat.size !== node.size || stat.mtimeMs !== node.mtimeMs || stat.nlink !== 1))
    )
      fail()
    deleteSkillEntrySync(node)
  }
  unlinkSync(ticket)
}
