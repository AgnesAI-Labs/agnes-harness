// The terminal's way onto the runtime: the session preset, and the SDK runtime client with the ports the
// terminal runtime modules take. The daemon's local socket stays the trusted handshake and names the
// loopback runtime endpoint and its restricted bearer; while it names none the runtime is reported
// unavailable, and runtime operations never fall back to the session path. A preset is never guessed:
// without an explicit one it is the daemon's configured default, and the server validates either.
import { randomUUID } from 'node:crypto'
import { RuntimeClientTransportPolicy, RuntimeClientTransportWire } from '@agnes/protocol/runtime'
import type { JournalStore } from '@agnes/sdk'
import {
  artifactReader,
  RuntimeClientTransport,
  type RuntimeFetch,
  runtimeJournalKey,
} from '@agnes/sdk/runtime'
import { escapeServerText } from '../component.js'
import type { ArtifactPorts } from './artifact-actions.js'
import { createDomainConsumer } from './domain-consumer.js'
import type { QuestionPorts } from './question-controller.js'

export type RuntimeRefusal = Readonly<{
  ok: false
  code: 'preset_unavailable' | 'runtime_unavailable'
  message: string
}>
/** Where the daemon serves the runtime to this terminal, as its local socket reports it. */
export type RuntimeEndpoint = Readonly<{ baseUrl: string; bearer: string }>

const refuse = (code: RuntimeRefusal['code'], message: string): RuntimeRefusal => ({
  ok: false,
  code,
  message: escapeServerText(message),
})

/** The explicit preset unchanged, otherwise the default preset the daemon's profile names. */
export async function resolvePresetId(
  client: { apis(): Promise<{ profile: { presets: { default: string } } }> },
  explicit?: string,
): Promise<{ ok: true; presetId: string } | RuntimeRefusal> {
  if (explicit !== undefined) return { ok: true, presetId: explicit }
  let presetId: unknown
  try {
    presetId = (await client.apis()).profile.presets.default
  } catch (error) {
    return refuse('preset_unavailable', `the daemon's default preset is unreadable (${error}); pass --preset`)
  }
  return typeof presetId === 'string' && presetId !== ''
    ? { ok: true, presetId }
    : refuse('preset_unavailable', 'the daemon names no default preset; pass --preset')
}

/** What this terminal can do: answer simple question fields, open a form link for the rest, show plain text. */
const hello = () => ({
  capabilities: {
    clientInstanceId: randomUUID(),
    target: 'tui' as const,
    protocols: [{ major: RuntimeClientTransportWire.wireMajor, minMinor: 0, maxMinor: 0 }],
    viewSchemaRanges: [],
    renderKeys: [],
    features: [RuntimeClientTransportWire.feature],
    capabilitiesRevision: 1,
    interaction: { text: true, singleChoice: true, multiChoice: true, confirm: true, complexFormLink: true },
    files: { link: true, upload: false, maxUploadBytes: 0, allowedMimes: [] },
    display: {
      plainText: true,
      markdown: false,
      maxTextBytes: RuntimeClientTransportPolicy.maxJsonBytes,
      inlinePreviewMimes: [],
    },
  },
  authorApi: [],
  loadedBundles: [],
})

/**
 * The runtime client over the endpoint the daemon names, with the question, artifact and domain view
 * ports wired to it. Commands an earlier run left unsettled are recovered before anything is returned.
 * Subscriptions over the returned transport poll; no push socket is opened.
 */
export async function connectRuntime(options: {
  /** The endpoint the daemon offers over its local socket, or undefined while it offers none. */
  endpoint: () => Promise<RuntimeEndpoint | undefined>
  journal: JournalStore
  /** The journal partition the trusted assembly derived from this terminal's authentication. Without
   * it, answers that need recovery across runs are refused before they are sent. */
  journalPartitionKey?: string
  locale: string
  fetch?: RuntimeFetch
}) {
  const { journal, locale } = options
  const unavailable = (why: string) => refuse('runtime_unavailable', `the runtime is unavailable: ${why}`)
  const endpoint = await options.endpoint()
  if (!endpoint) return unavailable('the daemon does not offer it to the terminal yet')
  let transport: RuntimeClientTransport
  try {
    transport = new RuntimeClientTransport({
      baseUrl: endpoint.baseUrl,
      credential: endpoint.bearer,
      hello: hello(),
      journal,
      ...(options.journalPartitionKey === undefined
        ? {}
        : { journalPartitionKey: options.journalPartitionKey }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    await transport.connect()
  } catch (error) {
    return unavailable(String(error))
  }
  const capabilities = transport.capabilities
  if (!capabilities || transport.mode === 'disconnected' || transport.mode === 'incompatible')
    return unavailable(`it refused this terminal (${transport.refusal?.message ?? transport.mode})`)
  const recovered = await transport.recover()
  const reader = artifactReader(transport)
  const questions: QuestionPorts = {
    read: (interactionId) => transport.query('interaction.read', interactionId),
    respond: (input) => transport.command('interaction.respond', input),
    respondApproval: (input) => transport.command('approval.respond', input),
    responseStatus: (responseId) => transport.query('interaction.responseStatus', responseId),
    formLink: (input) => transport.command('interaction.formLink', input),
    pendingJournal: async () => {
      const partition = options.journalPartitionKey
      return partition === undefined ? [] : journal.pending(runtimeJournalKey(partition))
    },
  }
  const artifacts: ArtifactPorts = {
    describe: (input) => transport.query('artifact.describe', input),
    openDownload: (input) => transport.command('artifact.openDownload', input),
    openStream: (input) => reader.openStream(input),
  }
  return {
    ok: true as const,
    transport,
    baseUrl: endpoint.baseUrl,
    recovered,
    questions,
    artifacts: { ...artifacts, readRange: reader.readRange },
    // ponytail: formats with the capabilities negotiated at connect; rebuild it on `session-replaced` if a
    // later bootstrap can negotiate differently.
    domain: createDomainConsumer({ locale, capabilities }),
  }
}
