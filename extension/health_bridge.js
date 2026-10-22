// Read-only, conversation-scoped projection of observations already owned by 429.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.A429Health=api;})(globalThis,function(){
 'use strict';
 const SCHEMA='a429-health/v1',MAX_AGE=5*60*1000;
 function validId(id){return typeof id==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(id);}
 function observe(previous,scan,now){
  const rows={...previous};
  if(!scan||scan.ok!==true)return rows;
  for(const it of scan.items||[]){if(!validId(it.id))continue;
   const old=rows[it.id]||{},has=Object.prototype.hasOwnProperty.call(scan.statuses||{},it.id);
   // List observation and stream observation have independent clocks.
   rows[it.id]={conversation_id:it.id,async_status:Number.isInteger(it.a)?it.a:null,updated_at_ms:Number.isFinite(it.u)?it.u:null,
    list_observed_at_ms:now,stream_status:has?scan.statuses[it.id]:old.stream_status||null,
    stream_observed_at_ms:has?now:old.stream_observed_at_ms||null,
    stream_update_time_ms:has?it.u:old.stream_update_time_ms||null};
  }
  return Object.fromEntries(Object.entries(rows).filter(([,r])=>now-r.list_observed_at_ms<86400000).sort((a,b)=>b[1].list_observed_at_ms-a[1].list_observed_at_ms).slice(0,400));
 }
 function snapshot(id,reaper={},cfg={},families={},now=Date.now()){
  if(!validId(id))return {ok:false,error:'CONVERSATION_ID_INVALID'};
  const row=reaper.health?.[id]||null;
  const fresh=t=>Number.isFinite(t)&&t<=now+5000&&now-t<=MAX_AGE;
  const listFresh=!!row&&fresh(row.list_observed_at_ms);
  const streamFresh=!!row&&fresh(row.stream_observed_at_ms)&&row.stream_update_time_ms===row.updated_at_ms;
  const cooling=Math.max(0,...Object.values(families).map(v=>Number(v.cd)||0));
  let state='UNKNOWN',reason=row?'STALE_OR_INCOMPLETE_OBSERVATION':'NO_SCOPED_OBSERVATION';
  if(cfg.enabled===false){state='OBSERVER_DISABLED';reason='429_DISABLED';}
  else if(cooling>now){state='RATE_LIMITED';reason='ACCOUNT_RETRY_AFTER';}
  else if(listFresh&&streamFresh){
   const st=row.stream_status;
   if(st==='IS_STREAMING'){state='RUNNING';reason='STREAM_ACTIVE';}
   else if(st==='IS_STOP_REQUESTED'){state='STOP_REQUESTED';reason='STOP_NOT_YET_CONFIRMED';}
   else if(row.async_status===3){state=st==='COMPLETE'&&now-(row.updated_at_ms||0)<(cfg.runStaleMs||900000)?'ASYNC_RUNNING':'ASYNC_STALE_OR_UNCONFIRMED';reason='ASYNC_3_IS_NOT_FINISHED_BY_STREAM_COMPLETE';}
   else if(st==='COMPLETE'&&row.async_status!==null){state='NO_ACTIVE_STREAM';reason='RESULT_NOT_YET_VERIFIED';}
  }
  return {ok:true,schema:SCHEMA,conversation_id:id,observer:'ANTI429_CACHED_AUDIT',sampled_at_ms:now,
   observation:row,state,reason,list_fresh:listFresh,stream_fresh:streamFresh,max_age_ms:MAX_AGE,
   cooldown_until_ms:cooling>now?cooling:null,scope:'SAME_CHROME_PROFILE',
   audit_error:typeof reaper.lastError==='string'?reaper.lastError.slice(0,120):null,
   network_requests_started:0,send:false,retry:false,stop:false};
 }
 return {SCHEMA,MAX_AGE,validId,observe,snapshot};
});
