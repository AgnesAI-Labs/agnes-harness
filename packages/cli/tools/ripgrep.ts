import { copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Preserve the pinned executable and both upstream license notices in every delivery. */
export async function copyRipgrep(outputDirectory: string): Promise<void> {
  const base = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'base', 'package.json')
  const require = createRequire(base)
  const wrapper = require.resolve('@vscode/ripgrep')
  const dependency = createRequire(wrapper)
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg' // guards-allow-platform: target native executable
  const executable = dependency.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${binary}`) // guards-allow-platform: target native dependency
  const destination = join(outputDirectory, 'ripgrep')
  await mkdir(destination, { recursive: true })
  await copyFile(executable, join(destination, binary))
  await copyFile(join(dirname(executable), '..', 'LICENSE'), join(destination, 'LICENSE'))
  await copyFile(join(dirname(wrapper), '..', 'LICENSE'), join(destination, 'WRAPPER-LICENSE'))
}
