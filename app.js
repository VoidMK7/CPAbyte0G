const tg = window.Telegram?.WebApp;
let actor = null, selected = new Set(), cache = [];

function headers(){ return {"content-type":"application/json","x-telegram-init-data":tg?.initData || ""}; }
async function api(url, options={}) {
  const r = await fetch(url, { ...options, headers:{...headers(), ...(options.headers||{})}});
  const text = await r.text();
  const data = (()=>{try{return JSON.parse(text)}catch{return {error:text}}})();
  if(!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
async function login(){
  if(!tg?.initData){document.querySelector("#loginError").textContent="Open this panel from Telegram.";return;}
  try{
    const d=await api("/api/admin/session",{method:"POST",body:JSON.stringify({initData:tg.initData})});
    actor=d.actor; document.querySelector("#login").hidden=true; document.querySelector("#app").hidden=false;
    document.querySelector("#role").textContent=actor.role;
    if(actor.role!=="OWNER")document.querySelector("#modsTab").hidden=true;
    tg.expand(); loadDashboard(); loadProofs();
  }catch(e){document.querySelector("#loginError").textContent=e.message;}
}
function initTabs(){
  document.querySelectorAll(".tabs button").forEach(b=>b.onclick=()=>{
    document.querySelectorAll(".tabs button").forEach(x=>x.classList.remove("active"));b.classList.add("active");
    document.querySelectorAll(".tab").forEach(x=>x.hidden=true);document.getElementById(b.dataset.tab).hidden=false;
    if(b.dataset.tab==="dashboard")loadDashboard();if(b.dataset.tab==="proofs")loadProofs();if(b.dataset.tab==="moderators")loadMods();
  });
}
async function loadDashboard(){
  try{const d=await api("/api/admin/dashboard");["pending","approved","rejected","total"].forEach(k=>document.getElementById(k).textContent=d[k+(k==="approved"||k==="rejected"?"_today":"")]||0);
  document.getElementById("activity").innerHTML=(d.recent_activity||[]).map(x=>`<div class="activityItem"><b>${esc(x.action)}</b> · ${esc(x.target||"")}<br><small>${new Date(x.created_at).toLocaleString()}</small></div>`).join("")||"<p class='muted'>No recent activity.</p>";}catch(e){toast(e.message);}
}
async function loadProofs(){
  try{
    const p=new URLSearchParams({search:document.getElementById("search").value,status:document.getElementById("status").value,sort:document.getElementById("sort").value});
    const d=await api("/api/admin/proofs?"+p);cache=d.proofs||[];
    document.getElementById("proofList").innerHTML=cache.map(x=>`<div class="card proof">
      <input class="check" type="checkbox" ${selected.has(x.id)?"checked":""} onchange="toggleSelect('${x.id}',this.checked)">
      <div class="meta" onclick="openProof('${x.id}')" style="cursor:pointer"><strong>${esc(x.task_name)}</strong><small>${esc(x.submission_id)} · ${esc(x.user_name||x.user_telegram_id)} · Task ${esc(x.task_id)}</small></div>
      <span class="status ${x.status}">${x.status}</span>
    </div>`).join("")||`<div class="card"><p class="muted">No proofs found.</p></div>`;
    updateBulk();
  }catch(e){toast(e.message);}
}
function toggleSelect(id,on){on?selected.add(id):selected.delete(id);updateBulk();}
function updateBulk(){document.getElementById("bulk").hidden=!selected.size;document.getElementById("selectedCount").textContent=`${selected.size} selected`;}
async function openProof(id){
  try{
    const d=await api("/api/admin/proofs/"+id),p=d.proof,u=d.user||{};
    let actions="";
    if(p.status==="pending")actions=`<div class="actions"><button onclick="approve('${p.id}')">✓ Approve</button><button class="danger" onclick="rejectUI('${p.id}')">Reject</button></div>`;
    const metadata=JSON.stringify(p.task_metadata||{},null,2);
    document.getElementById("modalContent").innerHTML=`<div class="reviewGrid">
      <div><img class="proofImage" src="${esc(p.screenshot_url)}" alt="Proof screenshot"></div>
      <div><h2>${esc(p.task_name)}</h2>
        ${line("Status",p.status)}${line("Submission ID",p.submission_id)}${line("Task ID",p.task_id)}
        ${line("User",p.user_name||"-")}${line("Username",p.username?("@"+p.username):"-")}${line("Telegram ID",p.user_telegram_id)}
        ${line("Submitted",new Date(p.submitted_at).toLocaleString())}${line("Reviewed",p.reviewed_at?new Date(p.reviewed_at).toLocaleString():"-")}
        ${line("Description",p.task_description||"-")}<div class="infoLine"><label>Task metadata</label><div class="json">${esc(metadata)}</div></div>
        ${p.reject_reason_type?line("Reject reason",`${esc(p.reject_reason_type)} — ${esc(p.reject_reason||"")}`):""}${actions}
        <button style="margin-top:12px;background:#132b20;color:#bfe8d3" onclick="openUser('${esc(p.user_telegram_id)}')">Open user profile</button>
      </div></div>`;
    document.getElementById("modal").hidden=false;
  }catch(e){toast(e.message);}
}
function line(a,b){return `<div class="infoLine"><label>${esc(a)}</label><b>${esc(b)}</b></div>`}
function closeModal(){document.getElementById("modal").hidden=true;}
async function approve(id){if(!confirm("Approve this proof?"))return;try{const d=await api("/api/admin/proofs/"+id+"/approve",{method:"POST",body:"{}"});if(d.callback_error)toast("Approved, but Base44 callback failed.");closeModal();loadProofs();loadDashboard();}catch(e){toast(e.message);}}
function rejectUI(id){
 document.getElementById("modalContent").insertAdjacentHTML("beforeend",`<div class="reasonBox"><h3>Reject proof</h3><select id="reason"><option value="">Select reason</option><option value="invalid_screenshot">Invalid screenshot</option><option value="wrong_task">Wrong task</option><option value="incomplete_proof">Incomplete proof</option><option value="unreadable_proof">Unreadable proof</option><option value="duplicate_submission">Duplicate submission</option><option value="task_requirements_not_met">Task requirements not met</option><option value="suspicious_submission">Suspicious submission</option><option value="other">Other</option></select><textarea id="reasonText" placeholder="Optional explanation"></textarea><button class="danger" onclick="reject('${id}')">Confirm rejection</button></div>`);
}
async function reject(id){const type=document.getElementById("reason").value;if(!type)return toast("Select a rejection reason.");try{const d=await api("/api/admin/proofs/"+id+"/reject",{method:"POST",body:JSON.stringify({reject_reason_type:type,reject_reason:document.getElementById("reasonText").value})});if(d.callback_error)toast("Rejected, but Base44 callback failed.");closeModal();loadProofs();loadDashboard();}catch(e){toast(e.message);}}
async function deleteSelected(){if(actor.role!=="OWNER")return toast("Owner only.");const ids=[...selected];if(!confirm(`Permanently delete ${ids.length} reviewed proof(s)?`))return;try{await api("/api/admin/proofs/reviewed/delete",{method:"POST",body:JSON.stringify({ids})});selected.clear();loadProofs();}catch(e){toast(e.message);}}
async function deleteAllReviewed(){if(actor.role!=="OWNER")return toast("Owner only.");if(!confirm("PERMANENTLY DELETE ALL APPROVED AND REJECTED PROOFS? Pending proofs will not be deleted."))return;if(!confirm("Final confirmation: this also deletes their private screenshots from Supabase Storage."))return;try{const d=await api("/api/admin/proofs/reviewed/delete",{method:"POST",body:JSON.stringify({all:true})});toast(`${d.deleted_count} reviewed proofs deleted.`);loadProofs();loadDashboard();}catch(e){toast(e.message);}}
async function openUser(id){
  closeModal();document.querySelector('[data-tab="users"]').click();document.getElementById("userId").value=id;await loadUser();
}
async function loadUser(){
  const id=document.getElementById("userId").value.trim();if(!id)return;
  try{const [u,h]=await Promise.all([api("/api/admin/users/"+encodeURIComponent(id)),api("/api/admin/users/"+encodeURIComponent(id)+"/history")]);
    document.getElementById("userView").innerHTML=`<div class="card userCard"><h2>${esc(u.main_app?.full_name||u.local?.full_name||"User")}</h2>${line("Username",u.main_app?.username||u.local?.username||"-")}${line("Telegram ID",id)}<div class="infoLine"><label>Main app profile</label><div class="json">${esc(JSON.stringify(u.main_app||{},null,2))}</div></div></div>
    <div class="card history"><h3>Task history</h3><table><thead><tr><th>Task</th><th>Status</th><th>Date</th><th>Reason</th></tr></thead><tbody>${(h.proofs||[]).map(p=>`<tr><td>${esc(p.task_name)}<br><small>${esc(p.task_id)}</small></td><td class="${p.status}">${p.status}</td><td>${new Date(p.submitted_at).toLocaleString()}</td><td>${esc(p.reject_reason||"—")}</td></tr>`).join("")}</tbody></table></div>`;
  }catch(e){toast(e.message);}
}
async function loadMods(){
 try{const d=await api("/api/admin/moderators");document.getElementById("modsList").innerHTML=`<p><b>OWNER</b> · ${esc(d.owner)}</p>`+(d.moderators||[]).map(m=>`<div class="activityItem">${m.active?"🟢":"⚪"} <b>${esc(m.full_name||"Unnamed")}</b> · ${esc(m.telegram_id)} · ${esc(m.username||"")}<div class="row"><button onclick="toggleMod('${m.telegram_id}',${!m.active})">${m.active?"Disable":"Enable"}</button><button class="danger" onclick="removeMod('${m.telegram_id}')">Remove</button></div></div>`).join("")||"<p>No moderators.</p>";}catch(e){toast(e.message);}
}
async function addMod(){try{await api("/api/admin/moderators",{method:"POST",body:JSON.stringify({telegram_id:document.getElementById("modId").value,full_name:document.getElementById("modName").value,username:document.getElementById("modUsername").value})});document.getElementById("modId").value="";loadMods();}catch(e){toast(e.message);}}
async function toggleMod(id,active){try{await api("/api/admin/moderators/"+id,{method:"PATCH",body:JSON.stringify({active})});loadMods();}catch(e){toast(e.message);}}
async function removeMod(id){if(!confirm("Remove this moderator?"))return;try{await api("/api/admin/moderators/"+id,{method:"DELETE"});loadMods();}catch(e){toast(e.message);}}
function toast(s){alert(s)}
initTabs();
if(tg){tg.ready(); if(tg.initData)login();}
