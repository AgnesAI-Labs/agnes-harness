// Spellings that are high-entropy by construction and are NOT credentials: subresource-integrity
// digests and this package's own sha256-/sha512- hashes (resolved_profile_hash, LockEntry.integrity,
// preset hashes). They are removed first, because otherwise the generic long-run rule below reports
// every one of them and the error path explodes on exactly the messages it exists to carry.
//
// The body is the real SRI alphabet and nothing else. It used to admit `-` and `_`, which meant a
// `sha256-` prefix laundered whatever followed it: `sha256-sk-live-...` was masked clean.
const SAFE_DIGEST = /\b(?:sha1|sha256|sha384|sha512)-[A-Za-z0-9+/=]{16,128}/g
// A digest is not always written with its algorithm in front of it. A message that announces itself
// as being about a hash gets its bare hex runs exempted too, all of them, because the message that
// needs this is `integrity mismatch: expected <64 hex>, got <64 hex>` - two runs, one label, and a
// label-adjacent exemption would only ever cover the first. Outside such a message a long hex run
// is still a credential shape: an unconditional hex exemption is what let every hex API key
// through, since every hex character is also a digest character.
// `(?:\b|_)` and not `\b`, because the field is spelled `resolved_profile_hash` and an underscore
// is a word character: `\bhash\b` does not match inside it.
const DIGEST_LABEL = /(?:\b|_)(?:hash|integrity|digest|checksum|fingerprint)\b/i
const BARE_HEX = /\b[A-Fa-f0-9]{32,128}\b/g
// Vendor prefixes that identify key material on sight. `sk-` is matched with a two-character tail,
// not six, because `sk-live-abc` and `sk-ant-api03-...` both have a short first segment. `npm_` is
// listed for itself rather than left to the opaque-run rule below: an npm token's body is 36
// characters, so it only ever reached forty by counting its own prefix and separator. The last two
// alternatives are structural rather than entropic: a `Basic` credential is short enough to slip
// under any length threshold, and a password inside a URL cannot be told from a path by entropy -
// `postgres://user:pw@host` is a realistic thing to quote in a connector error.
const CREDENTIAL =
  /(?:\b|_)(?:sk|rk|pk)[-_][A-Za-z0-9][A-Za-z0-9_-]{2,}|-----BEGIN[A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----|\bgithub_pat_[A-Za-z0-9_]{10,}|\bgh[pousr]_[A-Za-z0-9]{10,}|\bxox[baprse]-[A-Za-z0-9-]{10,}|\b(?:AKIA|ASIA)[0-9A-Z]{12,}|\bAIza[0-9A-Za-z_-]{20,}|\bhf_[A-Za-z0-9]{20,}|\bnpm_[A-Za-z0-9]{20,}|\bglpat-[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}|\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/
// A hex run long enough to be key material and not announced as a digest. Thirty-two, not forty,
// because a 32-character hex API key is the shape the previous pass left clean - including the one
// its own write-up used as the example of what had been fixed.
const HEX_TOKEN = /\b[A-Fa-f0-9]{32,}\b/
// Whatever is left that is one unbroken opaque run. `/` and `.` are separators, so a filesystem
// path and a dotted identifier break into segments instead of reading as one blob. `-` and `_` are
// not: making them separators cost 69 % of base64url tokens, because a single `-` splits a
// 43-character token below any threshold, and everything without a vendor prefix - session tokens,
// opaque bearer tokens, most self-issued keys - was invisible. What keeps the hyphenated package
// ids out is not the separator but the shape test below.
//
// Matched with an exec loop rather than a lookahead. The lookahead `(?=[A-Za-z0-9+=]*[0-9])` was
// quadratic: with no digit in the run it rescanned from every start position, 2.4 seconds for a
// 64 000-character run on a path that interpolates caller-controlled package ids.
const OPAQUE_RUN = /[A-Za-z0-9+=_-]{40,}/g
const WORD = /^[A-Za-z][a-z]*[0-9]{0,4}$/

/**
 * Whether a long run reads as words rather than as key material: every segment a word, and the
 * segments long enough on average that the split is not just noise. `tool-v2-connector-for-the-
 * analytics-thing-here` and `Kernel1SessionRegisterMaterializationStrategyFactory2` are words;
 * `k9Xq2mZv7Lp0RtYuIo...` splits into two-character fragments and is not. Random key material
 * almost never survives this - a digit in the middle of a segment, or an uppercase run, is enough.
 */
function looksLikeWords(run: string): boolean {
  const segs = run
    .split(/[-_]+/)
    .flatMap((s) => s.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter((s) => s.length > 0)
  if (segs.length < 2) return false
  const letters = segs.reduce((n, s) => n + s.length, 0)
  return segs.every((s) => WORD.test(s)) && letters / segs.length >= 3
}

/**
 * True when `message` looks like it carries key material. Strip the spellings that are safe by
 * construction, then flag a known credential shape, a long hex run, or an opaque run that does not
 * read as words. Exported so the test can attack it from both directions — a leak filter is only as
 * good as its false-positive list, and the digests this package quotes are the hard cases.
 *
 * Known residual gap, measured and accepted: a secret containing `/` escapes, which is 46 % of
 * random standard-base64 strings. Excluding `/` is what keeps deep paths from tripping the filter,
 * and this is a last-ditch predicate on an error message, not a scanner.
 */
export function looksLikeSecret(message: string): boolean {
  let rest = message.replace(SAFE_DIGEST, '<digest>')
  if (DIGEST_LABEL.test(message)) rest = rest.replace(BARE_HEX, '<digest>')
  if (CREDENTIAL.test(rest) || HEX_TOKEN.test(rest)) return true
  for (const run of rest.match(OPAQUE_RUN) ?? []) if (/[0-9]/.test(run) && !looksLikeWords(run)) return true
  return false
}

/** Fixed stand-in when a typed error's message would have carried key material. */
export const REDACTED_ERROR_MESSAGE = 'error message omitted: looks like a secret'

const PUBLIC_REASON = /^[a-z][a-z0-9-]{0,63}$/

/** Structured refusal tokens that may cross the worker boundary. Not prose, not secrets. */
export function isPublicErrorReason(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_REASON.test(value) && !looksLikeSecret(value)
}

export type DomainFailure = { code: string; message: string; reason?: string }

/**
 * The worker's non-RPC error object: keep code and an optional reason identifier, drop the rest of
 * detail, and never put a secret-shaped message on the frame.
 */
export function domainFailureFromUnknown(error: unknown): DomainFailure {
  const err = error as {
    code?: unknown
    message?: unknown
    reason?: unknown
    detail?: { reason?: unknown }
  } | null
  const code = typeof err?.code === 'string' && err.code.length > 0 ? err.code : 'E_WORKER'
  const raw = typeof err?.message === 'string' ? err.message : String(error)
  const message = looksLikeSecret(raw) ? `${code}: ${REDACTED_ERROR_MESSAGE}` : raw
  const reason = err?.reason ?? err?.detail?.reason
  return isPublicErrorReason(reason) ? { code, message, reason } : { code, message }
}
