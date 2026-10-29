/** One incremental SHA-256: feed strings (as UTF-8) or bytes, read the hex digest once. */
export type Sha256Stream = {
  update(chunk: string | Uint8Array): void
  /** UTF-8 bytes fed so far. */
  readonly bytes: number
  digestHex(): string
}

/** Which SHA-256 `#sha256` resolved to on this host. */
export type Sha256Implementation = 'node' | 'portable'
