import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyComputerUseNotice } from '../tools/build-local.js'

const fixedHermesCommit = 'fb56a7e06dde62e9f645ff744c82cb47b60c469e'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('Computer Use Hermes attribution packaging', () => {
  it('copies the complete NOTICE into the local build without altering the fixed commit', async () => {
    const output = await mkdtemp(join(tmpdir(), 'agnes-computer-use-notice-'))
    temporaryDirectories.push(output)

    await copyComputerUseNotice(output)

    const source = await readFile(
      new URL('../../base/extensions/computer-use/NOTICE', import.meta.url),
      'utf8',
    )
    const packaged = await readFile(join(output, 'THIRD-PARTY-NOTICES', 'computer-use-hermes.txt'), 'utf8')
    expect(packaged).toBe(source)
    expect(packaged).toContain(`Fixed commit: ${fixedHermesCommit}`)
    expect(packaged).toContain('MIT License')
    expect(packaged).toContain('Copyright (c) 2025 Nous Research')
  })

  it('keeps the SEA transfer and npm package file coverage explicit', async () => {
    const seaBuild = await readFile(new URL('../sea/build.mjs', import.meta.url), 'utf8')
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      files?: string[]
    }

    expect(seaBuild).toContain(
      "['daemon.mjs', 'worker.mjs', 'web', 'THIRD-PARTY-NOTICES', 'bundled-plugins']",
    )
    expect(packageJson.files).toContain('dist/local/THIRD-PARTY-NOTICES/computer-use-hermes.txt')
    expect(packageJson.files).toContain('dist/sea/THIRD-PARTY-NOTICES/computer-use-hermes.txt')
  })
})
