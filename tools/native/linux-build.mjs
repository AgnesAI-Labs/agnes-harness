import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
export function linuxBuild(script, output) {
  const mode = process.env.AGNES_NATIVE_BUILDER
  if (!mode) return false
  if (mode !== 'glibc228') throw new Error('AGNES_NATIVE_BUILDER must be unset or glibc228')
  if (existsSync('/opt/agnes-native-builder')) return false
  const arch = process.arch // guards-allow-platform: match the native artifact to its loading Node runtime.
  if (arch !== 'x64' && arch !== 'arm64') throw new Error('Unsupported Linux native architecture')
  const platform = `linux/${arch === 'x64' ? 'amd64' : arch}`
  const version = readFileSync(resolve(root, '.node-version'), 'utf8').trim()
  const image = `agnes-native-glibc228:${version}-${arch}`
  execFileSync(
    'docker',
    [
      'build',
      '--platform',
      platform,
      '--build-arg',
      `NODE_VERSION=${version}`,
      '-t',
      image,
      resolve(root, 'tools/native'),
    ],
    { stdio: 'inherit' },
  )
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      platform,
      '--network=none',
      '-e',
      'AGNES_NATIVE_BUILDER=glibc228',
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '-v',
      `${root}:/src:ro`,
      '-v',
      `${output}:/out`,
      image,
      'node',
      `/src/${relative(root, script)}`,
      '--output-dir',
      '/out',
    ],
    { stdio: 'inherit' },
  )
  return true
}
