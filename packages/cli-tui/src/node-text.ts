import { storedAttachment, type UINode } from '@agnes/protocol'

/** Text presentation while the richer cards are assembled around the same projected nodes. */
export function nodeText(node: UINode): string {
  switch (node.kind) {
    case 'user':
      return `you: ${node.content.map((block) => (block.type === 'text' ? block.text : storedAttachment(block) ? `[${block.attachment.image ? 'image' : 'file'}: ${block.name} (${block.mimeType}, ${block.attachment.artifact.size} B)]` : block.type === 'file' ? `[file: ${block.name} (${block.mimeType})]` : `[${block.type}]`)).join('\n')}`
    case 'assistant':
      // An attempt whose streamed text died with its process has only that fact to show.
      return node.text === '' && node.lostChars !== undefined
        ? `(output interrupted, at least ${node.lostChars} characters not saved)`
        : node.text
    case 'tool':
      return `${node.name}: ${node.status}\n${node.summary}`
    case 'approval':
      return `approval ${node.state}: ${node.summary}`
    case 'cost':
      // Aggregate usage already lives in the fixed footer and /usage keeps the detailed report.
      // Repeating four accounting rows after every answer drowns the conversation itself.
      return ''
    case 'artifact':
      return `artifact: ${node.name}`
    case 'compaction':
      return `compacted: ${node.summary ?? node.range.join('–')}`
    case 'context':
      // A per-request environment snapshot or a harness note. It is content the model is sent, not
      // a message for the human reading the transcript, so it gets no line here -- same treatment
      // as the 'slot' case below, and the same treatment the channel renderer already gives it.
      // The node stays in the projection; only this rendering of it goes away.
      return ''
    case 'slot':
      // A standalone slot node (status.line / sidebar.action / notification) has no timeline
      // presence of its own: collectSlots() reads it out of the projected timeline directly and
      // routes it to the hint row or status bar instead. Never dump its payload as text here.
      return ''
    case 'tool-source-pending':
      return `${node.sources.join(', ')} still connecting; this turn runs without it`
    case 'memory-external-change':
      return `Memory ${node.paths.join(', ')} changed outside the memory provider and was loaded as is; review it with /memory`
    case 'workspace-undo':
      return node.conflicts > 0
        ? `Undo of turn ${node.turn} refused: ${node.conflicts} file(s) changed since the turn`
        : node.failed > 0
          ? `Undo of turn ${node.turn} stopped: restored ${node.restored}, not restored ${node.failed}`
          : `Undid the file changes of turn ${node.turn}: restored ${node.restored} file(s)`
    case 'ledger-recovery':
      return `Recovered the valid log through event ${node.validThroughSeq}; damaged tail quarantined. Diagnostic ID: ${node.diagnosticId}`
    case 'context-sections':
    case 'contribute-conflict':
      // Advisory diagnostic rows, not turn transcript: /context reads these directly off
      // projectUIOpening().timeline.nodes (formatContextBreakdown), so they have no chat-line
      // rendering of their own any more than a slot node does.
      return ''
  }
}
