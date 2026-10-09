import type { FactChainParams } from '@agnes/protocol'

/** Presentation navigation only; opening a link never grants backend access. */
export class RegistrableLink<T> {
  #opener: ((target: T) => boolean) | undefined
  register(opener: (target: T) => boolean): () => void {
    this.#opener = opener
    return () => {
      if (this.#opener === opener) this.#opener = undefined
    }
  }
  open(target: T): boolean {
    return this.#opener?.(target) ?? false
  }
}
/** WB file review supplies an existing ledger anchor, never a guessed path-to-artifact mapping. */
export const factChainLinks = new RegistrableLink<FactChainParams>()
export const workbenchNavigation = new RegistrableLink<string>()
