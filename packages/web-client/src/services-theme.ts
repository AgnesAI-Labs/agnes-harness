import { type Context, Service } from '@agnes/cordis'
import { notifyListeners } from '@agnes/sdk/browser'

export type ResolvedTheme = 'light' | 'dark'

/** Light/dark theme and subscriptions. The host wraps existing appearance state without changing its internals. */
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

  /** Host-only call. */
  setTheme(theme: ResolvedTheme): void {
    if (theme === this.resolved) return
    this.resolved = theme
    notifyListeners(this.listeners, 'theme')
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ResolvedTheme => this.resolved
}

/** UI locale. Unknown values fall back to English. Keep values aligned with Web preferences. */
