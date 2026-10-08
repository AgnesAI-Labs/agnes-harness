import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { candidateTemplate } from '@agnes/base/plugin-creator'
import { expect, it } from 'vitest'
import { runAuthoringTests } from '../src/packages/authoring-tests.js'

it.each(['tool', 'tool-with-panel', 'mcp-skills', 'model-adapter', 'loop', 'skill'])(
  'runs real Node contract tests against the %s candidate with the public author SDK',
  async (template) => {
    const directory = mkdtempSync(join(tmpdir(), 'agh-author-test-'))
    try {
      const files = candidateTemplate(template, 'review-demo')
      writeFiles(directory, files)
      const result = await runAuthoringTests(directory, files, new AbortController().signal)
      expect(result, result.output).toMatchObject({ state: 'passed', runner: 'node-test' })
      expect(result.count).toBeGreaterThan(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
  60_000,
)
it('does not accept missing or failing tests, lifecycle success claims or private SDK imports', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agh-author-test-'))
  try {
    const files = [
      { path: 'package.json', content: '{"name":"test","scripts":{"test":"echo pass"}}' },
      {
        path: 'test/fail.test.mjs',
        content: 'import {test} from "node:test";test("fails",()=>{throw new Error("fixture failure")})',
      },
    ]
    writeFiles(directory, files)
    expect(await runAuthoringTests(directory, [], new AbortController().signal)).toMatchObject({
      state: 'failed',
      count: 0,
    })
    expect(await runAuthoringTests(directory, files, new AbortController().signal)).toMatchObject({
      state: 'failed',
    })
    const blocked = files.map((f) =>
      f.path.endsWith('.mjs') ? { ...f, content: 'import "@agnes/host";' } : f,
    )
    expect(await runAuthoringTests(directory, blocked, new AbortController().signal)).toMatchObject({
      state: 'failed',
      count: 0,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)

function writeFiles(directory: string, files: readonly { path: string; content: string }[]) {
  for (const file of files) {
    const path = join(directory, file.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.content)
  }
}
