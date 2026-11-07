const counts = new Map();

/** Count completed provider HTTP requests, grouped by provider and operation. */
export function recordProviderRequest(provider, operation, succeeded) {
  const key = `${provider}:${operation}`;
  const entry = counts.get(key) ?? { provider, operation, success: 0, failure: 0 };
  entry[succeeded ? 'success' : 'failure'] += 1;
  counts.set(key, entry);
}

/** Take and reset the counters for the next reporting window. */
export function takeProviderRequestMetrics() {
  const providers = new Map(['ave', 'dex'].map((provider) => [provider, {
    provider,
    success: 0,
    failure: 0,
    operations: {},
  }]));
  for (const entry of counts.values()) {
    const provider = providers.get(entry.provider) ?? {
      provider: entry.provider,
      success: 0,
      failure: 0,
      operations: {},
    };
    provider.success += entry.success;
    provider.failure += entry.failure;
    provider.operations[entry.operation] = { success: entry.success, failure: entry.failure };
    providers.set(entry.provider, provider);
  }
  counts.clear();
  return [...providers.values()];
}
