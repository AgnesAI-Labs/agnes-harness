/** 宿主服务与插件身份类型（WC6）。实现由宿主在启动时实例化并包装宿主既有状态（WC8），本包只定义合同。 */
import { type Context, Service } from '@agnes/cordis'
import type { ArtifactReadResult, ArtifactRef } from '@agnes/protocol'

/** 当前页面已连接的 SDK 客户端；宿主提供同一实例（WC6）。
 *  用浏览器导出变体：插件跑在页面里，Node 专属面（packages/skills 等）不在页面上。 */
/** The host SDK client before the module-specific service facade is attached. */
export type HostAgnesClient = import('@agnes/sdk/browser').Client

/** The only backend-service entry point available to a browser module. */
export type ClientServiceApi = Readonly<{
  call(name: string, input: Record<string, unknown>): Promise<unknown>
}>

export type AgnesClient = HostAgnesClient & Readonly<{ services: ClientServiceApi }>

export type ClientImageArtifact = Readonly<Pick<ArtifactRef, 'sha256' | 'size' | 'mime'>>
export type ClientDocumentArtifact = ClientImageArtifact

export type ClientDocumentKind = 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'code'

export type ClientImageResource = Readonly<{
  artifact: ClientImageArtifact
  url: string
  release(): void
}>

export type ClientImageLoader = Readonly<{
  load(input: Readonly<{ laneId: string; artifact: ClientImageArtifact }>): Promise<ClientImageResource>
}>

export type ClientDocumentResource = Readonly<{
  artifact: ClientImageArtifact
  kind: ClientDocumentKind
  content?: string
  url?: string
  release(): void
}>

export type ClientDocumentLoader = Readonly<{
  load(
    input: Readonly<{
      laneId: string
      kind: ClientDocumentKind
      artifact: ClientImageArtifact
    }>,
  ): Promise<ClientDocumentResource>
}>

export type ClientServiceCaller = (
  module: ModuleIdentity,
  sessionId: string,
  name: string,
  input: Record<string, unknown>,
) => Promise<unknown>

export type ClientEffectCaller = (
  module: ModuleIdentity,
  sessionId: string,
  name: string,
  commandId: string,
  input: Record<string, unknown>,
) => Promise<unknown>

/** Host-owned service that supplies the already-authenticated SDK client to browser modules. */
export class AgnesClientService extends Service {
  constructor(
    ctx: Context,
    readonly client: HostAgnesClient,
    readonly serviceCaller?: ClientServiceCaller,
    readonly effectCaller?: ClientEffectCaller,
  ) {
    super(ctx, 'agnes')
  }
}

export type SessionClientHandle = {
  readonly id: string
  readonly listeners: Set<(...args: never[]) => void>
  projectUI(): Promise<unknown>
  prompt(input: unknown): Promise<unknown>
  steer(input: unknown): Promise<unknown>
  followUp(input: unknown): Promise<unknown>
  compact(instructions?: string): Promise<unknown>
  cancel(): Promise<void>
}

export type SessionProjection = {
  read(name?: string): Promise<unknown>
  subscribe(listener: () => void): () => void
}

export type SessionCommands = {
  prompt(input: unknown): Promise<unknown>
  steer(input: unknown): Promise<unknown>
  followUp(input: unknown): Promise<unknown>
  compact(instructions?: string): Promise<unknown>
  cancel(): Promise<void>
}

/**
 * Browser-side command contribution.  Registering a command is deliberately
 * separate from executing it: package code never gets to decide whether the
 * currently signed-in person may run a command.
 */
export type ClientCommand = Readonly<{
  id: string
  title?: string
  /** Set only by the host adapter for an effect-backed command; useful to an approval UI. */
  effectService?: string
  execute(input: unknown): unknown | Promise<unknown>
}>

export type ClientEffectCommand = Readonly<{
  id: string
  title?: string
  service: string
}>

export type CommandAuthorizer = (
  request: Readonly<{
    owner: string
    command: ClientCommand
    input: unknown
  }>,
) => boolean | Promise<boolean>

/**
 * Host-owned command table for client modules.  The host supplies the policy
 * bridge; absent such a bridge execution is fail-closed.  Registration is
 * still useful because the host can render or audit the current command set.
 */
export class CommandService extends Service {
  private readonly entries = new Map<string, Readonly<{ owner: string; command: ClientCommand }>>()

  constructor(
    ctx: Context,
    private readonly authorize: CommandAuthorizer = async () => false,
  ) {
    super(ctx, 'commands')
  }

  register(owner: string, command: ClientCommand): () => void {
    if (typeof command.id !== 'string' || !/^[a-z][a-z0-9.-]{0,127}$/.test(command.id))
      throw new TypeError('client command id must be a stable lowercase identifier')
    if (typeof command.execute !== 'function')
      throw new TypeError('client command execute must be a function')
    const current = this.entries.get(command.id)
    if (current) throw new Error(`client command already registered: ${command.id}`)
    const entry = Object.freeze({ owner, command: Object.freeze({ ...command }) })
    this.entries.set(command.id, entry)
    return () => {
      if (this.entries.get(command.id) === entry) this.entries.delete(command.id)
    }
  }

  list(): readonly Readonly<{ id: string; title?: string; owner: string }>[] {
    return [...this.entries.values()]
      .map(({ owner, command }) => ({
        owner,
        id: command.id,
        ...(command.title ? { title: command.title } : {}),
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  async execute(id: string, input: unknown): Promise<unknown> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`client command is not registered: ${id}`)
    if (!(await this.authorize({ owner: entry.owner, command: entry.command, input })))
      throw new Error(`client command is not authorized: ${id}`)
    return await entry.command.execute(input)
  }

  async executeOwned(owner: string, id: string, input: unknown): Promise<unknown> {
    const entry = this.entries.get(id)
    if (!entry || entry.owner !== owner) throw new Error(`client command is not registered: ${id}`)
    return await this.execute(id, input)
  }
}

/** 宿主绑定的当前模块身份；是版本提示，不是安全凭据（WC6）。 */
export interface ModuleIdentity {
  /** Browser lifecycle/slot owner identity. Distinct rows of one package must not tear down each other. */
  rowId?: string
  packageId: string
  revision: string
  /** Informational manifest declaration enforced by the host registry as a UX/diagnostic guard. */
  allowedSlots?: readonly string[]
  /** Exact DSH-aligned component catalog used by this contribution. */
  slotCatalogVersion?: string
  /** Digest of the daemon-verified immutable client snapshot. */
  contentDigest?: string
  /** Explicit immutable manifest metadata, projected through the browser roster allow-list. */
  publicConfig?: Readonly<Record<string, unknown>>
  /** Immutable manifest allow-list for own-extension query services. */
  services?: readonly string[]
}

/** 当前会话：id 与订阅。会话切换由宿主推给服务，组件经 useSyncExternalStore 订阅。 */
export class SessionService extends Service {
  private currentSessionId: string | undefined
  private readonly client: HostAgnesClient | undefined
  private readonly listeners = new Set<() => void>()
  private readonly projectionListeners = new Set<() => void>()
  private currentHandle: SessionClientHandle | undefined
  private currentHandleListener: ((...args: never[]) => void) | undefined

  constructor(ctx: Context, initial?: string, client?: HostAgnesClient) {
    super(ctx, 'session')
    this.currentSessionId = initial
    this.client = client
    this.reattachHandle()
  }

  get sessionId(): string | undefined {
    return this.currentSessionId
  }

  /** 仅宿主调用。 */
  setSession(sessionId: string | undefined): void {
    if (sessionId === this.currentSessionId) return
    this.detachHandle()
    this.currentSessionId = sessionId
    this.reattachHandle()
    for (const listener of [...this.listeners]) listener()
  }

  /** Alias for hosts that model a session switch as a scope reattachment. */
  reattach(sessionId: string | undefined): void {
    this.setSession(sessionId)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): string | undefined => this.currentSessionId

  get handle(): SessionClientHandle | undefined {
    return this.currentHandle
  }

  /** Session-scoped UI projection bound to the current SDK session. */
  readonly projection: SessionProjection = {
    read: async (name = 'session.ui') => {
      const handle = this.currentHandle
      if (!handle)
        return {
          status: 'unavailable' as const,
          name,
          error: { code: 'E_PROJECTION_STATE' as const, safeMessage: 'session unavailable' },
        }
      const value = await handle.projectUI()
      return { status: 'available' as const, name, asOfSeq: 0, stateVersion: 1, value }
    },
    subscribe: (listener) => {
      this.projectionListeners.add(listener)
      return () => this.projectionListeners.delete(listener)
    },
  }

  /** Commands are bound to the current SDK session; the host remains the authority. */
  readonly commands: SessionCommands = {
    prompt: (input) => this.requireHandle().prompt(input),
    steer: (input) => this.requireHandle().steer(input),
    followUp: (input) => this.requireHandle().followUp(input),
    compact: (instructions) => this.requireHandle().compact(instructions),
    cancel: () => this.requireHandle().cancel(),
  }

  private requireHandle(): SessionClientHandle {
    if (!this.currentHandle) throw new Error('session unavailable')
    return this.currentHandle
  }

  private detachHandle(): void {
    if (this.currentHandle && this.currentHandleListener)
      this.currentHandle.listeners.delete(this.currentHandleListener)
    this.currentHandle = undefined
    this.currentHandleListener = undefined
  }

  private reattachHandle(): void {
    if (!this.client || !this.currentSessionId) return
    // Browser test hosts and compatibility embedders may supply the SDK subset
    // used by the workbench before `sessions` is available. Treat that as an
    // unavailable projection rather than breaking the entire Web bootstrap.
    const sessions = (this.client as unknown as { sessions?: { get?(id: string): unknown } }).sessions
    const handle = sessions?.get?.(this.currentSessionId) as SessionClientHandle | undefined
    if (!handle) return
    const listener = (() => {
      for (const item of [...this.projectionListeners]) item()
    }) as (...args: never[]) => void
    this.currentHandle = handle
    this.currentHandleListener = listener
    handle.listeners.add(listener)
  }
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg'])
const SHA256 = /^[0-9a-f]{64}$/

function isImageArtifact(value: unknown): value is ClientImageArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const artifact = value as Record<string, unknown>
  return (
    typeof artifact.sha256 === 'string' &&
    SHA256.test(artifact.sha256) &&
    typeof artifact.size === 'number' &&
    Number.isSafeInteger(artifact.size) &&
    artifact.size >= 0 &&
    artifact.size <= 1024 * 1024 &&
    typeof artifact.mime === 'string' &&
    IMAGE_MIMES.has(artifact.mime)
  )
}

function isArtifact(value: unknown): value is ClientImageArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const artifact = value as Record<string, unknown>
  return (
    typeof artifact.sha256 === 'string' &&
    SHA256.test(artifact.sha256) &&
    typeof artifact.size === 'number' &&
    Number.isSafeInteger(artifact.size) &&
    artifact.size >= 0 &&
    artifact.size <= 1024 * 1024 &&
    typeof artifact.mime === 'string' &&
    artifact.mime.length > 0 &&
    artifact.mime.length <= 128
  )
}

function acceptsDocumentMime(kind: ClientDocumentKind, mime: string): boolean {
  if (kind === 'image') return IMAGE_MIMES.has(mime)
  if (kind === 'pdf') return mime === 'application/pdf'
  if (kind === 'html') return mime === 'text/html'
  if (kind === 'markdown') return mime === 'text/markdown' || mime === 'text/plain'
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/javascript'
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
}

function sameImageArtifact(left: ClientImageArtifact, right: ClientImageArtifact): boolean {
  return left.sha256 === right.sha256 && left.size === right.size && left.mime === right.mime
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = globalThis.atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

/** Session-authorized image access for DSH components; raw URLs are intentionally not accepted. */
/** The daemon no longer holds this resource because the retention policy removed it. */
export class ClientResourceReclaimedError extends Error {
  constructor() {
    super('document resource was reclaimed by retention')
    this.name = 'ClientResourceReclaimedError'
  }
}

export class ClientResourceService extends Service {
  private readonly objectUrls = new Set<string>()

  readonly images: ClientImageLoader = Object.freeze({
    load: (input) => this.loadImage(input),
  })

  readonly documents: ClientDocumentLoader = Object.freeze({
    load: (input) => this.loadDocument(input),
  })

  constructor(
    ctx: Context,
    private readonly client: HostAgnesClient,
    private readonly session: SessionService,
  ) {
    super(ctx, 'resources')
    ctx.effect(() => this.releaseAll.bind(this))
  }

  private async loadImage(
    input: Readonly<{ laneId: string; artifact: ClientImageArtifact }>,
  ): Promise<ClientImageResource> {
    const sessionId = this.session.sessionId
    if (!sessionId) throw new Error('image resource requires an active session')
    if (!isBoundedText(input.laneId) || !isImageArtifact(input.artifact))
      throw new TypeError('image resource reference is invalid')

    const resource = await this.loadDocument({ ...input, kind: 'image' })
    if (!resource.url) throw new Error('image resource URL is unavailable')
    return Object.freeze({ artifact: resource.artifact, url: resource.url, release: resource.release })
  }

  private async loadDocument(
    input: Readonly<{ laneId: string; kind: ClientDocumentKind; artifact: ClientImageArtifact }>,
  ): Promise<ClientDocumentResource> {
    const sessionId = this.session.sessionId
    if (!sessionId) throw new Error('document resource requires an active session')
    if (
      !isBoundedText(input.laneId) ||
      !isArtifact(input.artifact) ||
      !acceptsDocumentMime(input.kind, input.artifact.mime)
    )
      throw new TypeError('document resource reference is invalid')

    const result = await this.client.call<ArtifactReadResult>('_agnes/v1/artifact.read', {
      sessionId,
      laneId: input.laneId,
      artifact: input.artifact,
    })
    if (this.session.sessionId !== sessionId) throw new Error('document resource session changed')
    if (!result.ok && result.status === 410 && result.code === 'artifact_reclaimed')
      throw new ClientResourceReclaimedError()
    if (!result.ok) throw new Error(`document resource is unavailable: ${result.code}`)
    if (!sameImageArtifact(result.artifact, input.artifact) || result.contentLength !== input.artifact.size)
      throw new Error('document resource identity mismatch')

    const bytes = decodeBase64(result.base64)
    if (bytes.byteLength !== result.contentLength) throw new Error('document resource length mismatch')
    const needsUrl = input.kind === 'image' || input.kind === 'pdf'
    const url = needsUrl ? this.createObjectUrl(bytes, result.artifact.mime) : undefined
    const content = needsUrl ? undefined : new TextDecoder().decode(bytes)
    let released = false
    return Object.freeze({
      artifact: result.artifact,
      kind: input.kind,
      ...(content === undefined ? {} : { content }),
      ...(url === undefined ? {} : { url }),
      release: () => {
        if (released) return
        released = true
        if (url !== undefined) {
          this.objectUrls.delete(url)
          globalThis.URL.revokeObjectURL(url)
        }
      },
    })
  }

  private createObjectUrl(bytes: ArrayBuffer, mime: string): string {
    const createObjectUrl = globalThis.URL?.createObjectURL
    if (!createObjectUrl) throw new Error('document resource URLs are unavailable')
    const url = createObjectUrl(new Blob([bytes], { type: mime }))
    this.objectUrls.add(url)
    return url
  }

  private releaseAll(): void {
    for (const url of this.objectUrls) globalThis.URL.revokeObjectURL(url)
    this.objectUrls.clear()
  }
}

export type ResolvedTheme = 'light' | 'dark'

/** 主题：light/dark 与订阅。宿主把既有 appearance 状态包进来（WC8：不改宿主内部）。 */
export class ThemeService extends Service {
  private resolved: ResolvedTheme
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context, initial: ResolvedTheme) {
    super(ctx, 'theme')
    this.resolved = initial
  }

  get theme(): ResolvedTheme {
    return this.resolved
  }

  /** 仅宿主调用。 */
  setTheme(theme: ResolvedTheme): void {
    if (theme === this.resolved) return
    this.resolved = theme
    for (const listener of [...this.listeners]) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ResolvedTheme => this.resolved
}

/** 多语言字典：`ctx.locale.register`（对齐清单 #8）。键为消息 key，值为已翻译文本。 */
export type LocaleDictionary = Record<string, string>

export class LocaleService extends Service {
  private currentLocale: string
  private readonly dictionaries = new Map<string, LocaleDictionary>()
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context, initial: string) {
    super(ctx, 'locale')
    this.currentLocale = initial
  }

  get locale(): string {
    return this.currentLocale
  }

  /** 注册字典（命名空间 = 包 id）。撤销时自动移除；插件侧经 effect 绑定 fiber。 */
  register(namespace: string, dictionary: LocaleDictionary): () => void {
    // Re-registering a namespace is an update, not a second competing seat.
    // Delete first so the newest revision wins deterministic lookup order.
    this.dictionaries.delete(namespace)
    this.dictionaries.set(namespace, dictionary)
    for (const listener of [...this.listeners]) listener()
    return () => {
      if (this.dictionaries.get(namespace) !== dictionary) return
      this.dictionaries.delete(namespace)
      for (const listener of [...this.listeners]) listener()
    }
  }

  /** 查字典：后注册者覆盖先注册者；找不到回退 key 本身。 */
  t(key: string): string {
    const dictionaries = [...this.dictionaries.values()]
    for (let index = dictionaries.length - 1; index >= 0; index -= 1) {
      const dictionary = dictionaries[index]
      if (!dictionary) continue
      const hit = dictionary[key]
      if (hit !== undefined) return hit
    }
    return key
  }

  /** Bind a namespace for slot entries that declare `locale`. */
  bind(namespace: string): (key: string) => string {
    return (key) => this.dictionaries.get(namespace)?.[key] ?? this.t(key)
  }

  /** 仅宿主调用。 */
  setLocale(locale: string): void {
    if (locale === this.currentLocale) return
    this.currentLocale = locale
    for (const listener of [...this.listeners]) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): string => this.currentLocale
}
