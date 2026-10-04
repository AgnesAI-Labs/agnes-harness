import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import {
  type DataRef,
  type GeneratedAuthorSchemaSource,
  type RunAdmission,
  type RunBinding,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { createIdentityAuthority } from '../../../src/runtime/identity/authority.js'
import { createIdentityNonceOwner } from '../../../src/runtime/identity/nonce.js'
import { verifyIdentityJwt } from '../../../src/runtime/identity/verify.js'
import {
  createRuntimeAdmissionSource,
  type RuntimeAdmissionFacts,
} from '../../../src/runtime/state/admission.js'
import { canonicalJson } from '../../../src/runtime/state/canonical-json.js'
import { digestOf } from '../../../src/runtime/state/records.js'
import {
  createSessionControlClaimsOwner,
  createSessionControlConfiguration,
  type SessionControlClaimsOwner,
  type SessionControlPermissionClaims,
} from '../../../src/runtime/state/session-control-configuration.js'
import { RuntimeStateDatabase } from '../../../src/runtime/state/transactions.js'

const at = '2026-04-01T00:00:00.000Z'
const until = '2026-04-01T00:10:00.000Z'
const authority = { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 }
const scope = {
  installationId: 'installation',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
  sessionId: 'session',
  kind: 'session' as const,
}
const cleanups: Array<() => void> = []
function inline(value: Record<string, string>): DataRef {
  const text = canonicalJson(value)
  return {
    kind: 'inline',
    schema: {
      typeId: 'fixture.admission/json@1',
      revision: 1,
      digest: digestOf({ $id: 'fixture.admission/json@1', type: 'object' }),
    },
    value,
    digest: digestOf(value),
    bytes: Buffer.byteLength(text),
  }
}
async function issueIdentity(
  db: DatabaseSync,
  clockHook: () => void,
  permissionOwner: SessionControlClaimsOwner,
  additionalWorkspace?: string,
  now: () => number = () => Date.parse(at),
) {
  const identity = createIdentityAuthority(
    db,
    permissionOwner,
    () => {
      clockHook()
      return now()
    },
    (_actor, target) =>
      target.bindingId === 'controller' &&
      (canonicalJson(target.scope) === canonicalJson(scope) ||
        (additionalWorkspace !== undefined &&
          canonicalJson(target.scope) === canonicalJson({ ...scope, workspaceId: additionalWorkspace }))),
    () => true,
  )
  const signing = randomBytes(32)
  const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const p = Buffer.from(
    JSON.stringify({ iss: 'issuer', sub: 'controller', exp: Date.parse(until) / 1000 }),
  ).toString('base64url')
  const key = signing.toString('hex')
  const signature = createHmac('sha256', key).update(`${h}.${p}`).digest('base64url')
  const credential = verifyIdentityJwt(`${h}.${p}.${signature}`, {
    now: () => Date.parse(at),
    generation: 'generation',
    nonces: createIdentityNonceOwner(db),
    jwt: { issuer: 'issuer', secret: key },
  })
  if (!credential.ok) throw Error('actual JWT refused')
  const actor = await identity.accept({
    verified: credential.value,
    principalRef: 'controller',
    tenantRef: 'tenant',
    bindingId: 'controller',
    scope,
    signal: new AbortController().signal,
    source: { kind: 'deployment', generation: 'generation', keyId: 'fixture' },
  })
  if (!actor) throw Error('actual identity refused')
  const context = identity.issue(actor.authorizationRef, {
    bindingId: 'controller',
    scope,
    invocationId: 'admit',
    traceRef: 'trace',
    deadline: until,
    signal: new AbortController().signal,
  })
  if (!context) throw Error('genuine context refused')
  return { identity, actor, context }
}
export async function createSessionControlSourceFixture(
  optionsInput: Readonly<{ additionalWorkspace?: string; now?: () => number }> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-admission-'))
  const file = join(dir, 'state.sqlite')
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let hook = () => {}
  let clockHook = () => {}
  const options = {
    file,
    authority,
    now: optionsInput.now ?? (() => Date.parse(at)),
    beforeCommit: () => hook(),
  }
  const state = new RuntimeStateDatabase(options)
  cleanups.push(() => state.close())
  const db = Object.values(Object.getOwnPropertyDescriptors(state))
    .map((d) => d.value)
    .find((v) => v instanceof DatabaseSync)
  if (!(db instanceof DatabaseSync)) throw Error('genuine native State connection missing')
  db.exec(
    'CREATE TABLE runtime_admission_source_issued (source_id TEXT PRIMARY KEY, ticket_id TEXT UNIQUE NOT NULL, source_json TEXT NOT NULL, source_digest TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,decision_json TEXT,decision_digest TEXT)',
  )
  db.exec(
    'CREATE TABLE runtime_session_control_claims_issued (authorization_ref TEXT PRIMARY KEY, value_json TEXT NOT NULL)',
  )
  const permissionCodec = defineGeneratedAuthorSchema<SessionControlPermissionClaims>(permissionSchema)
  const permissionOwner = createSessionControlClaimsOwner(db, permissionCodec)
  const { identity, actor, context } = await issueIdentity(
    db,
    () => clockHook(),
    permissionOwner,
    optionsInput.additionalWorkspace,
    options.now,
  )
  const configuration = createSessionControlConfiguration({
    database: db,
    state,
    stateOptions: options,
    identity,
    parameterSchema,
    permissionOwner,
    producerCodeDigest: digestOf({ code: 'restricted-session-config' }),
    qualifiedUntil: until,
  })
  const request = configurationRequest()
  const resolved = configuration.resolve(request)
  cleanups.push(() => identity.close())
  const admission: RunAdmission = {
    ticketId: 'ticket',
    fingerprint: digestOf({ ticket: 'ticket', input: 'hello' }),
    releaseSetId: 'release',
    bindingId: 'run-binding',
    packagePinReceipt: inline({ pin: 'retained-package' }),
    runId: 'run',
    sessionId: 'session',
    lane: 'main',
    workspaceId: 'workspace',
    input: inline({ text: 'hello' }),
    admittedAt: at,
    deadline: until,
    conversation: null,
  }
  const runBinding: RunBinding = {
    bindingId: 'run-binding',
    releaseSetId: 'release',
    profileDigest: resolved.profileDigest,
    presetDigest: resolved.presetDigest,
    createdAt: at,
    minimumRecovery: 'R1',
    stateAuthorityAtCreation: authority,
    filesystemPolicy: {
      policyId: 'policy',
      digest: digestOf({ policy: 1 }),
      scope,
      compilerVersion: 'fixture',
      roots: [],
      rules: [],
    },
    telemetryConsent: {
      sessionId: 'session',
      level: 'DISABLED',
      sourceDigest: digestOf({ consent: 0 }),
      profileId: 'profile',
      recordedAt: at,
      explicitFull: false,
      evidence: 'trusted-config',
    },
    providers: [],
    jointDispatchDomains: [],
  }
  if (!validateRuntime('RunBinding', runBinding).ok) throw Error('real RunBinding codec refused')
  const facts: RuntimeAdmissionFacts = {
    sourceId: 'source',
    authority,
    admission,
    runBinding,
    pin: {
      ticketId: 'ticket',
      releaseSetId: 'release',
      bindingId: 'run-binding',
      requiredDigests: [admission.input.schema.digest],
      commitRef: inline({ commit: 'maintenance-issuance' }),
      receipt: admission.packagePinReceipt,
    },
    qualifiedUntil: until,
    scope,
    callerBindingId: 'controller',
    producerCodeDigest: digestOf({ code: 'restricted-native-ticket-issuer-v1' }),
  }
  if (!identity.current(context)) throw Error('issuer no longer authorized')
  db.prepare(
    'INSERT INTO runtime_admission_source_issued(source_id,ticket_id,source_json,source_digest) VALUES(?,?,?,?)',
  ).run(facts.sourceId, admission.ticketId, JSON.stringify(facts), digestOf(facts))
  const source = createRuntimeAdmissionSource({ database: db, identity, authority })
  state.installAdmissionSource(source)
  await state.createRun({ admission, scope }, context)
  const opened = state
  // Both owners use the original source connection; only the State writer owns business rows.
  return {
    state: opened,
    source,
    db,
    file,
    admission,
    context,
    identity,
    actor,
    setHook: (h: () => void) => {
      hook = h
    },
    setClock: (h: () => void) => {
      clockHook = h
    },
    legacy: state,
    close() {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    },
    options,
    request,
    configuration,
    permissionCodec,
    permissionOwner,
    parameterSchema,
  }
}

const parameterSchema: GeneratedAuthorSchemaSource = {
  ownerPackageId: 'fixture.session',
  name: 'Parameters',
  typeId: 'fixture.session/parameters@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/Parameters',
    $defs: {
      Parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
}
const permissionSchema: GeneratedAuthorSchemaSource = {
  ownerPackageId: 'fixture.session',
  name: 'Permission',
  typeId: 'fixture.session/permission@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/Permission',
    $defs: {
      Permission: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          principalRef: { type: 'string' },
        },
        required: ['sessionId', 'principalRef'],
      },
    },
  },
}
function configurationRequest() {
  const codec = defineGeneratedAuthorSchema<unknown>(parameterSchema)
  const preset = {
    $schema: 'https://agnes.ai/schema/runtime/v1/preset.schema.json',
    kind: 'agh.preset',
    schemaVersion: '1.0',
    id: 'base',
    revision: 1,
    selections: [],
    configOverrides: [],
    parameters: { schema: codec.ref, value: { name: 'base' } },
    restrictions: {
      capabilityCeiling: [],
      minimumRecovery: 'R0',
      allowedIsolation: ['trusted-in-process'],
      limits: { MAX_ID_BYTES: 256 },
    },
  }
  const profile = {
    $schema: 'https://agnes.ai/schema/runtime/v1/profile.schema.json',
    kind: 'agh.profile',
    schemaVersion: '1.0',
    id: 'profile',
    revision: 1,
    requiredContractSet: 'agh.runtime/full-v1',
    packages: [],
    selections: [],
    providerConfigs: [],
    selectionPolicy: [],
    presets: { default: 'base', allowed: [{ presetId: 'base', digest: digestOf(preset) }] },
    policy: {
      capabilityCeiling: [],
      minimumRecovery: 'R0',
      allowedIsolation: ['trusted-in-process'],
      sourcePolicy: { allowLocal: false, npmRegistries: [], gitOrigins: [], allowBuildScripts: false },
      grants: [
        {
          provider: { packageId: 'agnes-host', providerId: 'agh.default/config' },
          decision: 'ask',
          capabilities: [],
          resourceScopes: [],
        },
      ],
    },
    limits: { MAX_ID_BYTES: 256 },
    client: {
      rendererSelections: [],
      requiredTargets: ['sdk'],
      shell: { packageId: 'agnes-host', contributionId: 'shell' },
      registry: { packageId: 'agnes-host', contributionId: 'registry' },
      fallbackRenderer: { packageId: 'agnes-host', contributionId: 'fallback' },
    },
    storage: { dataDir: '/var/agnes/data', cacheDir: '/var/agnes/cache' },
    overrides: { allowWorkspaceRestrictions: false, sessionParametersSchema: codec.ref },
  }
  const leaf = { ...preset, id: 'leaf', extends: { presetId: preset.id, digest: digestOf(preset) } }
  profile.presets.default = 'leaf'
  profile.presets.allowed.push({ presetId: 'leaf', digest: digestOf(leaf) })
  const selectedProfile = {
    ...profile,
    id: 'selected-profile',
    revision: 2,
    extends: { profileId: profile.id, digest: digestOf(profile) },
  }
  const bind = (sourceRef: string, document: unknown) => ({
    source: { sourceRef, revision: 1, digest: digestOf(document) },
    document,
  })
  return {
    algorithm: 'agh.config/resolve-v1',
    defaults: { profile: bind('profile', profile), preset: bind('preset', preset) },
    profiles: [bind('selected-profile', selectedProfile)],
    presets: [bind('leaf', leaf)],
    managed: null,
    workspace: null,
    session: null,
  }
}
