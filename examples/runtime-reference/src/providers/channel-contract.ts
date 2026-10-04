import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  CallContext,
  Outcome,
  ServiceProvider,
  TrustedIngressContext,
} from '@agnes/extension-api/runtime'
import {
  type BuildIdentity,
  type ConformanceHarness,
  createRestrictedEffectsFixture,
  providerFileForContract,
} from '@agnes/extension-api/testkit'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import {
  type ChannelConformanceBinding,
  type ChannelRemoteAnswer,
  type ChannelWorld,
  registerChannelContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/channel.js'
import {
  CHANNEL_PROVIDER,
  channelData,
  createReferenceChannel,
  REMOTE,
  REMOTE_DATA,
  type RemoteAnswer,
  type RemotePost,
  signWebhook,
  WEBHOOK_BODY,
  WEBHOOK_SIGNATURE,
} from './channel.js'
import { killWhenReady } from './interaction-contract.js'
import { createReferenceSecrets } from './secrets.js'

const sha256 = (url: URL) => createHash('sha256').update(readFileSync(url)).digest('hex')

const build: BuildIdentity = {
  codeSha: 'reference-code',
  buildDigest: 'reference-build',
  lockDigest: 'reference-lock',
  specVersion: 'reference-spec',
  sdkVersion: 'reference-sdk',
  sdkDigest: 'reference-sdk-digest',
  platform: 'reference-platform',
}

const SCOPE = {
  kind: 'workspace',
  installationId: 'installation-1',
  runtimeId: 'runtime-1',
  workspaceId: 'workspace-1',
} as const satisfies Wire.ScopeRef
const ALLOWED: Wire.ChannelDestination = {
  channelId: 'reference-webhook',
  accountId: 'team-1',
  conversationId: 'room-1',
  threadId: null,
}
const USERS = { known: 'remote-alice', principalRef: 'alice', unknown: 'remote-mallory' }
/** The principal the provider reads its webhook secret as. */
const SERVICE = 'reference.channel/service'
const TENANT = 'reference-tenant'
const CREDENTIAL: Wire.SecretConsumerBinding = {
  consumer: 'surface',
  secretId: 'channel-webhook',
  accountRef: ALLOWED.accountId,
  serverRef: ALLOWED.channelId,
  audience: 'reference.channel',
  purpose: 'webhook-signature',
}
const WINDOW_MS = 300_000
const provider = fileURLToPath(new URL('./channel.ts', import.meta.url))

/** The in-memory remote: it keeps one message per remote key and answers as `answer` last said. */
function createRemote(key: string) {
  let mode: ChannelRemoteAnswer = 'deliver'
  let posts = 0
  let release = () => {}
  let holding = Promise.resolve()
  const messages = new Map<string, { remoteMessageId: string; post: RemotePost }>()
  const answerOf = ({ remoteMessageId }: { remoteMessageId: string }): RemoteAnswer => ({
    kind: 'delivered',
    remoteMessageId,
    receipt: { remoteMessageId },
  })
  /** Takes one post; answers null while holding it. */
  function receive(post: RemotePost): RemoteAnswer | null {
    posts += 1
    if (mode === 'refuse') return { kind: 'refused', reason: 'conversation closed' }
    const entry = messages.get(post.remoteKey) ?? { remoteMessageId: `remote-${messages.size + 1}`, post }
    messages.set(post.remoteKey, entry)
    if (mode !== 'hold') return answerOf(entry)
    release()
    return null
  }
  const effects = createRestrictedEffectsFixture()
  const reply = (value: RemoteAnswer | null): Outcome<Wire.DataRef> => ({
    ok: true,
    value: channelData(REMOTE_DATA, value),
  })
  effects.allow({
    port: 'invoke',
    operation: REMOTE.post,
    async handle(request) {
      const answer = receive((request.input.kind === 'inline' ? request.input.value : null) as RemotePost)
      return answer === null ? new Promise<never>(() => undefined) : reply(answer)
    },
  })
  effects.allow({
    port: 'invoke',
    operation: REMOTE.lookup,
    async handle(request) {
      const asked = request.input.kind === 'inline' ? (request.input.value as { remoteKey?: unknown }) : {}
      const entry = typeof asked.remoteKey === 'string' ? messages.get(asked.remoteKey) : undefined
      return reply(entry ? answerOf(entry) : null)
    },
  })
  return {
    effects: effects.ports,
    receive,
    posts: () => posts,
    held: () => holding,
    answer(next: ChannelRemoteAnswer) {
      mode = next
      if (next === 'hold') holding = new Promise((resolve) => (release = resolve))
    },
    deliver(event: Parameters<ChannelWorld['deliver']>[0]): Wire.ChannelCallbackRequest {
      const held = [...messages.values()].find((entry) => entry.remoteMessageId === event.remoteMessageId)
      const destination = held?.post.destination
      const body = JSON.stringify({
        eventId: event.eventId,
        remoteMessageId: event.remoteMessageId,
        conversationId: event.forwarded ? 'room-forwarded' : (destination?.conversationId ?? 'room-unknown'),
        threadId: destination?.threadId ?? null,
        user: { id: event.user, bot: event.bot ?? false },
        reply: event.reply,
      })
      const signer = event.forged === 'signature' ? randomBytes(32).toString('hex') : key
      return {
        envelope: channelData(WEBHOOK_BODY, event.forged === 'body' ? `${body} ` : body),
        signatureEvidence: channelData(WEBHOOK_SIGNATURE, {
          timestamp: event.sentAt,
          signature: signWebhook(signer, event.sentAt, body),
        }),
      }
    },
  }
}

/** One store, its remote and the doubles standing in for the Host webhook route and the client ingress. */
function referenceWorld(directory: string, binding: Wire.BindingRef): ChannelWorld {
  const key = randomBytes(32).toString('hex')
  const remote = createRemote(key)
  const secrets = createReferenceSecrets({
    directory: join(directory, 'secrets'),
    tenantId: TENANT,
    entries: [
      { secretId: CREDENTIAL.secretId, versions: [{ version: '1', ref: 'secret://channel/webhook-1' }] },
    ],
    grants: [{ principalRef: SERVICE, scope: SCOPE, binding: CREDENTIAL }],
    source: { resolve: () => key },
    identity: {
      async resolve({ principalRef }) {
        if (principalRef !== SERVICE) {
          const refusal: Wire.RuntimeError = {
            code: 'denied',
            detailCode: 'permission_denied',
            message: 'Unknown principal',
            retryAdvice: { kind: 'never' },
            diagnosticId: 'reference-channel-identity',
          }
          return { ok: false, error: refusal }
        }
        return {
          ok: true,
          value: {
            principalRef,
            tenantRef: TENANT,
            claims: channelData(
              { typeId: 'reference.channel/claims@1', revision: 1, digest: 'c'.repeat(64) },
              {},
            ),
            authRevision: 1,
            expiresAt: '2099-01-01T00:00:00Z',
            authKind: 'local',
            credentialKind: 'local',
            ownerClass: 'local-owner',
          },
        }
      },
    },
    maintenance: () => false,
  })
  const issued = new WeakSet<TrustedIngressContext>()
  const forwarded: Wire.AuthenticatedCallback[] = []
  const opened: ServiceProvider[] = []
  const path = join(directory, 'channel.sqlite')
  let ingresses = 0
  let crashes = 0
  const credentialCall = (context: TrustedIngressContext): CallContext => ({
    principalRef: SERVICE,
    scope: SCOPE,
    bindingId: binding.bindingId,
    invocationId: context.ingressId,
    deadline: context.deadline,
    traceRef: context.traceRef,
    authorizationRef: 'reference.channel/webhook',
    signal: context.signal,
  })
  return {
    async open() {
      const channel = createReferenceChannel({
        path,
        binding,
        scope: SCOPE,
        authorize: (destination) => jcs(destination) === jcs(ALLOWED),
        callbacks: {
          trusted: (context) => issued.has(context),
          secrets,
          credential: CREDENTIAL,
          credentialCall,
          actors: { [USERS.known]: USERS.principalRef },
          windowMs: WINDOW_MS,
          async forward(callback) {
            forwarded.push(callback)
            return {
              ok: true,
              value: {
                authorityId: 'reference.client-ingress',
                receiptId: `command-${forwarded.length}`,
                digest: canonicalJsonDigest(callback),
              },
            }
          },
        },
      })
      opened.push(channel)
      return channel
    },
    effects: remote.effects,
    answer: remote.answer,
    held: remote.held,
    posts: remote.posts,
    deliver: remote.deliver,
    ingress(receivedAt) {
      ingresses += 1
      const context: TrustedIngressContext = Object.freeze({
        ingressId: `ingress-${ingresses}`,
        installationId: SCOPE.installationId,
        runtimeId: SCOPE.runtimeId,
        tenantRoute: TENANT,
        transport: 'http',
        transportEvidence: channelData(
          { typeId: 'reference.channel/webhook-route@1', revision: 1, digest: 'd'.repeat(64) },
          { route: 'reference channel webhook' },
        ),
        receivedAt,
        // Real time: the secrets broker refuses a call past its deadline.
        deadline: new Date(Date.now() + 60_000).toISOString(),
        traceRef: `ingress-${ingresses}`,
        signal: new AbortController().signal,
      })
      issued.add(context)
      return context
    },
    forwarded: () => [...forwarded],
    async crash(frame) {
      crashes += 1
      const config = join(directory, `crash-${crashes}.json`)
      writeFileSync(config, JSON.stringify({ path, binding, scope: SCOPE, allowed: ALLOWED, frame }))
      const killed = await killWhenReady(
        ['hold', config],
        (stdout) => {
          const line = /^POST (.+)\n/m.exec(stdout)?.[1]
          // The remote takes the post; the process dies before it reads the answer.
          if (line !== undefined) remote.receive(JSON.parse(line) as RemotePost)
          return line !== undefined
        },
        provider,
      )
      return { signal: killed.signal, pid: killed.pid }
    },
    async close() {
      await Promise.all(opened.map((channel) => channel.close('shutdown')))
      await secrets.close()
    },
  }
}

/**
 * Registers the six channel cases for the reference provider, reported under `providerId` (the runner
 * passes the name it was asked for, such as `reference`). Each case opens its own world under one temporary
 * directory; call `close` after the harness has run to remove it.
 */
export function bindChannelContract(
  harness: ConformanceHarness,
  command: string,
  options: Readonly<{ providerId?: string }> = {},
): { close(): void } {
  const providerId = options.providerId ?? CHANNEL_PROVIDER.id
  const directory = mkdtempSync(join(tmpdir(), 'reference-channel-contract-'))
  const binding: Wire.BindingRef = {
    bindingId: 'reference-channel',
    contract: CHANNEL_PROVIDER.contract,
    logicalName: 'channel',
    providerId,
  }
  const contract: ChannelConformanceBinding = {
    providerId,
    recipe: providerFileForContract(CHANNEL_PROVIDER.contract),
    command,
    build,
    providerDigest: sha256(new URL('./channel.ts', import.meta.url)),
    configDigest: canonicalJsonDigest({ windowMs: WINDOW_MS, credential: CREDENTIAL }),
    releaseSetDigest: sha256(new URL('../../package.json', import.meta.url)),
    binding,
    scope: SCOPE,
    destinations: { allowed: ALLOWED, refused: { ...ALLOWED, conversationId: 'room-2' } },
    users: USERS,
    world: async () => referenceWorld(mkdtempSync(join(directory, 'world-')), binding),
  }
  registerChannelContract(harness, contract)
  return {
    close() {
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
