import type { UsageView } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import { listSessionChoices } from './commands.js'
import { tt } from './locale-extended.js'
import { WelcomeBanner, welcomeTips } from './views/welcome-banner.js'
import { tildePath, type WorkspaceInfo } from './workspace-info.js'

/** The welcome's own options on the app: what the launcher knows, and what tests and the gallery pin. */
export type WelcomeOptions = {
  version?: string
  /** The output is a TTY, so the welcome may animate (it still needs colour and a non-mono theme). */
  motion?: boolean
  /** Wall clock (ms) and randomness for the greeting, tip and blink. */
  now?: () => number
  random?: () => number
}

/**
 * Keeps the welcome banner informed: facts known at launch, read-only queries after the first
 * frame, projection updates, and the one timer that animates it. The banner itself only draws.
 */
export class WelcomeController {
  readonly banner: WelcomeBanner
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly locale: string

  constructor(
    private readonly app: {
      profile?: string | undefined
      header?: string | undefined
      model?: string | undefined
      session: Session
      cwd?: string | undefined
      welcome?: WelcomeOptions | undefined
    },
    private readonly hooks: Pick<
      ConstructorParameters<typeof WelcomeBanner>[0],
      'branding' | 'ansi' | 'theme' | 'locale'
    > & {
      viewport(): { rows: number; reserved: number }
      /** The app is live, no turn is running and the welcome is what the timeline shows. */
      shows(): boolean
      repaint(): void
    },
  ) {
    const o = app.welcome ?? {}
    this.locale = hooks.locale ?? 'en'
    this.banner = new WelcomeBanner({
      branding: hooks.branding,
      ansi: hooks.ansi,
      theme: hooks.theme,
      ...(hooks.locale ? { locale: hooks.locale } : {}),
      profile: app.profile ?? app.header ?? '',
      ...(app.model ? { model: app.model } : {}),
      viewport: hooks.viewport,
      motion: o.motion === true,
      ...(o.now ? { now: o.now } : {}),
      ...(o.random ? { random: o.random } : {}),
    })
    const tips = welcomeTips(this.locale)
    this.banner.update({
      workspace: { root: tildePath(app.cwd ?? process.cwd()) },
      ...(o.version ? { version: o.version } : {}),
      ...(tips.length > 0 ? { tip: tips[Math.floor((o.random ?? Math.random)() * tips.length)] } : {}),
    })
  }

  /**
   * After the first frame: records the welcome as seen, then fills it from read-only queries (what
   * the session loaded, the last sessions here). Each is independent and a failure only leaves its
   * field out.
   */
  start(): void {
    const { session } = this.app
    const apply = (facts: Parameters<WelcomeBanner['update']>[0]): void => {
      this.banner.update(facts)
      this.hooks.repaint()
    }
    void session.capabilities().then(
      (caps) => {
        if (!caps) return
        const on = (items: readonly { enabled: boolean }[]): number => items.filter((i) => i.enabled).length
        apply({ resources: { plugins: on(caps.plugins), skills: on(caps.skills), mcp: on(caps.mcp) } })
      },
      () => {},
    )
    void listSessionChoices(session, this.app.cwd ?? process.cwd()).then(
      (choices) => {
        const recent = choices
          .filter((c) => c.title)
          .slice(0, 2)
          .map((c) => ({ at: Date.parse(c.createdAt), title: c.title as string }))
          .filter((c) => Number.isFinite(c.at))
        if (recent.length > 0) apply({ recent })
      },
      () => {},
    )
    this.kick()
  }

  /** The projection's view of the session: model, its reasoning and context. */
  projected(usage: UsageView | undefined): void {
    const window = usage?.context.window ?? 0
    const parts = usage
      ? [
          usage.model.thinking !== 'off' &&
            tt('welcome.detailReasoning', this.locale, { level: usage.model.thinking }),
          window > 0 &&
            tt('welcome.detailContext', this.locale, {
              size:
                window >= 1_000_000 ? `${Math.round(window / 1_000_000)}M` : `${Math.round(window / 1024)}K`,
            }),
        ].filter((part): part is string => typeof part === 'string')
      : []
    if (usage) this.banner.setModel(usage.model.id)
    this.banner.update({
      ...(usage ? { modelDetail: parts.length > 0 ? parts.join(' · ') : undefined } : {}),
    })
    this.kick()
  }

  workspace(info: WorkspaceInfo): void {
    const branch = info.branch ?? info.detached
    this.banner.update({
      workspace: {
        root: info.subpath ? `${info.root}/${info.subpath}` : info.root,
        ...(branch ? { branch } : {}),
        ...(info.ahead !== undefined ? { ahead: info.ahead } : {}),
      },
    })
  }

  /**
   * Runs the animation while the welcome is on screen and the session idle; at every other moment
   * it stops and leaves the still picture. One timer, scheduled by the banner; called again
   * whenever the conditions can have changed.
   */
  kick(): void {
    if (this.timer !== undefined) return
    if (!this.banner.animates || !this.hooks.shows()) {
      this.halt()
      return
    }
    const step = (): void => {
      this.timer = undefined
      if (!this.banner.animates || !this.hooks.shows()) {
        this.banner.settle()
        this.hooks.repaint()
        return
      }
      this.banner.start()
      const next = this.banner.tick()
      this.hooks.repaint()
      if (next === undefined) return
      this.timer = setTimeout(step, next)
      this.timer.unref()
    }
    step()
  }

  /** No more frames, eyes open. */
  private halt(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.banner.settle()
  }
}
