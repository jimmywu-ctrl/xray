// Release a reusable resource only after all queued/running operations settle.
function createIdleResource({ retire, idleMs = 5 * 60 * 1000, timers = globalThis }) {
  let active = 0, timer = null, stopped = false;
  function cancel() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }
  function schedule() {
    cancel();
    if (stopped || active) return;
    timer = timers.setTimeout(() => {
      timer = null;
      if (stopped || active) return;
      // A visible resource may be in use by the person at the keyboard.
      if (retire() === false) schedule();
    }, idleMs);
    timer.unref?.();
  }
  return {
    acquire() {
      cancel();active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;active--;
        if (!active) schedule();
      };
    },
    stop() { stopped = true;cancel(); },
  };
}
module.exports = { createIdleResource };
