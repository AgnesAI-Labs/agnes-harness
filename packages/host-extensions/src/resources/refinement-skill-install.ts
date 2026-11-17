import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  REVIEW_AFTER_MS,
  RefinementRegistry,
  type RegistryRecords,
  type RegistrySkill,
  type SaveReceipt,
  type SaveRefusal,
  type SaveSource,
} from '@agnes/host-infrastructure/refinement-registry'
import type { ResourceControlMethodName, ResourceOperation, SkillDescriptor } from '@agnes/protocol'
import {
  isSavedSkillName,
  type RefinementSkillArchive,
  refinementSkillArchive,
  type SkillJournal,
} from './refinement-skill-archive.js'
import { inlineInstallBundle, refuseSkillCollision, refuseSkillTarget } from './skill-install-content.js'
import {
  type InstallBundle,
  installDigest,
  installError,
  readInstallBundle,
  type SkillDiscovery,
  unlinked,
} from './skill-install-files.js'
import { publishInstallBundle } from './skill-install-publish.js'

/**
 * A skill to save: its `SKILL.md` and plain text resources. Instructions only: the host never writes a
 * script into a skill. When a script would help, the skill's text tells the agent to write it itself,
 * with its own tools and under its own permissions.
 */
export type SkillDraft = { name: string; class: 'instructions'; files: { path: string; content: string }[] }

export { isSavedSkillName }

/** What the installer needs from its host. `resources` is bound to the installer's own authority. */
export type RefinementSkillDeps = Readonly<{
  dataDir: string
  profile: string
  agnesHome: string
  discovery: SkillDiscovery
  /** Resource control, limited by the caller to the methods this installer uses. */
  resources(method: ResourceControlMethodName, params: Record<string, unknown>): Promise<unknown>
  clock?: () => number
  pollMs?: number
  /** How long one resource operation, or reaching `ready`, may take. */
  timeoutMs?: number
}>

export type RefinementSkillInstallContext = {
  workspaceRoot: string
  receiptId: string
  /** The entry this skill was saved from; kept in the workspace registry. */
  source: SaveSource
}
export type RefinementSkillInstalled = {
  resourceId: string
  revision: string
  /** Turning refinement on is the user's authorisation for these installs; no approval is asked. */
  authorizedBy: 'refinement-enabled'
  /** The registry state: `review-disabled` when the review switched it off. */
  state: 'active' | 'review-disabled'
  /** Whether resource control reports it trusted, enabled and ready now. */
  ready: boolean
}

/**
 * A skill the review switched off stays off through an update or a rollback; `enable: true` turns it
 * back on. A skill that is on stays on either way.
 */
export type RefinementSkillReplaceOptions = {
  enable?: boolean
  /**
   * Update only: the entry the file now holds, which replaces the registry source of the skill (its
   * hash and whether it was made from a workflow run). Without it the skill keeps the source it had.
   */
  source?: SaveSource
}

export type RefinementSkillInstaller = Readonly<{
  install(draft: SkillDraft, ctx: RefinementSkillInstallContext): Promise<RefinementSkillInstalled>
  update(
    name: string,
    draft: SkillDraft,
    expected: { revision: string },
    options?: RefinementSkillReplaceOptions,
  ): Promise<{ revision: string } | { draft: 'changed-since' }>
  rollback(
    name: string,
    toRevision: string,
    options?: RefinementSkillReplaceOptions,
  ): Promise<{ revision: string }>
  /**
   * Switches the skill off (`desired = disabled`; the folder stays) and records it `review-disabled`.
   * With `reviewAfter`, only while the registry still holds that review date: a renewal meanwhile wins.
   * With `capacity` (the cap on saved skills in force), the record also says why (`disabledFor`) and
   * the registry keeps a receipt of it.
   */
  disable(
    name: string,
    expected: { revision: string; reviewAfter?: number },
    reason?: 'capacity',
  ): Promise<void>
  uninstall(name: string): Promise<void>
  /** Finishes the operations a crash left unfinished in this workspace; returns how many finished. */
  recover(): Promise<number>
}>

/**
 * One installer per workspace root, all sharing one queue per (workspace, skill name). `exclusive`
 * runs other work on a saved skill (the user's own change to it on the skills page, say) in that same
 * queue, so it never interleaves with the installer's operations on that name. `workspaceId` is the
 * SHA-256 of the workspace root, as resource control names it.
 */
export type RefinementSkillInstallers = ((workspaceRoot: string) => RefinementSkillInstaller) & {
  exclusive<T>(workspaceId: string, name: string, task: () => Promise<T>): Promise<T>
}

const LIVE: readonly RegistrySkill['state'][] = ['active', 'review-disabled']
/** The command a capacity receipt names: never one a save request carries. */
const CAPACITY_COMMAND = 'skill-capacity'
const WORKSPACE_ID = /^[a-f0-9]{64}$/
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Whether `value` is a registry source of a saved skill: the entry it came from, who asked, what it holds. */
function validSource(value: unknown): value is SaveSource {
  const source = value as Partial<SaveSource> | undefined
  return (
    source?.kind === 'skill' &&
    [source.sessionKey, source.entryId, source.contentHash].every(
      (text) => typeof text === 'string' && text.length > 0 && text.length <= 4096,
    ) &&
    ['auto', 'user', 'model'].includes(String(source.initiator)) &&
    (source.fromWorkflow === undefined || source.fromWorkflow === true)
  )
}

/**
 * The registry's receipt of a skill the cap on saved skills in force switched off: the entry it was
 * saved from, the capacity step that failed, and the skill and revision now off. Never a session
 * ledger row: the cap also runs when a session opens, with no ledger to write.
 */
function capacityReceipt(skill: RegistrySkill, at: number): SaveReceipt {
  return {
    receiptId: `${CAPACITY_COMMAND}-${randomUUID()}`,
    commandId: CAPACITY_COMMAND,
    initiator: 'auto',
    source: skill.source,
    outcome: 'refused',
    steps: [{ step: 'capacity', verdict: 'fail' }],
    target: { kind: 'skill', name: skill.name, resourceId: skill.resourceId, revision: skill.revision },
    at,
  }
}

/** How a refusal of the installer reads in a save receipt. */
export function refinementSkillRefusal(error: unknown): SaveRefusal {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return 'unavailable'
  if (code === 'SKILL_CHANGED_SINCE' || code === 'SKILL_TARGET_BUSY') return 'conflict'
  if (code.startsWith('REGISTRY_') || code.startsWith('SKILL_RESOURCE_') || code === 'SKILL_NOT_READY')
    return 'unavailable'
  if (
    [
      'SKILL_NAME_INVALID',
      'SKILL_NAME_MISMATCH',
      'SKILL_TARGET_CONFLICT',
      'SKILL_LINK_REFUSED',
      'SKILL_PATH_INVALID',
      'SKILL_FILE_CONFLICT',
      'SKILL_SIZE_LIMIT',
      'SKILL_DOCUMENT_INVALID',
      'SKILL_INSTALL_INVALID',
      'SKILL_CODE_REQUIRES_CANDIDATE',
      'SKILL_FILE_REFUSED',
      'SKILL_NOT_INSTALLED_BY_REFINEMENT',
    ].includes(code)
  )
    return 'static-check'
  return 'unavailable'
}

const INSTRUCTION_FILE = /^((agents|claude|gemini)\.md|.*\.local\.md)$/i
/**
 * A character that can hide text from a person reading the file: a C0 or C1 control other than tab, line
 * feed and carriage return, a bidirectional override or isolate, a zero-width character or direction
 * mark, a byte order mark anywhere but at the very start, or a line or paragraph separator.
 */
const hasHidden = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      code === 0x2060 ||
      (code >= 0x2066 && code <= 0x2069) ||
      (code === 0xfeff && i > 0)
    )
      return true
  }
  return false
}
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/**
 * A skill holds instructions and plain text, nothing that runs: no `scripts` folder at any depth, no
 * file that starts with a shebang, no binary or control bytes, no text that is not valid UTF-8, and no
 * file a context loader would read as standing instructions. The content checks of the install flow
 * then admit only `SKILL.md` and known text formats.
 */
function textOnly(file: { path: string; content: string }): void {
  const parts = file.path.split('/')
  const last = parts.at(-1) ?? ''
  if (
    parts.some((part) => part.toLowerCase() === 'scripts') ||
    (file.path !== 'SKILL.md' && INSTRUCTION_FILE.test(last)) ||
    file.content.replace(/^\ufeff/, '').startsWith('#!') ||
    hasHidden(file.content) ||
    LONE_SURROGATE.test(file.content)
  )
    throw installError('SKILL_FILE_REFUSED')
}

function shapeOf(draft: SkillDraft): void {
  if (
    !draft ||
    typeof draft.name !== 'string' ||
    draft.class !== 'instructions' ||
    !Array.isArray(draft.files) ||
    draft.files.length === 0 ||
    draft.files.some(
      (file) =>
        !file ||
        typeof file.path !== 'string' ||
        typeof file.content !== 'string' ||
        Object.keys(file).some((key) => key !== 'path' && key !== 'content'),
    )
  )
    throw installError('SKILL_INSTALL_INVALID')
  if (!isSavedSkillName(draft.name)) throw installError('SKILL_NAME_INVALID')
}

/**
 * The background installer for skills that refinement saves into a workspace. It never asks for an
 * approval and never runs in a turn: turning refinement on is the authorisation. It reuses the content
 * checks, bundle building and private publishing of the skill install flow and the resource control
 * calls, but keeps its own record of what it installed (the workspace registry), its own archive of
 * earlier revisions, and a journal so a restart finishes what a crash interrupted.
 *
 * Only the workspace skill folder is ever written; never the user's. A name held by any skill this
 * installer did not install is refused, and a skill it did install is only replaced, disabled or removed
 * while its revision is still the one it recorded, so nobody's own edit is overwritten.
 */
export function createRefinementSkillInstallers(deps: RefinementSkillDeps): RefinementSkillInstallers {
  const locks = new Map<string, Promise<unknown>>()
  const clock = deps.clock ?? Date.now
  const pollMs = deps.pollMs ?? 150
  const timeoutMs = deps.timeoutMs ?? 60_000
  /** Operations on one (workspace, name) run one at a time, in the order they were asked for. */
  const serialOn = async <T>(workspaceId: string, name: string, task: () => Promise<T>): Promise<T> => {
    const key = `${workspaceId}\0${name}`
    const previous = locks.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(task)
    const settled = run.catch(() => undefined)
    locks.set(key, settled)
    try {
      return await run
    } finally {
      if (locks.get(key) === settled) locks.delete(key)
    }
  }
  const forWorkspace = (workspaceRoot: string): RefinementSkillInstaller => {
    const root = deps.discovery
      .roots({ workspaceRoot, osHomeDir: deps.agnesHome, agnesHomeDir: deps.agnesHome })
      .find((candidate) => candidate.rootKey === 'workspace-agnes')
    if (root?.scope !== 'workspace') throw installError('SKILL_ROOT_UNAVAILABLE')
    const workspaceId = installDigest(workspaceRoot)
    const registry = new RefinementRegistry(deps.dataDir, workspaceRoot, clock)
    const archive: RefinementSkillArchive = refinementSkillArchive(deps.dataDir, workspaceRoot)
    const targetOf = (name: string) => join(root.path, name)

    const serial = <T>(name: string, task: () => Promise<T>): Promise<T> => serialOn(workspaceId, name, task)
    const call = (method: ResourceControlMethodName, params: Record<string, unknown>) =>
      deps.resources(method, { profile: deps.profile, ...params })
    const effect = async (method: ResourceControlMethodName, params: Record<string, unknown>, id: string) => {
      const receipt = (await call(method, { ...params, commandId: `refine-${id}` })) as {
        operationId?: string
      }
      if (!receipt?.operationId) throw installError('SKILL_RESOURCE_BAD_RECEIPT')
      const deadline = clock() + timeoutMs
      for (;;) {
        const op = (await call('_agnes/v1/resources.operation.get', {
          operationId: receipt.operationId,
        })) as ResourceOperation
        if (op.state === 'succeeded') return
        if (op.state === 'failed' || op.state === 'cancelled')
          throw installError('SKILL_RESOURCE_OPERATION_FAILED')
        if (clock() > deadline) throw installError('SKILL_RESOURCE_OPERATION_PENDING')
        await delay(pollMs)
      }
    }
    const get = async (resourceId: string): Promise<SkillDescriptor | undefined> => {
      try {
        return (await call('_agnes/v1/resources.get', { resourceId })) as SkillDescriptor
      } catch (error) {
        if ((error as { data?: { code?: string } }).data?.code === 'RESOURCE_NOT_FOUND') return undefined
        throw error
      }
    }
    /** The skill folder as it is on disk now: absent, a bundle, or something that cannot be read. */
    const onDisk = async (name: string): Promise<InstallBundle | 'absent' | 'unreadable'> => {
      const target = targetOf(name)
      if (!existsSync(unlinked(target))) return 'absent'
      try {
        return await readInstallBundle(target, root, [], deps.discovery)
      } catch {
        return 'unreadable'
      }
    }
    const recordOf = (name: string) =>
      registry.read().skills.find((skill) => skill.name.toLowerCase() === name)
    const writeRegistry = (mutate: (skills: RegistrySkill[], draft: RegistryRecords) => void) => {
      for (let attempt = 0; ; attempt++) {
        try {
          registry.update((draft) => mutate(draft.skills, draft), registry.read().revision)
          return
        } catch (error) {
          if ((error as { code?: string }).code !== 'REGISTRY_REVISION_CONFLICT' || attempt >= 4) throw error
        }
      }
    }
    const setRecord = (name: string, patch: (current: RegistrySkill | undefined) => RegistrySkill) =>
      writeRegistry((skills) => {
        const index = skills.findIndex((skill) => skill.name.toLowerCase() === name)
        const next = patch(index < 0 ? undefined : skills[index])
        if (index < 0) skills.push(next)
        else skills[index] = next
      })

    /** Static checks: plain text only, then the same content checks as the skill install flow. */
    const checked = async (draft: SkillDraft): Promise<InstallBundle> => {
      shapeOf(draft)
      for (const file of draft.files) textOnly(file)
      const bundle = await inlineInstallBundle(
        { action: 'prepare-content', name: draft.name, files: draft.files, scope: 'workspace', enable: true },
        root,
        deps.discovery,
      )
      // The listed name decides collisions, so it must be the folder name itself.
      if (bundle.candidate.normalizedName !== draft.name) throw installError('SKILL_NAME_MISMATCH')
      return bundle
    }

    /**
     * Refresh with the exact revision and trust it; then enable it and wait until it is ready, or keep
     * it switched off.
     */
    const activate = async (resourceId: string, revision: string, id: string, enabled: boolean) => {
      await effect(
        '_agnes/v1/skills.refresh',
        {
          rootKey: 'workspace-agnes',
          workspaceId,
          reinstall: { resourceId, expectedRevision: revision },
        },
        `${id}-refresh`,
      )
      const seen = await get(resourceId)
      if (!seen || seen.revision !== revision || seen.stale || !seen.resolution.winner)
        throw installError('SKILL_RESOURCE_CHANGED_OR_SHADOWED')
      await effect(
        '_agnes/v1/skills.trust.set',
        { resourceId, expectedRevision: revision, trust: 'trusted' },
        `${id}-trust`,
      )
      await effect(
        '_agnes/v1/resources.desired.set',
        { resourceId, expectedRevision: revision, state: enabled ? 'enabled' : 'disabled' },
        `${id}-${enabled ? 'enable' : 'disable'}`,
      )
      await settled(resourceId, revision, enabled)
    }
    /** Waits until resource control shows the revision trusted and either ready or switched off. */
    const settled = async (resourceId: string, revision: string, enabled: boolean) => {
      const deadline = clock() + timeoutMs
      for (;;) {
        const now = await get(resourceId)
        if (
          now?.revision === revision &&
          !now.stale &&
          now.resolution.winner &&
          now.trust === 'trusted' &&
          (enabled ? now.desired === 'enabled' && now.actual === 'ready' : now.desired === 'disabled')
        )
          return
        if (clock() > deadline) throw installError('SKILL_NOT_READY')
        await delay(pollMs)
      }
    }
    const readyOf = (listed: SkillDescriptor | undefined) =>
      listed?.trust === 'trusted' && listed.desired === 'enabled' && listed.actual === 'ready'

    /** Carries one journal entry to the end. Every step first looks at what is already on disk. */
    const finish = async (entry: SkillJournal): Promise<Omit<RefinementSkillInstalled, 'authorizedBy'>> => {
      let current = entry
      const advance = (phase: SkillJournal['phase']) => {
        current = { ...current, phase }
        archive.journal.write(current)
      }
      // Set once the old revision of a replacement may be gone from the folder.
      let removedOld = current.phase !== 'prepared'
      const abandon = (code: string) => {
        // The registry stops claiming the removed revision: it records the one this replacement wrote,
        // so a folder a person changed no longer matches it and is treated as theirs.
        if (entry.kind === 'replace' && removedOld)
          writeRegistry((skills) => {
            const record = skills.find((skill) => skill.name === entry.name)
            if (record && record.revision === entry.fromRevision) record.revision = entry.toRevision
          })
        archive.journal.remove(entry.id)
        return installError(code)
      }
      /** The folder still holds exactly the revision this entry wrote. */
      const stillOurs = async () => {
        const disk = await onDisk(entry.name)
        return disk !== 'absent' && disk !== 'unreadable' && disk.candidate.revision === entry.toRevision
      }
      // Fresh command ids for every attempt: each step is safe to repeat, and a failed attempt must
      // not be replayed as failed forever.
      const short = randomUUID().replaceAll('-', '')
      const fresh = await archive.load(entry.name, entry.toRevision, root, deps.discovery)
      const resourceId = fresh.candidate.resourceId
      if (current.phase === 'prepared' && entry.kind === 'replace') {
        const disk = await onDisk(entry.name)
        if (disk === 'unreadable') throw abandon('SKILL_CHANGED_SINCE')
        if (disk !== 'absent' && disk.candidate.revision === entry.fromRevision) {
          try {
            await effect(
              '_agnes/v1/skills.remove',
              { resourceId, expectedRevision: entry.fromRevision },
              `${short}-remove`,
            )
            removedOld = true
          } catch (error) {
            const after = await onDisk(entry.name)
            if (
              after !== 'absent' &&
              (after === 'unreadable' || after.candidate.revision !== entry.fromRevision)
            )
              throw abandon('SKILL_CHANGED_SINCE')
            throw error
          }
          if ((await onDisk(entry.name)) !== 'absent') throw abandon('SKILL_CHANGED_SINCE')
        } else if (disk !== 'absent' && disk.candidate.revision !== entry.toRevision) {
          throw abandon('SKILL_CHANGED_SINCE')
        }
        advance('removed')
      }
      if (current.phase === 'prepared' || current.phase === 'removed') {
        const disk = await onDisk(entry.name)
        if (disk === 'absent') publishInstallBundle(targetOf(entry.name), fresh, () => undefined)
        // Already there with exactly these files: published before a crash, never published twice.
        else if (disk === 'unreadable' || disk.candidate.revision !== entry.toRevision)
          throw abandon('SKILL_TARGET_CONFLICT')
        advance('published')
      }
      const enabled = entry.enable !== false
      // In every phase: a folder that no longer holds what was published is a person's now. Leave it,
      // and drop the entry so the name is never held up by it.
      removedOld = removedOld || entry.kind === 'replace'
      if (!(await stillOurs())) throw abandon('SKILL_CHANGED_SINCE')
      try {
        await activate(resourceId, entry.toRevision, short, enabled)
      } catch (error) {
        if (!(await stillOurs())) throw abandon('SKILL_CHANGED_SINCE')
        throw error
      }
      setRecord(entry.name, (record) => {
        // A new install starts a new history; a replacement continues the one it replaces.
        const earlier = entry.kind === 'install' ? [] : (record?.archive ?? [])
        const history = [...earlier, ...(entry.fromRevision ? [entry.fromRevision] : [])]
        const ordered = [...new Set([...history.filter((r) => r !== entry.toRevision), entry.toRevision])]
        // A replacement keeps why the skill is off (while it stays off) and that a person switched it on.
        const kept = entry.kind === 'install' ? undefined : record
        return {
          name: entry.name,
          resourceId,
          revision: entry.toRevision,
          source: entry.source !== undefined || !record ? (entry.source as SaveSource) : record.source,
          reviewAfter: clock() + REVIEW_AFTER_MS,
          state: enabled ? 'active' : 'review-disabled',
          archive: archive.prune(entry.name, ordered, [entry.toRevision]),
          ...(!enabled && kept?.disabledFor ? { disabledFor: kept.disabledFor } : {}),
          ...(kept?.enabledBy ? { enabledBy: kept.enabledBy } : {}),
        }
      })
      archive.journal.remove(entry.id)
      return {
        resourceId,
        revision: entry.toRevision,
        state: enabled ? ('active' as const) : ('review-disabled' as const),
        ready: enabled,
      }
    }
    const pendingFor = async (name: string) => {
      for (const entry of archive.journal.list()) if (entry.name === name) await finish(entry)
    }
    /** The record of a skill this installer installed and nobody has changed since. */
    const owned = async (name: string, expected?: string) => {
      const record = recordOf(name)
      if (!record || !LIVE.includes(record.state)) throw installError('SKILL_NOT_INSTALLED_BY_REFINEMENT')
      const disk = await onDisk(name)
      const listed = await get(record.resourceId)
      const unchanged =
        disk !== 'absent' &&
        disk !== 'unreadable' &&
        disk.candidate.revision === record.revision &&
        disk.candidate.resourceId === record.resourceId &&
        listed?.revision === record.revision &&
        (expected === undefined || expected === record.revision)
      return { record, disk, listed, unchanged }
    }
    /** Turns a skill the review switched off back on, at the revision it has. */
    const reenable = async (record: RegistrySkill) => {
      await effect(
        '_agnes/v1/resources.desired.set',
        { resourceId: record.resourceId, expectedRevision: record.revision, state: 'enabled' },
        `${randomUUID()}-enable`,
      )
      await settled(record.resourceId, record.revision, true)
      setRecord(record.name, (current) => {
        const { disabledFor: _off, ...rest } = current ?? record
        return { ...rest, state: 'active' }
      })
    }
    const replace = async (
      name: string,
      record: RegistrySkill,
      disk: InstallBundle,
      next: InstallBundle,
      options: RefinementSkillReplaceOptions | undefined,
    ) => {
      archive.save(name, disk)
      archive.save(name, next)
      const entry: SkillJournal = {
        id: archive.journal.idFor(`replace\0${name}\0${randomUUID()}`),
        kind: 'replace',
        enable: record.state !== 'review-disabled' || options?.enable === true,
        name,
        fromRevision: record.revision,
        toRevision: next.candidate.revision,
        ...(options?.source === undefined ? {} : { source: options.source }),
        phase: 'prepared',
        at: clock(),
      }
      archive.journal.write(entry)
      return finish(entry)
    }

    return Object.freeze({
      async install(draft, ctx) {
        if (ctx.workspaceRoot !== workspaceRoot) throw installError('SKILL_INSTALL_INVALID')
        if (typeof ctx.receiptId !== 'string' || !RECEIPT_ID.test(ctx.receiptId))
          throw installError('SKILL_INSTALL_INVALID')
        if (!validSource(ctx.source)) throw installError('SKILL_INSTALL_INVALID')
        shapeOf(draft)
        return serial(draft.name, async () => {
          const id = archive.journal.idFor(`install\0${ctx.receiptId}`)
          const resumed = archive.journal.list().find((entry) => entry.id === id)
          const bundle = await checked(draft)
          if (resumed) {
            if (resumed.name !== draft.name || resumed.toRevision !== bundle.candidate.revision)
              throw installError('SKILL_TARGET_CONFLICT')
            return { ...(await finish(resumed)), authorizedBy: 'refinement-enabled' as const }
          }
          await pendingFor(draft.name)
          const record = recordOf(draft.name)
          if (record && LIVE.includes(record.state)) {
            if (
              record.revision === bundle.candidate.revision &&
              record.resourceId === bundle.candidate.resourceId
            ) {
              // The same skill again: say what it is now, and never vouch for a folder a person changed.
              const { unchanged, listed } = await owned(draft.name)
              if (!unchanged) throw installError('SKILL_CHANGED_SINCE')
              return {
                resourceId: record.resourceId,
                revision: record.revision,
                authorizedBy: 'refinement-enabled' as const,
                state: record.state as RefinementSkillInstalled['state'],
                ready: readyOf(listed),
              }
            }
            throw installError('SKILL_TARGET_CONFLICT')
          }
          // Refuse any skill of this name not installed here: in every workspace skill folder and listed.
          refuseSkillTarget(targetOf(draft.name))
          refuseSkillTarget(join(workspaceRoot, '.agents', 'skills', draft.name))
          refuseSkillTarget(join(workspaceRoot, '.claude', 'skills', draft.name))
          await refuseSkillCollision(
            {
              principalId: 'system:refinement',
              profile: deps.profile,
              workspaceRoot,
              agnesHome: deps.agnesHome,
              assertActive: () => undefined,
              ask: async () => false,
              resources: (method, params) => deps.resources(method, params),
            },
            bundle,
          )
          archive.save(draft.name, bundle)
          const entry: SkillJournal = {
            id,
            kind: 'install',
            name: draft.name,
            toRevision: bundle.candidate.revision,
            receiptId: ctx.receiptId,
            source: ctx.source,
            phase: 'prepared',
            at: clock(),
          }
          archive.journal.write(entry)
          return { ...(await finish(entry)), authorizedBy: 'refinement-enabled' as const }
        })
      },
      async update(name, draft, expected, options) {
        shapeOf(draft)
        if (options?.source !== undefined && !validSource(options.source))
          throw installError('SKILL_INSTALL_INVALID')
        if (draft.name !== name) throw installError('SKILL_NAME_MISMATCH')
        return serial(name, async () => {
          await pendingFor(name)
          const bundle = await checked(draft)
          const { record, disk, unchanged } = await owned(name, expected.revision)
          if (!unchanged || disk === 'absent' || disk === 'unreadable')
            return { draft: 'changed-since' as const }
          if (bundle.candidate.revision === record.revision) {
            if (options?.enable === true && record.state === 'review-disabled') await reenable(record)
            return { revision: record.revision }
          }
          try {
            return { revision: (await replace(name, record, disk, bundle, options)).revision }
          } catch (error) {
            if ((error as { code?: string }).code === 'SKILL_CHANGED_SINCE')
              return { draft: 'changed-since' as const }
            throw error
          }
        })
      },
      async rollback(name, toRevision, options) {
        if (!isSavedSkillName(name)) throw installError('SKILL_NAME_INVALID')
        return serial(name, async () => {
          await pendingFor(name)
          const { record, disk, unchanged } = await owned(name)
          if (!unchanged || disk === 'absent' || disk === 'unreadable')
            throw installError('SKILL_CHANGED_SINCE')
          if (toRevision === record.revision) {
            if (options?.enable === true && record.state === 'review-disabled') await reenable(record)
            return { revision: record.revision }
          }
          if (!record.archive.includes(toRevision) || !archive.has(name, toRevision))
            throw installError('SKILL_ARCHIVE_MISSING')
          const restored = await archive.load(name, toRevision, root, deps.discovery)
          return { revision: (await replace(name, record, disk, restored, options)).revision }
        })
      },
      async disable(name, expected, reason) {
        if (!isSavedSkillName(name)) throw installError('SKILL_NAME_INVALID')
        return serial(name, async () => {
          await pendingFor(name)
          const { record, unchanged } = await owned(name, expected.revision)
          if (!unchanged) throw installError('SKILL_CHANGED_SINCE')
          if (record.state === 'review-disabled') return
          if (expected.reviewAfter !== undefined && record.reviewAfter !== expected.reviewAfter)
            throw installError('SKILL_REVIEW_RENEWED')
          await effect(
            '_agnes/v1/resources.desired.set',
            { resourceId: record.resourceId, expectedRevision: record.revision, state: 'disabled' },
            `${randomUUID()}-disable`,
          )
          writeRegistry((skills, draft) => {
            const index = skills.findIndex((skill) => skill.name.toLowerCase() === name)
            const current = index < 0 ? record : (skills[index] as RegistrySkill)
            const next: RegistrySkill = {
              ...current,
              state: 'review-disabled',
              ...(reason === 'capacity' ? { disabledFor: 'capacity' as const } : {}),
            }
            if (index < 0) skills.push(next)
            else skills[index] = next
            if (reason === 'capacity') draft.receipts.push(capacityReceipt(next, clock()))
          })
        })
      },
      async uninstall(name) {
        if (!isSavedSkillName(name)) throw installError('SKILL_NAME_INVALID')
        return serial(name, async () => {
          await pendingFor(name)
          const record = recordOf(name)
          if (record?.state === 'uninstalled') return
          const { disk, unchanged } = await owned(name)
          if (disk === 'absent') {
            setRecord(name, (current) => ({
              ...(current ?? (record as RegistrySkill)),
              state: 'uninstalled',
            }))
            return
          }
          if (!unchanged || !record) throw installError('SKILL_CHANGED_SINCE')
          await effect(
            '_agnes/v1/skills.remove',
            { resourceId: record.resourceId, expectedRevision: record.revision },
            `${randomUUID()}-uninstall`,
          )
          setRecord(name, (current) => ({ ...(current ?? record), state: 'uninstalled' }))
        })
      },
      async recover() {
        let finished = 0
        for (const entry of archive.journal.list()) {
          await serial(entry.name, async () => {
            if (!archive.journal.list().some((pending) => pending.id === entry.id)) return
            await finish(entry)
            finished++
          }).catch(() => {
            // Left in the journal for the next attempt; one stuck skill does not hold up the others.
          })
        }
        return finished
      },
    })
  }
  return Object.assign(forWorkspace, {
    exclusive<T>(workspaceId: string, name: string, task: () => Promise<T>): Promise<T> {
      if (!WORKSPACE_ID.test(workspaceId) || !isSavedSkillName(name))
        throw installError('SKILL_INSTALL_INVALID')
      return serialOn(workspaceId, name, task)
    },
  })
}
