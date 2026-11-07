import test from 'node:test';
import assert from 'node:assert/strict';
import { PriceAcquisition } from '../src/services/price-acquisition.mjs';
import { DeferredError, WaitError } from '../src/infra/worker.mjs';

test('baseline and history preserve cooldown and market waits', async () => {
  const token = { chain: 'eth', address: '0x123', version: 1, verified: true, at: 100, last_call: 100 };
  const market = {
    token: () => token, liveQuote: () => null, releaseLiveHigh() {},
    repo: { get: () => ({ baseline: JSON.stringify({ provider: 'ave_api', value: 1, at: 90 }) }), diagnostic() {} },
  };
  const acquisition = new PriceAcquisition(market);
  const ctx = { guard: () => true, job: { payload: { manualBatchId: 'test' } } };
  for (const stage of ['baseline', 'history']) {
    acquisition.result = () => stage === 'baseline' ? null : market.repo.get();
    market.priceBars = async () => { throw new DeferredError('cooldown', 30); };
    await assert.rejects(acquisition[stage](ctx), e => e.deferred && e.delay === 30);
    market.priceBars = async () => { throw new WaitError('market unavailable', 'chain'); };
    await assert.rejects(acquisition[stage](ctx), e => e.wait === 'chain');
  }
});
