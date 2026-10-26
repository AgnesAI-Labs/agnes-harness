import type {
  ConfigModel,
  ConfigProvider,
  ConfigSaveInput,
  ConfigSnapshot,
  ConfigTestInput,
  ConfigTestResult,
} from '@agnes/protocol'
import { publicErrorCode } from '@agnes/protocol'
import { type Component, CURSOR_MARKER, escapeControl, wrapText } from '../component.js'
import { type Box, dialogBox } from '../components/box.js'
import { FilterSelect } from '../components/filter-select.js'
import { fitLine } from '../components/line.js'
import { formatTuiErrorNotice } from '../error-notice.js'
import { tt } from '../locale-extended.js'
import type { ThemedAnsi } from '../theme.js'
import { SecretInputView } from './secret-input.js'

/** The slice of the daemon's `config.*` surface the dialog calls; tests stand in for it. */
export type ProviderPort = {
  test(input: ConfigTestInput): Promise<ConfigTestResult>
  save(input: ConfigSaveInput): Promise<ConfigSnapshot>
  /** After a save: does the running daemon already offer this model to new sessions? */
  published(saved: ConfigSnapshot, providerId: string, model: string): Promise<boolean>
}

export type ProviderSetupInit = {
  providers: readonly ConfigProvider[]
  /** Provider ids that already have an account. */
  configured: ReadonlySet<string>
  revision: number
  port: ProviderPort
}

type Hint = { key: string; label: string }

/**
 * `/provider`: provider -> API key -> test -> default model -> save, in one transient dialog. The key lives
 * in `#key` from the moment it is submitted until the dialog ends (saved, failed out of, or Esc); it is never
 * handed to anything but the injected port.
 */
export class ProviderSetup implements Component {
  #box: Box | undefined
  #init: ProviderSetupInit | undefined
  #provider: ConfigProvider | undefined
  #models: readonly ConfigModel[] = []
  #key = ''
  /** Bumped by every step change and by close, so an answer that arrives late is dropped. */
  #turn = 0

  constructor(
    private readonly o: {
      ansi: ThemedAnsi
      locale: string
      maxRows(): number
      notice(text: string | undefined): void
      changed(): void
    },
  ) {}

  get open(): boolean {
    return this.#box !== undefined
  }

  show(init: ProviderSetupInit): void {
    this.#init = init
    this.#pickProvider()
  }

  close(): void {
    this.#turn++
    this.#key = ''
    this.#init = undefined
    this.#provider = undefined
    this.#models = []
    if (this.#box) {
      this.#box = undefined
      this.o.changed()
    }
  }

  invalidate(): void {
    this.#box?.invalidate()
  }

  handleInput(data: string): boolean {
    if (!this.#box) return false
    this.#box.handleInput(data)
    return true
  }

  render(width: number): string[] {
    return this.#box?.render(width) ?? []
  }

  #t(key: Parameters<typeof tt>[0], vars?: Record<string, string | number>): string {
    return tt(key, this.o.locale, vars)
  }

  /** Draws one step: an optional note above the child, the key hints below. */
  #frame(title: string, child: Component, hints: readonly Hint[], note?: string): void {
    const { ansi } = this.o
    const stacked: Component = {
      invalidate: () => child.invalidate(),
      handleInput: (data) => child.handleInput?.(data) ?? false,
      render: (width) => [
        ...(note
          ? wrapText(escapeControl(note), width).map((l) => fitLine(ansi.fg('warning', l), width))
          : []),
        // The secret input marks its cursor for a host that places the terminal cursor; a dialog has none.
        ...child.render(width).map((line) => line.replaceAll(CURSOR_MARKER, '')),
      ],
    }
    this.#box = dialogBox(stacked, { title, ansi, hints })
    this.o.notice(undefined)
    this.o.changed()
  }

  #hints(out: 'dialog.close' | 'dialog.back', pick = true): Hint[] {
    return [
      ...(pick ? [{ key: '↑↓', label: this.#t('dialog.select') }] : []),
      { key: '⏎', label: this.#t('dialog.confirm') },
      { key: 'esc', label: this.#t(out) },
    ]
  }

  /** A step that waits on the daemon: only Esc answers, and it abandons the call. */
  #wait(title: string, text: string): void {
    const wait: Component = {
      invalidate: () => {},
      handleInput: (data) => {
        if (data === '\x1b') this.close()
        return true
      },
      render: (width) => [fitLine(text, width)],
    }
    this.#frame(title, wait, [{ key: 'esc', label: this.#t('dialog.close') }])
  }

  #pickProvider(): void {
    const init = this.#init
    if (!init) return
    this.#turn++
    this.#key = ''
    this.#provider = undefined
    const select = new FilterSelect({
      options: init.providers.map((p) => ({
        id: p.id,
        label: p.label,
        search: p.id,
        ...(init.configured.has(p.id) ? { description: this.#t('provider.configured') } : {}),
      })),
      locale: this.o.locale,
      ansi: this.o.ansi,
      maxRows: () => Math.max(1, this.o.maxRows() - 3),
      onChoose: (id) => {
        this.#provider = init.providers.find((p) => p.id === id)
        if (this.#provider) this.#askKey()
      },
      onCancel: () => this.close(),
    })
    this.#frame(this.#t('provider.title'), select, this.#hints('dialog.close'))
  }

  #askKey(note?: string): void {
    const provider = this.#provider
    if (!provider) return
    this.#turn++
    this.#key = ''
    const input = new SecretInputView({
      locale: this.o.locale,
      label: this.#t('provider.keyLabel'),
      hint: this.#t('provider.keyHint'),
      onSubmit: (secret) => {
        this.#key = secret
        void this.#test()
      },
      onBack: () => this.#pickProvider(),
      onInvalid: (reason) =>
        this.o.notice(this.#t(reason === 'empty' ? 'provider.keyEmpty' : 'provider.keyInvalid')),
    })
    this.#frame(
      this.#t('provider.keyTitle', { provider: provider.label }),
      input,
      this.#hints('dialog.back', false),
      note,
    )
  }

  async #test(): Promise<void> {
    const { port } = this.#init ?? {}
    const provider = this.#provider
    if (!port || !provider) return
    const turn = ++this.#turn
    this.#wait(provider.label, this.#t('provider.testing'))
    let result: ConfigTestResult
    try {
      result = await port.test({ providerId: provider.id, apiKey: this.#key })
    } catch (error) {
      if (turn === this.#turn) this.#askKey(formatTuiErrorNotice(error, this.o.locale))
      return
    }
    if (turn !== this.#turn) return
    if (result.catalogueError) {
      const { reason, status } = result.catalogueError
      return this.#askKey(this.#t(`provider.catalogue.${reason}`, { status: status ?? '' }))
    }
    if (!result.verified) return this.#askKey(this.#t('provider.unverified'))
    if (!result.models.length) {
      this.#pickProvider()
      return this.o.notice(this.#t('provider.noModels'))
    }
    this.#models = result.models
    this.#pickModel()
  }

  #pickModel(note?: string): void {
    const provider = this.#provider
    if (!provider) return
    this.#turn++
    const select = new FilterSelect({
      options: this.#models.map((m) => ({ id: m.id, label: m.id, search: m.name })),
      locale: this.o.locale,
      ansi: this.o.ansi,
      maxRows: () => Math.max(1, this.o.maxRows() - 3 - (note ? 1 : 0)),
      onChoose: (id) => void this.#save(id),
      onCancel: () => this.#pickProvider(),
    })
    this.#frame(
      this.#t('provider.modelTitle', { provider: provider.label }),
      select,
      this.#hints('dialog.back'),
      note,
    )
  }

  async #save(model: string): Promise<void> {
    const init = this.#init
    const provider = this.#provider
    if (!init || !provider) return
    const turn = ++this.#turn
    this.#wait(provider.label, this.#t('provider.saving'))
    const label = escapeControl(provider.label)
    try {
      const saved = await init.port.save({
        providerId: provider.id,
        apiKey: this.#key,
        model,
        expectedRevision: init.revision,
      })
      if (turn !== this.#turn) return
      const vars = { provider: label, model: escapeControl(model) }
      this.close()
      if (saved.effect === 'restart-required') return this.o.notice(this.#t('provider.savedRestart', vars))
      const usable = await init.port.published(saved, provider.id, model).catch(() => false)
      this.o.notice(this.#t(usable ? 'provider.savedUsable' : 'provider.savedNewSessions', vars))
    } catch (error) {
      if (turn !== this.#turn) return
      if (publicErrorCode(error) === 'CONFIG_REVISION_CONFLICT') {
        this.close()
        return this.o.notice(this.#t('provider.conflict'))
      }
      this.#pickModel(formatTuiErrorNotice(error, this.o.locale))
    }
  }
}
