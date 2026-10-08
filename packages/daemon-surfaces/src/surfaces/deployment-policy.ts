import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { DeploymentPolicy } from '@agnes/host'
import { readSurfaceInstances } from '@agnes/package-manager'

/** The operator-owned grant ceiling. It deliberately lives in the profile directory and NOT in the
 * customer deploy directory: the deploy directory is customer-authored, so letting it carry its own
 * ceiling would be self-authorization. A sourceId the operator never mentioned gets an empty
 * ceiling, which resolveDeployment accepts (Object.hasOwn passes, [] is not nullish) while refusing
 * every grant the descriptor asks for. */
export function buildDeploymentPolicy(input: {
  deployDir: string
  profileDir: string
  harnessVersion: string
  surfaceApiVersion: string
}): DeploymentPolicy {
  const overrides = readOverrides(input.profileDir, input.deployDir)
  const grants: Record<string, readonly unknown[]> = {}
  // readSurfaceInstances returns { manifest, instances }, where instances is a { path, instance }[]
  // -- the sourceId/grants fields live one level down, under .instance, not on the array element.
  const { instances } = readSurfaceInstances(input.deployDir)
  for (const { instance } of instances) {
    grants[instance.sourceId] = overrides[instance.sourceId] ?? []
  }
  return Object.freeze({
    harnessVersion: input.harnessVersion,
    surfaceApiVersion: input.surfaceApiVersion,
    grants: Object.freeze(grants),
  }) as DeploymentPolicy
}

function readOverrides(profileDir: string, deployDir: string): Record<string, readonly unknown[]> {
  const file = join(profileDir, 'deployment-policy.json')
  // M7 (final review, Minor): RC5's security argument (module doc above) is that this file lives
  // OUTSIDE the customer-authored deploy directory. `package-manager/src/workspace.ts`'s
  // `isContained` treats `rel === ''` as contained, so a profile where `deployDir === profileDir`
  // (an operator ran `agnes profile trust <profileDir>` pointing straight at the profile root, not a
  // subdirectory of it) would otherwise let the customer-authored deploy tree supply its own policy
  // file -- self-authorization. Fail closed (empty policy, same as "no override file") whenever the
  // resolved policy file path would fall inside `deployDir`, rather than relying on operators never
  // trusting the profile root directly. Same relative()-based containment idiom as
  // `local-runtime.ts`/`workspace.ts`.
  const rel = relative(deployDir, file)
  const insideDeployDir = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  if (insideDeployDir) return {}
  if (!existsSync(file)) return {}
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const grants = (raw as { grants?: unknown }).grants
    if (typeof grants !== 'object' || grants === null || Array.isArray(grants)) return {}
    const out: Record<string, readonly unknown[]> = {}
    for (const [key, value] of Object.entries(grants as Record<string, unknown>)) {
      if (Array.isArray(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}
