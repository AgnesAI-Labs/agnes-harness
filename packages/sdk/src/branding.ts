export type Branding = Readonly<{ accent: string; mark: string; selfLabel: string }>

/** The single built-in brand used whenever a daemon has no profile-specific override. */
export const DEFAULT_BRANDING: Branding = Object.freeze({
  accent: '#5E57FE',
  mark: 'agnes',
  selfLabel: 'Agnes AI',
})

export type BrandingCacheOptions = {
  refreshMs: number
  retryMs: number
  firstRenderWaitMs: number
}

const DEFAULT_OPTIONS: BrandingCacheOptions = {
  refreshMs: 30_000,
  retryMs: 5_000,
  firstRenderWaitMs: 1_500,
}

/**
 * Small stale-while-revalidate cache for presentation code. A missing server override and a failed
 * refresh both preserve the last known brand, so rendering never depends on control-plane health.
 */
export class BrandingCache {
  private value: Branding = DEFAULT_BRANDING
  private first: Promise<Branding> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private readonly fetcher: () => Promise<Branding | undefined>,
    private readonly opts: BrandingCacheOptions = DEFAULT_OPTIONS,
  ) {}

  current(): Branding {
    return this.value
  }

  async refreshNow(): Promise<Branding> {
    try {
      const branding = await this.fetcher()
      if (!this.stopped && branding !== undefined) this.value = Object.freeze({ ...branding })
      this.schedule(this.opts.refreshMs)
    } catch {
      this.schedule(this.opts.retryMs)
    }
    return this.value
  }

  forRender(): Promise<Branding> {
    this.first ??= this.refreshNow()
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.value), this.opts.firstRenderWaitMs)
      void this.first?.then(() => {
        clearTimeout(timer)
        resolve(this.value)
      })
    })
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.refreshNow(), ms)
  }
}
