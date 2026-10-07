import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type PackageBlocker, type PluginCapabilities, validatePackageAdminData } from '@agnes/protocol'
import { PackageError } from './errors.js'
import { readStaticJson } from './integrity.js'

export type PluginCapabilityPolicy = Readonly<{ allow?: readonly string[]; deny?: readonly string[] }>

export function parsePluginCapabilities(value: unknown): PluginCapabilities | undefined {
  if (value === undefined) return undefined
  const checked = validatePackageAdminData('PluginCapabilities', value)
  if (
    !checked.ok ||
    capabilityAtoms(value as PluginCapabilities).some((atom) => /[\u0000-\u001f]/.test(atom))
  )
    throw new PackageError(
      'E_EXT_LOAD',
      'Plugin capability schema is invalid; fix agnes.capabilities. See docs/guide/packages.md#capabilities',
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
    ...(['model', 'childAgents', 'ui'] as const).filter((key) => value[key] === true),
  ].sort()
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

/** Deny is conservative: a wildcard request cannot conceal a narrower denied scope. */
export function capabilityPolicyBlockers(
  declarations: PluginCapabilities | undefined,
  policy: PluginCapabilityPolicy,
): PackageBlocker[] {
  const blocked = capabilityAtoms(declarations).filter((atom) => {
    const denied = (policy.deny ?? []).some(
      (rule) =>
        matches(rule.startsWith('network:') ? rule.toLowerCase() : rule, atom) ||
        matches(atom, rule.startsWith('network:') ? rule.toLowerCase() : rule) ||
        (atom.includes('*') && rule.includes('*') && atom.split(':')[0] === rule.split(':')[0]),
    )
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

export function readPluginCapabilities(directory: string): PluginCapabilities | undefined {
  const manifest = readStaticJson(join(directory, 'package.json'))
  return parsePluginCapabilities((manifest.agnes as Record<string, unknown> | undefined)?.capabilities)
}
