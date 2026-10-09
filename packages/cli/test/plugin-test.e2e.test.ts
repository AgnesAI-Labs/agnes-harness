import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { expect, it } from 'vitest'
import { runPluginTests } from '../src/commands/plugin-test.js'

it('runs the installed package script with a private home and propagates failure without installing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agh-plugin-cli-'))
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node test.mjs' } }))
    await writeFile(
      join(directory, 'test.mjs'),
      `import {writeFileSync} from 'node:fs'; writeFileSync('observed.json', JSON.stringify({home:process.env.HOME,key:process.env.OPENAI_API_KEY,args:process.argv.slice(2)})); process.exit(7)`,
    )
    expect(
      await runPluginTests(['test', directory, '--', 'literal-argument'], {
        cwd: directory,
        env: { PATH: process.env.PATH, OPENAI_API_KEY: 'synthetic-private-value' },
        stdout: output,
        stderr: output,
      }),
    ).toBe(7)
    const observed = JSON.parse(await readFile(join(directory, 'observed.json'), 'utf8'))
    expect(observed.key).toBeUndefined()
    expect(observed.args).toEqual(['literal-argument'])
    await expect(readFile(join(observed.home, '.npmrc'))).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
