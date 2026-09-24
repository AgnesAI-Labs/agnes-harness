#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createWebServer, DEFAULT_WEB_PORT } from './serve.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const wsInput = argument('--ws')
  if (!wsInput) throw new Error('usage: agnes-web --ws ws://127.0.0.1:PORT [--port 4177] [--root DIR]')
  const root = argument('--root') ?? fileURLToPath(new URL('../dist/web/', import.meta.url))
  const requestedPort = Number(argument('--port') ?? DEFAULT_WEB_PORT)
  const web = await createWebServer({ root, wsUrl: wsInput, port: requestedPort })
  console.log(`Agnes Web: ${web.url}/`)
  const stop = () => {
    void web.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return pathToFileURL(entry).href === moduleUrl
  }
}

if (isMainModule(import.meta.url))
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
