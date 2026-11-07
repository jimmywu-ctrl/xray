// Dashboard statistics functions. Shared state remains in the page bootstrap.
async function loadStats() {
  const requestId = ++statsRequestId;
  const q = new URLSearchParams({ source: statsSource, group: $("#sgroup").value, hours: $("#shours").value, winX: String(configuredWinThreshold()), includeApprox: String(configuredIncludeApprox()) });
  const [statsResult, exclusionsResult] = await Promise.allSettled([api("/api/stats?" + q), api("/api/stats/exclusions")]);
  if (requestId !== statsRequestId) return;
  if (statsResult.status === "rejected") throw statsResult.reason;
  statsRows = statsResult.value;
  statsExclusionApiAvailable = exclusionsResult.status === "fulfilled";
  statsExcluded = statsExclusionApiAvailable ? exclusionsResult.value : [];
  const note = $("#s-api-note");
  note.hidden = statsExclusionApiAvailable;
  note.textContent = statsExclusionApiAvailable ? "" : "统计数据已加载；当前服务版本还不支持屏蔽统计，重启新版服务后即可使用屏蔽与恢复。";
  renderStats();
  renderStatsExclusions();
}
// END loadStats
function renderStats() {
  const heading=document.querySelector('#stats .page-h');
  if(heading){heading.querySelector('h1').textContent='喊单人表现';heading.querySelector('p').textContent='按喊单人对比喊单后的最高倍数，所有可计算的有效喊单都参与排序。';}
  const targetLabel=$('#swin')?.closest('label');if(targetLabel)targetLabel.childNodes[0].textContent='达标倍数 ≥ ';
  const approxLabel=$('#sinclude-approx')?.closest('label');if(approxLabel&&approxLabel.lastChild?.nodeType===Node.TEXT_NODE)approxLabel.lastChild.textContent=' 把近似基准也计入';
  const headers={calls:'算出倍数 / 总喊单',medianPeakX:'中位数倍数',avgPeakX:'平均最高倍数',best:'单次最高倍数'};
  for(const [key,label] of Object.entries(headers)){const th=$(`#stable thead th[data-k='${key}']`);if(th)th.textContent=label;}
  markSort("stable");
  const totals = statsRows.reduce((sum, row) => {
    sum.senders++;
    sum.total += Number(row.totalCalls) || 0;
    sum.baseline += Number(row.baselineCalls) || 0;
    sum.peak += Number(row.calls) || 0;
    sum.noBaseline += Number(row.missingBaselineCalls) || 0;
    sum.noPeak += Number(row.missingPeakCalls) || 0;
    sum.pending += Number(row.pendingAddresses) || 0;
    sum.expired += Number(row.expiredBaselines) || 0;
    return sum;
  }, { senders: 0, total: 0, baseline: 0, peak: 0, noBaseline: 0, noPeak: 0, pending: 0, expired: 0 });
  const inProgress = statsRows.reduce((sum, row) => sum + (Number(row.inProgressCalls) || 0), 0);
  const insufficient = statsRows.reduce((sum, row) => sum + (Number(row.insufficientSampleCalls) || 0), 0);
  $("#s-coverage").textContent = `当前筛选：${totals.total} 个已确认代币；${totals.peak} 个算出喊后最高倍数，${Math.max(0,totals.total-totals.peak)} 个暂时算不出。所有可计算的有效结果都参与排名。`;
  const winHeader=$("#stable thead th[data-k='winRate']");
  if(winHeader)winHeader.textContent=`达到 ${configuredWinThreshold()}× 的比例`;
  const rows = sortRows("stable", statsRows, () => "");
  const peakApproxMark = (r) => Number(r.approximateCalls || 0) > 0 ? "≈" : "";
  const detailTitle = (r) => `总喊单 ${r.totalCalls} 条 · 算出倍数 ${r.calls} 条 · 暂时算不出 ${Math.max(0,Number(r.totalCalls||0)-Number(r.calls||0))} 条。单条倍数 = 喊单后最高点 ÷ 喊单时基准。${Number(r.approximateCalls || 0) ? `其中 ${r.approximateCalls} 条使用近似基准。` : ""}`;
  const rate = (value, mark) => value == null ? "—" : `${mark}${(value * 100).toFixed(0)}%`;
  $("#stable tbody").innerHTML = rows.map((r) => `<tr class="sender" data-sender="${esc(r.sender)}" data-sender-key="${esc(r.senderKey || r.sender)}">
    <td data-label="喊单人" title="${esc(callerDisplay(r.sender))}">${esc(callerDisplay(r.sender))} <small class="dim">· ${r.source === "telegram" ? "Telegram" : "微信"}</small></td><td data-label="算出倍数/总喊单" title="${esc(detailTitle(r))}">${r.calls}/${r.totalCalls}${peakApproxMark(r)}</td>
    <td data-label="达到目标倍数的比例" title="${esc(detailTitle(r))}" class="${r.winRate != null && r.winRate >= .5 ? "up" : ""}">${rate(r.winRate, peakApproxMark(r))}</td>
    <td data-label="中位数倍数" title="${esc(detailTitle(r))}">${peakApproxMark(r)}${x(r.medianPeakX)}</td><td data-label="平均最高倍数" title="${esc(detailTitle(r))}">${peakApproxMark(r)}${x(r.avgPeakX)}</td>
    <td class="best" data-label="最高倍">${r.best ? `<span class="best-cell"><span class="best-symbol" title="${esc(r.best.symbol)}">${esc(r.best.symbol)}</span>${peakTier(r.best.x)}<span class="best-x up">${x(r.best.x)}</span></span>` : `<span class="best-cell empty">—</span>`}</td></tr>`).join("") || `<tr><td colspan="6" class="dim">当前筛选下没有可识别的首喊记录</td></tr>`;
  $("#stable tbody").querySelectorAll("tr.sender").forEach((tr) => tr.onclick = () => toggleSender(tr));
}
// END renderStats
function renderStatsExclusions() {
  const details = $("#s-exclusions");
  $("#s-exclusion-count").textContent = String(statsExcluded.length);
  details.hidden = !statsExclusionApiAvailable || statsExcluded.length === 0;
  if (!statsExcluded.length) details.open = false;
  $("#s-excluded-list").innerHTML = statsExcluded.map((item) => `<div class="stats-excluded-row">
    <span class="stats-excluded-token">
      ${logo(item.logo, item.symbol, item.chain, item.address)}<span class="label">${esc(item.symbol || item.address.slice(0, 8))} ${chainTag(item.chain)} · ${esc(item.address.slice(0, 10))}</span>
    </span><button class="ghost restore" type="button" data-address="${esc(item.address)}" data-chain="${esc(item.chain)}" data-symbol="${esc(item.symbol || "")}" data-target-excluded="0">恢复统计</button>
  </div>`).join("");
  $("#s-excluded-list").querySelectorAll("button[data-address]").forEach((button) => button.onclick = () => changeStatsExclusion(button, false));
}
// END renderStatsExclusions
async function changeStatsExclusion(button, excluded) {
  const activeSender = $("#stable tbody tr.sender.open")?.dataset.senderKey;
  button.disabled = true;
  try {
    await api("/api/stats/exclusions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      address: button.dataset.address, chain: button.dataset.chain || "", symbol: button.dataset.symbol || "", excluded,
    }) });
    await loadStats();
    if (activeSender) {
      const row = [...$("#stable tbody").querySelectorAll("tr.sender")].find((r) => r.dataset.senderKey === activeSender);
      if (row) await toggleSender(row);
    }
  } catch (error) {
    button.disabled = false;
    button.title = error instanceof Error ? error.message : String(error);
    button.textContent = "重试";
  }
}
// END changeStatsExclusion
async function toggleSender(tr) {
  const open = tr.classList.contains("open");
  $("#stable tbody").querySelectorAll("tr.detail").forEach((d) => d.remove());
  $("#stable tbody").querySelectorAll("tr.sender.open").forEach((t) => t.classList.remove("open"));
  if (open) return;
  tr.classList.add("open");
  const detail = document.createElement("tr"); detail.className = "detail";
  detail.innerHTML = `<td colspan="6"><div class="calls"><div class="empty">加载中…</div></div></td>`;
  tr.after(detail);
  const q = new URLSearchParams({ key: tr.dataset.senderKey || tr.dataset.sender, source: statsSource, group: $("#sgroup").value, hours: $("#shours").value });
  const list = await api("/api/sender?" + q);
  if (!tr.classList.contains("open")) return;
  const hasAnyInfo = (c) => !!(c.symbol || c.chain || c.base_mc != null || c.base_price != null || c.athMc != null || c.peakX != null);
  const canCount = (c) => c.counted && c.peakX != null;
  const orderedList = [...list].sort((a, b) => {
    const aPeak = Number.isFinite(a.peakX) && a.peakX > 0 ? a.peakX : null;
    const bPeak = Number.isFinite(b.peakX) && b.peakX > 0 ? b.peakX : null;
    if (aPeak == null || bPeak == null) return aPeak == null ? (bPeak == null ? (a.ts ?? 0) - (b.ts ?? 0) : 1) : -1;
    return bPeak - aPeak || (a.ts ?? 0) - (b.ts ?? 0);
  });
  const isPending = c => (c.key_chain === "?" || !c.chain);
  const isExpired = c => (c.result_baseline_precision ?? c.mc_precision) === "last-trade" && c.ts - (c.result_baseline_at ?? c.quote_at ?? c.ts) > 21600;
  const countable = orderedList.filter(canCount), incomplete = orderedList.filter((c) => !isExpired(c) && !isPending(c) && hasAnyInfo(c) && !canCount(c)), unresolved = orderedList.filter((c) => isPending(c) || !hasAnyInfo(c)), expired = orderedList.filter(c => isExpired(c) && !isPending(c));
  const renderCall = (c, included) => {
    const canExclude = statsExclusionApiAvailable && (included || c.excluded);
    const baselineExpired = (c.result_baseline_precision ?? c.mc_precision) === "last-trade" && c.ts - (c.result_baseline_at ?? c.quote_at ?? c.ts) > 21600;
    const peakMeta = c.peak_at != null ? ` · ${fmtTimeSec(c.peak_at)}` : "";
    return `<div class="li ${c.excluded ? "excluded" : ""}">
      <div class="li-main">${logo(c.logo, c.symbol, c.chain, c.address)}
        <div class="mid"><div class="t1">${esc(c.symbol || c.address.slice(0, 8))} ${included && !c.excluded ? peakTier(c.peakX) : ""} ${chainTag(c.chain)}${c.n > 1 ? ` <span class="dim">× ${c.n}</span>` : ""}${c.excluded ? ` <span class="pill">已屏蔽</span>` : ""}</div>
          <div class="t2">${c.source === "telegram" ? "Telegram" : "微信"} · ${fmtTimeSec(c.ts)} · ${c.base_mc!=null?'首喊市值 '+compact(c.base_mc):c.base_price>0?'首喊价格 $'+Number(c.base_price).toPrecision(4):'首喊价格未取得'}${c.approx ? "（近似）" : ""}</div></div>
        <div class="num">${included ? `<span class="up">${x(c.peakX)}</span>` : c.observedPeakX>0 ? `<span class="dim" title="观察到的高点，待历史K线校准；不计入正式统计">暂估 ${x(c.observedPeakX)}</span>` : `<span class="dim">—</span>`}<div class="t2">${c.ineligibleReason?esc(c.ineligibleReason):'喊后最高价 '+(c.peakPrice!=null?c.peakPrice.toPrecision(4):'未取得')}</div></div>
      </div>${canExclude ? `<button class="ghost exclude-token" type="button" data-address="${esc(c.address)}" data-chain="${esc(c.chain || "")}" data-symbol="${esc(c.symbol || "")}" data-target-excluded="${c.excluded ? "0" : "1"}">${c.excluded ? "恢复统计" : "屏蔽统计"}</button>` : ""}
    </div>`;
  };
  const callsHtml = countable.map((c) => renderCall(c, true)).join("");
  const incompleteHtml = incomplete.length ? `<details class="unresolved-calls"><summary>数据未取得 ${incomplete.length} 条</summary>${incomplete.map((c) => renderCall(c, false)).join("")}</details>` : "";
  const unresolvedHtml = unresolved.length ? `<details class="unresolved-calls"><summary>待确认地址 ${unresolved.length} 条（不计入统计）</summary>${unresolved.map((c) => renderCall(c, false)).join("")}</details>` : "";
  const expiredHtml = expired.length ? `<details class="unresolved-calls"><summary>过期基准 ${expired.length} 条（不计倍数和胜率）</summary>${expired.map(c => renderCall(c, false)).join("")}</details>` : "";
  detail.querySelector(".calls").innerHTML = callsHtml + incompleteHtml + unresolvedHtml + expiredHtml || `<div class="empty">这个筛选条件下没有喊单</div>`;
  detail.querySelectorAll("button.exclude-token").forEach((button) => button.onclick = () => changeStatsExclusion(button, button.dataset.targetExcluded === "1"));
}
// END toggleSender

