type Owner = { token: symbol; retire: (reason: string) => Promise<void> }

/**
 * Which mounted row currently owns an extension row id. The kernel tables are shared by the live
 * tree and every candidate tree, and a candidate is built before the previous tree is retired, so a
 * row that mounts must evict a same-id incumbent itself and a retiring row must not evict a newer
 * owner. Eviction is synchronous in effect (registrations are gone before `claim` returns); only the
 * incumbent's wind-down is left running.
 */
export class ExtensionOwners {
  readonly #owners = new Map<string, Owner>()
  readonly #winding = new Set<Promise<void>>()

  /** Takes over `rowId`, retiring the previous owner. Returns the token `release` later needs. */
  claim(rowId: string, retire: (reason: string) => Promise<void>): symbol {
    return this.#take(rowId, retire).token
  }

  /** Dynamic rows wait for their own previous generation's cleanup before opening a replacement. */
  async claimAndSettle(rowId: string, retire: (reason: string) => Promise<void>): Promise<symbol> {
    const claimed = this.#take(rowId, retire)
    await claimed.previous
    return claimed.token
  }

  #take(rowId: string, retire: (reason: string) => Promise<void>) {
    const previous = this.#owners.get(rowId)
    const token = Symbol(rowId)
    this.#owners.set(rowId, { token, retire })
    const wind = previous?.retire('evicted')
    if (wind) this.#track(wind)
    return { token, previous: wind }
  }

  /** Retires the row unless a newer owner already took the id over. */
  async release(rowId: string, token: symbol, reason: string): Promise<void> {
    const current = this.#owners.get(rowId)
    if (current?.token !== token) return
    this.#owners.delete(rowId)
    await current.retire(reason)
  }

  /** True while some row owns `rowId`. */
  has(rowId: string): boolean {
    return this.#owners.has(rowId)
  }

  /** Resolves once every eviction started so far has finished winding down. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#winding])
  }

  #track(wind: Promise<void>): void {
    const tracked = wind.catch(() => undefined).finally(() => this.#winding.delete(tracked))
    this.#winding.add(tracked)
  }
}
