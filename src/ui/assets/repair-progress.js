// One reader per dashboard; shares concurrent progress requests and short-lived results.
function createRepairProgressReader(request, clock = Date.now, ttl = 1000) {
  let value, expires = 0, pending, generation = 0;
  return {
    invalidate() { generation++; expires = 0; pending = undefined; },
    read() {
      if (pending) return pending;
      if (value !== undefined && clock() < expires) return Promise.resolve(value);
      const version = generation;
      const task = Promise.resolve().then(request).then(next => {
        if (version === generation) { value = next; expires = clock() + ttl; }
        return next;
      }).finally(() => { if (pending === task) pending = undefined; });
      pending = task;
      return task;
    },
  };
}
const repairProgressReader = createRepairProgressReader(() => api('/api/market-data/repair'));
