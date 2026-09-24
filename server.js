import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const app = express();
const port = Number(process.env.PORT || 10000);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const bucket = process.env.SUPABASE_BUCKET || 'proofs';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 6 } });
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const ids = name => new Set((process.env[name] || '').split(',').map(x => x.trim()).filter(Boolean));
const envAdmins = ids('ADMIN_TELEGRAM_IDS');
const envReviewers = ids('REVIEWER_TELEGRAM_IDS');
const envModerators = ids('MODERATOR_TELEGRAM_IDS');

function initData(req) { return req.headers['x-telegram-init-data'] || ''; }
function verifyTelegramInitData(raw) {
  if (!raw || !process.env.BOT_TOKEN) return null;
  try {
    const p = new URLSearchParams(raw);
    const hash = p.get('hash'); if (!hash) return null;
    const dataCheck = [...p.entries()].filter(([k]) => k !== 'hash').sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
    const authDate = Number(p.get('auth_date') || 0);
    if (!authDate || Date.now()/1000 - authDate > 86400) return null;
    return JSON.parse(p.get('user') || '{}');
  } catch { return null; }
}

async function roleOf(tid) {
  const s = String(tid);
  if (envAdmins.has(s)) return 'admin';
  if (envReviewers.has(s)) return 'reviewer';
  if (envModerators.has(s)) return 'moderator';
  const { data } = await supabase.from('roles').select('role').eq('telegram_id', tid).maybeSingle();
  return data?.role || 'user';
}
async function requireUser(req,res,next) {
  const u = verifyTelegramInitData(initData(req));
  if (!u?.id) return res.status(401).json({error:'Valid Telegram Mini App authentication is required'});
  req.tgUser = u;
  next();
}
async function requireRole(roles) {
  return async (req,res,next) => {
    const u = verifyTelegramInitData(initData(req));
    if (!u?.id) return res.status(401).json({error:'Valid Telegram Mini App authentication is required'});
    const role = await roleOf(u.id);
    if (!roles.includes(role)) return res.status(403).json({error:'Not authorized'});
    req.tgUser = u; req.role = role; next();
  };
}

async function upsertUser(tg) {
  const { data, error } = await supabase.from('users').upsert({telegram_id:tg.id, username:tg.username || null, first_name:tg.first_name || null},{onConflict:'telegram_id'}).select().single();
  if (error) throw error; return data;
}
async function telegram(method, body) {
  if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN is not configured');
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
  const j = await r.json(); if (!j.ok) throw new Error(j.description || 'Telegram API error'); return j.result;
}
async function postTask(task) {
  const text = `🚀 *HillsByte Task*\n\n*${task.title}*\n\n${task.description}\n\n💰 Reward: $${Number(task.reward).toFixed(2)}\n\nSubmit your proof in the HillsByte Proof Mini App.`;
  return telegram('sendMessage',{chat_id:process.env.CHANNEL_ID,text,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'📤 Submit Proof',web_app:{url:process.env.PUBLIC_APP_URL}}]]}});
}
function signature(body) { return crypto.createHmac('sha256', process.env.BASE44_WEBHOOK_SECRET || '').update(body).digest('hex'); }
async function emitEvent(type, submission, task, user, extra={}) {
  const payload = {event:type,timestamp:new Date().toISOString(),event_id:`${type}:${submission.id}`,submission_id:submission.id,task_id:task.id,telegram_id:user.telegram_id,reward:Number(task.reward),credited:Number(extra.credited || 0),status:extra.status || type.replace('task_',''),...extra};
  const eventKey = `${type}:${submission.id}`;
  const { data: existing } = await supabase.from('webhook_events').select('id,delivered').eq('event_key',eventKey).maybeSingle();
  if (existing?.delivered) return payload;
  await supabase.from('webhook_events').upsert({event_key:eventKey,event_type:type,submission_id:submission.id,payload},{onConflict:'event_key'});
  const url = process.env.BASE44_WEBHOOK_URL;
  if (!url) return payload;
  const raw = JSON.stringify(payload);
  try {
    const r = await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-hillsbyte-signature':signature(raw)},body:raw});
    const ok = r.ok;
    await supabase.from('webhook_events').update({delivered:ok}).eq('event_key',eventKey);
  } catch (e) { console.error('Base44 webhook:',e.message); }
  return payload;
}

app.get('/api/health',(req,res)=>res.json({ok:true,service:'hillsbyte-proof-bot'}));
app.get('/api/tasks',async(req,res)=>{const {data,error}=await supabase.from('tasks').select('*').eq('active',true).order('id',{ascending:false}); if(error)return res.status(500).json({error:error.message}); res.json({tasks:data});});
app.get('/api/me',requireUser,async(req,res)=>{try{const user=await upsertUser(req.tgUser); const role=await roleOf(req.tgUser.id); res.json({user,role});}catch(e){res.status(500).json({error:e.message});}});

app.post('/api/submissions',requireUser,upload.array('proofs',6),async(req,res)=>{
  try {
    const taskId=Number(req.body.task_id); const {data:task,error:te}=await supabase.from('tasks').select('*').eq('id',taskId).eq('active',true).single(); if(te) throw te;
    const user=await upsertUser(req.tgUser); const files=req.files || []; if(!files.length) return res.status(400).json({error:'Upload at least one proof image'});
    const urls=[];
    for (const file of files) { const path=`${user.telegram_id}/${Date.now()}-${crypto.randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`; const {error}=await supabase.storage.from(bucket).upload(path,file.buffer,{contentType:file.mimetype,upsert:false}); if(error) throw error; const {data}=supabase.storage.from(bucket).getPublicUrl(path); urls.push(data.publicUrl); }
    const row={task_id:task.id,user_id:user.id,proof_urls:urls,note:req.body.note || null,status:'pending',reward:Number(task.reward),credited:0};
    const {data:submission,error}=await supabase.from('submissions').insert(row).select().single(); if(error) throw error;
    await emitEvent('task_submitted',submission,task,user,{status:'pending'});
    res.json({ok:true,submission});
  } catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/submissions/mine',requireUser,async(req,res)=>{try{const user=await upsertUser(req.tgUser); const {data,error}=await supabase.from('submissions').select('*,tasks(title)').eq('user_id',user.id).order('id',{ascending:false}); if(error)throw error;res.json({submissions:data});}catch(e){res.status(400).json({error:e.message});}});

app.get('/api/reviewer/queue',await requireRole(['admin','reviewer']),async(req,res)=>{const {data,error}=await supabase.from('submissions').select('*,tasks(title,reward),users(telegram_id,username,first_name)').eq('status','pending').order('id',{ascending:false});if(error)return res.status(400).json({error:error.message});res.json({submissions:data});});
app.post('/api/reviewer/:id/approve',await requireRole(['admin','reviewer']),async(req,res)=>{try{const id=Number(req.params.id);const {data:s,error:se}=await supabase.from('submissions').select('*,tasks(*),users(*)').eq('id',id).single();if(se)throw se;if(s.status!=='pending')return res.status(409).json({error:'Submission already reviewed'});const reward=Number(s.tasks.reward);if(!Number.isFinite(reward)||reward<0)return res.status(400).json({error:'Task has an invalid reward'});const {data:updated,error:xe}=await supabase.from('submissions').update({status:'approved',credited:reward,reviewed_by:req.tgUser.id,reviewed_at:new Date().toISOString()}).eq('id',id).eq('status','pending').select().single();if(xe)throw xe;if(!updated)return res.status(409).json({error:'Submission was already reviewed'});const payload=await emitEvent('task_approved',updated,s.tasks,s.users,{credited:reward,credit_amount:reward,status:'approved'});res.json({ok:true,submission:updated,base44_event:payload,credit_amount:reward});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/reviewer/:id/reject',await requireRole(['admin','reviewer']),async(req,res)=>{try{const id=Number(req.params.id);const {data:s,error:se}=await supabase.from('submissions').select('*,tasks(*),users(*)').eq('id',id).single();if(se)throw se;if(s.status!=='pending')return res.status(409).json({error:'Submission already reviewed'});const reason=req.body.reason || 'Proof did not meet the task requirements.';const {data:updated,error:xe}=await supabase.from('submissions').update({status:'rejected',rejection_reason:reason,reviewed_by:req.tgUser.id,reviewed_at:new Date().toISOString()}).eq('id',id).eq('status','pending').select().single();if(xe)throw xe;await emitEvent('task_rejected',updated,s.tasks,s.users,{credited:0,status:'rejected',reason});res.json({ok:true,submission:updated});}catch(e){res.status(400).json({error:e.message});}});

app.post('/api/admin/tasks',await requireRole(['admin']),async(req,res)=>{try{const {title,description,reward,active=true}=req.body;if(!title||!description)return res.status(400).json({error:'Title and description are required'});const amount=Number(reward);if(!Number.isFinite(amount)||amount<0)return res.status(400).json({error:'A valid task reward is required'});const {data,error}=await supabase.from('tasks').insert({title,description,reward:amount,active}).select().single();if(error)throw error;res.json({task:data});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/admin/tasks/:id/post',await requireRole(['admin','moderator']),async(req,res)=>{try{const {data:task,error}=await supabase.from('tasks').select('*').eq('id',Number(req.params.id)).single();if(error)throw error;const msg=await postTask(task);await supabase.from('tasks').update({posted_message_id:msg.message_id}).eq('id',task.id);res.json({ok:true,message_id:msg.message_id});}catch(e){res.status(400).json({error:e.message});}});
app.patch('/api/admin/tasks/:id',await requireRole(['admin']),async(req,res)=>{const allowed={};for(const k of ['title','description','active'])if(req.body[k]!==undefined)allowed[k]=req.body[k];if(req.body.reward!==undefined)allowed.reward=Number(req.body.reward);const {data,error}=await supabase.from('tasks').update(allowed).eq('id',Number(req.params.id)).select().single();if(error)return res.status(400).json({error:error.message});res.json({task:data});});
app.delete('/api/admin/tasks/:id',await requireRole(['admin']),async(req,res)=>{const {error}=await supabase.from('tasks').delete().eq('id',Number(req.params.id));if(error)return res.status(400).json({error:error.message});res.json({ok:true});});
app.get('/api/admin/roles',await requireRole(['admin']),async(req,res)=>{const {data,error}=await supabase.from('roles').select('*').order('created_at',{ascending:false});if(error)return res.status(400).json({error:error.message});res.json({roles:data});});
app.post('/api/admin/roles',await requireRole(['admin']),async(req,res)=>{const role=req.body.role;const telegram_id=Number(req.body.telegram_id);if(!['reviewer','moderator','admin'].includes(role)||!telegram_id)return res.status(400).json({error:'Valid telegram_id and role required'});const {data,error}=await supabase.from('roles').upsert({telegram_id,role}).select().single();if(error)return res.status(400).json({error:error.message});res.json({role:data});});
app.delete('/api/admin/roles/:telegram_id',await requireRole(['admin']),async(req,res)=>{const {error}=await supabase.from('roles').delete().eq('telegram_id',Number(req.params.telegram_id));if(error)return res.status(400).json({error:error.message});res.json({ok:true});});

app.post('/telegram/webhook',async(req,res)=>{try{const m=req.body?.message;if(!m?.from?.id)return res.sendStatus(200);const tid=m.from.id;const role=await roleOf(tid);const text=m.text||'';if(text.startsWith('/start'))await telegram('sendMessage',{chat_id:tid,text:'Welcome to HillsByte Proof Bot. Open the mini app to complete tasks and submit proof.',reply_markup:{inline_keyboard:[[{text:'🚀 Open Proof App',web_app:{url:process.env.PUBLIC_APP_URL}}]]}});else if(text.startsWith('/review')&&['admin','reviewer'].includes(role))await telegram('sendMessage',{chat_id:tid,text:'Reviewer access is available in the Proof Mini App.',reply_markup:{inline_keyboard:[[{text:'🧾 Open Review Center',web_app:{url:`${process.env.PUBLIC_APP_URL}?review=1`}}]]}});else if(text.startsWith('/admin')&&role==='admin')await telegram('sendMessage',{chat_id:tid,text:'Admin access is available in the Proof Mini App.',reply_markup:{inline_keyboard:[[{text:'⚙️ Open Admin',web_app:{url:`${process.env.PUBLIC_APP_URL}?admin=1`}}]]}});res.sendStatus(200);}catch(e){console.error(e);res.sendStatus(200);}});

app.use(express.static('public'));
app.use((req,res,next)=>{if(req.path.startsWith('/api/')||req.path==='/telegram/webhook')return next();res.sendFile(process.cwd()+'/public/index.html');});

app.listen(port,async()=>{console.log(`HillsByte Proof Bot listening on ${port}`);if(process.env.BOT_TOKEN){try{await telegram('setWebhook',{url:`${process.env.PUBLIC_APP_URL}/telegram/webhook`});console.log('Telegram webhook configured');}catch(e){console.error('Webhook setup:',e.message);}}});
