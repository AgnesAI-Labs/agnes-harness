import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import {
  type AuthoringCandidate,
  type AuthoringCandidateSummary,
  type AuthoringFile,
  type AuthoringOrigin,
  type AuthoringTests,
  jcs,
  validatePackageAdminData,
} from '@agnes/protocol'
import {
  authoringDirectory,
  authoringError,
  authoringFiles,
  authoringHash,
  readAuthoringFiles,
  saveAuthoringRecord,
  writeAuthoringFiles,
} from './authoring-files.js'
import type { PackageManager } from './manager.js'
import { hashDirectory } from './sources.js'

type Record = {
  owner: string
  createHash: string
  value: AuthoringCandidate
  tree: string
  snapshot?: string
}
export type AuthoringTestRunner = (
  directory: string,
  files: readonly AuthoringFile[],
  signal: AbortSignal,
) => Promise<Omit<AuthoringTests, 'hash' | 'completedAt'>>
export class AuthoringCandidates {
  private readonly publications = new Set<string>()
  private readonly tails = new Map<string, Promise<unknown>>()
  constructor(
    private readonly manager: PackageManager,
    private readonly testRunner: AuthoringTestRunner,
  ) {}
  private root(profileDir: string) {
    return join(profileDir, '.authoring-candidates')
  }
  private path(profileDir: string, id: string) {
    if (!/^candidate-[a-f0-9]{32}$/.test(id)) authoringError('Candidate id is invalid')
    return join(this.root(profileDir), id, 'record.json')
  }
  private save(profileDir: string, record: Record) {
    saveAuthoringRecord(this.path(profileDir, record.value.candidateId), record)
  }
  private load(profileDir: string, id: string, owner: string, readOnly = false): Record {
    const file = this.path(profileDir, id)
    if (!existsSync(file) || lstatSync(file).isSymbolicLink() || lstatSync(file).size > 8388608)
      authoringError('Candidate is unavailable')
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record
    if (
      record.owner !== owner ||
      record.value.candidateId !== id ||
      !validatePackageAdminData('AuthoringCandidate', record.value).ok
    )
      authoringError('Candidate is unavailable')
    if (
      typeof record.tree !== 'string' ||
      resolve(record.tree) !== record.tree ||
      !record.tree.startsWith(join(this.root(profileDir), id, 'trees') + sep) ||
      (record.snapshot !== undefined &&
        (resolve(record.snapshot) !== record.snapshot ||
          !record.snapshot.startsWith(join(this.root(profileDir), id, 'reviews') + sep)))
    )
      authoringError('Candidate storage is invalid')
    for (const directory of [record.tree, record.snapshot].filter((p): p is string => p !== undefined)) {
      for (let cursor = directory; cursor !== profileDir; cursor = dirname(cursor)) {
        authoringDirectory(cursor)
      }
    }
    if (record.value.state === 'publishing' && !this.publications.has(id)) {
      record.value.state = 'interrupted'
      record.value.message = 'Publication interrupted; inspect actual package state before retrying'
      if (!readOnly) this.save(profileDir, record)
    }
    return record
  }
  private verify(record: Record, expected: string) {
    if (record.value.candidateHash !== expected || hashDirectory(record.tree, { exclude: [] }) !== expected)
      authoringError('Candidate changed; test and request a new review')
  }
  async serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve(),
      task = prior.catch(() => undefined).then(run)
    this.tails.set(key, task)
    try {
      return await task
    } finally {
      if (this.tails.get(key) === task) this.tails.delete(key)
    }
  }
  list(profileDir: string, owner: string): AuthoringCandidateSummary[] {
    const root = this.root(profileDir)
    if (!existsSync(root)) return []
    authoringDirectory(root)
    return readdirSync(root)
      .filter((id) => /^candidate-[a-f0-9]{32}$/.test(id))
      .slice(0, 128)
      .flatMap((id) => {
        const record = this.load(profileDir, id, owner)
        const { candidateId, packageId, candidateHash, state } = this.project(record, profileDir)
        return [{ candidateId, packageId, candidateHash, state }]
      })
  }
  private project(record: Record, profileDir: string): AuthoringCandidate {
    const actual = hashDirectory(record.tree, { exclude: [] })
    if (
      actual !== record.value.candidateHash &&
      !['published', 'rejected', 'publishing', 'interrupted'].includes(record.value.state)
    ) {
      record.value = {
        ...record.value,
        candidateHash: actual,
        state: 'draft',
        reviewHash: null,
        tests: null,
        preview: null,
        reviewer: null,
        message: 'Candidate changed; test and request a new review',
        sourceFiles: readAuthoringFiles(record.tree),
        files: readAuthoringFiles(record.tree).map((f) => ({ path: f.path, before: null, after: f.content })),
      }
      delete record.snapshot
      this.save(profileDir, record)
    }
    const value = structuredClone(record.value)
    return value
  }
  /** Fact-chain reads never reset drafts or persist interrupted-publication recovery. */
  evidence(profileDir: string, id: string, owner: string): AuthoringCandidate {
    const record = this.load(profileDir, id, owner, true)
    const value = record.value
    const tree = ['published', 'rejected', 'publishing', 'interrupted'].includes(value.state)
      ? (record.snapshot ?? record.tree)
      : record.tree
    if (
      hashDirectory(tree, { exclude: [] }) !== value.candidateHash ||
      (value.reviewHash !== null && this.reviewDigest(value) !== value.reviewHash)
    )
      authoringError('Candidate evidence is unavailable')
    return structuredClone(value)
  }
  show(profileDir: string, id: string, owner: string) {
    return this.project(this.load(profileDir, id, owner), profileDir)
  }
  async create(
    profileDir: string,
    files: readonly AuthoringFile[],
    owner: string,
    commandKey: string,
    origin: AuthoringOrigin,
  ): Promise<AuthoringCandidate> {
    const checked = authoringFiles(files),
      createHash = authoringHash(jcs({ files: checked, origin }))
    const id = 'candidate-' + authoringHash(commandKey).slice(7, 39),
      file = this.path(profileDir, id)
    if (existsSync(file)) {
      const old = this.load(profileDir, id, owner)
      if (old.createHash !== createHash) authoringError('Candidate command id conflicts')
      return this.project(old, profileDir)
    }
    if (
      existsSync(this.root(profileDir)) &&
      readdirSync(this.root(profileDir)).filter((x) => x.startsWith('candidate-')).length >= 128
    )
      authoringError('Candidate limit reached')
    const tree = join(this.root(profileDir), id, 'trees', randomUUID())
    writeAuthoringFiles(tree, checked)
    const source = { type: 'file' as const, ref: 'file:' + tree },
      preview = await this.manager.inspect(profileDir, source)
    const installed = (await this.manager.inventory(profileDir)).packages.find((p) => p.id === preview.id)
    const candidateHash = hashDirectory(tree, { exclude: [] })
    if (preview.integrity !== candidateHash) authoringError('Candidate source changed during inspection')
    const record: Record = {
      owner,
      createHash,
      tree,
      value: {
        candidateId: id,
        packageId: preview.id,
        candidateHash,
        baseHash: installed?.entry.integrity ?? null,
        reviewHash: null,
        state: 'draft',
        sourceFiles: checked,
        files: checked.map((f) => ({ path: f.path, before: null, after: f.content })),
        preview: null,
        tests: null,
        origin,
        installer: 'agent',
        reviewer: null,
        message: '',
      },
    }
    this.save(profileDir, record)
    return this.project(record, profileDir)
  }
  async write(
    profileDir: string,
    id: string,
    owner: string,
    expected: string,
    files: readonly AuthoringFile[],
  ) {
    const record = this.load(profileDir, id, owner)
    this.verify(record, expected)
    if (['published', 'rejected', 'publishing', 'interrupted'].includes(record.value.state))
      authoringError('Candidate is terminal; create another candidate')
    const tree = join(this.root(profileDir), id, 'trees', randomUUID())
    writeAuthoringFiles(tree, files)
    const preview = await this.manager.inspect(profileDir, { type: 'file', ref: 'file:' + tree })
    if (preview.id !== record.value.packageId) authoringError('Candidate package identity cannot change')
    record.tree = tree
    record.value = {
      ...record.value,
      candidateHash: hashDirectory(tree, { exclude: [] }),
      state: 'draft',
      reviewHash: null,
      preview: null,
      tests: null,
      reviewer: null,
      message: '',
      sourceFiles: authoringFiles(files),
      files: authoringFiles(files).map((f) => ({ path: f.path, before: null, after: f.content })),
    }
    delete record.snapshot
    this.save(profileDir, record)
    return this.project(record, profileDir)
  }
  async test(profileDir: string, id: string, owner: string, expected: string, signal: AbortSignal) {
    const record = this.load(profileDir, id, owner)
    this.verify(record, expected)
    if (['published', 'rejected', 'publishing', 'interrupted'].includes(record.value.state))
      authoringError('Candidate is terminal')
    const files = readAuthoringFiles(record.tree),
      work = join(this.root(profileDir), id, 'tests', randomUUID())
    writeAuthoringFiles(work, files)
    // Revoke an older review before any test code runs.
    record.value.reviewHash = null
    record.value.state = 'draft'
    record.value.tests = null
    this.save(profileDir, record)
    const result = await this.testRunner(work, files, signal)
    this.verify(record, expected)
    if (hashDirectory(work) !== expected)
      authoringError('Tests changed their source; passing results cannot be retained')
    record.value.tests = { ...result, hash: expected, completedAt: new Date().toISOString() }
    record.value.state = result.state === 'passed' ? 'tested' : 'failed'
    this.save(profileDir, record)
    return this.project(record, profileDir)
  }
  async submit(profileDir: string, id: string, owner: string, expected: string) {
    const record = this.load(profileDir, id, owner)
    this.verify(record, expected)
    if (
      !['tested', 'review'].includes(record.value.state) ||
      record.value.tests?.state !== 'passed' ||
      record.value.tests.hash !== expected
    )
      authoringError('Passing tests for this exact candidate are required')
    const installed = (await this.manager.inventory(profileDir)).packages.find(
      (p) => p.id === record.value.packageId,
    )
    if ((installed?.entry.integrity ?? null) !== record.value.baseHash)
      authoringError('Installed version changed; draft a new candidate')
    const next = readAuthoringFiles(record.tree),
      before = installed?.directory ? readAuthoringFiles(installed.directory) : []
    const paths = [...new Set([...next, ...before].map((f) => f.path))].sort()
    const snapshot = join(this.root(profileDir), id, 'reviews', randomUUID())
    writeAuthoringFiles(snapshot, next)
    const preview = await this.manager.inspect(profileDir, { type: 'file', ref: 'file:' + snapshot })
    if (preview.integrity !== expected || preview.blockers.length || !preview.capabilityHash)
      authoringError('Candidate inspection is blocked or changed')
    record.snapshot = snapshot
    record.value.files = paths.flatMap((path) => {
      const a = before.find((f) => f.path === path)?.content ?? null,
        b = next.find((f) => f.path === path)?.content ?? null
      return a === b ? [] : [{ path, before: a, after: b }]
    })
    record.value.preview = {
      ...preview,
      source: { type: 'file', ref: 'file:./reviewed-candidate' },
      provenance: {
        ...preview.provenance,
        installer: 'agent',
        source: { type: 'file', ref: 'file:./reviewed-candidate' },
        resolvedLocation: 'reviewed candidate',
      },
    }
    record.value.reviewHash = this.reviewDigest(record.value)
    record.value.state = 'review'
    this.save(profileDir, record)
    return this.project(record, profileDir)
  }
  private reviewDigest(value: AuthoringCandidate) {
    return authoringHash(
      jcs({
        baseHash: value.baseHash,
        candidateHash: value.candidateHash,
        files: value.files,
        preview: value.preview,
        tests: value.tests,
        origin: value.origin,
      }),
    )
  }
  async decide(
    profileDir: string,
    id: string,
    owner: string,
    expected: string,
    reviewHash: string,
    approve: boolean,
    publish: (source: { type: 'file'; ref: string }, value: AuthoringCandidate) => Promise<void>,
  ) {
    const record = this.load(profileDir, id, owner)
    this.verify(record, expected)
    if (record.value.state === 'published' && record.value.reviewHash === reviewHash)
      return this.project(record, profileDir)
    if (
      record.value.state !== 'review' ||
      record.value.reviewHash !== reviewHash ||
      this.reviewDigest(record.value) !== reviewHash ||
      record.value.tests?.state !== 'passed' ||
      record.value.tests.hash !== expected ||
      !record.snapshot ||
      hashDirectory(record.snapshot, { exclude: [] }) !== expected
    )
      authoringError('Review is stale; test and request a new review')
    const installed = (await this.manager.inventory(profileDir)).packages.find(
      (p) => p.id === record.value.packageId,
    )
    if ((installed?.entry.integrity ?? null) !== record.value.baseHash)
      authoringError('Installed version changed since review')
    if (!approve) {
      record.value.state = 'rejected'
      record.value.reviewer = owner
      this.save(profileDir, record)
      return this.project(record, profileDir)
    }
    record.value.state = 'publishing'
    record.value.reviewer = owner
    this.save(profileDir, record)
    this.publications.add(id)
    try {
      await publish({ type: 'file', ref: 'file:' + record.snapshot }, record.value)
      record.value.state = 'published'
      record.value.message =
        'Published. Executable tools and plugin code are available in new sessions; existing sessions keep their pins. Approved live resources refresh at turn boundaries.'
    } catch (error) {
      record.value.state = 'failed'
      record.value.message = 'Publication failed; inspect actual package state'
      this.save(profileDir, record)
      this.publications.delete(id)
      throw error
    }
    this.publications.delete(id)
    this.save(profileDir, record)
    return this.project(record, profileDir)
  }
}
