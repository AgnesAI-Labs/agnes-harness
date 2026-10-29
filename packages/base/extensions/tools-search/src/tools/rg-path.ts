import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

declare const AGNES_BUNDLED_RIPGREP_PATH: string | undefined

/** Source installs resolve the pinned platform dependency; deliveries use a copied executable. */
export function ripgrepPath(): string {
  if (typeof AGNES_BUNDLED_RIPGREP_PATH !== 'undefined')
    return resolve(dirname(fileURLToPath(import.meta.url)), AGNES_BUNDLED_RIPGREP_PATH)
  const require = createRequire(import.meta.url)
  const dependency = createRequire(require.resolve('@vscode/ripgrep'))
  return dependency.resolve(
    `@vscode/ripgrep-${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`, // guards-allow-platform: resolve the pinned native binary
  )
}
