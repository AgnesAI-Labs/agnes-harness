// A simplified artifact workbench shell on plain DOM APIs. It reads session data only from the
// snapshots and the ShellServices it is mounted with, and lays out the five public regions:
//
//   conversation  the turns of the authorized conversation window, then its domain cards in the
//                 window's order as their fallback text; only cards scoped to this session show
//   composer      the draft, sent as a prompt or a follow-up, a stop for the session's active run, and
//                 what became of each through the conversation client
//   resources     the domain views; choosing one navigates through the services
//   interactions  pending interactions, so a forced approval is never hidden
//   settings      the session and its connection
//
// Each region carries the public region hook `data-agnes-region`. Every turn, view, interaction and
// submission is an item with `data-agnes-shell-item` and a `data-agnes-shell-state` of pending, unknown,
// blocked, error, interrupted or done, also spelled out in its text; a domain card spells out its phase
// in the contract's words instead. Only the draft, the chosen view and
// the focused region are kept, as ShellViewState; a request still waiting for its outcome is held only
// here, so the shell refuses to export its state until the outcome arrives rather than lose it.
//
// The browser entry reaches no package, so the shapes used here are mirrored; the Node binding in
// providers/shell.ts assigns the factory to the generated ShellProvider type.

type Region = 'conversation' | 'composer' | 'resources' | 'interactions' | 'settings'
type State = 'pending' | 'unknown' | 'blocked' | 'error' | 'interrupted' | 'done'

const REGIONS: Region[] = ['conversation', 'composer', 'resources', 'interactions', 'settings']

// Revision 1 of the view state data, ViewState below. The digest is the SHA-256 of
// {"draft":"string","focus":"region|null","viewId":"string|null"}; a new data shape takes a new
// revision and digest, and a state written under another one is refused.
const STATE_SCHEMA = {
  typeId: 'reference.workbench/shell-state@1',
  revision: 1,
  digest: '57827b8e4888925501650370b98cc8ee4838ad2085ba9c641e25fc0ac945fec1',
}

// The state each wire status, reason, phase or connection shows as. A turn's reason is more precise
// than its status. Anything not listed shows as unknown, never as done.
const STATE_WORDS: Record<State, string[]> = {
  pending: ['pending', 'running', 'waiting', 'parked', 'accepted', 'provisional', 'reconnecting'],
  unknown: ['unknown_effect', 'offline'],
  blocked: ['blocked', 'budget', 'max_steps', 'expired'],
  error: ['failed', 'error'],
  interrupted: ['interrupted', 'cancelled', 'aborted'],
  done: ['completed', 'succeeded', 'finalized', 'answered', 'connected'],
}
const STATES = new Map(
  Object.entries(STATE_WORDS).flatMap(([state, words]) => words.map((word) => [word, state as State])),
)
const stateOf = (...words: (string | undefined)[]): State =>
  words.map((word) => STATES.get(word ?? '')).find((state) => state !== undefined) ?? 'unknown'
const CONNECTIONS = ['connected', 'reconnecting', 'offline']
// A domain card's phase as its state and in the contract's words.
const PHASES: Record<string, [State, string]> = {
  provisional: ['pending', 'running'],
  interrupted: ['interrupted', 'incomplete'],
  finalized: ['done', 'complete'],
}

interface DomainEntry {
  id: string
  turnId: string | null
  view: { phase: string; fallbackText: string; scope: { kind: string; sessionId?: string } }
}

interface Snapshot {
  sessionId: string | null
  catalogRevision: number
  conversation: {
    native: { timeline: { generation: number; turns: { id: string; status: string; reason?: string }[] } }
    domains: DomainEntry[]
    order: { kind: 'native' | 'domain'; id: string }[]
  } | null
  views: { viewId: string; phase: string; fallbackText: string }[]
  pending: { interactionId: string; status: string; request: { title: string } }[]
  connection: string
  cursor: string | null
}

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string } }

interface Services {
  conversation: {
    submit(input: {
      sessionId: string
      kind: 'prompt' | 'follow-up'
      content: { type: 'text'; text: string }[]
      requestId: string
      expectedGeneration: number
    }): Promise<Result<{ status: string }>>
    cancel(input: {
      sessionId: string
      runId: string
      requestId: string
    }): Promise<Result<{ status: string }>>
  }
  control: { read(sessionId: string): Promise<Result<{ activeRunId: string | null }>> }
  navigate(target: { sessionId: string; viewId?: string }): Promise<Result<void>>
}

interface Refusal {
  code: 'invalid_input' | 'incompatible' | 'cancelled' | 'conflict'
  detailCode: string
  message: string
  retryAdvice: { kind: 'never' }
  diagnosticId: string
}
type Outcome<T> = { ok: true; value: T } | { ok: false; error: Refusal }
type Refused = { ok: false; error: Refusal }
type ViewState = { draft: string; viewId: string | null; focus: Region | null }
// The text spells out `word` when there is one, else the state.
type Item = [id: string, label: string, state: State, word?: string]

export interface WorkbenchShell {
  readonly descriptor: {
    id: string
    apiMajor: 1
    stateSchema: typeof STATE_SCHEMA
    requiredRegions: Region[]
  }
  mount(input: {
    container: HTMLElement
    snapshot: Snapshot
    services: Services
    ownerToken: string
    signal: AbortSignal
  }): Promise<Outcome<void>>
  update(snapshot: Snapshot): Promise<Outcome<void>>
  exportState(): Promise<Outcome<{ schema: typeof STATE_SCHEMA; data: ViewState }>>
  importState(state: { schema: typeof STATE_SCHEMA; data: unknown }): Promise<Outcome<void>>
  stopAdmission(): void
  dispose(): Promise<Outcome<void>>
}

const OK: Outcome<void> = { ok: true, value: undefined }

const refuse = (code: Refusal['code'], detailCode: string, message: string): Refused => ({
  ok: false,
  error: {
    code,
    detailCode,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'reference-workbench-shell',
  },
})

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isTextOrNull = (value: unknown) => value === null || isText(value)
const listOf = (value: unknown, valid: (item: Record<string, unknown>) => boolean) =>
  Array.isArray(value) && value.every((item) => isObject(item) && valid(item))

/** The snapshot when it has every field this shell reads, or null. */
function readSnapshot(value: unknown): Snapshot | null {
  if (!isObject(value)) return null
  const { conversation } = value
  const window = isObject(conversation) ? conversation : null
  const timeline = isObject(window?.native) ? window.native.timeline : null
  // Every domain the order names must be in the window; the merged window is otherwise taken as it is.
  const domainIds = new Set(
    Array.isArray(window?.domains) ? window.domains.map((entry) => isObject(entry) && entry.id) : [],
  )
  const valid =
    isTextOrNull(value.sessionId) &&
    typeof value.catalogRevision === 'number' &&
    (conversation === null ||
      (isObject(timeline) &&
        typeof timeline.generation === 'number' &&
        listOf(timeline.turns, (turn) => isText(turn.id) && isText(turn.status)) &&
        listOf(
          window?.domains,
          (entry) =>
            isText(entry.id) &&
            isTextOrNull(entry.turnId) &&
            isObject(entry.view) &&
            Object.hasOwn(PHASES, entry.view.phase as string) &&
            isText(entry.view.fallbackText) &&
            isObject(entry.view.scope),
        ) &&
        listOf(
          window?.order,
          (entry) =>
            isText(entry.id) &&
            (entry.kind === 'native' || (entry.kind === 'domain' && domainIds.has(entry.id))),
        ))) &&
    listOf(value.views, (view) => isText(view.viewId) && isText(view.phase) && isText(view.fallbackText)) &&
    listOf(
      value.pending,
      (record) =>
        isText(record.interactionId) &&
        isText(record.status) &&
        isObject(record.request) &&
        isText(record.request.title),
    ) &&
    CONNECTIONS.includes(value.connection as string) &&
    isTextOrNull(value.cursor)
  return valid ? (value as unknown as Snapshot) : null
}

/**
 * The conversation's domain cards in the window's order, each scoped to this session. A provisional card
 * of a turn that failed or was cancelled shows that turn as interrupted, never as still running.
 */
function cards(snapshot: Snapshot, turns: Item[]): Item[] {
  const window = snapshot.conversation
  const domains = new Map(window?.domains.map((entry) => [entry.id, entry]))
  const turnStates = new Map(turns.map(([id, , state]) => [id, state]))
  return (window?.order ?? []).flatMap((at): Item[] => {
    const card = at.kind === 'domain' ? domains.get(at.id) : undefined
    const scope = card?.view.scope
    if (!card || scope?.kind !== 'session' || scope.sessionId !== snapshot.sessionId) return []
    const turn = card.turnId === null ? undefined : turnStates.get(card.turnId)
    const [state, word] =
      card.view.phase === 'provisional' && (turn === 'error' || turn === 'interrupted')
        ? (['interrupted', 'turn interrupted, refresh pending'] as const)
        : (PHASES[card.view.phase] as [State, string])
    return [[card.id, card.view.fallbackText, state, word]]
  })
}

interface Mounted {
  readonly services: Services
  readonly ownerToken: string
  readonly root: HTMLElement
  readonly regions: Record<Region, HTMLElement>
  readonly draft: HTMLTextAreaElement
  readonly submissions: { requestId: string; text: string; state: State; settled: boolean }[]
  snapshot: Snapshot
}

export function createWorkbenchShell(): WorkbenchShell {
  let mounted: Mounted | null = null
  let admitting = false
  let disposed = false
  let chosen: string | null = null
  let sent = 0
  // Every listener the shell adds goes through this signal, so dispose removes them all at once.
  const listeners = new AbortController()

  const live = (): Mounted | Refused => {
    if (disposed) return refuse('conflict', 'shell_disposed', 'the shell was disposed')
    return mounted ?? refuse('conflict', 'shell_not_mounted', 'the shell is not mounted')
  }
  const admitted = (): Mounted | Refused => {
    const view = live()
    if ('ok' in view || admitting) return view
    return refuse('conflict', 'admission_stopped', 'the shell admits no more changes')
  }

  /** A list of items, each marked with its id and state and spelling the state out in its text. */
  function list(view: Mounted, items: Item[], tag: 'span' | 'button' = 'span'): HTMLElement {
    const doc = view.root.ownerDocument
    const ul = doc.createElement('ul')
    for (const [id, label, state, word] of items) {
      const element = doc.createElement(tag)
      element.dataset.agnesShellItem = id
      element.dataset.agnesShellState = state
      element.textContent = `${label}: ${word ?? state}`
      if (tag === 'button') element.setAttribute('type', 'button')
      if (tag === 'button' && id === chosen) element.setAttribute('aria-current', 'true')
      ul.appendChild(doc.createElement('li')).append(element)
    }
    return ul
  }

  function render(view: Mounted): void {
    const { snapshot, regions } = view
    const turns = (snapshot.conversation?.native.timeline.turns ?? []).map(
      (turn): Item => [turn.id, `Turn ${turn.id}`, stateOf(turn.reason, turn.status)],
    )
    regions.conversation.replaceChildren(list(view, [...turns, ...cards(snapshot, turns)]))
    regions.resources.replaceChildren(
      list(
        view,
        snapshot.views.map((domain): Item => [domain.viewId, domain.fallbackText, stateOf(domain.phase)]),
        'button',
      ),
    )
    regions.interactions.replaceChildren(
      list(
        view,
        snapshot.pending.map(
          (record): Item => [record.interactionId, record.request.title, stateOf(record.status)],
        ),
      ),
    )
    const session: Item = [
      'connection',
      `Session ${snapshot.sessionId ?? 'none'}, connection`,
      stateOf(snapshot.connection),
    ]
    regions.settings.replaceChildren(list(view, [session]))
    renderSubmissions(view)
  }

  function renderSubmissions(view: Mounted): void {
    const items = view.submissions.map(
      (submission): Item => [submission.requestId, submission.text, submission.state],
    )
    view.regions.composer.querySelector('ul')?.replaceWith(list(view, items))
  }

  /** Shows `text` as a pending request until `call` answers, then in the state of its outcome. */
  async function track(
    view: Mounted,
    text: string,
    call: (requestId: string) => Promise<Result<{ status: string }>>,
  ): Promise<boolean> {
    sent += 1
    const request = {
      requestId: `${view.ownerToken}:${sent}`,
      text,
      state: 'pending' as State,
      settled: false,
    }
    view.submissions.push(request)
    renderSubmissions(view)
    let accepted = false
    try {
      const outcome = await call(request.requestId)
      accepted = outcome.ok
      request.state = outcome.ok
        ? stateOf(outcome.value.status)
        : outcome.error.code === 'denied'
          ? 'blocked'
          : 'error'
    } catch {
      // A services call that throws is shown as failed, never as done.
      request.state = 'error'
    }
    request.settled = true
    if (mounted === view) renderSubmissions(view)
    return accepted
  }

  async function submit(kind: 'prompt' | 'follow-up'): Promise<void> {
    const view = mounted
    const text = view?.draft.value.trim()
    const sessionId = view?.snapshot.sessionId
    if (!view || !admitting || !text || !sessionId) return
    const expectedGeneration = view.snapshot.conversation?.native.timeline.generation ?? 0
    const accepted = await track(view, text, (requestId) =>
      view.services.conversation.submit({
        sessionId,
        kind,
        content: [{ type: 'text', text }],
        requestId,
        expectedGeneration,
      }),
    )
    if (accepted && view.draft.value.trim() === text) view.draft.value = ''
  }

  /** Cancels the run the session's control state names as active, by its id; with none, sends nothing. */
  async function stop(): Promise<void> {
    const view = mounted
    const sessionId = view?.snapshot.sessionId
    if (!view || !admitting || !sessionId) return
    let runId: string | null = null
    try {
      const control = await view.services.control.read(sessionId)
      if (control.ok) runId = control.value.activeRunId
    } catch {
      // Without the control state there is no run to name, so nothing is cancelled.
    }
    const run = runId
    if (run === null || mounted !== view || !admitting) return
    await track(view, 'Stop', (requestId) =>
      view.services.conversation.cancel({ sessionId, runId: run, requestId }),
    )
  }

  async function navigate(viewId: string): Promise<void> {
    const view = mounted
    const sessionId = view?.snapshot.sessionId
    if (!view || !admitting || !sessionId) return
    const outcome = await view.services.navigate({ sessionId, viewId }).catch(() => null)
    if (!outcome?.ok || mounted !== view) return
    chosen = viewId
    render(view)
  }

  function build(
    container: HTMLElement,
    services: Services,
    ownerToken: string,
    snapshot: Snapshot,
  ): Mounted {
    const doc = container.ownerDocument
    const root = doc.createElement('div')
    const regions = {} as Record<Region, HTMLElement>
    for (const name of REGIONS) {
      const section = doc.createElement('section')
      section.dataset.agnesRegion = name
      section.setAttribute('aria-label', `${name.charAt(0).toUpperCase()}${name.slice(1)}`)
      section.tabIndex = -1
      regions[name] = section
      root.append(section)
    }
    const form = doc.createElement('form')
    const draft = doc.createElement('textarea')
    draft.setAttribute('aria-label', 'Draft')
    const button = (type: 'submit' | 'button', label: string) =>
      Object.assign(doc.createElement('button'), { type, textContent: label })
    const followUp = button('button', 'Follow up')
    const stopRun = button('button', 'Stop')
    form.append(draft, button('submit', 'Send'), followUp, stopRun)
    regions.composer.append(form, doc.createElement('ul'))
    const view: Mounted = { services, ownerToken, root, regions, draft, submissions: [], snapshot }
    const signal = listeners.signal
    form.addEventListener(
      'submit',
      (event) => {
        event.preventDefault()
        void submit('prompt')
      },
      { signal },
    )
    followUp.addEventListener('click', () => void submit('follow-up'), { signal })
    stopRun.addEventListener('click', () => void stop(), { signal })
    regions.resources.addEventListener(
      'click',
      (event) => {
        const id = (event.target as Element | null)
          ?.closest('[data-agnes-shell-item]')
          ?.getAttribute('data-agnes-shell-item')
        if (id) void navigate(id)
      },
      { signal },
    )
    render(view)
    container.append(root)
    return view
  }

  return {
    descriptor: {
      id: 'reference.workbench-shell',
      apiMajor: 1,
      stateSchema: STATE_SCHEMA,
      requiredRegions: [...REGIONS],
    },

    async mount({ container, snapshot, services, ownerToken, signal }) {
      if (disposed) return refuse('conflict', 'shell_disposed', 'the shell was disposed')
      if (mounted) return refuse('conflict', 'shell_mounted', 'the shell is already mounted')
      const read = readSnapshot(snapshot)
      const valid =
        container?.nodeType === 1 &&
        isText(ownerToken) &&
        ownerToken !== '' &&
        typeof services?.conversation?.submit === 'function' &&
        typeof services.navigate === 'function' &&
        typeof signal?.addEventListener === 'function'
      if (!valid || !read) return refuse('invalid_input', 'mount_invalid', 'the mount input is incomplete')
      if (signal.aborted) return refuse('cancelled', 'mount_cancelled', 'the mount was cancelled')
      mounted = build(container, services, ownerToken, read)
      admitting = true
      signal.addEventListener(
        'abort',
        () => {
          admitting = false
        },
        { signal: listeners.signal },
      )
      return OK
    },

    async update(snapshot) {
      const view = admitted()
      if ('ok' in view) return view
      const read = readSnapshot(snapshot)
      if (!read) return refuse('invalid_input', 'snapshot_invalid', 'the snapshot is incomplete')
      view.snapshot = read
      render(view)
      return OK
    },

    async exportState() {
      const view = live()
      if ('ok' in view) return view
      if (view.submissions.some((request) => !request.settled))
        return refuse('conflict', 'request_in_flight', 'a request is still waiting for its outcome')
      const active = view.root.ownerDocument.activeElement
      const focused = active && view.root.contains(active) ? active.closest('[data-agnes-region]') : null
      const focus = (focused?.getAttribute('data-agnes-region') ?? null) as Region | null
      return {
        ok: true,
        value: { schema: { ...STATE_SCHEMA }, data: { draft: view.draft.value, viewId: chosen, focus } },
      }
    },

    async importState(state) {
      const view = admitted()
      if ('ok' in view) return view
      const schema = isObject(state) ? state.schema : null
      if (
        !isObject(schema) ||
        !isText(schema.typeId) ||
        !Number.isInteger(schema.revision) ||
        !isText(schema.digest)
      )
        return refuse('invalid_input', 'state_malformed', 'the view state has no schema')
      if (
        schema.typeId !== STATE_SCHEMA.typeId ||
        schema.revision !== STATE_SCHEMA.revision ||
        schema.digest !== STATE_SCHEMA.digest
      )
        return refuse('incompatible', 'state_version_mismatch', 'the view state belongs to another schema')
      const data = state.data
      if (
        !isObject(data) ||
        !isText(data.draft) ||
        !isTextOrNull(data.viewId) ||
        !(data.focus === null || REGIONS.includes(data.focus as Region))
      )
        return refuse('invalid_input', 'state_malformed', 'the view state data is malformed')
      view.draft.value = data.draft
      chosen = data.viewId as string | null
      render(view)
      // Focus the region's draft or chosen view when it has one, else the region itself.
      const region = data.focus === null ? null : view.regions[data.focus as Region]
      const target = region?.querySelector<HTMLElement>('textarea, [aria-current="true"]') ?? region
      target?.focus()
      return OK
    },

    stopAdmission() {
      admitting = false
    },

    async dispose() {
      if (disposed) return OK
      disposed = true
      admitting = false
      listeners.abort()
      mounted?.root.remove()
      mounted = null
      return OK
    },
  }
}
