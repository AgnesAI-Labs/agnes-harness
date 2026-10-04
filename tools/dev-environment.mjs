import { constants } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'

const jevKey = /^(?:AGNES_JEV_[A-Z_]+|TYPESAFE_API_KEY)$/u

/** Opt-in capture from this shell, never from another process. No values are logged. */
export async function saveDevEnvironment(home, env) {
  const path = join(home, 'dev.env')
  const values = Object.fromEntries(Object.entries(env).filter(([key, value]) => jevKey.test(key) && value))
  if (!Object.keys(values).length) throw new Error('No Jev environment variables to save')
  const content = `${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n')}\n`
  const parsed = parseEnv(content)
  if (Object.entries(values).some(([key, value]) => parsed[key] !== value))
    throw new Error('Jev environment cannot be represented safely in dev.env')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, { flag: 'wx', mode: 0o600 })
  return path
}

export async function loadDevEnvironment(home, env) {
  const path = join(home, 'dev.env')
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error.code === 'ENOENT') return { ...env }
    throw error
  }
  try {
    const info = await file.stat()
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid())
      throw new Error('dev.env must be an owner-only regular file (chmod 600)')
    const values = parseEnv(await file.readFile('utf8'))
    if (Object.keys(values).some((key) => !jevKey.test(key)))
      throw new Error('Automatic dev.env accepts only AGNES_JEV_* and TYPESAFE_API_KEY')
    return { ...values, ...env }
  } finally {
    await file.close()
  }
}
