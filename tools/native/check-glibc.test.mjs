import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { aboveBaseline, checkGlibc, checkNativeGlibc } from './check-glibc.mjs'

test('compares numeric GLIBC versions including minor versions below ten', () => {
  for (const version of ['2.2.5', '2.9', '2.17', '2.28']) assert.equal(aboveBaseline(version), false)
  for (const version of ['2.28.1', '2.29', '2.33', '2.34', '3.0']) assert.equal(aboveBaseline(version), true)
})

test('rejects a directory without ELF artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-glibc-check-'))
  try {
    assert.throws(() => checkGlibc(dir), /No ELF artifacts/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scans the complete pinned Node executable without overflowing the symbol buffer', {
  skip: process.platform !== 'linux',
}, () => {
  assert.equal(checkGlibc(process.execPath), 1)
})

test('scans actual ELF dependencies and rejects a deliberately high GLIBC import', {
  skip: process.platform !== 'linux',
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-glibc-check-'))
  try {
    // Build a tiny versioned dependency, independent of the test host's libc patch.
    writeFileSync(join(dir, 'dep.c'), 'void agnes_test_symbol(void) {}\n')
    writeFileSync(join(dir, 'version.map'), 'GLIBC_2.33 { global: agnes_test_symbol; };\n')
    writeFileSync(
      join(dir, 'addon.c'),
      'extern void agnes_test_symbol(void); void call(void) { agnes_test_symbol(); }\n',
    )
    execFileSync('cc', ['-shared', '-fPIC', 'dep.c', '-Wl,--version-script=version.map', '-o', 'libdep.so'], {
      cwd: dir,
    })
    execFileSync('cc', ['-shared', '-fPIC', 'addon.c', '-L.', '-ldep', '-o', 'arbitrary-helper'], {
      cwd: dir,
    })
    const previous = process.env.AGNES_NATIVE_BUILDER
    const warning = []
    const write = t.mock.method(process.stderr, 'write', (message) => {
      warning.push(message)
      return true
    })
    try {
      delete process.env.AGNES_NATIVE_BUILDER
      assert.equal(checkNativeGlibc(dir), 0)
      assert.match(warning.join(''), /development build warning:.*GLIBC_2\.33/)
      assert.throws(
        () => checkGlibc(dir),
        /arbitrary-helper: imports GLIBC_2\.33.*AGNES_NATIVE_BUILDER=glibc228/,
      )
      process.env.AGNES_NATIVE_BUILDER = 'glibc228'
      assert.throws(() => checkNativeGlibc(dir), /GLIBC_2\.33.*AGNES_NATIVE_BUILDER=glibc228/)
    } finally {
      write.mock.restore()
      if (previous === undefined) delete process.env.AGNES_NATIVE_BUILDER
      else process.env.AGNES_NATIVE_BUILDER = previous
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('host builds work without Docker and retain Node-provided hashing', {
  skip: process.platform !== 'linux',
}, () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'agnes-host-native-'))
  try {
    const bin = join(dir, 'bin'),
      output = join(dir, 'native'),
      marker = join(dir, 'docker-called')
    mkdirSync(bin)
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\ntouch "$AGNES_TEST_DOCKER_MARKER"\nexit 91\n', {
      mode: 0o755,
    })
    const env = {
      ...process.env,
      AGNES_NATIVE_BUILDER: '',
      AGNES_TEST_DOCKER_MARKER: marker,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    }
    for (const owner of ['system-node', 'host-infrastructure'])
      execFileSync(
        process.execPath,
        [join(root, 'packages', owner, 'scripts/build-native.mjs'), '--output-dir', output],
        { env },
      )
    assert.equal(existsSync(marker), false)
    const addon = join(output, 'agnes-system.node')
    const dependencies = execFileSync('readelf', ['--dynamic', addon], { encoding: 'utf8' })
    assert.doesNotMatch(dependencies, /NEEDED.*libcrypto/)
    const symbols = execFileSync('nm', ['--dynamic', '--undefined-only', addon], { encoding: 'utf8' })
    assert.match(symbols, /\bU EVP_DigestUpdate\b/)
    execFileSync(process.execPath, [join(root, 'tools/native/crypto-smoke.cjs'), addon], {
      env,
      stdio: 'inherit',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
