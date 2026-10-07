import type {
  ToolPolicy,
  ToolPolicyRegistryPort,
  ToolRuntimeProvider,
  ToolRuntimeRegistryPort,
} from '@agnes/extension-api'
import { defaultToolRuntimeProvider } from './tool-runtime.js'

/** Also used by standalone Kernels; Base registers the same default through its plugin row. */
export const defaultToolPolicy: ToolPolicy = {
  id: 'default',
  version: '1.0.0',
  decide(input, signal) {
    signal.throwIfAborted()
    const management = [
      'subagent_fork',
      'subagent_spawn',
      'subagent_collect',
      'subagent_cancel',
      'subagent_list',
      'subagent_send_message',
      'subagent_interrupt',
    ].includes(input.call.name)
    const ask =
      !management &&
      !input.fullAccess &&
      input.approvalMode !== 'off' &&
      (input.policy.requiresApproval === 'always' ||
        (input.policy.requiresApproval === 'destructive' && input.policy.isDestructive) ||
        (input.tainted && !input.policy.isReadOnly))
    return {
      effect: ask ? 'ask' : 'allow',
      reason: ask ? 'Tool risk requires approval' : 'Default tool policy',
    }
  },
}

/** Small registries shared by Cordis services and directly embedded Kernels. */
class Providers<T extends { id: string; version: string }> {
  private readonly entries = new Map<string, { provider: T; sourcePackage: string }>()
  register(sourcePackage: string, provider: T): () => void {
    if (!provider.id?.trim() || !provider.version?.trim() || this.entries.has(provider.id))
      throw new Error(`Provider ${provider.id} is invalid or already registered`)
    const entry = { provider, sourcePackage }
    this.entries.set(provider.id, entry)
    return () => {
      if (this.entries.get(provider.id) === entry) this.entries.delete(provider.id)
    }
  }
  resolve(id: string): T {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Tool provider ${id} is not installed`)
    return entry.provider
  }
  catalog() {
    return Object.freeze(
      [...this.entries.values()].map(({ provider, sourcePackage }) =>
        Object.freeze({
          id: provider.id,
          version: provider.version,
          sourcePackage,
        }),
      ),
    )
  }
}
export class ToolRuntimeRegistry extends Providers<ToolRuntimeProvider> implements ToolRuntimeRegistryPort {
  constructor(withDefault = true) {
    super()
    if (withDefault) this.register('@agnes/core', defaultToolRuntimeProvider)
  }
}
export class ToolPolicyRegistry extends Providers<ToolPolicy> implements ToolPolicyRegistryPort {
  constructor(withDefault = true) {
    super()
    if (withDefault) this.register('@agnes/base', defaultToolPolicy)
  }
}
