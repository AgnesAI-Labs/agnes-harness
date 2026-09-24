import type { ToolContext, ToolResult } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import type { ComputerUseActionResult, ComputerUseCaptureResult, ComputerUseElement } from './backend.js'

export const MAX_ELEMENTS = 100
export const MAX_SUMMARY_LINES = 40
export const MAX_LABEL_CHARS = 120
export const MIN_IMAGE_DIMENSION = 8

function publicElement(element: ComputerUseElement, truncate: boolean): Record<string, JsonValue> {
  const clipped = truncate && element.label.length > MAX_LABEL_CHARS
  return {
    index: element.index,
    role: element.role,
    label: truncate ? element.label.slice(0, MAX_LABEL_CHARS) : element.label,
    bounds: element.bounds ? [...element.bounds] : null,
    ...(element.app ? { app: element.app } : {}),
    ...(element.pid ? { pid: element.pid } : {}),
    ...(element.windowId ? { window_id: element.windowId } : {}),
    ...(clipped ? { label_truncated: true } : {}),
  }
}

function elementLine(element: ComputerUseElement): string {
  const label = element.label.replaceAll('\n', ' ').slice(0, 60)
  const bounds = element.bounds
    ? `@ (${element.bounds.join(', ')})`
    : '@ bounds-unknown (click by element index)'
  return `#${element.index} ${element.role} ${JSON.stringify(label)} ${bounds}`
}

export async function captureToolResult(
  capture: ComputerUseCaptureResult,
  ctx: Pick<ToolContext, 'artifacts'>,
  options: Readonly<{ omitImage?: boolean }> = {},
): Promise<ToolResult> {
  const visible = capture.elements.slice(0, MAX_ELEMENTS)
  const lost =
    capture.elements.length > visible.length ||
    visible.some((element) => element.label.length > MAX_LABEL_CHARS)
  const elementsArtifact = lost
    ? await ctx.artifacts.put(
        new TextEncoder().encode(JSON.stringify(capture.elements.map((item) => publicElement(item, false)))),
        { mime: 'application/json', name: 'computer-use-elements.json' },
      )
    : undefined
  const truncation =
    capture.elements.length > visible.length
      ? `response truncated to ${visible.length} of ${capture.elements.length} elements`
      : undefined
  let lines = [
    `capture mode=${capture.mode} ${capture.width}x${capture.height}${capture.app ? ` app=${capture.app}` : ''}${capture.windowTitle ? ` window=${JSON.stringify(capture.windowTitle)}` : ''}`,
    `${capture.elements.length} interactable element(s):`,
    ...visible.map(elementLine),
    truncation,
    options.omitImage
      ? 'screen_unchanged: identical pixels omitted; element indices are from the new snapshot'
      : undefined,
    capture.note,
    capture.boundsScale
      ? `bounds_scale=${capture.boundsScale}; coordinates use the native element-bounds space`
      : undefined,
  ].filter((line): line is string => line !== undefined)
  if (lines.length > MAX_SUMMARY_LINES) {
    const tail = [
      truncation,
      options.omitImage ? 'screen_unchanged: identical pixels omitted' : undefined,
    ].filter((line): line is string => line !== undefined)
    lines = [...lines.slice(0, MAX_SUMMARY_LINES - tail.length), ...tail]
  }
  const tooSmall =
    capture.image !== undefined &&
    (capture.image.width < MIN_IMAGE_DIMENSION || capture.image.height < MIN_IMAGE_DIMENSION)
  const structured: Record<string, JsonValue> = {
    ok: true,
    action: 'capture',
    mode: capture.mode,
    width: capture.width,
    height: capture.height,
    ...(capture.app ? { app: capture.app } : {}),
    ...(capture.windowTitle ? { window_title: capture.windowTitle } : {}),
    ...(capture.note ? { note: capture.note } : {}),
    ...(capture.boundsScale ? { bounds_scale: capture.boundsScale } : {}),
    target: {
      ...(capture.target.app ? { app: capture.target.app } : {}),
      ...(capture.target.pid ? { pid: capture.target.pid } : {}),
      ...(capture.target.windowId ? { window_id: capture.target.windowId } : {}),
    },
    elements: visible.map((item) => publicElement(item, true)),
    total_elements: capture.elements.length,
    ...(truncation ? { truncated_elements: capture.elements.length - visible.length } : {}),
    ...(elementsArtifact ? { elements_artifact: elementsArtifact } : {}),
    ...(capture.image
      ? {
          image: {
            artifact: capture.image.ref,
            mime: capture.image.mime,
            width: capture.image.width,
            height: capture.image.height,
            digest: capture.image.digest,
          },
        }
      : {}),
    ...(tooSmall ? { image_omitted: 'too_small' } : {}),
    ...(options.omitImage ? { screen_unchanged: true, image_omitted: 'deduplicated' } : {}),
  }
  return {
    content: [
      { type: 'text', text: lines.join('\n') },
      ...(capture.image && capture.mode !== 'ax' && !tooSmall && !options.omitImage
        ? [{ type: 'image' as const, ref: capture.image.ref, mime: capture.image.mime }]
        : []),
    ],
    structured,
  }
}

export function actionVerdict(result: ComputerUseActionResult): Record<string, JsonValue> {
  if (result.ok && (result.effect === 'confirmed' || result.verified === true)) return { decision: 'done' }
  if (result.effect === 'unverifiable')
    return {
      decision: 'verify_fresh_state',
      hint: 'Input was delivered but not confirmed. Capture fresh state before any retry.',
    }
  const escalate =
    result.effect === 'suspected_noop' ||
    !result.ok ||
    Boolean(result.code) ||
    result.escalation?.recommended !== undefined
  return {
    decision: escalate ? 'escalate' : 'verify_fresh_state',
    ...(escalate && result.escalation?.recommended ? { recommended: result.escalation.recommended } : {}),
    hint: escalate
      ? 'The input likely did not land. Follow the recommended escalation; do not silently retry.'
      : 'Transport success is not proof of effect. Capture fresh state before continuing.',
  }
}

export function actionToolResult(result: ComputerUseActionResult, warning?: string): ToolResult {
  const structured: Record<string, JsonValue> = {
    ok: result.ok,
    action: result.action,
    ...(result.message ? { message: result.message } : {}),
    ...(result.code ? { code: result.code } : {}),
    ...(result.effect ? { effect: result.effect } : {}),
    ...(result.verified === undefined ? {} : { verified: result.verified }),
    ...(result.escalation ? { escalation: result.escalation as JsonValue } : {}),
    ...(result.path ? { path: result.path } : {}),
    ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
    ...(result.deliveryMode ? { delivery_mode: result.deliveryMode } : {}),
    ...(result.target
      ? {
          target: {
            ...(result.target.app ? { app: result.target.app } : {}),
            ...(result.target.pid ? { pid: result.target.pid } : {}),
            ...(result.target.windowId ? { window_id: result.target.windowId } : {}),
          },
        }
      : {}),
    verdict: actionVerdict(result),
    ...(warning ? { warning } : {}),
  }
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structured, isError: !result.ok }
}

export function refusalToolResult(code: string, message: string): ToolResult {
  const structured = { ok: false, code, message }
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structured, isError: true }
}
