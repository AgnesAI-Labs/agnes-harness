import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
export function linuxBuild(script, output) {
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
