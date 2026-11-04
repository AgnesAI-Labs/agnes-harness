// The tools of the long tasks (tasks/long-*): each task keeps its tool's readable source in
// `tool/<name>.py`, next to the fixture and never copied into a workspace, and the fixture holds it
// packed as `bin/<name>`: a launcher that runs the compressed source. Reading the launcher with `cat` or
// `grep` shows neither the tool's checks nor its messages, so a rule the tool enforces cannot be read
// off the workspace; the agent has to find it by using the tool. `long-tasks.test.ts` checks that every
// launcher runs exactly its source.
//
//   pnpm exec tsx tools/rsi-eval/long-tools.ts      # pack every long task's tools into its fixture
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'
import { defaultTasksDir } from './suite.js'

const LINE = 76
const MARK = '#PACKED'
/**
 * The macOS command line tools' own Python, tried before `python3` on the PATH: inside a sandbox the
 * `/usr/bin/python3` shim prints cache warnings to stderr around every message of the tool, and agents then
 * hide stderr, and the tool's errors with it.
 */
const PYTHONS = [
  '/Library/Developer/CommandLineTools/usr/bin/python3',
  '/Applications/Xcode.app/Contents/Developer/usr/bin/python3',
]

/**
 * The launcher for a tool's source: a shell script that runs the packed source, kept below a mark, with the
 * Python it finds. The source's first line (a `# ` comment) stays readable as the header.
 */
export const packTool = (name: string, source: string): string => {
  const header = source.split('\n', 1)[0] ?? ''
  if (!header.startsWith('# ')) throw new Error(`${name}: the source must start with a "# " comment line`)
  const blob = deflateSync(Buffer.from(source, 'utf8'), { level: 9 }).toString('base64')
  const lines = blob.match(new RegExp(`.{1,${LINE}}`, 'g')) ?? []
  const run = `import base64,sys,zlib;sys.argv=sys.argv[1:];exec(compile(zlib.decompress(base64.b64decode(open(sys.argv[0]).read().split("${MARK}\\n",1)[1])),"<${name}>","exec"))`
  return [
    '#!/bin/sh',
    header,
    'py=python3',
    `for c in ${PYTHONS.join(' ')}; do`,
    '  if [ -x "$c" ]; then py=$c; break; fi',
    'done',
    `exec "$py" -c '${run}' "$0" "$@"`,
    MARK,
    ...lines,
    '',
  ].join('\n')
}

/** The source a launcher runs. */
export const unpackTool = (launcher: string): string => {
  const at = launcher.indexOf(`\n${MARK}\n`)
  if (at < 0) throw new Error('not a packed tool')
  const blob = launcher.slice(at + MARK.length + 2).replace(/\n/g, '')
  return inflateSync(Buffer.from(blob, 'base64')).toString('utf8')
}

/** Every long task's tools: the source file and the launcher it is packed into. */
export const longTools = (tasksDir = defaultTasksDir): { name: string; source: string; launcher: string }[] =>
  readdirSync(tasksDir)
    .filter((task) => task.startsWith('long-') && existsSync(join(tasksDir, task, 'tool')))
    .sort()
    .flatMap((task) =>
      readdirSync(join(tasksDir, task, 'tool'))
        .filter((file) => file.endsWith('.py'))
        .sort()
        .map((file) => ({
          name: basename(file, '.py'),
          source: join(tasksDir, task, 'tool', file),
          launcher: join(tasksDir, task, 'fixture', 'bin', basename(file, '.py')),
        })),
    )

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const tool of longTools()) {
    writeFileSync(tool.launcher, packTool(tool.name, readFileSync(tool.source, 'utf8')))
    chmodSync(tool.launcher, 0o755)
    console.log(`packed ${tool.launcher}`)
  }
}
