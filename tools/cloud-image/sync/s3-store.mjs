import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { fault } from './private-files.mjs'
export function createStore(initial, readCredentials, signal) {
  let client, signature
  async function currentClient() {
    const c = await readCredentials()
    const next = JSON.stringify([c.tmp_secret_id, c.tmp_secret_key, c.session_token])
    if (!client || next !== signature) {
      client?.destroy()
      client = new S3Client({
        endpoint: initial.endpoint,
        region: initial.region,
        followRegionRedirects: false,
        maxAttempts: 2,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        requestHandler: { connectionTimeout: 3000, requestTimeout: 8000 },
        // Recreate on rotation: the SDK may memoize asynchronous credential providers.
        credentials: {
          accessKeyId: c.tmp_secret_id,
          secretAccessKey: c.tmp_secret_key,
          sessionToken: c.session_token,
        },
      })
      signature = next
    }
    return client
  }
  const cancellation = (operationSignal) => {
    const signals = [signal, operationSignal].filter(Boolean)
    return signals.length ? AbortSignal.any(signals) : undefined
  }

  return {
    async get(key, operationSignal) {
      try {
        const client = await currentClient()
        const response = await client.send(new GetObjectCommand({ Bucket: initial.bucket, Key: key }), {
          abortSignal: cancellation(operationSignal),
        })
        const chunks = []
        let bytes = 0
        for await (const chunk of response.Body) {
          bytes += chunk.length
          if (bytes > 16 * 1024 * 1024) {
            response.Body.destroy()
            throw fault('SYNC_MANIFEST_TOO_LARGE')
          }
          chunks.push(chunk)
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return undefined
        throw fault('SYNC_OBJECT_READ_FAILED')
      }
    },
    async put(key, value, operationSignal) {
      try {
        const body = JSON.stringify(value)
        if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw fault('SYNC_MANIFEST_TOO_LARGE')
        const client = await currentClient()
        await client.send(
          new PutObjectCommand({
            Bucket: initial.bucket,
            Key: key,
            Body: body,
            ContentType: 'application/json',
            CacheControl: 'no-store',
          }),
          { abortSignal: cancellation(operationSignal) },
        )
      } catch {
        throw fault('SYNC_OBJECT_WRITE_FAILED')
      }
    },
    close: () => client?.destroy(),
  }
}
