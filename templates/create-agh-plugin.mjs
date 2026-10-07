#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const templateNames = ['tool', 'tool-with-panel', 'mcp-skills', 'model-adapter', 'loop']
const root = dirname(fileURLToPath(import.meta.url))

/** Copy sources without installing dependencies or overwriting an existing destination. */
export async function scaffold(template, name, destination = name?.split('/').at(-1)) {
  if (!templateNames.includes(template)) throw new TypeError(`Unknown template: ${template}`)
  if (
    typeof name !== 'string' ||
    name.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
  ) {
    throw new TypeError('Name must be a lowercase npm package name, optionally @scope/name')
  }
  const leaf = name.split('/').at(-1)
  const skillName = leaf.replace(/[._]+/g, '-').replace(/-+/g, '-').replace(/-$/, '')
  const toolName = `plugin_${skillName.replace(/-/g, '_')}`
  if (toolName.length > 64)
    throw new TypeError('Name is too long for a tool identifier (57 characters maximum)')
  const target = resolve(destination)
  await mkdir(target)
  const replacements = { __PACKAGE_NAME__: name, __TOOL_NAME__: toolName, __SKILL_NAME__: skillName }
  const replace = (text) => {
    for (const [token, value] of Object.entries(replacements)) text = text.replaceAll(token, value)
    return text
  }
  async function copy(source, dest) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = join(source, entry.name)
      const to = join(dest, replace(entry.name))
      if (entry.isDirectory()) {
        await mkdir(to)
        await copy(from, to)
      } else if (entry.isFile()) {
        await writeFile(to, replace(await readFile(from, 'utf8')), { flag: 'wx' })
      } else throw new Error(`Unsupported template entry: ${entry.name}`)
    }
  }
  try {
    await copy(join(root, template), target)
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
  return target
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [template, name, destination, ...extra] = process.argv.slice(2)
  if (template === '--help' || !template) {
    console.log(
      `Usage: node ${basename(process.argv[1])} <template> <name> [directory]\nTemplates: ${templateNames.join(', ')}`,
    )
  } else {
    try {
      if (extra.length) throw new TypeError('Too many arguments')
      const target = await scaffold(template, name, destination)
      console.log(
        `Created ${name} in ${target}\nNext: cd ${JSON.stringify(target)} && npm install && npm run build && npm test`,
      )
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
