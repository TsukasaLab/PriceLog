(() => {
'use strict';

const cfg = window.PRICELOG_CONFIG || {};
const $ = id => document.getElementById(id);
const ACTIVE_SCOPE_KEY = 'pricelog_cloud_scope_v1';
const MIGRATION_KEY_PREFIX = 'pricelog_cloud_migrated_v2_';
const POLL_INTERVAL_MS = 10000;
let client = null;
let currentUser = null;
let loadedUserId = null;
let groups = [];
let activeScope = localStorage.getItem(ACTIVE_SCOPE_KEY) || 'personal';
let currentDocumentId = null;
let uploadTimer = null;
let suppressUpload = false;
let realtimeChannel = null;
let pollTimer = null;
let lastCloudUpdatedAt = '';
let pendingRemoteDocument = null;
let pendingApplyTimer = null;
let migrationResolver = null;

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
  let query=client.from('pricelog_documents').select('id,data,updated_at,updated_by,owner_id,group_id,scope_type').limit(1);
  const scope=scopeFilter();
  query = scope.scope_type==='group' ? query.eq('scope_type','group').eq('group_id',scope.group_id) : query.eq('scope_type','personal').eq('owner_id',scope.owner_id);
  const {data,error}=await query.maybeSingle(); if(error) throw error; return data || null;
}

async function writeDocument(products) {
  if(!client || !currentUser) return;
  const now=new Date().toISOString();
  if(currentDocumentId){
    const {data,error}=await client.from('pricelog_documents').update({data:{products},updated_at:now,updated_by:currentUser.id}).eq('id',currentDocumentId).select('id,updated_at').single();
    if(error) throw error;
    lastCloudUpdatedAt=data?.updated_at || now;
    return;
  }
  const scope=scopeFilter();
  const payload={scope_type:scope.scope_type,owner_id:scope.scope_type==='personal'?currentUser.id:null,group_id:scope.scope_type==='group'?scope.group_id:null,data:{products},updated_at:now,updated_by:currentUser.id};
  const {data,error}=await client.from('pricelog_documents').insert(payload).select('id,updated_at').single(); if(error) throw error;
  currentDocumentId=data.id;
  lastCloudUpdatedAt=data?.updated_at || now;
}

function localProducts() { return window.PriceLogApp?.getProducts?.() || []; }
function replaceLocal(products) {
  suppressUpload=true;
  try { window.PriceLogApp?.replaceProducts?.(products,{persist:true}); }
  finally { setTimeout(()=>{suppressUpload=false;},0); }
}
function mergeProducts(base,incoming) { return window.PriceLogApp?.mergeProducts?.(base,incoming) || incoming || base || []; }
function hasActiveEdits() { return Boolean(window.PriceLogApp?.hasActiveEdits?.()); }

function setSyncBanner(text='') {
  const banner=$('cloudSyncBanner');
  if(!banner) return;
  if(!text){banner.textContent='';banner.classList.add('hidden');return;}
  banner.textContent=text;
  banner.classList.remove('hidden');
}

function isNewerTimestamp(a,b){
  const ta=Date.parse(a||'')||0, tb=Date.parse(b||'')||0;
  return ta>tb;
}

function sameProducts(a,b){
  try{return JSON.stringify(a||[])===JSON.stringify(b||[]);}catch{return false;}
}

async function applyPendingRemoteWhenSafe(){
  clearTimeout(pendingApplyTimer);
  if(!pendingRemoteDocument) return;
  if(hasActiveEdits()){
    pendingApplyTimer=setTimeout(applyPendingRemoteWhenSafe,500);
    return;
  }
  const doc=pendingRemoteDocument;
  pendingRemoteDocument=null;
  setSyncBanner('');
  const remoteProducts=Array.isArray(doc?.data?.products)?doc.data.products:[];
  const local=localProducts();
  const merged=mergeProducts(remoteProducts,local);
  currentDocumentId=doc?.id || currentDocumentId;
  lastCloudUpdatedAt=doc?.updated_at || lastCloudUpdatedAt;
  replaceLocal(merged);
  if(!sameProducts(merged,remoteProducts)){
    try{await writeDocument(merged);}catch(error){console.error('PriceLog merged sync write failed',error);}
  }
}

function handleRemoteDocument(doc){
  if(!doc || !currentUser) return;
  const scope=scopeFilter();
  if(scope.scope_type==='group' && doc.group_id!==scope.group_id) return;
  if(scope.scope_type==='personal' && doc.owner_id!==scope.owner_id) return;
  if(lastCloudUpdatedAt && !isNewerTimestamp(doc.updated_at,lastCloudUpdatedAt)) return;
  currentDocumentId=doc.id || currentDocumentId;
  if(hasActiveEdits()){
    if(!pendingRemoteDocument || isNewerTimestamp(doc.updated_at,pendingRemoteDocument.updated_at)) pendingRemoteDocument=doc;
    setSyncBanner('共有データが更新されました。編集中の内容を保存またはキャンセルすると自動で反映します。');
    applyPendingRemoteWhenSafe();
    return;
  }
  const remoteProducts=Array.isArray(doc?.data?.products)?doc.data.products:[];
  lastCloudUpdatedAt=doc.updated_at || lastCloudUpdatedAt;
  replaceLocal(remoteProducts);
}

function stopScopeSync(){
  clearTimeout(pendingApplyTimer); pendingApplyTimer=null; pendingRemoteDocument=null; setSyncBanner('');
  if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
  if(realtimeChannel && client){try{client.removeChannel(realtimeChannel);}catch{} realtimeChannel=null;}
}

function startScopeSync(){
  stopScopeSync();
  if(!client || !currentUser) return;
  const scope=scopeFilter();
  const filter=scope.scope_type==='group' ? `group_id=eq.${scope.group_id}` : `owner_id=eq.${scope.owner_id}`;
  try{
    realtimeChannel=client.channel(`pricelog-${scope.scope_type}-${scope.group_id||scope.owner_id}-${Date.now()}`)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'pricelog_documents',filter},payload=>handleRemoteDocument(payload.new))
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'pricelog_documents',filter},payload=>handleRemoteDocument(payload.new))
      .subscribe();
  }catch(error){console.warn('PriceLog realtime unavailable',error);}
  pollTimer=setInterval(async()=>{
    if(hasActiveEdits()) return;
    try{
      const doc=await fetchDocument();
      if(doc && (!lastCloudUpdatedAt || isNewerTimestamp(doc.updated_at,lastCloudUpdatedAt))) handleRemoteDocument(doc);
    }catch(error){console.warn('PriceLog sync check failed',error);}
  },POLL_INTERVAL_MS);
}

function migrationKey(){return currentUser ? MIGRATION_KEY_PREFIX+currentUser.id : '';}
function markMigrationDone(){
  if(!currentUser) return;
  localStorage.setItem(migrationKey(),'1');
}
function migrationAlreadyDecided(){
  if(!currentUser) return false;
  return localStorage.getItem(migrationKey())==='1';
}

function askLocalMigration(localCount,hasCloud){
  const dialog=$('cloudMigrationDialog');
  if(!dialog) return Promise.resolve(false);
  const text=$('cloudMigrationText');
  if(text){
    text.textContent=hasCloud
      ? `この端末に${localCount}件の商品データがあります。現在のクラウドデータと結合して、このアカウントに引き継ぎますか？`
      : `この端末に${localCount}件の商品データがあります。このアカウントのクラウドデータとして引き継ぎますか？`;
  }
  $('btnCloudMigrationEmpty')?.classList.toggle('hidden',!hasCloud);
  return new Promise(resolve=>{
    migrationResolver=resolve;
    dialog.showModal();
  });
}
function resolveMigration(choice){
  const dialog=$('cloudMigrationDialog');
  if(dialog?.open) dialog.close();
  const resolve=migrationResolver; migrationResolver=null;
  if(resolve) resolve(choice);
}

async function loadPersonalOnLogin(){
  activeScope='personal'; localStorage.setItem(ACTIVE_SCOPE_KEY,activeScope);
  const doc=await fetchDocument(); currentDocumentId=doc?.id || null; lastCloudUpdatedAt=doc?.updated_at || '';
  const cloudProducts=Array.isArray(doc?.data?.products)?doc.data.products:[];
  const local=localProducts();
  if(!migrationAlreadyDecided() && local.length){
    const choice=await askLocalMigration(local.length,Boolean(doc));
    if(choice==='import'){
      const merged=doc ? mergeProducts(cloudProducts,local) : local;
      replaceLocal(merged);
      await writeDocument(merged);
    }else if(choice==='empty'){
      replaceLocal([]);
      await writeDocument([]);
    }else{
      replaceLocal(cloudProducts);
      if(!doc) await writeDocument([]);
    }
    markMigrationDone();
    return;
  }
  if(doc){
    replaceLocal(cloudProducts);
  }else{
    replaceLocal([]);
    await writeDocument([]);
  }
  markMigrationDone();
}

async function loadScope({mergeLocal=false}={}) {
  if(!currentUser) return;
  const doc=await fetchDocument(); currentDocumentId=doc?.id || null; lastCloudUpdatedAt=doc?.updated_at || '';
  const cloudProducts=Array.isArray(doc?.data?.products)?doc.data.products:[];
  const local=localProducts();
  if(!doc){
    const initial=mergeLocal ? local : [];
    replaceLocal(initial);
    await writeDocument(initial);
    return;
  }
  if(mergeLocal){
    const merged=mergeProducts(cloudProducts,local);
    replaceLocal(merged); await writeDocument(merged);
  }else{
    replaceLocal(cloudProducts);
  }
}

function queueUpload() {
  if(suppressUpload || !currentUser || !client) return;
  clearTimeout(uploadTimer);
  uploadTimer=setTimeout(async()=>{
    try{await writeDocument(localProducts());}
    catch(error){console.error(error);setMessage('クラウドへの保存に失敗しました。');}
  },700);
}

async function applySession(session) {
  const nextUser=session?.user || null;
  if(!nextUser){
    currentUser=null; loadedUserId=null; currentDocumentId=null; lastCloudUpdatedAt='';
    stopScopeSync(); setMessage(''); renderAccount();
    return;
  }
  currentUser=nextUser; setMessage(''); renderAccount();
  if(loadedUserId===currentUser.id) return;
  loadedUserId=currentUser.id;
  try {
    await loadGroups();
    if(activeScope.startsWith('group:') && groups.some(g=>`group:${g.id}`===activeScope)) await loadScope();
    else await loadPersonalOnLogin();
    await loadGroups(); renderAccount(); startScopeSync();
  } catch(error){ console.error(error); setMessage('データを読み込めませんでした。設定を確認してください。'); }
}

async function loginGoogle() {
  if(!client) return setMessage('Googleログインの準備ができていません。');
  const redirectTo=`${location.origin}${location.pathname}`;
  const {error}=await client.auth.signInWithOAuth({provider:'custom:pricelog-google',options:{redirectTo}}); if(error) setMessage(error.message || 'Googleログインを開始できませんでした。');
}

async function createGroup() {
  const name=$('newGroupName')?.value.trim(); if(!name) return setMessage('共有名を入力してください。');
  const {error}=await client.rpc('pricelog_create_group',{p_name:name}); if(error) return setMessage('共有を作成できませんでした。');
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
  if(activeScope===`group:${group.id}`){
    stopScopeSync(); activeScope='personal';localStorage.setItem(ACTIVE_SCOPE_KEY,activeScope);currentDocumentId=null;
    await loadScope(); startScopeSync();
  }
  await loadGroups();
}
async function activateGroup(group) {
  if(activeScope===`group:${group.id}`) return;
  const merge=confirm(`「${group.name}」を使います。\n\n現在この端末に表示しているPriceLogのデータも共有データへ追加して結合しますか？\n\nOK：結合する\nキャンセル：共有データだけを表示する`);
  stopScopeSync(); activeScope=`group:${group.id}`; localStorage.setItem(ACTIVE_SCOPE_KEY,activeScope); currentDocumentId=null; lastCloudUpdatedAt='';
  try{ await loadScope({mergeLocal:merge}); await loadGroups(); renderAccount(); startScopeSync(); }
  catch(error){console.error(error);setMessage('共有データを開けませんでした。');}
}
async function activatePersonal() {
  if(activeScope==='personal') return;
  stopScopeSync(); activeScope='personal'; localStorage.setItem(ACTIVE_SCOPE_KEY,activeScope); currentDocumentId=null; lastCloudUpdatedAt='';
  try{await loadScope();await loadGroups();renderAccount();startScopeSync();}catch(error){console.error(error);setMessage('自分のデータを開けませんでした。');}
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
$('btnCloudMigrationImport')?.addEventListener('click',()=>resolveMigration('import'));
$('btnCloudMigrationSkip')?.addEventListener('click',()=>resolveMigration('cloud'));
$('btnCloudMigrationEmpty')?.addEventListener('click',()=>{
  if(confirm('このアカウントに保存されているPriceLogのクラウドデータを空にしますか？')) resolveMigration('empty');
});
$('cloudMigrationDialog')?.addEventListener('cancel',e=>e.preventDefault());
$('btnLogout')?.addEventListener('click',async()=>{
  stopScopeSync();
  if(client)await client.auth.signOut();
  activeScope='personal';localStorage.setItem(ACTIVE_SCOPE_KEY,activeScope);currentDocumentId=null;lastCloudUpdatedAt='';loadedUserId=null;
});
window.addEventListener('pricelog:data-changed',queueUpload);
renderAccount();
initClient();
})();
