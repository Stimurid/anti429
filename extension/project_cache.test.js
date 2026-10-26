"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const cache=require("./project_cache.js");
const CID="abc12345-def0-1234-5678-123456789012";
const OTHER="abc12345-def0-1234-5678-123456789013";
const PROJECT="g-p-1234567890abcdef1234567890abcdef";
const SCOPE="sha256:"+"a".repeat(64);
test("429 exposes only fresh positive exact provider project membership",()=>{
 const now=1700000000000;
 const c=cache.update(null,{accountScope:SCOPE,items:[{id:CID,g:PROJECT}]},now);
 const r=cache.read(c,[CID,OTHER],now+1000);
 assert.equal(r.ok,true);assert.equal(r.providerRequests,0);assert.equal(r.cacheOnly,true);
 assert.equal(r.matches[CID].projectId,PROJECT);
 assert.equal(r.matches[OTHER],undefined);
 assert.equal(JSON.stringify(r).includes("title"),false);
});
test("different accounts and missing scope fail closed rather than mixing",()=>{
 const now=1700000000000;
 const first=cache.update(null,{accountScope:SCOPE,items:[{id:CID,g:PROJECT}]},now);
 const second=cache.update(first,{accountScope:"sha256:"+"b".repeat(64),items:[]},now+1000);
 assert.equal(Object.keys(second.records).length,0);
 assert.equal(cache.read(second,[CID],now+1000).matches[CID],undefined);
 const unscoped=cache.update(second,{accountScope:null,items:[{id:CID,g:PROJECT}]},now+2000);
 assert.equal(cache.read(unscoped,[CID],now+2000).error,"PROJECT_CACHE_UNSCOPED");
});
test("conflicting or explicit none provider evidence invalidates prior project",()=>{
 const now=1700000000000;
 let state=cache.update(null,{accountScope:SCOPE,items:[{id:CID,g:PROJECT}]},now);
 state=cache.update(state,{accountScope:SCOPE,
   items:[{id:CID,g:null,conflict:true}]},now+1000);
 assert.equal(cache.read(state,[CID],now+1000).matches[CID],undefined);
 state=cache.update(state,{accountScope:SCOPE,items:[{id:CID,g:PROJECT}]},now+2000);
 state=cache.update(state,{accountScope:SCOPE,
   items:[{id:CID,g:null,explicitNone:true}]},now+3000);
 assert.equal(cache.read(state,[CID],now+3000).matches[CID],undefined);
});
test("expired evidence, invalid ids and oversized requests are rejected",()=>{
 const now=1700000000000;
 let state=cache.update(null,{accountScope:SCOPE,items:[{id:CID,g:PROJECT}]},now);
 assert.equal(cache.read(state,[CID],now+cache.TTL_MS+1).matches[CID],undefined);
 assert.equal(cache.read(state,["x"],now).error,"INVALID_CONVERSATION_IDS");
 assert.equal(cache.read(state,Array(129).fill(CID),now).error,"INVALID_CONVERSATION_IDS");
});
test("integration uses existing audit only and restricts HYDRA caller",()=>{
 const bg=fs.readFileSync(path.join(__dirname,"background.js"),"utf8");
 const bridge=fs.readFileSync(path.join(__dirname,"project_audit_bridge.js"),"utf8");
 assert.match(bg,/importScripts\("shared.js", "health_bridge.js", "project_cache.js"\)/);
 assert.match(bg,/A429ProjectCache.update\(prior,scan,Date.now\(\)\)/);
 assert.match(bg,/msg\?\.type==="hydra.projectMembership.read"/);
 assert.match(bg,/sender.id==="opgnfgihbjphabgflgnaiamenmdgfjom"/);
 assert.match(bg,/cacheModule.read\(cache,ids,Date.now\(\)\)/);
 assert.match(bridge,/accountScope = null/);
 assert.match(bridge,/digest = await crypto.subtle.digest/);
 assert.match(bridge,/const seen = new Map/);
 assert.match(bridge,/prior\.g&&project&&prior\.g!==project/);
});

test("catalog display name binds to exact project ID without chat title leakage",()=>{
 const now=1700000000000;
 const state=cache.update(null,{accountScope:SCOPE,
  projectNames:{[PROJECT]:"  МЕТАКСИ   07  "},
  items:[{id:CID,g:PROJECT,t:"PRIVATE CONVERSATION TITLE"}]},now);
 const result=cache.read(state,[CID],now+1000);
 assert.equal(result.ok,true);
 assert.equal(result.names[PROJECT].name,"МЕТАКСИ 07");
 assert.equal(result.names[PROJECT].source,"provider_project_catalog");
 assert.equal(result.matches[CID].projectId,PROJECT);
 assert.equal(JSON.stringify(result).includes("PRIVATE CONVERSATION TITLE"),false);
 assert.equal(result.names["g-p-unknown"],undefined);
});
test("catalog names and project membership expire separately",()=>{
 const now=1700000000000;
 let state=cache.update(null,{accountScope:SCOPE,
  projectNames:{[PROJECT]:"Артикль"},items:[{id:CID,g:PROJECT}]},now);
 const later=cache.read(state,[CID],now+cache.TTL_MS+1);
 assert.equal(later.matches[CID],undefined);
 assert.equal(later.names[PROJECT],undefined);
});
test("scoped catalogue is flushed on login switch",()=>{
 const now=1700000000000;
 const a=cache.update(null,{accountScope:SCOPE,
  projectNames:{[PROJECT]:"МЕТАКСИ"},items:[{id:CID,g:PROJECT}]},now);
 const b=cache.update(a,{accountScope:"sha256:"+"c".repeat(64),items:[]},now+1000);
 assert.deepEqual(b.records,{});
 assert.deepEqual(b.names,{});
});
test("429 bridges HYDRA without a new scan on read and keeps the 429 limiter",()=>{
 const bg=fs.readFileSync(path.join(__dirname,"background.js"),"utf8");
 const provider=fs.readFileSync(path.join(__dirname,"project_audit_bridge.js"),"utf8");
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,"manifest.json"),"utf8"));
 assert.equal(manifest.version,"0.5.15");
 assert(bg.includes('msg?.type==="hydra.projectMembership.read"'));
 assert(bg.includes("cacheModule.read(cache,ids,Date.now())"));
 assert(bg.includes("calmNow(now)"));
 assert(bg.includes("projectCursors: R.projectCursors||{}"));
 assert(provider.includes('const explicitNone=false'));
 assert(provider.includes('const seen = new Map()'));
 assert(provider.includes('out.projectCursors[g]=cur'));
});
