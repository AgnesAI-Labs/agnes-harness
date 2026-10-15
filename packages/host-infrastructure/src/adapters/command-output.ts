const encodings: Readonly<Record<number, string>> = {
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
}

/** Incremental decoding for live output, including prompts with no newline. */
export function commandOutputDecoder(codePage?: number) {
  let pending = Buffer.alloc(0)
  let fallback: TextDecoder | undefined
  const decode = (bytes: Buffer, final: boolean): string => {
    if (fallback) return fallback.decode(bytes, { stream: !final })
    pending = Buffer.concat([pending, bytes])
    // Retain an incomplete UTF-8 suffix; all other bytes can be delivered immediately.
    let end = pending.length
    if (!final && end) {
      let lead = end - 1
      while (lead > 0 && (pending[lead]! & 0xc0) === 0x80) lead--
      const byte = pending[lead]!
      const need =
        byte >= 0xf0 && byte <= 0xf4
          ? 4
          : byte >= 0xe0 && byte <= 0xef
            ? 3
            : byte >= 0xc2 && byte <= 0xdf
              ? 2
              : 1
      if (end - lead < need) end = lead
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(pending.subarray(0, end))
      pending = pending.subarray(end)
      return text
    } catch {
      const encoding = codePage === undefined ? undefined : encodings[codePage]
      fallback = new TextDecoder(encoding ?? 'utf-8', { ignoreBOM: true })
      const text = fallback.decode(pending, { stream: !final })
      pending = Buffer.alloc(0)
      return text
    }
  }
  return {
    write(bytes: Buffer): string {
      let text = '',
        start = 0
      for (let i = 0; i < bytes.length; i++)
        if (bytes[i] === 10) {
          text += decode(bytes.subarray(start, i + 1), true)
          fallback = undefined
          start = i + 1
        }
      return text + decode(bytes.subarray(start), false)
    },
    end(): string {
      return decode(Buffer.alloc(0), true)
    },
  }
}
