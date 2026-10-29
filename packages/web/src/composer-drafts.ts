/** Only plain local text. A draft never carries session readiness, permissions or attachments. */
export class ComposerDrafts {
  private selected: string
  private readonly memory = new Map<string, string>()
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly origin: string,
  ) {
    this.selected = this.keyFor('')
  }
  get key(): string {
    return this.selected
  }
  private keyFor(profile: string, id?: string): string {
    return `agnes-web-composer-draft:${JSON.stringify([this.origin, 'local', profile, id ?? null])}`
  }
  read(): string {
    if (this.memory.has(this.selected)) return this.memory.get(this.selected) ?? ''
    try {
      return this.storage.getItem(this.selected) ?? ''
    } catch {
      return ''
    }
  }
  /**
   * `preserve` keeps the typed text after a send creates its session. `carry` moves the same text
   * into the newly selected session key: uploading a file opens a session before the user has sent
   * anything, and the draft must survive that switch in the composer and on reload.
   */
  select(
    profile: string,
    id: string | undefined,
    text: string,
    options: { preserve?: boolean; carry?: boolean } = {},
  ): string {
    this.persist(this.selected, text)
    this.selected = this.keyFor(profile, id)
    if (options.carry) {
      this.persist(this.selected, text)
      return text
    }
    return options.preserve ? text : this.read()
  }
  private persist(key: string, text: string): void {
    this.memory.set(key, text)
    try {
      this.storage.setItem(key, text)
    } catch {
      /* Private storage may be unavailable. */
    }
  }
}
