import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ClientModule } from '@agnes/web-client'
import { afterAll } from 'vitest'

const directories: string[] = []
afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
})

/** Load the shipped bytes where the test host can resolve the browser import-map peers (React, UI, etc.). */
export async function bundledPresentation(feature: 'conversation' | 'navigation'): Promise<ClientModule> {
  const directory = await mkdtemp(resolve(__dirname, '../.bundled-ui-test-'))
  directories.push(directory)
  const entry = join(directory, 'client.js')
  await copyFile(
    resolve(__dirname, `../../../package-manager/bundled-plugins/${feature}-ui/src/client.js`),
    entry,
  )
  return import(pathToFileURL(entry).href)
}
