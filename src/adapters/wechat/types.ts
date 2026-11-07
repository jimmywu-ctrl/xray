/** Fields the reader needs from WeChat's local session database. */
export interface WechatConversation {
  username: string;
  displayName: string;
  isGroup: boolean;
  unread: number;
  lastTimestamp: number;
  summary: string;
}

/** A decoded row; raw database bytes and cryptographic material never cross this boundary. */
export interface DecodedWechatMessage {
  createTime: number;
  sourceId?: string;
  senderId?: string;
  sender: string;
  text: string;
  addrs?: string[];
  chainHint?: string | null;
}
