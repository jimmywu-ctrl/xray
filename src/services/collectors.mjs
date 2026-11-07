import path from 'node:path';
import {DATA_DIR} from '../adapters/config.ts';
import {ReliableDelivery} from './reliable-delivery.mjs';
import { WatchManager } from "../adapters/core/watchers.ts";
import { TelegramMonitor } from "../adapters/telegram/monitor.ts";
import { TelegramBotPublisher } from '../adapters/telegram/bot-api.ts';
import { extractAddresses } from "../adapters/wechat/extract.ts";
import { isBotSender } from "../adapters/core/sender-filter.ts";
import { CaptureWindows } from "./capture-windows.mjs";
import { now, RECENT_WINDOW_SEC } from "../domain/rules.mjs";
export class Collectors {
  constructor(repo, ingestion, changed = () => {}) {
    this.repo = repo;
    this.ingestion = ingestion;
    this.changed = changed;
    this.started = now();
    this.publisher = new TelegramBotPublisher();
    this.backfillStatus = {};
    this.backfillBounds = {};
    this.backfillTimers = {};
    this.startupBackfillPending = new Set();
    this.startupBackfillAttempts = {};
    this.windows = new CaptureWindows(repo);
    this.delivery = new ReliableDelivery(repo, m => {
      repo.transaction(()=>{
        const event={...m,isBot:isBotSender(m.sender,m.group,m.isBot,m.senderUsername),addresses:m.addrs??extractAddresses(m.text,1).addrs};
        const source=m.group.startsWith('tg:')?'telegram':'wechat';
        const previous=repo.get('SELECT payload FROM messages WHERE source=? AND channel=? AND message=?',source,m.group,m.sourceId);
        const prior=previous?JSON.parse(previous.payload):null;
        const applied=this.ingestion.ingest(event);
        const stream=this.delivery.stream(m);
        const current=['delete','retract'].includes(m.messageEvent)?[]:event.addresses;
        if(applied==='applied'){
          this.delivery.cancelPushes(stream,current);
          if(m._deliveryLive&&!event.isBot&&['create','edit'].includes(m.messageEvent||'create')){
            const earlier=prior?.addresses??prior?.addrs??[];
            for(const address of event.addresses.filter(a=>!earlier.includes(a))){
              const t=repo.tokenByAddress(address);
              const call={address,chain:t?.chain==='?'?null:t?.chain??m.chainHint,symbol:t?.symbol??null,mc:t?.baseline?.mc??null,sender:m.sender,senderId:m.senderId,telegramSenderId:source==='telegram'?m.senderId??null:null,group:m.group,groupName:m.group,time:m.time,sourceId:m.sourceId};
              if(this.publisher.canPublish(call))this.delivery.queuePush(stream,address,call,this.publisher.status().target);
            }
          }
          if(['delete','retract'].includes(m.messageEvent))this.publisher.cancelMessage(m.group.replace(/^tg:/,''),m.sourceId);
        }
        if(!m._deliveryHistorical)this.windows.committed(m);
      });
    }, async ({call,target})=>{
      if(this.publisher.status().target!==target||!this.publisher.canPublish(call))throw Error('转发配置暂停或已变更，保留待发送记录');
      const previous=repo.get('SELECT active,payload FROM messages WHERE source=? AND channel=? AND message=?',call.groupName.startsWith('tg:')?'telegram':'wechat',call.groupName,call.sourceId);
      if(!previous?.active||!JSON.parse(previous.payload).addresses?.includes(call.address))return;
      const sent=await this.publisher.publish(call);
      if(!sent&&!this.publisher.isOwnTelegramSender(call.telegramSenderId))throw Error('Delivery cancelled before sending');
    },path.join(DATA_DIR,'delivery-inbox-fallback.jsonl'));
    const accept = m => {
      const historical=m.backfill&&this.backfillBounds[m.group?.startsWith('tg:')?'telegram':'wechat'];
      if(!this.windows.windows[m.group]||!m.sourceId||(!(historical&&m.time>=historical.from&&m.time<=historical.to)&&!this.windows.accepts(m)))return false;
      this.delivery.receive({...m,_deliveryHistorical:!!historical,_deliveryLive:!m.backfill&&(m.messageEvent==='edit'?Number(m.messageRevision||m.time*1000)/1000:m.time)>=this.started});
      return true;
    };
    this.backfillVersions={wechat:0,telegram:0};
    this.wechat = new WatchManager(this.started, accept, (e, g) => {
      if (e.t === "error") repo.diagnostic("wechat", g, e.message);
      this.changed();
    });
    this.telegram = new TelegramMonitor(accept);
    this.telegram.onConnected = () => this.startPendingTelegramBackfill();
    this.wechat.knownMessages = (group) =>
      repo
        .all(
          "SELECT payload FROM messages WHERE source='wechat' AND channel=? AND active=1 ORDER BY revision DESC LIMIT 1000",
          group,
        )
        .map((r) => {const m=JSON.parse(r.payload);return {...m,messageRevision:m.revision??m.messageRevision};})
        .filter((m) => m.addresses?.length);
    this.telegram.historyStart = (peer) => this.windows.startAt("tg:" + peer);
    this.wechat.knownMessageAccepted=(group,id)=>!!repo.get("SELECT 1 FROM messages WHERE source='wechat' AND channel=? AND message=?",group,id);
    this.telegram.knownMessageRevision = (group,id) => repo.get(`
      SELECT MAX(revision) revision FROM (
        SELECT revision FROM messages WHERE source='telegram' AND channel=? AND message=?
        UNION ALL
        SELECT COALESCE(json_extract(payload,'$.messageRevision'),json_extract(payload,'$.time')*1000) revision
        FROM delivery_inbox WHERE json_extract(payload,'$.group')=? AND json_extract(payload,'$.sourceId')=?
      )`,group,id,group,id)?.revision ?? null;
    this.telegram.knownDeletePeers = id => this.delivery.telegramDeletePeers(id);
    this.telegram.onUnresolvedDelete = (id) =>
      repo.diagnostic(
        "telegram_delete",
        null,
        `无法唯一确认撤回消息 ${id} 的群，保留原记录`,
      );
  }
  async start() {
    this.delivery.start();
    const settings = this.repo.setting("monitor", { wechat: [], telegram: [] });
    this.startupBackfillPending.clear();
    if (settings.wechat.length) this.startupBackfillPending.add('wechat');
    if (settings.telegram.length) this.startupBackfillPending.add('telegram');
    this.windows.configure(settings);
    for (const group of settings.wechat)
      this.wechat.setSince(group, this.windows.startAt(group));
    this.wechat.sync(settings.wechat, this.repo.setting('senderFilters',{}));
    await this.telegram.start(settings.telegram, this.repo.setting('senderFilters',{}), this.started);
    if (settings.wechat.length || settings.telegram.length) {
      const timer = setTimeout(() => {
        delete this.startupBackfillTimer;
        this.startPendingWechatBackfill();
        this.startPendingTelegramBackfill();
      }, 1500);
      timer.unref?.();
      this.startupBackfillTimer = timer;
    }
  }
  startPendingTelegramBackfill() {
    if (!this.startupBackfillPending.has('telegram')) return;
    if (this.telegram.status().state !== 'connected') return;
    const status = this.backfillStatus.telegram?.status;
    if (['started', 'progress', 'waiting'].includes(status)) return;
    if (status === 'done') { this.startupBackfillPending.delete('telegram'); return; }
    try { this.runBackfill('telegram', '24h'); }
    catch (error) {
      this.backfillStatus.telegram = { channel: 'telegram', status: 'waiting', error: error.message };
      this.scheduleStartupBackfillRetry('telegram', '24h');
      this.changed();
    }
  }
  startPendingWechatBackfill() {
    if (!this.startupBackfillPending.has('wechat')) return;
    const status = this.backfillStatus.wechat?.status;
    if (['started', 'progress', 'waiting'].includes(status)) return;
    if (status === 'done') { this.startupBackfillPending.delete('wechat'); return; }
    try { this.runBackfill('wechat', '24h'); }
    catch (error) {
      this.backfillStatus.wechat = { channel: 'wechat', status: 'waiting', error: error.message };
      this.scheduleStartupBackfillRetry('wechat', '24h');
      this.changed();
    }
  }
  scheduleStartupBackfillRetry(source, duration) {
    clearTimeout(this.backfillTimers[source]);
    const attempt = this.startupBackfillAttempts[source] || 0;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
    this.startupBackfillAttempts[source] = attempt + 1;
    const timer = setTimeout(() => {
      delete this.backfillTimers[source];
      if (!this.startupBackfillPending.has(source)) return;
      try { this.runBackfill(source, duration, source === 'telegram' && this.telegram.hasBackfillJob, true); }
      catch (error) {
        this.backfillStatus[source] = { channel: source, status: 'waiting', error: error.message };
        this.scheduleStartupBackfillRetry(source, duration);
        this.changed();
      }
    }, delay);
    timer.unref?.();
    this.backfillTimers[source] = timer;
  }
  update(settings) {
    if (!Array.isArray(settings.wechat) || !Array.isArray(settings.telegram))
      throw Error("监控群配置无效");
    const old=this.repo.setting("monitor",{wechat:[],telegram:[]});
    for(const source of ['wechat','telegram']){
      const before=new Set(source==='wechat'?old.wechat:old.telegram.map(g=>g.peerId));
      const next=source==='wechat'?settings.wechat:settings.telegram.map(g=>g.peerId);
      if(next.some(id=>!before.has(id))){
        this.backfillVersions[source]++;this.startupBackfillPending.add(source);
        if(!['started','progress','waiting'].includes(this.backfillStatus[source]?.status))delete this.backfillStatus[source];
      }
    }
    this.repo.set("monitor", settings);
    this.windows.configure(settings);
    for (const group of settings.wechat)
      this.wechat.setSince(group, this.windows.startAt(group));
    this.wechat.sync(settings.wechat, this.repo.setting('senderFilters',{}));
    this.telegram.sync(settings.telegram, this.repo.setting('senderFilters',{}), this.started);
    if (!settings.wechat.length) this.startupBackfillPending.delete('wechat');
    else if (this.startupBackfillPending.has('wechat')) this.startPendingWechatBackfill();
    if (!settings.telegram.length) this.startupBackfillPending.delete('telegram');
    else if (this.startupBackfillPending.has('telegram')) this.startPendingTelegramBackfill();
    this.changed();
  }
  status() {
    return {
      delivery: this.delivery.status(),
      wechat: this.wechat.status(),
      telegram: this.telegram.status(),
    };
  }
  async groups(source) {
    return source === "telegram"
      ? this.telegram.chats()
      : this.wechat.reader.listGroups(500);
  }
  async action(action, body) {
    const s = this.repo.setting("monitor", { wechat: [], telegram: [] });
    if (action === "configure")
      return this.telegram.configure(
        Number(body.apiId),
        String(body.apiHash ?? ""),
        s.telegram,
        {},
        this.started,
      );
    if (action === "code")
      return this.telegram.sendLoginCode(String(body.phone ?? ""));
    if (action === "verify")
      return this.telegram.verifyLoginCode(String(body.code ?? ""));
    if (action === "password")
      return this.telegram.verifyPassword(String(body.password ?? ""));
    if (action === "reconnect") return this.telegram.reconnect(this.started);
    throw Error("未知登录操作");
  }
  async stop() {
    clearTimeout(this.startupBackfillTimer);
    for (const timer of Object.values(this.backfillTimers)) clearTimeout(timer);
    this.backfillTimers = {};
    this.startupBackfillAttempts = {};
    this.startupBackfillPending.clear();
    this.wechat.stop();
    await this.telegram.stop();
    await this.delivery.stop();
  }
  runBackfill(source, duration, resume=false, keepBounds=false) {
    if (!['wechat','telegram'].includes(source)) throw Error('回读来源无效');
    const seconds={'6h':6*3600,'12h':12*3600,'24h':RECENT_WINDOW_SEC,'3d':259200,'7d':604800}[duration];
    if (!seconds) throw Error('回读范围无效');
    if (['started','progress'].includes(this.backfillStatus[source]?.status)) throw Error('该来源正在回读');
    const bounds=(resume||keepBounds)&&this.backfillBounds[source]?this.backfillBounds[source]:{from:now()-seconds,to:now(),version:this.backfillVersions[source]};
    const version=bounds.version??this.backfillVersions[source];
    this.backfillBounds[source]=bounds;
    this.backfillStatus[source]={channel:source,status:'started',duration};
    const report=p=>{this.backfillStatus[source]={channel:source,status:p.phase==='waiting'?'waiting':'progress',duration,...p,totalGroups:p.groupsTotal,completedGroups:p.groupsCompleted,currentGroup:p.group};this.changed();};
    void this[source].backfillSince(bounds.from,report,resume).then(r=>{
      this.backfillStatus[source]={channel:source,status:r.waiting?'waiting':'done',duration,...r,retryAt:r.retryAt};
      if (!r.waiting && version===this.backfillVersions[source]) {
        this.startupBackfillPending.delete(source);
        delete this.startupBackfillAttempts[source];
      }
      if(!r.waiting){delete this.backfillBounds[source];clearTimeout(this.backfillTimers[source]);delete this.backfillTimers[source];}
      else if(r.retryAt){
        clearTimeout(this.backfillTimers[source]);
        const timer=setTimeout(()=>{delete this.backfillTimers[source];try{this.runBackfill(source,duration,true);}catch(error){this.backfillStatus[source]={channel:source,status:'error',error:error.message};delete this.backfillBounds[source];this.changed();}},Math.max(1000,r.retryAt-Date.now()));
        timer.unref?.();this.backfillTimers[source]=timer;
      }
      if(!r.waiting&&version!==this.backfillVersions[source]){this.backfillStatus[source]={channel:source,status:'waiting',duration:'24h'};this.scheduleStartupBackfillRetry(source,'24h');}
      this.changed();
    }).catch(e=>{
      if (this.startupBackfillPending.has(source)) {
        this.backfillStatus[source]={channel:source,status:'waiting',duration,error:e.message};
        this.scheduleStartupBackfillRetry(source,duration);
      } else {
        this.backfillStatus[source]={channel:source,status:'error',error:e.message};
        delete this.backfillBounds[source];
      }
      this.changed();
    });
    return {ok:true,duration};
  }
}
