import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
/** Preserve the exact notices of dependencies actually embedded into a browser asset. */
export async function notices(root, inputs) {
  const packages = new Map()
  for (const file of Object.keys(inputs)) {
    if (!file.includes('node_modules/')) continue
    let directory = dirname(resolve(root, file))
    while (directory !== dirname(directory)) {
      try {
        const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
        if (metadata.name) {
          packages.set(metadata.name, { directory, metadata })
          break
        }
      } catch {}
      directory = dirname(directory)
    }
  }
  const blocks = []
  for (const [name, { directory, metadata }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    let license
    for (const candidate of ['LICENSE', 'LICENSE.md', 'license', 'LICENSE.txt']) {
      try {
        await access(join(directory, candidate))
        license = await readFile(join(directory, candidate), 'utf8')
        break
      } catch {}
    }
    if (!license) throw new Error(`Missing bundled license: ${name}`)
    blocks.push(
      `${name}@${metadata.version} (${metadata.license})\n${license
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .trim()}`,
    )
  }
  return (
    `Agnes Harness browser presentation. Project source is Apache-2.0.\nThe generated asset also includes these third-party components:\n\n${blocks.join('\n\n-----\n\n')}`.trimEnd() +
    '\n'
  )
}
