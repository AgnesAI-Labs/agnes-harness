import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { candidateTemplate } from '@agnes/base/plugin-creator'
import { expect, it } from 'vitest'
import { createAuthoringTestRunner, runAuthoringTests } from '../src/packages/authoring-tests.js'

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
  const directory = mkdtempSync(join(tmpdir(), 'agh-author-test-中文 #%-'))
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
      output: expect.stringMatching(/location: ['"]?\.\/test\/fail\.test\.mjs:\d+:\d+/),
    })
    const blocked = files.map((f) =>
      f.path.endsWith('.mjs') ? { ...f, content: 'import "@agnes/host";' } : f,
    )
    expect(await runAuthoringTests(directory, blocked, new AbortController().signal)).toMatchObject({
      state: 'failed',
      count: 0,
    })
    const skill = candidateTemplate('skill', 'review-demo')
    const malformed = skill.map((file) =>
      file.path.endsWith('/SKILL.md')
        ? {
            ...file,
            content: '---\nname: demo\ndescription: valid\ndisable-model-invocation: definitely\n---\nbody',
          }
        : file,
    )
    expect(await runAuthoringTests(directory, malformed, new AbortController().signal)).toMatchObject({
      state: 'failed',
      count: 0,
      output: expect.stringContaining('Static Skill metadata'),
    })
    const document = skill.find((file) => file.path.endsWith('/SKILL.md'))
    if (!document) throw new Error('missing Skill document')
    const skillDir = dirname(document.path)
    const oversized = [
      ...skill,
      ...Array.from({ length: 33 }, (_, i) => ({
        path: `${skillDir}/references/${i}.md`,
        content: `attachment ${i}`,
      })),
    ]
    writeFiles(directory, oversized)
    expect(await runAuthoringTests(directory, oversized, new AbortController().signal)).toMatchObject({
      state: 'failed',
      count: 0,
      output: expect.stringContaining('attachment count, size or traversal budget exceeded'),
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

it('candidate tests cannot read or write protected paths or the private home, including in full-access isolation', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-candidate-boundary-')))
  const directory = join(root, 'candidate'),
    home = join(root, 'private-home'),
    workspace = join(root, 'workspace')
  const paths = [
    join(home, 'auth/marker.json'),
    join(workspace, '.git/config'),
    join(workspace, '.agh/secrets/marker.json'),
  ]
  try {
    for (const path of paths) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'synthetic private marker')
    }
    const files = [
      { path: 'package.json', content: '{"name":"boundary-probe","type":"module"}' },
      {
        path: 'test/boundary.test.mjs',
        content: `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync,writeFileSync} from 'node:fs'; for (const path of ${JSON.stringify(paths)}) test('protected read/write',()=>{assert.throws(()=>readFileSync(path));assert.throws(()=>writeFileSync(path,'changed'))});`,
      },
    ]
    writeFiles(directory, files)
    for (const network of ['deny', 'allow'] as const) {
      const runner = createAuthoringTestRunner({
        home,
        session: {
          local: true,
          network,
          policy: {
            workspaceRoot: workspace,
            rules: paths
              .slice(1)
              .map((path) => ({ path, effect: 'deny', hard: true, source: 'host-integrity' })),
            networkAllow: [],
            digest: 'a'.repeat(64),
          },
        },
      })
      const result = await runner(directory, files, new AbortController().signal)
      expect(result, result.output).toMatchObject({ state: 'passed', count: 3 })
      for (const path of paths) expect(readFileSync(path, 'utf8')).toBe('synthetic private marker')
      const attack = files.map((file) =>
        file.path.endsWith('.mjs')
          ? { ...file, content: `import marker from ${JSON.stringify(paths[0])}; console.log(marker);` }
          : file,
      )
      expect(await runner(directory, attack, new AbortController().signal)).toMatchObject({
        state: 'failed',
        count: 0,
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
