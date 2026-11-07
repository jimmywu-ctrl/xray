import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/services/market.mjs';

test('network failures never permanently park live quotes; genuine missing prices still do', () => {
  const market = new MarketService({ diagnostic() {}, setting(key, fallback) { return key === 'logoLookupStrategyVersion' ? 11 : fallback; } }, {}, {}, {});
  const token = { chain:'bsc', address:'test', version:1, lastCall:100 };
  const key = 'bsc:test';
  for (const provider of ['ave','dex']) {
    for (const message of ['net::ERR_CONNECTION_RESET','net::ERR_INTERNET_DISCONNECTED','net::ERR_PROXY_CONNECTION_FAILED','请求超时','HTTP 503','HTTP 429']) {
      for (let i=0;i<5;i++) assert.equal(market.noteLiveProviderFailure(token, provider, message), false);
      assert.equal(market.liveProviderFailureCount(key,provider,token), 0);
      assert.notEqual(market.aveSupplementRetryAt.get(key), Infinity);
    }
  }
  assert.equal(market.noteLiveProviderFailure(token,'ave','未返回有效价格'),false);
  assert.equal(market.noteLiveProviderFailure(token,'ave','未返回有效价格'),false);
  assert.equal(market.noteLiveProviderFailure(token,'ave','未返回有效价格'),true);
  assert.equal(market.liveProviderFailureCount(key,'ave',token),3);
});
