import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/infra/database.mjs';
import { IngestionService } from '../src/services/ingestion.mjs';
import { MarketService } from '../src/services/market.mjs';
import { DashboardContract } from '../src/services/dashboard-contract.mjs';

test('unresolved candidates remain correctable while cooldown suppresses repeated probes', async () => {
  const repo = new Repository(':memory:');
  try {
    const ingestion = new IngestionService(repo);
    const address = '0x2222222222222222222222222222222222222222';
    const shout = message => ingestion.ingest({ source:'telegram', channel:'tg:test', message,
      at:Math.floor(Date.now()/1000), addresses:[address], sender:'test' });
    shout('first');
    const market = new MarketService(repo, {}, {}, ingestion);
    market.prioritizeUnknownWalletAudit = () => {};
    const dashboard = new DashboardContract(repo, {}, market, {}, () => {});
    assert.equal(dashboard.tokens().length, 1);
    let pageCalls = 0, dexCalls = 0;
    market.chainProbes = {
      avePageSearch:async () => { pageCalls++; return []; },
      dex:async () => { dexCalls++; return []; },
    };
    assert.equal((await market.resolveUnknownChain(address)).review, true);
    assert.equal(dashboard.tokens().length, 1);
    assert.equal(repo.claim('?',address).active, 1);
    shout('again');
    assert.equal((await market.resolveUnknownChain(address)).review, true);
    assert.equal(pageCalls, 1);
    assert.equal(dexCalls, 1);
    assert.equal(dashboard.tokens().length, 1);
    for (const status of ['ambiguous','request_failed','not_configured']) {
      repo.run("UPDATE tokens SET metadata=? WHERE chain='?' AND address=?", JSON.stringify({aveChainLookup:{status}}), address);
      assert.equal(dashboard.tokens().length, 1);
    }
    repo.run("UPDATE tokens SET metadata=? WHERE chain='?' AND address=?", JSON.stringify({aveChainLookup:{status:'attempting'}}), address);
    assert.equal(dashboard.tokens().length, 1);
  } finally { repo.close(); }
});
