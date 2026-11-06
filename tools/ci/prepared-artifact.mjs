import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { release } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API } from 'typescript/unstable/sync'
import { sourceHash } from '../e2e-web/build-cache.mjs'
import { pnpmInvocation } from '../toolchain/check.mjs'

const localRoot = 'packages/cli/dist/local'
const digest = (data) => createHash('sha256').update(data).digest('hex')
const slash = (path) => path.split(sep).join('/')
function fail(message) {
  throw new Error(`Prepared artifact: ${message}`)
}
function safePath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    /[\\:*?"<>|]/.test(path) ||
    [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    isAbsolute(path) ||
    path
      .split('/')
      .some(
        (part) => !part || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    fail('unsafe payload path')
  return path
}
function relativePath(path) {
  return safePath(slash(relative(process.cwd(), path)))
}
function checkedPath(path, allowMissing = false) {
  safePath(path)
  let current = process.cwd()
  for (const part of path.split('/')) {
    current = join(current, part)
    if (!existsSync(current)) {
      // existsSync follows links; lstat still detects dangling links.
      try {
        if (lstatSync(current).isSymbolicLink()) fail(`symlink: ${path}`)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (allowMissing) continue
      fail(`missing file: ${path}`)
    }
    if (lstatSync(current).isSymbolicLink()) fail(`symlink: ${path}`)
  }
  return current
}
function nativePaths(platform = process.platform) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) fail('unsupported native platform')
  return [
    'packages/system-node/dist/native/agnes-system.node',
    ...(['darwin', 'linux'].includes(platform) ? ['packages/host-infrastructure/dist/native/pty-relay'] : []),
    ...(platform === 'darwin'
      ? [
          'packages/host-infrastructure/dist/native/macos-process-identity',
          'packages/host-computer-use/dist/native/macos-live-app-identity',
        ]
      : []),
  ]
}

// The pinned compiler API parses configurations without emitting or rebuilding files.
function typePaths() {
  const api = new API({ cwd: process.cwd() })
  const claims = new Map()
  const outputs = new Set()
  const add = (path) => {
    const output = relativePath(path)
    if (
      output.split('/').includes('node_modules') ||
      output.startsWith(`${localRoot}/`) ||
      (!/(^|\/)dist\//.test(output) &&
        !output.startsWith('outputs/e2e-types/') &&
        !output.endsWith('.tsbuildinfo'))
    )
      fail('unsupported generated output path')
    outputs.add(output)
  }
  function visit(input) {
    let config = resolve(input)
    if (!config.endsWith('.json')) config = join(config, 'tsconfig.json')
    relativePath(config)
    if (claims.has(config)) return claims.get(config)
    const claimed = new Set()
    claims.set(config, claimed)
    const effective = api.parseConfigFile(config)
    const directory = dirname(config)
    const declared = JSON.parse(readFileSync(config, 'utf8'))
    for (const reference of declared.references ?? [])
      for (const path of visit(resolve(directory, reference.path))) claimed.add(path)
    const referenced = new Set(claimed)
    if (!effective.fileNames?.length) return claimed
    const options = effective.options ?? {}
    if (
      !options.outDir ||
      !options.rootDir ||
      options.outFile ||
      options.declarationDir ||
      options.noEmit ||
      !options.declaration ||
      !options.composite
    )
      fail(`unsupported compiler output layout: ${relativePath(config)}`)
    const root = resolve(directory, options.rootDir)
    const out = resolve(directory, options.outDir)
    for (const input of effective.fileNames) {
      if (/\.d\.[cm]?ts$/.test(input)) continue
      const source = resolve(directory, input)
      claimed.add(source)
      // The compiler redirects overlapping roots to their referenced project owner.
      if (referenced.has(source)) continue
      const path = relative(root, source)
      if (path.startsWith(`..${sep}`) || isAbsolute(path)) fail('compiler source outside rootDir')
      const extension = extname(path)
      if (extension === '.json' && options.resolveJsonModule) {
        if (!options.emitDeclarationOnly) add(join(out, path))
        continue
      }
      if (!/\.[cm]?tsx?$/.test(input)) fail(`unsupported compiler source extension: ${input}`)
      const stem = path.slice(0, -extension.length)
      const js =
        extension === '.mts'
          ? '.mjs'
          : extension === '.cts'
            ? '.cjs'
            : extension === '.tsx' && options.jsx === 1
              ? '.jsx'
              : '.js'
      const declaration = extension === '.mts' ? '.d.mts' : extension === '.cts' ? '.d.cts' : '.d.ts'
      if (!options.emitDeclarationOnly) {
        add(join(out, stem + js))
        if (options.sourceMap) add(join(out, `${stem}${js}.map`))
      }
      add(join(out, stem + declaration))
      if (options.declarationMap) add(join(out, `${stem}${declaration}.map`))
    }
    add(
      options.tsBuildInfoFile
        ? resolve(directory, options.tsBuildInfoFile)
        : join(out, relative(root, directory), `${basename(config, '.json')}.tsbuildinfo`),
    )
    return claimed
  }
  try {
    visit('tsconfig.json')
    visit('tools/e2e-web/tsconfig.json')
  } finally {
    api.close()
  }
  if (!outputs.size) fail('no compiler outputs')
  return [...outputs].sort()
}
function localRequired() {
  return [
    'agnes.mjs',
    'agnes-main.mjs',
    'daemon.mjs',
    'daemon-main.mjs',
    'worker.mjs',
    'worker-main.mjs',
    'web/index.html',
    '.e2e-build.json',
    'node_modules/@agnes/system-node/dist/native/agnes-system.node',
    process.platform === 'win32' ? 'ripgrep/rg.exe' : 'ripgrep/rg',
    ...nativePaths()
      .filter((path) => !path.endsWith('.node'))
      .map((path) => `native/${basename(path)}`),
  ].map((path) => `${localRoot}/${path}`)
}
function checkLocalPath(path) {
  if (!path.startsWith(`${localRoot}/`)) fail('local path outside distribution')
  if (
    /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials(?:\.json)?|vs-env\.(?:txt|ps1))$/i.test(
      path,
    )
  )
    fail(`credential or environment file: ${path}`)
}
function validateStamp(content, manifest) {
  const stamp = JSON.parse(content.toString())
  for (const [key, expected] of Object.entries({
    hash: manifest.sourceHash,
    node: manifest.node,
    platform: manifest.platform,
    arch: manifest.arch,
  }))
    if (stamp[key] !== expected) fail(`local build stamp mismatch: ${key}`)
}
function localPaths() {
  const files = []
  function walk(path) {
    const absolute = checkedPath(path)
    const stat = lstatSync(absolute)
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) walk(`${path}/${name}`)
      return
    }
    if (!stat.isFile()) fail('unsupported payload file type')
    checkLocalPath(path)
    files.push(path)
  }
  walk(localRoot)
  for (const required of localRequired())
    if (!files.includes(required)) fail(`missing local output: ${required}`)
  return files
}
async function identity(kind, producer) {
  const runId = process.env.GITHUB_RUN_ID
  const producerAttempt = process.env.GITHUB_RUN_ATTEMPT
  if (!/^\d+$/.test(runId ?? '')) fail('GITHUB_RUN_ID is required')
  if (!producer && !/^\d+$/.test(producerAttempt ?? '')) fail('GITHUB_RUN_ATTEMPT is required for pack')
  const imageOS = process.env.ImageOS
  const imageVersion = process.env.ImageVersion
  if (kind !== 'types' && (!imageOS || !imageVersion)) fail('ImageOS and ImageVersion are required')
  const pnpm = execFileSync(process.execPath, [...pnpmInvocation(), '--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (JSON.parse(readFileSync('package.json', 'utf8')).packageManager !== `pnpm@${pnpm}`)
    fail('pnpm version does not match packageManager')
  return {
    schema: 1,
    kind,
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runId,
    producerAttempt,
    platform: process.platform,
    arch: process.arch,
    osMajor: release().split('.')[0],
    osRelease: release(),
    imageOS: imageOS ?? '',
    imageVersion: imageVersion ?? '',
    node: process.version,
    pnpm,
    lockHash: digest(readFileSync('pnpm-lock.yaml')),
    sourceHash: await sourceHash(
      kind === 'types' && producer ? { platform: producer.platform, arch: producer.arch } : undefined,
    ),
  }
}
function tarHeader(path, size, mode) {
  const header = Buffer.alloc(512)
  const bytes = (value) => Buffer.byteLength(value)
  let name = path
  let prefix = ''
  if (bytes(name) > 100) {
    const split = [...path.matchAll(/\//g)]
      .map((match) => match.index)
      .find((index) => bytes(path.slice(0, index)) <= 155 && bytes(path.slice(index + 1)) <= 100)
    if (split === undefined) fail('payload path exceeds supported ustar layout')
    prefix = path.slice(0, split)
    name = path.slice(split + 1)
  }
  header.write(name, 0, 100)
  const octal = (value, start, length) => {
    const text = value.toString(8)
    if (text.length >= length) fail('ustar numeric overflow')
    header.write(`${text.padStart(length - 1, '0')}\0`, start, length)
  }
  octal(mode, 100, 8)
  octal(0, 108, 8)
  octal(0, 116, 8)
  octal(size, 124, 12)
  octal(0, 136, 12)
  header.fill(32, 148, 156)
  header.write('0', 156)
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  header.write(prefix, 345, 155)
  const sum = header.reduce((total, value) => total + value, 0)
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return header
}
function archive(files) {
  const chunks = []
  for (const file of files) {
    const data = readFileSync(checkedPath(file.path))
    if (
      digest(data) !== file.hash ||
      data.length !== file.size ||
      (lstatSync(file.path).mode & 0o777) !== file.mode
    )
      fail('payload changed during pack')
    chunks.push(
      tarHeader(file.path, data.length, file.mode),
      data,
      Buffer.alloc((512 - (data.length % 512)) % 512),
    )
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}
function parseArchive(data, files) {
  const pending = new Map(files.map((file) => [file.path, file]))
  const entries = []
  let offset = 0
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      if (
        data.length - offset < 1024 ||
        (data.length - offset) % 512 ||
        !data.subarray(offset).every((byte) => byte === 0)
      )
        fail('invalid tar trailer')
      if (pending.size) fail('missing tar entries')
      return entries
    }
    const text = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '')
    const number = (start, length) => {
      const value = text(start, length).trim()
      if (!/^[0-7]+$/.test(value)) fail('invalid tar number')
      return Number.parseInt(value, 8)
    }
    const checksum = number(148, 8)
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (checksum !== sum || text(257, 6) !== 'ustar' || header[156] !== 48 || text(157, 100))
      fail('unsupported or corrupt tar header')
    const prefix = text(345, 155)
    const path = safePath(`${prefix ? `${prefix}/` : ''}${text(0, 100)}`)
    const file = pending.get(path)
    const size = number(124, 12)
    const mode = number(100, 8)
    if (!file || size !== file.size || mode !== file.mode || !Number.isSafeInteger(size))
      fail('unexpected tar entry or mode')
    offset += 512
    if (offset + size > data.length) fail('truncated tar entry')
    const content = data.subarray(offset, offset + size)
    if (digest(content) !== file.hash) fail(`payload hash mismatch: ${path}`)
    const padding = (512 - (size % 512)) % 512
    if (!data.subarray(offset + size, offset + size + padding).every((byte) => byte === 0))
      fail('invalid tar padding')
    entries.push({ ...file, content })
    pending.delete(path)
    offset += size + padding
  }
  fail('missing tar trailer')
}
function validateFiles(manifest, required) {
  if (!Array.isArray(manifest.files) || !manifest.files.length) fail('missing file manifest')
  const paths = new Set()
  for (const file of manifest.files) {
    safePath(file.path)
    if (
      paths.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.hash) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !Number.isInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777
    )
      fail('invalid file manifest')
    if (manifest.kind === 'local') {
      checkLocalPath(file.path)
      if (
        process.platform !== 'win32' &&
        /\/(?:native\/(?:pty-relay|macos-process-identity|macos-live-app-identity)|ripgrep\/rg)$/.test(
          file.path,
        ) &&
        !(file.mode & 0o111)
      )
        fail('local helper is not executable')
    }
    if (manifest.kind === 'native' && !file.path.endsWith('.node') && !(file.mode & 0o111))
      fail('native helper is not executable')
    paths.add(file.path)
  }
  if (required && (paths.size !== required.length || required.some((path) => !paths.has(path))))
    fail('file manifest does not contain exact expected outputs')
  if (manifest.kind === 'local')
    for (const path of localRequired()) if (!paths.has(path)) fail(`missing required local output: ${path}`)
}
async function pack(kind, directory) {
  if (!['types', 'native', 'local'].includes(kind)) fail('expected artifact kind types, native or local')
  if (existsSync(directory)) fail('artifact directory already exists')
  if (resolve(directory).startsWith(`${resolve(localRoot)}${sep}`))
    fail('artifact directory overlaps payload')
  const manifest = await identity(kind)
  const paths = kind === 'types' ? typePaths() : kind === 'native' ? nativePaths() : localPaths()
  if (kind === 'local') validateStamp(readFileSync(`${localRoot}/.e2e-build.json`), manifest)
  manifest.files = paths.map((path) => {
    const absolute = checkedPath(path)
    const stat = lstatSync(absolute)
    if (!stat.isFile()) fail('expected regular generated output')
    return { path, hash: digest(readFileSync(absolute)), size: stat.size, mode: stat.mode & 0o777 }
  })
  validateFiles(manifest, kind === 'local' ? undefined : paths)
  const payload = archive(manifest.files)
  parseArchive(payload, manifest.files)
  mkdirSync(dirname(directory), { recursive: true })
  const temporary = mkdtempSync(join(dirname(directory), '.prepared-'))
  try {
    writeFileSync(join(temporary, 'payload.tar'), payload)
    writeFileSync(join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    renameSync(temporary, directory)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
async function restore(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  if (
    manifest.schema !== 1 ||
    !['types', 'native', 'local'].includes(manifest.kind) ||
    !/^\d+$/.test(manifest.producerAttempt) ||
    !['darwin', 'linux', 'win32'].includes(manifest.platform) ||
    !['x64', 'arm64'].includes(manifest.arch)
  )
    fail('unsupported manifest identity')
  const expected = await identity(manifest.kind, manifest)
  const keys = [
    'sha',
    'runId',
    'node',
    'pnpm',
    'lockHash',
    'sourceHash',
    ...(manifest.kind === 'types' ? [] : ['platform', 'arch', 'osMajor', 'imageOS', 'imageVersion']),
  ]
  for (const key of keys) if (manifest[key] !== expected[key]) fail(`identity mismatch: ${key}`)
  const required =
    manifest.kind === 'types' ? typePaths() : manifest.kind === 'native' ? nativePaths() : undefined
  validateFiles(manifest, required)
  const entries = parseArchive(readFileSync(join(directory, 'payload.tar')), manifest.files)
  if (manifest.kind === 'local')
    validateStamp(entries.find((file) => file.path === `${localRoot}/.e2e-build.json`).content, manifest)
  // Validate every destination before touching the checkout, including existing parent links.
  for (const entry of entries) {
    const path = checkedPath(entry.path, true)
    if (existsSync(path) && !lstatSync(path).isFile()) fail('destination is not a regular file')
  }
  for (const entry of entries) {
    const path = checkedPath(entry.path, true)
    mkdirSync(dirname(path), { recursive: true })
    const staging = mkdtempSync(join(dirname(path), '.prepared-'))
    try {
      const staged = join(staging, 'file')
      writeFileSync(staged, entry.content)
      chmodSync(staged, entry.mode)
      renameSync(staged, path)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, first, second, ...extra] = process.argv.slice(2)
    if (command === 'pack' && first && second && !extra.length) await pack(first, resolve(second))
    else if (command === 'restore' && first && !second) await restore(resolve(first))
    else fail('usage: pack <types|native|local> <artifact-directory> | restore <artifact-directory>')
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
