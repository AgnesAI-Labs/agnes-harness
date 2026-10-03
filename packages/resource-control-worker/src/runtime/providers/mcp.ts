import type { ActionContext, CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { openMcpJournal } from '../mcp-journal.js'
import { createMcpLeases, type McpLeases, type McpSession } from '../mcp-leases.js'
import { openMcpSession } from '../mcp-transport.js'
import {
  type McpDependencies,
  type McpEndpoint,
  McpFault,
  type McpService,
  mcpData,
  mcpRefusal,
} from '../mcp-types.js'

export const DEFAULT_MCP_PROVIDER_ID = 'agh.default/mcp'
export type { McpDependencies, McpEndpoint, McpService } from '../mcp-types.js'

export function createMcpService(deps: McpDependencies, leases: McpLeases = createMcpLeases()): McpService {
  const journal = openMcpJournal(deps.directory, deps.tenantId, deps.ownerId)
  const binding: W.BindingRef = Object.freeze({
    bindingId: `${DEFAULT_MCP_PROVIDER_ID}/${deps.ownerId}`,
    contract: 'agh.mcp',
    logicalName: 'mcp',
    providerId: DEFAULT_MCP_PROVIDER_ID,
  })
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()
  const cached = new Map<string, Record<string, unknown>>()
  const negotiatedMethods = new WeakMap<McpSession, Readonly<Record<string, W.SchemaRef>>>()
  const retired = new Set<string>()
  let closing: Promise<void> | undefined
  async function guarded<T>(call: CallContext, operation: () => Promise<T>, control = false): Promise<T> {
    const ms = Math.min(Date.parse(call.deadline) - Date.now(), deps.timeoutMs ?? 10000)
    if (lifetime.signal.aborted && !control) throw new McpFault('denied', 'mcp_closed')
    if (call.signal.aborted || !Number.isFinite(ms) || ms <= 0)
      throw new McpFault('cancelled', 'mcp_cancelled')
    const signal = AbortSignal.any([
      call.signal,
      ...(!control ? [lifetime.signal] : []),
      AbortSignal.timeout(ms),
    ])
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new McpFault('cancelled', 'mcp_cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      operation()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort))
    })
  }
  async function permitted(
    resource: W.ResourceRef,
    context: CallContext,
    control = false,
  ): Promise<McpEndpoint> {
    return guarded(
      context,
      async () => {
        const endpoint = deps.endpoints.find(
          (item) => canonicalJsonDigest(item.resource) === canonicalJsonDigest(resource),
        )
        if (!endpoint) throw new McpFault('denied', 'mcp_resource')
        if (endpoint.credential && endpoint.credential.consumer !== 'mcp')
          throw new McpFault('denied', 'mcp_credential')
        const identity = await deps.identity.resolve({ principalRef: context.principalRef }, context)
        if (
          !identity.ok ||
          !validateRuntime('AuthenticatedIdentity', identity.value).ok ||
          identity.value.principalRef !== context.principalRef ||
          identity.value.tenantRef !== deps.tenantId ||
          Date.parse(identity.value.expiresAt) <= Date.now() ||
          canonicalJsonDigest(context.scope) !== canonicalJsonDigest(deps.scope) ||
          !(await deps.authorize(endpoint, context))
        )
          throw new McpFault('denied', 'mcp_denied')
        return endpoint
      },
      control,
    )
  }
  function checkHandle(endpoint: McpEndpoint, handle: W.SecretHandle | null) {
    if (
      endpoint.credential === null
        ? handle !== null
        : !handle ||
          handle.secretId !== endpoint.credential.secretId ||
          handle.audience !== endpoint.credential.audience
    )
      throw new McpFault('denied', 'mcp_credential')
  }
  async function fresh(
    endpoint: McpEndpoint,
    request: W.McpConnectRequest,
    call: CallContext,
  ): Promise<McpSession> {
    checkHandle(endpoint, request.credentialRef)
    if (endpoint.transport !== request.transport) throw new McpFault('invalid_input', 'mcp_transport')
    return openMcpSession(endpoint, request.credentialRef, deps, call)
  }
  async function handshake(session: McpSession, endpoint: McpEndpoint, call: CallContext) {
    const negotiated = await session.request(
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'agnes-runtime', version: '1' },
      },
      call,
    )
    if (
      !negotiated ||
      typeof negotiated !== 'object' ||
      Array.isArray(negotiated) ||
      negotiated.protocolVersion !== '2025-03-26' ||
      !negotiated.capabilities ||
      typeof negotiated.capabilities !== 'object' ||
      Array.isArray(negotiated.capabilities)
    )
      throw new McpFault('incompatible', 'mcp_protocol_version')
    await session.request('notifications/initialized', {}, call)
    const capabilities = negotiated.capabilities as Record<string, W.JsonValue>
    const methods = Object.fromEntries(
      Object.entries(endpoint.methods).filter(
        ([method]) =>
          (method === 'tools/call' && capabilities.tools !== undefined) ||
          (method === 'resources/read' && capabilities.resources !== undefined),
      ),
    )
    negotiatedMethods.set(session, methods)
    return negotiated
  }
  async function sessionFor(request: W.McpConnectRequest, id: string, context: CallContext) {
    const endpoint = await permitted(request.serverRef, context)
    checkHandle(endpoint, request.credentialRef)
    const session = await leases.acquire(id, deps.ownerId, async () => {
      const opened = await fresh(endpoint, request, context)
      try {
        await handshake(opened, endpoint, context)
        return opened
      } catch (error) {
        await opened.close()
        throw error
      }
    })
    return { endpoint, session }
  }
  function savedConnection(ref: W.DomainObjectRef, call: CallContext) {
    if (ref.authorityId !== binding.bindingId || ref.typeId !== 'agh.mcp/connection@1' || ref.revision !== 1)
      throw new McpFault('denied', 'mcp_connection')
    const raw = cached.get(ref.id) ?? (!lifetime.signal.aborted ? journal.connection(ref.id) : null)
    if (!raw || typeof raw !== 'object') throw new McpFault('denied', 'mcp_connection')
    const saved = raw as Record<string, unknown>
    cached.set(ref.id, saved)
    const request = validateRuntime('McpConnectRequest', saved.request)
    if (
      !request.ok ||
      saved.principal !== call.principalRef ||
      saved.scope !== canonicalJsonDigest(call.scope)
    )
      throw new McpFault('denied', 'mcp_connection')
    return request.value
  }
  async function connection(ref: W.DomainObjectRef, call: CallContext) {
    const request = savedConnection(ref, call)
    return { ...(await sessionFor(request, ref.id, call)), request }
  }
  function credentialFailure(
    fault: McpFault,
    endpoint: McpEndpoint,
    handle: W.SecretHandle | null,
    call: CallContext,
  ) {
    if (fault.detailCode !== 'credential_refresh_required' || !handle || !endpoint.credential) return fault
    if (
      !endpoint.staticClientId ||
      !endpoint.credential.accountRef ||
      endpoint.credential.purpose !== 'mcp-oauth'
    )
      return new McpFault('denied', 'mcp_needs_reconnect')
    return new McpFault('denied', 'credential_refresh_required', {
      kind: 'credential-refresh-required',
      failedAttempt: deps.attempt(call),
      request: {
        requestId: `refresh-${call.invocationId}`,
        secretId: handle.secretId,
        expectedVersion: handle.version,
        audience: handle.audience,
        accountRef: endpoint.credential.accountRef,
        serverRef: endpoint.credential.serverRef,
        purpose: 'mcp-oauth',
      },
    })
  }
  async function recorded<T>(
    method: string,
    input: W.JsonValue,
    call: CallContext,
    execute: () => Promise<T>,
  ): Promise<Outcome<T>> {
    const key = `${call.bindingId}/${call.invocationId}`
    const fingerprint = canonicalJsonDigest({
      method,
      input,
      principal: call.principalRef,
      scope: call.scope,
    })
    const prior = journal.request(key)
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        return mcpRefusal(new McpFault('conflict', 'mcp_request_identity'))
      if (prior.output === null) return mcpRefusal(new McpFault('unknown_effect', 'mcp_unknown'))
      return JSON.parse(String(prior.output)) as Outcome<T>
    }
    if (!journal.begin(key, fingerprint)) return mcpRefusal(new McpFault('unknown_effect', 'mcp_unknown'))
    let result: Outcome<T>
    try {
      result = { ok: true, value: await execute() }
    } catch (error) {
      const fault = error instanceof McpFault ? error : new McpFault('unknown_effect', 'mcp_unknown')
      result = mcpRefusal(fault.code === 'cancelled' ? new McpFault('unknown_effect', 'mcp_unknown') : fault)
    }
    journal.finish(key, result)
    return result
  }
  async function prepare(input: unknown, context: ActionContext): Promise<Outcome<W.McpConnectRequest>> {
    const parsed = validateRuntime('McpConnectionPreparation', input)
    if (!parsed.ok) return mcpRefusal(new McpFault('invalid_input', 'mcp_schema'))
    const { request, credentialRefresh: renewal } = parsed.value
    const endpoint = await permitted(request.serverRef, context.call)
    if (endpoint.transport !== request.transport) throw new McpFault('invalid_input', 'mcp_transport')
    if (!endpoint.credential) {
      if (renewal || request.credentialRef) throw new McpFault('denied', 'mcp_credential')
      return { ok: true, value: request }
    }
    const expected = endpoint.credential
    if (renewal) {
      checkHandle(endpoint, request.credentialRef)
      if (!endpoint.staticClientId || !expected.accountRef || expected.purpose !== 'mcp-oauth')
        throw new McpFault('denied', 'mcp_needs_reconnect')
      if (
        renewal.secretId !== expected.secretId ||
        renewal.serverRef !== expected.serverRef ||
        renewal.accountRef !== expected.accountRef ||
        renewal.audience !== expected.audience ||
        renewal.purpose !== 'mcp-oauth' ||
        renewal.expectedVersion !== request.credentialRef?.version
      )
        throw new McpFault('denied', 'mcp_credential')
      const data = mcpData(renewal, RuntimeMethodSchemaRefs['agh.secrets'].refresh.input.typeId)
      data.schema = RuntimeMethodSchemaRefs['agh.secrets'].refresh.input
      const child = await context.effects.invoke(
        { operation: 'agh.secrets.refresh', input: data },
        context.call,
      )
      if (!child.ok) return child
      if (
        child.value.kind !== 'inline' ||
        canonicalJsonDigest(child.value.schema) !==
          canonicalJsonDigest(RuntimeMethodSchemaRefs['agh.secrets'].refresh.output) ||
        child.value.digest !== canonicalJsonDigest(child.value.value) ||
        child.value.bytes !== Buffer.byteLength(JSON.stringify(child.value.value))
      )
        throw new McpFault('incompatible', 'mcp_refresh_schema')
      const response =
        child.value.kind === 'inline' ? validateRuntime('CredentialRefreshResult', child.value.value) : null
      if (
        !response?.ok ||
        response.value.requestId !== renewal.requestId ||
        response.value.state !== 'ready' ||
        !response.value.handle
      )
        throw new McpFault(
          response?.ok && response.value.state === 'unknown' ? 'unknown_effect' : 'denied',
          'mcp_needs_reconnect',
        )
      checkHandle(endpoint, response.value.handle)
      return { ok: true, value: { ...request, credentialRef: response.value.handle } }
    }
    const resolved = await deps.secrets.resolve(
      { secretId: expected.secretId, audience: expected.audience, purpose: expected.purpose },
      context.call,
    )
    if (!resolved.ok) return resolved
    checkHandle(endpoint, resolved.value)
    return { ok: true, value: { ...request, credentialRef: resolved.value } }
  }
  async function connect(input: unknown, call: CallContext): Promise<Outcome<W.McpConnectResult>> {
    const parsed = validateRuntime('McpConnectRequest', input)
    if (!parsed.ok) return mcpRefusal(new McpFault('invalid_input', 'mcp_schema'))
    const request = parsed.value
    const endpoint = await permitted(request.serverRef, call)
    checkHandle(endpoint, request.credentialRef)
    return recorded('connect', request, call, async () => {
      const id = canonicalJsonDigest({
        binding,
        request,
        action: call.invocationId,
        principal: call.principalRef,
        scope: call.scope,
      })
      try {
        const { session } = await sessionFor(request, id, call)
        const methods = negotiatedMethods.get(session) ?? {}
        const tools = methods['tools/call'] ? await session.request('tools/list', {}, call) : { tools: [] }
        if (!tools || typeof tools !== 'object' || Array.isArray(tools) || !Array.isArray(tools.tools))
          throw new McpFault('incompatible', 'mcp_catalog')
        const catalog = tools.tools.map((tool) => {
          if (
            !tool ||
            typeof tool !== 'object' ||
            Array.isArray(tool) ||
            typeof tool.name !== 'string' ||
            !tool.inputSchema ||
            typeof tool.inputSchema !== 'object' ||
            Array.isArray(tool.inputSchema)
          )
            throw new McpFault('incompatible', 'mcp_catalog')
          return tool.name
        })
        if (new Set(catalog).size !== catalog.length) throw new McpFault('incompatible', 'mcp_catalog')
        const capabilities = mcpData(
          { protocolVersion: '2025-03-26', tools, methods: JSON.parse(JSON.stringify(methods)) },
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
        const saved = {
          request,
          principal: call.principalRef,
          scope: canonicalJsonDigest(call.scope),
          methods,
          catalog,
        }
        journal.saveConnection(id, saved)
        cached.set(id, saved)
        return {
          connectionRef: { authorityId: binding.bindingId, typeId: 'agh.mcp/connection@1', id, revision: 1 },
          capabilities,
          schemaRevision: 1,
        }
      } catch (error) {
        await leases.release(id, deps.ownerId)
        throw credentialFailure(
          error instanceof McpFault ? error : new McpFault('unknown_effect', 'mcp_unknown'),
          endpoint,
          request.credentialRef,
          call,
        )
      }
    })
  }
  async function invoke(input: unknown, call: CallContext, read: boolean): Promise<Outcome<W.McpCallResult>> {
    const parsed = validateRuntime(read ? 'McpReadRequest' : 'McpCallRequest', input)
    if (!parsed.ok) return mcpRefusal(new McpFault('invalid_input', 'mcp_schema'))
    const request = parsed.value
    if (retired.has(request.connectionRef.id)) throw new McpFault('denied', 'mcp_connection')
    const fixed = savedConnection(request.connectionRef, call)
    const endpoint = await permitted(fixed.serverRef, call)
    const saved = cached.get(request.connectionRef.id)
    const methods = saved?.methods as Record<string, W.SchemaRef> | undefined
    const schema = methods?.[request.method]
    const configured = endpoint.methods[request.method]
    if (
      !schema ||
      !configured ||
      canonicalJsonDigest(schema) !== canonicalJsonDigest(configured) ||
      canonicalJsonDigest(schema) !== canonicalJsonDigest(request.methodSchema) ||
      canonicalJsonDigest(schema) !== canonicalJsonDigest(request.params.schema) ||
      request.params.kind !== 'inline' ||
      canonicalJsonDigest(request.params.value) !== request.params.digest ||
      Buffer.byteLength(JSON.stringify(request.params.value)) !== request.params.bytes
    )
      throw new McpFault('invalid_input', 'mcp_method_schema')
    if ((read && request.method !== 'resources/read') || (!read && request.method !== 'tools/call'))
      throw new McpFault('incompatible', 'mcp_method')
    if (request.method === 'tools/call' && !(await deps.toolsAdmission(endpoint, request, call)))
      throw new McpFault('denied', 'mcp_tools_admission')
    const params = request.params.value
    if (
      !params ||
      typeof params !== 'object' ||
      Array.isArray(params) ||
      (read
        ? typeof params.uri !== 'string'
        : typeof params.name !== 'string' ||
          !Array.isArray(saved?.catalog) ||
          !saved.catalog.includes(params.name))
    )
      throw new McpFault('invalid_input', read ? 'mcp_resource_uri' : 'mcp_tool')
    return recorded(read ? 'read' : 'call', request, call, async () => {
      try {
        const current = await connection(request.connectionRef, call)
        await permitted(fixed.serverRef, call)
        if (!read && !(await deps.toolsAdmission(endpoint, request, call)))
          throw new McpFault('denied', 'mcp_tools_admission')
        const value = await guarded(call, () => current.session.request(request.method, params, call))
        return {
          contentRefs: [mcpData(value, 'agh.mcp/content@1')],
          provenance: {
            sourceRefs: [current.endpoint.resource.resourceId],
            producer: binding,
            trustLabels: ['untrusted-remote'],
          },
          remoteReceipt: null,
        }
      } catch (error) {
        throw credentialFailure(
          error instanceof McpFault ? error : new McpFault('unknown_effect', 'mcp_unknown'),
          endpoint,
          fixed.credentialRef,
          call,
        )
      }
    })
  }
  function run<T>(operation: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
    const pending = operation().catch((error) =>
      mcpRefusal(error instanceof McpFault ? error : new McpFault('unknown_effect', 'mcp_unknown')),
    )
    active.add(pending)
    void pending.finally(() => active.delete(pending))
    return pending
  }
  return {
    binding,
    providerDigest: canonicalJsonDigest({ contract: 'agh.mcp', recipe: 'sqlite-jsonrpc' }),
    features: [
      'connect',
      'prepareConnection',
      'call',
      'read',
      'stdio',
      'stateless-http',
      'durable-request-identity',
    ],
    prepareConnection: (input, context) => run(() => prepare(input, context)),
    connect: (input, call) => run(() => connect(input, call)),
    call: (input, call) => run(() => invoke(input, call, false)),
    read: (input, call) => run(() => invoke(input, call, true)),
    retain: (ref, ownerId, call) =>
      run(async () => {
        if (retired.has(ref.id)) throw new McpFault('denied', 'mcp_connection')
        await permitted(savedConnection(ref, call).serverRef, call)
        if (!ownerId || !leases.retain(ref.id, ownerId)) throw new McpFault('denied', 'mcp_connection')
        return { ok: true, value: undefined }
      }),
    release: (ref, ownerId, call) =>
      run(async () => {
        // Trusted assembly control, outside Agent dispatch; cleanup survives revoked/cancelled calls.
        savedConnection(ref, call)
        const owners = leases.inspect(ref.id)?.owners
        if (!owners || (owners.length === 1 && owners[0] === ownerId)) retired.add(ref.id)
        await leases.release(ref.id, ownerId)
        if (!leases.inspect(ref.id)) retired.add(ref.id)
        return { ok: true, value: undefined }
      }),
    close() {
      if (!closing) {
        lifetime.abort()
        closing = Promise.allSettled([...active]).then(async () => {
          await leases.releaseOwner(deps.ownerId)
          journal.close()
        })
      }
      return closing
    },
  }
}
