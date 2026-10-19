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
  select(profile: string, id: string | undefined, text: string, preserve = false): string {
    this.memory.set(this.selected, text)
    try {
      this.storage.setItem(this.selected, text)
    } catch {
      /* Private storage may be unavailable. */
    }
    this.selected = this.keyFor(profile, id)
    return preserve ? text : this.read()
  }
}
