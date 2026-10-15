import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  type JsonValue,
  jcs,
  type PackageBlocker,
  type PluginCapabilities,
  transportCapabilityProblems,
  validatePackageAdminData,
} from '@agnes/protocol'
import { PackageError } from './errors.js'
import { readStaticJson } from './integrity.js'

export type PluginCapabilityPolicy = Readonly<{ allow?: readonly string[]; deny?: readonly string[] }>

export function parsePluginCapabilities(value: unknown): PluginCapabilities | undefined {
  if (value === undefined) return undefined
  const checked = validatePackageAdminData('PluginCapabilities', value)
  if (
    !checked.ok ||
    transportCapabilityProblems(checked.ok ? (checked.value as PluginCapabilities) : {}).length > 0 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control bytes at the identifier or path boundary.
    capabilityAtoms(value as PluginCapabilities).some((atom) => /[\u0000-\u001f]/.test(atom))
  )
    throw new PackageError(
      'E_EXT_LOAD',
      'Plugin capability schema is invalid; fix agnes.plugins[].capabilities. See docs/guide/packages.md#capabilities',
    )
  return checked.value as PluginCapabilities
}

/** Human-readable atoms are also the policy vocabulary. No values or credentials are included. */
export function capabilityAtoms(value: PluginCapabilities | undefined): string[] {
  if (!value) return []
  return [
    ...(['network', 'exec', 'secrets', 'credentials'] as const).flatMap((key) =>
      (value[key] ?? []).map((scope) => `${key}:${key === 'network' ? scope.toLowerCase() : scope}`),
    ),
    ...(['read', 'write'] as const).flatMap((key) =>
      (value.filesystem?.[key] ?? []).map((scope) => `filesystem.${key}:${scope}`),
    ),
    ...(['model', 'childAgents', 'ui', 'device', 'wake', 'store'] as const).filter(
      (key) => value[key] === true,
    ),
    ...(value.uiData ?? []).map((permission) => `uiData:${permission}`),
    ...(value.streams ?? []).map((stream) => `streams:${stream.scope}:${stream.name}:${stream.lane}`),
    ...(value.managedServices ?? []).map((service) => `managedServices:${service.scope}:${service.id}`),
  ].sort()
}

/** Category ceiling is an admission check on declarations, never JavaScript isolation. */
export function pluginCapabilityCategories(value: PluginCapabilities | undefined): string[] {
  if (!value) return []
  return Object.entries(value)
    .flatMap(([key, declared]) => {
      if (key === 'filesystem')
        return ['read', 'write']
          .filter((access) => value.filesystem?.[access as 'read' | 'write']?.length)
          .map((access) => `filesystem.${access}`)
      if (
        declared === true ||
        (Array.isArray(declared) && declared.length) ||
        (declared && typeof declared === 'object' && !Array.isArray(declared))
      )
        return [key]
      return []
    })
    .sort()
}

export function readPluginCapabilityPolicy(profileDir: string): PluginCapabilityPolicy {
  const file = join(profileDir, 'plugin-capabilities.json')
  if (!existsSync(file)) return {}
  const data = readStaticJson(file)
  if (
    Object.keys(data).some((key) => key !== 'allow' && key !== 'deny') ||
    ['allow', 'deny'].some(
      (key) =>
        data[key] !== undefined &&
        (!Array.isArray(data[key]) ||
          data[key].length > 512 ||
          data[key].some(
            (item: unknown) =>
              // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control bytes at the identifier or path boundary.
              typeof item !== 'string' || !item || item.length > 1024 || /[\u0000-\u001f]/.test(item),
          )),
    )
  )
    throw new PackageError(
      'E_CEILING_EXCEEDED',
      'Capability policy is invalid; fix plugin-capabilities.json. See docs/guide/packages.md#capabilities',
    )
  return data as PluginCapabilityPolicy
}

function matches(pattern: string, value: string): boolean {
  let p = 0,
    v = 0,
    star = -1,
    retry = 0
  while (v < value.length) {
    if (pattern[p] === '*') {
      star = p++
      retry = v
    } else if (pattern[p] === value[v]) {
      p++
      v++
    } else if (star >= 0) {
      p = star + 1
      v = ++retry
    } else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}

/** `network:host` for a `network:host:port` atom; undefined for any other atom. */
function networkHost(atom: string): string | undefined {
  if (!atom.startsWith('network:')) return undefined
  const scope = atom.slice('network:'.length)
  const port = scope.lastIndexOf(':')
  return port < 0 ? undefined : `network:${scope.slice(0, port)}`
}

/** Deny is conservative: a wildcard request cannot conceal a narrower denied scope. */
export function capabilityPolicyBlockers(
  declarations: PluginCapabilities | undefined,
  policy: PluginCapabilityPolicy,
): PackageBlocker[] {
  const blocked = capabilityAtoms(declarations).filter((atom) => {
    const host = networkHost(atom)
    const denied = (policy.deny ?? []).some((rule) => {
      const normalized = rule.startsWith('network:') ? rule.toLowerCase() : rule
      return (
        matches(normalized, atom) ||
        matches(atom, normalized) ||
        (atom.includes('*') && rule.includes('*') && atom.split(':')[0] === rule.split(':')[0]) ||
        // A host declared without a port reaches every port, so a port-less host rule denies them all.
        (host !== undefined &&
          normalized.startsWith('network:') &&
          !normalized.slice('network:'.length).includes(':') &&
          (matches(normalized, host) || matches(host, normalized)))
      )
    })
    const allowed =
      policy.allow === undefined ||
      policy.allow.some(
        (rule) =>
          rule === '*' ||
          rule === atom ||
          (!atom.includes('*') && matches(rule, atom)) ||
          (rule.endsWith('*') && atom.startsWith(rule.slice(0, -1))),
      )
    return denied || !allowed
  })
  return blocked.length
    ? [{ code: 'policy', references: ['capability-blocked', ...blocked.slice(0, 127)] }]
    : []
}

const AUTHORITY_LISTS = ['network', 'exec', 'secrets', 'credentials', 'uiData'] as const
const AUTHORITY_FLAGS = ['model', 'device', 'childAgents', 'ui', 'store', 'wake'] as const

/**
 * The package-level view of its plugins' capabilities: the authority a package needs is the union of
 * what each plugin declares, including service/transport contracts for review. Runtime callers
 * select the exact verified export rather than granting a sibling row this union.
 */
export function mergePluginCapabilities(
  declared: readonly (PluginCapabilities | undefined)[],
): PluginCapabilities | undefined {
  const present = declared.filter((value): value is PluginCapabilities => value !== undefined)
  if (present.length === 0) return undefined
  const merged: Record<string, unknown> = {}
  for (const key of AUTHORITY_LISTS) {
    const values = [...new Set(present.flatMap((capabilities) => capabilities[key] ?? []))]
    if (present.some((capabilities) => capabilities[key] !== undefined)) merged[key] = values
  }
  for (const key of AUTHORITY_FLAGS)
    if (present.some((capabilities) => capabilities[key] !== undefined))
      merged[key] = present.some((capabilities) => capabilities[key] === true)
  for (const access of ['read', 'write'] as const) {
    const scopes = [...new Set(present.flatMap((capabilities) => capabilities.filesystem?.[access] ?? []))]
    if (present.some((capabilities) => capabilities.filesystem?.[access] !== undefined))
      merged.filesystem = { ...(merged.filesystem as object | undefined), [access]: scopes }
  }
  for (const key of ['services', 'streams', 'managedServices'] as const) {
    if (present.some((c) => c[key] !== undefined)) {
      const byValue = new Map<string, JsonValue>()
      for (const capability of present)
        for (const d of capability[key] ?? []) byValue.set(jcs(d), structuredClone(d))
      merged[key] = [...byValue.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, d]) => d)
    }
  }
  return merged as PluginCapabilities
}

/** Package previews use the union; runtime registration must select its verified export. */
export function readPluginCapabilities(
  directory: string,
  exportName?: string,
): PluginCapabilities | undefined {
  const manifest = readStaticJson(join(directory, 'package.json'))
  const plugins =
    (manifest.agnes as { plugins?: { export?: string; capabilities?: unknown }[] } | undefined)?.plugins ?? []
  if (exportName !== undefined) {
    const entries = plugins.filter((entry) => entry.export === exportName)
    if (entries.length !== 1)
      throw new PackageError('E_EXT_LOAD', 'Plugin export capabilities are unavailable')
    return parsePluginCapabilities(entries[0]?.capabilities)
  }
  return mergePluginCapabilities(plugins.map((entry) => parsePluginCapabilities(entry.capabilities)))
}
