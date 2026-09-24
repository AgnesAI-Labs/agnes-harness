import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agnesHome,
  type LockState,
  type ProfileInputs,
  type RuntimeProfileManifest,
  readConfigurationProfileInputs,
} from '@agnes/host'
import type { ModelSel, ParsedArgs } from '../args.js'
import { BootError, UsageError } from '../errors.js'

/**
 * Delegated to host's paths module so the CLI cannot resolve a different AGH_HOME than daemon or
 * doctor do for the same environment. An empty variable still counts as unset -- a process started
 * with AGH_HOME= would otherwise put its profiles directory at /profiles, and the resulting "no
 * such profile" is a long way from the cause -- and a relative one is now refused outright rather
 * than joined onto whatever directory the process happened to start in.
 */
export function resolveHome(env: NodeJS.ProcessEnv): string {
  return agnesHome(env)
}

/** A home of its own for one run, so `--ephemeral` writes nothing the machine keeps. */
export function makeEphemeralHome(): { home: string; dispose(): void } {
  const home = mkdtempSync(join(tmpdir(), 'agnes-ephemeral-'))
  return {
    home,
    dispose: () => {
      rmSync(home, { recursive: true, force: true })
    },
  }
}

export type ProfileFlags = { profile: string; preset?: string; model?: ModelSel; park: boolean; cwd: string }

// The name is pasted straight into a path under the home directory, so it has to be one plain
// directory name. A separator, or a dot entry, would read a profile from outside the profiles
// directory entirely -- `--profile ../../..` reaching a profile.yaml the user never installed.
function checkProfileName(name: string): string {
  if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name))
    throw new UsageError(`profile name ${name} is not a single path segment`)
  return name
}

export function profileNameFrom(p: ParsedArgs, env: NodeJS.ProcessEnv): string {
  return checkProfileName(p.profile ?? (env.AGNES_PROFILE || 'local-dev'))
}

/**
 * The profile layers this process can see, in the order host merges them. Nothing is resolved here:
 * host owns the merge, and handing it undefined-valued keys would make "absent" and "set to nothing"
 * the same thing, so a layer whose file is missing is left off the object entirely.
 *
 * There is no flags layer at all, and that is not an omission. host refuses every `flags` layer it is
 * handed (E_DEP_MISSING), because a resolved_profile_hash that attested to inputs nobody applied
 * would be a profile misrepresenting itself -- so a layer built here could only ever turn every boot
 * into a refusal naming an internal layer instead of the flag the user typed.
 *
 * Each of the three flags that would have gone in one therefore travels its own way, or is refused
 * by name where the user can see it: `--preset` rides on session/new, which daemon validates against
 * presets.allowed; `--park` and `--model` have no route at all in this build and are refused in
 * modes/print.ts. None of them may widen what a session can do, which is what kept them out of the
 * layer's remit even when the layer existed.
 */
// `agnesVersion` feeds the lockfile's empty-lock fallback (generatedBy) when the file is absent.
export async function readProfileInputs(o: {
  home: string
  cwd: string
  flags: ProfileFlags
  agnesVersion: string
  /** Test seam: an explicit lock wins over the profile's own agnes-lock.json. */
  lock?: LockState
  /** Host configuration is the final client-owned overlay and never contains a credential value. */
  configuration?: Partial<RuntimeProfileManifest>
}): Promise<ProfileInputs> {
  const profile = checkProfileName(o.flags.profile)
  try {
    return await readConfigurationProfileInputs({
      home: o.home,
      cwd: o.cwd,
      profile,
      agnesVersion: o.agnesVersion,
      ...(o.lock ? { lock: o.lock } : {}),
      ...(o.configuration ? { configuration: o.configuration } : {}),
    })
  } catch (e) {
    // Host owns the actual YAML reader. Keep the CLI's established error boundary so a malformed
    // profile names the file and exits as a boot error, while lock/profile resolution failures keep
    // their original Host error codes for callers that inspect them.
    if (e instanceof Error && / is not valid yaml$/.test(e.message)) {
      throw new BootError(e.message, e.cause)
    }
    if (e instanceof Error && / is not a mapping$/.test(e.message)) {
      throw new BootError(e.message)
    }
    throw e
  }
}
