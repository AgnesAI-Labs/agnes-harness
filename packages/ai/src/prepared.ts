import type { PreparedInference, ProviderRequestSnapshot, RequestBody } from '@agnes/protocol'
import { guardSequence } from './guard.js'
import { sha256Hex } from './hash.js'
import type { InferenceDeps } from './provider.js'
import { runInference } from './provider.js'
import { buildRegistry } from './registry.js'
import { resolveSelection } from './route.js'
import { renderPrefixedPrompt } from './stamp.js'

/** Freeze semantic provider inputs, independently of later registry/contract replacement. */
export async function prepareInference(
  deps: InferenceDeps,
  request: RequestBody,
  opts: { signal: AbortSignal },
): Promise<PreparedInference> {
  opts.signal.throwIfAborted()
  const req = structuredClone(request)
  const selected = resolveSelection(deps.registry, req.slot, req.route, req.model)
  const hit = deps.registry.lookup(selected.route)
  if (!hit?.adapter.prepare) throw new Error('Selected adapter does not support durable request preparation')
  const id = req.contractId
  const hash = deps.contract.prefixHash(id)
  if (id !== selected.model.contract_id || (id !== null && hash === null))
    throw new Error('Selected model contract is unavailable or inconsistent')
  const prefix = id === null ? new Uint8Array() : deps.contract.prefixBytes(id).slice()
  if (id !== null && sha256Hex(prefix) !== hash)
    throw new Error('Prepared contract prefix hash is inconsistent')
  const contract = {
    prefixHash: () => hash,
    prefixBytes: () => prefix.slice(),
    tools: () => structuredClone(req.tools),
    syntax: () => ({ toolCallFormats: ['native' as const] }),
  }
  const prepared = await hit.adapter.prepare(req.route, req, opts)
  opts.signal.throwIfAborted()
  const registry = buildRegistry([prepared.adapter])
  registry.seal()
  const snapshot: ProviderRequestSnapshot = {
    codec: 'agnes-provider-request-v1',
    request: {
      ...req,
      system: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        renderPrefixedPrompt(req, contract),
      ),
    },
    adapter: prepared.snapshot,
    endpoint: prepared.endpoint,
    parserVersion: deps.parserVersion,
    contract: { id, prefix: Buffer.from(prefix).toString('base64'), prefixHash: hash },
  }
  const frozenDeps = { ...deps, registry, contract, creditsPerUsd: deps.creditsPerUsd }
  let consumed = false
  return {
    // The execution binding never reads the caller-owned copy of the durable snapshot.
    snapshot: structuredClone(snapshot),
    infer(options) {
      if (consumed) throw new Error('Prepared provider call was already invoked')
      consumed = true
      return guardSequence(runInference(frozenDeps, req, { ...options, retry: false }))
    },
  }
}
