import { type Context, Service } from '@agnes/cordis'
import type {
  ComparisonCreateParams,
  EventEnvelope,
  RuntimeDescriptor,
  RuntimeIdentity,
  ThinkingLevel,
  WorkspaceEntry,
} from '@agnes/protocol'

export type WorkbenchPermission = 'view' | 'workspace' | 'full'
export type WorkbenchMode = Pick<RuntimeDescriptor, 'id' | 'label' | 'available' | 'unavailableReason'> & {
  hint?: string
  permissions?: readonly { id: WorkbenchPermission; label: string; description: string }[]
  permissionMessage?(mode: WorkbenchPermission): string
}
/** One immutable capture is used for each first submission. */
export interface WorkbenchSnapshot {
  revision: number
  runtimes: readonly RuntimeDescriptor[]
  workspaces: readonly WorkspaceEntry[]
  selectedMode: string
  permissionMode: WorkbenchPermission
  decisionBackend?: 'jev' | 'laya'
  /** Draft JevLoop stage bindings; a dual-line comparison freezes them into its JevLoop lane. */
  jevStages?: ComparisonCreateParams['right']['jevStages']
  cwd?: string
  model?: { route: string; model: string; thinking?: ThinkingLevel; contextWindow?: number }
  connected: boolean
  sending: boolean
  loading: boolean
  session?: { id: string; runtime?: RuntimeIdentity; head: number }
  view: 'chat' | 'trace'
}
export interface WorkbenchTarget {
  provider: string
  id: string
  mode: string
  title: string
  label: string
  hint: string
  modelLabel: string
  workspaceLabel: string
  decisionBackends?: RuntimeDescriptor['decisionBackends']
  defaultDecisionBackend?: 'jev' | 'laya'
  /** Provider-owned location fields, encoded by the host. */
  query: Readonly<Record<string, string>>
}
/**
 * A fixed conversation cut a module holds the native transcript at: the durable ledger seq a
 * replay surface (for example all-turn Jev replay) is scrubbing. Presentation-only; the host
 * decides how to render it and `undefined` returns the conversation to live.
 */
export type ReplayCut = Readonly<{ sessionId: string; through: number }>
/** Explicit public DOM surfaces. Modules own their children, never the surrounding shell. */
export interface WorkbenchSurfaces {
  root: HTMLElement
  chat: HTMLElement
  aside: HTMLElement
  divider: HTMLElement
  footer: HTMLElement
  toolbar: HTMLElement
  overlay: HTMLElement
}
export interface WorkbenchProvider {
  id: string
  modes(snapshot: WorkbenchSnapshot): readonly WorkbenchMode[]
  resolve(url: URL): string | undefined
  open(id: string): Promise<void>
  submit(input: { key: string; text: string; target?: string; snapshot: WorkbenchSnapshot }): Promise<void>
  close(): void
  errorMessage?(error: unknown): string | undefined
}
export interface WorkbenchClient {
  readonly surfaces: WorkbenchSurfaces
  readonly snapshot: WorkbenchSnapshot
  readonly target: WorkbenchTarget | undefined
  register(provider: WorkbenchProvider): () => void
  subscribe(listener: (snapshot: WorkbenchSnapshot) => void): () => void
  observe(listener: (event: EventEnvelope) => void): () => void
  select(target: WorkbenchTarget | undefined): Promise<void>
  openSettings(pane: 'model' | 'jev'): Promise<void>
  /** Holds the native conversation at a ledger cut this module owns; `undefined` resumes live. */
  setReplayCut(cut: ReplayCut | undefined): void
}

function immutable<T>(value: T): T {
  const clone = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object') return
    for (const child of Object.values(item)) freeze(child)
    Object.freeze(item)
  }
  freeze(clone)
  return clone
}

const initial: WorkbenchSnapshot = {
  revision: 0,
  runtimes: [],
  workspaces: [],
  selectedMode: 'native',
  permissionMode: 'workspace',
  connected: false,
  sending: false,
  loading: false,
  view: 'chat',
}

/** Generic browser ownership seam; it has no knowledge of runtime-specific UI or RPCs. */
export class WorkbenchService extends Service {
  private state: WorkbenchSnapshot = immutable(initial)
  private readonly providers = new Map<string, { owner: string; provider: WorkbenchProvider }>()
  private readonly listeners = new Set<(state: WorkbenchSnapshot) => void>()
  private readonly observers = new Set<(event: EventEnvelope) => void>()
  private host?: {
    surfaces: WorkbenchSurfaces
    select(target: WorkbenchTarget | undefined, current?: () => boolean): Promise<void>
    openSettings?(pane: 'model' | 'jev'): Promise<void>
    changed(): void
  }
  private active: WorkbenchTarget | undefined
  private selectionEpoch = 0
  private selectionOwner: string | undefined
  private cut: ReplayCut | undefined
  private cutOwner: string | undefined
  private readonly cutListeners = new Set<(cut: ReplayCut | undefined) => void>()
  constructor(ctx: Context) {
    super(ctx, 'workbench')
  }

  configure(host: NonNullable<WorkbenchService['host']>): void {
    this.host = host
  }
  get snapshot(): WorkbenchSnapshot {
    return this.state
  }
  get target(): WorkbenchTarget | undefined {
    return this.active
  }
  get available(): boolean {
    return !this.active || this.providers.has(this.active.provider)
  }
  get modes(): readonly WorkbenchMode[] {
    const modes = [...this.providers.values()].flatMap(({ provider }) => [...provider.modes(this.state)])
    const ids = new Set(['native', ...this.state.runtimes.map((runtime) => runtime.id)])
    for (const mode of modes) {
      if (ids.has(mode.id)) throw new Error('duplicate workbench mode')
      ids.add(mode.id)
    }
    return modes
  }
  mode(id: string): WorkbenchMode | undefined {
    return this.modes.find((mode) => mode.id === id)
  }
  publish(state: Omit<WorkbenchSnapshot, 'revision'>): void {
    this.state = immutable({ ...state, revision: this.state.revision + 1 })
    const snapshot = this.state
    for (const listener of this.listeners) this.deliver(() => listener(snapshot))
  }
  /** The conversation cut a module currently holds, if any; read by the host each render. */
  get replayCut(): ReplayCut | undefined {
    return this.cut
  }
  /**
   * Host- or module-side cut write. Notifications are value-based and deduplicated; `owner`
   * marks the module whose fiber must outlive the cut (module unload clears only its own cut).
   */
  setReplayCut(cut: ReplayCut | undefined, owner?: string): void {
    const unchanged = cut?.sessionId === this.cut?.sessionId && cut?.through === this.cut?.through
    this.cutOwner = cut ? owner : undefined
    if (unchanged) return
    this.cut = cut ? Object.freeze({ ...cut }) : undefined
    for (const listener of [...this.cutListeners]) this.deliver(() => listener(this.cut))
  }
  observeReplayCut(listener: (cut: ReplayCut | undefined) => void): () => void {
    this.cutListeners.add(listener)
    return () => this.cutListeners.delete(listener)
  }
  event(sessionId: string, event: EventEnvelope): void {
    if (sessionId !== this.state.session?.id) return
    for (const listener of this.observers) this.deliver(() => listener(event))
  }
  private deliver(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      console.error('[workbench]', error)
    }
  }
  private ownerForMode(id: string) {
    // Validate current declarations before choosing an owner; dynamic collisions fail closed.
    this.modes
    return [...this.providers.values()].find(({ provider }) =>
      provider.modes(this.state).some((mode) => mode.id === id),
    )
  }
  async submit(key: string, text: string): Promise<boolean> {
    this.modes
    const entry = this.active
      ? this.providers.get(this.active.provider)
      : this.ownerForMode(this.state.selectedMode)
    if (!entry) {
      if (this.active) throw new Error('当前页面的插件已禁用或不可用；请启用插件后继续。')
      if (
        this.state.selectedMode !== 'native' &&
        !this.state.runtimes.some((runtime) => runtime.id === this.state.selectedMode)
      )
        throw new Error('所选执行方式不可用。')
      return false
    }
    const target = this.active?.id
    const snapshot = immutable(this.state)
    if (
      !target &&
      !entry.provider.modes(snapshot).some((mode) => mode.id === snapshot.selectedMode && mode.available)
    )
      throw new Error('所选执行方式不可用。')
    await entry.provider.submit({ key, text, ...(target ? { target } : {}), snapshot })
    return true
  }
  /** Unknown routes are preserved, never interpreted as a fresh native draft. */
  hasLocation(url: URL): boolean {
    return [...url.searchParams.keys()].some((key) => key !== 'session')
  }
  async restore(url: URL): Promise<boolean> {
    const matches = [...this.providers.values()].flatMap(({ provider }) => {
      const id = provider.resolve(url)
      return id === undefined ? [] : [{ provider, id }]
    })
    if (matches.length > 1) throw new Error('页面目标存在多个插件处理器，无法安全打开。')
    if (matches[0]) {
      await matches[0].provider.open(matches[0].id)
      return true
    }
    if (this.hasLocation(url)) throw new Error('此页面需要的客户端插件尚未加载；请启用插件后重试。')
    return false
  }
  clear(): void {
    ++this.selectionEpoch
    this.selectionOwner = undefined
    this.setReplayCut(undefined)
    for (const { provider } of this.providers.values()) this.deliver(() => provider.close())
    this.active = undefined
  }
  errorMessage(error: unknown): string | undefined {
    const entry = this.active
      ? this.providers.get(this.active.provider)
      : this.ownerForMode(this.state.selectedMode)
    return entry?.provider.errorMessage?.(error)
  }
  /** All registrations and notifications belong to the calling module's fiber. */
  bind(ctx: Context, owner: string): WorkbenchClient {
    let alive = true
    const owned = new Set<string>()
    const cleanups = new Set<() => void>()
    const assertActive = () => {
      if (!alive) throw new Error('客户端模块已卸载。')
    }
    const own = (dispose: () => void) => {
      cleanups.add(dispose)
      return () => {
        if (cleanups.delete(dispose)) dispose()
      }
    }
    ctx.effect(() => () => {
      alive = false
      if (this.selectionOwner === owner) ++this.selectionEpoch
      for (const dispose of cleanups) this.deliver(dispose)
      cleanups.clear()
      this.host?.changed()
    })
    const service = this
    // A conversation frozen by this module must never outlive the module's fiber.
    own(() => {
      if (service.cutOwner === owner) service.setReplayCut(undefined)
    })
    return {
      get surfaces() {
        assertActive()
        if (!service.host) throw new Error('当前宿主未提供工作区界面。')
        return service.host.surfaces
      },
      get snapshot() {
        return service.state
      },
      get target() {
        return service.active
      },
      register: (provider) => {
        assertActive()
        if (!this.host) throw new Error('当前宿主未提供工作区界面。')
        if (this.providers.has(provider.id)) throw new Error(`duplicate workbench provider: ${provider.id}`)
        const existing = new Set([
          'native',
          ...this.state.runtimes.map((runtime) => runtime.id),
          ...this.modes.map((mode) => mode.id),
        ])
        const proposed = provider.modes(this.state).map((mode) => mode.id)
        if (new Set(proposed).size !== proposed.length || proposed.some((id) => existing.has(id)))
          throw new Error('duplicate workbench mode')
        this.providers.set(provider.id, { owner, provider })
        owned.add(provider.id)
        const off = own(() => {
          if (this.providers.get(provider.id)?.provider !== provider) return
          this.providers.delete(provider.id)
          owned.delete(provider.id)
          if (this.active?.provider === provider.id) ++this.selectionEpoch
          try {
            provider.close()
          } finally {
            this.host?.changed()
          }
        })
        try {
          this.host.changed()
        } catch (error) {
          off()
          throw error
        }
        return off
      },
      subscribe: (listener) => {
        assertActive()
        const bound = (snapshot: WorkbenchSnapshot) => {
          if (alive) listener(snapshot)
        }
        this.listeners.add(bound)
        return own(() => {
          this.listeners.delete(bound)
        })
      },
      observe: (listener) => {
        assertActive()
        const bound = (event: EventEnvelope) => {
          if (alive) listener(event)
        }
        this.observers.add(bound)
        return own(() => {
          this.observers.delete(bound)
        })
      },
      select: async (target) => {
        assertActive()
        if (target && !owned.has(target.provider)) throw new Error('插件不能选择其他模块的页面。')
        if (!target && this.active && !owned.has(this.active.provider))
          throw new Error('插件不能关闭其他模块的页面。')
        const previous = this.active
        const selected = target === undefined ? undefined : immutable(target)
        const epoch = ++this.selectionEpoch
        this.selectionOwner = owner
        this.active = selected
        const current = () =>
          alive &&
          epoch === this.selectionEpoch &&
          this.active === selected &&
          (!selected || owned.has(selected.provider))
        try {
          await this.host?.select(selected, current)
          if (!current()) throw new Error('客户端模块已卸载或页面选择已改变。')
        } catch (error) {
          if (current()) this.active = previous
          throw error
        }
      },
      openSettings: async (pane) => {
        assertActive()
        if (pane !== 'model' && pane !== 'jev') throw new Error('未知设置页面。')
        if (!this.host?.openSettings) throw new Error('宿主不支持配置入口。')
        await this.host.openSettings(pane)
        assertActive()
      },
      setReplayCut: (cut) => {
        assertActive()
        service.setReplayCut(cut, owner)
      },
    }
  }
}
