export type ComposerDraftReferences = Readonly<{
  files: readonly Readonly<{ path: string; name: string; directory: boolean }>[]
  skills: readonly Readonly<{
    name: string
    description?: string
    source?: Readonly<{ scope: string; rootKey: string }>
    priority?: number
  }>[]
}>

const EMPTY_REFERENCES: ComposerDraftReferences = { files: [], skills: [] }

function referencesKey(key: string): string {
  return `${key}:references`
}

function readReferences(value: string | null): ComposerDraftReferences {
  if (!value) return EMPTY_REFERENCES
  try {
    const parsed = JSON.parse(value) as Partial<ComposerDraftReferences>
    const files = Array.isArray(parsed.files)
      ? parsed.files.filter(
          (file): file is ComposerDraftReferences['files'][number] =>
            Boolean(file) &&
            typeof file.path === 'string' &&
            typeof file.name === 'string' &&
            typeof file.directory === 'boolean',
        )
      : []
    const skills = Array.isArray(parsed.skills)
      ? parsed.skills.filter(
          (skill): skill is ComposerDraftReferences['skills'][number] =>
            Boolean(skill) && typeof skill.name === 'string',
        )
      : []
    return { files, skills }
  } catch {
    return EMPTY_REFERENCES
  }
}

/** Local draft text plus the minimal locators needed to restore its inline references. */
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
  /** Reads only local file paths and skill metadata; never file content or authorization state. */
  readReferences(): ComposerDraftReferences {
    const key = referencesKey(this.selected)
    if (this.memory.has(key)) return readReferences(this.memory.get(key) ?? null)
    try {
      return readReferences(this.storage.getItem(key))
    } catch {
      return EMPTY_REFERENCES
    }
  }
  /** Stores reference locators separately so ordinary drafts remain plain text. */
  setReferences(references: ComposerDraftReferences): void {
    this.persist(referencesKey(this.selected), JSON.stringify(references))
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
  /**
   * `select` for the composer: the outgoing draft's references are kept under its own key, `carry`
   * takes them along with the text, and the result is the draft and references to show next.
   */
  selectWithReferences(
    profile: string,
    id: string | undefined,
    current: Readonly<{ text: string; references: ComposerDraftReferences }>,
    options: { preserve?: boolean; carry?: boolean } = {},
  ): { text: string; references: ComposerDraftReferences } {
    this.setReferences(current.references)
    const text = this.select(profile, id, current.text, options)
    if (options.carry) this.setReferences(current.references)
    // A lone `@` only opens the reference picker; it is not meaningful draft content to carry into
    // a later new session when the picker was dismissed before any reference was selected.
    if (text === '@') {
      this.clear()
      this.setReferences(EMPTY_REFERENCES)
    }
    return { text: text === '@' ? '' : text, references: this.readReferences() }
  }
  /** Replace the currently selected draft without changing which session it belongs to. */
  clear(): void {
    this.persist(this.selected, '')
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

/** The part of the composer a draft switch reads and restores. */
export type DraftComposer = Readonly<{
  getDraft(): string
  getDraftReferences(): ComposerDraftReferences
  setDraft(text: string): void
  clearImageBlocks(): void
  restoreDraftReferences(references: ComposerDraftReferences): void
}>

/** Show another session's saved draft and its inline references in the composer. */
export function switchComposerDraft(
  drafts: ComposerDrafts,
  composer: DraftComposer,
  profile: string,
  id: string | undefined,
  options: { preserve?: boolean; carry?: boolean } = {},
): void {
  const current = { text: composer.getDraft(), references: composer.getDraftReferences() }
  const next = drafts.selectWithReferences(profile, id, current, options)
  composer.setDraft(next.text)
  if (!options.preserve) composer.clearImageBlocks()
  composer.restoreDraftReferences(next.references)
}
