// The Web client's default chat shell as a ShellProvider. It lays the chat out in the five public
// regions and reads session data only from the snapshots and the ShellServices it is mounted with:
// it holds no SDK client, reaches no daemon and borrows nothing from the app's own boot.
//
//   conversation  each turn of the conversation window, with its user and assistant text
//   interactions  pending interactions, so a forced approval is never hidden
//   composer      the draft, and what became of each prompt sent through the conversation client
//   resources     the domain views, each presented through the client host's presentation in a
//                 React region of its own; choosing one navigates through the services
//   settings      the session and its connection
//
// Each region carries the public region hook `data-agnes-region`. Every turn, interaction, prompt and
// view is an item with `data-agnes-shell-item` and a `data-agnes-shell-state` of pending, unknown,
// blocked, error, interrupted or done, the state also spelled out in its text. Wire text is only ever
// set as text, never parsed as HTML.
//
// View state is the draft, the chosen view, the focused region and the conversation's scroll position.
// A prompt still waiting for its outcome is held only here, so the shell refuses to export its state
// until the outcome arrives rather than lose it in a switch.
//
// Every word the shell itself shows is a key of DEFAULT_SHELL_TEXT looked up through the LocaleClient it
// is created with; refusal messages are diagnostics and stay in English.
import type {
  LocaleClient,
  Outcome,
  RendererPresentation,
  RuntimeError,
  SchemaRef,
  ShellProvider,
  ShellServices,
  ShellSnapshot,
  ShellViewState,
} from '@agnes/extension-api/client'
import { renderRegion, unmountRegion } from '@agnes/web-ui'

type Region = ShellProvider['descriptor']['requiredRegions'][number]
type ItemState = 'pending' | 'unknown' | 'blocked' | 'error' | 'interrupted' | 'done'
type DomainView = ShellSnapshot['views'][number]
type Refused = { ok: false; error: RuntimeError }

/** The regions in layout order. */
const REGIONS: readonly Region[] = ['settings', 'conversation', 'interactions', 'composer', 'resources']

const EN = {
  'defaultShell.region.settings': 'Session',
  'defaultShell.region.conversation': 'Conversation',
  'defaultShell.region.interactions': 'Pending interactions',
  'defaultShell.region.composer': 'Message composer',
  'defaultShell.region.resources': 'Views',
  'defaultShell.state.pending': 'pending',
  'defaultShell.state.unknown': 'unknown',
  'defaultShell.state.blocked': 'blocked',
  'defaultShell.state.error': 'error',
  'defaultShell.state.interrupted': 'interrupted',
  'defaultShell.state.done': 'done',
  'defaultShell.connection.connected': 'connected',
  'defaultShell.connection.reconnecting': 'reconnecting',
  'defaultShell.connection.offline': 'offline',
  'defaultShell.turn': 'Turn {turn}: {state}',
  'defaultShell.item': '{title}: {state}',
  'defaultShell.session': 'Session: {session}',
  'defaultShell.session.none': 'none',
  'defaultShell.connection': 'Connection: {connection}',
  'defaultShell.message': 'Message',
  'defaultShell.send': 'Send',
}
type TextKey = keyof typeof EN

/** The shell's text by locale; a host registers the dictionary of its locale with its LocaleClient. */
export const DEFAULT_SHELL_TEXT: Readonly<Record<'en' | 'zh-CN', Readonly<Record<TextKey, string>>>> = {
  en: EN,
  'zh-CN': {
    'defaultShell.region.settings': '会话',
    'defaultShell.region.conversation': '对话',
    'defaultShell.region.interactions': '待处理的交互',
    'defaultShell.region.composer': '消息输入',
    'defaultShell.region.resources': '视图',
    'defaultShell.state.pending': '进行中',
    'defaultShell.state.unknown': '未知',
    'defaultShell.state.blocked': '受阻',
    'defaultShell.state.error': '出错',
    'defaultShell.state.interrupted': '已中断',
    'defaultShell.state.done': '已完成',
    'defaultShell.connection.connected': '已连接',
    'defaultShell.connection.reconnecting': '重连中',
    'defaultShell.connection.offline': '离线',
    'defaultShell.turn': '第 {turn} 轮：{state}',
    'defaultShell.item': '{title}：{state}',
    'defaultShell.session': '会话：{session}',
    'defaultShell.session.none': '无',
    'defaultShell.connection': '连接：{connection}',
    'defaultShell.message': '消息',
    'defaultShell.send': '发送',
  },
}

/**
 * DEFAULT_SHELL_TEXT as a LocaleClient, for a host without one of its own: `locale` when the shell has
 * its text, else English. A `{name}` placeholder takes the parameter of that name.
 */
export function defaultShellLocale(locale: string): LocaleClient {
  const known = locale === 'zh-CN' ? locale : 'en'
  const dictionary: Readonly<Record<string, string>> = DEFAULT_SHELL_TEXT[known]
  return {
    locale: known,
    text: (key, parameters = {}) =>
      (Object.hasOwn(dictionary, key) ? (dictionary[key] as string) : key).replace(
        /\{(\w+)\}/g,
        (placeholder, name: string) =>
          Object.hasOwn(parameters, name) ? String(parameters[name]) : placeholder,
      ),
    formatNumber: (value) => new Intl.NumberFormat(known).format(value),
    formatDate: (value) =>
      new Intl.DateTimeFormat(known, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)),
  }
}

type Text = (key: TextKey, parameters?: Readonly<Record<string, string | number>>) => string

// Revision 1 of ViewState below. The digest is canonicalJsonDigest of
// {"draft":"string","viewId":"string|null","focus":"region|null","scroll":"number"}; a new data shape
// takes a new revision and digest, and state written under any other schema is refused.
const STATE_SCHEMA: SchemaRef = {
  typeId: 'agnes.web/default-shell-state@1',
  revision: 1,
  digest: '4697d856b0d2f88ca87c23f615fb94859c46e86b84aeacd11097e37fc8ffdc8e',
}
type ViewState = { draft: string; viewId: string | null; focus: Region | null; scroll: number }

// The state each command status, turn status or reason, view phase or interaction status shows as.
// Anything not listed shows as unknown, never as done.
const STATES = new Map(
  Object.entries({
    pending: 'accepted running waiting parked pending provisional',
    unknown: 'unknown_effect',
    blocked: 'blocked budget max_steps expired',
    error: 'failed error not-accepted',
    interrupted: 'cancelled aborted interrupted',
    done: 'completed succeeded finalized answered',
  }).flatMap(([state, words]) => words.split(' ').map((word) => [word, state as ItemState] as const)),
)
const stateOf = (word: string): ItemState => STATES.get(word) ?? 'unknown'

const OK: Outcome<void> = { ok: true, value: undefined }
const refuse = (code: RuntimeError['code'], detailCode: string, message: string): Refused => ({
  ok: false,
  error: { code, detailCode, message, retryAdvice: { kind: 'never' }, diagnosticId: 'web-default-shell' },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const listOf = (value: unknown, valid: (item: Record<string, unknown>) => boolean) =>
  Array.isArray(value) && value.every((item) => isRecord(item) && valid(item))

/** Whether `value` has every snapshot field this shell reads, with the wire's types. */
function readable(value: unknown): value is ShellSnapshot {
  if (!isRecord(value)) return false
  const { conversation } = value
  const timeline =
    isRecord(conversation) && isRecord(conversation.native) ? conversation.native.timeline : undefined
  return (
    (value.sessionId === null || isText(value.sessionId)) &&
    typeof value.catalogRevision === 'number' &&
    (conversation === null ||
      (isRecord(timeline) &&
        typeof timeline.generation === 'number' &&
        listOf(timeline.nodes, (node) => isText(node.id) && isText(node.kind)) &&
        listOf(
          timeline.turns,
          (turn) =>
            isText(turn.id) &&
            typeof turn.turn === 'number' &&
            isText(turn.status) &&
            (turn.reason === undefined || isText(turn.reason)) &&
            Array.isArray(turn.nodeIds) &&
            turn.nodeIds.every(isText),
        ))) &&
    listOf(
      value.views,
      (view) =>
        isText(view.viewId) && isText(view.domainType) && isText(view.phase) && isText(view.fallbackText),
    ) &&
    listOf(
      value.pending,
      (record) =>
        isText(record.interactionId) &&
        isText(record.status) &&
        isRecord(record.request) &&
        isText(record.request.title),
    ) &&
    ['connected', 'reconnecting', 'offline'].includes(value.connection as string) &&
    (value.cursor === null || isText(value.cursor))
  )
}

function readableState(data: unknown): data is ViewState {
  return (
    isRecord(data) &&
    isText(data.draft) &&
    (data.viewId === null || isText(data.viewId)) &&
    (data.focus === null || REGIONS.includes(data.focus as Region)) &&
    typeof data.scroll === 'number' &&
    Number.isFinite(data.scroll) &&
    data.scroll >= 0
  )
}

type Node = NonNullable<ShellSnapshot['conversation']>['native']['timeline']['nodes'][number]

/** What a user or assistant node says, as plain text. */
function spoken(node: Node | undefined): string {
  if (node?.kind === 'assistant') return isText(node.text) ? node.text : ''
  if (node?.kind !== 'user' || !Array.isArray(node.content)) return ''
  return node.content
    .flatMap((block) => (isRecord(block) && block.type === 'text' && isText(block.text) ? [block.text] : []))
    .join('\n')
}

/** One domain view's entry in the resources region, kept across updates so focus inside it stays. */
interface Presented {
  readonly entry: HTMLLIElement
  readonly choose: HTMLButtonElement
  readonly host: HTMLElement
  /** Whether `host` holds a React region rather than fallback text. */
  react: boolean
}

interface Prompt {
  readonly requestId: string
  readonly text: string
  state: ItemState
  settled: boolean
}

interface Mounted {
  readonly services: ShellServices
  readonly text: Text
  readonly formatNumber: (value: number) => string
  readonly root: HTMLElement
  readonly regions: Readonly<Record<Region, HTMLElement>>
  readonly lists: Readonly<Record<Region, HTMLUListElement>>
  readonly draft: HTMLTextAreaElement
  readonly prompts: Prompt[]
  readonly views: Map<string, Presented>
  /** Every listener the shell adds goes through this controller's signal, so dispose removes them all. */
  readonly listeners: AbortController
  snapshot: ShellSnapshot
  chosen: string | null
}

const release = (presented: Presented) => {
  unmountRegion(presented.host)
  presented.react = false
}

/** Puts `nodes` into `list` in order, moving only those out of place so focus inside the rest stays. */
function place(list: HTMLElement, nodes: readonly HTMLElement[]): void {
  let next = list.firstChild
  for (const node of nodes) {
    if (node === next) next = node.nextSibling
    else list.insertBefore(node, next)
  }
  while (next) {
    const after = next.nextSibling
    next.remove()
    next = after
  }
}

const key = (node: ChildNode) =>
  node.nodeType === node.ELEMENT_NODE
    ? `${node.nodeName}:${(node as HTMLElement).dataset.agnesShellItem ?? ''}`
    : node.nodeName

/**
 * Makes `parent`'s children match `wanted`, keeping each node already there under the same key and changing
 * only what differs, so a selection or focus inside unchanged text stays.
 */
function rewrite(parent: Element, wanted: readonly ChildNode[]): void {
  let have = parent.firstChild
  for (const node of wanted) {
    let found = have
    while (found && key(found) !== key(node)) found = found.nextSibling
    if (!found) {
      parent.insertBefore(node, have)
      continue
    }
    while (have && have !== found) {
      const after: ChildNode | null = have.nextSibling
      have.remove()
      have = after
    }
    if (found.nodeType === found.ELEMENT_NODE) {
      const element = found as Element
      const next = node as Element
      for (const name of element.getAttributeNames())
        if (!next.hasAttribute(name)) element.removeAttribute(name)
      for (const name of next.getAttributeNames()) {
        const value = next.getAttribute(name) ?? ''
        if (element.getAttribute(name) !== value) element.setAttribute(name, value)
      }
      rewrite(element, [...next.childNodes])
    } else if (found.nodeValue !== node.nodeValue) found.nodeValue = node.nodeValue
    have = found.nextSibling
  }
  while (have) {
    const after: ChildNode | null = have.nextSibling
    have.remove()
    have = after
  }
}

function item<K extends 'li' | 'button'>(doc: Document, tag: K, id: string, state: ItemState, text: string) {
  const element = doc.createElement(tag)
  element.dataset.agnesShellItem = id
  element.dataset.agnesShellState = state
  element.textContent = text
  return element
}

const line = (doc: Document, tag: 'p' | 'li', text: string) =>
  Object.assign(doc.createElement(tag), { textContent: text })

/** Shows `view` in its entry's host: the presented Web element, or else its fallback text. */
function present(services: ShellServices, presented: Presented, view: DomainView): void {
  let outcome: Outcome<RendererPresentation> | undefined
  try {
    outcome = services.presentation.domain(view)
  } catch {
    // A presentation that throws shows the fallback text.
  }
  if (outcome?.ok === true && outcome.value.target === 'web') {
    try {
      if (!presented.react) presented.host.replaceChildren()
      presented.react = true
      renderRegion(presented.host, outcome.value.element)
      return
    } catch {
      // As above: a renderer that fails to render shows the fallback text.
    }
  }
  release(presented)
  if (presented.host.textContent !== view.fallbackText) presented.host.textContent = view.fallbackText
}

function render(view: Mounted): void {
  const { snapshot, lists, services, text } = view
  const named = (state: ItemState) => text(`defaultShell.state.${state}`)
  const doc = view.root.ownerDocument
  const timeline = snapshot.conversation?.native.timeline
  const nodes = new Map(timeline?.nodes.map((node) => [node.id, node]))
  rewrite(
    lists.conversation,
    (timeline?.turns ?? []).map((turn) => {
      const state = stateOf(turn.reason ?? turn.status)
      const entry = item(doc, 'li', turn.id, state, '')
      const messages = turn.nodeIds.map((id) => spoken(nodes.get(id))).filter(Boolean)
      entry.append(
        line(
          doc,
          'p',
          text('defaultShell.turn', { turn: view.formatNumber(turn.turn), state: named(state) }),
        ),
        ...messages.map((message) => line(doc, 'p', message)),
      )
      return entry
    }),
  )
  rewrite(
    lists.interactions,
    snapshot.pending.map((record) => {
      const state = stateOf(record.status)
      const entry = item(
        doc,
        'li',
        record.interactionId,
        state,
        text('defaultShell.item', { title: record.request.title, state: named(state) }),
      )
      if (isText(record.request.body)) entry.append(line(doc, 'p', record.request.body))
      return entry
    }),
  )
  const shown = new Set<string>()
  const entries = snapshot.views.map((domain) => {
    shown.add(domain.viewId)
    let presented = view.views.get(domain.viewId)
    if (!presented) {
      const entry = doc.createElement('li')
      const choose = item(doc, 'button', domain.viewId, 'unknown', '')
      choose.type = 'button'
      presented = { entry, choose, host: doc.createElement('div'), react: false }
      entry.append(choose, presented.host)
      view.views.set(domain.viewId, presented)
    }
    const state = stateOf(domain.phase)
    presented.choose.dataset.agnesShellState = state
    presented.choose.textContent = text('defaultShell.item', {
      title: domain.domainType,
      state: named(state),
    })
    if (domain.viewId === view.chosen) presented.choose.setAttribute('aria-current', 'true')
    else presented.choose.removeAttribute('aria-current')
    present(services, presented, domain)
    return presented.entry
  })
  for (const [viewId, presented] of view.views)
    if (!shown.has(viewId)) {
      release(presented)
      view.views.delete(viewId)
    }
  place(lists.resources, entries)
  rewrite(lists.settings, [
    line(
      doc,
      'li',
      text('defaultShell.session', { session: snapshot.sessionId ?? text('defaultShell.session.none') }),
    ),
    line(
      doc,
      'li',
      text('defaultShell.connection', { connection: text(`defaultShell.connection.${snapshot.connection}`) }),
    ),
  ])
  renderPrompts(view)
}

function renderPrompts(view: Mounted): void {
  const doc = view.root.ownerDocument
  const { text } = view
  // ponytail: one entry per prompt sent from this mount; trim settled ones if long sessions make it heavy.
  rewrite(
    view.lists.composer,
    view.prompts.map((prompt) =>
      item(
        doc,
        'li',
        prompt.requestId,
        prompt.state,
        text('defaultShell.item', { title: prompt.text, state: text(`defaultShell.state.${prompt.state}`) }),
      ),
    ),
  )
}

/** A default chat shell that shows its text through `locale`. */
export function createDefaultShell(locale: LocaleClient): ShellProvider {
  const text: Text = (key, parameters) => locale.text(key, parameters)
  let mounted: Mounted | undefined
  let admitting = false
  let disposed = false

  /** The mounted view, or why the shell refuses the call. */
  const live = (admission: boolean): Mounted | Refused => {
    if (disposed) return refuse('conflict', 'shell_disposed', 'the shell was disposed')
    if (!mounted) return refuse('conflict', 'shell_not_mounted', 'the shell is not mounted')
    if (admission && !admitting)
      return refuse('conflict', 'shell_admission_stopped', 'the shell admits no more changes')
    return mounted
  }

  async function submit(view: Mounted): Promise<void> {
    const text = view.draft.value.trim()
    const { sessionId, conversation } = view.snapshot
    if (!admitting || mounted !== view || text === '' || sessionId === null) return
    const prompt: Prompt = { requestId: crypto.randomUUID(), text, state: 'pending', settled: false }
    view.prompts.push(prompt)
    view.draft.value = ''
    renderPrompts(view)
    let state: ItemState = 'error'
    try {
      const outcome = await view.services.conversation.submit({
        sessionId,
        kind: 'prompt',
        content: [{ type: 'text', text }],
        requestId: prompt.requestId,
        expectedGeneration: conversation?.native.timeline.generation ?? 0,
      })
      if (outcome.ok) state = stateOf(outcome.value.status)
    } catch {
      // A services call that throws shows as an error, never as done.
    }
    prompt.state = state
    prompt.settled = true
    if (mounted !== view) return
    // A prompt that did not go through returns to an empty draft, so nothing typed is lost.
    if (state === 'error' && view.draft.value === '') view.draft.value = text
    renderPrompts(view)
  }

  async function navigate(view: Mounted, viewId: string): Promise<void> {
    const sessionId = view.snapshot.sessionId
    if (!admitting || sessionId === null) return
    const outcome = await view.services.navigate({ sessionId, viewId }).catch(() => undefined)
    if (!outcome?.ok || mounted !== view) return
    view.chosen = viewId
    render(view)
  }

  function build(container: HTMLElement, services: ShellServices, snapshot: ShellSnapshot): Mounted {
    const doc = container.ownerDocument
    const root = doc.createElement('div')
    root.className = 'agnes-default-shell'
    const regions = {} as Record<Region, HTMLElement>
    const lists = {} as Record<Region, HTMLUListElement>
    for (const name of REGIONS) {
      const section = doc.createElement('section')
      section.dataset.agnesRegion = name
      section.setAttribute('aria-label', text(`defaultShell.region.${name}`))
      section.tabIndex = -1
      lists[name] = section.appendChild(doc.createElement('ul'))
      regions[name] = section
    }
    const form = doc.createElement('form')
    const draft = doc.createElement('textarea')
    draft.setAttribute('aria-label', text('defaultShell.message'))
    const send = Object.assign(doc.createElement('button'), { type: 'submit' })
    send.textContent = text('defaultShell.send')
    form.append(draft, send)
    regions.composer.prepend(form)
    root.append(...Object.values(regions))
    const view: Mounted = {
      services,
      text,
      formatNumber: (value) => locale.formatNumber(value),
      root,
      regions,
      lists,
      draft,
      prompts: [],
      views: new Map(),
      listeners: new AbortController(),
      snapshot,
      chosen: null,
    }
    const { signal } = view.listeners
    form.addEventListener(
      'submit',
      (event) => {
        event.preventDefault()
        void submit(view)
      },
      { signal },
    )
    // Enter sends and Shift+Enter starts a new line, as in the chat composer.
    draft.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
        event.preventDefault()
        form.requestSubmit()
      },
      { signal },
    )
    lists.resources.addEventListener(
      'click',
      (event) => {
        // Only a view's own entry navigates; a click inside a presented view stays with that view.
        const choose = (event.target as Element | null)?.closest?.('button')
        const viewId = choose?.getAttribute('data-agnes-shell-item')
        if (viewId != null && view.views.get(viewId)?.choose === choose) void navigate(view, viewId)
      },
      { signal },
    )
    container.append(root)
    render(view)
    return view
  }

  return {
    descriptor: {
      id: 'agnes.web.default-shell',
      apiMajor: 1,
      stateSchema: STATE_SCHEMA,
      requiredRegions: [...REGIONS],
    },

    async mount({ container, snapshot, services, ownerToken, signal }) {
      if (disposed) return refuse('conflict', 'shell_disposed', 'the shell was disposed')
      if (mounted) return refuse('conflict', 'shell_mounted', 'the shell is already mounted')
      const valid =
        container?.nodeType === 1 &&
        isText(ownerToken) &&
        ownerToken !== '' &&
        typeof services?.conversation?.submit === 'function' &&
        typeof services.presentation?.domain === 'function' &&
        typeof services.navigate === 'function' &&
        typeof signal?.addEventListener === 'function' &&
        readable(snapshot)
      if (!valid)
        return refuse('invalid_input', 'shell_mount_invalid', 'the mount input is incomplete or malformed')
      if (signal.aborted) return refuse('cancelled', 'shell_mount_cancelled', 'the mount was cancelled')
      const view = build(container, services, snapshot)
      mounted = view
      admitting = true
      signal.addEventListener(
        'abort',
        () => {
          admitting = false
        },
        { signal: view.listeners.signal },
      )
      return OK
    },

    async update(snapshot) {
      const view = live(true)
      if ('ok' in view) return view
      if (!readable(snapshot))
        return refuse('invalid_input', 'shell_snapshot_invalid', 'the snapshot is malformed')
      view.snapshot = snapshot
      render(view)
      return OK
    },

    async exportState(): Promise<Outcome<ShellViewState>> {
      const view = live(false)
      if ('ok' in view) return view
      if (view.prompts.some((prompt) => !prompt.settled))
        return refuse('conflict', 'shell_prompt_in_flight', 'a prompt is still waiting for its outcome')
      const active = view.root.ownerDocument.activeElement
      const focus = REGIONS.find((name) => view.regions[name].contains(active)) ?? null
      const scroll = view.regions.conversation.scrollTop
      const data: ViewState = {
        draft: view.draft.value,
        viewId: view.chosen,
        focus,
        scroll: Number.isFinite(scroll) && scroll > 0 ? scroll : 0,
      }
      return { ok: true, value: { schema: { ...STATE_SCHEMA }, data } }
    },

    async importState(state) {
      const view = live(true)
      if ('ok' in view) return view
      const schema = isRecord(state) ? state.schema : undefined
      if (
        !isRecord(schema) ||
        !isText(schema.typeId) ||
        !Number.isSafeInteger(schema.revision) ||
        !isText(schema.digest)
      )
        return refuse('invalid_input', 'shell_state_malformed', 'the view state names no schema')
      if (
        schema.typeId !== STATE_SCHEMA.typeId ||
        schema.revision !== STATE_SCHEMA.revision ||
        schema.digest !== STATE_SCHEMA.digest
      )
        return refuse(
          'incompatible',
          'shell_state_incompatible',
          `this shell cannot read view state ${schema.typeId} revision ${String(schema.revision)}`,
        )
      const { data } = state
      if (!readableState(data))
        return refuse('invalid_input', 'shell_state_malformed', 'the view state data is malformed')
      view.draft.value = data.draft
      view.chosen = data.viewId
      render(view)
      if (data.focus !== null) (data.focus === 'composer' ? view.draft : view.regions[data.focus]).focus()
      view.regions.conversation.scrollTop = data.scroll
      return OK
    },

    stopAdmission() {
      admitting = false
    },

    // Every reason releases the same way: what the shell mounted goes, whatever ended it.
    async dispose() {
      disposed = true
      admitting = false
      const view = mounted
      mounted = undefined
      if (view) {
        view.listeners.abort()
        for (const presented of view.views.values()) release(presented)
        view.root.remove()
      }
      return OK
    },
  }
}
