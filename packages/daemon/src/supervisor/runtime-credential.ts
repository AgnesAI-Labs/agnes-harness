import { createHmac } from 'node:crypto'

/** A separate transport capability derived from the existing generation-protected local secret.
 * The only caller admitted by the private Unix/pipe delivery path is the local OS owner. */
export function runtimeClientBearer(secret: string, generation: string): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify(['agnesd-runtime-client', 1, generation, 'local']))
    .digest('base64url')
}
