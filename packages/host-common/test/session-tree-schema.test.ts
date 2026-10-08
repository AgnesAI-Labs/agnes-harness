import { describe, expect, it } from 'vitest'
import { assertSessionTreeStorePath, assertSessionTreeTableName } from '../src/session-tree-schema.js'

describe('session tree schema', () => {
  it('refuses legacy session_profiles stores with rebuild guidance', () => {
    expect(() => assertSessionTreeStorePath('/data/session_profiles')).toThrow(/session_trees/)
    expect(() => assertSessionTreeStorePath('/data/session_profiles.db')).toThrow(/E_SESSION_TREE_SCHEMA/)
    expect(() => assertSessionTreeStorePath('/data/session_trees')).not.toThrow()
    expect(() => assertSessionTreeTableName('session_profiles')).toThrow(/E_SESSION_TREE_SCHEMA/)
    expect(() => assertSessionTreeTableName('session_trees')).not.toThrow()
  })
})
