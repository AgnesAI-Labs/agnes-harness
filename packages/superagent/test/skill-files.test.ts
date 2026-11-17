/** The packaged prompts, skills and locale files the package reads when it loads. */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  bundledSkills,
  LOCALES,
  PROMPT_FILES,
  packagedFiles,
  packageRoot,
  parseSkill,
  promptFile,
  readPackaged,
  SKILL_NAMES,
} from '../src/app/skill-files.js'

let copy: string
beforeEach(() => {
  copy = mkdtempSync(join(tmpdir(), 'packaged-'))
  for (const folder of ['prompts', 'skills', 'locale'])
    cpSync(join(packageRoot(), folder), join(copy, folder), { recursive: true })
})
afterEach(() => {
  rmSync(copy, { recursive: true, force: true })
})

/** The files of the three folders, relative to `root` with `/` between names, as the package declares them everywhere. */
const listed = (root: string): string[] =>
  ['prompts', 'skills', 'locale']
    .flatMap((folder) =>
      readdirSync(join(root, folder), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')),
    )
    .sort()

it('reads every declared packaged file, which is every file of the three folders and nothing else', () => {
  const declared = packagedFiles()
  expect(declared).toHaveLength(PROMPT_FILES.length + SKILL_NAMES.length + LOCALES.length)
  for (const file of declared) expect(readPackaged(packageRoot(), file).text.trim(), file).not.toBe('')
  expect([...declared].sort()).toEqual(listed(packageRoot()))
})

it('loads each prompt file and each bundled skill with its front matter', () => {
  for (const name of PROMPT_FILES) expect(promptFile(name), name).not.toBe('')
  for (const name of SKILL_NAMES) {
    const skill = bundledSkills[name]
    expect(skill.name).toBe(`dsh-superagent-${name}`)
    expect(skill.description).not.toBe('')
    expect(skill.content.trim()).not.toBe('')
  }
})

it('describes the plugin in each language, with the same keys', () => {
  const locales = LOCALES.map((name) =>
    JSON.parse(readFileSync(join(packageRoot(), 'locale', `${name}.json`), 'utf8')),
  )
  for (const locale of locales)
    expect(locale.meta).toEqual({ title: 'Superagent', description: expect.any(String) })
  expect(Object.keys(locales[0].meta)).toEqual(Object.keys(locales[1].meta))
})

it('names the first missing file, whichever folder it was in', () => {
  for (const file of packagedFiles()) {
    const root = mkdtempSync(join(tmpdir(), 'packaged-missing-'))
    try {
      for (const folder of ['prompts', 'skills', 'locale'])
        cpSync(join(copy, folder), join(root, folder), { recursive: true })
      rmSync(join(root, file))
      expect(() => readPackaged(root, file), file).toThrow(`Missing packaged file: ${join(root, file)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

it('refuses an empty packaged file and a skill whose front matter is wrong', () => {
  writeFileSync(join(copy, 'prompts', 'shared.md'), ' \n\t\n')
  expect(() => readPackaged(copy, 'prompts', 'shared.md')).toThrow(
    `Empty packaged file: ${join(copy, 'prompts', 'shared.md')}`,
  )
  expect(() => parseSkill('x/SKILL.md', 'no front matter')).toThrow('Invalid packaged skill: x/SKILL.md')
  expect(parseSkill('x', '---\nname: a\ndescription: b\n---\n\nBody\n')).toEqual({
    name: 'a',
    description: 'b',
    content: 'Body\n',
    path: 'x',
  })
})
