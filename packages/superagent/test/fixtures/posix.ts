import { describe, it } from 'vitest'

/**
 * Superagent runs on macOS and Linux only, as the original does: its setup refuses Windows. Tests that run POSIX tools
 * (`sh`, shebang scripts made executable with `chmod`, process groups) or start the plugin for real skip on Windows.
 */
export const posixIt: ReturnType<typeof it.skipIf> = it.skipIf(process.platform === 'win32')
export const posixDescribe: ReturnType<typeof describe.skipIf> = describe.skipIf(process.platform === 'win32')
