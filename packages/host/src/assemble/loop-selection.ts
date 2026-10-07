import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type LoopSelection, parseLoopSelection } from '@agnes/protocol'
import { HostError } from '../errors.js'

/** W4 stores PUT /admin/api/defaults in the profile configuration, independently of provider keys. */
export async function readAdminLoopDefault(
  profileDir: string,
  profile: string,
): Promise<LoopSelection | undefined> {
  let text: string
  try {
    text = await readFile(join(profileDir, 'configuration.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('configuration is too large')
    const value = JSON.parse(text)
    if ((value.version !== 1 && value.version !== 2) || value.profile !== profile)
      throw new Error('configuration identity is invalid')
    const loop = value.sessionDefaults?.loop
    return loop === undefined ? undefined : parseLoopSelection(loop)
  } catch {
    throw new HostError('E_PRESET_UNSUPPORTED', 'invalid persisted session loop default')
  }
}
