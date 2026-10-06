import { randomUUID } from 'node:crypto'
import type { ModelAdapterDeployment, ModelWireFetch, ModelWireSource } from '@agnes/ai/runtime'
import type { ActionContext, Outcome } from '@agnes/extension-api/runtime'
import { type ActionFrame, canonicalJsonDigest, type RuntimeError } from '@agnes/protocol/runtime'
import {
  createModelEgress,
  ModelEgressError,
  type ModelEgressOptions,
  type ModelEgressPort,
} from './model-egress.js'

type SourceOwner = Omit<ModelAdapterDeployment, 'egress' | 'withCredential'>
type CallEgress = {
  source: ModelWireSource
  marker: string
  port: ModelEgressPort
  current(): boolean
  active: boolean
  closed: boolean
}
const same = (a: unknown, b: unknown) => canonicalJsonDigest(a as never) === canonicalJsonDigest(b as never)
const refusal = (detailCode: string, code: RuntimeError['code'] = 'denied'): Outcome<never> => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Model egress request refused',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'model-egress',
  },
})
function refuse(detailCode: string): never {
  throw new ModelEgressError('denied', detailCode)
}

/** Explicit Host assembly for a selected model chain; never installs an ambient source or key. */
export function createHostModelAdapterDeployment(
  owner: SourceOwner,
  installations: readonly ModelEgressOptions[],
): ModelAdapterDeployment {
  if (
    !owner ||
    ['installed', 'load', 'current', 'beforeSend', 'save', 'lookup'].some(
      (name) => typeof owner[name as keyof SourceOwner] !== 'function',
    )
  )
    throw new TypeError('Missing model source owner')
  const original = { ...owner }
  const selected = [...installations]
  const calls = new WeakMap<ActionFrame, WeakMap<ActionContext, CallEgress>>()
  const ownerCurrent = () =>
    Object.entries(original).every(([key, value]) => owner[key as keyof SourceOwner] === value) &&
    installations.length === selected.length &&
    selected.every((item, index) => installations[index] === item)
  const find = (frame: ActionFrame, context: ActionContext) => calls.get(frame)?.get(context)
  return {
    ...original,
    egress(source, frame, context) {
      const matches = selected.filter(
        (item) => item.installation?.binding.bindingId === source.prepared.target.adapter.bindingId,
      )
      const options = matches[0]
      // Missing C14, C21 or C22 never produces a usable transport.
      if (
        !ownerCurrent() ||
        matches.length !== 1 ||
        !options?.installation ||
        !options.current ||
        !options.network ||
        !options.secrets ||
        !options.endpoints ||
        typeof options.network.identity?.resolve !== 'function' ||
        typeof options.network.authorize !== 'function' ||
        typeof options.network.resolver !== 'function' ||
        typeof options.secrets.use !== 'function'
      )
        return undefined
      const installation = options.installation
      const originalOptions = { ...options }
      const sourceDigest = canonicalJsonDigest(source as never)
      const frameDigest = canonicalJsonDigest(frame as never)
      const call = context.call
      const current = () =>
        ownerCurrent() &&
        Object.entries(originalOptions).every(
          ([key, value]) => options[key as keyof ModelEgressOptions] === value,
        ) &&
        context.call === call &&
        sourceDigest === canonicalJsonDigest(source as never) &&
        frameDigest === canonicalJsonDigest(frame as never) &&
        same(source.prepared.target.adapter, installation.binding) &&
        frame.bindingId === installation.binding.bindingId &&
        source.route.route === installation.route &&
        source.route.api === installation.api &&
        source.prepared.target.endpointRef === installation.endpointRef &&
        source.prepared.target.credentialAudience === installation.consumer.audience &&
        same(source.prepared.credentialRef, installation.handle) &&
        same(source.prepared.target.credentialBinding, installation.consumer) &&
        original.installed(call) === true &&
        original.current(source, frame, call) === true &&
        options.current?.(call, installation) === true &&
        ownerCurrent() &&
        Object.entries(originalOptions).every(
          ([key, value]) => options[key as keyof ModelEgressOptions] === value,
        ) &&
        sourceDigest === canonicalJsonDigest(source as never) &&
        frameDigest === canonicalJsonDigest(frame as never)
      const beforeWrite = (digest: string) => {
        try {
          return !!(
            state.active &&
            !state.closed &&
            state.current() &&
            original.beforeSend(source, frame, context, digest) === true &&
            state.current()
          )
        } catch {
          return false
        }
      }
      const port = createModelEgress({ ...options, current, beforeWrite }, call)
      const state: CallEgress = {
        source,
        marker: `agh-model-${randomUUID()}`,
        port,
        current,
        active: false,
        closed: false,
      }
      let pending = calls.get(frame)
      if (!pending) {
        pending = new WeakMap()
        calls.set(frame, pending)
      }
      pending.set(context, state)
      let lastRefusal: ReturnType<NonNullable<ModelWireFetch['refusal']>>
      const fetch: ModelWireFetch = async (input, init) => {
        try {
          if (!state.active || state.closed || !current()) refuse('model_egress_binding')
          const request = new Request(input, init)
          const header = installation.api === 'anthropic-messages' ? 'x-api-key' : 'authorization'
          const expected = header === 'authorization' ? `Bearer ${state.marker}` : state.marker
          if (request.headers.get(header) !== expected) refuse('model_egress_credential')
          // Pi sees only a call-local marker. C22 inserts the real key inside the final send callback.
          const headers = new Headers(request.headers)
          headers.delete(header)
          return await port.fetch(new Request(request, { headers }))
        } catch (problem) {
          const error =
            problem instanceof ModelEgressError
              ? problem
              : new ModelEgressError(
                  port.fenced() ? 'unknown_effect' : 'retryable',
                  port.fenced() ? 'model_egress_unknown' : 'model_egress_connect',
                )
          lastRefusal = { code: error.code, detailCode: error.detailCode }
          throw error
        }
      }
      fetch.fenced = () => port.fenced()
      fetch.refusal = () => lastRefusal
      return fetch
    },
    async withCredential(source, frame, context, consume) {
      const state = find(frame, context)
      if (!state) return refusal('model_egress_missing')
      try {
        if (!['openai-completions', 'anthropic-messages'].includes(source.route.api))
          return refusal('model_egress_api', 'incompatible')
        if (state.source !== source || state.active || state.closed || !state.current())
          return refusal('model_egress_binding')
        state.active = true
        return { ok: true, value: await consume(state.marker) }
      } catch {
        return refusal('model_egress_unavailable')
      } finally {
        state.active = false
        state.closed = true
        await state.port.close()
      }
    },
    // Legacy adapters may preflight here; the durable owner is called only at beforeWrite.
    beforeSend(source, frame, context, _digest) {
      const state = find(frame, context)
      try {
        return !!(state?.active && !state.closed && state.source === source && state.current())
      } catch {
        return false
      }
    },
  }
}
