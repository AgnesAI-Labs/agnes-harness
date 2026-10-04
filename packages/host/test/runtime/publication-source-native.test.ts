import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createLocalDeploymentIdentity } from '../../src/runtime/identity/local-deployment-identity.js'
import { createNativeMaintenanceOwner } from '../../src/runtime/maintenance/native-store.js'
import {
  createNativePublicationSource,
  nativePublicationSourceUsesDatabase,
  openNativePublicationInstallationHistory,
} from '../../src/runtime/maintenance/publication-source.js'
import { publicationNativeFixture } from './fixtures/publication-native.js'

describe.skipIf(typeof process.getuid !== 'function')('publication installation native anchor', () => {
  it('retains the original nullable publication slot in a new C14 installation', () => {
    const f = publicationNativeFixture()
    const identity = createLocalDeploymentIdentity(f.options)
    try {
      const row = f.database.prepare('SELECT publication_json FROM runtime_local_identity_installation').get()
      expect(row).toEqual({ publication_json: null })
      expect(
        f.database
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'runtime_publication_%'")
          .get()?.n,
      ).toBe(0)
    } finally {
      identity.close()
      f.close()
    }
  })
  it('installs source storage once in the original slot and refuses missing installed tables', () => {
    const f = publicationNativeFixture()
    const identity = createLocalDeploymentIdentity(f.options)
    const maintenance = createNativeMaintenanceOwner({ database: f.database, identity, writerEpoch: 1 })
    let source: ReturnType<typeof createNativePublicationSource> | undefined
    try {
      source = createNativePublicationSource({ database: f.database, identity, maintenance })
      expect(nativePublicationSourceUsesDatabase(source, f.database)).toBe(true)
      const foreign = new DatabaseSync(f.file)
      try {
        expect(nativePublicationSourceUsesDatabase(source, foreign)).toBe(false)
      } finally {
        foreign.close()
      }
      const installation = source.readInstallation()
      expect(installation.installationDigest).toHaveLength(64)
      const before = f.database.prepare('SELECT total_changes() AS n').get()?.n
      const restored = createNativePublicationSource({ database: f.database, identity, maintenance })
      expect(restored.readInstallation()).toEqual(installation)
      expect(f.database.prepare('SELECT total_changes() AS n').get()?.n).toBe(before)
      restored.close()
      f.database.exec('DROP TABLE runtime_publication_sources')
      const damaged = f.database.prepare('SELECT total_changes() AS n').get()?.n
      expect(() => source?.readInstallation()).toThrow()
      expect(() => createNativePublicationSource({ database: f.database, identity, maintenance })).toThrow()
      expect(f.database.prepare('SELECT total_changes() AS n').get()?.n).toBe(damaged)
      expect(
        f.database.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_publication_sources'").get(),
      ).toBeUndefined()
    } finally {
      source?.close()
      maintenance.close()
      identity.close()
      f.close()
    }
  })
  it('rolls back original DDL and NULL-slot CAS together when SQL rejects the update', () => {
    const f = publicationNativeFixture()
    const identity = createLocalDeploymentIdentity(f.options)
    const maintenance = createNativeMaintenanceOwner({ database: f.database, identity, writerEpoch: 1 })
    try {
      f.database.exec(
        "CREATE TRIGGER reject_publication_slot BEFORE UPDATE OF publication_json ON runtime_local_identity_installation BEGIN SELECT RAISE(ABORT,'reject'); END",
      )
      expect(() => createNativePublicationSource({ database: f.database, identity, maintenance })).toThrow()
      expect(
        f.database.prepare('SELECT publication_json FROM runtime_local_identity_installation').get()
          ?.publication_json,
      ).toBeNull()
      expect(
        f.database
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'runtime_publication_%'")
          .get()?.n,
      ).toBe(0)
      f.database.exec('DROP TRIGGER reject_publication_slot')
      const source = createNativePublicationSource({ database: f.database, identity, maintenance })
      expect(source.readInstallation().installationDigest).toHaveLength(64)
      source.close()
    } finally {
      maintenance.close()
      identity.close()
      f.close()
    }
  })
  it('refuses residual storage and a closed original identity before any installation writes', () => {
    const f = publicationNativeFixture()
    const identity = createLocalDeploymentIdentity(f.options)
    const maintenance = createNativeMaintenanceOwner({ database: f.database, identity, writerEpoch: 1 })
    try {
      f.database.exec('CREATE TABLE runtime_publication_sources (residual TEXT)')
      const before = f.database.prepare('SELECT total_changes() AS n').get()?.n
      expect(() => createNativePublicationSource({ database: f.database, identity, maintenance })).toThrow()
      expect(f.database.prepare('SELECT total_changes() AS n').get()?.n).toBe(before)
      f.database.exec('DROP TABLE runtime_publication_sources')
      identity.close()
      expect(() => createNativePublicationSource({ database: f.database, identity, maintenance })).toThrow()
      expect(f.database.prepare('SELECT total_changes() AS n').get()?.n).toBe(before)
      expect(
        f.database
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'runtime_publication_%'")
          .get()?.n,
      ).toBe(0)
    } finally {
      maintenance.close()
      identity.close()
      f.close()
    }
  })
  it('invalidates the original source generation after the same JS database closes and reopens', () => {
    const f = publicationNativeFixture()
    const identity = createLocalDeploymentIdentity(f.options)
    const maintenance = createNativeMaintenanceOwner({ database: f.database, identity, writerEpoch: 1 })
    const source = createNativePublicationSource({ database: f.database, identity, maintenance })
    try {
      expect(nativePublicationSourceUsesDatabase(source, f.database)).toBe(true)
      f.database.close()
      f.database.open()
      expect(nativePublicationSourceUsesDatabase(source, f.database)).toBe(false)
      expect(() => source.readInstallation()).toThrow()
    } finally {
      source.close()
      maintenance.close()
      identity.close()
      f.close()
    }
  })
  it('refuses an old installation lacking the slot without repairing its DDL', () => {
    const f = publicationNativeFixture()
    const identity = createLocalDeploymentIdentity(f.options)
    identity.close()
    try {
      f.database.exec('ALTER TABLE runtime_local_identity_installation DROP COLUMN publication_json')
      const before = f.database.prepare('SELECT total_changes() AS n').get()?.n
      const schema = f.database
        .prepare("SELECT sql FROM sqlite_master WHERE name='runtime_local_identity_installation'")
        .get()?.sql
      expect(() => createLocalDeploymentIdentity(f.options)).toThrow()
      expect(f.database.prepare('SELECT total_changes() AS n').get()?.n).toBe(before)
      expect(
        f.database
          .prepare("SELECT sql FROM sqlite_master WHERE name='runtime_local_identity_installation'")
          .get()?.sql,
      ).toBe(schema)
    } finally {
      f.close()
    }
  })
  it('reads empty installation history on a fresh readonly connection after every original owner closes', () => {
    const f = publicationNativeFixture()
    const identity = createLocalDeploymentIdentity(f.options)
    const maintenance = createNativeMaintenanceOwner({ database: f.database, identity, writerEpoch: 1 })
    const source = createNativePublicationSource({ database: f.database, identity, maintenance })
    const expected = source.readInstallation()
    source.close()
    maintenance.close()
    identity.close()
    f.database.close()
    const cold = new DatabaseSync(f.file, { readOnly: true })
    try {
      f.clock(() => {
        throw new Error('Historical reading must not clock')
      })
      const before = cold.prepare('SELECT total_changes() AS n').get()?.n
      const history = openNativePublicationInstallationHistory({
        database: cold,
        identityInstallationId: expected.identityInstallationId,
        deploymentDirectory: f.deploymentDirectory,
      })
      expect(history.readInstallation()).toEqual(expected)
      expect(cold.prepare('SELECT total_changes() AS n').get()?.n).toBe(before)
      cold.close()
      f.database.open()
      f.database.exec('DROP TABLE runtime_publication_contents')
      const damaged = f.database.prepare('SELECT total_changes() AS n').get()?.n
      expect(() =>
        openNativePublicationInstallationHistory({
          database: f.database,
          identityInstallationId: expected.identityInstallationId,
          deploymentDirectory: f.deploymentDirectory,
        }),
      ).toThrow()
      expect(f.database.prepare('SELECT total_changes() AS n').get()?.n).toBe(damaged)
      expect(
        f.database.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_publication_contents'").get(),
      ).toBeUndefined()
    } finally {
      if (cold.isOpen) cold.close()
      f.close()
    }
  })
  it('freezes content kind, digest and byte-size SQL constraints without issuing contents', () => {
    const f = publicationNativeFixture()
    const identity = createLocalDeploymentIdentity(f.options)
    const maintenance = createNativeMaintenanceOwner({ database: f.database, identity, writerEpoch: 1 })
    const source = createNativePublicationSource({ database: f.database, identity, maintenance })
    try {
      const insert = f.database.prepare('INSERT INTO runtime_publication_contents VALUES(?,?,?,?)')
      expect(() => insert.run('foreign', 'a'.repeat(64), 0, new Uint8Array())).toThrow()
      expect(() => insert.run('json', 'A'.repeat(64), 0, new Uint8Array())).toThrow()
      expect(() => insert.run('json', 'a'.repeat(64), -1, new Uint8Array())).toThrow()
      expect(f.database.prepare('SELECT count(*) AS n FROM runtime_publication_contents').get()?.n).toBe(0)
    } finally {
      source.close()
      maintenance.close()
      identity.close()
      f.close()
    }
  })
  it('refuses closed original maintenance and identity owners as current installation membership', () => {
    for (const closedOwner of ['maintenance', 'identity']) {
      const f = publicationNativeFixture()
      const identity = createLocalDeploymentIdentity(f.options)
      const maintenance = createNativeMaintenanceOwner({ database: f.database, identity, writerEpoch: 1 })
      const source = createNativePublicationSource({ database: f.database, identity, maintenance })
      try {
        expect(nativePublicationSourceUsesDatabase(source, f.database)).toBe(true)
        if (closedOwner === 'maintenance') maintenance.close()
        else identity.close()
        expect(nativePublicationSourceUsesDatabase(source, f.database)).toBe(false)
        expect(() => source.readInstallation()).toThrow()
      } finally {
        source.close()
        maintenance.close()
        identity.close()
        f.close()
      }
    }
  })
})
