import type { Suite } from '../lib.mjs'

/** The read-heavy suite, built from the generator's tables; the same value on every call. */
export function buildSuite(): Suite & { description: string }
