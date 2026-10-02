import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webUiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tailwindPackage = require.resolve('@tailwindcss/cli/package.json')
const tailwindCli = join(dirname(tailwindPackage), 'dist', 'index.mjs')
const tailwindInput = join(webUiRoot, 'src', 'conversation', 'tailwind.css')

export function buildConversationCss(outputPath: string): void {
  execFileSync(process.execPath, [tailwindCli, '-i', tailwindInput, '-o', outputPath, '--minify'], {
    cwd: webUiRoot,
    stdio: 'pipe',
  })
}
