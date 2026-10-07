import { existsSync, lstatSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { copyPackageTreeSync } from './copy-tree.js'
import { readStaticJson } from './integrity.js'
import { hashDirectory, type PackageSource } from './sources.js'

export interface LocalPluginRoots {
  home: string
  workspace: string
}
export interface LocalPluginCandidate {
  source: PackageSource & { type: 'local' }
  directory: string
  name: string
}

/** Only immediate, non-symlink directories are executable plugin candidates. */
export function discoverLocalPlugins(roots: LocalPluginRoots): LocalPluginCandidate[] {
  const result: LocalPluginCandidate[] = []
  for (const scope of ['home', 'workspace'] as const) {
    const root = roots[scope]
    if (!existsSync(root)) continue
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
      throw new TypeError('Local plugins root must be a directory, not a symlink')
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9._-]*$/.test(entry.name)) continue
      const directory = join(root, entry.name)
      // An incomplete scaffold is still inventoried, with an actionable failure.
      result.push({
        name: entry.name,
        directory,
        source: { type: 'local', ref: `local:${scope}/${entry.name}` },
      })
    }
  }
  return result
}

/** Freeze source bytes before evaluation. A single-file tool is adapted to the usual Cordis export. */
export function stageLocalPlugin(candidate: LocalPluginCandidate, stage: string) {
  copyPackageTreeSync(
    candidate.directory,
    stage,
    (path) =>
      !relative(candidate.directory, path)
        .split(/[\\/]/)
        .some((part) => ['node_modules', '.git'].includes(part)),
  )
  if (!existsSync(join(stage, 'package.json'))) {
    const entry = ['plugin.ts', 'plugin.js'].find((name) => existsSync(join(stage, name)))
    if (!entry)
      throw new TypeError('Add package.json with agnes.plugins, or plugin.ts/plugin.js with a default export')
    writeFileSync(
      join(stage, 'package.json'),
      JSON.stringify({
        name: candidate.name,
        version: '0.0.0',
        type: 'module',
        license: 'UNLICENSED',
        exports: './.agnes-local-entry.mjs',
        agnes: {
          kinds: ['tool'],
          plugins: [{ export: 'main', id: `ext:${candidate.name}/main`, inject: ['extension'] }],
        },
      }),
    )
    writeFileSync(
      join(stage, '.agnes-local-entry.mjs'),
      `import * as author from ${JSON.stringify(`./${entry}`)}\nimport { defineAgnesPlugin } from "@agnes/plugin-runtime"\nconst value = author.default ?? author.main\nexport const main = value && typeof value.execute === "function"\n  ? defineAgnesPlugin({ inject: ["extension"], apply(ctx) {\n      const unregister = ctx.extension().registerTool(value)\n      ctx.effect(() => () => unregister())\n    } })\n  : value\n`,
    )
  }
  const pkg = readStaticJson(join(stage, 'package.json'))
  if (
    !pkg.agnes ||
    typeof pkg.agnes !== 'object' ||
    !Array.isArray((pkg.agnes as Record<string, unknown>).plugins)
  )
    throw new TypeError('Declare agnes.plugins in package.json')
  // Local authoring resolves source entries as declared; it does not guess a missing dist build.
  const integrity = hashDirectory(stage, { exclude: [] })
  return { pkg, integrity, directory: stage }
}

export function localPluginRoots(home: string, workspace: string): LocalPluginRoots {
  return { home: join(home, 'plugins'), workspace: join(workspace, '.agnes', 'plugins') }
}

/** Sanitized diagnostics deliberately exclude source text, exception messages and absolute paths. */
export const LOCAL_PLUGIN_FAILURE =
  'Local plugin could not be loaded. Check package.json agnes.plugins, its source entry, and plugin.ts/plugin.js default export. See docs/extend/local-plugins.md.'
