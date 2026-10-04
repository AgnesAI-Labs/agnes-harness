import { jcs } from '@agnes/protocol'
import type {
  AuthorityDirectoryCompareAndSwapRequest,
  AuthorityDirectoryCompareAndSwapResult,
  AuthorityDirectoryReadRequest,
  AuthorityDirectoryReadResult,
  AuthorityFence,
  AuthorityPublication,
  AuthorityRoute,
  DataRef,
  JointDispatchMigrationMapping,
  JsonValue,
  StateAuthorityRef,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'

export interface StoredRoute {
  readonly revision: number
  readonly route: AuthorityRoute
}

export interface StoredDomain {
  readonly revision: number
  readonly current: JointDispatchMigrationMapping
}

export interface Activation {
  readonly logicalAuthorityId: string
  readonly authorityEpoch: number
  readonly cutoverId: string
}

/** Live directory head. Historical cutover results stay outside this object. */
export interface DirectoryHead {
  readonly writerEpoch: number
  readonly directoryEpoch: number
  readonly locatorEpoch: number
  readonly migrationId: string | null
  readonly fenced: boolean
  readonly authority: StateAuthorityRef
  readonly routes: Readonly<Record<string, StoredRoute>>
  readonly domains: Readonly<Record<string, StoredDomain>>
  readonly activations: readonly Activation[]
}

export interface PublicationRefusal {
  readonly code: 'invalid_input' | 'conflict' | 'incompatible' | 'denied' | 'cancelled' | 'retryable'
  readonly detailCode: string
}

type PublicationStop = { readonly kind: 'refuse'; readonly refusal: PublicationRefusal }

export type PublicationDecision =
  | { readonly kind: 'replay'; readonly result: AuthorityDirectoryCompareAndSwapResult }
  | PublicationStop
  | {
      readonly kind: 'commit'
      readonly result: AuthorityDirectoryCompareAndSwapResult
      readonly head: DirectoryHead
      readonly fingerprint: string
    }

export function emptyHead(authority: StateAuthorityRef, locatorEpoch: number): DirectoryHead {
  return {
    writerEpoch: 1,
    directoryEpoch: authority.authorityEpoch,
    locatorEpoch,
    fenced: false,
    migrationId: null,
    authority,
    routes: {},
    domains: {},
    activations: [],
  }
}

export function publicationFingerprint(request: AuthorityDirectoryCompareAndSwapRequest): string {
  return canonicalJsonDigest(cloneJson(request))
}

export function sameAuthority(left: StateAuthorityRef, right: StateAuthorityRef): boolean {
  return (
    left.authorityId === right.authorityId &&
    left.tenantId === right.tenantId &&
    left.authorityEpoch === right.authorityEpoch
  )
}

export function routeDigest(route: AuthorityRoute): string {
  return canonicalJsonDigest(cloneJson(route))
}

export function inlineData(value: JsonValue, typeId: string): DataRef {
  const digest = canonicalJsonDigest(value)
  return {
    kind: 'inline',
    schema: { typeId, revision: 1, digest },
    value,
    digest,
    bytes: Buffer.byteLength(jcs(value)),
  }
}

export function compareAuthorityId(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

export function decidePublication(
  head: DirectoryHead,
  request: AuthorityDirectoryCompareAndSwapRequest,
  existing: { readonly fingerprint: string; readonly result: AuthorityDirectoryCompareAndSwapResult } | null,
  journal: {
    readonly validationDigest: string
    readonly authorityIds: readonly string[]
    readonly sourceFences?: readonly AuthorityFence[]
  } | null,
): PublicationDecision {
  if (request.transactionId !== request.publication.cutoverId) {
    return refuse('invalid_input', 'cutover_transaction_mismatch')
  }
  const fingerprint = publicationFingerprint(request)
  if (existing) {
    if (existing.fingerprint !== fingerprint) return refuse('conflict', 'cutover_identity_conflict')
    return { kind: 'replay', result: existing.result }
  }
  if (head.fenced) return refuse('conflict', 'directory_fenced')
  if (!sameAuthority(head.authority, request.authority)) return refuse('conflict', 'directory_authority')
  if (request.expectedWriterEpoch !== head.writerEpoch) return refuse('conflict', 'writer_epoch')
  if (!journal) return refuse('incompatible', 'upgrade_not_journaled')
  if (journal.validationDigest !== canonicalJsonDigest(cloneJson(request.publication.validationRef))) {
    return refuse('incompatible', 'validation_mismatch')
  }
  const structural = inspectPublication(head, request.publication, journal.authorityIds)
  if (structural.kind === 'refuse') return structural
  const revision = revisionsMatch(head, structural.changes)
  if (revision.kind === 'refuse') return revision
  const registered = new Set(
    (journal.sourceFences ?? []).map((fence) => canonicalJsonDigest(cloneJson(fence))),
  )
  if (
    request.publication.sourceFences.some((fence) => !registered.has(canonicalJsonDigest(cloneJson(fence))))
  )
    return refuse('incompatible', 'fence_not_registered')
  const result = buildResult(request, revision.revisions)
  const headNext = applyCommit(head, structural.changes, structural.domains)
  return { kind: 'commit', result, head: headNext, fingerprint }
}

export function decideRead(
  head: DirectoryHead,
  request: AuthorityDirectoryReadRequest,
  hasOrigin: (domainId: string, digest: string) => boolean,
):
  | { readonly kind: 'value'; readonly value: AuthorityDirectoryReadResult }
  | { readonly kind: 'refuse'; readonly refusal: PublicationRefusal } {
  if (request.kind === 'authority') {
    const stored = own(head.routes, request.logicalAuthorityId)
    if (!stored) return refuse('incompatible', 'route_absent')
    return {
      kind: 'value',
      value: {
        kind: 'authority',
        route: stored.route,
        revision: stored.revision,
        epoch: stored.route.authorityEpoch,
      },
    }
  }
  if (request.domainId !== request.from.domainId) return refuse('invalid_input', 'joint_domain')
  const domain = own(head.domains, request.domainId)
  if (!domain) {
    return { kind: 'value', value: { kind: 'joint-dispatch', resolution: { state: 'unmapped' } } }
  }
  const wanted = canonicalJsonDigest(cloneJson(request.from))
  if (!hasOrigin(request.domainId, wanted)) return refuse('incompatible', 'joint_chain_broken')
  const current = domain.current
  const stateRoute = memberRoute(head, current.to.stateAuthority.authorityId)
  const budgetRoute = memberRoute(head, current.to.budgetAuthority.authorityId)
  if (
    !stateRoute ||
    !budgetRoute ||
    stateRoute.route.authorityEpoch !== current.to.stateAuthority.authorityEpoch ||
    budgetRoute.route.authorityEpoch !== current.to.budgetAuthority.authorityEpoch ||
    stateRoute.route.tenantId !== current.to.stateAuthority.tenantId ||
    budgetRoute.route.tenantId !== current.to.budgetAuthority.tenantId
  ) {
    return refuse('incompatible', 'joint_chain_broken')
  }
  if (!sameBinding(stateRoute.route.providerBinding, current.to.stateBinding)) {
    return refuse('incompatible', 'joint_binding')
  }
  if (!sameBinding(budgetRoute.route.providerBinding, current.to.budgetBinding)) {
    return refuse('incompatible', 'joint_binding')
  }
  if (!activated(head, stateRoute.route) || !activated(head, budgetRoute.route)) {
    return refuse('incompatible', 'joint_member_inactive')
  }
  return {
    kind: 'value',
    value: {
      kind: 'joint-dispatch',
      resolution: {
        state: 'mapped',
        qualification: current.to,
        revision: domain.revision,
        validationRef: current.validationRef,
      },
    },
  }
}

export function seedHead(head: DirectoryHead, route: AuthorityRoute): DirectoryHead | PublicationRefusal {
  if (own(head.routes, route.logicalAuthorityId)) return { code: 'conflict', detailCode: 'route_exists' }
  if (route.authorityEpoch < 1) return { code: 'invalid_input', detailCode: 'epoch_not_increasing' }
  if (route.authorityEpoch !== 1) return { code: 'invalid_input', detailCode: 'bootstrap_epoch' }
  if (route.checkpoint.authorityId !== route.logicalAuthorityId || route.checkpoint.authorityEpoch !== 1)
    return { code: 'invalid_input', detailCode: 'checkpoint_mismatch' }
  return {
    ...head,
    routes: { ...head.routes, [route.logicalAuthorityId]: { revision: 1, route } },
  }
}

export function activateHead(
  head: DirectoryHead,
  activation: Activation,
): DirectoryHead | PublicationRefusal {
  const stored = own(head.routes, activation.logicalAuthorityId)
  if (!stored) return { code: 'incompatible', detailCode: 'route_absent' }
  if (
    stored.route.authorityEpoch !== activation.authorityEpoch ||
    stored.route.cutoverId !== activation.cutoverId
  ) {
    return { code: 'conflict', detailCode: 'activation_mismatch' }
  }
  if (activated(head, stored.route)) return head
  return {
    ...head,
    activations: [
      ...head.activations.filter((item) => item.logicalAuthorityId !== activation.logicalAuthorityId),
      activation,
    ],
  }
}

export function fenceHead(head: DirectoryHead): DirectoryHead {
  if (head.fenced) return head
  return { ...head, fenced: true }
}

export function unfenceHead(head: DirectoryHead): DirectoryHead {
  if (!head.fenced) return head
  return { ...head, fenced: false }
}

/** The copied directory becomes writable at the new locator epoch. The source copy stays fenced. */
export function retargetLocator(head: DirectoryHead, locatorEpoch: number): DirectoryHead {
  return { ...head, locatorEpoch, directoryEpoch: locatorEpoch, fenced: false, migrationId: null }
}

function inspectPublication(
  head: DirectoryHead,
  publication: AuthorityPublication,
  journalAuthorities: readonly string[],
):
  | {
      readonly kind: 'ok'
      readonly changes: readonly AuthorityPublication['changes'][number][]
      readonly domains: DirectoryHead['domains']
    }
  | PublicationStop {
  const seen = new Set<string>()
  for (const change of publication.changes) {
    if (seen.has(change.previous.logicalAuthorityId)) return refuse('invalid_input', 'duplicate_authority')
    seen.add(change.previous.logicalAuthorityId)
    const identity = changeIdentity(change, publication.cutoverId)
    if (identity) return refuse(identity.code, identity.detailCode)
    if (!journalAuthorities.includes(change.previous.logicalAuthorityId)) {
      return refuse('incompatible', 'journal_authority')
    }
  }
  if (seen.size !== journalAuthorities.length) return refuse('incompatible', 'journal_authority')
  const fences = fenceSet(publication)
  if (fences.kind === 'refuse') return fences
  for (const change of publication.changes) {
    const key = fenceKey(change.previous)
    if (!fences.keys.has(key)) return refuse('incompatible', 'fence_incomplete')
  }
  if (fences.keys.size !== seen.size) return refuse('incompatible', 'fence_incomplete')
  const domains = domainUpdates(head, publication)
  if (domains.kind === 'refuse') return domains
  const partial = partialJoint(head, publication, domains.domains)
  if (partial) return refuse('incompatible', 'joint_partial_publication')
  return { kind: 'ok', changes: publication.changes, domains: domains.domains }
}

function changeIdentity(
  change: AuthorityPublication['changes'][number],
  cutoverId: string,
): PublicationRefusal | null {
  const previous = change.previous
  const next = change.next
  if (previous.logicalAuthorityId !== next.logicalAuthorityId || previous.tenantId !== next.tenantId) {
    return { code: 'invalid_input', detailCode: 'route_identity' }
  }
  if (next.authorityEpoch <= previous.authorityEpoch) {
    return { code: 'invalid_input', detailCode: 'epoch_not_increasing' }
  }
  if (
    next.previous === null ||
    next.previous.authorityEpoch !== previous.authorityEpoch ||
    next.previous.locationRef !== previous.locationRef ||
    next.previous.cutoverId !== previous.cutoverId
  ) {
    return { code: 'invalid_input', detailCode: 'previous_link' }
  }
  if (next.cutoverId !== cutoverId) return { code: 'invalid_input', detailCode: 'cutover_link' }
  if (
    next.checkpoint.authorityId !== next.logicalAuthorityId ||
    next.checkpoint.authorityEpoch !== next.authorityEpoch
  ) {
    return { code: 'invalid_input', detailCode: 'checkpoint_mismatch' }
  }
  return null
}

function fenceSet(
  publication: AuthorityPublication,
): { readonly kind: 'ok'; readonly keys: ReadonlySet<string> } | PublicationStop {
  const keys = new Set<string>()
  for (const fence of publication.sourceFences) {
    const refusal = fenceShape(fence, publication.upgradeId)
    if (refusal) return refuse(refusal.code, refusal.detailCode)
    const key = `${fence.source.authorityId}\0${fence.source.tenantId}\0${fence.source.authorityEpoch}`
    if (keys.has(key)) return refuse('invalid_input', 'duplicate_fence')
    keys.add(key)
  }
  return { kind: 'ok', keys }
}

function fenceShape(fence: AuthorityFence, upgradeId: string): PublicationRefusal | null {
  if (fence.upgradeId !== upgradeId) return { code: 'invalid_input', detailCode: 'fence_upgrade' }
  if (!fence.writerCredentialsRevoked) return { code: 'incompatible', detailCode: 'fence_open' }
  if (
    fence.checkpoint.authorityId !== fence.source.authorityId ||
    fence.checkpoint.authorityEpoch !== fence.source.authorityEpoch
  ) {
    return { code: 'invalid_input', detailCode: 'checkpoint_mismatch' }
  }
  return null
}

function fenceKey(route: AuthorityRoute): string {
  return `${route.logicalAuthorityId}\0${route.tenantId}\0${route.authorityEpoch}`
}

function revisionsMatch(
  head: DirectoryHead,
  changes: readonly AuthorityPublication['changes'][number][],
): { readonly kind: 'ok'; readonly revisions: ReadonlyMap<string, number> } | PublicationStop {
  const revisions = new Map<string, number>()
  for (const change of changes) {
    const stored = own(head.routes, change.previous.logicalAuthorityId)
    if (
      !stored ||
      stored.revision !== change.expectedRevision ||
      routeDigest(stored.route) !== routeDigest(change.previous)
    ) {
      return refuse('conflict', 'revision_mismatch')
    }
    if (change.next.cutoverId !== changes[0]?.next.cutoverId) return refuse('invalid_input', 'cutover_link')
    revisions.set(change.previous.logicalAuthorityId, stored.revision + 1)
  }
  return { kind: 'ok', revisions }
}

function buildResult(
  request: AuthorityDirectoryCompareAndSwapRequest,
  revisions: ReadonlyMap<string, number>,
): AuthorityDirectoryCompareAndSwapResult {
  const routes = request.publication.changes.map((change) => ({
    logicalAuthorityId: change.next.logicalAuthorityId,
    revision: revisions.get(change.next.logicalAuthorityId) ?? 0,
    authorityEpoch: change.next.authorityEpoch,
  }))
  routes.sort((left, right) => compareAuthorityId(left.logicalAuthorityId, right.logicalAuthorityId))
  return { transactionId: request.transactionId, cutoverId: request.publication.cutoverId, routes }
}

function applyCommit(
  head: DirectoryHead,
  changes: readonly AuthorityPublication['changes'][number][],
  domains: DirectoryHead['domains'],
): DirectoryHead {
  const routes: Record<string, StoredRoute> = Object.assign(Object.create(null), head.routes)
  for (const change of changes) {
    const stored = routes[change.previous.logicalAuthorityId]
    routes[change.previous.logicalAuthorityId] = {
      revision: (stored?.revision ?? 0) + 1,
      route: change.next,
    }
  }
  return {
    ...head,
    routes,
    domains,
    activations: head.activations.filter(
      (item) => !changes.some((change) => change.next.logicalAuthorityId === item.logicalAuthorityId),
    ),
  }
}

function domainUpdates(
  head: DirectoryHead,
  publication: AuthorityPublication,
): { readonly kind: 'ok'; readonly domains: DirectoryHead['domains'] } | PublicationStop {
  const domains: Record<string, StoredDomain> = Object.assign(Object.create(null), head.domains)
  const seen = new Set<string>()
  for (const mapping of publication.jointDispatchMappings) {
    if (seen.has(mapping.domainId)) return refuse('invalid_input', 'duplicate_authority')
    seen.add(mapping.domainId)
    if (mapping.domainId !== mapping.from.domainId || mapping.domainId !== mapping.to.domainId) {
      return refuse('invalid_input', 'joint_domain')
    }
    if (mapping.to.revision <= mapping.from.revision) return refuse('invalid_input', 'epoch_not_increasing')
    const state = findChange(publication, mapping.to.stateAuthority.authorityId)
    const budget = findChange(publication, mapping.to.budgetAuthority.authorityId)
    if (!state || !budget) return refuse('invalid_input', 'joint_member')
    if (
      !memberMatches(state.next, mapping.to.stateAuthority, mapping.to.stateBinding, mapping.cohortDigest)
    ) {
      return refuse('incompatible', 'joint_binding')
    }
    if (
      !memberMatches(budget.next, mapping.to.budgetAuthority, mapping.to.budgetBinding, mapping.cohortDigest)
    ) {
      return refuse('incompatible', 'joint_binding')
    }
    if (
      !sameMember(state.previous, mapping.from.stateAuthority, mapping.from.stateBinding) ||
      !sameMember(budget.previous, mapping.from.budgetAuthority, mapping.from.budgetBinding)
    )
      return refuse('incompatible', 'joint_chain_broken')
    if (
      canonicalJsonDigest(cloneJson(mapping.validationRef)) !==
      canonicalJsonDigest(cloneJson(publication.validationRef))
    )
      return refuse('incompatible', 'validation_mismatch')
    const prior = own(domains, mapping.domainId)
    if (prior) {
      const tail = prior.current
      if (!tail || canonicalJsonDigest(cloneJson(tail.to)) !== canonicalJsonDigest(cloneJson(mapping.from))) {
        return refuse('incompatible', 'joint_chain_broken')
      }
    } else if (
      !sameMember(state.previous, mapping.from.stateAuthority, mapping.from.stateBinding) ||
      !sameMember(budget.previous, mapping.from.budgetAuthority, mapping.from.budgetBinding)
    ) {
      return refuse('incompatible', 'joint_chain_broken')
    }
    domains[mapping.domainId] = { revision: (prior?.revision ?? 0) + 1, current: mapping }
  }
  return { kind: 'ok', domains }
}

function partialJoint(
  head: DirectoryHead,
  publication: AuthorityPublication,
  domains: DirectoryHead['domains'],
): boolean {
  for (const change of publication.changes) {
    for (const [domainId, domain] of Object.entries(head.domains)) {
      const tail = domain.current
      if (!tail) continue
      const ids = [tail.to.stateAuthority.authorityId, tail.to.budgetAuthority.authorityId]
      if (!ids.includes(change.previous.logicalAuthorityId)) continue
      if (domains[domainId] === domain) return true
    }
  }
  return false
}

function findChange(publication: AuthorityPublication, authorityId: string) {
  return publication.changes.find((change) => change.previous.logicalAuthorityId === authorityId)
}

function sameMember(
  route: AuthorityRoute,
  authority: StateAuthorityRef,
  binding: AuthorityRoute['providerBinding'],
): boolean {
  return (
    route.logicalAuthorityId === authority.authorityId &&
    route.tenantId === authority.tenantId &&
    route.authorityEpoch === authority.authorityEpoch &&
    sameBinding(route.providerBinding, binding)
  )
}

function memberMatches(
  route: AuthorityRoute,
  authority: StateAuthorityRef,
  binding: AuthorityRoute['providerBinding'],
  cohortDigest: string,
): boolean {
  return (
    route.logicalAuthorityId === authority.authorityId &&
    route.tenantId === authority.tenantId &&
    route.authorityEpoch === authority.authorityEpoch &&
    sameBinding(route.providerBinding, binding) &&
    route.cohortDigest === cohortDigest
  )
}

function memberRoute(head: DirectoryHead, authorityId: string): StoredRoute | undefined {
  return own(head.routes, authorityId)
}

function activated(head: DirectoryHead, route: AuthorityRoute): boolean {
  return head.activations.some(
    (item) =>
      item.logicalAuthorityId === route.logicalAuthorityId &&
      item.authorityEpoch === route.authorityEpoch &&
      item.cutoverId === route.cutoverId,
  )
}

function sameBinding(
  left: AuthorityRoute['providerBinding'],
  right: AuthorityRoute['providerBinding'],
): boolean {
  return (
    left.bindingId === right.bindingId &&
    left.contract === right.contract &&
    left.logicalName === right.logicalName &&
    left.providerId === right.providerId
  )
}

function refuse(code: PublicationRefusal['code'], detailCode: string): PublicationStop {
  return { kind: 'refuse', refusal: { code, detailCode } }
}

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

function cloneJson<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
