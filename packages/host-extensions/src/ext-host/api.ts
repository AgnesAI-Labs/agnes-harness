import type { Disposer, ExtensionAPI, ToolDef } from '@agnes/extension-api'
import { ExtensionError } from '@agnes/extension-api'
import type { ExtensionManifest } from './manifest.js'
import type { KernelPorts } from './ports.js'

/** The one kernel registry this host hands to an extension. It is `Kernel.tools`, nothing wider. */
export type ToolPort = KernelPorts['tools']

// Five of the six members of ExtensionAPI are capabilities this host does not grant. They are
// present and throw, rather than absent or silently doing nothing: an extension that reaches for a
// hook gets a refusal naming the member, at the moment it reaches, instead of a handler that is
// never called and a turn that quietly behaves as though it had been.
function ungranted(extId: string, member: string): never {
  throw new ExtensionError('E_CAPABILITY_UNDECLARED', `${member} is not granted by this host`, {
    extId,
    detail: { member, granted: ['registerTool'] },
  })
}

function checkDeclared(m: ExtensionManifest, name: string): void {
  const refuse = (why: string): never => {
    throw new ExtensionError('E_CAPABILITY_UNDECLARED', `tool ${name} ${why}`, {
      extId: m.id,
      detail: { tool: name, prefix: m.tools.prefix, declared: m.tools.names },
    })
  }
  if (!name.startsWith(m.tools.prefix)) refuse(`does not carry the declared prefix ${m.tools.prefix}`)
  if (m.tools.names !== null && !m.tools.names.includes(name))
    refuse('is not one of the tool names the manifest declares')
}

/**
 * The extension API object for one extension: `registerTool` and five refusals.
 *
 * The manifest is an upper bound in one direction only. Registering a name it does not declare is
 * refused, because that is authority escaping the file the deployment reviewed; declaring a name
 * nothing registers is allowed, because a name nobody registers is a name nobody can call — the
 * model is offered the tool registry, never the manifest.
 */
export function buildExtensionApi(
  m: ExtensionManifest,
  port: ToolPort,
  onRegister: (name: string, dispose: Disposer) => Disposer,
  isRegistering: () => boolean,
): ExtensionAPI {
  return {
    registerTool(def: ToolDef): Disposer {
      if (!isRegistering()) ungranted(m.id, 'registerTool outside factory')
      const name = String((def as { name?: unknown }).name)
      checkDeclared(m, name)
      // This legacy loader has no resolved inventory/lock attestation. It can continue to load
      // static built-ins, but it can never mint classified-tool provenance or a Host domain.
      const dispose = port.add(def, { source: m.id, trust: 'builtin' })
      return onRegister(name, dispose)
    },
    registerService: () => ungranted(m.id, 'registerService'),
    registerProjection: () => ungranted(m.id, 'registerProjection'),
    registerHook: () => ungranted(m.id, 'registerHook'),
    registerSlot: () => ungranted(m.id, 'registerSlot'),
    registerResource: () => ungranted(m.id, 'registerResource'),
    get events(): never {
      return ungranted(m.id, 'events')
    },
    get ctx(): never {
      return ungranted(m.id, 'ctx')
    },
  }
}
