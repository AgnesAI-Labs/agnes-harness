import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { validateExample } from './external-examples.js'

it('scans nested HTML template substitutions and still refuses private and computed imports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agh-example-imports-'))
  const file = join(directory, 'index.mjs')
  try {
    await writeFile(
      file,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is JavaScript source for the scanner fixture.
      'import { defineTool } from "@agnes/plugin-runtime";\nconst svg = `<svg>${items.map(item => `<rect width="${item.width}"/>`).join("")}</svg>`;',
    )
    await expect(validateExample(directory)).resolves.toBeUndefined()
    await writeFile(file, 'import "@agnes/plugin-runtime/host";')
    await expect(validateExample(directory)).rejects.toThrow('Private or undeclared')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: deliberately test a computed module specifier.
    await writeFile(file, 'import(`@agnes/${name}`);')
    await expect(validateExample(directory)).rejects.toThrow('Nonliteral')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
