import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
import {Repository} from './database.mjs';
import {rank} from '../domain/rules.mjs';
import {performance} from 'node:perf_hooks';

// A separate read-only connection: never run migrations or write application data here.
const reader=Object.create(Repository.prototype);
reader.db=new Database(workerData.filename,{readonly:true,fileMustExist:true});
reader.db.pragma('busy_timeout=1000');
reader.performanceMetrics=new Map();
parentPort.on('message',({id})=>{
  try{
    const started=performance.now();
    const snapshot=reader.db.transaction(()=>{
      const rows=reader.view(),leaderboard=rank(rows);
      const overview={total:rows.length,formal:0,reference:0,pending:0,wins:0};
      for(const row of rows){if(row.priceMultiple!=null)overview.formal++;else overview.pending++;if(row.priceMultiple>=2)overview.wins++;}
      return {rows,leaderboard,overview};
    }).deferred();
    parentPort.postMessage({id,snapshot,elapsedMs:performance.now()-started});
  }catch(error){parentPort.postMessage({id,error:String(error.message)});}
});
