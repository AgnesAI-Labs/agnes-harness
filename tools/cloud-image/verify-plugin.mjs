import { execFileSync } from 'node:child_process'

const [archive, version] = process.argv.slice(2)
if (!archive || !version) throw Error('Usage: verify-plugin.mjs ARCHIVE VERSION')
const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/u)
for (const name of names) {
  const parts = name.replace(/\/$/u, '').split('/')
  if (
    parts[0] !== 'package' ||
    parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\')) ||
    parts.some((part) => part.startsWith('._') || part === '.DS_Store' || part === '__MACOSX')
  )
    throw Error('Plugin archive contains an unexpected path or macOS metadata')
}
const pkg = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' }))
if (pkg.name !== '@agnes/cloud-plugin' || pkg.version !== version)
  throw Error('Unexpected cloud plugin identity or version')
if (pkg.agnes?.plugins?.[0]?.apiRange !== '^5.23.0') throw Error('Unexpected cloud plugin API range')
process.stdout.write(`Cloud plugin ${version}: clean package/ archive (${names.length} entries)\n`)
