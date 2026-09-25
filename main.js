const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const $ = id => document.getElementById(id);
const initData = () => tg?.initData || "";
const jsonHeaders = () => ({ "Content-Type":"application/json", "X-Telegram-Init-Data":initData() });

function esc(v){return String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function toast(message){const el=$("toast");el.textContent=message;el.style.display="block";clearTimeout(window.__toast);window.__toast=setTimeout(()=>el.style.display="none",2800)}
async function api(url, options={}){
  const res=await fetch(url,{...options,headers:{...jsonHeaders(),...(options.headers||{})}});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
async function checkServer(){
  try{
    const h=await fetch("/health").then(r=>r.json());
    $("connection").textContent=h.ok?"Online":"Offline";
    $("connection").className="pill";
  }catch{
    $("connection").textContent="Server error";
  }
}
function showPublic(){
  $("loading").classList.add("hidden");
  $("publicHome").classList.remove("hidden");
}
function renderProfile(me){
  $("profile").innerHTML=`<div class="row"><div><b>${esc(me.user.first_name||"HillsByte user")}</b><div class="muted small">Telegram ID: ${esc(me.user.telegram_id)}</div></div><div><b>$${Number(me.user.balance||0).toFixed(2)}</b><div class="muted small">Balance</div></div><div><b>${esc(me.role)}</b><div class="muted small">Role</div></div></div>`;
}
async function loadTasks(){
  const {tasks}=await api("/api/tasks");
  const box=$("tasks");
  if(!tasks?.length){box.innerHTML='<div class="card"><b>No active tasks.</b><p class="muted">An administrator can create tasks from the Admin Panel.</p></div>';return}
  box.innerHTML=tasks.map(t=>`<article class="card task">
    <h3>${esc(t.title)}</h3><p>${esc(t.description)}</p>
    <p><b>Reward: $${Number(t.reward).toFixed(2)}</b></p>
    <form data-task="${t.id}" class="proofForm">
      <input type="file" name="proofs" accept="image/*" multiple required>
      <textarea name="note" placeholder="Optional note"></textarea>
      <button>Submit Proof</button>
    </form>
  </article>`).join("");
  document.querySelectorAll(".proofForm").forEach(form=>form.addEventListener("submit",submitProof));
}
async function submitProof(e){
  e.preventDefault();
  const fd=new FormData(e.currentTarget);fd.append("task_id",e.currentTarget.dataset.task);
  try{
    const r=await fetch("/api/submissions",{method:"POST",headers:{"X-Telegram-Init-Data":initData()},body:fd});
    const j=await r.json();if(!r.ok)throw new Error(j.error||"Submission failed");
    toast("Proof submitted for review.");e.currentTarget.reset();await loadMine();
  }catch(err){toast(err.message)}
}
async function loadMine(){
  const {submissions}=await api("/api/submissions/mine");
  $("mine").innerHTML=submissions?.length?submissions.map(s=>`<div class="card"><b>${esc(s.tasks?.title||"Task")}</b><div class="muted small">Status: ${esc(s.status)} · Reward: $${Number(s.reward||0).toFixed(2)}</div>${s.rejection_reason?`<p class="error">${esc(s.rejection_reason)}</p>`:""}</div>`).join(""):'<div class="card"><p class="muted">No submissions yet.</p></div>';
}
async function loadQueue(){
  const {submissions}=await api("/api/reviewer/queue");
  $("queue").innerHTML=submissions?.length?submissions.map(s=>`<div class="card">
    <h3>${esc(s.tasks?.title||"Task")}</h3><div class="muted small">User: @${esc(s.users?.username||"unknown")} · Reward: $${Number(s.tasks?.reward||0).toFixed(2)}</div>
    ${(s.proof_urls||[]).map(u=>`<img class="proof" src="${esc(u)}" alt="Submitted proof">`).join("")}
    ${s.note?`<p>${esc(s.note)}</p>`:""}
    <div class="row"><button data-approve="${s.id}">Approve</button><button class="danger" data-reject="${s.id}">Reject</button></div>
  </div>`).join(""):'<div class="card"><p class="muted">No pending submissions.</p></div>';
  document.querySelectorAll("[data-approve]").forEach(b=>b.onclick=async()=>{try{await api(`/api/reviewer/${b.dataset.approve}/approve`,{method:"POST"});toast("Approved.");loadQueue()}catch(e){toast(e.message)}});
  document.querySelectorAll("[data-reject]").forEach(b=>b.onclick=async()=>{const reason=prompt("Reason for rejection?")||"Proof did not meet the task requirements.";try{await api(`/api/reviewer/${b.dataset.reject}/reject`,{method:"POST",body:JSON.stringify({reason})});toast("Rejected.");loadQueue()}catch(e){toast(e.message)}});
}
async function loadAdmin(){
  const {tasks}=await api("/api/tasks");
  $("adminTasks").innerHTML=tasks.map(t=>`<div class="card"><b>${esc(t.title)}</b><div class="muted">$${Number(t.reward).toFixed(2)} · ${t.active?"Active":"Inactive"}</div><div class="row"><button data-post="${t.id}">Post to Channel</button><button class="danger" data-delete="${t.id}">Delete</button></div></div>`).join("");
  document.querySelectorAll("[data-post]").forEach(b=>b.onclick=async()=>{try{await api(`/api/admin/tasks/${b.dataset.post}/post`,{method:"POST"});toast("Posted to channel.")}catch(e){toast(e.message)}});
  document.querySelectorAll("[data-delete]").forEach(b=>b.onclick=async()=>{if(!confirm("Delete this task?"))return;try{await api(`/api/admin/tasks/${b.dataset.delete}`,{method:"DELETE"});toast("Deleted.");loadAdmin()}catch(e){toast(e.message)}});
  const {roles}=await api("/api/admin/roles");
  $("roles").innerHTML=roles?.length?roles.map(r=>`<div class="card"><b>${esc(r.role)}</b><div class="muted">${esc(r.telegram_id)}</div><button class="danger" data-role-delete="${r.telegram_id}">Remove</button></div>`).join(""):'<div class="card"><p class="muted">No database-assigned roles.</p></div>';
  document.querySelectorAll("[data-role-delete]").forEach(b=>b.onclick=async()=>{try{await api(`/api/admin/roles/${b.dataset.roleDelete}`,{method:"DELETE"});toast("Role removed.");loadAdmin()}catch(e){toast(e.message)}});
}
$("refreshTasks").onclick=()=>loadTasks().catch(e=>toast(e.message));
$("refreshMine").onclick=()=>loadMine().catch(e=>toast(e.message));
$("refreshQueue").onclick=()=>loadQueue().catch(e=>toast(e.message));
$("refreshAdmin").onclick=()=>loadAdmin().catch(e=>toast(e.message));
$("taskForm").onsubmit=async e=>{
  e.preventDefault();
  try{
    await api("/api/admin/tasks",{method:"POST",body:JSON.stringify({title:$("taskTitle").value.trim(),description:$("taskDescription").value.trim(),reward:Number($("taskReward").value)})});
    e.currentTarget.reset();$("taskReward").value="0.70";toast("Task created.");loadAdmin();loadTasks();
  }catch(err){toast(err.message)}
};
$("roleForm").onsubmit=async e=>{
  e.preventDefault();
  try{await api("/api/admin/roles",{method:"POST",body:JSON.stringify({telegram_id:Number($("roleTelegramId").value),role:$("roleName").value})});e.currentTarget.reset();toast("Role saved.");loadAdmin()}catch(err){toast(err.message)}
};

async function boot(){
  await checkServer();
  if(!initData()){showPublic();return}
  try{
    const me=await api("/api/me");
    $("loading").classList.add("hidden");
    $("userPanel").classList.remove("hidden");
    renderProfile(me);
    await Promise.all([loadTasks(),loadMine()]);
    if(me.role==="admin"||me.role==="reviewer"){ $("reviewPanel").classList.remove("hidden");await loadQueue(); }
    if(me.role==="admin"){ $("adminPanel").classList.remove("hidden");await loadAdmin(); }
  }catch(e){
    $("loading").classList.remove("hidden");
    $("loading").innerHTML=`<h2>Unable to open Proof Center</h2><p class="error">${esc(e.message)}</p><p class="muted">Open this page from the HillsByte Telegram bot so Telegram can provide signed Mini App data.</p>`;
  }
}
boot();
