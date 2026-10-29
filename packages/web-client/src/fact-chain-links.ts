import type { FactChainParams } from '@agnes/protocol'

/** Presentation navigation only; opening a link never grants backend access. */
export class RegistrableLink<T> {
  #opener: ((target: T, selection?: unknown) => boolean) | undefined
  register(opener: (target: T, selection?: unknown) => boolean): () => void {
    this.#opener = opener
    return () => {
      if (this.#opener === opener) this.#opener = undefined
    }
  }
  /**
   * `selection` is presentation the destination applies while opening, such as the dock panel tab
   * to show. An opener with nothing to apply simply ignores the argument.
   */
  open(target: T, selection?: unknown): boolean {
    return this.#opener?.(target, selection) ?? false
  }
}
/** WB file review supplies an existing ledger anchor, never a guessed path-to-artifact mapping. */
export const factChainLinks = new RegistrableLink<FactChainParams>()
export const workbenchNavigation = new RegistrableLink<string>()
