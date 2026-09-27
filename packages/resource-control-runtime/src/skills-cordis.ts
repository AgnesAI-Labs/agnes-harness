import { createHash, randomUUID } from 'node:crypto'
import { type Context, type Fiber, symbols } from '@agnes/cordis'
import {
  type createSkillCandidateRegistry,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  RUNTIME_SKILL_PRIORITY,
  type RuntimeSkillOwner,
  runtimeSkillOwnerBlocks,
  type SkillCandidate,
} from './skills.js'

/** Disk frontmatter limits. Runtime registration uses the same bounds. */
export { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH }

const MAX_BODY_BYTES = 192 * 1024
const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type SkillRuntimeRegistration = Readonly<{
  name: string
  description: string
  body: string
}>

export type SkillProvider = Readonly<{
  skills(): readonly SkillRuntimeRegistration[]
}>

export type SkillProviderControl = Readonly<{
  readonly signal: AbortSignal
  /** Re-read this provider while its registration is still alive. A disposed registration ignores it. */
  invalidate(): void
}>

export type SkillCordisService = Readonly<{
  register(skill: SkillRuntimeRegistration): () => void
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
}>

declare module '@agnes/cordis' {
  interface Context {
    skills: SkillCordisService
  }
}

type SkillRegistry = ReturnType<typeof createSkillCandidateRegistry>

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function assertRegistration(skill: SkillRuntimeRegistration): void {
  if (typeof skill?.name !== 'string' || skill.name.length > MAX_NAME_LENGTH || !KEBAB_NAME.test(skill.name))
    throw new TypeError('runtime skill name must be kebab-case')
  if (
    typeof skill.description !== 'string' ||
    skill.description.length === 0 ||
    skill.description.length > MAX_DESCRIPTION_LENGTH
  )
    throw new TypeError('runtime skill description is empty or too long')
  if (typeof skill.body !== 'string' || Buffer.byteLength(skill.body, 'utf8') > MAX_BODY_BYTES)
    throw new TypeError('runtime skill body is too long')
}

function toCandidate(skill: SkillRuntimeRegistration): SkillCandidate {
  assertRegistration(skill)
  const sourceId = sha256(randomUUID())
  return Object.freeze({
    resourceId: `skill/runtime/runtime/${sourceId}`,
    name: skill.name,
    description: skill.description,
    revision: sha256(skill.body),
    capabilityHash: sha256(`${skill.name}\0${skill.description}`),
    sourceIdentity: Object.freeze({
      scope: 'runtime' as const,
      rootKey: 'runtime' as const,
      sourceId,
    }),
    priority: RUNTIME_SKILL_PRIORITY,
    body: skill.body,
  })
}

function assertUnique(skills: readonly SkillRuntimeRegistration[]): void {
  const seen = new Set<string>()
  for (const skill of skills) {
    assertRegistration(skill)
    const key = skill.name.trim().toLocaleLowerCase('en-US')
    if (seen.has(key)) throw new TypeError('runtime skill name already registered')
    seen.add(key)
  }
}

/**
 * Contribution-only cordis service. Plugins can register skills; they cannot list or read them.
 * Methods bind to the calling fiber because the service carries cordis's context tracker.
 */
const treeOwners = new WeakMap<object, string>()
let treeOwnerSeq = 0
/** One clash scope per cordis root. A replacement tree is a different root, so it may overlap. */
function treeOwner(ctx: Context): string {
  const root = ctx.root as object
  const existing = treeOwners.get(root)
  if (existing) return existing
  treeOwnerSeq += 1
  const created = `cordis-root:${treeOwnerSeq}`
  treeOwners.set(root, created)
  return created
}

/** Row identity installed by Host before a plugin apply. Absent for a raw `ctx.plugin()` test. */
export type SkillRuntimeRowLookup = {
  lookup(fiber: Fiber): { readonly rowId: string } | undefined
}

const rowLookups = new WeakMap<object, SkillRuntimeRowLookup>()

/** Associate the ordinary tree's row-origin lookup with the root the service was provided on. */
export function bindSkillRuntimeRows(root: object, lookup: SkillRuntimeRowLookup): void {
  rowLookups.set(root, lookup)
}

function ownerFor(ctx: Context): RuntimeSkillOwner {
  const scope = treeOwner(ctx)
  const rowId = rowLookups.get(ctx.root)?.lookup(ctx.fiber)?.rowId
  const fiberId = ctx.fiber.uid
  if (rowId === undefined || rowId.length === 0 || fiberId === null) return { scope }
  return { scope, rowId, fiberId: String(fiberId) }
}

export function createSkillCordisService(registry: SkillRegistry): SkillCordisService {
  const service: SkillCordisService = {
    register(this: { ctx: Context }, skill) {
      const owner = ownerFor(this.ctx)
      const candidate = toCandidate(skill)
      return this.ctx.effect(() => {
        const id = registry.registerRuntime(candidate, owner)
        let removed = false
        return () => {
          if (removed) return
          removed = true
          registry.unregisterRuntime(id)
        }
      }, `ctx.skills.register(${skill.name})`)
    },
    registerProvider(this: { ctx: Context }, create) {
      const owner = ownerFor(this.ctx)
      return this.ctx.effect(() => {
        const abort = new AbortController()
        let alive = true
        let ids: string[] = []
        const owned = new Set<string>()
        const publish = (skills: readonly SkillRuntimeRegistration[]) => {
          assertUnique(skills)
          const candidates = skills.map(toCandidate)
          for (const candidate of candidates) {
            const key = candidate.name.trim().toLocaleLowerCase('en-US')
            for (const [id, existing] of registry.runtimeMap()) {
              if (owned.has(id)) continue
              if (
                existing.name.trim().toLocaleLowerCase('en-US') === key &&
                runtimeSkillOwnerBlocks(registry.runtimeOwners().get(id), owner)
              )
                throw new TypeError('runtime skill name already registered')
            }
          }
          for (const id of ids) registry.unregisterRuntime(id)
          ids = candidates.map((candidate) => registry.registerRuntime(candidate, owner))
          owned.clear()
          for (const id of ids) owned.add(id)
        }
        let provider: SkillProvider | undefined
        const control: SkillProviderControl = Object.freeze({
          signal: abort.signal,
          invalidate() {
            if (!alive || !provider) return
            publish(provider.skills())
          },
        })
        provider = create(control)
        publish(provider.skills())
        return () => {
          if (!alive) return
          alive = false
          abort.abort()
          for (const id of ids) registry.unregisterRuntime(id)
          ids = []
          owned.clear()
        }
      }, 'ctx.skills.registerProvider')
    },
  }
  Object.defineProperty(service, symbols.tracker, { value: { property: 'ctx' } })
  return service
}
