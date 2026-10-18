(() => {
'use strict';

const cfg = window.PRICELOG_CONFIG || {};
const $ = id => document.getElementById(id);
const ACTIVE_SCOPE_KEY = 'pricelog_cloud_scope_v1';
const MIGRATION_KEY_PREFIX = 'pricelog_cloud_migrated_v1_';
let client = null;
let currentUser = null;
let groups = [];
let activeScope = localStorage.getItem(ACTIVE_SCOPE_KEY) || 'personal';
let currentDocumentId = null;
let uploadTimer = null;
let suppressUpload = false;

function setMessage(text='') { const el=$('accountMessage'); if(el) el.textContent=text; }
function safeName(user) { return user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || 'Googleアカウント'; }
function avatarUrl(user) { return user?.user_metadata?.avatar_url || user?.user_metadata?.picture || ''; }
function setAvatar(img, url, fallback='') {
  if (!img) return;
  if (url) { img.src=url; img.classList.remove('hidden'); img.alt=fallback || 'アカウント'; }
  else { img.removeAttribute('src'); img.classList.add('hidden'); }
}

function showAccountDialog() { $('accountDialog')?.showModal(); }
function closeAccountDialog() { $('accountDialog')?.close(); }

function renderAccount() {
  const signedOut=$('accountSignedOut'), signedIn=$('accountSignedIn');
  const topAvatar=$('accountAvatar'), fallback=$('accountFallback');
  if (!currentUser) {
    signedOut?.classList.remove('hidden'); signedIn?.classList.add('hidden');
    topAvatar?.classList.add('hidden'); fallback?.classList.remove('hidden');
    return;
  }
  signedOut?.classList.add('hidden'); signedIn?.classList.remove('hidden');
  const name=safeName(currentUser), email=currentUser.email || '';
  $('accountDisplayName').textContent=name; $('accountEmail').textContent=email;
  const avatar=avatarUrl(currentUser);
  setAvatar(topAvatar,avatar,name); fallback?.classList.toggle('hidden',!!avatar);
  setAvatar($('accountDialogAvatar'),avatar,name);
  if (!avatar && $('accountDialogAvatar')) { $('accountDialogAvatar').src='./icon-192-v058.png'; $('accountDialogAvatar').classList.remove('hidden'); }
  renderGroups();
}

function renderGroups() {
  $('btnUsePersonalData')?.classList.toggle('active',activeScope==='personal');
  const host=$('accountGroups'); if(!host) return; host.innerHTML='';
  groups.forEach(group=>{
    const row=document.createElement('div'); row.className='account-group-row';
    const info=document.createElement('div'); info.innerHTML=`<div class="account-group-name"></div><div class="account-group-code"></div>`;
    info.querySelector('.account-group-name').textContent=group.name || '共有';
    info.querySelector('.account-group-code').textContent=`招待コード ${group.invite_code}`;
    const use=document.createElement('button'); use.type='button'; use.className='ghost mini account-scope-btn'; use.textContent=activeScope===`group:${group.id}`?'使用中':'使う';
    if(activeScope===`group:${group.id}`) use.classList.add('active');
    use.addEventListener('click',()=>activateGroup(group));
    const leave=document.createElement('button'); leave.type='button'; leave.className='ghost mini'; leave.textContent=group.owner_id===currentUser?.id?'削除':'退出';
    leave.addEventListener('click',()=>leaveGroup(group));
    row.append(info,use,leave); host.appendChild(row);
  });
}

async function loadGroups() {
  if (!client || !currentUser) { groups=[]; renderGroups(); return; }
  const {data,error}=await client.from('pricelog_share_groups').select('id,name,invite_code,owner_id,created_at').order('created_at',{ascending:true});
  if(error) throw error; groups=data || [];
  if(activeScope.startsWith('group:')) {
    const id=activeScope.slice(6); if(!groups.some(g=>g.id===id)) activeScope='personal';
  }
  localStorage.setItem(ACTIVE_SCOPE_KEY,activeScope); renderGroups();
}

function scopeFilter() {
  if(activeScope.startsWith('group:')) return {scope_type:'group',group_id:activeScope.slice(6)};
  return {scope_type:'personal',owner_id:currentUser?.id || ''};
}

async function fetchDocument() {
  if(!client || !currentUser) return null;
  let query=client.from('pricelog_documents').select('id,data,updated_at,owner_id,group_id').limit(1);
  const scope=scopeFilter();
  query = scope.scope_type==='group' ? query.eq('scope_type','group').eq('group_id',scope.group_id) : query.eq('scope_type','personal').eq('owner_id',scope.owner_id);
  const {data,error}=await query.maybeSingle(); if(error) throw error; return data || null;
}

async function writeDocument(products) {
  if(!client || !currentUser) return;
  const now=new Date().toISOString();
  if(currentDocumentId){
    const {error}=await client.from('pricelog_documents').update({data:{products},updated_at:now,updated_by:currentUser.id}).eq('id',currentDocumentId);
    if(error) throw error; return;
  }
  const scope=scopeFilter();
  const payload={scope_type:scope.scope_type,owner_id:scope.scope_type==='personal'?currentUser.id:null,group_id:scope.scope_type==='group'?scope.group_id:null,data:{products},updated_at:now,updated_by:currentUser.id};
  const {data,error}=await client.from('pricelog_documents').insert(payload).select('id').single(); if(error) throw error; currentDocumentId=data.id;
}

function localProducts() { return window.PriceLogApp?.getProducts?.() || []; }
function replaceLocal(products) {
  suppressUpload=true;
  try { window.PriceLogApp?.replaceProducts?.(products,{persist:true}); }
  finally { setTimeout(()=>{suppressUpload=false;},0); }
}
function mergeProducts(base,incoming) { return window.PriceLogApp?.mergeProducts?.(base,incoming) || incoming || base || []; }

async function loadScope({mergeLocal=false,firstLogin=false}={}) {
  if(!currentUser) return;
  const doc=await fetchDocument(); currentDocumentId=doc?.id || null;
  const cloudProducts=Array.isArray(doc?.data?.products)?doc.data.products:[];
  const local=localProducts();
  const migrationKey=MIGRATION_KEY_PREFIX+currentUser.id;
  const shouldMerge = mergeLocal || (firstLogin && local.length && localStorage.getItem(migrationKey)!=='1');
  if(!doc){
    await writeDocument(local);
    localStorage.setItem(migrationKey,'1');
    return;
  }
  if(shouldMerge){
    const merged=mergeProducts(cloudProducts,local);
    replaceLocal(merged); await writeDocument(merged); localStorage.setItem(migrationKey,'1');
  } else {
    replaceLocal(cloudProducts);
  }
}

function queueUpload() {
  if(suppressUpload || !currentUser || !client) return;
  clearTimeout(uploadTimer); uploadTimer=setTimeout(async()=>{ try{await writeDocument(localProducts());}catch(error){console.error(error);} },700);
}

async function applySession(session) {
  currentUser=session?.user || null; currentDocumentId=null; setMessage(''); renderAccount();
  if(!currentUser) return;
  try { await loadGroups(); await loadScope({firstLogin:true}); renderAccount(); }
  catch(error){ console.error(error); setMessage('データを読み込めませんでした。設定を確認してください。'); }
}

async function loginGoogle() {
  if(!client) return setMessage('Googleログインの準備ができていません。');
  const redirectTo=`${location.origin}${location.pathname}`;
  const {error}=await client.auth.signInWithOAuth({provider:'custom:pricelog-google',options:{redirectTo}}); if(error) setMessage(error.message || 'Googleログインを開始できませんでした。');
}

async function createGroup() {
  const name=$('newGroupName')?.value.trim(); if(!name) return setMessage('共有名を入力してください。');
  const {data,error}=await client.rpc('pricelog_create_group',{p_name:name}); if(error) return setMessage('共有を作成できませんでした。');
  $('newGroupName').value=''; await loadGroups(); setMessage('共有を作成しました。');
}
async function joinGroup() {
  const code=$('joinInviteCode')?.value.trim(); if(!code) return setMessage('招待コードを入力してください。');
  const {error}=await client.rpc('pricelog_join_group',{p_code:code}); if(error) return setMessage('招待コードを確認してください。');
  $('joinInviteCode').value=''; await loadGroups(); setMessage('共有に参加しました。');
}
async function leaveGroup(group) {
  const word=group.owner_id===currentUser?.id?'削除':'退出';
  if(!confirm(`「${group.name}」を${word}しますか？`)) return;
  const {error}=await client.rpc('pricelog_leave_group',{p_group_id:group.id}); if(error) return setMessage(`${word}できませんでした。`);
  if(activeScope===`group:${group.id}`){activeScope='personal';localStorage.setItem(ACTIVE_SCOPE_KEY,activeScope);currentDocumentId=null;await loadScope();}
  await loadGroups();
}
async function activateGroup(group) {
  if(activeScope===`group:${group.id}`) return;
  const merge=confirm(`「${group.name}」を使います。\n\n現在この端末に表示しているPriceLogのデータも共有データへ追加して結合しますか？\n\nOK：結合する\nキャンセル：共有データだけを表示する`);
  activeScope=`group:${group.id}`; localStorage.setItem(ACTIVE_SCOPE_KEY,activeScope); currentDocumentId=null;
  try{ await loadScope({mergeLocal:merge}); await loadGroups(); renderAccount(); }
  catch(error){console.error(error);setMessage('共有データを開けませんでした。');}
}
async function activatePersonal() {
  if(activeScope==='personal') return;
  activeScope='personal'; localStorage.setItem(ACTIVE_SCOPE_KEY,activeScope); currentDocumentId=null;
  try{await loadScope();await loadGroups();renderAccount();}catch(error){console.error(error);setMessage('自分のデータを開けませんでした。');}
}

async function initClient() {
  try {
    const mod=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    if(!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) return;
    client=mod.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_KEY);
    const {data:{session}}=await client.auth.getSession(); await applySession(session);
    client.auth.onAuthStateChange((_event,session)=>applySession(session));
  } catch(error) { console.warn('PriceLog account features unavailable',error); }
}

$('btnAccount')?.addEventListener('click',showAccountDialog);
$('btnCloseAccount')?.addEventListener('click',closeAccountDialog);
$('btnGoogleLogin')?.addEventListener('click',loginGoogle);
$('btnCreateGroup')?.addEventListener('click',createGroup);
$('btnJoinGroup')?.addEventListener('click',joinGroup);
$('btnUsePersonalData')?.addEventListener('click',activatePersonal);
$('btnLogout')?.addEventListener('click',async()=>{if(client)await client.auth.signOut();activeScope='personal';localStorage.setItem(ACTIVE_SCOPE_KEY,activeScope);currentDocumentId=null;});
window.addEventListener('pricelog:data-changed',queueUpload);
renderAccount();
initClient();
})();
