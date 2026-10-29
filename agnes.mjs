#!/usr/bin/env node
import { spawn } from 'node:child_process'
// Repository entry delegates to the exact packaged CLI, including signal and exit semantics.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./packages/cli/dist/local/agnes.mjs', import.meta.url))
if (!existsSync(entry)) {
  process.stderr.write(
    process.env.AGNES_LOCALE === 'zh-CN'
      ? '请先运行 pnpm install --frozen-lockfile 和 pnpm --filter @agnes/cli build:local，然后重试。\n'
      : 'Run pnpm install --frozen-lockfile and pnpm --filter @agnes/cli build:local first, then retry.\n',
  )
  process.exitCode = 1
} else {
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit' })
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  child.once('error', () => {
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)
  })
}
