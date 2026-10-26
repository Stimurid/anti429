// Read-only project membership cache built solely from the existing 429 account audit.
// Stores no chat title, content, session token or full provider response.
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.A429ProjectCache=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const STORAGE_KEY="a429.hydra.projectEvidence.v1";
  const TTL_MS=24*60*60*1000;
  const NAMES_TTL_MS=48*60*60*1000;
  const MAX_RECORDS=2400,MAX_QUERY=128;
  const CID=/^[a-z0-9-]{8,80}$/i,PROJECT=/^g-p-[a-z0-9-]{8,80}$/i;
  const SCOPE=/^sha256:[a-f0-9]{64}$/;
  const goodId=x=>typeof x==="string"&&CID.test(x);
  const goodProject=x=>typeof x==="string"&&PROJECT.test(x);
  const goodScope=x=>typeof x==="string"&&SCOPE.test(x);
  function prune(input,now){
    const src=input&&typeof input==="object"?input:{};
    const entries=Object.entries(src.records||{})
      .filter(([id,r])=>goodId(id)&&r&&goodProject(r.projectId)&&
        Number.isFinite(r.at)&&r.at<=now+60000&&now-r.at>=0&&now-r.at<TTL_MS)
      .sort((a,b)=>b[1].at-a[1].at).slice(0,MAX_RECORDS);
    const names=Object.fromEntries(Object.entries(src.names||{})
      .filter(([id,r])=>goodProject(id)&&r&&typeof r.name==="string"&&
        r.name.length>0&&r.name.length<=64&&Number.isFinite(r.at)&&
        r.at<=now+60000&&now-r.at>=0&&now-r.at<NAMES_TTL_MS)
      .sort((a,b)=>b[1].at-a[1].at).slice(0,400));
    return {schema:1,scope:goodScope(src.scope)?src.scope:null,
      lastScanAt:Number.isFinite(src.lastScanAt)?src.lastScanAt:0,
      records:Object.fromEntries(entries),names};
  }
  function update(previous,scan,now=Date.now()){
    const scope=scan&&scan.accountScope;
    // An unscoped scan cannot be allowed to mingle different logins.
    if(!goodScope(scope))return {schema:1,scope:null,lastScanAt:0,records:{},names:{}};
    const old=prune(previous,now);
    const records=old.scope===scope?{...old.records}:{};
    const names=old.scope===scope?{...old.names}:{};
    for(const [id,value] of Object.entries(scan.projectNames||{})){
      const name=typeof value==="string"?
        value.replace(/\\s+/g," ").trim().slice(0,64):"";
      if(goodProject(id)&&name)names[id]={name,at:now};
    }
    for(const item of Array.isArray(scan.items)?scan.items:[]){
      if(!item||!goodId(item.id))continue;
      if(item.conflict===true||item.explicitNone===true){
        delete records[item.id];continue;
      }
      if(goodProject(item.g)){
        records[item.id]={projectId:item.g,at:now,source:"provider_native"};
      }
    }
    return prune({schema:1,scope,lastScanAt:now,records,names},now);
  }
  function read(raw,ids,now=Date.now()){
    if(!Array.isArray(ids)||ids.length<1||ids.length>MAX_QUERY||
       ids.some(id=>!goodId(id)))return {ok:false,error:"INVALID_CONVERSATION_IDS"};
    const cache=prune(raw,now);
    if(!cache.scope)return {ok:false,error:"PROJECT_CACHE_UNSCOPED",matches:{},lastScanAt:0};
    const matches={},names={};
    for(const id of new Set(ids)){
      const rec=cache.records[id];
      if(rec){
        matches[id]={projectId:rec.projectId,verified:true,
          source:"provider_native",observedAt:rec.at,expiresAt:rec.at+TTL_MS};
        const project=cache.names[rec.projectId];
        if(project)names[rec.projectId]={name:project.name,verified:true,
          source:"provider_project_catalog",observedAt:project.at,
          expiresAt:project.at+NAMES_TTL_MS};
      }
    }
    return {ok:true,scope:cache.scope,matches,names,lastScanAt:cache.lastScanAt,
      scanAgeMs:now-cache.lastScanAt,cacheOnly:true,providerRequests:0};
  }
  return {STORAGE_KEY,TTL_MS,NAMES_TTL_MS,MAX_RECORDS,MAX_QUERY,goodId,goodProject,
    goodScope,update,prune,read};
});
