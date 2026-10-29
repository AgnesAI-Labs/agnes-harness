import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'

const MAX_ENTRIES = 500
// A bigger entry (an expanded paste, say) stays in this run's memory but is not written down: the file
// is read on every start and holds at most MAX_ENTRIES of these.
const MAX_ENTRY_CHARS = 20_000

/** Prompts in the file, oldest first; a missing file or an unreadable line adds nothing. */
function fileTexts(path: string): string[] {
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    // A rewrite from nothing would erase the history, so only a missing file reads as empty.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const texts: string[] = []
  for (const line of raw.split('\n')) {
    try {
      const text = (JSON.parse(line) as { text?: unknown }).text
      if (typeof text === 'string' && text.length <= MAX_ENTRY_CHARS) texts.push(text)
    } catch {}
  }
  return texts
}

/**
 * The prompts the user has sent, newest first, kept across runs in a private JSON-lines file.
 * Memory is the source of truth: a file that cannot be read or written (missing home, bad permissions,
 * a full disk, garbage in it) never stops the TUI from starting or from remembering this run's prompts.
 */
export class PromptHistory {
  /** Newest first. */
  readonly entries: string[] = []
  // Lines in the file, or enough to force a rewrite when its tail cannot be appended to cleanly.
  private lines = 0
  private broken = false

  constructor(private readonly path?: string) {
    if (path) this.load(path)
  }

  /** Records a sent prompt, unless it repeats the one before it. */
  add(text: string): void {
    if (this.entries[0] === text) return
    this.entries.unshift(text)
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES
    this.save(text)
  }

  /** Index of the first entry after `after` that contains `query`, ignoring case; -1 when none does. */
  find(query: string, after = -1): number {
    const needle = query.toLowerCase()
    for (let i = after + 1; i < this.entries.length; i++)
      if ((this.entries[i] as string).toLowerCase().includes(needle)) return i
    return -1
  }

  private load(path: string): void {
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      // A first run has no file yet; anything else means the file cannot be relied on.
      this.broken = (error as NodeJS.ErrnoException).code !== 'ENOENT'
      return
    }
    const oldestFirst: string[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const text = (JSON.parse(line) as { text?: unknown }).text
        if (typeof text === 'string') oldestFirst.push(text)
      } catch {
        this.lines = MAX_ENTRIES
      }
    }
    if (raw && !raw.endsWith('\n')) this.lines = MAX_ENTRIES
    this.lines = Math.max(this.lines, oldestFirst.length)
    this.entries.push(...oldestFirst.slice(-MAX_ENTRIES).reverse())
  }

  private save(added: string): void {
    const path = this.path
    if (!path || this.broken || added.length > MAX_ENTRY_CHARS) return
    const line = (text: string) => `${JSON.stringify({ text })}\n`
    try {
      if (this.lines >= MAX_ENTRIES) {
        // Another agh process may have appended since load: rewrite from what the file holds now, so
        // its prompts survive. This run's memory stays as it is, oversize entries included.
        const merged = [...fileTexts(path), added].slice(-MAX_ENTRIES)
        writeFileSync(path, merged.map(line).join(''), { mode: 0o600 })
        this.lines = merged.length
      } else {
        appendFileSync(path, line(added), { mode: 0o600 })
        this.lines++
      }
      // The mode above applies only to a file this call creates.
      chmodSync(path, 0o600)
    } catch {
      this.broken = true
    }
  }
}

/**
 * Reverse incremental search over the history (Ctrl-R): the query narrows to the newest entry that
 * contains it, and each further Ctrl-R moves to the next older match. It holds the draft the search
 * started from so that leaving without choosing puts it back.
 */
export class HistorySearch {
  query = ''
  private index: number

  constructor(
    private readonly history: PromptHistory,
    readonly draft: { text: string; cursor: number },
  ) {
    this.index = history.find('')
  }

  get hit(): string | undefined {
    return this.history.entries[this.index]
  }

  type(text: string): void {
    this.query += text
    this.index = this.history.find(this.query)
  }

  erase(): void {
    this.query = [...this.query].slice(0, -1).join('')
    this.index = this.history.find(this.query)
  }

  older(): void {
    const next = this.history.find(this.query, this.index)
    if (next >= 0) this.index = next
  }
}
