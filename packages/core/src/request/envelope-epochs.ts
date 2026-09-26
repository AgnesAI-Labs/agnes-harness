/** The final durable header of each consecutive nonce run, in ledger sequence order. */
export type EnvelopeEpochs = Array<{ lastHeaderSeq: number; nonce: string }>

/** A node uses the nonce on the first durable request header after its own sequence. */
export function nonceFor(epochs: readonly EnvelopeEpochs[number][], nodeSeq: number): string | undefined {
  let low = 0
  let high = epochs.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if ((epochs[middle]?.lastHeaderSeq ?? -1) <= nodeSeq) low = middle + 1
    else high = middle
  }
  return epochs[low]?.nonce
}

/** Only call after a header's transaction commits; same-nonce headers extend their epoch. */
export function recordHeader(epochs: EnvelopeEpochs, headerSeq: number, nonce: string): void {
  const last = epochs.at(-1)
  if (last && headerSeq <= last.lastHeaderSeq) throw new Error('envelope headers must be in ledger order')
  if (last?.nonce === nonce) last.lastHeaderSeq = headerSeq
  else epochs.push({ lastHeaderSeq: headerSeq, nonce })
}
