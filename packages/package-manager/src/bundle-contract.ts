import {
  type BundleLaunch,
  type CompositionPatch,
  inspectJsonData,
  type PresetDoc,
  validateAgainst,
  validatePreset,
} from '@agnes/protocol'
import { BundleLaunch as LaunchSchema } from '@agnes/protocol/gen/extension-manifest'
import { CompositionPatch as PatchSchema } from '@agnes/protocol/gen/profile'

export type PackageBundleDocument = {
  extends?: string[]
  profile?: CompositionPatch
  presets?: Record<string, PresetDoc>
  launch?: BundleLaunch
}
export type PackageBundleCatalog = Readonly<
  Record<
    string,
    Readonly<{
      id: string
      sourcePackage: string
      document: PackageBundleDocument
    }>
  >
>
const ID = /^[a-z][a-z0-9-]{0,63}$/
const REF =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)#[a-z][a-z0-9-]{0,63}$/
const map = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fail = (message: string): never => {
  throw new TypeError(`composition: ${message}`)
}

/** Shared, pure author-data parser. No package imports, filesystem reads or deployment defaults. */
export function parsePackageBundleContract(packageId: string, input: unknown): PackageBundleCatalog {
  if (input === undefined) return Object.freeze({})
  const data = inspectJsonData(input, 1_048_576)
  if (!data.ok) return fail('bundles must be JSON data')
  if (!map(data.value) || Object.keys(data.value).length > 64) fail('bundles must be a bounded JSON map')
  const result: Record<string, PackageBundleCatalog[string]> = Object.create(null)
  for (const [name, raw] of Object.entries(data.value as Record<string, unknown>)) {
    if (
      !ID.test(name) ||
      !map(raw) ||
      Object.keys(raw).some((k) => !['extends', 'profile', 'presets', 'launch'].includes(k))
    )
      fail(`invalid bundle ${name}`)
    const doc = raw as Record<string, unknown>
    if (
      doc.extends !== undefined &&
      (!Array.isArray(doc.extends) ||
        doc.extends.length > 64 ||
        doc.extends.some((ref) => typeof ref !== 'string' || !REF.test(ref)) ||
        new Set(doc.extends).size !== doc.extends.length)
    )
      fail(`invalid extends in ${name}: use unique full package#bundle references`)
    if (doc.profile !== undefined && !validateAgainst(PatchSchema, doc.profile).ok)
      fail(`invalid profile in ${name}`)
    if (doc.presets !== undefined && (!map(doc.presets) || Object.keys(doc.presets).length > 64))
      fail(`invalid presets in ${name}`)
    for (const [id, preset] of Object.entries((doc.presets ?? {}) as Record<string, unknown>)) {
      if (!ID.test(id) || !map(preset) || preset.name !== id || !validatePreset(preset).ok)
        fail(`invalid preset ${id}`)
      const p = preset as PresetDoc
      if (p.composition && !validateAgainst(PatchSchema, p.composition).ok)
        fail(`invalid composition in preset ${id}`)
      if (p.composition?.providers) fail(`preset ${id}: select providers in the preset's providers table`)
    }
    if (doc.launch !== undefined) {
      if (!validateAgainst(LaunchSchema, doc.launch).ok) fail(`invalid launch in ${name}`)
      const launch = doc.launch as BundleLaunch
      for (const value of Object.values(launch.prompt?.text ?? {}))
        if (new TextEncoder().encode(value).byteLength > 16384 || /secret:\/\//i.test(value))
          fail(`invalid draft prompt in ${name}`)
    }
    const id = `${packageId}#${name}`
    result[id] = Object.freeze({
      id,
      sourcePackage: packageId,
      document: structuredClone(doc) as PackageBundleDocument,
    })
  }
  return Object.freeze(result)
}

export type StaticPreflight = {
  level: 'structural' | 'static-references' | 'deployment-dependent' | 'refused'
  reasons: string[]
  next: 'resolve-static-references' | 'validate-deployment' | 'review-trust' | 'fix-declaration'
}

/** References are checked without evaluating untrusted JavaScript. Unknown dependency data waits. */
export function preflightPackageBundles(input: {
  packageId: string
  bundles: unknown
  dependencies?: Readonly<Record<string, string>>
  catalog?: PackageBundleCatalog
  pages?: readonly string[]
  runtime?: readonly {
    runtime: string
    capabilities?:
      | { model?: boolean; tools?: unknown; resources?: unknown; services?: unknown; projections?: unknown }
      | undefined
  }[]
  stage?: 'structural'
}): StaticPreflight {
  try {
    const local = parsePackageBundleContract(input.packageId, input.bundles)
    if (input.stage === 'structural')
      return { level: 'structural', reasons: [], next: 'resolve-static-references' }
    const catalog = Object.assign(Object.create(null), input.catalog, local) as PackageBundleCatalog
    const pending = new Set<string>()
    const get = (ref: string) => {
      if (Object.hasOwn(catalog, ref)) return catalog[ref]
      const owner = ref.slice(0, ref.indexOf('#'))
      if (owner !== input.packageId && Object.hasOwn(input.dependencies ?? {}, owner)) {
        pending.add('dependency-definitions-required')
        return undefined
      }
      fail(`unknown bundle ${ref}`)
    }
    const visiting = new Set<string>()
    const checkOwner = (ref: string, sourcePackage: string) => {
      const owner = ref.slice(0, ref.indexOf('#'))
      if (
        sourcePackage === input.packageId &&
        owner !== input.packageId &&
        !Object.hasOwn(input.dependencies ?? {}, owner)
      )
        fail(`undeclared bundle dependency ${owner}`)
    }
    // Only the scalar extends link affects this check. An omitted child link keeps the parent's
    // link, just as the compiler's recursive map merge does. Each Bundle is applied once in DFS
    // parent-to-child order, including diamonds shared by several parents.
    type PresetLink = { parent?: string | undefined; known: boolean }
    for (const entry of Object.values(local)) {
      const presets = new Map<string, PresetLink>()
      const applied = new Set<string>()
      let unknownPresets = false
      const walk = (ref: string) => {
        if (visiting.size >= 64 || visiting.has(ref))
          fail(`bundle inheritance cycle or excessive depth at ${ref}`)
        if (applied.has(ref)) return
        const base = get(ref)
        if (!base) {
          // Missing parents may define or override any preset. A later explicit link can make
          // that individual edge known again; an omitted link cannot prove the chain terminates.
          unknownPresets = true
          for (const preset of presets.values()) preset.known = false
          applied.add(ref)
          return
        }
        visiting.add(ref)
        for (const parent of base.document.extends ?? []) {
          checkOwner(parent, base.sourcePackage)
          walk(parent)
        }
        visiting.delete(ref)
        applied.add(ref)
        for (const [id, preset] of Object.entries(base.document.presets ?? {})) {
          const previous = presets.get(id)
          presets.set(id, {
            parent: preset.extends ?? previous?.parent,
            known: preset.extends !== undefined || (previous?.known ?? !unknownPresets),
          })
          for (const selected of preset.bundles ?? []) {
            if (!REF.test(selected)) fail(`invalid bundle reference ${selected}`)
            checkOwner(selected, base.sourcePackage)
            get(selected)
          }
        }
      }
      walk(entry.id)
      for (const name of presets.keys()) {
        const seen = new Set<string>()
        let current: string | undefined = name
        while (current) {
          if (seen.has(current)) fail(`preset extends cycle at ${current}`)
          seen.add(current)
          const preset: PresetLink | undefined = presets.get(current)
          if (!preset || !preset.known) {
            pending.add(`preset-inheritance-definition-required:${current}`)
            break
          }
          current = preset.parent
        }
      }
      const launch = entry.document.launch
      if (launch && !presets.has(launch.preset))
        pending.add(`launch-preset-definition-required:${launch.preset}`)
      if (launch?.pages?.some((page) => !input.pages?.includes(page)))
        fail(`unknown launch page in ${entry.id}`)
    }
    for (const row of input.runtime ?? []) {
      if (row.runtime === 'isolated') fail('unsupported isolated plugin runtime contract')
    }
    if (input.runtime?.length) pending.add('runtime-registration-required')
    if (pending.size)
      return {
        level: 'deployment-dependent',
        reasons: [...pending],
        next: 'validate-deployment',
      }
    return { level: 'static-references', reasons: [], next: 'review-trust' }
  } catch (error) {
    return {
      level: 'refused',
      reasons: [error instanceof Error ? error.message : 'invalid declaration'],
      next: 'fix-declaration',
    }
  }
}
