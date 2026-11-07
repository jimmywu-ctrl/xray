// Release timeout closures and abort listeners as soon as a request settles.
function withRequestDeadline(task, { signal, timeoutMs = 45000 } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason || Error('已取消'));
  let timer, abort;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('AVE 网页地址搜索超时')), timeoutMs);
    timer.unref?.();
    if (signal) {
      abort = () => reject(signal.reason || Error('已取消'));
      signal.addEventListener('abort', abort, { once: true });
    }
  });
  return Promise.race([task, deadline]).finally(() => {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  });
}
module.exports = { withRequestDeadline };
