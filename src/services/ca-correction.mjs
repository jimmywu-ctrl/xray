import bs58 from 'bs58';
import { canonicalChain, normalize, now, CAPTURE_REFRESH_INTERVAL_SEC } from '../domain/rules.mjs';

/** Explicit local correction; original source messages and event payloads remain intact. */
export function correctCa(repo, ingestion, input) {
  const chain = canonicalChain(input.chain);
  const oldAddress = normalize(chain, input.address);
  const address = normalize(chain, input.correctedAddress);
  if (chain === 'sol' && bs58.decode(address).length !== 32) throw Error('Solana 地址必须解码为 32 字节');
  if (oldAddress === address) throw Error('新地址与原地址相同');
  const original = repo.get('SELECT verified FROM tokens WHERE chain=? AND address=?', chain, oldAddress);
  if (!original) throw Error('原地址不存在，请刷新后重试');
  if (repo.setting(`caCorrection:${chain}:${address}`, null)) throw Error('目标地址已有修正记录，请填写最终正确地址');
  let count = 0;
  repo.transaction(() => {
    const mentions = repo.all('SELECT * FROM mentions WHERE chain=? AND address=? AND active=1', chain, oldAddress);
    if (!mentions.length) throw Error('原地址已没有有效喊单，请刷新后重试');
    const previous = repo.claim(chain,address);
    repo.run('INSERT OR IGNORE INTO tokens(chain,address,last_call) VALUES(?,?,0)', chain, address);
    for (const m of mentions) {
      repo.run(`INSERT INTO mentions(source,channel,message,chain,address,sender_key,sender,at,bot,active)
        VALUES(?,?,?,?,?,?,?,?,?,1) ON CONFLICT(source,channel,message,chain,address)
        DO UPDATE SET active=1,at=MIN(mentions.at,excluded.at)`,
        m.source,m.channel,m.message,chain,address,m.sender_key,m.sender,m.at,m.bot);
    }
    repo.run('UPDATE mentions SET active=0 WHERE chain=? AND address=?', chain, oldAddress);
    for (const a of [oldAddress,address]) {
      repo.run('UPDATE tokens SET last_call=COALESCE((SELECT MAX(at) FROM mentions WHERE chain=? AND address=? AND active=1 AND bot=0),0) WHERE chain=? AND address=?',chain,a,chain,a);
      ingestion.reconcile(chain,a);
    }
    // A correction into an existing claim is another original-time mention;
    // it must extend the quiet window just like a normal repeat shout.
    if (previous?.active && repo.claim(chain,address)?.version === previous.version) {
      const capture = repo.get("SELECT * FROM jobs WHERE lane='capture' AND chain=? AND address=? AND claim_version=?",chain,address,previous.version);
      const payload = capture?.payload ? JSON.parse(capture.payload) : {};
      delete payload.refresh;
      const lastCall = repo.get('SELECT last_call FROM tokens WHERE chain=? AND address=?',chain,address).last_call;
      const hasBaseline=!!repo.get('SELECT baseline FROM price_results WHERE chain=? AND address=? AND claim_version=?',chain,address,previous.version)?.baseline;
      const due = payload.manualBatchId || chain === '?' || !hasBaseline ? now() : now() + CAPTURE_REFRESH_INTERVAL_SEC;
      const next = JSON.stringify({...payload,stage:hasBaseline?'history':'baseline'});
      if ((capture?.state === 'PARKED' && ['ave_api_key','baseline','verify','chain'].includes(capture.wait)) || (!hasBaseline && capture?.state === 'BACKOFF')) {
        // Preserve credential and provider cooldown waits when merging a correction.
      } else if (capture?.state === 'RUNNING') repo.run('UPDATE jobs SET payload=?,due=?,updated_at=? WHERE id=?',next,due,now(),capture.id);
      else if (capture) repo.run("UPDATE jobs SET payload=?,state='QUEUED',wait=NULL,attempts=0,due=?,lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=?",next,due,now(),capture.id);
      else repo.enqueue('capture',chain,address,previous.version,{...payload,stage:'history'},1,due);
    }
    repo.set(`caCorrection:${chain}:${oldAddress}`, address);
    repo.diagnostic('ca_correction',`${chain}:${oldAddress}`,JSON.stringify({oldAddress,address,mentions:mentions.length,at:now()}));
    count = mentions.length;
  });
  repo.project({mentionsChanged:true});
  ingestion.changed();
  return {ok:true,chain,address,correctedMentions:count};
}
