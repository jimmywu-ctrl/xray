/** Adapter events use Unix seconds and keep source identity separate from display text. */
export interface GroupMsg {
  t: "msg";
  group: string;
  groupName?: string;
  sourceId: string;
  messageEvent?: "edit" | "delete" | "retract";
  messageRevision?: number;
  time: number;
  detectedAtMs?: number;
  sender: string;
  senderId?: string;
  senderAliases?: string[];
  senderUsername?: string;
  isBot?: boolean;
  text: string;
  addrs: string[];
  chainHint: string | null;
  backfill: boolean;
}

export interface ContextRow {
  createTime: number;
  sourceId: string;
  sender: string;
  text: string;
  addrs?: string[];
  chainHint?: string | null;
}

export interface BackfillScanProgress {
  group: string;
  phase: "read" | "process" | "done" | "waiting";
  scanned: number;
  total: number | null;
  messages: number;
  groupsCompleted: number;
  groupsTotal: number;
  nextAction?: string;
  waitSeconds?: number;
  retryAt?: number;
}

/** New groups receive a short bounded seed before live monitoring begins. */
export const RECENT_BACKFILL = 100;
