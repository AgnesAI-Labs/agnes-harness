import type {
  DingtalkGateway,
  DingtalkHandlers,
  DingtalkTarget,
  RawCardCallback,
  RawDept,
  RawRobotMessage,
  RawUser,
} from './gateway.js'

export type FakeDingtalkSend =
  | {
      kind: 'markdown'
      target: DingtalkTarget
      payload: { title: string; markdown: string }
    }
  | {
      kind: 'card'
      outTrackId: string
      target: DingtalkTarget
      payload: Record<string, unknown>
    }
  | {
      kind: 'cardUpdate'
      outTrackId: string
      payload: Record<string, unknown>
    }

export class FakeDingtalkGateway implements DingtalkGateway {
  started = false
  botUserId = 'bot-1'
  readonly sent: FakeDingtalkSend[] = []
  departments: RawDept[] = []
  readonly users = new Map<number, RawUser[]>()
  readonly downloads = new Map<string, { bytes: Uint8Array; mime: string } | { url: string }>()
  private handlers: DingtalkHandlers | undefined
  private signal: AbortSignal | undefined
  private markdownSequence = 0

  async start(handlers: DingtalkHandlers, signal: AbortSignal): Promise<{ botUserId: string }> {
    this.reset()
    if (!signal.aborted) {
      this.handlers = handlers
      this.signal = signal
      this.started = true
      signal.addEventListener('abort', this.reset, { once: true })
    }
    return { botUserId: this.botUserId }
  }

  async stop(): Promise<void> {
    this.reset()
  }

  emitMessage(message: RawRobotMessage): void {
    this.handlers?.onMessage(message)
  }

  emitCard(callback: RawCardCallback): void {
    this.handlers?.onCard(callback)
  }

  emitDisconnect(error: Error): void {
    this.handlers?.onDisconnect(error)
  }

  async sendMarkdown(
    target: DingtalkTarget,
    title: string,
    markdown: string,
  ): Promise<{ processQueryKey: string }> {
    this.sent.push({ kind: 'markdown', target, payload: { title, markdown } })
    return { processQueryKey: `pq${++this.markdownSequence}` }
  }

  async createCard(
    outTrackId: string,
    cardData: Record<string, unknown>,
    target: DingtalkTarget,
  ): Promise<void> {
    this.sent.push({ kind: 'card', outTrackId, target, payload: cardData })
  }

  async updateCard(outTrackId: string, cardData: Record<string, unknown>): Promise<void> {
    this.sent.push({ kind: 'cardUpdate', outTrackId, payload: cardData })
  }

  async download(
    downloadCode: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; mime: string } | { url: string }> {
    const download = this.downloads.get(downloadCode)
    if (download === undefined) throw new Error(`no download ${downloadCode}`)
    if ('bytes' in download && download.bytes.length > maxBytes) {
      return { url: `https://dl.example/${encodeURIComponent(downloadCode)}` }
    }
    return download
  }

  async listDepartments(parentId = 1): Promise<RawDept[]> {
    return this.departments.filter((department) => (department.parent_id ?? 1) === parentId)
  }

  async listUsers(deptId: number, cursor = 0): Promise<{ users: RawUser[]; nextCursor?: number }> {
    const all = this.users.get(deptId) ?? []
    const users = all.slice(cursor, cursor + 2)
    const nextCursor = cursor + users.length < all.length ? cursor + users.length : undefined
    return { users, ...(nextCursor === undefined ? {} : { nextCursor }) }
  }

  private readonly reset = (): void => {
    this.signal?.removeEventListener('abort', this.reset)
    this.signal = undefined
    this.handlers = undefined
    this.started = false
  }
}
