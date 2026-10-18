/** Keep bounded stdout for explicit diagnostic consumers, out of ordinary error serialization.
 * Output is untrusted command data: consumers must redact it before displaying or persisting it. */
export function withCommandOutput(error: Error, chunks: readonly Buffer[]): Error {
  if (Object.isExtensible(error))
    Object.defineProperty(error, 'stdout', {
      value: Buffer.concat(chunks).toString('utf8'),
      enumerable: false,
      configurable: true,
    })
  return error
}
