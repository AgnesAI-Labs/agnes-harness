import type { ContentBlock, ModelRecord, RequestBody, RouteDecl } from '@agnes/protocol'
import { createImagesModels, type ImageContent } from '@earendil-works/pi-ai'
import { type AdapterStreamOptions, WireAdapter, type WireEvent } from '../../adapter.js'
import { canonicalJson, sha256Hex } from '../../hash.js'
import { pollUntilDone, type VideoClient, type VideoStatus } from './video-job.js'

export const IMAGE_ROUTE = 'agnes-media-image'
export const VIDEO_ROUTE = 'agnes-media-video'

type RouteCfg = { baseUrl: string; credentialRef?: string; models: ModelRecord[] }

export type ImagesImpl = (
  model: ModelRecord,
  input: string,
  opts: { apiKey?: string; signal: AbortSignal },
) => Promise<{ images: Array<{ data: string; mimeType: string }> }>

/** The text of the last user turn, which is the whole prompt an image/video request carries. */
function lastUserText(req: RequestBody): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]
    if (m && m.role === 'user') {
      return m.content
        .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
    }
  }
  return ''
}

type MediaAdapterConfig = {
  imageRoute: RouteCfg
  videoRoute?: RouteCfg
  imagesImpl?: ImagesImpl
  videoClient?: VideoClient
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  clock?: () => number
  videoTimeoutMs?: number
}

/**
 * Media generation adapter: `slot: 'image'` is a single synchronous call answered inline, `slot:
 * 'video'` is submit-then-poll because no vendor returns a finished video synchronously. Both slots
 * end in the same three-event tail (`usage`, `done`) as every other adapter, so a caller does not
 * need a separate code path for media versus text/tool-call inference.
 */
export class MediaAdapter extends WireAdapter {
  readonly id = 'media'
  private readonly imagesImpl: ImagesImpl

  constructor(private readonly cfg: MediaAdapterConfig) {
    super()
    this.imagesImpl = cfg.imagesImpl ?? piImages
  }

  routes(): RouteDecl[] {
    const r: RouteDecl[] = [
      {
        route: IMAGE_ROUTE,
        api: 'agnes-media',
        baseUrl: this.cfg.imageRoute.baseUrl,
        credentialRef: this.cfg.imageRoute.credentialRef ?? 'secret://agnes/media',
      },
    ]
    if (this.cfg.videoRoute) {
      r.push({
        route: VIDEO_ROUTE,
        api: 'agnes-media',
        baseUrl: this.cfg.videoRoute.baseUrl,
        credentialRef: this.cfg.videoRoute.credentialRef ?? 'secret://agnes/media',
      })
    }
    return r
  }

  models(route: string): ModelRecord[] {
    if (route === IMAGE_ROUTE) return this.cfg.imageRoute.models
    if (route === VIDEO_ROUTE) return this.cfg.videoRoute?.models ?? []
    return []
  }

  async *stream(route: string, req: RequestBody, opts: AdapterStreamOptions): AsyncIterable<WireEvent> {
    const model = this.models(route).find((m) => m.id === req.model)
    if (!model) {
      yield {
        type: 'error',
        reason: 'error',
        code: 'NO_MODEL',
        message: `route=${route} model=${req.model}`,
        retryable: false,
      }
      return
    }
    const prompt = lastUserText(req)
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

    if (route === IMAGE_ROUTE) {
      const cred = this.credentialFor(route)
      let res: { images: Array<{ data: string; mimeType: string }> }
      try {
        res = await this.imagesImpl(model, prompt, {
          signal: opts.signal,
          ...(cred !== undefined ? { apiKey: cred } : {}),
        })
      } catch (e) {
        // `piImages` throws for both a real transport failure and a provider-reported
        // `stopReason: 'error'` result (see its own comment) — this is the one place that
        // distinguishes an aborted request from an actual failure and turns either into the
        // terminal `error` WireEvent every adapter is expected to end a failed stream with.
        yield {
          type: 'error',
          reason: opts.signal.aborted ? 'aborted' : 'error',
          code: opts.signal.aborted ? 'ABORTED' : 'TRANSPORT',
          message: e instanceof Error ? e.message : 'image generation failed',
          retryable: !opts.signal.aborted,
        }
        return
      }
      for (const img of res.images)
        yield { type: 'media', kind: 'image', data: img.data, mimeType: img.mimeType }
      yield {
        type: 'usage',
        tokens: zero,
        credits: model.cost.output * res.images.length,
        creditSource: 'estimated',
      }
      yield { type: 'done', reason: 'stop' }
      return
    }

    const client = this.cfg.videoClient
    if (!client) {
      yield {
        type: 'error',
        reason: 'error',
        code: 'NO_ADAPTER',
        message: 'no video client configured',
        retryable: false,
      }
      return
    }
    const idempotencyKey = sha256Hex(canonicalJson({ prompt, model: model.id }))
    const { jobId } = await client.submit({ prompt, idempotencyKey }, opts.signal)
    yield { type: 'media', kind: 'video_job', jobId, status: 'submitted' }
    let last: VideoStatus = 'submitted'
    const ticks: WireEvent[] = []
    const result = await pollUntilDone(client, jobId, {
      sleep: this.cfg.sleep ?? defaultSleep,
      clock: this.cfg.clock ?? Date.now,
      timeoutMs: this.cfg.videoTimeoutMs ?? 900_000,
      signal: opts.signal,
      // `succeeded` is deliberately excluded from the tick log: the block below re-emits it once
      // more anyway, carrying `url` — a field `onTick`'s bare status string cannot express. Without
      // this exclusion a caller would see two `succeeded` events for the same job, the first (from
      // here) with no `url` at all, which is exactly the kind of thing a caller treating the first
      // terminal status it sees as final would act on prematurely.
      onTick: (s) => {
        if (s !== last && s !== 'succeeded') {
          last = s
          ticks.push({ type: 'media', kind: 'video_job', jobId, status: s })
        }
      },
    })
    for (const t of ticks) yield t
    if (result.status === 'succeeded') {
      yield {
        type: 'media',
        kind: 'video_job',
        jobId,
        status: 'succeeded',
        ...(result.url ? { url: result.url } : {}),
      }
      yield { type: 'usage', tokens: zero, credits: model.cost.output, creditSource: 'estimated' }
      yield { type: 'done', reason: 'stop' }
      return
    }
    yield {
      type: 'error',
      reason: result.status === 'cancelled' ? 'aborted' : 'error',
      code: result.status === 'cancelled' ? 'ABORTED' : result.status === 'expired' ? 'TIMEOUT' : 'TRANSPORT',
      message: `video job ${result.status}`,
      retryable: false,
    }
  }
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })

/**
 * The real pi-ai call, used whenever a caller does not inject its own `imagesImpl` (every test in
 * this package does, since this function talks to a real provider and needs real credentials).
 *
 * CORRECTNESS NOTE — this is a fix, not a transcription of the plan's sample:
 *
 * `ImagesModels.generateImages()` does not resolve to `{ images: Array<{ data, mimeType }> }`. Per
 * `@earendil-works/pi-ai@0.84.3`'s own `dist/types.d.ts`, it resolves to an `AssistantImages`:
 *
 *   interface AssistantImages {
 *     output: ImagesOutputContent[]   // not `images`
 *     stopReason: 'stop' | 'error' | 'aborted'
 *     errorMessage?: string
 *     ...
 *   }
 *   type ImagesOutputContent = TextContent | ImageContent   // some providers mix in commentary
 *
 * The plan's original sample assumed a `result.images` field that does not exist on this type, so
 * `for (const img of res.images)` would have thrown a runtime TypeError on the first real call (or
 * failed to typecheck at all, had the plan's `as unknown as {...}` cast not been hiding it) — it
 * would never have compiled or run against the real library, only against a hand-rolled duck type.
 *
 * The second half of the fix is `stopReason`. Per `images-models.d.ts`'s own doc comment on
 * `ImagesModels.generateImages`: "Never rejects; failures are returned as an `AssistantImages` with
 * `stopReason: 'error'`." So a failed generation is not a thrown/rejected promise — it is an
 * ordinary successful resolution that this function must inspect and re-raise as a thrown error,
 * which is what lets `MediaAdapter.stream()`'s existing try/catch (written for the ordinary case of
 * a transport-level throw) also catch a provider-level generation failure without a second code
 * path. Treating `stopReason: 'error'` as success would silently turn every real generation failure
 * into a `done` event carrying zero images.
 */
async function piImages(
  model: ModelRecord,
  input: string,
  opts: { apiKey?: string; signal: AbortSignal },
): Promise<{ images: Array<{ data: string; mimeType: string }> }> {
  const models = createImagesModels()
  // `model.route` is this package's own route id, kept equal to the declaring RouteDecl's `route`
  // by convention (mirrors how `toPiModel` uses `decl.route` as pi-ai's `provider` field) — so it
  // doubles as the provider id `getModel` expects.
  const piModel = models.getModel(model.route, model.id)
  if (!piModel) throw new Error(`no pi-ai images model registered for route=${model.route} id=${model.id}`)
  const result = await models.generateImages(
    piModel,
    { input: [{ type: 'text', text: input }] },
    { signal: opts.signal, ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}) },
  )
  if (result.stopReason === 'error') throw new Error(result.errorMessage ?? 'image generation failed')
  return {
    images: result.output
      .filter((c): c is ImageContent => c.type === 'image')
      .map((c) => ({ data: c.data, mimeType: c.mimeType })),
  }
}
