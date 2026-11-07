import { now, RECENT_WINDOW_SEC } from "../domain/rules.mjs";
/** Per-group durable receiving boundary; advance only after event commit. */
export class CaptureWindows {
  constructor(repo, clock = now) {
    this.repo = repo;
    this.clock = clock;
    this.windows = repo.setting("captureWindows", {});
  }
  configure(settings) {
    const channels = [
        ...settings.wechat,
        ...settings.telegram.map((g) => "tg:" + g.peerId),
      ],
      next = {};
    for (const channel of channels)
      next[channel] = this.windows[channel] ?? {
        enabledAt: this.clock() - RECENT_WINDOW_SEC,
        lastSeen: this.clock() - RECENT_WINDOW_SEC,
      };
    this.windows = next;
    this.repo.set("captureWindows", next);
  }
  startAt(channel) {
    const w = this.windows[channel];
    return w ? Math.max(this.clock() - RECENT_WINDOW_SEC, w.enabledAt, w.lastSeen - 120) : this.clock();
  }
  accepts(message) {
    const w = this.windows[message.group];
    return (
      !!w &&
      (message.messageEvent === "delete" ||
        message.messageEvent === "retract" ||
        message.messageEvent === "edit" ||
        message.time >= w.enabledAt)
    );
  }
  committed(message) {
    const w = this.windows[message.group];
    if (!w) return;
    const timestamp = Math.max(
      Number(message.time) || 0,
      Math.floor((message.messageRevision ?? 0) / 1000),
    );
    if (timestamp > w.lastSeen) {
      w.lastSeen = timestamp;
      this.repo.set("captureWindows", this.windows);
    }
  }
}
