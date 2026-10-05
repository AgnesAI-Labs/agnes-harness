import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pid } from 'node:process'
import { isDeepStrictEqual } from 'node:util'
import type {
  ClientPresentation,
  DomainView,
  IMRenderer,
  RendererContext,
  RendererDefinition,
  RendererDescriptor,
  RendererPresentation,
  ShellProvider,
  UIRegistryFactory,
  UIRegistryHost,
  WebRendererDefinition,
} from '@agnes/extension-api/client'
import type { Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import { type BuildIdentity, type ReuseLifecycle, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const CONTRACT = 'agh.renderer'
const HEX = /^[a-f0-9]{64}$/
const DIGEST = 'c'.repeat(64)
const TARGETS = ['web', 'tui', 'sdk', 'im'] as const
type Target = (typeof TARGETS)[number]
type Element = Extract<RendererPresentation, { target: 'web' }>['element']
type Services = Pick<RendererContext, 'commands' | 'interactions' | 'artifacts' | 'locale'>
type Checks = Record<string, boolean>

/** A React root over a fresh element attached to a document; `render` commits before it returns. */
export interface RendererRoot {
  readonly container: HTMLElement
  render(element: Element): void
  unmount(): void
}

/** What a client host needs to present through one catalog. The cases play the server and the session. */
export interface RendererHostInput {
  readonly target: Target
  readonly modules: readonly Wire.ClientModule[]
  readonly selection: Wire.ClientSelection
  /** The namespace of a catalog module, as the client's verified loader hands it over. */
  readonly load: (module: Wire.ClientModule) => Promise<Outcome<Readonly<Record<string, unknown>>>>
  /** The authorized window: the view it holds under an id, or undefined. */
  readonly views: { current(viewId: string): DomainView | undefined }
  readonly capabilities: Wire.NegotiatedClientCapabilities
  /** The locale text targets are formatted for. */
  readonly locale: string
  /** The session clients a renderer context reaches once it admits a call. */
  readonly services: Services
}

/**
 * A binding supplies the renderers under test and the client host that presents through them. Each
 * scenario builds its own catalog, window and session double, presents through the host and judges what
 * the renderers receive and show, so every implementation is judged the same way.
 */
export interface RendererConformanceBinding {
  readonly providerId: string
  readonly recipe: string
  readonly command: string
  readonly build: BuildIdentity
  /** Hex digests of the renderer code, its options and the release set it ships in. */
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  /**
   * The renderers for one view, at most one per target and together serving web, tui, sdk and im. The
   * cases select each through a catalog that declares its descriptor.
   */
  readonly renderers: readonly RendererDefinition[]
  /** A view every renderer reads: its render key and view schema fit each descriptor. */
  readonly view: DomainView
  /** Makes a new React root. The binding owns React and the DOM, so these cases depend on neither. */
  readonly root: () => RendererRoot
  /**
   * Runs a client host over one catalog: resolves the selection, builds a generation whose namespaces come
   * from `load` and answers its presentation, or the refusal of either step. `release` ends the
   * generation as a newer catalog or a closed client does.
   */
  readonly select: (
    input: RendererHostInput,
  ) => Promise<Outcome<{ readonly presentation: ClientPresentation; release(): Promise<void> }>>
  /**
   * Runs `recoverRenderer` with this binding's renderers, root and select in a client process over
   * `directory` and kills it with SIGKILL once it is ready, then runs it in a second process over the
   * same directory until that one exits. Resolves to each process's exit signal and pid, in that order.
   */
  readonly restart: (directory: string) => Promise<readonly { signal: string | null; pid: number | null }[]>
}

type Subject = Pick<RendererConformanceBinding, 'renderers' | 'view' | 'root' | 'select'>
/** What a client process needs to present: the view comes with the catalogs. */
type Presenting = Omit<Subject, 'view'>
type Namespace = Readonly<Record<string, unknown>>
type Contribution = NonNullable<Wire.ClientModule['contributions']>[number]
type Action = DomainView['actions'][number]

/** Who presented a view: the renderer under test, the case's selected fallback or its decoy. */
type Seen = {
  readonly by: 'provider' | 'fallback' | 'decoy'
  readonly view: DomainView
  readonly context?: RendererContext
  readonly formatted?: Outcome<Wire.FormattedView>
  readonly formatContext?: unknown
}

// The case catalog: FRAME serves the registry double, a shell the host only probes and the selected
// fallback renderer; DECOY declares another renderer for the same view; each of the binding's renderers
// gets a module of its own.
const FRAME = 'conformance.frame'
const DECOY = 'conformance.decoy'
const REGISTRY = 'conformance.registry'
const FALLBACK = 'conformance.fallback'
const SHELL = 'conformance.shell'
const providerModule = (index: number) => `conformance.provider-${index}`
const ownerOf = (moduleId: string) => `owner-${moduleId}`

const CLIENT = 'conformance-client'
const LOCALE = 'en'
const ACT = 'conformance.act'
const REQUIRED = 'conformance.required-feature'
const UNKNOWN = 'conformance.unknown-feature'
// A desktop capability no case negotiates.
const DESKTOP = 'desktop.open-path.v1'
const INPUT = { typeId: 'conformance.act/input@1', revision: 1, digest: DIGEST }
// sha256 of the canonical JSON `{}`.
const EMPTY_DIGEST = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
/** The fixed export a renderer module presents each target through, for the missing-export refusal. */
const PART: Record<Target, string> = { web: 'component', tui: 'format', sdk: 'format', im: 'encode' }

const capabilities = (
  target: Target,
  features: readonly string[] = [],
): Wire.NegotiatedClientCapabilities => ({
  clientInstanceId: CLIENT,
  target,
  protocols: [{ major: 1, minMinor: 0, maxMinor: 0 }],
  viewSchemaRanges: [],
  renderKeys: [],
  features: [...features],
  capabilitiesRevision: 1,
  interaction: { text: true, singleChoice: true, multiChoice: true, confirm: true, complexFormLink: false },
  files: { link: false, upload: false, maxUploadBytes: 0, allowedMimes: [] },
  display: { plainText: true, markdown: false, maxTextBytes: 4096, inlinePreviewMimes: [] },
  negotiatedSession: 'conformance-session',
  effectivePolicyRevision: 1,
})

const action = (actionKey: string, requiredFeatures: string[] = []): Action => ({
  kind: 'command',
  actionKey,
  label: 'Act',
  requiredFeatures,
  availability: 'enabled',
  disabledReason: null,
  command: actionKey,
  inputSchema: INPUT,
})

/** The binding's view with one more command action, so its renderer context offers a call. */
const acting = (view: DomainView): DomainView => ({ ...view, actions: [...view.actions, action(ACT)] })

const submitting = (
  view: DomainView,
  actionKey = ACT,
  requestId = `request-${actionKey}-${view.revision}`,
): Wire.DomainCommandClientSubmitRequest => ({
  action: { viewId: view.viewId, actionKey, viewRevision: view.revision },
  commandSchema: INPUT,
  input: { kind: 'inline', schema: INPUT, value: {}, digest: EMPTY_DIGEST, bytes: 2 },
  requestId,
  expectedRevision: view.source.projectionRevision,
})

/** A double for the session clients: every call is recorded and accepted. */
function fakeServices(): { services: Services; calls: { method: string; input: unknown[] }[] } {
  const calls: { method: string; input: unknown[] }[] = []
  const client = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) =>
          typeof method !== 'string' || method === 'then'
            ? undefined
            : async (...input: unknown[]) => {
                calls.push({ method: `${name}.${method}`, input })
                return { ok: true, value: { served: `${name}.${method}` } }
              },
      },
    )
  const locale = { locale: LOCALE, text: (key: string) => key, formatNumber: () => '', formatDate: () => '' }
  const services = {
    commands: client('commands'),
    interactions: client('interactions'),
    artifacts: client('artifacts'),
    locale,
  } as unknown as Services
  return { services, calls }
}

/** The binding's renderer that serves `target`. */
function serving({ renderers }: Pick<Subject, 'renderers'>, target: Target): number {
  const index = renderers.findIndex((definition) => definition.descriptor.targets.includes(target))
  if (index === -1) throw new Error(`no renderer serves ${target}`)
  return index
}

/** A case renderer's descriptor: the view's render key and exactly its schema revision, on every target. */
const ownDescriptor = (id: string, view: DomainView): RendererDescriptor => ({
  id,
  packageDigest: DIGEST,
  renderKey: view.renderKey,
  targets: [...TARGETS],
  viewSchemaRanges: [
    {
      typeId: view.viewSchema.typeId,
      minRevision: view.viewSchema.revision,
      maxRevision: view.viewSchema.revision,
    },
  ],
  requiredFeatures: [],
  optionalFeatures: [],
  scope: 'view',
  entry: './conformance.js',
})

/** A catalog module, loaded from the entry its renderers declare, as a Host lock requires. */
const catalogModule = (
  moduleId: string,
  packageDigest: string,
  contributions: Contribution[],
): Wire.ClientModule => ({
  moduleId,
  packageId: moduleId,
  packageDigest,
  assetDigest: DIGEST,
  entryPath: contributions.find((entry) => entry.kind === 'renderer')?.descriptor.entry ?? `./${moduleId}.js`,
  ownerToken: ownerOf(moduleId),
  authorApiMajor: 1,
  targets: [...TARGETS],
  schemas: [],
  requiredFeatures: [],
  styles: [],
  contributions,
})
const declaring = (descriptor: RendererDescriptor): Contribution => ({
  contributionId: descriptor.id,
  kind: 'renderer',
  targets: [...descriptor.targets],
  descriptor,
})

interface Catalog {
  readonly modules: Wire.ClientModule[]
  readonly selection: Wire.ClientSelection
  readonly features?: string[]
  /** A fixed export missing from the binding's renderer modules. */
  readonly drop?: string
}

interface Options {
  /** The renderer the selection's row names for the view's render key; null for no row. */
  readonly row?: string | null
  /** A feature every renderer's declared descriptor requires. */
  readonly required?: string
  /** Modules and their declarations in the opposite order. */
  readonly reversed?: boolean
  /** The serving renderer's module carries another package digest than its descriptor names. */
  readonly foreign?: boolean
  readonly features?: string[]
  readonly drop?: string
}

/** The case catalog and a selection for `target`; by default the row names the binding's renderer. */
function catalog(
  binding: Pick<Subject, 'renderers' | 'view'>,
  target: Target,
  options: Options = {},
): Catalog {
  const { renderers, view } = binding
  const index = serving(binding, target)
  const require = (descriptor: RendererDescriptor): RendererDescriptor =>
    options.required
      ? { ...descriptor, requiredFeatures: [...descriptor.requiredFeatures, options.required] }
      : descriptor
  const other = (digest: string) => (digest === DIGEST ? 'd'.repeat(64) : DIGEST)
  let modules = [
    catalogModule(FRAME, DIGEST, [
      { contributionId: REGISTRY, kind: 'registry', export: 'createRegistry', targets: [...TARGETS] },
      { contributionId: SHELL, kind: 'shell', export: 'frameShell', targets: ['web'] },
      declaring(require(ownDescriptor(FALLBACK, view))),
    ]),
    catalogModule(DECOY, DIGEST, [declaring(require(ownDescriptor(DECOY, view)))]),
    ...renderers.map(({ descriptor }, at) =>
      catalogModule(
        providerModule(at),
        options.foreign && at === index ? other(descriptor.packageDigest) : descriptor.packageDigest,
        [declaring(require(descriptor))],
      ),
    ),
  ]
  if (options.reversed)
    modules = modules
      .map((module) => ({ ...module, contributions: [...(module.contributions ?? [])].reverse() }))
      .reverse()
  const row = options.row === undefined ? renderers[index]?.descriptor.id : options.row
  const ref = (contributionId: string) => ({ packageId: FRAME, contributionId })
  const selection = {
    target,
    shell: target === 'web' ? ref(SHELL) : null,
    registry: ref(REGISTRY),
    fallbackRenderer: ref(FALLBACK),
    rendererSelections: row ? [{ target, renderKey: view.renderKey, rendererId: row }] : [],
  } as Wire.ClientSelection
  return {
    modules,
    selection,
    ...(options.features ? { features: options.features } : {}),
    ...(options.drop ? { drop: options.drop } : {}),
  }
}

/** A case renderer that records each presentation as `by` and shows nothing of its own. */
function marked(by: Seen['by'], seen: Seen[]): Namespace {
  return {
    component: ({ view, context }: { view: DomainView; context: RendererContext }) => {
      seen.push({ by, view, context })
      return null
    },
    format: (view: DomainView) => {
      const formatted: Outcome<Wire.FormattedView> = {
        ok: true,
        value: {
          viewId: view.viewId,
          revision: view.revision,
          parts: [],
          complete: true,
          unsupportedRequiredFeatures: [],
        },
      }
      seen.push({ by, view, formatted })
      return formatted
    },
    encode: () => ({ ok: true, value: { messages: [], complete: true, requiresWebForm: false } }),
  }
}

/**
 * The module namespace of a renderer under test: its own `component`, `format` and `encode`, each
 * presentation recorded once it returned. The first time a context reaches the component, a cleanup that
 * counts its runs is registered on it.
 */
function recorded(
  definition: RendererDefinition,
  seen: Seen[],
  cleanups: Map<RendererContext, number>,
  drop: string | undefined,
): Namespace {
  const own = definition as Partial<WebRendererDefinition & IMRenderer>
  const { component, format, encode } = own
  const parts: Record<string, unknown> = {}
  if (typeof component === 'function')
    parts.component = (props: { view: DomainView; context: RendererContext }) => {
      const element = component.call(own, props)
      seen.push({ by: 'provider', view: props.view, context: props.context })
      const { context } = props
      if (!cleanups.has(context)) {
        cleanups.set(context, 0)
        context.onDispose(() => {
          cleanups.set(context, (cleanups.get(context) ?? 0) + 1)
        })
      }
      return element
    }
  if (typeof format === 'function')
    parts.format = (view: DomainView, formatContext: Wire.TextRendererFormatContext) => {
      const formatted = format.call(own, view, formatContext)
      seen.push({ by: 'provider', view, formatted, formatContext })
      return formatted
    }
  if (typeof encode === 'function') parts.encode = encode
  if (drop !== undefined) delete parts[drop]
  return parts
}

interface Run {
  readonly presentation: ClientPresentation
  readonly release: () => Promise<void>
  readonly window: Map<string, DomainView>
  readonly seen: Seen[]
  readonly calls: { method: string; input: unknown[] }[]
  /** The definitions the host registered with the registry double, and the host it built that over. */
  readonly registered: RendererDefinition[]
  readonly host: UIRegistryHost
  readonly roots: RendererRoot[]
  /** How many times the cleanup registered on each context of the renderer under test ran. */
  readonly cleanups: Map<RendererContext, number>
}

/** Runs the binding's host over `chosen` with a registry double that resolves every view to the fallback. */
async function start(binding: Presenting, chosen: Catalog): Promise<Outcome<Run>> {
  const seen: Seen[] = []
  const cleanups = new Map<RendererContext, number>()
  const registered: RendererDefinition[] = []
  let host: UIRegistryHost | undefined
  const createRegistry: UIRegistryFactory = (bound) => {
    host = bound
    return {
      ok: true,
      value: {
        register(definition) {
          registered.push(definition)
          return {
            ok: true,
            value: {
              id: definition.descriptor.id,
              ownerToken: 'conformance-registry',
              dispose: async () => {},
            },
          }
        },
        resolve: () => ({
          ok: true,
          value: { kind: 'fallback', reason: 'the conformance registry matches nothing' },
        }),
      },
    }
  }
  // Probed for its id and never mounted.
  const frameShell = () => ({ descriptor: { id: SHELL } }) as unknown as ShellProvider
  const namespaces: Record<string, Namespace> = {
    [FRAME]: { createRegistry, frameShell, ...marked('fallback', seen) },
    [DECOY]: marked('decoy', seen),
    ...Object.fromEntries(
      binding.renderers.map((definition, at) => [
        providerModule(at),
        recorded(definition, seen, cleanups, chosen.drop),
      ]),
    ),
  }
  const window = new Map<string, DomainView>()
  const fake = fakeServices()
  const target = chosen.selection.target
  const selected = await binding.select({
    target,
    modules: chosen.modules,
    selection: chosen.selection,
    load: async (module) => ({ ok: true, value: namespaces[module.moduleId] ?? {} }),
    views: { current: (viewId) => window.get(viewId) },
    capabilities: capabilities(target, chosen.features),
    locale: LOCALE,
    services: fake.services,
  })
  if (!selected.ok) return selected
  if (host === undefined) throw new Error('the client host built no registry')
  const { presentation, release } = selected.value
  return {
    ok: true,
    value: { presentation, release, window, seen, calls: fake.calls, registered, host, roots: [], cleanups },
  }
}

async function close(run: Run): Promise<void> {
  for (const root of run.roots.splice(0)) root.unmount()
  await run.release()
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
/** Whether `context` is closed and the cleanup the case registered on it ran exactly once. */
const closedOnce = (run: Run, context: RendererContext | undefined) =>
  context?.signal.aborted === true && run.cleanups.get(context) === 1
const code = (outcome: Outcome<unknown>) => (outcome.ok ? 'ok' : outcome.error.code)

interface Shown {
  readonly outcome: Outcome<RendererPresentation>
  readonly seen: Seen[]
  /** The visible text of a Web presentation, or null for text. */
  readonly text: string | null
  readonly root: RendererRoot | undefined
}

/** Presents `view` and renders a Web presentation into `root`, or a new root the run unmounts. */
function show(binding: Presenting, run: Run, view: DomainView, root?: RendererRoot): Shown {
  const from = run.seen.length
  const outcome = run.presentation.domain(view)
  let into = root
  let text: string | null = null
  if (outcome.ok && outcome.value.target === 'web') {
    if (into === undefined) {
      into = binding.root()
      run.roots.push(into)
    }
    into.render(outcome.value.element)
    text = into.container.textContent?.trim() ?? ''
  }
  return { outcome, seen: run.seen.slice(from), text, root: into }
}

/** Who presented: one recorded renderer, `generic` when none did, or the refusal. */
function who({ outcome, seen }: Shown): string {
  if (!outcome.ok) return `refused ${outcome.error.code}`
  const by = new Set(seen.map((entry) => entry.by))
  return by.size === 0 ? 'generic' : by.size === 1 ? [...by].join('') : 'several'
}

/** Presented by the built-in generic view: no recorded renderer, the same view, its fallback text on the Web. */
function generic(shown: Shown, view: DomainView): boolean {
  if (who(shown) !== 'generic' || !shown.outcome.ok) return false
  const { value } = shown.outcome
  if (value.target === 'web') return Boolean(shown.text?.includes(view.fallbackText.trim()))
  return value.formatted.viewId === view.viewId && value.formatted.revision === view.revision
}

/** The text a presentation shows: the Web container's text, or every formatted part, labels included. */
const said = ({ outcome, text }: Shown) =>
  outcome.ok && outcome.value.target !== 'web'
    ? outcome.value.formatted.parts.map((part) => (part.kind === 'text' ? part.text : part.label)).join('\n')
    : (text ?? '')

/** Whether `shown` offers `actionKey`: an action part, or an enabled Web button labelled `label`. */
const offers = ({ outcome, root }: Shown, actionKey: string, label: string) =>
  outcome.ok && outcome.value.target !== 'web'
    ? outcome.value.formatted.parts.some((part) => part.kind === 'action' && part.actionKey === actionKey)
    : [...(root?.container.querySelectorAll('button') ?? [])].some(
        (button) => button.textContent === label && !button.disabled,
      )

/** Presents `view` through a run over `chosen` and judges what it showed; a refused selection fails. */
async function judged(
  binding: Subject,
  chosen: Catalog,
  view: DomainView,
  judge: (shown: Shown) => boolean,
): Promise<boolean> {
  const run = await start(binding, chosen)
  if (!run.ok) return false
  try {
    run.value.window.set(view.viewId, view)
    return judge(show(binding, run.value, view))
  } finally {
    await close(run.value)
  }
}

async function presented(binding: Subject, chosen: Catalog): Promise<string> {
  const run = await start(binding, chosen)
  if (!run.ok) return `refused ${run.error.code}`
  try {
    const view = acting(binding.view)
    run.value.window.set(view.viewId, view)
    return who(show(binding, run.value, view))
  } finally {
    await close(run.value)
  }
}

const utf8 = (text: string) => new TextEncoder().encode(text).length

/** The renderer's own encode, for two limits with and without buttons: valid, within limit and numbered. */
function encodes(definition: RendererDefinition, formatted: Wire.FormattedView): boolean {
  const own = definition as Partial<IMRenderer>
  const { encode } = own
  if (typeof encode !== 'function') return false
  const offered = new Set(formatted.parts.flatMap((part) => (part.kind === 'action' ? [part.actionKey] : [])))
  return [4096, 16].every((maxTextBytes) =>
    [true, false].every((supportsButtons) => {
      const encoded = encode.call(own, formatted, { kind: 'conformance', maxTextBytes, supportsButtons })
      if (!encoded.ok || !validateRuntime('IMRendererEncodeResult', encoded.value).ok) return false
      const { messages, complete } = encoded.value
      return (
        messages.every(
          (message, index) =>
            utf8(message.text) <= maxTextBytes &&
            message.partIndex === index &&
            message.partCount === messages.length &&
            message.actionKeys.every((key) => offered.has(key)),
        ) &&
        // An incomplete view is never sent as complete.
        (formatted.complete || !complete)
      )
    }),
  )
}

/** For every target, opens a run over the default catalog, hands it to `judge` and closes it. */
async function perTarget(
  binding: Subject,
  judge: (target: Target, run: Run, view: DomainView) => Promise<Checks>,
): Promise<Checks> {
  const checks: Checks = {}
  for (const target of TARGETS) {
    const run = await start(binding, catalog(binding, target))
    if (!run.ok) {
      checks[`${target}: selection accepted`] = false
      continue
    }
    try {
      const view = acting(binding.view)
      run.value.window.set(view.viewId, view)
      Object.assign(checks, await judge(target, run.value, view))
    } finally {
      await close(run.value)
    }
  }
  return checks
}

/** Whether a late call through `context` is refused. */
const refuses = async (context: RendererContext | undefined, view: DomainView) =>
  context !== undefined && !(await context.commands.submit(submitting(view))).ok

/** Context calls a mounted Web renderer makes outside its view: each refused, none reaching the session. */
async function outside(binding: Subject, run: Run, view: DomainView): Promise<Checks> {
  const context = show(binding, run, view).seen.at(-1)?.context
  if (context === undefined) return { 'web: the renderer mounted with a context': false }
  const before = run.calls.length
  const refused = await Promise.all([
    context.commands.submit(submitting(view, 'conformance.not-offered')),
    context.commands.submit({
      ...submitting(view),
      action: { viewId: 'conformance.other-view', actionKey: ACT, viewRevision: view.revision },
    }),
    context.commands.commandStatus('conformance.unsent-request'),
    context.interactions.read('conformance.other-interaction'),
    context.artifacts.describe('conformance.other-artifact', 1),
  ])
  return {
    'web: context calls outside the view refused': refused.every((outcome) => code(outcome) === 'denied'),
    'web: refused context calls reach no session client': run.calls.length === before,
  }
}

// The files `recover` and its client processes share: the view and catalogs both processes present
// from, then what each process saw.
const PROFILE = 'profile.json'
const KILLED = 'killed.json'
const REBUILT = 'rebuilt.json'

type Presentation = { by: string; text: string | null; formatted: Wire.FormattedView | null }
type Recorded = { readonly pid: number; readonly shown: Partial<Record<Target, Presentation>> }

/**
 * The client process side of `recover`, in Node; a browser reload is not covered. Each process reads the
 * view and the catalog of every target in `directory`, presents the view through the binding's host and
 * records who presented it and what it showed. The first process keeps its presentations and calls
 * `ready`, which must not return, since the process is killed there. A process that finds that record is
 * the rebuilt one: it records the same and releases what it presented.
 */
export async function recoverRenderer(
  binding: Presenting,
  directory: string,
  ready: () => void,
): Promise<void> {
  const profile = JSON.parse(readFileSync(join(directory, PROFILE), 'utf8')) as {
    view: DomainView
    catalogs: Catalog[]
  }
  const killed = join(directory, KILLED)
  const rebuilt = existsSync(killed)
  const runs: Run[] = []
  const shown: Recorded['shown'] = {}
  for (const chosen of profile.catalogs) {
    const run = await start(binding, chosen)
    if (!run.ok) throw new Error(`the selection was refused: ${run.error.message}`)
    runs.push(run.value)
    run.value.window.set(profile.view.viewId, profile.view)
    const seen = show(binding, run.value, profile.view)
    const value = seen.outcome.ok ? seen.outcome.value : undefined
    shown[chosen.selection.target] = {
      by: who(seen),
      text: seen.text,
      formatted: value !== undefined && value.target !== 'web' ? value.formatted : null,
    }
  }
  const record: Recorded = { pid, shown }
  if (!rebuilt) {
    writeFileSync(killed, JSON.stringify(record))
    ready()
    return
  }
  for (const run of runs) await close(run)
  writeFileSync(join(directory, REBUILT), JSON.stringify(record))
}

const CASES: Record<ScenarioName, (binding: RendererConformanceBinding) => Promise<Checks>> = {
  // On every target the selection's row decides who presents: the renderer under test, another renderer
  // for the same view, or, with no row, the selected fallback, whatever the catalog order. A row naming a
  // renderer the catalog does not declare is refused.
  async select(binding) {
    const checks: Checks = {}
    const choices: [string, Options, string][] = [
      ['the renderer selected', {}, 'provider'],
      ['the renderer selected from the reversed catalog', { reversed: true }, 'provider'],
      ['another renderer selected', { row: DECOY }, 'decoy'],
      ['no renderer selected', { row: null }, 'fallback'],
    ]
    for (const target of TARGETS) {
      for (const [what, options, expected] of choices)
        checks[`${target}: ${what}: only it presents the view`] =
          (await presented(binding, catalog(binding, target, options))) === expected
      checks[`${target}: selecting an undeclared renderer refused`] = !(
        await start(binding, catalog(binding, target, { row: 'conformance.undeclared' }))
      ).ok
    }
    return checks
  },

  // The Web component mounts with a context scoped to its view and this client and follows the view to a
  // newer revision; the text targets present the renderer's own valid format; IM's encode keeps within
  // the channel limit.
  normal: (binding) =>
    perTarget(binding, async (target, run, view) => {
      const index = serving(binding, target)
      const shown = show(binding, run, view)
      const last = shown.seen.at(-1)
      const checks: Checks = {
        [`${target}: presented by the renderer`]:
          shown.outcome.ok && shown.outcome.value.target === target && who(shown) === 'provider',
        [`${target}: the renderer reads a copy of the window's view`]:
          last !== undefined && last.view !== view && isDeepStrictEqual(last.view, view),
      }
      if (target !== 'web') {
        const value = shown.outcome.ok ? shown.outcome.value : undefined
        const formatted = value !== undefined && value.target !== 'web' ? value.formatted : undefined
        const definition = binding.renderers[index]
        checks[`${target}: the renderer's own valid format of this view and revision`] =
          formatted !== undefined &&
          last?.formatted?.ok === true &&
          isDeepStrictEqual(formatted, last.formatted.value) &&
          validateRuntime('FormattedView', formatted).ok &&
          formatted.viewId === view.viewId &&
          formatted.revision === view.revision
        checks[`${target}: formatted for the client's locale and negotiated capabilities`] =
          isDeepStrictEqual(last?.formatContext, { locale: LOCALE, capabilities: capabilities(target) })
        if (target === 'im')
          checks['im: encode keeps within the channel limit'] =
            formatted !== undefined && definition !== undefined && encodes(definition, formatted)
        return checks
      }
      const context = last?.context
      // More than the fallback text alone, which is all a renderer that throws while rendering leaves.
      checks['web: the renderer shows the view'] =
        Boolean(shown.text) && shown.text !== view.fallbackText.trim()
      checks['web: a live context for this client and the module the catalog issued it'] =
        context?.clientInstanceId === CLIENT &&
        context.ownerToken === ownerOf(providerModule(index)) &&
        !context.signal.aborted &&
        isDeepStrictEqual(context.capabilities, capabilities('web'))
      const request = submitting(view)
      checks['web: an action the view offers reaches the session'] =
        (await context?.commands.submit(request))?.ok === true &&
        isDeepStrictEqual(run.calls.at(-1), { method: 'commands.submit', input: [request] })
      // The window moves to a newer revision; presenting it again moves the renderer and its scope.
      const next = { ...view, revision: view.revision + 1 }
      run.window.set(next.viewId, next)
      const again = show(binding, run, next, shown.root)
      const latest = again.seen.at(-1)
      checks['web: a newer revision presented'] =
        who(again) === 'provider' && latest?.view.revision === next.revision
      const stale = await latest?.context?.commands.submit(submitting(view, ACT, 'request-stale'))
      const fresh = await latest?.context?.commands.submit(submitting(next))
      checks['web: the context follows the newer revision'] = stale?.ok === false && fresh?.ok === true
      return checks
    }),

  // A view the renderer's descriptor does not fit, or a renderer requiring a feature the client did not
  // negotiate, presents through the generic view, never the renderer; a desktop capability it lacks is
  // named there. A view the window does not hold at that revision is refused for a reread. A renderer
  // without its export, or with a descriptor of another package, fails the selection. Context calls
  // outside the view are refused.
  deny: (binding) =>
    perTarget(binding, async (target, run, view) => {
      const checks: Checks = target === 'web' ? await outside(binding, run, view) : {}
      const read = (binding.renderers[serving(binding, target)]?.descriptor.viewSchemaRanges ?? [])
        .filter((range) => range.typeId === view.viewSchema.typeId)
        .map((range) => range.maxRevision)
      const unread = Math.max(view.viewSchema.revision, ...read) + 1
      const unfit: [string, DomainView][] = [
        [
          'a view schema revision it does not read',
          { ...view, viewSchema: { ...view.viewSchema, revision: unread } },
        ],
        [
          'another view type',
          { ...view, viewSchema: { ...view.viewSchema, typeId: 'conformance.other/view@1' } },
        ],
        [
          'an action feature it does not declare',
          { ...view, actions: [...view.actions, action('conformance.x', [UNKNOWN])] },
        ],
      ]
      for (const [what, other] of unfit) {
        run.window.set(other.viewId, other)
        checks[`${target}: ${what}: presented by the generic view`] = generic(
          show(binding, run, other),
          other,
        )
      }
      run.window.delete(view.viewId)
      const missing = show(binding, run, view)
      run.window.set(view.viewId, { ...view, revision: view.revision + 1 })
      checks[`${target}: a view the window does not hold at that revision refused for a reread`] = [
        missing,
        show(binding, run, view),
      ].every(
        ({ outcome, seen }) =>
          !outcome.ok && outcome.error.retryAdvice.kind === 'retry_read' && seen.length === 0,
      )
      const required = { required: REQUIRED }
      checks[`${target}: a required feature the client did not negotiate: presented by the generic view`] =
        (await presented(binding, catalog(binding, target, required))) === 'generic'
      checks[`${target}: the same feature negotiated: presented by the renderer`] =
        (await presented(binding, catalog(binding, target, { ...required, features: [REQUIRED] }))) ===
        'provider'
      // A desktop capability the client lacks: the generic view presents instead and names it, and an
      // action needing one is shown there with that reason, never offered.
      checks[`${target}: a required desktop capability the client lacks: the generic view names it`] =
        await judged(
          binding,
          catalog(binding, target, { required: DESKTOP }),
          view,
          (shown) => generic(shown, view) && said(shown).includes(DESKTOP),
        )
      const reveal = { ...action('conformance.reveal', [DESKTOP]), label: 'Reveal' }
      const revealing = { ...view, actions: [...view.actions, reveal] }
      checks[
        `${target}: an action needing a desktop capability the client lacks: shown with it, not offered`
      ] = await judged(
        binding,
        catalog(binding, target, { row: null }),
        revealing,
        (shown) =>
          generic(shown, revealing) &&
          said(shown).includes(DESKTOP) &&
          !offers(shown, reveal.actionKey, reveal.label),
      )
      for (const [what, options] of [
        [`a renderer without its ${PART[target]} export`, { drop: PART[target] }],
        ['a descriptor of another package', { foreign: true }],
      ] as const)
        checks[`${target}: ${what} refused`] = !(await start(binding, catalog(binding, target, options))).ok
      return checks
    }),

  // A lease the registry took is disposed mid-use: its Web context closes, runs its cleanup once and
  // refuses later calls, the lease refuses to present, and a lease taken alongside it keeps presenting.
  // A Web presentation rendered after its lease was disposed leaves no context open.
  cancel: (binding) =>
    perTarget(binding, async (target, run, view) => {
      const id = binding.renderers[serving(binding, target)]?.descriptor.id
      const definition = run.registered.find((entry) => entry.descriptor.id === id)
      if (definition === undefined) return { [`${target}: the renderer registered`]: false }
      const lease = () => {
        const bound = run.host.bindRenderer(definition)
        if (!bound.ok) throw new Error(`the host refused a lease: ${bound.error.message}`)
        return bound.value
      }
      /** Presents through `handle` and renders a Web presentation into a new root; answers what it saw. */
      const through = (handle: ReturnType<typeof lease>) => {
        const from = run.seen.length
        const presentation = handle.present(view)
        if (presentation.ok && presentation.value.target === 'web') {
          const root = binding.root()
          run.roots.push(root)
          root.render(presentation.value.element)
        }
        return { ok: presentation.ok, seen: run.seen.slice(from) }
      }
      const first = lease()
      const alongside = lease()
      const presented = through(first)
      const context = presented.seen.at(-1)?.context
      await first.dispose()
      await settle()
      const after = run.seen.length
      const checks: Checks = {
        [`${target}: the lease presents through the renderer`]:
          presented.ok &&
          presented.seen.length > 0 &&
          presented.seen.every((entry) => entry.by === 'provider'),
        [`${target}: the disposed lease refuses to present`]:
          code(first.present(view)) === 'cancelled' && run.seen.length === after,
        [`${target}: a lease taken alongside still presents`]: alongside.present(view).ok,
      }
      if (target !== 'web') return checks
      checks['web: disposing the lease closes its context and runs its cleanup once'] = closedOnce(
        run,
        context,
      )
      checks['web: the closed context refuses later calls'] = await refuses(context, view)
      // In flight: presented, then its lease disposed before the element commits.
      const late = lease()
      const pending = late.present(view)
      await late.dispose()
      const from = run.seen.length
      if (pending.ok && pending.value.target === 'web') {
        const root = binding.root()
        run.roots.push(root)
        root.render(pending.value.element)
      }
      await settle()
      const opened = run.seen.slice(from).flatMap((entry) => (entry.context ? [entry.context] : []))
      checks['web: a render after its lease was disposed leaves no context open'] =
        pending.ok &&
        opened.every((entry) => closedOnce(run, entry)) &&
        (await Promise.all(opened.map((entry) => refuses(entry, view)))).every(Boolean)
      return checks
    }),

  // A client process presenting through the selection is killed with SIGKILL; a second one rebuilds the
  // host over the same catalogs and must present the view through the same renderer, the same way.
  async recover(binding) {
    const directory = mkdtempSync(join(tmpdir(), 'renderer-recover-'))
    const read = (name: string) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as Recorded
    try {
      const view = acting(binding.view)
      const catalogs = TARGETS.map((target) => catalog(binding, target))
      writeFileSync(join(directory, PROFILE), JSON.stringify({ view, catalogs }))
      const exits = await binding.restart(directory)
      const killed = read(KILLED)
      const rebuilt = read(REBUILT)
      const pids = exits.map((exit) => exit.pid)
      const checks: Checks = {
        'the client killed with SIGKILL, the rebuilt one exited': isDeepStrictEqual(
          exits.map((exit) => exit.signal),
          ['SIGKILL', null],
        ),
        'each record written by its own client process':
          isDeepStrictEqual(pids, [killed.pid, rebuilt.pid]) &&
          killed.pid !== rebuilt.pid &&
          !pids.includes(pid),
      }
      for (const target of TARGETS) {
        const before = killed.shown[target]
        const after = rebuilt.shown[target]
        checks[`${target}: the renderer presents the same way before and after the restart`] =
          before?.by === 'provider' &&
          after?.by === 'provider' &&
          (target === 'web'
            ? Boolean(before.text) && before.text === after.text
            : before.formatted !== null && isDeepStrictEqual(before.formatted, after.formatted))
      }
      return checks
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },

  // Releasing the generation closes every context its renderers mounted, runs their cleanups once and
  // refuses their late calls and later presentations; unmounting a Web renderer closes its context too.
  dispose: (binding) =>
    perTarget(binding, async (target, run, view) => {
      const checks: Checks = {}
      if (target === 'web') {
        // Unmounted first, then released with its generation.
        const shown = show(binding, run, view)
        const context = shown.seen.at(-1)?.context
        shown.root?.unmount()
        await settle()
        checks['web: unmounting the renderer closes its context and runs its cleanup once'] =
          closedOnce(run, context) && (await refuses(context, view))
      }
      const shown = show(binding, run, view)
      const context = shown.seen.at(-1)?.context
      await run.release()
      await run.release()
      const after = run.seen.length
      checks[`${target}: the released generation presents nothing`] =
        who(shown) === 'provider' && code(run.presentation.domain(view)) !== 'ok' && run.seen.length === after
      if (target !== 'web') return checks
      checks['web: releasing the generation closes the context and runs its cleanup once'] = closedOnce(
        run,
        context,
      )
      checks['web: the released context refuses late calls'] = await refuses(context, view)
      shown.root?.unmount()
      await settle()
      checks['web: unmounting afterwards runs no cleanup again'] =
        closedOnce(run, context) && [...run.cleanups.values()].every((count) => count === 1)
      return checks
    }),
}

/** The names of the failed checks, or the error a case threw. */
async function failures(scenario: ScenarioName, binding: RendererConformanceBinding): Promise<string[]> {
  const digests = [binding.providerDigest, binding.configDigest, binding.releaseSetDigest]
  if (!digests.every((digest) => HEX.test(digest))) return ['provider, config or release set digest']
  try {
    return Object.entries(await CASES[scenario](binding))
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
  } catch (error) {
    // A renderer or host that throws fails its scenario instead of ending the run.
    return [`threw: ${error instanceof Error ? error.message : String(error)}`]
  }
}

const FEATURES = ['component', 'format', 'encode', 'present', 'dispose', 'domain']

const LIFECYCLE: Record<ScenarioName, ReuseLifecycle> = {
  select: 'call',
  normal: 'call',
  deny: 'call',
  cancel: 'cancel',
  recover: 'recover',
  dispose: 'dispose',
}

/** Register select, normal, deny, cancel, recover and dispose for one set of renderers. */
export function registerRendererContract(
  harness: ConformanceHarness,
  binding: RendererConformanceBinding,
): void {
  for (const scenario of SCENARIOS) {
    harness.registerCase({
      contract: CONTRACT,
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run(): Promise<AssertionInput> {
        const failed = await failures(scenario, binding)
        const diagnostic = failed.join('; ')
        return {
          id: `${CONTRACT}/${binding.providerId}/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: binding.recipe,
          features: [...FEATURES],
          build: binding.build,
          consumer: 'renderer-conformance-consumer',
          command: binding.command,
          status: failed.length === 0 ? 'passed' : 'failed',
          ...(diagnostic ? { diagnostic } : {}),
          configDigest: binding.configDigest,
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: null,
          // Every scenario presents through the binding's client host over the cases' own catalog, with a
          // registry double and a session double standing in for the server and the session's clients.
          fixture: 'test-client-host',
          sharedEvidenceId: null,
          reuse: {
            scope: 'run',
            methodKind: 'local',
            lifecycle: LIFECYCLE[scenario],
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
  }
}
