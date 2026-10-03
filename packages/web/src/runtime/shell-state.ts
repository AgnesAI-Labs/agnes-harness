// The Web client's shell switch. A client instance shows one shell at a time, and this switcher owns
// its mount surface: every shell mounts into a container of its own under the surface, with a fresh
// owner token and abort signal. A replacement is validated before the current shell is touched, then
// mounted hidden beside it and handed the current shell's exported view state. Only a candidate that
// mounted and imported becomes current; only then does the old shell stop admission and get disposed,
// so any candidate failure leaves the old shell mounted and admitting. The switcher calls shells and
// containers only, never the backend: a blocked or failed switch holds up no other client and no run.
import type {
  Outcome,
  RuntimeError,
  SchemaRef,
  ShellProvider,
  ShellServices,
  ShellSnapshot,
  ShellViewState,
} from '@agnes/extension-api/client'

export interface ShellSwitcher {
  current(): ShellProvider | undefined
  /** Replaces the current shell, or mounts the first one. Refused while another switch is running. */
  switchTo(factory: () => ShellProvider): Promise<Outcome<void>>
  /** Disposes the current shell and any candidate in flight. Idempotent. */
  dispose(): Promise<void>
}

// `mounted` is set once mount is called; a shell never handed a container gets no lifecycle calls.
type Owner = { shell: ShellProvider; container: HTMLElement; controller: AbortController; mounted: boolean }

const REGIONS = new Set(['conversation', 'composer', 'resources', 'interactions', 'settings'])
const METHODS = ['mount', 'update', 'exportState', 'importState', 'stopAdmission', 'dispose'] as const

const refuse = (
  code: RuntimeError['code'],
  detailCode: string,
  message: string,
): { ok: false; error: RuntimeError } => ({
  ok: false,
  error: { code, detailCode, message, retryAdvice: { kind: 'never' }, diagnosticId: 'web-shell-switch' },
})
const closed = () => refuse('cancelled', 'shell_switcher_disposed', 'the client closed')

const text = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** One call into a shell. A refusal, a throw or a malformed outcome all become one switcher error. */
async function attempt<T>(
  code: RuntimeError['code'],
  detailCode: string,
  what: string,
  call: () => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  let reason: string
  try {
    const result = await call()
    if (result.ok) return result
    reason = String(result.error.message)
  } catch (error) {
    reason = text(error)
  }
  return refuse(code, detailCode, `${what}: ${reason}`)
}

const schemaRef = (value: unknown): value is SchemaRef =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as SchemaRef).typeId === 'string' &&
  Number.isSafeInteger((value as SchemaRef).revision) &&
  typeof (value as SchemaRef).digest === 'string'

/**
 * Whether a shell declaring `reader` can import view state written under `written`. The type id
 * carries the schema's major version, so it must match. A later revision of a major only adds, so a
 * reader at the same or a later revision reads the state; the same revision must be the same schema.
 */
const reads = (reader: SchemaRef, written: SchemaRef) =>
  reader.typeId === written.typeId &&
  (reader.revision > written.revision ||
    (reader.revision === written.revision && reader.digest === written.digest))

/** Why `shell` cannot replace `current`, or undefined when it can. */
function incompatibility(shell: ShellProvider, current: ShellProvider | undefined): string | undefined {
  if (!METHODS.every((name) => typeof shell?.[name] === 'function')) return 'the shell lacks a shell method'
  const descriptor = shell.descriptor
  if (typeof descriptor?.id !== 'string' || descriptor.id === '') return 'the shell has no id'
  if (descriptor.apiMajor !== 1) return `shell API ${String(descriptor.apiMajor)} is not supported`
  const regions: unknown = descriptor.requiredRegions
  if (
    !Array.isArray(regions) ||
    new Set(regions).size !== regions.length ||
    !regions.every((region) => REGIONS.has(region))
  )
    return 'the shell requires a region this client does not offer'
  if (!schemaRef(descriptor.stateSchema)) return 'the shell state schema is malformed'
  const written = current?.descriptor.stateSchema
  if (written && !reads(descriptor.stateSchema, written))
    return `the shell cannot read view state ${written.typeId} revision ${written.revision}`
  return undefined
}

export function createShellSwitcher(input: {
  /** The client's mount surface. The switcher adds and removes its shell containers here. */
  surface: HTMLElement
  services: ShellServices
  /** The latest snapshot, read when a shell mounts and again before a candidate takes over. */
  snapshot: () => ShellSnapshot
}): ShellSwitcher {
  let current: Owner | undefined
  let switching: { controller: AbortController; done: Promise<Outcome<void>> } | undefined
  let disposed = false
  let closing: Promise<void> | undefined

  // ponytail: no mount or dispose deadline, so a shell that never settles stalls this client's switch
  // and close (no other client's). Race these calls against the lifecycle deadlines if that matters.
  /** Ends an owner in lifecycle order: stop admission, abort, dispose, then remove its container. */
  async function end(owner: Owner, reason: 'switch' | 'shutdown' | 'fault'): Promise<void> {
    if (!owner.mounted) {
      owner.controller.abort()
      owner.container.remove()
      return
    }
    try {
      owner.shell.stopAdmission()
    } catch {
      // A shell that throws while ending is ended all the same.
    }
    owner.controller.abort()
    try {
      await owner.shell.dispose(reason)
    } catch {
      // As above.
    }
    owner.container.remove()
  }

  /** Ends a candidate that will not become current and gives the old shell its input back. */
  async function fallBack(candidate: Owner, reason: 'shutdown' | 'fault', result: Outcome<void>) {
    await end(candidate, reason)
    if (current) current.container.inert = false
    return result
  }

  async function run(factory: () => ShellProvider, controller: AbortController): Promise<Outcome<void>> {
    let shell: ShellProvider
    try {
      shell = factory()
    } catch (error) {
      return refuse('invalid_input', 'shell_invalid', `the shell could not be created: ${text(error)}`)
    }
    const candidate: Owner = { shell, container: document.createElement('div'), controller, mounted: false }
    const old = current
    const problem = incompatibility(shell, old?.shell)
    if (problem) return fallBack(candidate, 'fault', refuse('incompatible', 'shell_incompatible', problem))

    let state: ShellViewState | undefined
    if (old) {
      // The old shell takes no input while its state is in transit, so nothing typed meanwhile is
      // lost. Unlike stopAdmission, which has no undo and is called only once the candidate is
      // current, this is lifted again when the switch does not go through.
      old.container.inert = true
      // A shell refuses the export when it holds an unsaved buffer its view state cannot carry, such
      // as an upload in progress; the switch is then blocked with the shell's reason.
      const exported = await attempt(
        'conflict',
        'shell_state_blocked',
        'the current shell cannot hand over its state',
        () => old.shell.exportState(),
      )
      if (!exported.ok) return fallBack(candidate, 'shutdown', exported)
      if (disposed) return fallBack(candidate, 'shutdown', closed())
      state = exported.value
    }

    candidate.container.hidden = true
    input.surface.append(candidate.container)
    let sent = input.snapshot()
    candidate.mounted = true
    let result = await attempt('internal', 'shell_candidate_failed', 'the new shell failed to mount', () =>
      shell.mount({
        container: candidate.container,
        snapshot: sent,
        services: input.services,
        ownerToken: crypto.randomUUID(),
        signal: controller.signal,
      }),
    )
    if (result.ok && state && !disposed) {
      const imported = state
      result = await attempt('internal', 'shell_candidate_failed', 'the new shell failed to import', () =>
        shell.importState(imported),
      )
    }
    // Snapshots that arrived while the candidate was mounting reached only the old shell.
    for (
      let latest = input.snapshot();
      result.ok && !disposed && latest !== sent;
      latest = input.snapshot()
    ) {
      sent = latest
      result = await attempt('internal', 'shell_candidate_failed', 'the new shell failed to update', () =>
        shell.update(latest),
      )
    }
    if (disposed) return fallBack(candidate, 'shutdown', closed())
    if (!result.ok) return fallBack(candidate, 'fault', result)

    // Nothing from the last snapshot read to `current = candidate` waits, so no update falls between.
    if (old) old.container.hidden = true
    candidate.container.hidden = false
    current = candidate
    if (old) await end(old, 'switch')
    return { ok: true, value: undefined }
  }

  return {
    current: () => current?.shell,
    async switchTo(factory) {
      if (disposed) return closed()
      if (switching) return refuse('conflict', 'shell_switch_in_progress', 'another shell switch is running')
      const controller = new AbortController()
      const done = run(factory, controller).finally(() => {
        switching = undefined
      })
      switching = { controller, done }
      return done
    },
    dispose() {
      disposed = true
      closing ??= (async () => {
        switching?.controller.abort()
        await switching?.done
        const last = current
        current = undefined
        if (last) await end(last, 'shutdown')
      })()
      return closing
    },
  }
}
