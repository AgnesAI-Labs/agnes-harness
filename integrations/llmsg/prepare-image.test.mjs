import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('prepares committed matching sources and refuses dirty, mismatched or occupied inputs', () => {
  const parent = resolve(tmpdir())
  const temp = mkdtempSync(join(parent, 'agh-image-inputs-'))
  const source = dirname(fileURLToPath(import.meta.url))
  const core = join(temp, 'core'),
    plugin = join(temp, 'plugin'),
    llmsg = join(temp, 'llmsg')
  const git = (repo, ...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.autocrlf=false',
        '-C',
        repo,
        ...args,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
  try {
    for (const repo of [core, plugin, llmsg]) {
      mkdirSync(repo)
      git(repo, 'init')
    }
    mkdirSync(join(core, 'integrations/llmsg'), { recursive: true })
    for (const name of ['prepare-image.mjs', 'Dockerfile'])
      copyFileSync(join(source, name), join(core, 'integrations/llmsg', name))
    const entry = '#!/bin/bash\nset -euo pipefail\nprintf ready\n'
    writeFileSync(join(core, 'integrations/llmsg/start.sh'), entry)
    mkdirSync(join(llmsg, 'deploy/agh-cloud'), { recursive: true })
    writeFileSync(join(llmsg, 'deploy/agh-cloud/start.sh'), entry)
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'fixture-plugin', version: '0.9.2' }))
    writeFileSync(join(core, '.gitignore'), 'private.env\n')
    writeFileSync(join(core, 'private.env'), 'SYNTHETIC_TEST_CREDENTIAL')
    for (const repo of [core, plugin, llmsg]) {
      git(repo, 'add', '.')
      git(repo, 'commit', '-m', 'fixture')
    }
    const run = (output) =>
      spawnSync(
        process.execPath,
        [join(core, 'integrations/llmsg/prepare-image.mjs'), plugin, llmsg, output],
        { encoding: 'utf8' },
      )
    const output = join(temp, 'build')
    const result = run(output)
    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(readFileSync(join(output, 'sources.json'), 'utf8'))
    assert.equal(manifest.coreRevision, git(core, 'rev-parse', 'HEAD'))
    assert.equal(manifest.pluginRevision, git(plugin, 'rev-parse', 'HEAD'))
    assert.equal(manifest.llmsgEntrypointRevision, git(llmsg, 'rev-parse', 'HEAD'))
    assert.equal(readFileSync(join(output, 'packaging/start.sh'), 'utf8'), entry)
    const entries = execFileSync('tar', ['-tf', join(output, 'core-source.tar')], { encoding: 'utf8' })
    assert.ok(!entries.includes('private.env'))
    assert.notEqual(run(output).status, 0)
    writeFileSync(join(plugin, 'dirty.txt'), 'uncommitted')
    const dirtyOutput = join(temp, 'dirty-build')
    assert.notEqual(run(dirtyOutput).status, 0)
    assert.equal(existsSync(dirtyOutput), false)
    git(plugin, 'add', '.')
    git(plugin, 'commit', '-m', 'fixture change')
    writeFileSync(join(llmsg, 'deploy/agh-cloud/start.sh'), `${entry}printf changed\n`)
    git(llmsg, 'add', '.')
    git(llmsg, 'commit', '-m', 'fixture mismatch')
    const mismatchOutput = join(temp, 'mismatch-build')
    assert.notEqual(run(mismatchOutput).status, 0)
    assert.equal(existsSync(mismatchOutput), false)
  } finally {
    assert.ok(relative(parent, temp).startsWith('agh-image-inputs-'))
    rmSync(temp, { recursive: true, force: true })
  }
})

test('start.sh passes the telemetry setting to home initialization and refuses an unrecognized home', () => {
  const parent = resolve(tmpdir())
  const temp = mkdtempSync(join(parent, 'agh-start-entry-'))
  const source = dirname(fileURLToPath(import.meta.url))
  try {
    const bin = join(temp, 'bin')
    mkdirSync(bin)
    const writeTool = (name, script) => {
      const target = join(bin, name)
      writeFileSync(target, script)
      chmodSync(target, 0o755)
    }
    writeTool(
      'realpath',
      `#!${process.execPath}\nconst p = process.argv.at(-1);\nprocess.stdout.write(p + '\\n');\n`,
    )
    writeTool('stat', '#!/bin/sh\nprintf "ext4\\n"\n')
    writeTool(
      'node',
      `#!${process.execPath}\n` +
        'const fs = require("node:fs"), path = require("node:path");\n' +
        'const home = process.env.AGH_HOME;\n' +
        'console.log(process.env.AGH_TELEMETRY_DISABLED);\n' +
        'if (fs.existsSync(home) && fs.readdirSync(home).some((n) => n !== "cloud-key")) process.exit(1);\n' +
        'fs.mkdirSync(home, { recursive: true, mode: 0o700 });\n' +
        'fs.chmodSync(home, 0o700);\n',
    )

    const occupied = join(temp, 'occupied-home')
    const workspace = join(temp, 'workspace-never-created')
    mkdirSync(occupied)
    chmodSync(occupied, 0o755)
    writeFileSync(join(occupied, 'existing.txt'), 'preserve')

    for (const [setting, expected] of [
      [undefined, '1'],
      ['', '1'],
      ['0', '0'],
    ]) {
      const failed = spawnSync('/bin/bash', [join(source, 'start.sh')], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          AGH_CLOUD_API_BASE_URL: 'https://models.example.com/v1',
          LLMSG_TRACK_URL: 'https://models.example.com/llmsg/api/track/tool_calls',
          AGH_HOME: occupied,
          WORKSPACE_DIR: workspace,
          ...(setting === undefined ? {} : { AGH_TELEMETRY_DISABLED: setting }),
        },
        encoding: 'utf8',
      })
      assert.equal(failed.status, 1, failed.stderr)
      assert.equal(failed.stdout.trim(), expected)
    }
    assert.equal(lstatSync(occupied).mode & 0o777, 0o755)
    assert.equal(readFileSync(join(occupied, 'existing.txt'), 'utf8'), 'preserve')
    assert.equal(existsSync(workspace), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
