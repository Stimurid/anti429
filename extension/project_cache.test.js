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
 const bridge=fs.readFileSync(path.join(__dirname,"bridge.js"),"utf8");
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
