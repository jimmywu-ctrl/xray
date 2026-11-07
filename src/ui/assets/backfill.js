function renderBackfillProgress(panel, result) {
  if (!panel?.progress || !panel.progressLabel) return;
  const active = !!result && (result.status === "started" || result.status === "progress");
  const waiting = result?.status === "waiting";
  panel.progress.hidden = !active && !waiting;
  panel.progress.classList.toggle("running", active);
  panel.progress.classList.toggle("waiting", waiting);
  if (!active && !waiting) { panel.progressLabel.textContent = ""; return; }
  if (result.status === "progress") {
    const stage = result.phase === "process" ? "整理并去重消息" : result.phase === "done" ? "当前群完成" : "读取历史消息";
    const groupPosition = result.totalGroups ? `${Math.min(Number(result.completedGroups) + 1, Number(result.totalGroups))}/${result.totalGroups} 群` : "等待群组";
    const group = result.currentGroup ? `「${result.currentGroup}」` : "";
    const detail = result.phase === "read"
      ? `，已读取 ${backfillCount(result.scanned)} 条消息；本群读完后再解析 CA`
      : result.scanned == null ? "" : `，已处理 ${backfillCount(result.scanned)}${result.total == null ? "" : `/${backfillCount(result.total)}`} 条消息，已识别 ${backfillCount(result.messages)} 条含 CA`;
    panel.progressLabel.textContent = `${panel.label} · ${stage} ${groupPosition} ${group}${detail}${result.nextAction ? ` · 下一步：${result.nextAction}` : ""}`;
  } else if (waiting) {
    const left = Math.max(0, Math.ceil((backfillRetryAt - Date.now()) / 1000));
    panel.progressLabel.textContent = `${panel.label} · Telegram 限流冷却 ${backfillWaitLabel(left)} · 已保留断点`;
  } else {
    panel.progressLabel.textContent = `正在准备${panel.label}回读 · ${Number(result.totalGroups) || 0} 个群`;
  }
}
function renderGroupBackfillStatus(result) {
  if (result?.bySource) { for (const value of Object.values(result.bySource)) if (value) renderGroupBackfillStatus(value); return; }
  const source = result?.channel === "telegram" ? "telegram" : result?.channel === "wechat" ? "wechat" : null;
  if (!source) return;
  backfillStatusBySource[source] = result;
  const panel = groupBackfillPanels[source];
  const active = result.status === "started" || result.status === "progress" || result.status === "waiting";
  const groupName = result.currentGroup || result.group || "";
  const progressDetail = result.status === "waiting"
    ? "Telegram 限流冷却中，已保留断点；冷却结束后可继续"
    : result.phase === "process" ? "正在整理并去重消息，已识别 " + backfillCount(result.messages) + " 条含 CA 消息"
      : result.phase === "read" ? "正在读取历史消息，已扫描 " + backfillCount(result.scanned) + " 条" + (groupName ? " · " + groupName : "")
        : "准备回读 " + (Number(result.totalGroups) || 0) + " 个群";
  if (active) setGlobalWork("backfill:" + source, { title: panel.label + " CA 历史回读", detail: progressDetail, waiting: result.status === "waiting" });
  else if (result.status === "done") setGlobalWork("backfill:" + source, { title: panel.label + " CA 历史回读完成", detail: "扫描 " + backfillCount(result.groups) + " 个群，发现 " + backfillCount(result.messages) + " 条含 CA 消息", done: true, dismissAfterMs: 7000 });
  else if (result.status === "error") setGlobalWork("backfill:" + source, { title: panel.label + " CA 历史回读失败", detail: String(result.error || "未知错误"), percent: null, error: true, dismissAfterMs: 12000 });
  else setGlobalWork("backfill:" + source, null);
  if (result.status === "waiting") {
    backfillWaitingState = result;
    backfillRetryAt = Number(result.retryAt) || (Date.now() + Math.max(0, Number(result.waitSeconds) || 0) * 1000);
  } else if (source === "telegram" && (result.status === "started" || result.status === "done" || result.status === "error")) {
    backfillWaitingState = null;
    backfillRetryAt = 0;
  }
  renderBackfillProgress(panel, result);
  panel.status.className = "group-backfill-status";
  const waiting = result.status === "waiting";
  const secondsLeft = waiting ? Math.max(0, Math.ceil((backfillRetryAt - Date.now()) / 1000)) : 0;
  panel.run.dataset.resume = waiting && source === "telegram" ? "true" : "false";
  panel.run.disabled = (active && !waiting) || (waiting && secondsLeft > 0);
  panel.run.textContent = waiting ? (secondsLeft ? `等待 ${backfillWaitLabel(secondsLeft)}` : "继续回读") : active ? "正在回读…" : "开始回读";
  if (result.status === "started") {
    panel.status.classList.add("running");
    panel.status.textContent = `正在回读最近 ${result.duration || panel.range?.value || "所选时间"} 的${panel.label}群消息…`;
  } else if (result.status === "progress") {
    panel.status.classList.add("running");
    const stage = result.phase === "process" ? "正在整理并去重" : result.phase === "done" ? "当前群已完成" : "正在读取群历史";
    const detail = result.phase === "read"
      ? `已读取 ${backfillCount(result.scanned)} 条消息，本群读完后开始解析 CA。`
      : `已处理 ${backfillCount(result.scanned)}${result.total == null ? "" : `/${backfillCount(result.total)}`} 条消息，已识别 ${backfillCount(result.messages)} 条含 CA。`;
    panel.status.textContent = `${stage}：已完成 ${Number(result.completedGroups) || 0}/${Number(result.totalGroups) || 0} 个群；${detail}${result.nextAction ? `下一步：${result.nextAction}` : ""}`;
  } else if (waiting) {
    panel.status.classList.add("waiting");
    const next = result.nextAction || "等待限流冷却结束后点击继续回读，系统会从当前群断点续读。";
    panel.status.textContent = `Telegram API 限流，需等待约 ${backfillWaitLabel(secondsLeft)}。已完成 ${Number(result.completedGroups) || 0}/${Number(result.totalGroups) || 0} 个群，发现 ${backfillCount(result.messages)} 条含 CA 的消息。${next}`;
  } else if (result.status === "done") {
    panel.status.classList.add("done");
    panel.status.textContent = `完成：扫描 ${Number(result.groups) || 0} 个群，发现 ${backfillCount(result.messages)} 条含 CA 的消息；统计只归给每个 CA 最早喊出的真人。`;
  } else {
    panel.status.classList.add("error");
    panel.status.textContent = `${panel.label}回读失败：${String(result.error || "未知错误")}`;
  }
}
