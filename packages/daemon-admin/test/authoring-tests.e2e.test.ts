import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { candidateTemplate } from '@agnes/base/plugin-creator'
import { expect, it } from 'vitest'
import { runAuthoringTests } from '../src/packages/authoring-tests.js'

it.each(['tool', 'tool-with-panel', 'mcp-skills', 'model-adapter', 'loop', 'skill', 'bounded-tool'])(
  'runs real Node contract tests against the %s candidate with the public author SDK',
  async (template) => {
    const directory = mkdtempSync(join(tmpdir(), 'agh-author-test-'))
    try {
      let files: { path: string; content: string }[]
      if (template === 'bounded-tool') {
        const { pluginHelper } = await import(
          new URL('../../package-manager/bundled-plugins/plugin-helper/index.mjs', import.meta.url).href
        )
        const tools: { name: string; execute(args: unknown): Promise<{ content: { text: string }[] }> }[] = []
        pluginHelper.apply({
          tools: { register: (tool: (typeof tools)[number]) => tools.push(tool) },
        })
        const guide = tools.find((tool) => tool.name === 'plugin_helper_guide')
        if (!guide) throw new Error('guide missing')
        const result = (await guide.execute({ kind: 'tool' })).content[0]
        if (!result) throw new Error('guide content missing')
        files = JSON.parse(result.text).files
      } else files = candidateTemplate(template, 'review-demo')
      const authorTests = files
        .filter((file) => /\.test\.mjs$/.test(file.path))
        .map((file) => file.content)
        .join('\n')
      if (template !== 'skill') expect(authorTests).toContain('@agnes/host/author-testkit')
      expect(authorTests).not.toMatch(/@agnes\/(?:plugin-runtime|host)\/testkit/)
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
