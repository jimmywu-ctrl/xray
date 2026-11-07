import readline from "node:readline";
export class Bridge {
  constructor() {
    this.sequence = 0;
    this.pending = new Map();
    this.reader = readline.createInterface({ input: process.stdin });
    this.reader.on("line", (line) => {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.type !== "reply") return;
      const p = this.pending.get(e.id);
      if (!p) return;
      clearTimeout(p.timer);
      p.cleanup?.();
      this.pending.delete(e.id);
      e.error ? p.reject(Error(e.error)) : p.resolve(e.result);
    });
    this.reader.on("close", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error("桌面连接已关闭"));
      }
      this.pending.clear();
    });
  }
  rpc(method, params, timeout = 15000, signal) {
    if (process.env.XRAY_HEADLESS === "1")
      return Promise.reject(Error("请通过桌面客户端打开内置登录"));
    if (this.pending.size >= 100)
      return Promise.reject(Error("桌面请求队列已满"));
    if (signal?.aborted) return Promise.reject(signal.reason || Error("请求已取消"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        process.stdout.write(JSON.stringify({type:'cancel',id})+'\n');
        reject(signal?.reason || Error('桌面请求超时或已取消'));
      };
      const timer = setTimeout(cancel, timeout);
      this.pending.set(id, { resolve, reject, timer, cleanup:()=>signal?.removeEventListener('abort',cancel) });
      signal?.addEventListener('abort',cancel,{once:true});
      process.stdout.write(
        JSON.stringify({ type: "request", id, method, params }) + "\n",
      );
    });
  }
  aveQuery(params, signal) {
    return this.rpc("ave.query", params, 30_000, signal);
  }
  aveSearchAddress(params, signal) {
    return this.rpc("ave.search-address", params, 55_000, signal);
  }
}
