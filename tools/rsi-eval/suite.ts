import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Category, EvalTask } from './types.js'

export const defaultTasksDir = join(dirname(fileURLToPath(import.meta.url)), 'tasks')

const categories: readonly Category[] = [
  'directory',
  'command-args',
  'convention',
  'cross-session',
  'cross-workspace',
  'workflow',
]

/** The fixture a session's workspace is copied from when it names none. */
export const DEFAULT_FIXTURE = 'fixture'
const FIXTURE_NAME = /^fixture(-[a-z0-9]+)?$/
/** A cross-workspace lesson has to fit the user memory, which holds about 512 bytes in all. */
const MAX_CROSS_WORKSPACE_NOTE = 256

/** The fixture directory, next to task.json, that a session's workspace is copied from. */
export const sessionFixture = (session: EvalTask['sessions'][number]): string =>
  session.fixture ?? DEFAULT_FIXTURE

/** The fixture of the task's session at `sessionIndex`. */
export const fixtureOf = (task: EvalTask, sessionIndex: number): string => {
  const session = task.sessions[sessionIndex]
  return session ? sessionFixture(session) : DEFAULT_FIXTURE
}

/** Every fixture a task's sessions use, once each, in the order the sessions first use them. */
export const taskFixtures = (task: EvalTask): string[] => [...new Set(task.sessions.map(sessionFixture))]

/**
 * The name a runner gives the workspace made from `fixture`: `work` for the default fixture (as
 * before there were several), `work-b` for `fixture-b`. It is also the directory a run keeps.
 */
export const workspaceName = (fixture: string): string => `work${fixture.slice(DEFAULT_FIXTURE.length)}`

const DEFAULT_MIN_TASKS = 20
const MIN_PER_CATEGORY = 5
const MIN_PROMPTS_PER_SESSION = 3

export type LoadSuiteOptions = {
  /**
   * Minimum number of tasks in the suite. The default of 20 also requires at least 5 tasks per
   * category. Passing a value below 20 is a temporary relaxation while the suite is still being
   * written: it lowers the total floor to that value and drops the per-category floor to 0.
   */
  minTasks?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const expectRecord = (
  value: unknown,
  where: string,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${where}: expected an object`)
  for (const key of Object.keys(value)) {
    if (!keys.includes(key) && !optional.includes(key)) throw new Error(`${where}: unknown key "${key}"`)
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${where}: missing key "${key}"`)
  }
  return value
}

const expectString = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${where}: expected a non-empty string`)
  return value
}

const expectArray = (value: unknown, where: string): unknown[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${where}: expected a non-empty array`)
  return value
}

const parseTask = (raw: unknown, dirName: string): EvalTask => {
  const where = `task ${dirName}`
  const task = expectRecord(raw, where, ['id', 'category', 'description', 'trap', 'sessions'])
  const id = expectString(task.id, `${where}.id`)
  const category = expectString(task.category, `${where}.category`)
  if (!categories.includes(category as Category))
    throw new Error(`${where}.category: unknown category "${category}"`)
  const description = expectString(task.description, `${where}.description`)

  const trapRaw = expectRecord(task.trap, `${where}.trap`, ['signatures', 'reproduce', 'note'])
  const signatures = expectArray(trapRaw.signatures, `${where}.trap.signatures`).map((entry, index) => {
    const signature = expectString(entry, `${where}.trap.signatures[${index}]`)
    try {
      new RegExp(signature)
    } catch {
      throw new Error(`${where}.trap: signature "${signature}" is not a valid regular expression`)
    }
    return signature
  })
  const trap = {
    signatures,
    reproduce: expectString(trapRaw.reproduce, `${where}.trap.reproduce`),
    note: expectString(trapRaw.note, `${where}.trap.note`),
  }

  const sessions = expectArray(task.sessions, `${where}.sessions`).map((entry, sessionIndex) => {
    const sessionWhere = `${where}.sessions[${sessionIndex}]`
    const session = expectRecord(entry, sessionWhere, ['prompts'], ['fixture'])
    const fixture =
      'fixture' in session ? expectString(session.fixture, `${sessionWhere}.fixture`) : undefined
    if (fixture !== undefined && !FIXTURE_NAME.test(fixture))
      throw new Error(`${sessionWhere}: fixture "${fixture}" must match ${FIXTURE_NAME.source}`)
    const prompts = expectArray(session.prompts, `${sessionWhere}.prompts`).map(
      (promptEntry, promptIndex) => {
        const promptWhere = `${sessionWhere}.prompts[${promptIndex}]`
        const prompt = expectRecord(promptEntry, promptWhere, ['text', 'checks', 'solution'])
        return {
          text: expectString(prompt.text, `${promptWhere}.text`),
          checks: expectArray(prompt.checks, `${promptWhere}.checks`).map((checkEntry, checkIndex) => {
            const checkWhere = `${promptWhere}.checks[${checkIndex}]`
            const check = expectRecord(checkEntry, checkWhere, ['command', 'contains'])
            return {
              command: expectString(check.command, `${checkWhere}.command`),
              contains: expectString(check.contains, `${checkWhere}.contains`),
            }
          }),
          solution: expectArray(prompt.solution, `${promptWhere}.solution`).map((command, commandIndex) =>
            expectString(command, `${promptWhere}.solution[${commandIndex}]`),
          ),
        }
      },
    )
    if (prompts.length < MIN_PROMPTS_PER_SESSION) {
      throw new Error(
        `${sessionWhere}: needs at least ${MIN_PROMPTS_PER_SESSION} prompts, got ${prompts.length}`,
      )
    }
    return fixture === undefined ? { prompts } : { prompts, fixture }
  })

  const expectedSessions =
    category === 'cross-session' || category === 'cross-workspace' || category === 'workflow' ? 2 : 1
  if (sessions.length !== expectedSessions) {
    throw new Error(
      `${where}: ${category} tasks need exactly ${expectedSessions} session${expectedSessions === 1 ? '' : 's'}, got ${sessions.length}`,
    )
  }

  const fixtures = sessions.map(sessionFixture)
  if (category === 'cross-workspace') {
    if (fixtures[1] === fixtures[0])
      throw new Error(`${where}: the second session must name a fixture other than "${fixtures[0]}"`)
    if (trap.note.length > MAX_CROSS_WORKSPACE_NOTE)
      throw new Error(
        `${where}.trap.note: a cross-workspace lesson must be at most ${MAX_CROSS_WORKSPACE_NOTE} characters, got ${trap.note.length}`,
      )
  } else if (fixtures.some((fixture) => fixture !== DEFAULT_FIXTURE)) {
    throw new Error(`${where}: only cross-workspace tasks name another fixture than "${DEFAULT_FIXTURE}"`)
  }

  return { id, category: category as Category, description, trap, sessions }
}

/**
 * Loads every `<dir>/<id>/task.json` (with a sibling `fixture/`, and any other fixture its sessions
 * name) and validates the whole suite.
 */
export const loadSuite = (dir: string, opts: LoadSuiteOptions = {}): EvalTask[] => {
  const minTasks = opts.minTasks ?? DEFAULT_MIN_TASKS
  const minPerCategory = minTasks < DEFAULT_MIN_TASKS ? 0 : MIN_PER_CATEGORY

  const dirNames = readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort()
  const tasks: EvalTask[] = []
  const seen = new Set<string>()
  for (const dirName of dirNames) {
    const file = join(dir, dirName, 'task.json')
    if (!existsSync(file)) throw new Error(`task ${dirName}: missing task.json`)
    const task = parseTask(JSON.parse(readFileSync(file, 'utf8')) as unknown, dirName)
    if (seen.has(task.id)) throw new Error(`task ${dirName}: duplicate id "${task.id}"`)
    seen.add(task.id)
    if (task.id !== dirName) throw new Error(`task ${dirName}: id "${task.id}" does not match directory name`)
    for (const name of new Set([DEFAULT_FIXTURE, ...taskFixtures(task)])) {
      const fixture = join(dir, dirName, name)
      if (!existsSync(fixture) || !statSync(fixture).isDirectory())
        throw new Error(`task ${dirName}: missing ${name}/ directory`)
    }
    tasks.push(task)
  }

  if (tasks.length < minTasks) throw new Error(`suite needs at least ${minTasks} tasks, got ${tasks.length}`)
  for (const category of categories) {
    const count = tasks.filter((task) => task.category === category).length
    if (count < minPerCategory) {
      throw new Error(`suite needs at least ${minPerCategory} ${category} tasks, got ${count}`)
    }
  }
  return tasks
}
