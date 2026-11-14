// Adapted from dsh-superagent (MIT)
/** Loads packaged built-in skill definitions and prompt templates from disk. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Prompt files read at load time (`prompts/<name>.md`). */
export const PROMPT_FILES = [
  'admission',
  'cli',
  'dispatch',
  'handoff',
  'handoff-orchestrator',
  'handoff-worker',
  'orchestrator',
  'replies',
  'shared',
  'subscriptions',
  'work',
  'worker',
  'team/communication',
  'team/delivery',
  'team/scope',
] as const
/** Source skills read at load time (`skills/dsh-superagent-<name>/SKILL.md`). */
export const SKILL_NAMES = ['feishu', 'github'] as const
/** Interface languages with a `locale/<language>.json` file describing the plugin. */
export const LOCALES = ['en', 'zh'] as const

/** Every packaged file the package reads, relative to its root. */
export function packagedFiles(): string[] {
  return [
    ...PROMPT_FILES.map((name) => `prompts/${name}.md`),
    ...SKILL_NAMES.map((name) => `skills/dsh-superagent-${name}/SKILL.md`),
    ...LOCALES.map((name) => `locale/${name}.json`),
  ]
}

let cached: string | undefined
/**
 * The directory holding the packaged `prompts/`, `skills/` and `locale/` folders: the package directory when run from
 * source, the payload directory next to the bundled entry when installed.
 */
export function packageRoot(): string {
  if (cached) return cached
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    if (['prompts', 'skills', 'locale'].every((name) => existsSync(join(directory, name)))) {
      cached = directory
      return directory
    }
    directory = dirname(directory)
  }
  throw new Error('The packaged prompts, skills and locale folders were not found')
}

/**
 * Reads a packaged text file with normalized Unix line endings.
 * @throws Naming the file when it is missing or whitespace-only, because Superagent cannot load without it.
 */
export function readPackaged(root: string, ...parts: string[]): { path: string; text: string } {
  const path = join(root, ...parts)
  let text: string
  try {
    text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
  } catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? new Error(`Missing packaged file: ${path}`, { cause: error })
      : error
  }
  if (!text.trim()) throw new Error(`Empty packaged file: ${path}`)
  return { path, text }
}
const packaged = (...parts: string[]) => readPackaged(packageRoot(), ...parts)

/** Parses the text of a packaged skill: front matter naming it and describing it, then its content. */
export function parseSkill(path: string, text: string) {
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`Invalid packaged skill: ${path}`)
  return { name: match[1]!, description: match[2]!, content: match[3]!, path }
}
function load(name: (typeof SKILL_NAMES)[number]) {
  const { path, text } = packaged('skills', `dsh-superagent-${name}`, 'SKILL.md')
  return parseSkill(path, text)
}
export const bundledSkills = { feishu: load('feishu'), github: load('github') }
/**
 * Loads a built-in prompt file (`prompts/<name>.md`). Source `.md` files are written one sentence per line for
 * readable diffs; `promptFile` joins lines within each paragraph with spaces while keeping blank-line paragraph breaks.
 */
export function promptFile(name: string): string {
  const paragraphs = packaged('prompts', `${name}.md`)
    .text.trim()
    .split(/\n(?:[ \t]*\n)+/)
  return paragraphs
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.trim())
        .join(' '),
    )
    .join('\n')
}
