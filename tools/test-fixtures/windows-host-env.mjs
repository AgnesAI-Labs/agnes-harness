import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Windows host variables for child process fixtures with a synthetic user profile.
 * @param {string} userProfile A directory owned by the fixture, outside its workspace and AGH_HOME.
 * @param {string} [temp]
 */
export function windowsTestHostEnv(userProfile, temp = tmpdir()) {
  if (process.platform !== 'win32') return {}
  const appData = join(userProfile, 'AppData', 'Roaming')
  const localAppData = join(userProfile, 'AppData', 'Local')
  for (const directory of [appData, localAppData, temp]) mkdirSync(directory, { recursive: true })
  return {
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    ProgramFiles: process.env.ProgramFiles,
    USERPROFILE: userProfile,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
  }
}
