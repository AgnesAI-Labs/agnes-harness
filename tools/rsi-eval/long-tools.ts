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

/** The launcher for a tool's source; its first line (a `# ` comment) stays readable as the header. */
export const packTool = (name: string, source: string): string => {
  const header = source.split('\n', 1)[0] ?? ''
  if (!header.startsWith('# ')) throw new Error(`${name}: the source must start with a "# " comment line`)
  const blob = deflateSync(Buffer.from(source, 'utf8'), { level: 9 }).toString('base64')
  const lines = blob.match(new RegExp(`.{1,${LINE}}`, 'g')) ?? []
  return [
    '#!/usr/bin/env python3',
    header,
    'import base64, zlib',
    'exec(compile(zlib.decompress(base64.b64decode("""',
    ...lines,
    `""")), "<${name}>", "exec"))`,
    '',
  ].join('\n')
}

/** The source a launcher runs. */
export const unpackTool = (launcher: string): string => {
  const match = /base64\.b64decode\("""\n([A-Za-z0-9+/=\n]*)"""\)/.exec(launcher)
  if (!match?.[1]) throw new Error('not a packed tool')
  return inflateSync(Buffer.from(match[1].replace(/\n/g, ''), 'base64')).toString('utf8')
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
