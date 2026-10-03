import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionContext, CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import {
  type ReferenceMcp,
  type ReferenceMcpEndpoint,
  ReferenceMcpError,
  type ReferenceMcpOptions,
  referenceData,
  refuseMcp,
} from './mcp-support.js'
import { type ReferenceWire, referenceWire } from './mcp-wire.js'

export type { ReferenceMcp, ReferenceMcpOptions } from './mcp-support.js'

type Connection = {
  request: Wire.McpConnectRequest
  principal: string
  scope: string
  methods: Record<string, Wire.SchemaRef>
  catalog: string[]
}
type Stored = { fingerprint: string; outcome: unknown | null }

/** Independent append-only cabinet and serial wire client; no product provider imports. */
export function createReferenceMcp(settings: ReferenceMcpOptions): ReferenceMcp {
  if (!existsSync(settings.directory)) createPrivateDirectorySync(settings.directory)
  const cabinet = join(settings.directory, 'mcp.ndjson')
  if (!existsSync(cabinet)) closeSync(createPrivateFileSync(cabinet))
  const records = new Map<string, Stored>()
  const connections = new Map<string, Connection>()
  let tenant: string | null = null
  let generation: string | null = null
  function apply(event: Record<string, unknown>) {
    if (event.tenant) tenant = String(event.tenant)
    if (event.generation) generation = String(event.generation)
    if (event.requestId)
      records.set(String(event.requestId), {
        fingerprint: String(event.fingerprint),
        outcome: event.outcome ?? null,
      })
    if (event.connectionId) {
      const parsed = validateRuntime('McpConnectRequest', event.request)
      if (
        !parsed.ok ||
        typeof event.principal !== 'string' ||
        typeof event.scope !== 'string' ||
        !event.methods ||
        typeof event.methods !== 'object' ||
        Array.isArray(event.methods) ||
        !Object.values(event.methods).every((value) => validateRuntime('SchemaRef', value).ok) ||
        !Array.isArray(event.catalog) ||
        !event.catalog.every((name) => typeof name === 'string')
      )
        throw new Error('Invalid MCP cabinet')
      connections.set(String(event.connectionId), {
        request: parsed.value,
        principal: event.principal,
        scope: event.scope,
        methods: event.methods as Record<string, Wire.SchemaRef>,
        catalog: event.catalog as string[],
      })
    }
  }
  const text = readFileSync(cabinet, 'utf8')
  if (text && !text.endsWith('\n')) throw new Error('Incomplete MCP cabinet')
  for (const row of text.split('\n').filter(Boolean)) apply(JSON.parse(row))
  if (tenant !== null && (tenant !== settings.tenantId || generation !== settings.ownerId))
    throw new Error('MCP journal ownership mismatch')
  const file = openSync(cabinet, 'a')
  function append(event: Record<string, unknown>) {
    writeSync(file, `${JSON.stringify(event)}\n`)
    fsyncSync(file)
    apply(event)
  }
  if (tenant === null) append({ tenant: settings.tenantId, generation: settings.ownerId })
  const binding: Wire.BindingRef = Object.freeze({
    contract: 'agh.mcp',
    logicalName: 'mcp',
    providerId: 'agh.reference/mcp',
    bindingId: `agh.reference/mcp/${settings.ownerId}`,
  })
  const sessions = new Map<string, { wire: ReferenceWire; owners: Set<string> }>()
  const loading = new Map<string, Promise<ReferenceWire>>()
  const running = new Set<Promise<unknown>>()
  const shutdown = new AbortController()
  const agreement = new WeakMap<ReferenceWire, Record<string, Wire.SchemaRef>>()
  const retired = new Set<string>()
  let done: Promise<void> | undefined
  async function deadline<T>(call: CallContext, work: () => Promise<T>, control = false): Promise<T> {
    if (shutdown.signal.aborted && !control) throw new ReferenceMcpError('denied', 'mcp_closed')
    const remaining = Math.min(Date.parse(call.deadline) - Date.now(), settings.timeoutMs ?? 10000)
    if (call.signal.aborted || !Number.isFinite(remaining) || remaining <= 0)
      throw new ReferenceMcpError('cancelled', 'mcp_cancelled')
    const signal = AbortSignal.any([
      ...(!control ? [shutdown.signal] : []),
      call.signal,
      AbortSignal.timeout(remaining),
    ])
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(new ReferenceMcpError('cancelled', 'mcp_cancelled'))
      signal.addEventListener('abort', cancel, { once: true })
      work()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', cancel))
    })
  }
  async function authorize(ref: Wire.ResourceRef, call: CallContext, control = false) {
    return deadline(
      call,
      async () => {
        const definition = settings.endpoints.find(
          (candidate) => canonicalJsonDigest(candidate.resource) === canonicalJsonDigest(ref),
        )
        if (!definition) throw new ReferenceMcpError('denied', 'mcp_resource')
        if (definition.credential && definition.credential.consumer !== 'mcp')
          throw new ReferenceMcpError('denied', 'mcp_credential')
        const who = await settings.identity.resolve({ principalRef: call.principalRef }, call)
        if (
          !who.ok ||
          !validateRuntime('AuthenticatedIdentity', who.value).ok ||
          who.value.principalRef !== call.principalRef ||
          who.value.tenantRef !== settings.tenantId ||
          Date.parse(who.value.expiresAt) <= Date.now() ||
          canonicalJsonDigest(call.scope) !== canonicalJsonDigest(settings.scope) ||
          !(await settings.authorize(definition, call))
        )
          throw new ReferenceMcpError('denied', 'mcp_denied')
        return definition
      },
      control,
    )
  }
  function credential(definition: ReferenceMcpEndpoint, handle: Wire.SecretHandle | null) {
    const binding = definition.credential
    if (
      (!binding && handle) ||
      (binding && (!handle || handle.secretId !== binding.secretId || handle.audience !== binding.audience))
    )
      throw new ReferenceMcpError('denied', 'mcp_credential')
  }
  async function obtain(id: string, request: Wire.McpConnectRequest, call: CallContext) {
    const definition = await authorize(request.serverRef, call)
    credential(definition, request.credentialRef)
    if (request.transport !== definition.transport)
      throw new ReferenceMcpError('invalid_input', 'mcp_transport')
    let slot = sessions.get(id)
    if (!slot?.wire.usable) {
      let promise = loading.get(id)
      if (!promise) {
        promise = (async () => {
          const wire = await referenceWire(definition, request.credentialRef, settings, call)
          try {
            const hello = await wire.exchange(
              'initialize',
              {
                clientInfo: { name: 'agnes-runtime', version: '1' },
                capabilities: {},
                protocolVersion: '2025-03-26',
              },
              call,
            )
            if (
              !hello ||
              typeof hello !== 'object' ||
              Array.isArray(hello) ||
              hello.protocolVersion !== '2025-03-26' ||
              !hello.capabilities ||
              typeof hello.capabilities !== 'object' ||
              Array.isArray(hello.capabilities)
            )
              throw new ReferenceMcpError('incompatible', 'mcp_protocol_version')
            await wire.exchange('notifications/initialized', {}, call)
            const announced = hello.capabilities as Record<string, Wire.JsonValue>
            const allowed: Record<string, Wire.SchemaRef> = {}
            for (const [name, shape] of Object.entries(definition.methods)) {
              const capability =
                name === 'tools/call' ? 'tools' : name === 'resources/read' ? 'resources' : null
              if (capability && announced[capability] !== undefined) allowed[name] = shape
            }
            agreement.set(wire, allowed)
            return wire
          } catch (fault) {
            await wire.stop()
            throw fault
          }
        })()
        loading.set(id, promise)
      }
      try {
        const wire = await promise
        slot = sessions.get(id)
        if (!slot || slot.wire !== wire) {
          await slot?.wire.stop()
          slot = { wire, owners: slot?.owners ?? new Set() }
          sessions.set(id, slot)
        }
      } finally {
        if (loading.get(id) === promise) loading.delete(id)
      }
    }
    slot.owners.add(settings.ownerId)
    return { slot, definition }
  }
  function fixedConnection(ref: Wire.DomainObjectRef, call: CallContext) {
    if (ref.authorityId !== binding.bindingId || ref.typeId !== 'agh.mcp/connection@1' || ref.revision !== 1)
      throw new ReferenceMcpError('denied', 'mcp_connection')
    const saved = connections.get(ref.id)
    if (!saved || saved.principal !== call.principalRef || saved.scope !== canonicalJsonDigest(call.scope))
      throw new ReferenceMcpError('denied', 'mcp_connection')
    return saved
  }
  function authenticationFault(
    error: unknown,
    definition: ReferenceMcpEndpoint,
    handle: Wire.SecretHandle | null,
    call: CallContext,
  ) {
    if (
      !(error instanceof ReferenceMcpError) ||
      error.detail !== 'credential_refresh_required' ||
      !definition.credential ||
      !handle
    )
      return error
    const account = definition.credential.accountRef
    if (!account || !definition.staticClientId || definition.credential.purpose !== 'mcp-oauth')
      return new ReferenceMcpError('denied', 'mcp_needs_reconnect')
    return new ReferenceMcpError('denied', 'credential_refresh_required', {
      kind: 'credential-refresh-required',
      failedAttempt: settings.attempt(call),
      request: {
        secretId: handle.secretId,
        audience: handle.audience,
        expectedVersion: handle.version,
        requestId: `refresh-${call.invocationId}`,
        accountRef: account,
        serverRef: definition.credential.serverRef,
        purpose: 'mcp-oauth',
      },
    })
  }
  async function once<T>(
    operation: string,
    input: Wire.JsonValue,
    call: CallContext,
    perform: () => Promise<T>,
  ): Promise<Outcome<T>> {
    const id = `${call.bindingId}/${call.invocationId}`
    const fingerprint = canonicalJsonDigest({
      method: operation,
      input,
      principal: call.principalRef,
      scope: call.scope,
    })
    const previous = records.get(id)
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        return refuseMcp(new ReferenceMcpError('conflict', 'mcp_request_identity'))
      return previous.outcome === null
        ? refuseMcp(new ReferenceMcpError('unknown_effect', 'mcp_unknown'))
        : (previous.outcome as Outcome<T>)
    }
    append({ requestId: id, fingerprint, outcome: null })
    let outcome: Outcome<T>
    try {
      outcome = { ok: true, value: await perform() }
    } catch (reason) {
      outcome = refuseMcp(
        reason instanceof ReferenceMcpError && reason.code === 'cancelled'
          ? new ReferenceMcpError('unknown_effect', 'mcp_unknown')
          : reason,
      )
    }
    append({ requestId: id, fingerprint, outcome })
    return outcome
  }
  async function prepare(input: unknown, action: ActionContext): Promise<Outcome<Wire.McpConnectRequest>> {
    const value = validateRuntime('McpConnectionPreparation', input)
    if (!value.ok) return refuseMcp(new ReferenceMcpError('invalid_input', 'mcp_schema'))
    const { request, credentialRefresh: renew } = value.value
    const definition = await authorize(request.serverRef, action.call)
    if (definition.transport !== request.transport)
      throw new ReferenceMcpError('invalid_input', 'mcp_transport')
    const secret = definition.credential
    if (!secret) {
      if (renew || request.credentialRef) throw new ReferenceMcpError('denied', 'mcp_credential')
      return { ok: true, value: request }
    }
    if (!renew) {
      const selected = await settings.secrets.resolve(
        { secretId: secret.secretId, purpose: secret.purpose, audience: secret.audience },
        action.call,
      )
      if (!selected.ok) return selected
      credential(definition, selected.value)
      return { ok: true, value: { ...request, credentialRef: selected.value } }
    }
    credential(definition, request.credentialRef)
    if (!definition.staticClientId || !secret.accountRef || secret.purpose !== 'mcp-oauth')
      throw new ReferenceMcpError('denied', 'mcp_needs_reconnect')
    if (
      renew.accountRef !== secret.accountRef ||
      renew.serverRef !== secret.serverRef ||
      renew.audience !== secret.audience ||
      renew.secretId !== secret.secretId ||
      renew.purpose !== 'mcp-oauth' ||
      renew.expectedVersion !== request.credentialRef?.version
    )
      throw new ReferenceMcpError('denied', 'mcp_credential')
    const envelope = referenceData(renew, RuntimeMethodSchemaRefs['agh.secrets'].refresh.input.typeId)
    envelope.schema = RuntimeMethodSchemaRefs['agh.secrets'].refresh.input
    const child = await action.effects.invoke(
      { operation: 'agh.secrets.refresh', input: envelope },
      action.call,
    )
    if (!child.ok) return child
    if (
      child.value.kind !== 'inline' ||
      canonicalJsonDigest(child.value.schema) !==
        canonicalJsonDigest(RuntimeMethodSchemaRefs['agh.secrets'].refresh.output) ||
      child.value.digest !== canonicalJsonDigest(child.value.value) ||
      child.value.bytes !== Buffer.byteLength(JSON.stringify(child.value.value))
    )
      throw new ReferenceMcpError('incompatible', 'mcp_refresh_schema')
    const renewed =
      child.value.kind === 'inline' ? validateRuntime('CredentialRefreshResult', child.value.value) : null
    if (
      !renewed?.ok ||
      renewed.value.requestId !== renew.requestId ||
      renewed.value.state !== 'ready' ||
      !renewed.value.handle
    )
      throw new ReferenceMcpError(
        renewed?.ok && renewed.value.state === 'unknown' ? 'unknown_effect' : 'denied',
        'mcp_needs_reconnect',
      )
    credential(definition, renewed.value.handle)
    return { ok: true, value: { ...request, credentialRef: renewed.value.handle } }
  }
  async function connect(input: unknown, call: CallContext) {
    const decoded = validateRuntime('McpConnectRequest', input)
    if (!decoded.ok) return refuseMcp(new ReferenceMcpError('invalid_input', 'mcp_schema'))
    const request = decoded.value
    const definition = await authorize(request.serverRef, call)
    credential(definition, request.credentialRef)
    return once('connect', request, call, async () => {
      const id = canonicalJsonDigest({
        binding,
        request,
        action: call.invocationId,
        principal: call.principalRef,
        scope: call.scope,
      })
      try {
        const { slot } = await obtain(id, request, call)
        const methods = agreement.get(slot.wire) ?? {}
        const tools = methods['tools/call'] ? await slot.wire.exchange('tools/list', {}, call) : { tools: [] }
        const listing = tools && typeof tools === 'object' && !Array.isArray(tools) ? tools.tools : null
        if (!Array.isArray(listing)) throw new ReferenceMcpError('incompatible', 'mcp_catalog')
        const catalog: string[] = []
        for (const item of listing) {
          if (
            !item ||
            typeof item !== 'object' ||
            Array.isArray(item) ||
            typeof item.name !== 'string' ||
            !item.inputSchema ||
            typeof item.inputSchema !== 'object' ||
            Array.isArray(item.inputSchema) ||
            catalog.includes(item.name)
          )
            throw new ReferenceMcpError('incompatible', 'mcp_catalog')
          catalog.push(item.name)
        }
        append({
          connectionId: id,
          request,
          principal: call.principalRef,
          scope: canonicalJsonDigest(call.scope),
          methods,
          catalog,
        })
        const capabilities = referenceData(
          { tools, protocolVersion: '2025-03-26', methods: JSON.parse(JSON.stringify(methods)) },
          'agh.mcp/capabilities-2025-03-26@1',
        )
        capabilities.schema.digest = canonicalJsonDigest({
          type: 'object',
          required: ['protocolVersion', 'tools', 'methods'],
          properties: {
            protocolVersion: { const: '2025-03-26' },
            tools: { type: 'object' },
            methods: { type: 'object' },
          },
          additionalProperties: false,
        })
        return {
          connectionRef: { authorityId: binding.bindingId, id, revision: 1, typeId: 'agh.mcp/connection@1' },
          schemaRevision: 1,
          capabilities,
        }
      } catch (fault) {
        await sessions.get(id)?.wire.stop()
        sessions.delete(id)
        throw authenticationFault(fault, definition, request.credentialRef, call)
      }
    })
  }
  async function invoke(input: unknown, call: CallContext, reading: boolean) {
    const decoded = validateRuntime(reading ? 'McpReadRequest' : 'McpCallRequest', input)
    if (!decoded.ok) return refuseMcp(new ReferenceMcpError('invalid_input', 'mcp_schema'))
    const command = decoded.value
    if (retired.has(command.connectionRef.id)) throw new ReferenceMcpError('denied', 'mcp_connection')
    const saved = fixedConnection(command.connectionRef, call)
    const definition = await authorize(saved.request.serverRef, call)
    const shape = saved.methods[command.method]
    const configured = definition.methods[command.method]
    if (
      !shape ||
      !configured ||
      canonicalJsonDigest(shape) !== canonicalJsonDigest(configured) ||
      canonicalJsonDigest(shape) !== canonicalJsonDigest(command.methodSchema) ||
      canonicalJsonDigest(shape) !== canonicalJsonDigest(command.params.schema) ||
      command.params.kind !== 'inline' ||
      command.params.digest !== canonicalJsonDigest(command.params.value) ||
      command.params.bytes !== Buffer.byteLength(JSON.stringify(command.params.value))
    )
      throw new ReferenceMcpError('invalid_input', 'mcp_method_schema')
    if (command.method !== (reading ? 'resources/read' : 'tools/call'))
      throw new ReferenceMcpError('incompatible', 'mcp_method')
    if (!reading && !(await settings.toolsAdmission(definition, command, call)))
      throw new ReferenceMcpError('denied', 'mcp_tools_admission')
    const argument = command.params.value
    if (
      !argument ||
      typeof argument !== 'object' ||
      Array.isArray(argument) ||
      (reading
        ? typeof argument.uri !== 'string'
        : typeof argument.name !== 'string' || !saved.catalog.includes(argument.name))
    )
      throw new ReferenceMcpError('invalid_input', reading ? 'mcp_resource_uri' : 'mcp_tool')
    return once(reading ? 'read' : 'call', command, call, async () => {
      try {
        const { slot } = await obtain(command.connectionRef.id, saved.request, call)
        await authorize(saved.request.serverRef, call)
        if (!reading && !(await settings.toolsAdmission(definition, command, call)))
          throw new ReferenceMcpError('denied', 'mcp_tools_admission')
        const content = await deadline(call, () => slot.wire.exchange(command.method, argument, call))
        return {
          contentRefs: [referenceData(content)],
          remoteReceipt: null,
          provenance: {
            producer: binding,
            trustLabels: ['untrusted-remote'],
            sourceRefs: [definition.resource.resourceId],
          },
        }
      } catch (reason) {
        throw authenticationFault(reason, definition, saved.request.credentialRef, call)
      }
    })
  }
  function launch<T>(work: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
    const task = work().catch(refuseMcp)
    running.add(task)
    void task.finally(() => running.delete(task))
    return task
  }
  return {
    binding,
    providerDigest: canonicalJsonDigest({ contract: 'agh.mcp', recipe: 'append-cabinet-serial-wire' }),
    features: [
      'connect',
      'prepareConnection',
      'call',
      'read',
      'stdio',
      'stateless-http',
      'durable-request-identity',
    ],
    connect: (input, call) => launch(() => connect(input, call)),
    prepareConnection: (input, action) => launch(() => prepare(input, action)),
    call: (input, call) => launch(() => invoke(input, call, false)),
    read: (input, call) => launch(() => invoke(input, call, true)),
    retain: (ref, owner, call) =>
      launch(async () => {
        if (retired.has(ref.id)) throw new ReferenceMcpError('denied', 'mcp_connection')
        const saved = connections.get(ref.id),
          slot = sessions.get(ref.id)
        if (
          !saved ||
          !slot ||
          ref.authorityId !== binding.bindingId ||
          ref.typeId !== 'agh.mcp/connection@1' ||
          ref.revision !== 1 ||
          saved.principal !== call.principalRef ||
          saved.scope !== canonicalJsonDigest(call.scope)
        )
          throw new ReferenceMcpError('denied', 'mcp_connection')
        await authorize(saved.request.serverRef, call)
        if (!owner) throw new ReferenceMcpError('denied', 'mcp_connection')
        slot.owners.add(owner)
        return { ok: true, value: undefined }
      }),
    release: (ref, owner, call) =>
      launch(async () => {
        const saved = connections.get(ref.id),
          slot = sessions.get(ref.id)
        if (
          !saved ||
          ref.authorityId !== binding.bindingId ||
          ref.typeId !== 'agh.mcp/connection@1' ||
          ref.revision !== 1 ||
          saved.principal !== call.principalRef ||
          saved.scope !== canonicalJsonDigest(call.scope)
        )
          throw new ReferenceMcpError('denied', 'mcp_connection')
        // Private assembly lifecycle port; an ended business authorization must not prevent cleanup.
        if (!slot || (slot.owners.size === 1 && slot.owners.has(owner))) retired.add(ref.id)
        slot?.owners.delete(owner)
        if (slot && !slot.owners.size) {
          sessions.delete(ref.id)
          await slot.wire.stop()
        }
        if (!sessions.has(ref.id)) retired.add(ref.id)
        return { ok: true, value: undefined }
      }),
    close() {
      if (!done) {
        shutdown.abort()
        done = Promise.allSettled([...running]).then(async () => {
          for (const [id, slot] of sessions) {
            slot.owners.delete(settings.ownerId)
            if (!slot.owners.size) {
              sessions.delete(id)
              await slot.wire.stop()
            }
          }
          closeSync(file)
        })
      }
      return done
    },
  }
}
