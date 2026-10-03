import { isDeepStrictEqual } from 'node:util'
import type { ShellProvider, ShellServices } from '@agnes/extension-api/client'
import type { Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { type BuildIdentity, type ReuseLifecycle, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const CONTRACT = 'agh.shell'
const HEX = /^[a-f0-9]{64}$/
const DIGEST = 'c'.repeat(64)
const SESSION = 'session-1'
const AT = '2026-10-01T00:00:00.000Z'
const REGIONS = ['conversation', 'composer', 'resources', 'interactions', 'settings'] as const
type Region = (typeof REGIONS)[number]

/**
 * A binding supplies the shell and the containers it mounts into. Each scenario builds its own services
 * double, drives the shell and judges the DOM it leaves, so every implementation is judged the same way.
 *
 * What the cases read from the container, with standard DOM calls only:
 *
 *   regions      one element per public region, on the public region hook `data-agnes-region="<name>"`,
 *                labelled with aria-label
 *   items        each turn, view, interaction and composer submission is an element with
 *                `data-agnes-shell-item="<turn id | viewId | interactionId | requestId>"` and
 *                `data-agnes-shell-state` (pending, unknown, blocked, error, done or another non-success
 *                state), with visible text
 *   composer     a form with a textarea; the textarea holds the draft and submitting the form sends it
 *   navigation   clicking a view item navigates to it; the selected one carries aria-current
 *   focus        the region that holds the document's active element
 */
export interface ShellConformanceBinding {
  readonly providerId: string
  readonly recipe: string
  readonly command: string
  readonly build: BuildIdentity
  /** Hex digests of the shell code, its options and the release set it ships in. */
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  /** Makes a new, unmounted shell. */
  readonly shell: () => ShellProvider
  /**
   * Makes a new empty element attached to a document, for one mount. The binding owns the DOM
   * implementation, so these cases depend on no DOM library.
   */
  readonly container: () => HTMLElement
}

type Turn = Wire.RuntimeConversationWindow['native']['timeline']['turns'][number]
type Submitted = Wire.ShellConversationClientSubmitRequest
type Checks = Record<string, boolean>

const SCOPE = {
  kind: 'session',
  installationId: 'installation-1',
  runtimeId: 'runtime-1',
  workspaceId: 'workspace-1',
  sessionId: SESSION,
} as const

const turn = (id: string, status: Turn['status'], reason?: Turn['reason']): Turn => ({
  id,
  turn: 1,
  startSeq: 1,
  startedAt: AT,
  status,
  ...(reason ? { reason } : {}),
  nodeIds: [],
  usage: {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: true,
    billingComplete: true,
    calls: [],
  },
  inherited: false,
  forkable: false,
})

const conversation = (turns: Turn[]): Wire.RuntimeConversationWindow => ({
  sessionId: SESSION,
  epoch: 'epoch-1',
  revision: turns.length,
  native: {
    timeline: { sessionId: SESSION, upto: 0, generation: 1, opState: null, nodes: [], turns },
    history: { hasEarlier: false, startIndex: 0, totalNodes: 0 },
  },
  domains: [],
  order: [],
  orderCursor: 'order-0',
  nextPageCursor: null,
  complete: true,
})

const view = (viewId: string, phase: Wire.DomainView['phase']): Wire.DomainView => ({
  kind: 'domain',
  viewId,
  revision: 1,
  domainType: 'acme.card',
  viewSchema: { typeId: 'acme.card/view@1', revision: 1, digest: DIGEST },
  renderKey: 'card',
  scope: SCOPE,
  source: { eventIds: [], projectionRevision: 1 },
  phase,
  fallbackText: `Card ${viewId}`,
  data: {},
  resources: [],
  actions: [],
})

/** A forced approval: a shell must never hide it. */
const APPROVAL: Wire.InteractionRecord = {
  interactionId: 'approval-1',
  owner: { runId: 'run-1', actionId: 'action-1' },
  request: {
    kind: 'approval',
    title: 'Approve deleting the draft deck',
    body: 'A destructive action waits for approval.',
    actionRef: 'action-1',
    inputDigest: DIGEST,
    policyDecisionRef: 'policy-1',
    scope: SCOPE,
    allowedResponders: ['user-1'],
    expiresAt: AT,
    idempotencyKey: 'approval-key-1',
    risk: 'destructive',
    intentDigest: DIGEST,
  },
  version: 1,
  createdAt: AT,
  updatedAt: AT,
  status: 'pending',
  terminationReason: null,
  resolution: null,
}

const SNAPSHOT: Wire.ShellSnapshot = {
  sessionId: SESSION,
  catalogRevision: 1,
  conversation: conversation([
    turn('turn-running', 'running'),
    turn('turn-blocked', 'completed', 'blocked'),
    turn('turn-failed', 'failed', 'error'),
    turn('turn-interrupted', 'cancelled', 'interrupted'),
  ]),
  views: [view('view-1', 'finalized'), view('view-2', 'provisional')],
  pending: [APPROVAL],
  connection: 'connected',
  cursor: null,
}

/** The approval was answered and a turn completed. */
const NEXT: Wire.ShellSnapshot = {
  ...SNAPSHOT,
  catalogRevision: 2,
  conversation: conversation([
    ...(SNAPSHOT.conversation?.native.timeline.turns ?? []),
    turn('turn-done', 'completed', 'completed'),
  ]),
  pending: [],
}

const refusal = (code: Wire.RuntimeError['code'], detailCode: string): Wire.RuntimeError => ({
  code,
  detailCode,
  message: 'the services double refused this call',
  retryAdvice: { kind: 'never' },
  diagnosticId: 'shell-conformance',
})

function handle(input: unknown, status: 'accepted' | 'unknown_effect' | 'failed'): Wire.CommandHandle {
  const { requestId } = input as Submitted
  const base = { commandId: `command-${requestId}`, requestId, revision: 1, result: null }
  return status === 'failed'
    ? { ...base, completion: 'runtime-accepted', status, error: refusal('internal', 'command_failed') }
    : { ...base, completion: 'runtime-accepted', status, error: null }
}

type Answer = (input: unknown) => Outcome<unknown>
const ok = (value: unknown): Outcome<unknown> => ({ ok: true, value })

const CLIENTS = [
  'commands',
  'interactions',
  'control',
  'approvals',
  'artifacts',
  'registry',
  'presentation',
  'conversation',
  'domains',
] as const

/**
 * A double for the services a client host hands a shell. Every call is recorded as `client.method` (or
 * `navigate`) with its input and answered asynchronously by the next queued answer for that method;
 * `navigate` is accepted by default and any other unqueued call is refused.
 */
function fakeServices(): {
  services: ShellServices
  calls: { method: string; input: unknown }[]
  answer(method: string, ...answers: Answer[]): void
} {
  const calls: { method: string; input: unknown }[] = []
  const queued = new Map<string, Answer[]>()
  const call = async (method: string, input: unknown) => {
    calls.push({ method, input })
    const next = queued.get(method)?.shift()
    if (next) return next(input)
    return method === 'navigate' ? ok(undefined) : { ok: false, error: refusal('denied', 'not_served') }
  }
  const client = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) =>
          typeof method !== 'string' || method === 'then'
            ? undefined
            : (input: unknown) => call(`${name}.${method}`, input),
      },
    )
  const services = {
    ...Object.fromEntries(CLIENTS.map((name) => [name, client(name)])),
    navigate: (target: unknown) => call('navigate', target),
  } as unknown as ShellServices
  return {
    services,
    calls,
    answer: (method, ...answers) => queued.set(method, [...(queued.get(method) ?? []), ...answers]),
  }
}

const submitted = (calls: readonly { method: string; input: unknown }[]) =>
  calls.filter((call) => call.method === 'conversation.submit').map((call) => call.input as Submitted)

function input(
  container: HTMLElement,
  services: ShellServices,
  snapshot: Wire.ShellSnapshot = SNAPSHOT,
  signal: AbortSignal = new AbortController().signal,
) {
  return { container, snapshot, services, ownerToken: 'owner-1', signal }
}

const code = (outcome: Outcome<unknown>) => (outcome.ok ? 'ok' : outcome.error.code)
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const region = (box: HTMLElement, name: Region) =>
  box.querySelector<HTMLElement>(`[data-agnes-region="${name}"]`)

/** Whether nothing between the element and the document hides it. */
function visible(element: Element | null): boolean {
  for (let node = element; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false
    if ((node as HTMLElement).style?.display === 'none') return false
  }
  return element !== null
}

const item = (box: HTMLElement, id: string) =>
  [...box.querySelectorAll<HTMLElement>('[data-agnes-shell-item]')].find(
    (element) => element.getAttribute('data-agnes-shell-item') === id,
  ) ?? null

/** The state an item shows inside `within`, or null when it is missing, hidden or has no text. */
function state(box: HTMLElement, id: string, within: Region): string | null {
  const found = item(box, id)
  if (!found || !region(box, within)?.contains(found) || !visible(found)) return null
  return found.textContent?.trim() ? found.getAttribute('data-agnes-shell-state') : null
}

function composer(box: HTMLElement) {
  const form = region(box, 'composer')?.querySelector('form')
  const draft = form?.querySelector('textarea')
  if (!form || !draft) throw new Error('the composer region has no form with a textarea')
  return { form, draft }
}

async function send(box: HTMLElement, text: string): Promise<void> {
  const { form, draft } = composer(box)
  draft.value = text
  form.requestSubmit()
  await settle()
}

const current = (element: Element | null) =>
  element !== null && ![null, 'false'].includes(element.getAttribute('aria-current'))

const CASES: Partial<Record<ScenarioName, (binding: ShellConformanceBinding) => Promise<Checks>>> = {
  async normal({ shell, container }) {
    const first = shell()
    const box = container()
    const fake = fakeServices()
    const { descriptor } = first
    const checks: Checks = {
      'descriptor declares every region': REGIONS.every((name) => descriptor.requiredRegions.includes(name)),
      'descriptor names its state schema':
        descriptor.apiMajor === 1 && HEX.test(descriptor.stateSchema.digest),
      'mount accepted': (await first.mount(input(box, fake.services))).ok,
    }
    checks['regions present, visible and labelled'] = REGIONS.every((name) => {
      const found = region(box, name)
      return visible(found) && Boolean(found?.getAttribute('aria-label')?.trim())
    })
    checks['pending, blocked and error shown'] = isDeepStrictEqual(
      [
        state(box, 'approval-1', 'interactions'),
        state(box, 'turn-running', 'conversation'),
        state(box, 'turn-blocked', 'conversation'),
        state(box, 'turn-failed', 'conversation'),
        state(box, 'view-2', 'resources'),
      ],
      ['pending', 'pending', 'blocked', 'error', 'pending'],
    )
    const interrupted = state(box, 'turn-interrupted', 'conversation')
    checks['interruption shown, not as success'] = interrupted !== null && interrupted !== 'done'
    fake.answer(
      'conversation.submit',
      (sent) => ok(handle(sent, 'accepted')),
      (sent) => ok(handle(sent, 'unknown_effect')),
    )
    await send(box, 'first')
    await send(box, 'second')
    const sent = submitted(fake.calls)
    checks['composer submits through the conversation client'] = isDeepStrictEqual(
      sent.map((request) => [request.sessionId, request.content]),
      ['first', 'second'].map((text) => [SESSION, [{ type: 'text', text }]]),
    )
    checks['pending and unknown commands shown'] = isDeepStrictEqual(
      sent.map((request) => state(box, request.requestId, 'composer')),
      ['pending', 'unknown'],
    )
    checks['update accepted'] = (await first.update(NEXT)).ok
    checks['update applied'] =
      item(box, 'approval-1') === null && state(box, 'turn-done', 'conversation') === 'done'
    item(box, 'view-2')?.click()
    await settle()
    checks['navigation goes through the services'] =
      isDeepStrictEqual(
        fake.calls.filter((call) => call.method === 'navigate').map((call) => call.input),
        [{ sessionId: SESSION, viewId: 'view-2' }],
      ) && current(item(box, 'view-2'))
    const { draft } = composer(box)
    draft.value = 'unsent draft'
    draft.focus()
    const exported = await first.exportState()
    const saved = exported.ok ? exported.value : null
    checks['state exported under the declared schema'] =
      saved !== null &&
      isDeepStrictEqual(saved.schema, descriptor.stateSchema) &&
      isDeepStrictEqual(JSON.parse(JSON.stringify(saved.data)), saved.data)
    const second = shell()
    const other = container()
    checks['fresh mount accepted'] = (await second.mount(input(other, fakeServices().services, NEXT))).ok
    checks['state imported'] = saved !== null && (await second.importState(saved)).ok
    checks['draft restored'] = composer(other).draft.value === 'unsent draft'
    checks['navigation restored'] = current(item(other, 'view-2'))
    checks['focus restored'] = Boolean(region(other, 'composer')?.contains(other.ownerDocument.activeElement))
    const again = await second.exportState()
    checks['state survives the round trip'] = again.ok && isDeepStrictEqual(again.value, saved)
    checks['both shells disposed'] =
      (await first.dispose('shutdown')).ok && (await second.dispose('shutdown')).ok
    return checks
  },

  async deny({ shell, container }) {
    const fake = fakeServices()
    const empty = [container(), container(), container()]
    const invalid = [
      { ...input(empty[0] as HTMLElement, fake.services), ownerToken: '' },
      input(empty[1] as HTMLElement, fake.services, { ...SNAPSHOT, connection: 'sideways' } as never),
      input(empty[2] as HTMLElement, fake.services, { ...SNAPSHOT, views: 'none' } as never),
      input({} as HTMLElement, fake.services),
    ]
    const mounts = await Promise.all(invalid.map((mount) => shell().mount(mount)))
    const checks: Checks = {
      'invalid mounts refused': mounts.every((outcome) => code(outcome) === 'invalid_input'),
      'refused mounts render nothing': empty.every((box) => box.childNodes.length === 0),
    }
    const provider = shell()
    const box = container()
    checks['mount accepted'] = (await provider.mount(input(box, fake.services))).ok
    const updates = [null, { ...SNAPSHOT, pending: 'none' }] as unknown as Wire.ShellSnapshot[]
    checks['invalid updates refused'] = (
      await Promise.all(updates.map((snapshot) => provider.update(snapshot)))
    ).every((outcome) => code(outcome) === 'invalid_input')
    checks['previous snapshot kept'] = state(box, 'approval-1', 'interactions') === 'pending'
    const before = await provider.exportState()
    if (!before.ok) return { ...checks, 'state exported': false }
    const { schema, data } = before.value
    const mismatched = [
      { schema: { ...schema, revision: schema.revision + 1 }, data },
      { schema: { ...schema, typeId: 'other.shell/state@1' }, data },
      { schema: { ...schema, digest: schema.digest === DIGEST ? 'd'.repeat(64) : DIGEST }, data },
    ]
    const malformed = [
      null,
      { data },
      { schema: { ...schema, revision: 'one' }, data },
      { schema, data: undefined },
    ] as unknown as Wire.ShellViewState[]
    const imported = async (states: Wire.ShellViewState[]) =>
      Promise.all(states.map(async (state) => code(await provider.importState(state))))
    checks['mismatched state versions refused as incompatible'] = (await imported(mismatched)).every(
      (seen) => seen === 'incompatible',
    )
    checks['malformed states refused as invalid input'] = (await imported(malformed)).every(
      (seen) => seen === 'invalid_input',
    )
    const after = await provider.exportState()
    checks['refused imports change nothing'] = after.ok && isDeepStrictEqual(after.value, before.value)
    fake.answer(
      'conversation.submit',
      () => ({ ok: false, error: refusal('internal', 'submit_failed') }),
      (sent) => ok(handle(sent, 'failed')),
    )
    await send(box, 'first')
    await send(box, 'second')
    const sent = submitted(fake.calls)
    checks['failed service calls shown as errors'] =
      sent.length === 2 && sent.every((request) => state(box, request.requestId, 'composer') === 'error')
    checks['shell disposed'] = (await provider.dispose('shutdown')).ok
    return checks
  },

  async cancel({ shell, container }) {
    const early = new AbortController()
    early.abort()
    const unused = container()
    const checks: Checks = {
      'mount with an aborted signal refused as cancelled':
        code(await shell().mount(input(unused, fakeServices().services, SNAPSHOT, early.signal))) ===
        'cancelled',
      'cancelled mount renders nothing': unused.childNodes.length === 0,
    }
    for (const stop of ['abort', 'stopAdmission'] as const) {
      const provider = shell()
      const box = container()
      const fake = fakeServices()
      const controller = new AbortController()
      checks[`${stop}: mount accepted`] = (
        await provider.mount(input(box, fake.services, SNAPSHOT, controller.signal))
      ).ok
      const saved = await provider.exportState()
      if (stop === 'abort') controller.abort()
      else provider.stopAdmission()
      await send(box, 'late')
      checks[`${stop}: no command admitted`] = submitted(fake.calls).length === 0
      checks[`${stop}: later update refused`] = !(await provider.update(NEXT)).ok
      checks[`${stop}: later import refused`] = saved.ok && !(await provider.importState(saved.value)).ok
      // A shell switch stops admission, exports the state and then disposes the old shell.
      if (stop === 'stopAdmission')
        checks[`${stop}: state still exported`] = (await provider.exportState()).ok
      checks[`${stop}: disposed`] = (await provider.dispose('switch')).ok
    }
    return checks
  },

  async dispose({ shell, container }) {
    const checks: Checks = {}
    for (const reason of ['switch', 'shutdown', 'fault'] as const) {
      const provider = shell()
      const box = container()
      const fake = fakeServices()
      checks[`${reason}: mount accepted`] = (await provider.mount(input(box, fake.services))).ok
      const saved = await provider.exportState()
      const { form, draft } = composer(box)
      const entry = item(box, 'view-1')
      const before = fake.calls.length
      checks[`${reason}: dispose accepted`] = (await provider.dispose(reason)).ok
      checks[`${reason}: dispose is idempotent`] = (
        await Promise.all([provider.dispose(reason), provider.dispose(reason)])
      ).every((outcome) => outcome.ok)
      checks[`${reason}: container released`] = box.childNodes.length === 0 && box.isConnected
      // Events on the released nodes must reach no listener the shell left behind.
      const Event = form.ownerDocument.defaultView?.Event
      draft.value = 'late'
      if (Event) form.dispatchEvent(new Event('submit', { cancelable: true }))
      entry?.click()
      await settle()
      checks[`${reason}: released nodes reach no service`] =
        Event !== undefined && entry !== null && fake.calls.length === before
      const later = [
        await provider.mount(input(box, fake.services)),
        await provider.update(NEXT),
        await provider.exportState(),
        saved.ok ? await provider.importState(saved.value) : saved,
      ]
      checks[`${reason}: later calls refused`] = later.every((outcome) => !outcome.ok)
      checks[`${reason}: refused mount renders nothing`] = box.childNodes.length === 0
    }
    return checks
  },
}

/**
 * Classes these cases cannot prove yet. Each is reported as skipped, which the report counts as
 * missing evidence, never as passed.
 */
const UNPROVEN: Partial<Record<ScenarioName, string>> = {
  select:
    'selecting a shell needs ClientHost.registerShell and a client selection field in the protocol, ' +
    'neither of which exists yet',
  recover:
    'recovering a shell needs a client host lease to rebuild it in a new client process, which does not ' +
    'exist yet',
}

/** The names of the failed checks, or the error a case threw. */
async function failures(scenario: ScenarioName, binding: ShellConformanceBinding): Promise<string[]> {
  const digests = [binding.providerDigest, binding.configDigest, binding.releaseSetDigest]
  if (!digests.every((digest) => HEX.test(digest))) return ['provider, config or release set digest']
  const run = CASES[scenario]
  if (!run) return ['no case']
  try {
    return Object.entries(await run(binding))
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
  } catch (error) {
    // A shell that throws fails its scenario instead of ending the run.
    return [`threw: ${error instanceof Error ? error.message : String(error)}`]
  }
}

const FEATURES = ['mount', 'update', 'exportState', 'importState', 'stopAdmission', 'dispose']

const LIFECYCLE: Record<ScenarioName, ReuseLifecycle> = {
  select: 'call',
  normal: 'call',
  deny: 'call',
  cancel: 'cancel',
  recover: 'recover',
  dispose: 'dispose',
}

/** Register select, normal, deny, cancel, recover and dispose for one shell. */
export function registerShellContract(harness: ConformanceHarness, binding: ShellConformanceBinding): void {
  for (const scenario of SCENARIOS) {
    harness.registerCase({
      contract: CONTRACT,
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run(): Promise<AssertionInput> {
        const unproven = UNPROVEN[scenario]
        const failed = unproven === undefined ? await failures(scenario, binding) : []
        const diagnostic = unproven ?? failed.join('; ')
        return {
          id: `${CONTRACT}/${binding.providerId}/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: binding.recipe,
          features: [...FEATURES],
          build: binding.build,
          consumer: 'shell-conformance-consumer',
          command: binding.command,
          status: unproven !== undefined ? 'skipped' : failed.length === 0 ? 'passed' : 'failed',
          ...(diagnostic ? { diagnostic } : {}),
          configDigest: binding.configDigest,
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: null,
          // Every scenario drives the shell through a services double that stands in for the client host.
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
