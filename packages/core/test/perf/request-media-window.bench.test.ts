import { writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { prepareRequestMediaFromSurface } from '../../src/orchestrator/request-media-surface.js'
import type { SurfaceNode } from '../../src/project/surface.js'
import { sha256Hex } from '../../src/request/hash.js'
import type { Event } from '../../src/types.js'
import { toolCallLookup } from '../helpers/request-media-lookup.js'
import { legacyPrepareRequestMediaFromSurface } from '../helpers/request-media-surface-legacy.js'

// Opt-in benchmark: AGNES_BENCH=1 runs it, nothing else does. It reports wall-clock numbers and
// never asserts on timing. Optional knobs: AGNES_BENCH_SIZES (comma list of image-node counts),
// AGNES_BENCH_STEPS / AGNES_BENCH_LEGACY_STEPS (sliding steps per size), AGNES_BENCH_TIERS,
// AGNES_BENCH_OUT (JSON result file).
const enabled = process.env.AGNES_BENCH === '1'
const sizes = (process.env.AGNES_BENCH_SIZES ?? '3,20,50,100,150,200').split(',').map(Number)
const steps = Number(process.env.AGNES_BENCH_STEPS ?? 10)
const legacySteps = Number(process.env.AGNES_BENCH_LEGACY_STEPS ?? 3)
const tiers = (process.env.AGNES_BENCH_TIERS ?? 'flat,mixed,noise').split(',') as Tier[]
type Tier = 'flat' | 'mixed' | 'noise'

const WIDTH = 1456
const HEIGHT = 816

function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** 1456x816 RGB PNG; entropy is set per tier and is the same for every image in a tier. */
function screenshot(tier: Tier, seed: number): Uint8Array {
  const row = WIDTH * 3 + 1
  const raw = Buffer.alloc(row * HEIGHT)
  let state = 0x9e3779b9 ^ seed
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state & 0xff
  }
  for (let y = 0; y < HEIGHT; y += 1)
    for (let x = 0; x < WIDTH * 3; x += 1) {
      const noisy =
        tier === 'noise' ||
        (tier === 'mixed' && y % 8 < 2) ||
        (tier === 'flat' && x % 997 === 0 && y % 7 === 0)
      raw[y * row + 1 + x] = noisy ? random() : ((x >> 6) * 7) & 0xff
    }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(WIDTH, 0)
  header.writeUInt32BE(HEIGHT, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(raw)),
      pngChunk('IEND', new Uint8Array()),
    ]),
  )
}

function resultNode(seq: number, bytes: Uint8Array): SurfaceNode {
  const event = {
    seq: 100_000 + seq,
    ts: '2026-09-24T00:00:00.000Z',
    id: String(100_000 + seq).padStart(26, '0'),
    type: 'tool/result',
    data: {
      toolUseId: `tool-${seq}`,
      content: [
        { type: 'text', text: `screen ${seq}` },
        {
          type: 'resource_link',
          uri: `artifact://${sha256Hex(bytes)}`,
          name: 'image',
          mimeType: 'image/png',
        },
      ],
      isError: false,
      enforcement: { level: 'full', scope: [] },
      authz: { decisionId: 'n/a' },
    },
    actor: { id: 'a', org: '', role: 'user', deptPath: [], attrs: {} },
    origin: 'tool:computer_use',
    trust: 'untrusted',
    sourceEventSeqs: [seq],
  } as unknown as Event
  return { seq: event.seq, kind: 'tool_result', pinned: false, event }
}

function ledger(surface: readonly SurfaceNode[]): Event[] {
  const calls = surface.map(
    (node) =>
      ({
        ...node.event,
        seq: node.event.sourceEventSeqs?.[0],
        type: 'tool/call',
        origin: 'model',
        sourceEventSeqs: undefined,
        data: {
          toolUseId: (node.event.data as { toolUseId: string }).toolUseId,
          name: 'computer_use',
          args: {},
        },
      }) as unknown as Event,
  )
  return [...calls, ...surface.map((node) => node.event)]
}

const MiB = 1024 * 1024
const surfaceLimits = {
  maxLedgerEvents: 10_000,
  maxSurfaceNodes: 2_048,
  maxContentBlocks: 4_096,
  maxManifestEntries: 256,
  maxCandidateBytes: 256 * 4 * MiB,
  maxCandidatePixels: 256 * 1456 * 1456,
}
const mediaLimits = {
  maxManifestEntries: 256,
  maxSelectedImages: 4,
  maxSelectedBlocks: 8,
  maxBytesPerImage: 4 * MiB,
  maxDimensionPerImage: 1456,
  maxPixelsPerImage: 1456 * 1456,
  maxSelectedBytes: 16 * MiB,
  maxSelectedPixels: 4 * 1456 * 1456,
}

const percentile = (values: readonly number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number
}
const round = (value: number) => Math.round(value * 10) / 10

describe.runIf(enabled)('request media preflight window benchmark', () => {
  it('measures per-step preflight wall time by image-node count, before and after windowing', async () => {
    const rows: Record<string, unknown>[] = []
    for (const tier of tiers) {
      const pool = Array.from({ length: 4 }, (_, index) => screenshot(tier, index + 1))
      const artifacts = new Map(pool.map((bytes) => [sha256Hex(bytes), bytes]))
      const readArtifact = ({ sha256 }: { sha256: string }) => artifacts.get(sha256)
      const maxSize = Math.max(...sizes)
      const nodes = Array.from({ length: maxSize + Math.max(steps, legacySteps) }, (_, index) =>
        resultNode(index + 1, pool[index % pool.length] as Uint8Array),
      )
      for (const size of sizes)
        for (const impl of ['window', 'legacy'] as const) {
          const times: number[] = []
          for (let step = 0; step < (impl === 'window' ? steps : legacySteps); step += 1) {
            const surface = nodes.slice(step, step + size)
            const common = {
              sessionKey: 'bench',
              lane: 'main',
              signal: new AbortController().signal,
              surface,
              readArtifact,
              surfaceLimits,
              mediaLimits,
              mainModelInput: ['text', 'image'] as Array<'text' | 'image'>,
              auxiliaryVisionAvailable: false,
            }
            const lookupToolCalls = toolCallLookup(ledger(surface))
            const ledgerEvents = ledger(surface)
            const started = performance.now()
            const prepared =
              impl === 'window'
                ? await prepareRequestMediaFromSurface({ ...common, lookupToolCalls })
                : await legacyPrepareRequestMediaFromSurface({ ...common, ledgerEvents })
            times.push(performance.now() - started)
            expect(prepared.selected).toHaveLength(Math.min(3, size))
          }
          const row = {
            tier,
            imageKiB: Math.round((pool[0]?.length ?? 0) / 1024),
            impl,
            n: size,
            steps: times.length,
            firstMs: round(times[0] as number),
            p50Ms: round(percentile(times, 50)),
            p95Ms: round(percentile(times, 95)),
            steadyP50Ms: round(percentile(times.slice(1).length ? times.slice(1) : times, 50)),
          }
          rows.push(row)
          console.log(JSON.stringify(row))
        }
    }
    const out = process.env.AGNES_BENCH_OUT
    if (out)
      writeFileSync(
        out,
        `${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, rows }, null, 2)}\n`,
      )
  }, 3_600_000)
})
