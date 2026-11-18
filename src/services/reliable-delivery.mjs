import fs from 'node:fs';
import path from 'node:path';
import {now} from '../domain/rules.mjs';

/** Durable local inbox and bot outbox. No credentials are stored in queue payloads. */
export class ReliableDelivery {
  constructor(repo, processMessage, sendPush, spoolFile) {
    Object.assign(this,{repo,processMessage,sendPush,spoolFile});this.stopped=true;this.outboxFlight=null;
    repo.db.exec(`CREATE TABLE IF NOT EXISTS delivery_inbox(id TEXT PRIMARY KEY,stream TEXT NOT NULL,payload TEXT NOT NULL,due INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS delivery_inbox_due ON delivery_inbox(due);
      CREATE TABLE IF NOT EXISTS delivery_outbox(id TEXT PRIMARY KEY,stream TEXT NOT NULL,address TEXT NOT NULL,payload TEXT NOT NULL,due INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT);
      CREATE TABLE IF NOT EXISTS delivery_receipts(id TEXT PRIMARY KEY,at INTEGER NOT NULL);`);
  }
  stream(m){return JSON.stringify([m.group?.startsWith('tg:')?'telegram':'wechat',m.group,m.sourceId]);}
  telegramDeletePeers(messageId) {
    const peers=new Set(),id=String(messageId);
    const include=m=>{if(m.group?.startsWith('tg:')&&m.sourceId===`${m.group}:${id}`)peers.add(m.group.slice(3));};
    try{for(const row of this.repo.all("SELECT DISTINCT channel FROM messages WHERE source='telegram' AND message=channel||':'||?",id))peers.add(row.channel.slice(3));}catch{}
    try{for(const row of this.repo.all("SELECT payload FROM delivery_inbox WHERE json_extract(payload,'$.group') LIKE 'tg:%' AND json_extract(payload,'$.sourceId')=json_extract(payload,'$.group')||':'||?",id))include(JSON.parse(row.payload));}catch{}
    if(this.spoolFile&&fs.existsSync(this.spoolFile)){
      for(const line of fs.readFileSync(this.spoolFile,'utf8').split('\n')){try{include(JSON.parse(JSON.parse(line).payload));}catch{}}
    }
    return [...peers];
  }
  receive(message) {
    const stream=this.stream(message),id=JSON.stringify([stream,message.messageRevision??message.time,message.messageEvent||'create']);
    const payload=JSON.stringify(message);
    try{this.repo.run('INSERT OR IGNORE INTO delivery_inbox(id,stream,payload,due) VALUES(?,?,?,?)',id,stream,payload,now());}
    catch(error){
      if(!this.spoolFile)throw error;
      fs.mkdirSync(path.dirname(this.spoolFile),{recursive:true});
      const fd=fs.openSync(this.spoolFile,'a',0o600);
      try{fs.writeSync(fd,JSON.stringify({id,stream,payload})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      return;
    }
    this.processInboxRow(this.repo.get('SELECT rowid seq,* FROM delivery_inbox WHERE id=?',id));
  }
  processInboxRow(row) {
    if(!row||row.due>now()||this.repo.get('SELECT 1 FROM delivery_inbox WHERE stream=? AND rowid<? LIMIT 1',row.stream,row.seq))return;
    try{
      this.processMessage(JSON.parse(row.payload));
      this.repo.run('DELETE FROM delivery_inbox WHERE id=?',row.id);
    }catch(error){
      try{this.repo.run('UPDATE delivery_inbox SET attempts=attempts+1,due=? WHERE id=?',now()+Math.min(60,2**Math.min(row.attempts,6)),row.id);
        this.repo.diagnostic('delivery_inbox',row.id,error.message);}catch{}
    }
  }
  importSpool() {
    if(!this.spoolFile||!fs.existsSync(this.spoolFile))return;
    const content=fs.readFileSync(this.spoolFile,'utf8');if(!content)return;
    const tail=[];
    this.repo.transaction(()=>{
      for(const line of content.split('\n').filter(Boolean)){
        let row;try{row=JSON.parse(line);}catch{tail.push(line);continue;}
        this.repo.run('INSERT OR IGNORE INTO delivery_inbox(id,stream,payload,due) VALUES(?,?,?,?)',row.id,row.stream,row.payload,now());
      }
    });
    fs.writeFileSync(this.spoolFile,tail.length?tail.join('\n')+'\n':'',{mode:0o600});
  }
  drainInbox(){try{this.importSpool();for(const row of this.repo.all('SELECT rowid seq,* FROM delivery_inbox i WHERE due<=? AND NOT EXISTS(SELECT 1 FROM delivery_inbox older WHERE older.stream=i.stream AND older.rowid<i.rowid) ORDER BY rowid LIMIT 10',now())){this.processInboxRow(row);}}catch{}}
  queuePush(stream,address,call,target) {
    const id=JSON.stringify([stream,address,target]);
    if(this.repo.get('SELECT 1 FROM delivery_receipts WHERE id=?',id))return;
    this.repo.run('INSERT OR IGNORE INTO delivery_outbox(id,stream,address,payload,due) VALUES(?,?,?,?,?)',id,stream,address,JSON.stringify({call,target}),now());
  }
  cancelPushes(stream,keep=[]) {
    for(const row of this.repo.all('SELECT id,address FROM delivery_outbox WHERE stream=?',stream))if(!keep.includes(row.address))this.repo.run('DELETE FROM delivery_outbox WHERE id=?',row.id);
  }
  drainOutbox() {
    if(this.stopped||this.outboxFlight)return this.outboxFlight;
    const row=this.repo.get('SELECT * FROM delivery_outbox WHERE due<=? ORDER BY rowid LIMIT 1',now());if(!row)return;
    this.outboxFlight=(async()=>{
      try{
        const sent = await this.sendPush(JSON.parse(row.payload));
        this.repo.transaction(()=>{if(!this.repo.get('SELECT 1 FROM delivery_outbox WHERE id=?',row.id))return;
          if (sent !== false) this.repo.run('INSERT OR IGNORE INTO delivery_receipts VALUES(?,?)', row.id, now());
          this.repo.run('DELETE FROM delivery_outbox WHERE id=?', row.id);
        });
      }catch(error){try{if(!this.stopped)this.repo.run('UPDATE delivery_outbox SET attempts=attempts+1,due=?,last_error=? WHERE id=?',now()+Math.min(300,2**Math.min(row.attempts,8)),String(error.message).slice(0,500),row.id);}catch{}}
    })().finally(()=>{this.outboxFlight=null;});
    return this.outboxFlight;
  }
  start(){this.stopped=false;this.drainInbox();this.inboxTimer=setInterval(()=>this.drainInbox(),250);this.inboxTimer.unref?.();this.outboxTimer=setInterval(()=>{try{void this.drainOutbox()?.catch(()=>{});}catch{}},1000);this.outboxTimer.unref?.();}
  async stop(){this.stopped=true;clearInterval(this.inboxTimer);clearInterval(this.outboxTimer);await this.outboxFlight;}
  status(){return {inbox:this.repo.get('SELECT COUNT(*) n FROM delivery_inbox').n,outbox:this.repo.get('SELECT COUNT(*) n FROM delivery_outbox').n};}
}
