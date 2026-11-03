import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkillRoot, skillRoots } from '@agnes/base'
import {
  createRefinementSkillInstallers,
  type RefinementSkillInstaller,
  refinementSkillRefusal,
  type SkillDraft,
} from '@agnes/host-extensions/resources/refinement-skill-install'
import { readInstallBundle } from '@agnes/host-extensions/resources/skill-install-files'
import { RefinementRegistry } from '@agnes/host-infrastructure/refinement-registry'
import { AGH_DIR } from '@agnes/protocol'

export const discovery = { roots: skillRoots, discover: discoverSkillRoot }

type Entry = {
  descriptor: Record<string, unknown> & { resourceId: string; name: string; revision: string }
  trust: string
  desired: string
  removed: boolean
}
const notFound = () => Object.assign(new Error('not found'), { data: { code: 'RESOURCE_NOT_FOUND' } })

/** Resource control as the installer sees it, over the real skill folders of a temporary home. */
function fakeResources(workspace: string, home: string) {
  const entries = new Map<string, Entry>()
  const ops = new Map<string, string>()
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const scan = async () => {
    const found = []
    for (const root of skillRoots({ workspaceRoot: workspace, osHomeDir: home, agnesHomeDir: home })) {
      if (!existsSync(root.path)) continue
      for (const name of readdirSync(root.path)) {
        if (name.startsWith('.')) continue
        try {
          found.push((await readInstallBundle(join(root.path, name), root, [], discovery)).candidate)
        } catch {}
      }
    }
    return found
  }
  const refresh = async () => {
    const found = await scan()
    for (const [id, entry] of entries)
      if (!entry.removed && !found.some((candidate) => candidate.resourceId === id)) entries.delete(id)
    for (const candidate of found) {
      const previous = entries.get(candidate.resourceId)
      entries.set(candidate.resourceId, {
        descriptor: {
          kind: 'skill',
          resourceId: candidate.resourceId,
          name: candidate.name,
          revision: candidate.revision,
          sourceIdentity: candidate.sourceIdentity,
          priority: candidate.priority,
          stale: false,
        },
        trust: previous?.trust ?? 'trusted',
        desired: previous?.desired ?? 'enabled',
        removed: false,
      })
    }
  }
  const view = (entry: Entry) => ({
    ...entry.descriptor,
    resolution: { winner: !entry.removed, shadowed: [] },
    trust: entry.trust,
    desired: entry.desired,
    actual: !entry.removed && entry.trust === 'trusted' && entry.desired === 'enabled' ? 'ready' : 'disabled',
  })
  const done = (params: Record<string, unknown>, state = 'succeeded') => {
    const id = `op-${String(params.commandId)}`
    ops.set(id, state)
    return { operationId: id }
  }
  const resources = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    calls.push({ method, params })
    if (method === '_agnes/v1/resources.list') {
      // What resource control lists follows the disk, as its watcher would.
      await refresh()
      return { items: [...entries.values()].filter((e) => !e.removed).map(view) }
    }
    if (method === '_agnes/v1/resources.operation.get') return { state: ops.get(String(params.operationId)) }
    const entry = entries.get(String(params.resourceId))
    if (method === '_agnes/v1/resources.get') {
      // What resource control lists follows the disk, as its watcher would.
      await refresh()
      const now = entries.get(String(params.resourceId))
      if (!now) throw notFound()
      return view(now)
    }
    if (method === '_agnes/v1/skills.refresh') {
      await refresh()
      const reinstall = params.reinstall as { resourceId: string; expectedRevision: string } | undefined
      if (reinstall && entries.get(reinstall.resourceId)?.descriptor.revision !== reinstall.expectedRevision)
        return done(params, 'failed')
      return done(params)
    }
    if (!entry) throw notFound()
    if (params.expectedRevision !== entry.descriptor.revision) return done(params, 'failed')
    if (method === '_agnes/v1/skills.trust.set') entry.trust = String(params.trust)
    else if (method === '_agnes/v1/resources.desired.set') entry.desired = String(params.state)
    else if (method === '_agnes/v1/skills.remove') {
      const folder = join(workspace, AGH_DIR, 'skills', entry.descriptor.name)
      const root = skillRoots({ workspaceRoot: workspace, osHomeDir: home, agnesHomeDir: home })[0]
      if (!root) throw new Error('missing workspace skill root')
      const disk = await readInstallBundle(folder, root, [], discovery)
      if (disk.candidate.revision !== entry.descriptor.revision) return done(params, 'failed')
      rmSync(folder, { recursive: true })
      entry.removed = true
      entry.desired = 'disabled'
    } else throw new Error(`unexpected ${method}`)
    return done(params)
  }
  return { resources, calls, refresh, entries }
}

export const skillDoc = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

/**
 * A workspace, its data directory, a resource control over its skill folders and the real background
 * installer. `request` answers a skill request the way the daemon does: the installer's result with
 * `ok: true`, or the installer's refusal as a save refusal reason.
 */
export function skillWorkspace(dirs: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-skill-update-')))
  dirs.push(root)
  const workspace = join(root, 'ws')
  const home = join(root, 'home')
  const dataDir = join(home, 'store')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const fake = fakeResources(workspace, home)
  const installer: RefinementSkillInstaller = createRefinementSkillInstallers({
    dataDir,
    profile: 'local-dev',
    agnesHome: home,
    discovery,
    resources: (method, params) => fake.resources(method, params),
    pollMs: 1,
    timeoutMs: 2_000,
  })(workspace)
  const requests: { sessionKey: string; params: Record<string, unknown> }[] = []
  const request = async (sessionKey: string, params: Record<string, unknown>): Promise<unknown> => {
    requests.push({ sessionKey, params: structuredClone(params) })
    try {
      if (params.op === 'install') {
        const result = await installer.install(params.draft as SkillDraft, {
          workspaceRoot: workspace,
          receiptId: String(params.receiptId),
          source: params.source as never,
        })
        return { ok: true, ...result }
      }
      if (params.op === 'uninstall') {
        await installer.uninstall(String(params.name))
        return { ok: true }
      }
      if (params.op === 'recover') return { ok: true, finished: await installer.recover() }
      if (params.op === 'update') {
        const result = await installer.update(
          String(params.name),
          params.draft as SkillDraft,
          { revision: String(params.expectedRevision) },
          {
            ...(params.enable === undefined ? {} : { enable: params.enable === true }),
            ...(params.source === undefined ? {} : { source: params.source as never }),
          },
        )
        return { ok: true, ...result }
      }
      throw new Error(`unexpected op ${String(params.op)}`)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      return {
        ok: false,
        reason: refinementSkillRefusal(error),
        ...(typeof code === 'string' ? { code } : {}),
      }
    }
  }
  const skillDir = (name: string) => join(workspace, AGH_DIR, 'skills', name)
  return { root, workspace, home, dataDir, fake, installer, request, requests, skillDir }
}

export const registryOf = (dataDir: string, workspace: string, clock: () => number = Date.now) =>
  new RefinementRegistry(dataDir, workspace, clock)
