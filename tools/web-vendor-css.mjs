import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Shared renderer entries can emit the same CSS companion as the markdown entry.
 * Keep one copy of each body in the existing style.css URL, with no extra stylesheet requests.
 */
export async function consumeVendorCss(directory) {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.css')).sort()
  if (!files.includes('conversation.css')) throw new Error('Missing conversation vendor stylesheet')
  const bodies = new Set()
  for (const file of files) {
    bodies.add(
      (await readFile(join(directory, file), 'utf8')).replace(/\/\*# sourceMappingURL=.*?\*\//g, '').trim(),
    )
    await rm(join(directory, file))
    await rm(join(directory, `${file}.map`), { force: true })
  }
  return [...bodies].join('\n')
}
