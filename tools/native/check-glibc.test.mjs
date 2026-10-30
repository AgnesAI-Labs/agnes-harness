import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { aboveBaseline, checkGlibc } from './check-glibc.mjs'

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
}, () => {
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
    assert.throws(() => checkGlibc(dir), /arbitrary-helper: imports GLIBC_2\.33/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
