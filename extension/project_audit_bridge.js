// 429 v0.5.15: on-demand account audit in the existing selected ChatGPT tab.
// Separate from bridge.js gen3: no second traffic/status timer, no duplicate
// legacy onMessage responder after extension reload, no user page reload.
(()=>{
  "use strict";
  if(globalThis.__A429_PROJECT_AUDIT_VERSION__==="0.5.15")return;
  globalThis.__A429_PROJECT_AUDIT_VERSION__="0.5.15";
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));
  async function scanAccount(p) {
    const pace = Math.max(0, p.paceMs == null ? 2000 : p.paceMs); // one request per `pace` ms: stay far below the limiters
    const t0 = Date.now();
    const out = { ok: false, items: [], statuses: {}, rate: false, errors: 0,
      requests: 0, ms: 0, projectNames: {}, projectCursors: {}, projectsScanned: 0,
      catalogFetched: false, catalogNextCursor: null };
    let tok = null, accountScope = null;
    try {
      const session = await (await fetch("/api/auth/session", { credentials: "include" })).json();
      tok = session && session.accessToken;
      // Only a non-reversible local fingerprint leaves this closure. Never return
      // an access token, session cookie, email or raw user/account identifier.
      const user = session && session.user && (session.user.id || session.user.sub);
      const activeAccount = session && (session.activeAccountId || (session.account && session.account.id) || "");
      if (typeof user === "string" && user.length >= 8 && crypto.subtle) {
        const raw = new TextEncoder().encode("429-project-scope-v1:" + user + ":" + String(activeAccount));
        const digest = await crypto.subtle.digest("SHA-256",raw);
        accountScope = "sha256:" + [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
      }
    } catch {}
    if (!tok) return { ok: false, reason: "no-session" };
    out.accountScope = accountScope;
    const H = { Authorization: "Bearer " + tok };
    let lastAt = 0;
    const get = async url => {
      // spacing is enforced HERE, before every single request, so no code path can ever burst
      const wait = lastAt + pace - Date.now();
      if (wait > 0) await sleepMs(wait);
      lastAt = Date.now();
      let r;
      out.requests++;
      try { r = await fetch(url, { credentials: "include", headers: H }); } catch { out.errors++; return null; }
      if (r.status === 429) { out.rate = true; return null; }
      if (!r.ok) { out.errors++; return null; }
      return r;
    };
    const seen = new Map();
    const validProject = id => typeof id === "string" && /^g-p-[a-z0-9-]{8,80}$/i.test(id);
    const gizmos = new Set((p.projectIds || []).filter(validProject));
    const add = (it, g) => {
      if (!it || typeof it.id !== "string" || !/^[a-z0-9-]{8,80}$/i.test(it.id)) return;
      const listed=validProject(g)?g:null;
      const itemProject=validProject(it.gizmo_id)?it.gizmo_id:null;
      // A general-list null is NOT proof that a project membership was
      // removed: project-specific lists can still return the same chat.
      // Only an explicit positive project ID is accepted as evidence here.
      const explicitNone=false;
      if(itemProject)gizmos.add(itemProject);
      const conflict=!!(listed&&itemProject&&listed!==itemProject);
      const project=conflict?null:(itemProject||listed);
      const prior=seen.get(it.id);
      if(prior){
        // A conversation may be in BOTH the general list and its project list.
        // Reconcile the evidence instead of losing the later project membership.
        if(conflict||prior.conflict||(prior.g&&project&&prior.g!==project)){
          prior.g=null;prior.conflict=true;prior.explicitNone=false;
        }else if(project&&!prior.g){
          prior.g=project;prior.explicitNone=false;
        }else if(explicitNone&&!prior.g)prior.explicitNone=true;
        return;
      }
      const record={id:it.id,t:String(it.title||"").slice(0,40),
        u:Date.parse(it.update_time)||0,g:project,a:it.async_status==null?null:it.async_status,
        explicitNone:explicitNone&&!project,conflict};
      seen.set(it.id,record);out.items.push(record);
    };
    // Discover project IDs/names via a single paced project-sidebar page in
    // the EXISTING audit loop. Never issue a second scan from HYDRA.
    if (p.catalogFetch && !out.rate) {
      const cursor=typeof p.catalogCursor==="string"&&p.catalogCursor!=="0"?
        "&cursor="+encodeURIComponent(p.catalogCursor):"";
      const r=await get("/backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0"+cursor);
      if(r){
        let j=null;try{j=await r.json();}catch(_){out.errors++;}
        if(j&&Array.isArray(j.items)){
          for(const item of j.items){
            const project=item?.gizmo?.gizmo;
            const id=project?.id,name=project?.display?.name;
            if(!validProject(id)||typeof name!=="string"||!name.trim())continue;
            gizmos.add(id);
            out.projectNames[id]=name.replace(/\s+/g," ").trim().slice(0,64);
          }
          out.catalogFetched=true;
          out.catalogNextCursor=typeof j.cursor==="string"&&j.cursor?j.cursor:null;
        }
      }
    }
    for (let off = 0; off < (p.maxList || 112) && !out.rate; off += 28) {
      const r = await get("/backend-api/conversations?offset=" + off + "&limit=28&order=updated");
      if (!r) break;
      const j = await r.json();
      if (!j.items || !j.items.length) break;
      j.items.forEach(it => add(it, null));
    }
    // Progressive catalog traversal. Bound requests per audit and resume
    // each project's opaque pagination cursor on subsequent audits, so old
    // /c/... conversations eventually become covered without full history GETs.
    const allProjects=[...gizmos].filter(validProject);
    const offset=allProjects.length?
      Math.max(0,Math.floor(Number(p.projectOffset)||0))%allProjects.length:0;
    const maxProjects=Math.min(12,Math.max(0,Math.floor(Number(p.maxProjects)||4)));
    const selected=allProjects.length?
      Array.from({length:Math.min(maxProjects,allProjects.length)},
        (_,i)=>allProjects[(offset+i)%allProjects.length]):[];
    for(const g of selected){
      if(out.rate)break;
      let cur=typeof p.projectCursors?.[g]==="string"&&p.projectCursors[g]?
        p.projectCursors[g]:"0";
      let scanned=false;
      for(let i=0;i<(p.projectPages||1)&&!out.rate;i++){
        const r=await get("/backend-api/gizmos/"+encodeURIComponent(g)+
          "/conversations?cursor="+encodeURIComponent(cur)+"&limit=25");
        if(!r)break;
        let j;try{j=await r.json();}catch(_){out.errors++;break;}
        if(!Array.isArray(j.items))break;
        j.items.forEach(it=>add(it,g));
        scanned=true;
        cur=typeof j.cursor==="string"&&j.cursor&&j.items.length?j.cursor:"0";
        if(cur==="0")break;
      }
      if(scanned){
        out.projectCursors[g]=cur;
        out.projectsScanned++;
      }else if(!out.rate){
        // A private or removed project must not keep the whole rotation stuck.
        out.projectsScanned++;
      }
    }
    const now = Date.now();
    const skip = p.skip || {};
    const suspects = [], fresh = [];
    for (const it of out.items) {
      if ((p.checkIds || []).includes(it.id) || it.a === 3) { suspects.push(it.id); continue; } // async_status 3: a run OR a zombie - the status tells which
      if (skip[it.id] && skip[it.id] === it.u) continue; // already known COMPLETE at this update_time
      if (it.u && now - it.u <= (p.lookbackMs || 14 * 86400000)) fresh.push(it);
    }
    fresh.sort((a, b) => b.u - a.u); // most recently active first: new zombies are caught early, the old backlog drains over time
    const present=new Set(out.items.map(x=>x.id));
    const want = [...new Set((p.checkIds||[]).filter(id=>present.has(id)).concat(suspects,fresh.map(x => x.id)))];
    for (const id of want.slice(0, p.maxStatus || 20)) {
      if (out.rate) break;
      const r = await get("/backend-api/conversation/" + id + "/stream_status");
      if (!r) continue;
      try { const j = await r.json(); out.statuses[id] = (j && j.status) || null; } catch {}
    }
    out.ok = true;
    out.ms = Date.now() - t0;
    return out;
  }


  chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
    if(msg?.type!=="a429_project_audit_v1"||sender.id!==chrome.runtime.id)return;
    scanAccount(msg.params||{}).then(sendResponse,
      ()=>sendResponse({ok:false,reason:"project-audit-error"}));
    return true;
  });
})();
