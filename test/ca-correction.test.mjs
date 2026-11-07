import test from 'node:test';
import assert from 'node:assert/strict';
import {Repository} from '../src/infra/database.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {correctCa} from '../src/services/ca-correction.mjs';
import {now,CAPTURE_REFRESH_INTERVAL_SEC} from '../src/domain/rules.mjs';
const oldAddress='9ubGdBpKqnkJCatLMYDp8wV7USS2PAKopH67zjMo3ZvT';
const address='9ubGdBpKqnkJCatLMYDp8wV7UsS2PAKopH67zjMo3ZvT';
function msg(id,addr=oldAddress,at=now()-120){return {source:'telegram',channel:'tg:audit',message:id,at,addresses:[addr],chain:'sol',sender:'Original Caller',senderId:'original'};}
test('manual correction preserves source sender/time, removes wrong card and original messages remain untouched',()=>{
 const repo=new Repository(':memory:');try{
  const ingestion=new IngestionService(repo),e=msg('one');ingestion.ingest(e);
  const before=repo.get('SELECT payload,revision FROM messages');
  assert.equal(correctCa(repo,ingestion,{chain:'sol',address:oldAddress,correctedAddress:address}).correctedMentions,1);
  const mention=repo.get('SELECT * FROM mentions WHERE address=? AND active=1',address);
  assert.equal(mention.at,e.at);assert.equal(mention.sender,e.sender);assert.equal(mention.message,e.message);
  assert.deepEqual(repo.get('SELECT payload,revision FROM messages'),before);
  assert.equal(repo.get('SELECT active FROM claims WHERE address=?',oldAddress).active,0);
  assert.equal(repo.get('SELECT last_call FROM tokens WHERE address=?',address).last_call,e.at);
  ingestion.ingest(msg('two'));assert.equal(repo.get('SELECT COUNT(*) n FROM mentions WHERE address=? AND active=1',address).n,2);
  ingestion.ingest({...e,kind:'edit',revision:e.at*1000+1});
  assert.equal(repo.get('SELECT at FROM mentions WHERE address=? AND message=? AND active=1',address,e.message).at,e.at);
  ingestion.ingest({...e,kind:'delete',revision:e.at*1000+2});
  assert.equal(repo.get('SELECT active FROM mentions WHERE address=? AND message=?',address,e.message).active,0);
 }finally{repo.close();}
});
test('correcting into existing verified token keeps claim owner and schedules incremental history',()=>{
 const repo=new Repository(':memory:');try{
  const ingestion=new IngestionService(repo),at=now()-300;
  ingestion.ingest(msg('existing',address,at));repo.run('UPDATE tokens SET verified=1 WHERE address=?',address);
  const claim=repo.claim('sol',address);repo.run("UPDATE jobs SET state='DONE' WHERE address=?",address);
  repo.run('INSERT INTO price_results(chain,address,claim_version,baseline,updated_at) VALUES(?,?,?,?,?)','sol',address,claim.version,JSON.stringify({provider:'ave_api',price:1,value:1,at}),now());
  ingestion.ingest(msg('typo',oldAddress,at+60));correctCa(repo,ingestion,{chain:'sol',address:oldAddress,correctedAddress:address});
  assert.equal(repo.claim('sol',address).owner,claim.owner);
  const job=repo.get("SELECT * FROM jobs WHERE address=? AND lane='capture'",address);
  assert.equal(job.state,'QUEUED');assert.equal(job.due,now()+CAPTURE_REFRESH_INTERVAL_SEC);
 }finally{repo.close();}
});
test('invalid and unchanged corrections are rejected; verified cards support explicit correction',()=>{
 const repo=new Repository(':memory:');try{
  const ingestion=new IngestionService(repo);ingestion.ingest(msg('invalid'));
  for(const correctedAddress of ['',oldAddress,'not-an-address'])assert.throws(()=>correctCa(repo,ingestion,{chain:'sol',address:oldAddress,correctedAddress}));
  assert.equal(repo.get('SELECT COUNT(*) n FROM tokens').n,1);
  repo.run('UPDATE tokens SET verified=1');assert.equal(correctCa(repo,ingestion,{chain:'sol',address:oldAddress,correctedAddress:address}).ok,true);
  assert.equal(repo.get('SELECT COUNT(*) n FROM mentions WHERE address=? AND active=1',address).n,1);
 }finally{repo.close();}
});
