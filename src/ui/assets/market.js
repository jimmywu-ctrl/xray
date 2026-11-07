// Query completion and successful data retrieval are intentionally separate.
function marketProgressModel(repair, audit, time = Date.now()) {
  const number = value => Math.max(0, Number(value) || 0);
  const running = !!repair.running;
  const recovering = !!repair.queued && !running;
  const paused = running && !!repair.requestWait?.paused;
  const run = audit.status?.run;
  const matching = !!run && (!repair.runId || run.id === repair.runId);
  const outcomes = matching ? audit.status?.outcomes || {} : {};
  const baseline = outcomes.callBaselines || {}, peak = outcomes.callAth || {};
  const missing = number(baseline.unresolved) + number(peak.unresolved);
  const phaseIndex = { metadata: 0, quotes: 1, baseline: 1, candles: 1, ath: 2 }[repair.phase];
  const totals = [number(repair.metadataTotal), number(repair.totalCalls), number(repair.totalAth)];
  const processed = [number(repair.metadataCompleted), number(repair.completedCalls), number(repair.completedAth)];
  const total = number(repair.phaseTotal) || totals[phaseIndex] || 0;
  const done = Math.min(total, number(repair.phaseCompleted));
  const completed = repair.phase === 'complete' && !recovering;
  const failed = ['failed', 'interrupted'].includes(repair.phase) && !recovering;
  const percent = completed ? 100 : total ? Math.round(done / total * 100) : null;
  const age = repair.lastResponseAt ? Math.max(0, Math.floor(time / 1000 - repair.lastResponseAt)) : null;
  const titles = ['补齐代币资料', '查询首喊市值', '查询喊后最高市值'];
  let title = running ? titles[phaseIndex] || '正在查询行情' : completed ? (missing ? '查询结束，仍有待补项' : '本轮查询已完成') : failed ? '补齐中断，需要检查' : '准备开始补齐';
  let state = running ? '正在查询' : completed ? (missing ? '仍有待补' : '已结束') : failed ? '未完成' : '待开始';
  let tone = running ? 'active' : completed ? (missing ? 'waiting' : 'done') : failed ? 'error' : 'idle';
  let description = running ? '后台正在自动查询，完成这一步后会继续下一步。'
    : completed ? (missing ? `本轮有 ${missing} 条行情暂未取得，可稍后再补齐。` : '本轮查询已结束，取得的数据已保存。')
    : failed ? '请导出日志检查原因，也可以重新补齐未完成项。' : '点击“补齐缺失”，后台会依次查询三个步骤。';
  if (repair.health && ['stalled','rate-limited','timeout','queued','retrying','failed'].includes(repair.health.state)) {
    const health=repair.health;title=health.label;state=health.label;tone='waiting';
    description=`处理中 ${health.running} 项，排队 ${health.queued} 项，等待重试 ${health.backoff} 项。`+(health.reason?' '+health.reason:'')+(health.waitSeconds?' 最近任务约 '+health.waitSeconds+' 秒后重试。':'');
  } else if (paused) {
    title = '限流等待，稍后自动继续'; state = '限流等待'; tone = 'waiting';
    description = `行情服务暂时限流，约 ${number(repair.requestWait.waitSeconds)} 秒后自动继续。`;
  } else if (recovering) {
    title = '正在恢复未完成的查询'; state = '自动恢复'; tone = 'waiting';
    description = '后台正在等待重试，已保存的数据会保留。';
  } else if (running && age >= 90) {
    state = '查询较慢'; tone = 'waiting';
    description = '当前查询返回较慢；超时后结束该项查询，保留已有数据。';
  }
  const steps = titles.map((name, index) => {
    const prior = running && phaseIndex != null && index < phaseIndex;
    const current = running && index === phaseIndex;
    const ended = completed || prior;
    const value = totals[index] ? Math.min(100, processed[index] / totals[index] * 100) : 0;
    return { name, current, state: ended ? 'done' : current ? (paused ? 'waiting' : 'active') : failed ? 'error' : 'idle',
      label: ended ? '已结束' : current ? (paused ? '等待继续' : '正在查询') : failed ? '未完成' : '等待开始',
      detail: ended ? '本步查询已处理' : current && totals[index] ? `已处理 ${Math.min(processed[index], totals[index])} / ${totals[index]} 项` : totals[index] ? `${totals[index]} 项待查询` : '按需自动查询',
      percent: ended ? 100 : value };
  });
  return { title, state, tone, description, steps, percent, running, recovering, busy: running || !!repair.queued, total, done, completed,
    foundBaseline: matching ? Math.max(0, number(baseline.logicalItems) - number(baseline.unresolved)) : null,
    foundPeak: matching ? Math.max(0, number(peak.logicalItems) - number(peak.unresolved)) : null,
    missing: matching ? missing : null, age,
    elapsed: repair.startedAt ? Math.max(0, Math.floor((repair.finishedAt || time / 1000) - repair.startedAt)) : null };
}
function renderMarketProgress(repair, audit) {
  const model = marketProgressModel(repair, audit);
  $('#ma-visual').dataset.state = model.tone;
  $('#ma-state').textContent = model.title;
  $('#ma-status').textContent = model.state;
  $('#ma-status').dataset.state = model.tone;
  $('#ma-progress').textContent = model.description;
  $('#ma-count').textContent = model.running && model.total ? `当前步骤已处理 ${model.done} / ${model.total} 项` : model.recovering ? '即将重新查询未完成项' : model.completed ? '查询结束不代表每项都有返回数据' : '';
  const ring = $('#ma-ring');
  ring.style.setProperty('--ma-progress', `${model.percent || 0}%`);
  ring.setAttribute('aria-valuetext', model.percent == null ? model.state : `${model.percent}%，${model.state}`);
  if (model.percent == null) ring.removeAttribute('aria-valuenow'); else ring.setAttribute('aria-valuenow', String(model.percent));
  $('#ma-percent').textContent = model.percent == null ? '—' : `${model.percent}%`;
  $('#ma-ring-label').textContent = model.completed ? '本轮已结束' : model.running ? '当前步骤' : model.state;
  const bar = $('#ma-progress-bar');
  bar.hidden = !model.running;
  if (model.percent == null) bar.removeAttribute('value'); else bar.value = model.percent;
  for (let index = 0; index < model.steps.length; index++) {
    const step = model.steps[index], card = $(`#ma-step-${index}`);
    card.dataset.state = step.state;
    if (step.current) card.setAttribute('aria-current', 'step'); else card.removeAttribute('aria-current');
    $(`#ma-step-${index}-number`).textContent = step.state === 'done' ? '✓' : String(index + 1).padStart(2, '0');
    $(`#ma-step-${index}-status`).textContent = step.label;
    $(`#ma-step-${index}-detail`).textContent = step.detail;
    $(`#ma-step-${index}-bar`).style.width = `${step.percent}%`;
  }
  $('#ma-found-base').textContent = model.foundBaseline == null ? '—' : String(model.foundBaseline);
  $('#ma-found-peak').textContent = model.foundPeak == null ? '—' : String(model.foundPeak);
  $('#ma-not-found').textContent = model.missing == null ? '—' : String(model.missing);
  const duration = model.elapsed == null ? '' : model.elapsed < 60 ? `${model.elapsed} 秒` : `${Math.floor(model.elapsed / 60)} 分 ${model.elapsed % 60} 秒`;
  $('#ma-progress-label').textContent = model.running ? (model.age == null ? '正在等待首次返回' : `最近一次返回：${model.age} 秒前`) : model.completed ? '本轮已保存查询结果' : model.recovering ? '后台会自动继续，无需重复点击' : '查询结果会自动保存';
  $('#ma-duration').textContent = duration ? `${model.busy ? '已运行' : '本轮用时'} ${duration}` : '';
  $('#ma-run').disabled = model.busy;

}
async function loadMarketAudit() {
  if (marketAuditLoading) return;
  marketAuditLoading = true;
  try {
    const [repair, audit] = await Promise.all([repairProgressReader.read(), api('/api/market-data/audit?limit=1&offset=0')]);
    renderMarketProgress(repair, audit);
  } catch (error) { $('#ma-progress-label').textContent = '状态暂时未更新，正在重试…'; }
  finally { marketAuditLoading = false; }
}
