import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { safeSkillReadRoots } from '../../src/resources/skill-read-roots.js'

const home = '/nonexistent-home/u'
const context = { homeDir: home, agnesHome: join(home, '.agh'), dataDir: join(home, '.agh', 'data') }

describe('safeSkillReadRoots', () => {
  it('keeps ordinary Skill directories and those under the installation skills folder', () => {
    const keep = [
      join(home, '.claude', 'skills', 'pdf'),
      join(home, '.agh', 'skills', 'review'),
      join(home, '.agnes', 'skills', 'x'),
      '/opt/skills/lint',
    ]
    expect(safeSkillReadRoots(keep, context)).toEqual(keep)
  })

  it('drops the filesystem root, the home directory and anything above it', () => {
    expect(safeSkillReadRoots(['/', '/nonexistent-home', home], context)).toEqual([])
  })

  it('drops roots overlapping data or credential stores, in either direction', () => {
    const drop = [
      join(home, '.agh', 'data', 'x'),
      join(home, '.ssh'),
      join(home, '.aws', 'skill'),
      join(home, '.config'),
      join(home, '.config', 'gcloud', 'y'),
      join(home, '.AWS'),
    ]
    expect(safeSkillReadRoots(drop, context)).toEqual([])
  })

  it('closes the installation homes except strictly inside their skills folder', () => {
    const drop = [
      join(home, '.agh'),
      join(home, '.agh', 'skills'),
      join(home, '.agh', 'secrets'),
      join(home, '.agnes'),
      join(home, '.agnes', 'secrets.env'),
    ]
    expect(safeSkillReadRoots(drop, context)).toEqual([])
  })

  it('honours a relocated installation home', () => {
    const moved = { ...context, agnesHome: '/srv/agh', dataDir: '/srv/agh/data' }
    expect(safeSkillReadRoots(['/srv/agh/profile', '/srv/agh/skills/a'], moved)).toEqual([
      '/srv/agh/skills/a',
    ])
  })
})
