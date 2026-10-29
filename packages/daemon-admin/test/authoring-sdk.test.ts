import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runAuthoringTests } from '../src/packages/authoring-tests.js'

const exec = vi.fn(async (argv: string[]) => {
  const entry = argv.at(-1)
  if (!entry) throw new Error('No compiled test entry')
  const compiled = readFileSync(entry, 'utf8')
  // Real esbuild resolution, with execution intercepted before any child/OS process starts.
  expect(compiled).toContain('createPluginTestHost')
  expect(compiled).toContain('createPluginTestRegistration')
  return { stdout: '# tests 1\n# pass 1\n# fail 0\n# authoring-exit 0\n' }
})
vi.mock('../src/packages/authoring-sandbox.js', () => ({
  defaultAuthoringSandboxContext: () => ({ home: '/synthetic/private-home' }),
  authoringSandbox: async () => ({ sandbox: { exec } }),
}))

it('resolves the public real-Host testkit inside the existing candidate runner allowlist', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agh-sdk-resolution-'))
  const files = [
    { path: 'package.json', content: '{"name":"sdk-check","type":"module"}' },
    {
      path: 'test/sdk.test.mjs',
      content:
        "import React from 'react'; import {createClientPanelTestHost} from '@agnes/web-client/testkit'; import {test} from 'node:test'; import {createPluginTestHost} from '@agnes/host/author-testkit'; test('real registration',async()=>{if(typeof createClientPanelTestHost!=='function'||typeof React.createElement!=='function')throw Error('Browser test SDK missing');const host=await createPluginTestHost({apply(){}});await host.dispose()})",
    },
  ]
  try {
    for (const file of files) {
      const path = join(directory, file.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file.content)
    }
    expect(await runAuthoringTests(directory, files, new AbortController().signal)).toMatchObject({
      state: 'passed',
      count: 1,
    })
    expect(exec).toHaveBeenCalledOnce()
    const privateImport = files.map((file) =>
      file.path.endsWith('.mjs') ? { ...file, content: "import '@agnes/host/src/private.js'" } : file,
    )
    expect(await runAuthoringTests(directory, privateImport, new AbortController().signal)).toMatchObject({
      state: 'failed',
      count: 0,
    })
    expect(exec).toHaveBeenCalledOnce()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
