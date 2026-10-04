import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { DomainView, RendererDefinition } from '@agnes/extension-api/client'
import {
  type BuildIdentity,
  type ConformanceHarness,
  providerFileForContract,
} from '@agnes/extension-api/testkit'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import {
  type RendererConformanceBinding,
  registerRendererContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/renderer.js'
import {
  OUTLINE_RENDER_KEY,
  OUTLINE_VIEW_TYPE,
  referenceOutlineText,
  referenceOutlineWeb,
} from '../client/renderer.js'

// Assigning the browser definitions here checks their mirrored shapes against the generated types.
export const referenceOutlineRenderers: readonly RendererDefinition[] = [
  referenceOutlineWeb,
  referenceOutlineText,
]

/** A slide outline view both reference renderers read. */
const OUTLINE_VIEW: DomainView = {
  kind: 'domain',
  viewId: 'reference-outline-1',
  revision: 1,
  domainType: 'reference.outline',
  viewSchema: { typeId: OUTLINE_VIEW_TYPE, revision: 1, digest: 'b'.repeat(64) },
  renderKey: OUTLINE_RENDER_KEY,
  scope: {
    kind: 'session',
    installationId: 'installation-1',
    runtimeId: 'runtime-1',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
  },
  source: { eventIds: ['event-1'], projectionRevision: 1 },
  phase: 'finalized',
  fallbackText: 'Launch plan outline',
  data: { title: 'Launch plan', revision: 1, slides: [{ heading: 'Goals', points: ['Ship', 'Learn'] }] },
  resources: [],
  actions: [],
}

const sha256 = (...urls: URL[]) =>
  urls.reduce((hash, url) => hash.update(readFileSync(url)), createHash('sha256')).digest('hex')

const build: BuildIdentity = {
  codeSha: 'reference-code',
  buildDigest: 'reference-build',
  lockDigest: 'reference-lock',
  specVersion: 'reference-spec',
  sdkVersion: 'reference-sdk',
  sdkDigest: 'reference-sdk-digest',
  platform: 'reference-platform',
}

/**
 * Registers the six renderer cases for the reference slide outline renderers, reported under
 * `providerId` (the runner passes the name it was asked for, such as `reference`). This package carries
 * no DOM implementation and no client host, so the caller supplies `root`, which makes a React root over
 * an element attached to a document, `select`, which runs a web client host over a catalog, and
 * `restart`, which runs `recoverRenderer` with both and these renderers in client processes.
 */
export function bindRendererContract(
  harness: ConformanceHarness,
  command: string,
  options: Readonly<
    { providerId?: string } & Pick<RendererConformanceBinding, 'root' | 'select' | 'restart'>
  >,
): void {
  registerRendererContract(harness, {
    providerId: options.providerId ?? 'reference.renderer',
    recipe: providerFileForContract('agh.renderer'),
    command,
    build,
    // The text renderers and the Web component they share the outline reading with.
    providerDigest: sha256(
      new URL('../client/renderer.ts', import.meta.url),
      new URL('../client/presentation-renderer.tsx', import.meta.url),
    ),
    configDigest: canonicalJsonDigest({}),
    releaseSetDigest: sha256(new URL('../../package.json', import.meta.url)),
    renderers: referenceOutlineRenderers,
    view: OUTLINE_VIEW,
    root: options.root,
    select: options.select,
    restart: options.restart,
  })
}
