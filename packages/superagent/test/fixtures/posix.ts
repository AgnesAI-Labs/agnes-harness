import { describe, it } from 'vitest'

/**
 * For the few tests that need a POSIX tool Windows has not, such as `ps` or `sleep`; each says which where it is used.
 * Superagent itself runs on macOS, Linux and Windows, and its other tests run on all three.
 */
export const posixIt: ReturnType<typeof it.skipIf> = it.skipIf(process.platform === 'win32')
export const posixDescribe: ReturnType<typeof describe.skipIf> = describe.skipIf(process.platform === 'win32')
