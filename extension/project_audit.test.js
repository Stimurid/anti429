"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const fs=require("node:fs");
const path=require("node:path");
const {webcrypto}=require("node:crypto");
const {TextEncoder}=require("node:util");
const SRC=fs.readFileSync(path.join(__dirname,"project_audit_bridge.js"),"utf8");
const PID="g-p-1234567890abcdef1234567890abcdef";
const QID="g-p-abcdef1234567890abcdef1234567890";
const CID="aaaabbbb-cccc-dddd-eeee-000011112222";
const SECOND="aaaabbbb-cccc-dddd-eeee-000011112223";
const response=obj=>({ok:true,status:200,async json(){return obj;}});
async function scan({projects=[PID],projectMembers={},list=null}={}){
 let listener=null;
 const calls=[];
 const projectSet=new Set(projects);
 const fetch=async address=>{
  calls.push(String(address));
  if(address==="/api/auth/session")
   return response({accessToken:"mock-never-returned",user:{id:"test-account-1234567890"},activeAccountId:"acc-001"});
  if(address.startsWith("/backend-api/gizmos/snorlax/sidebar"))
   return response({items:projects.map(id=>({gizmo:{gizmo:{
     id,display:{name:id===PID?"МЕТАКСИ":"Артикль"}
   }}})),cursor:null});
  if(address.startsWith("/backend-api/conversations?")){
   const offset=Number(new URL("https://chatgpt.com"+address).searchParams.get("offset"));
   return response({items:offset===0?(list||[
    {id:CID,title:"PRIVATE",gizmo_id:null,update_time:"2020-01-01"}
   ]):[]});
  }
  for(const project of projectSet){
   if(address.startsWith("/backend-api/gizmos/"+project+"/conversations"))
    return response({items:(projectMembers[project]||[]).map(id=>({
     id,title:"PRIVATE",gizmo_id:null,update_time:"2020-01-01"
    })),cursor:null});
  }
  throw Error("Unexpected network request "+address);
 };
 const chrome={runtime:{id:"own-429-extension",onMessage:{
  addListener(fn){listener=fn;}
 }}};
 vm.runInNewContext(SRC,{chrome,fetch,crypto:webcrypto,TextEncoder,
  setTimeout,Date,Promise,console});
 assert.equal(typeof listener,"function");
 const answer=await new Promise(resolve=>{
  const asynchronous=listener({type:"a429_project_audit_v1",params:{
   paceMs:0,maxList:28,maxStatus:1,projectPages:1,maxProjects:2,
   projectIds:projects,catalogFetch:true,projectOffset:0
  }},{id:chrome.runtime.id},resolve);
  assert.equal(asynchronous,true);
 });
 return {answer,calls};
}
test("old /c/... chat is recognized via project-specific list despite general null",async()=>{
 const {answer,calls}=await scan({projectMembers:{[PID]:[CID]}});
 assert.equal(answer.ok,true);
 assert.equal(answer.items.length,1);
 assert.equal(answer.items[0].id,CID);
 assert.equal(answer.items[0].g,PID);
 assert.equal(answer.items[0].conflict,false);
 assert.equal(answer.projectNames[PID],"МЕТАКСИ");
 assert.match(answer.accountScope,/^sha256:[0-9a-f]{64}$/);
 assert.equal(calls.filter(x=>x.includes("/conversation/"+CID)).length,0);
 assert(calls.some(x=>x.includes("snorlax/sidebar")));
 assert(!JSON.stringify(answer).includes("mock-never-returned"));
});
test("same chat positively listed in two projects is CONFLICT, never picked by order",async()=>{
 const {answer}=await scan({projects:[PID,QID],
   projectMembers:{[PID]:[CID],[QID]:[CID]}});
 assert.equal(answer.ok,true);
 assert.equal(answer.items.length,1);
 assert.equal(answer.items[0].conflict,true);
 assert.equal(answer.items[0].g,null);
});
test("unknown and absent projects remain unknown, not title-inferred",async()=>{
 const {answer}=await scan({projectMembers:{},list:[{
   id:SECOND,title:"МЕТАКСИ",gizmo_id:null,update_time:"2020-01-01"
 }]});
 assert.equal(answer.ok,true);
 assert.equal(answer.items[0].g,null);
 assert.equal(answer.items[0].conflict,false);
});
test("project scanner adds no periodic loop, and ignores foreign messages",()=>{
 assert(!SRC.includes("setInterval("));
 assert(SRC.includes("a429_project_audit_v1"));
 assert(!SRC.includes("a429_tabstate"));
});
