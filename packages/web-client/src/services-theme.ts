import { type Context, Service } from '@agnes/cordis'

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

/** 界面语言。未知值回落英文。与 Web 偏好模块保持同一组取值。 */
