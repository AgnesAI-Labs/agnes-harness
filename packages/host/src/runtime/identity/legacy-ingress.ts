import { randomUUID } from 'node:crypto'
import type { TrustedIngressContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  type IdentityAuthenticateRequest,
  type JsonValue,
  type LegacyIdentityTransportEvidence,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  type ScopeRef,
  type ServiceOperation,
  type Timestamp,
  type TransportAuthenticationEvidence,
  type TransportCredentialEnvelope,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { decodeIdentityData, encodeIdentityData } from './data.js'

/** Facts obtained from a real, currently selected Host connection, never from a request label. */
export type IdentityConnectionFacts = Readonly<{
  installationId: string
  runtimeId: string
  tenantRef: string
  bindingId: string
  connectionId: string
  channelBinding: string
  scope: ScopeRef
  transport: 'local' | 'rpc' | 'websocket'
  localGate: LegacyIdentityTransportEvidence['localGate']
}>

export type IdentityIngressAssociation = Readonly<{
  input: IdentityAuthenticateRequest
  scope: ScopeRef
  tenantRef: string
  connectionId: string
  bindingId: string
}>

export interface IdentityIngressAuthority {
  legacy(
    connection: object,
    params: unknown,
    clientId: string | undefined,
    signal: AbortSignal,
    deadline: Timestamp,
    traceRef: string,
  ): { operation: ServiceOperation; context: TrustedIngressContext } | null
  http(
    connection: object,
    input: Readonly<{
      credential: TransportCredentialEnvelope
      evidence: TransportAuthenticationEvidence
      scope: ScopeRef
      tenantRef: string
    }>,
    signal: AbortSignal,
    deadline: Timestamp,
    traceRef: string,
  ): { operation: ServiceOperation; context: TrustedIngressContext } | null
  inspect(operation: ServiceOperation, context: TrustedIngressContext): IdentityIngressAssociation | null
  remote(
    connection: object,
    operation: ServiceOperation,
    context: TrustedIngressContext,
  ): Promise<{ operation: ServiceOperation; context: TrustedIngressContext } | null>
  close(): void
}

function frozenJson<T>(value: T): T {
  const copy = JSON.parse(jcs(value)) as T
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') {
      for (const member of Object.values(item)) freeze(member)
      Object.freeze(item)
    }
  }
  freeze(copy)
  return copy
}

/** Shares the original initialize signature contract: remove only the one auth pocket field. */
function initializeSnapshot(params: unknown): Record<string, JsonValue> | null {
  try {
    const input: unknown = JSON.parse(jcs(params))
    return input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, JsonValue>)
      : null
  } catch {
    return null
  }
}

export function identityInitializeDigest(params: unknown): string | null {
  const input = initializeSnapshot(params)
  if (!input) return null
  const meta = input._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return canonicalJsonDigest(input)
  const pocket = meta['ai.agnes.harness']
  if (!pocket || typeof pocket !== 'object' || Array.isArray(pocket)) return canonicalJsonDigest(input)
  return canonicalJsonDigest({
    ...input,
    _meta: {
      ...meta,
      'ai.agnes.harness': Object.fromEntries(Object.entries(pocket).filter(([key]) => key !== 'auth')),
    },
  })
}

/** Host-only deployment ports attest actual transport objects. Typed evidence does not grant access. */
export function createIdentityIngressAuthority(ports: {
  now(): number
  binding: ServiceOperation['target']
  readLegacyConnection(connection: object): IdentityConnectionFacts | null
  verifyHttpConnection(
    connection: object,
    credential: TransportCredentialEnvelope,
    evidence: TransportAuthenticationEvidence,
    scope: ScopeRef,
    tenantRef: string,
  ): boolean
  remote?: Readonly<{
    connection(
      connection: object,
      context: TrustedIngressContext,
      evidence: LegacyIdentityTransportEvidence,
    ): Readonly<{
      tenantRef: string
      scope: ScopeRef
      allowLocalOwner: boolean
    }> | null
    verify(
      issuerBindingId: string,
      keyId: string,
      document: JsonValue,
      signature: string,
      signal: AbortSignal,
    ): Promise<boolean>
    consume(issuerBindingId: string, ingressId: string, expiresAt: string): boolean
  }>
}): IdentityIngressAuthority {
  const associations = new WeakMap<
    object,
    { value: IdentityIngressAssociation; operation: string; live(): boolean }
  >()
  let closed = false
  const remember = (
    input: IdentityAuthenticateRequest,
    association: Omit<IdentityIngressAssociation, 'input'>,
    fields: Omit<TrustedIngressContext, 'signal' | 'transportEvidence'>,
    signal: AbortSignal,
    live: () => boolean,
  ) => {
    if (closed || signal.aborted || !(Date.parse(fields.deadline) > ports.now()) || !live()) return null
    const request = frozenJson(input)
    const operation = frozenJson({
      target: ports.binding,
      method: 'authenticate',
      input: encodeIdentityData(
        'IdentityAuthenticateRequest',
        RuntimeMethodSchemaRefs['agh.identity'].authenticate.input,
        request,
      ),
    })
    const context: TrustedIngressContext = Object.freeze({
      ...fields,
      transportEvidence: request.transportEvidence,
      signal,
    })
    associations.set(context, {
      value: Object.freeze({ ...association, scope: frozenJson(association.scope), input: request }),
      operation: jcs(operation),
      live,
    })
    return { operation, context }
  }
  return {
    legacy(connection, params, clientId, signal, deadline, traceRef) {
      if (closed) return null
      const actual = ports.readLegacyConnection(connection)
      const facts = actual ? frozenJson(actual) : null
      const digest = identityInitializeDigest(params)
      const input = initializeSnapshot(params)
      if (
        !facts ||
        !digest ||
        !input ||
        facts.bindingId !== ports.binding.bindingId ||
        !validateRuntime('ScopeRef', facts.scope).ok
      )
        return null
      const meta = input._meta
      const pocket =
        meta && typeof meta === 'object' && !Array.isArray(meta) ? meta['ai.agnes.harness'] : undefined
      const rawAuth = pocket && typeof pocket === 'object' && !Array.isArray(pocket) ? pocket.auth : undefined
      const auth = validateRuntime('LegacyIdentityCredentialEnvelope', rawAuth ?? { kind: 'local' })
      if (!auth.ok) return null
      const label = clientId ?? `anon-${randomUUID()}`
      const ingressId = randomUUID()
      const receivedAt = new Date(ports.now()).toISOString()
      const evidence: LegacyIdentityTransportEvidence = {
        bindingId: facts.bindingId,
        ingressId,
        connectionId: facts.connectionId,
        clientId: label,
        initializeDigest: digest,
        receivedAt,
        transport: facts.transport,
        localGate: facts.localGate,
        channelBinding: facts.channelBinding,
        proof: { kind: 'in-process', issuerBindingId: facts.bindingId },
      }
      const live = () => {
        const current = ports.readLegacyConnection(connection)
        return !!current && jcs(current) === jcs(facts)
      }
      return remember(
        {
          credentialEnvelope: encodeIdentityData(
            'LegacyIdentityCredentialEnvelope',
            RuntimeSchemaRefs.LegacyIdentityCredentialEnvelope,
            auth.value,
          ),
          transportEvidence: encodeIdentityData(
            'LegacyIdentityTransportEvidence',
            RuntimeSchemaRefs.LegacyIdentityTransportEvidence,
            evidence,
          ),
        },
        {
          scope: facts.scope,
          tenantRef: facts.tenantRef,
          connectionId: facts.connectionId,
          bindingId: facts.bindingId,
        },
        {
          ingressId,
          installationId: facts.installationId,
          runtimeId: facts.runtimeId,
          tenantRoute: facts.tenantRef,
          transport: facts.transport,
          receivedAt,
          deadline,
          traceRef,
        },
        signal,
        live,
      )
    },
    http(connection, input, signal, deadline, traceRef) {
      const { credential, evidence, scope, tenantRef } = input
      if (
        closed ||
        evidence.bindingId !== ports.binding.bindingId ||
        !('runtimeId' in scope) ||
        !validateRuntime('ScopeRef', scope).ok ||
        !validateRuntime('TransportCredentialEnvelope', credential).ok ||
        !validateRuntime('TransportAuthenticationEvidence', evidence).ok
      )
        return null
      const saved = frozenJson(input)
      return remember(
        {
          credentialEnvelope: encodeIdentityData(
            'TransportCredentialEnvelope',
            RuntimeSchemaRefs.TransportCredentialEnvelope,
            saved.credential,
          ),
          transportEvidence: encodeIdentityData(
            'TransportAuthenticationEvidence',
            RuntimeSchemaRefs.TransportAuthenticationEvidence,
            saved.evidence,
          ),
        },
        { scope: saved.scope, tenantRef, connectionId: evidence.requestNonce, bindingId: evidence.bindingId },
        {
          installationId: scope.installationId,
          runtimeId: scope.runtimeId,
          tenantRoute: tenantRef,
          ingressId: evidence.ingressId,
          transport: evidence.transport,
          receivedAt: evidence.receivedAt,
          deadline,
          traceRef,
        },
        signal,
        () =>
          ports.verifyHttpConnection(
            connection,
            saved.credential,
            saved.evidence,
            saved.scope,
            saved.tenantRef,
          ),
      )
    },
    inspect(operation, context) {
      const saved = associations.get(context)
      if (
        closed ||
        !saved ||
        context.signal.aborted ||
        !(Date.parse(context.deadline) > ports.now()) ||
        !saved.live()
      )
        return null
      try {
        return jcs(operation) === saved.operation &&
          jcs(saved.value.input.transportEvidence) === jcs(context.transportEvidence)
          ? saved.value
          : null
      } catch {
        return null
      }
    },
    async remote(connection, operation, context) {
      if (
        closed ||
        !ports.remote ||
        context.signal.aborted ||
        !(Date.parse(context.deadline) > ports.now()) ||
        operation.method !== 'authenticate' ||
        jcs(operation.target) !== jcs(ports.binding)
      )
        return null
      const request = decodeIdentityData(
        'IdentityAuthenticateRequest',
        RuntimeMethodSchemaRefs['agh.identity'].authenticate.input,
        operation.input,
      )
      if (!request || jcs(request.transportEvidence) !== jcs(context.transportEvidence)) return null
      const credential = decodeIdentityData(
        'LegacyIdentityCredentialEnvelope',
        RuntimeSchemaRefs.LegacyIdentityCredentialEnvelope,
        request.credentialEnvelope,
      )
      const evidence = decodeIdentityData(
        'LegacyIdentityTransportEvidence',
        RuntimeSchemaRefs.LegacyIdentityTransportEvidence,
        request.transportEvidence,
      )
      if (
        !credential ||
        !evidence ||
        evidence.proof.kind !== 'signed' ||
        evidence.bindingId !== ports.binding.bindingId ||
        evidence.ingressId !== context.ingressId ||
        evidence.transport !== context.transport ||
        evidence.receivedAt !== context.receivedAt ||
        !(Date.parse(evidence.proof.expiresAt) > ports.now()) ||
        Date.parse(evidence.proof.expiresAt) > Date.parse(context.deadline)
      )
        return null
      const remote = ports.remote
      const proof = evidence.proof
      const actual = remote.connection(connection, context, evidence)
      const origin = actual ? frozenJson(actual) : null
      if (
        !origin ||
        origin.tenantRef !== context.tenantRoute ||
        !validateRuntime('ScopeRef', origin.scope).ok ||
        (credential.kind === 'local' && !origin.allowLocalOwner)
      )
        return null
      const document = identityLegacySigningDocument(request.credentialEnvelope, evidence, context)
      if (
        !document ||
        !(await remote.verify(proof.issuerBindingId, proof.keyId, document, proof.signature, context.signal))
      )
        return null
      if (
        closed ||
        context.signal.aborted ||
        !(Date.parse(proof.expiresAt) > ports.now()) ||
        !remote.connection(connection, context, evidence) ||
        !remote.consume(proof.issuerBindingId, evidence.ingressId, proof.expiresAt)
      )
        return null
      return remember(
        request,
        {
          scope: origin.scope,
          tenantRef: origin.tenantRef,
          connectionId: evidence.connectionId,
          bindingId: evidence.bindingId,
        },
        {
          ingressId: context.ingressId,
          installationId: context.installationId,
          runtimeId: context.runtimeId,
          tenantRoute: context.tenantRoute,
          transport: context.transport,
          receivedAt: context.receivedAt,
          deadline: context.deadline,
          traceRef: context.traceRef,
        },
        context.signal,
        () => {
          const live = remote.connection(connection, context, evidence)
          return !!live && jcs(live) === jcs(origin) && Date.parse(proof.expiresAt) > ports.now()
        },
      )
    },
    close() {
      closed = true
    },
  }
}

/** Domain-separated remote signing input excludes the proof and final evidence digest. */
export function identityLegacySigningDocument(
  credential: IdentityAuthenticateRequest['credentialEnvelope'],
  evidence: LegacyIdentityTransportEvidence,
  context: TrustedIngressContext,
): JsonValue | null {
  if (evidence.proof.kind !== 'signed') return null
  const { proof, ...facts } = evidence
  return {
    domain: 'agh.identity/legacy-ingress.v1',
    context: {
      installationId: context.installationId,
      runtimeId: context.runtimeId,
      tenantRoute: context.tenantRoute,
      ingressId: context.ingressId,
      transport: context.transport,
      receivedAt: context.receivedAt,
      deadline: context.deadline,
      traceRef: context.traceRef,
    },
    credential: {
      schema: credential.schema,
      digest: credential.kind === 'inline' ? credential.digest : credential.blob.digest,
      bytes: credential.kind === 'inline' ? credential.bytes : credential.blob.bytes,
    },
    evidence: facts,
    issuerBindingId: proof.issuerBindingId,
    keyId: proof.keyId,
    expiresAt: proof.expiresAt,
  }
}
