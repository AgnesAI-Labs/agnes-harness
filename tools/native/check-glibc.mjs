import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function aboveBaseline(version) {
  const parts = version.split('.').map(Number)
  const baseline = [2, 28, 0]
  return parts.reduce((order, part, i) => order || Math.sign(part - (baseline[i] ?? 0)), 0) > 0
}

export function checkGlibc(root) {
  const seen = new Set()
  let checked = 0
  function visit(path) {
    const real = realpathSync(path)
    if (seen.has(real)) return
    seen.add(real)
    if (statSync(real).isDirectory()) {
      for (const name of readdirSync(real)) visit(join(real, name))
      return
    }
    const fd = openSync(real, 'r')
    const magic = Buffer.alloc(4)
    try {
      readSync(fd, magic, 0, 4, 0)
    } finally {
      closeSync(fd)
    }
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return
    const symbols = execFileSync('readelf', ['--wide', '--dyn-syms', real], {
      encoding: 'utf8',
      // Node exports several MB of symbols; still bound malformed/oversized tool output.
      maxBuffer: 32 * 1024 * 1024,
    })
    for (const line of symbols.split('\n')) {
      if (!/\bUND\b/.test(line)) continue
      for (const match of line.matchAll(/@GLIBC_([A-Za-z0-9_.]+)/g))
        if (!/^\d+(?:\.\d+)+$/.test(match[1]) || aboveBaseline(match[1]))
          throw new Error(
            `${path}: imports GLIBC_${match[1]} above baseline GLIBC_2.28; rebuild with AGNES_NATIVE_BUILDER=glibc228`,
          )
    }
    checked++
  }
  visit(root)
  if (!checked) throw new Error(`No ELF artifacts checked in ${root}`)
  process.stdout.write(`GLIBC_2.28 check passed: ${checked} ELF artifacts in ${root}\n`)
  return checked
}

/** Dev outputs are for their own host; only compatibility builds promise portable artifacts. */
export function checkNativeGlibc(root) {
  try {
    return checkGlibc(root)
  } catch (error) {
    if (process.env.AGNES_NATIVE_BUILDER === 'glibc228') throw error
    process.stderr.write(`Native development build warning: ${error.message}\n`)
    return 0
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Expected a native artifact or distribution directory')
  checkGlibc(process.argv[2])
}
