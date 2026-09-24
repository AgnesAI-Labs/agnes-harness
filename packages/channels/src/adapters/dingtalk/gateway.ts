export type RawRobotMessage = {
  msgId: string
  conversationId: string
  conversationType: '1' | '2'
  senderStaffId: string
  senderNick?: string
  senderCorpId?: string
  msgtype: 'text' | 'picture' | 'file' | 'audio' | 'richText'
  text?: { content: string }
  content?: { downloadCode?: string; fileName?: string; duration?: number }
  isInAtList?: boolean
  atUsers?: Array<{ dingtalkId: string; staffId?: string }>
  createAt: number
  robotCode?: string
  chatbotUserId?: string
}

export type RawCardCallback = {
  outTrackId: string
  userId: string
  cardPrivateData: {
    actionIds: string[]
    params: Record<string, unknown>
  }
  conversationId?: string
  conversationType?: '1' | '2'
}

export type RawDept = {
  dept_id: number
  name: string
  parent_id?: number
}

export type RawUser = {
  userid: string
  name: string
  unionid?: string
  dept_id_list: number[]
  leave_time?: number
}

export type DingtalkTarget = {
  conversationId: string
  conversationType: '1' | '2'
  userIds?: string[]
}

export type DingtalkHandlers = {
  onMessage(message: RawRobotMessage): void
  onCard(callback: RawCardCallback): void
  onDisconnect(error: Error): void
}

export interface DingtalkGateway {
  start(handlers: DingtalkHandlers, signal: AbortSignal): Promise<{ botUserId: string }>
  stop(): Promise<void>
  sendMarkdown(target: DingtalkTarget, title: string, markdown: string): Promise<{ processQueryKey: string }>
  createCard(outTrackId: string, cardData: Record<string, unknown>, target: DingtalkTarget): Promise<void>
  updateCard(outTrackId: string, cardData: Record<string, unknown>): Promise<void>
  download(
    downloadCode: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; mime: string } | { url: string }>
  listDepartments(parentId?: number): Promise<RawDept[]>
  listUsers(deptId: number, cursor?: number): Promise<{ users: RawUser[]; nextCursor?: number }>
}
