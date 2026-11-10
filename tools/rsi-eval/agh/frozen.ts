// The frozen arm's source: what a finished `on` run saved, read from its output folder. That is its saved
// memory paragraphs (the managed paragraphs refinement wrote into each workspace's `MEMORY.md`), its saved
// user memory sections, and the skills installed in its workspaces. Nothing else: not the notes the agent
// wrote into memory by itself, which an `off` run writes as well, and not the work it left in the files.
//
// The paragraphs are seeded as text: a managed paragraph is shown to the agent only while the host's
// registry vouches for it, and the frozen run's registry has no record of another run's saves. Written as
// hand-written memory, the same text is what the agent reads.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGH_DIR } from '../../../packages/protocol/src/constants.js'
import { runId } from '../prime/run-prime.js'
import { taskFixtures, workspaceName } from '../suite.js'
import type { EvalTask, FrozenSeed, RunOutcome } from '../types.js'

const PACKAGES = join(import.meta.dirname, '..', '..', '..', 'packages')
const MEMORY_INDEX = 'MEMORY.md'

/** The parts of the file memory provider this file uses: its layout and its own paragraph parser. */
export type FrozenMemoryModule = {
  fileMemoryRoots(home: string, workspace: string): { root: string; userRoot: string }
  parseParagraphs(text: string): { paragraphs: readonly { id: string; text: string }[] }
}

export const loadFrozenMemoryModule = async (): Promise<FrozenMemoryModule> => {
  const [index, paragraphs] = await Promise.all([
    import(pathToFileURL(join(PACKAGES, 'memory-file', 'src', 'index.ts')).href),
    import(pathToFileURL(join(PACKAGES, 'memory-file', 'src', 'paragraphs.ts')).href),
  ])
  return {
    ...(index as Pick<FrozenMemoryModule, 'fileMemoryRoots'>),
    ...(paragraphs as Pick<FrozenMemoryModule, 'parseParagraphs'>),
  }
}

export type FrozenSource = {
  runId: string
  /** Per fixture: the saved paragraphs' text, and the folders of the saved skills. */
  workspaces: Map<string, { paragraphs: string[]; skillDirs: string[] }>
  userSections: string[]
}

const savedParagraphs = (file: string, memory: FrozenMemoryModule): string[] =>
  existsSync(file)
    ? memory
        .parseParagraphs(readFileSync(file, 'utf8'))
        .paragraphs.map((p) => p.text.trim())
        .filter((text) => text !== '')
    : []

/**
 * Reads what the `on` run of `task` and `rep` in `fromDir` saved. Refuses a source that is missing, is not
 * an `on` run, was ended by the infrastructure (it is to be redone), or cannot be matched to the task's
 * workspaces.
 */
export function readFrozenSource(
  fromDir: string,
  task: EvalTask,
  rep: number,
  memory: FrozenMemoryModule,
): FrozenSource {
  const id = runId(task.id, 'on', rep)
  const dir = join(fromDir, id)
  const file = join(dir, 'outcome.json')
  if (!existsSync(file))
    throw new Error(
      `the frozen arm needs the on run ${id} in ${fromDir}, and it is not there (no outcome.json)`,
    )
  const outcome = JSON.parse(readFileSync(file, 'utf8')) as RunOutcome
  if (outcome.runId !== id || !/\.on\.r\d+$/.test(outcome.runId))
    throw new Error(`the frozen arm's source ${dir} is not an on run (${outcome.runId})`)
  if (outcome.infraFailed)
    throw new Error(
      `the frozen arm's source ${id} was ended by the upstream (${outcome.infraFailed.reason}); redo it first`,
    )
  // A blocked run stopped part-way: what it saved is a partial lesson, not what the on arm learns.
  if (outcome.blocked)
    throw new Error(
      `the frozen arm's source ${id} was blocked by the host's verifier (${outcome.blocked.reasons.join(', ')}, session ${outcome.blocked.session + 1}); it saved only part of a run`,
    )
  const home = join(dir, 'home')
  const fixtures = taskFixtures(task)
  const memoryDirs = existsSync(join(home, 'memory', 'workspaces'))
    ? readdirSync(join(home, 'memory', 'workspaces'))
    : []
  const workspaces = new Map<string, { paragraphs: string[]; skillDirs: string[] }>()
  for (const fixture of fixtures) {
    const path = outcome.workspaces?.[fixture]
    let root: string | undefined
    if (path !== undefined) root = memory.fileMemoryRoots(home, path).root
    else if (fixtures.length === 1 && memoryDirs.length <= 1)
      // Recorded before the runner kept the workspace paths: one workspace, at most one memory folder.
      root = memoryDirs[0] === undefined ? undefined : join(home, 'memory', 'workspaces', memoryDirs[0])
    else
      throw new Error(
        `the frozen arm's source ${id} does not record which memory folder is the workspace of ${fixture}; it predates recorded workspace paths`,
      )
    const skillsDir = join(dir, workspaceName(fixture), AGH_DIR, 'skills')
    const skillDirs = existsSync(skillsDir)
      ? readdirSync(skillsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
          .map((entry) => join(skillsDir, entry.name))
          .sort()
      : []
    workspaces.set(fixture, {
      paragraphs: root === undefined ? [] : savedParagraphs(join(root, MEMORY_INDEX), memory),
      skillDirs,
    })
  }
  const userRoot = memory.fileMemoryRoots(home, outcome.workspaces?.[fixtures[0] ?? ''] ?? dir).userRoot
  return { runId: id, workspaces, userSections: savedParagraphs(join(userRoot, MEMORY_INDEX), memory) }
}

/** Copies the source's skills into the frozen run's workspaces, before its host starts. */
export function copyFrozenSkills(
  source: FrozenSource,
  workOf: (fixture: string) => string,
): Record<string, string[]> {
  const copied: Record<string, string[]> = {}
  for (const [fixture, { skillDirs }] of source.workspaces) {
    const target = join(workOf(fixture), AGH_DIR, 'skills')
    copied[fixture] = []
    for (const skill of skillDirs) {
      const name = basename(skill)
      mkdirSync(target, { recursive: true })
      cpSync(skill, join(target, name), { recursive: true })
      copied[fixture]?.push(name)
    }
  }
  return copied
}

/** What the frozen run records of its seed. */
export const frozenSeed = (source: FrozenSource, skills: Record<string, string[]>): FrozenSeed => ({
  runId: source.runId,
  paragraphs: Object.fromEntries(
    [...source.workspaces].map(([fixture, w]) => [fixture, w.paragraphs.length]),
  ),
  skills,
  userSections: source.userSections.length,
})
