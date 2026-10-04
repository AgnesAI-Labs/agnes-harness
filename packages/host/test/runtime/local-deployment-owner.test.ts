import { chmodSync, closeSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import {
  captureLocalDeploymentOwner,
  localDeploymentOwnerUsesDatabase,
} from '../../src/runtime/identity/local-deployment-owner.js'
import { inlineData } from '../../src/runtime/maintenance/authority-publication.js'
import { createBootstrapAnchor } from '../../src/runtime/maintenance/bootstrap-locator.js'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-deployment-owner-')))
  const directory = join(root, 'deployment')
  const created = createBootstrapAnchor(directory, {
    principalRef: 'bootstrap-label-is-not-authentication',
    locator: {
      directoryId: 'local-directory',
      providerLockRef: inlineData({ lock: 'locator-only' }, 'agh.maintenance/provider-lock@1'),
      endpointRef: directory,
      epoch: 1,
      revision: 1,
      cutoverId: 'local-cutover',
    },
  })
  if (!created.ok) throw new Error(created.error.detailCode)
  const file = join(directory, 'state.sqlite')
  closeSync(createPrivateFileSync(file))
  const database = new DatabaseSync(file)
  return {
    root,
    directory,
    deploymentDirectory: directory,
    file,
    database,
    close() {
      database.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe.skipIf(typeof process.getuid !== 'function')('original POSIX local deployment owner', () => {
  it('uses the actual owner and native connection, without authenticating the bootstrap principal label', () => {
    const f = fixture()
    try {
      const owner = captureLocalDeploymentOwner(f)
      expect(owner.facts.uid).toBe(process.getuid?.())
      expect(owner.facts.principalRef).not.toBe('bootstrap-label-is-not-authentication')
      expect(localDeploymentOwnerUsesDatabase(owner, f.database)).toBe(true)
      expect(localDeploymentOwnerUsesDatabase({ ...owner }, f.database)).toBe(false)
      const other = new DatabaseSync(f.file)
      try {
        expect(localDeploymentOwnerUsesDatabase(owner, other)).toBe(false)
      } finally {
        other.close()
      }
      owner.dynamicCheck()
    } finally {
      f.close()
    }
  })

  it('rejects real nonprivate State and bootstrap files', () => {
    const f = fixture()
    try {
      chmodSync(f.file, 0o644)
      expect(() => captureLocalDeploymentOwner(f)).toThrow(/private/)
      chmodSync(f.file, 0o600)
      chmodSync(join(f.directory, 'locator.json'), 0o644)
      expect(() => captureLocalDeploymentOwner(f)).toThrow(/private/)
    } finally {
      f.close()
    }
  })

  it('rejects an actually writable ancestor without sticky ownership protection', () => {
    const f = fixture()
    try {
      chmodSync(f.root, 0o777)
      expect(() => captureLocalDeploymentOwner(f)).toThrow(/ancestor/)
    } finally {
      f.close()
    }
  })

  it('rejects a caller supplied path alias and an in-memory native database', () => {
    const f = fixture()
    const memory = new DatabaseSync(':memory:')
    try {
      const alias = join(f.root, 'alias')
      symlinkSync(f.directory, alias)
      expect(() =>
        captureLocalDeploymentOwner({ database: f.database, deploymentDirectory: alias }),
      ).toThrow()
      expect(() =>
        captureLocalDeploymentOwner({ database: memory, deploymentDirectory: f.directory }),
      ).toThrow()
    } finally {
      memory.close()
      f.close()
    }
  })

  it('detects a real permission change in the preclock check', () => {
    const f = fixture()
    try {
      const owner = captureLocalDeploymentOwner(f)
      chmodSync(f.file, 0o644)
      expect(() => owner.dynamicCheck()).toThrow(/private/)
    } finally {
      f.close()
    }
  })

  it('does not invoke a replaced OS owner method during fixed descriptor checks', () => {
    const f = fixture()
    const original = Object.getOwnPropertyDescriptor(process, 'getuid')
    if (!original) throw new Error('original OS owner method unavailable')
    try {
      const owner = captureLocalDeploymentOwner(f)
      let calls = 0
      Object.defineProperty(process, 'getuid', {
        ...original,
        value: () => {
          calls++
          return owner.facts.uid
        },
      })
      expect(() => owner.staticCheck()).toThrow(/methods/)
      expect(() => owner.dynamicCheck()).toThrow(/methods/)
      expect(calls).toBe(0)
    } finally {
      Object.defineProperty(process, 'getuid', original)
      f.close()
    }
  })
  it('rejects reuse of the same JavaScript database after native close and reopen', () => {
    const f = fixture()
    try {
      const owner = captureLocalDeploymentOwner(f)
      expect(localDeploymentOwnerUsesDatabase(owner, f.database)).toBe(true)
      f.database.close()
      f.database.open()
      expect(localDeploymentOwnerUsesDatabase(owner, f.database)).toBe(false)
      expect(() => owner.dynamicCheck()).toThrow()
      expect(() => owner.staticCheck()).toThrow()
      const fresh = captureLocalDeploymentOwner(f)
      expect(localDeploymentOwnerUsesDatabase(fresh, f.database)).toBe(true)
      fresh.dynamicCheck()
    } finally {
      f.close()
    }
  })
})
