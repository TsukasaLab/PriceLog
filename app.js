/* Ver.0.50 temporary showcase data.
   It is inserted only when there are no fuel/maintenance/expense records. */
(function seedShowcaseData(){
 try{
  const parse=k=>{try{return JSON.parse(localStorage.getItem(k)||"[]")}catch(e){return[]}};
  const existing=[...parse("fuelRecords"),...parse("carlog_maintenance"),...parse("carlog_expenses")];
  if(existing.length) return;
  let vs=parse("carlog_vehicles");
  let v=vs[0];
  if(!v){
    v={id:"demo-freed",name:"Honda FREED",maker:"Honda",model:"GP3",year:"2014",color:"white",
       odometer:38842,inspectionDate:"2027-06-15",oilInterval:5000,plate:"",photoId:null,memos:[]};
    vs=[v]; localStorage.setItem("carlog_vehicles",JSON.stringify(vs)); localStorage.setItem("carlog_vehicle",JSON.stringify(v));
  }else{
    v.odometer=Math.max(+v.odometer||0,38842);
    if(!v.model)v.model="GP3"; if(!v.color)v.color="white"; if(!v.oilInterval)v.oilInterval=5000;
    localStorage.setItem("carlog_vehicles",JSON.stringify(vs)); localStorage.setItem("carlog_vehicle",JSON.stringify(v));
  }
  localStorage.setItem("carlog_active_vehicle",v.id);
  const vid=v.id;
  localStorage.setItem("fuelRecords",JSON.stringify([
   {id:"show-f1",vehicleId:vid,date:"2026-09-20",time:"15:30",odometer:38842,liters:39.6,store:"ENEOS",amount:6280,fullTank:true,distance:626,fuelEconomy:15.8,pricePerLiter:158.6,createdAt:"2026-09-20T15:30:00"},
   {id:"show-f2",vehicleId:vid,date:"2026-08-20",time:"16:10",odometer:38216,liters:40.2,store:"コスモ石油",amount:6650,fullTank:true,distance:647,fuelEconomy:16.1,pricePerLiter:165.4,createdAt:"2026-08-20T16:10:00"},
   {id:"show-f3",vehicleId:vid,date:"2026-07-18",time:"11:20",odometer:37569,liters:38.8,store:"ENEOS",amount:6360,fullTank:true,distance:605,fuelEconomy:15.6,pricePerLiter:163.9,createdAt:"2026-07-18T11:20:00"},
   {id:"show-f4",vehicleId:vid,date:"2026-06-16",time:"17:05",odometer:36964,liters:39.1,store:"apollostation",amount:6250,fullTank:true,distance:594,fuelEconomy:15.2,pricePerLiter:159.8,createdAt:"2026-06-16T17:05:00"},
   {id:"show-f5",vehicleId:vid,date:"2026-05-15",time:"12:10",odometer:36370,liters:38.2,store:"ENEOS",amount:6110,fullTank:true,distance:607,fuelEconomy:15.9,pricePerLiter:159.9,createdAt:"2026-05-15T12:10:00"}
  ]));
  localStorage.setItem("carlog_maintenance",JSON.stringify([
   {id:"show-m1",vehicleId:vid,date:"2026-09-12",time:"10:00",type:"オイル交換",odometer:38620,amount:4800,store:"カーショップ",memo:"エンジンオイル交換"},
   {id:"show-m2",vehicleId:vid,date:"2026-08-28",time:"13:00",type:"タイヤ交換",odometer:37100,amount:28400,store:"タイヤショップ",memo:"後輪2本交換"}
  ]));
  localStorage.setItem("carlog_expenses",JSON.stringify([
   {id:"show-e1",vehicleId:vid,date:"2026-09-05",time:"14:00",category:"洗車",amount:1200,store:"洗車場",memo:"手洗い洗車"},
   {id:"show-e2",vehicleId:vid,date:"2026-08-10",time:"09:00",category:"用品",amount:1400,store:"カー用品店",memo:"車用品"}
  ]));
  localStorage.setItem("carlog_showcase_v050","1");
 }catch(e){console.warn("showcase seed skipped",e)}
})();



const KEY={vehicles:"carlog_vehicles",active:"carlog_active_vehicle",legacy:"carlog_vehicle",fuel:"fuelRecords",maint:"carlog_maintenance",expense:"carlog_expenses"};
const load=(k,d)=>{try{let v=localStorage.getItem(k);return v?JSON.parse(v):d}catch{return d}},save=(k,v)=>localStorage.setItem(k,JSON.stringify(v));
const uid=p=>p+"_"+(crypto.randomUUID?crypto.randomUUID():Date.now()+"_"+Math.random().toString(16).slice(2));
const today=()=>{let d=new Date();return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,10)},nowTime=()=>new Date().toTimeString().slice(0,5),nf=v=>Number(v||0).toLocaleString("ja-JP"),esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
let vehicles=load(KEY.vehicles,[]),activeId=localStorage.getItem(KEY.active)||"",fuelRecords=load(KEY.fuel,[]),maintenanceRecords=load(KEY.maint,[]),expenseRecords=load(KEY.expense,[]);
let edit={fuel:null,maintenance:null,expense:null,vehicle:null},costYear=new Date().getFullYear(),costChartMode="total",driveMode="distance",pendingVehiclePhoto=null,memoDraft=[];
const COLOR_LABELS={white:"ホワイト",black:"ブラック",silver:"シルバー",gray:"グレー",red:"レッド",blue:"ブルー",navy:"ネイビー",green:"グリーン",beige:"ベージュ",brown:"ブラウン",yellow:"イエロー",orange:"オレンジ",purple:"パープル",other:"その他"};
const COLOR_HEX={white:"#f4f4f2",black:"#25282d",silver:"#b8bdc5",gray:"#737982",red:"#c93c3c",blue:"#3478c8",navy:"#263f68",green:"#4f7d57",beige:"#d5c4a1",brown:"#795548",yellow:"#e5bf36",orange:"#df7b2c",purple:"#76518d",other:"#8b95a5"};
function carSvg(color,bodyType="compact-minivan"){
 let fill=COLOR_HEX[color]||"#f4f5f6";
 const shapes={
  "kei":"M22 59l9-24c3-8 9-12 17-12h70c9 0 15 5 19 13l11 23 15 6v10H13V65z",
  "kei-tall":"M22 59l8-31c2-8 8-12 17-12h75c9 0 15 5 18 14l9 29 14 6v10H13V65z",
  "compact":"M20 59l15-22c5-8 12-12 22-12h61c10 0 18 4 24 12l16 22 10 6v10H12V65z",
  "sedan":"M17 60l24-17c9-7 17-16 31-17h40c14 1 24 9 34 18l20 16 5 5v10H10V65z",
  "wagon":"M18 59l18-24c6-8 12-11 22-11h70c9 0 16 5 21 13l13 22 8 6v10H10V65z",
  "compact-minivan":"M18 59l14-28c4-9 11-13 21-13h73c10 0 17 5 22 14l13 27 8 6v10H10V65z",
  "minivan":"M18 59l12-31c4-10 10-14 21-14h77c10 0 18 6 22 16l11 29 9 6v10H10V65z",
  "suv":"M16 59l18-25c6-8 14-12 24-12h67c11 0 19 5 25 14l14 23 8 6v10H9V65z",
  "coupe":"M17 60l28-20c12-9 23-15 38-15h31c15 0 25 8 37 19l16 16 5 5v10H10V65z",
  "van":"M18 59l9-32c3-10 9-14 20-14h78c11 0 18 6 21 17l8 29 15 6v10H10V65z"
 };
 return `<svg viewBox="0 0 180 90" class="generated-car"><defs><linearGradient id="paint" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".72"/><stop offset=".42" stop-color="${fill}"/><stop offset="1" stop-color="${fill}"/></linearGradient></defs><ellipse cx="91" cy="77" rx="70" ry="7" fill="rgba(0,0,0,.22)"/><path fill="url(#paint)" stroke="rgba(25,34,41,.82)" stroke-width="2.4" d="${shapes[bodyType]||shapes["compact-minivan"]}"/><path fill="#cfe0ea" opacity=".9" d="M49 29h30v24H38l9-20zm38 0h32c7 0 11 3 15 9l10 15H87z"/><path d="M34 58h116" stroke="rgba(255,255,255,.45)" stroke-width="2"/><circle cx="47" cy="72" r="12" fill="#20262b"/><circle cx="47" cy="72" r="6" fill="#aab3b9"/><circle cx="137" cy="72" r="12" fill="#20262b"/><circle cx="137" cy="72" r="6" fill="#aab3b9"/></svg>`;
}

function migrate(){let legacy=load(KEY.legacy,null);if(!vehicles.length&&legacy){vehicles=[legacy];save(KEY.vehicles,vehicles);activeId=legacy.id;localStorage.setItem(KEY.active,activeId)}if(!activeId&&vehicles[0]){activeId=vehicles[0].id;localStorage.setItem(KEY.active,activeId)}if(vehicles.length===1){[fuelRecords,maintenanceRecords,expenseRecords].forEach(a=>a.forEach(r=>{if(!r.vehicleId)r.vehicleId=vehicles[0].id}));persistRecords()}}
function persistRecords(){save(KEY.fuel,fuelRecords);save(KEY.maint,maintenanceRecords);save(KEY.expense,expenseRecords)}
const car=()=>vehicles.find(v=>v.id===activeId)||null,fuels=()=>fuelRecords.filter(r=>r.vehicleId===activeId),maints=()=>maintenanceRecords.filter(r=>r.vehicleId===activeId),expenses=()=>expenseRecords.filter(r=>r.vehicleId===activeId);
function stamp(r){
 const d=r?.date||"";
 const n=String(Number(r?.count||0)).padStart(3,"0");
 const x=r?.createdAt||r?.time||"";
 return `${d}_${n}_${x}`;
}
function show(id){
 document.querySelectorAll(".screen").forEach(x=>x.classList.add("hidden"));
 const target=document.getElementById(id);
 if(target)target.classList.remove("hidden");
 document.body.dataset.screen=id;
 let hide=id==="setup";
 bottomNav.classList.toggle("hidden",hide);
 adDock.classList.toggle("hidden-ad",hide);
 document.querySelectorAll(".pc-sidebar button").forEach(b=>b.classList.remove("active"));
 const map={home:0,fuel:1,maintenance:2,expense:3,history:4,costs:5,driving:6,vehicles:7,vehicleEdit:7,vehicleNotes:7,settings:8,help:8};
 const buttons=document.querySelectorAll(".pc-sidebar button");
 if(map[id]!=null&&buttons[map[id]])buttons[map[id]].classList.add("active");
 window.scrollTo(0,0);
}
document.addEventListener("DOMContentLoaded",()=>{migrate();refreshStoreNames();car()?goHome():show("setup")});

function currentKm(){let c=car();return Math.max(Number(c?.odometer)||0,...fuels().map(r=>+r.odometer||0),...maints().map(r=>+r.odometer||0))}
function createVehicleFromSetup(){let n=setupName.value.trim(),km=+setupKm.value;if(!n||km<0)return alert("車両名と走行距離を入力してください。");let v={id:uid("vehicle"),name:n,maker:setupMaker.value.trim(),odometer:km,inspectionDate:setupInspection.value,oilInterval:+setupOil.value||5000,createdAt:new Date().toISOString(),memos:[]};vehicles.push(v);activeId=v.id;save(KEY.vehicles,vehicles);localStorage.setItem(KEY.active,activeId);goHome()}
function goHome(){edit.fuel=edit.maintenance=edit.expense=null;if(!car())return show("setup");show("home");renderHome()}
function costs(y,m){let same=r=>{let d=(r.date||"").split("-").map(Number);return d[0]===y&&(!m||d[1]===m)},f=fuels().filter(same).reduce((s,r)=>s+(+r.amount||0),0),mt=maints().filter(same).reduce((s,r)=>s+(+r.amount||0),0),e=expenses().filter(same).reduce((s,r)=>s+(+r.amount||0),0);return{fuel:f,maint:mt,other:e,total:f+mt+e}}
function recomputeFuel(){let rs=fuels().sort((a,b)=>+a.odometer-+b.odometer||stamp(a).localeCompare(stamp(b)));rs.forEach((r,i)=>{let p=rs[i-1];r.distance=p?+r.odometer-+p.odometer:null;r.fuelEconomy=p&&r.fullTank&&p.fullTank&&r.distance>0?r.distance/+r.liters:null;r.pricePerLiter=+r.liters?+r.amount/+r.liters:null});save(KEY.fuel,fuelRecords)}
async function renderHome(){let c=car(),km=currentKm();c.odometer=km;save(KEY.vehicles,vehicles);homeCarName.textContent=c.name;homeMaker.textContent=c.maker||"";homeCarMeta.textContent=[c.model,c.year,COLOR_LABELS[c.color]||c.color].filter(Boolean).join(" / ");homeKm.textContent=nf(km)+" km";applyHomeHeroScene(c);renderCarThumb(c);
let d=new Date(),y=d.getFullYear(),m=d.getMonth()+1,mc=costs(y,m);monthFuel.textContent=nf(mc.fuel)+" 円";monthTotal.textContent=nf(mc.total)+" 円";let md=monthDrive(y,m);monthKm.textContent=nf(Math.round(md.distance))+" km";let eco=fuels().filter(r=>+r.fuelEconomy>0).sort((a,b)=>stamp(b).localeCompare(stamp(a)))[0];latestEco.textContent=eco?(+eco.fuelEconomy).toFixed(1)+" km/L":"記録なし";
let yc=costs(y),elapsed=m;yearTotal.textContent=nf(yc.total)+" 円";yearAvg.textContent=nf(Math.round(yc.total/elapsed))+" 円";let yd=Array.from({length:12},(_,i)=>monthDrive(y,i+1).distance).reduce((a,b)=>a+b,0);yearKm.textContent=nf(Math.round(yd))+" km";perKm.textContent=yd?(yc.total/yd).toFixed(1)+" 円/km":"---";
if(c.inspectionDate){inspection.textContent=c.inspectionDate.replaceAll("-","/");let days=Math.ceil((new Date(c.inspectionDate+"T00:00:00")-new Date(today()+"T00:00:00"))/86400000);inspectionLeft.textContent=days>=0?"あと "+nf(days)+" 日":"期限切れ"}else{inspection.textContent="未設定";inspectionLeft.textContent=""}
let oil=maints().filter(r=>["オイル交換","オイル＋フィルター交換"].includes(r.type)).sort((a,b)=>+b.odometer-+a.odometer)[0];if(c.oilInterval){let target=(oil?+oil.odometer:km)+(+c.oilInterval);oilTarget.textContent=nf(target)+" km";let left=target-km;oilLeft.textContent=left>=0?"あと "+nf(left)+" km":nf(Math.abs(left))+" km超過"}else{oilTarget.textContent="未設定";oilLeft.textContent=""}
let all=allRecords().slice(0,5);recent.innerHTML=all.length?all.map(historyHtml).join(""):'<p class="help">まだ記録がありません。中央の＋から追加できます。</p>';renderHomeMemos(c);renderRecentStable();renderCorrectDashboard(c)}
async function renderCarThumb(c){if(heroScenePath(c)&&!c.photoId){homeCarThumb.innerHTML="";return}homeCarThumb.innerHTML=vehicleImageMarkup(c.bodyType||"compact-minivan",c.color||"white","home-photo-car");if(c.photoId){let rec=await imageGet(c.photoId);if(rec){let u=URL.createObjectURL(rec.blob);homeCarThumb.innerHTML=`<img src="${u}" onload="URL.revokeObjectURL(this.src)">`}}}
function allRecords(){let a=[];fuels().forEach(r=>a.push({...r,_kind:"fuel",_title:"給油",_detail:[r.store,r.liters?`${r.liters} L`:""].filter(Boolean).join(" ・ ")}));maints().forEach(r=>a.push({...r,_kind:"maintenance",_title:r.type||"整備・修理",_detail:[r.store,r.memo].filter(Boolean).join(" ・ ")}));expenses().forEach(r=>a.push({...r,_kind:"expense",_title:r.category||"その他支出",_detail:[r.store,r.memo].filter(Boolean).join(" ・ ")}));return a.sort((a,b)=>stamp(b).localeCompare(stamp(a)))}
function historyHtml(r){return`<div class="recent-row"><div><b>${esc(r._title)}</b><small>${esc(r.date||"")} ${esc(r.time||"")} ${r._detail?"・ "+esc(r._detail):""}</small></div><b>${nf(r.amount)} 円</b></div>`}
function storeNamesList(){return [...new Set([...fuelRecords,...maintenanceRecords,...expenseRecords].map(r=>(r.store||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"ja"))}
function refreshStoreNames(){["fuel","maint","expense"].forEach(p=>populateStoreSelect(p))}
function populateStoreSelect(p,current=""){let el=document.getElementById(p+"StoreSelect");if(!el)return;let names=storeNamesList();el.innerHTML='<option value="">店名を選択</option>'+names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("")+'<option value="__new__">新しい店名を入力</option>';let inp=document.getElementById(p+"Store");if(current&&names.includes(current)){el.value=current;inp.value=current}else if(current){el.value="__new__";inp.value=current}else{el.value="";inp.value=""}}
function chooseStore(p){let s=document.getElementById(p+"StoreSelect"),i=document.getElementById(p+"Store");if(s.value==="__new__"){i.value="";i.focus()}else i.value=s.value}

function openFuel(id=null){edit.fuel=id;let r=id?fuelRecords.find(x=>x.id===id):null;fuelTitle.textContent=r?"給油記録を編集":"給油を記録";fuelSave.textContent=r?"変更を保存":"登録";fuelDelete.classList.toggle("hidden",!r);fuelDate.value=r?.date||today();fuelCount.value=r?.count??"";fuelKm.value=r?.odometer??currentKm();fuelLiters.value=r?.liters??"";populateStoreSelect("fuel",r?.store||"");fuelAmount.value=r?.amount??"";fuelFull.checked=r?.fullTank??true;show("fuel");showSameDay("fuel")}
function saveFuel(){let r={date:fuelDate.value,count:fuelCount.value?+fuelCount.value:null,odometer:+fuelKm.value,liters:+fuelLiters.value,store:fuelStore.value.trim(),amount:+fuelAmount.value,fullTank:fuelFull.checked};if(!r.date||r.odometer<0||r.liters<=0||r.amount<=0)return alert("入力内容を確認してください。");if(edit.fuel){let i=fuelRecords.findIndex(x=>x.id===edit.fuel);fuelRecords[i]={...fuelRecords[i],...r}}else fuelRecords.push({id:uid("fuel"),vehicleId:activeId,...r,createdAt:new Date().toISOString()});persistRecords();recomputeFuel();refreshStoreNames();goHome()}
function openMaintenance(id=null){edit.maintenance=id;let r=id?maintenanceRecords.find(x=>x.id===id):null;maintTitle.textContent=r?"整備・修理を編集":"整備・修理を記録";maintSave.textContent=r?"変更を保存":"登録";maintDelete.classList.toggle("hidden",!r);maintDate.value=r?.date||today();maintCount.value=r?.count??"";maintType.value=r?.type||"オイル交換";maintKm.value=r?.odometer??"";maintAmount.value=r?.amount??"";populateStoreSelect("maint",r?.store||"");maintMemo.value=r?.memo||"";show("maintenance");showSameDay("maintenance")}
function saveMaintenance(){let km=maintKm.value===""?null:+maintKm.value;let r={date:maintDate.value,count:maintCount.value?+maintCount.value:null,type:maintType.value,odometer:km,amount:+maintAmount.value||0,store:maintStore.value.trim(),memo:maintMemo.value.trim()};if(!r.date||(km!==null&&km<0)||r.amount<0)return alert("入力内容を確認してください。");if(edit.maintenance){let i=maintenanceRecords.findIndex(x=>x.id===edit.maintenance);maintenanceRecords[i]={...maintenanceRecords[i],...r}}else maintenanceRecords.push({id:uid("maintenance"),vehicleId:activeId,...r,createdAt:new Date().toISOString()});persistRecords();refreshStoreNames();goHome()}
function openExpense(id=null){edit.expense=id;let r=id?expenseRecords.find(x=>x.id===id):null;expenseTitle.textContent=r?"その他支出を編集":"その他支出を記録";expenseSave.textContent=r?"変更を保存":"登録";expenseDelete.classList.toggle("hidden",!r);expenseDate.value=r?.date||today();expenseCount.value=r?.count??"";expenseCategory.value=r?.category||"自動車税";expenseAmount.value=r?.amount??"";populateStoreSelect("expense",r?.store||"");expenseMemo.value=r?.memo||"";show("expense");showSameDay("expense")}
function saveExpense(){let r={date:expenseDate.value,count:expenseCount.value?+expenseCount.value:null,category:expenseCategory.value,amount:+expenseAmount.value,store:expenseStore.value.trim(),memo:expenseMemo.value.trim()};if(!r.date||r.amount<=0)return alert("日付と金額を入力してください。");if(edit.expense){let i=expenseRecords.findIndex(x=>x.id===edit.expense);expenseRecords[i]={...expenseRecords[i],...r}}else expenseRecords.push({id:uid("expense"),vehicleId:activeId,...r,createdAt:new Date().toISOString()});persistRecords();refreshStoreNames();goHome()}
function deleteCurrent(kind){let id=edit[kind];if(!id||!confirm("この記録を削除しますか？"))return;if(kind==="fuel")fuelRecords=fuelRecords.filter(x=>x.id!==id);if(kind==="maintenance")maintenanceRecords=maintenanceRecords.filter(x=>x.id!==id);if(kind==="expense")expenseRecords=expenseRecords.filter(x=>x.id!==id);persistRecords();if(kind==="fuel")recomputeFuel();refreshStoreNames();goHome()}
function showSameDay(kind){let date=kind==="fuel"?fuelDate.value:kind==="maintenance"?maintDate.value:expenseDate.value,box=kind==="fuel"?fuelSameDay:kind==="maintenance"?maintSameDay:expenseSameDay,arr=kind==="fuel"?fuels():kind==="maintenance"?maints():expenses(),rs=arr.filter(r=>r.date===date).sort((a,b)=>Number(a.count||0)-Number(b.count||0)||stamp(a).localeCompare(stamp(b)));if(!rs.length){box.innerHTML="";return}box.innerHTML=`<div class="samebox"><small>この日の登録済み記録 ${rs.length}件</small>${rs.map(r=>`<div class="same-item"><div><b>${kind==="fuel"?esc((r.liters||0)+" L / "+nf(r.amount)+"円"):kind==="maintenance"?esc(r.type+" / "+nf(r.amount)+"円"):esc(r.category+" / "+nf(r.amount)+"円")}</b></div><button type="button" onclick="${kind==="fuel"?"openFuel":kind==="maintenance"?"openMaintenance":"openExpense"}('${r.id}')">編集</button></div>`).join("")}</div>`}

function openHistory(){show("history");renderHistory("all")}function renderHistory(filter){let rs=allRecords().filter(r=>filter==="all"||r._kind===filter);historyList.innerHTML=rs.length?rs.map(r=>`<button class="card history-entry" onclick="${r._kind==="fuel"?"openFuel":r._kind==="maintenance"?"openMaintenance":"openExpense"}('${r.id}')"><div class="history-main"><b class="history-title">${esc(r._title)}</b><div class="history-detail"><span>${esc(r.date)}</span><span>${nf(r.amount)}円</span>${r.store?`<span>${esc(r.store)}</span>`:""}${r._detail?`<span>${esc(r._detail)}</span>`:""}</div></div><span class="history-edit">編集 ›</span></button>`).join(""):'<div class="card">記録はありません。</div>'}

function openCosts(mode){if(mode)costChartMode=mode;show("costs");renderCosts()}function changeYear(n){costYear+=n;renderCosts()}function setCostChart(m){costChartMode=m;renderCostChart()}
function renderCosts(){costYearEl=document.getElementById("costYear");costYearEl.textContent=costYear+"年";let c=costs(costYear),months=costYear===new Date().getFullYear()?new Date().getMonth()+1:12;costTotal.textContent=nf(c.total)+" 円";costFuel.textContent=nf(c.fuel)+" 円";costMaint.textContent=nf(c.maint)+" 円";costOther.textContent=nf(c.other)+" 円";costAvg.textContent=nf(Math.round(c.total/months))+" 円";renderCostChart()}
function renderCostChart(){let labels={total:"年間合計",fuel:"ガソリン",maint:"整備・維持",other:"その他",avg:"月平均"};["total","fuel","maint","other","avg"].forEach(k=>document.getElementById("costCard"+({total:"Total",fuel:"Fuel",maint:"Maint",other:"Other",avg:"Avg"}[k])).classList.toggle("active",costChartMode===k));monthChartTitle.textContent=costChartMode==="avg"?"月ごとの累計平均":"月別 "+labels[costChartMode];let vals;if(costChartMode==="avg"){let now=new Date(),currentYear=now.getFullYear(),lastMonth=costYear<currentYear?12:costYear===currentYear?now.getMonth()+1:0,run=0;vals=Array.from({length:12},(_,i)=>{let month=i+1;if(month>lastMonth)return null;run+=costs(costYear,month).total;return run/month})}else vals=Array.from({length:12},(_,i)=>costs(costYear,i+1)[costChartMode]);renderBars(monthBars,vals,"円")}

function monthDrive(y,m){let key=`${y}-${String(m).padStart(2,"0")}`,rs=fuels().filter(r=>r.date?.startsWith(key)).sort((a,b)=>stamp(a).localeCompare(stamp(b))),liters=rs.reduce((s,r)=>s+(+r.liters||0),0),amount=rs.reduce((s,r)=>s+(+r.amount||0),0),distance=rs.reduce((s,r)=>s+(+r.distance>0?+r.distance:0),0),ecos=rs.filter(r=>+r.fuelEconomy>0).map(r=>+r.fuelEconomy);return{distance,liters,count:rs.length,economy:ecos.length?ecos.reduce((a,b)=>a+b,0)/ecos.length:0,price:liters?amount/liters:0,fuelkm:distance?amount/distance:0}}
function openDriving(mode){if(mode)driveMode=mode;show("driving");renderDriving()}function setDriveChart(m){driveMode=m;renderDriving()}
function renderDriving(){let y=new Date().getFullYear(),vals=Array.from({length:12},(_,i)=>monthDrive(y,i+1)),sum=k=>vals.reduce((s,x)=>s+x[k],0),lit=sum("liters"),dist=sum("distance"),amount=costs(y).fuel,eco=vals.filter(x=>x.economy).map(x=>x.economy);driveDistance.textContent=nf(Math.round(dist))+" km";driveLiters.textContent=lit.toFixed(1)+" L";driveCount.textContent=nf(sum("count"))+" 回";driveEconomy.textContent=eco.length?(eco.reduce((a,b)=>a+b,0)/eco.length).toFixed(1)+" km/L":"---";drivePrice.textContent=lit?(amount/lit).toFixed(1)+" 円/L":"---";driveFuelKm.textContent=dist?(amount/dist).toFixed(1)+" 円/km":"---";let map={distance:["Distance","走行距離","km"],liters:["Liters","給油量","L"],count:["Count","給油回数","回"],economy:["Economy","平均燃費","km/L"],price:["Price","平均単価","円/L"],fuelkm:["FuelKm","1km燃料代","円/km"]};Object.keys(map).forEach(k=>document.getElementById("driveCard"+map[k][0]).classList.toggle("active",driveMode===k));driveChartTitle.textContent="月別 "+map[driveMode][1];renderBars(driveBars,vals.map(x=>x[driveMode]),map[driveMode][2])}
function renderBars(el,vals,unit){let numeric=vals.filter(v=>v!==null&&Number.isFinite(+v)),max=Math.max(1,...numeric);el.innerHTML=vals.map((v,i)=>v===null?`<div class="barcol future"><div class="bar-empty"></div><small></small>${i+1}</div>`:`<div class="barcol"><div class="bar" style="height:${Math.max(2,(+v)/max*145)}px" title="${(+v).toFixed((+v)%1?1:0)} ${unit}"></div><small>${v?(+v).toFixed((+v)>=100?0:1):""}</small>${i+1}</div>`).join("")}

function openVehicleManager(){show("vehicles");renderVehicles()}function renderVehicles(){vehicleList.innerHTML=vehicles.map(v=>`<div class="card vehicle-row"><button class="vehicle-select" onclick="selectVehicle('${v.id}')"><div><b>${esc(v.name)} ${v.id===activeId?"✓":""}</b><small>${esc([v.maker,v.model,v.color].filter(Boolean).join(" / "))} ・ ${nf(v.odometer)} km</small></div><span>切替</span></button><button class="vehicle-edit-btn" onclick="openVehicleEdit('${v.id}')">編集</button></div>`).join("")}function selectVehicle(id){activeId=id;localStorage.setItem(KEY.active,id);goHome()}
async function openVehicleEdit(id=null){edit.vehicle=id;let v=id?vehicles.find(x=>x.id===id):null;vehicleEditTitle.textContent=v?"車両を編集":"車両を追加";vehicleDelete.classList.toggle("hidden",!v);editCarName.value=v?.name||"";editCarMaker.value=v?.maker||"";editCarModel.value=v?.model||"";editCarYear.value=v?.year||"";let vc=v?.color||"";if(vc&&!COLOR_LABELS[vc]){let x=vc.toLowerCase();vc=x.includes("白")||x.includes("white")?"white":x.includes("黒")||x.includes("black")?"black":x.includes("銀")||x.includes("silver")?"silver":x.includes("灰")||x.includes("gray")?"gray":x.includes("赤")||x.includes("red")?"red":x.includes("青")||x.includes("blue")?"blue":x.includes("緑")||x.includes("green")?"green":x.includes("黄")||x.includes("yellow")?"yellow":"other"}editCarColor.value=vc;editCarBodyType.value=v?.bodyType||"compact-minivan";renderBodyTypeChoices();editCarPurchase.value=v?.purchaseDate||"";editCarPlate.value=v?.plate||"";editCarKm.value=v?.odometer??"";editCarInspection.value=v?.inspectionDate||"";editCarOil.value=v?.oilInterval||5000;pendingVehiclePhoto=v?.photoId||null;memoDraft=JSON.parse(JSON.stringify(v?.memos||[]));show("vehicleEdit");await renderVehiclePhoto();renderMemoEditor()}
async function saveVehicleEdit(){syncMemoText();let n=editCarName.value.trim(),km=+editCarKm.value;if(!n||km<0)return alert("車両名と走行距離を入力してください。");let data={name:n,maker:editCarMaker.value.trim(),model:editCarModel.value.trim(),year:editCarYear.value.trim(),color:editCarColor.value.trim(),bodyType:editCarBodyType.value||"compact-minivan",purchaseDate:editCarPurchase.value,plate:editCarPlate.value.trim(),odometer:km,inspectionDate:editCarInspection.value,oilInterval:+editCarOil.value||5000,photoId:pendingVehiclePhoto,memos:memoDraft};if(edit.vehicle){let i=vehicles.findIndex(x=>x.id===edit.vehicle);vehicles[i]={...vehicles[i],...data}}else{let v={id:uid("vehicle"),...data,createdAt:new Date().toISOString()};vehicles.push(v);activeId=v.id;localStorage.setItem(KEY.active,activeId)}save(KEY.vehicles,vehicles);goHome()}
async function deleteVehicle(){let id=edit.vehicle;if(!id||!confirm("この車両と関連するすべての記録・写真を削除しますか？"))return;let v=vehicles.find(x=>x.id===id);if(v){let ids=[v.photoId,...(v.memos||[]).flatMap(m=>m.photos||[])].filter(Boolean);for(let x of ids)await imageDelete(x)}vehicles=vehicles.filter(v=>v.id!==id);fuelRecords=fuelRecords.filter(r=>r.vehicleId!==id);maintenanceRecords=maintenanceRecords.filter(r=>r.vehicleId!==id);expenseRecords=expenseRecords.filter(r=>r.vehicleId!==id);activeId=vehicles[0]?.id||"";save(KEY.vehicles,vehicles);localStorage.setItem(KEY.active,activeId);persistRecords();activeId?goHome():show("setup")}

function addMemo(){syncMemoText();memoDraft.push({id:uid("memo"),title:"",content:"",photos:[]});renderMemoEditor()}
function syncMemoText(){document.querySelectorAll("[data-memo]").forEach(el=>{let m=memoDraft.find(x=>x.id===el.dataset.memo);if(m)m[el.dataset.field]=el.value})}
function renderMemoEditor(){memoEditor.innerHTML=memoDraft.length?memoDraft.map((m,i)=>`<div class="memo-edit"><div class="memo-number">メモ ${i+1}</div><label>題名<textarea rows="3" data-memo="${m.id}" data-field="title"></textarea></label><label>内容<textarea rows="7" data-memo="${m.id}" data-field="content"></textarea></label><div id="photos_${m.id}" class="photo-grid"></div><div class="photo-actions"><select id="quality_${m.id}"><option value="standard">標準</option><option value="high">高画質</option><option value="original">原画</option></select><label class="file-btn">写真から選択<input type="file" accept="image/*" multiple onchange="addMemoPhotos('${m.id}',event)"></label><label class="file-btn">撮影する<input type="file" accept="image/*" capture="environment" onchange="addMemoPhotos('${m.id}',event)"></label><button type="button" class="danger-mini" onclick="removeMemo('${m.id}')">メモを削除</button></div></div>`).join(""):'<div class="empty-memo">「＋ メモを追加」で新しいメモを作成します。</div>';memoDraft.forEach(m=>{document.querySelector(`[data-memo="${m.id}"][data-field="title"]`).value=m.title||"";document.querySelector(`[data-memo="${m.id}"][data-field="content"]`).value=m.content||"";renderMemoPhotos(m)})}
function removeMemo(id){if(!confirm("このメモと添付写真を削除しますか？"))return;let m=memoDraft.find(x=>x.id===id);Promise.all((m?.photos||[]).map(imageDelete)).then(()=>{memoDraft=memoDraft.filter(x=>x.id!==id);renderMemoEditor()})}
async function addMemoPhotos(id,e){syncMemoText();let m=memoDraft.find(x=>x.id===id),q=document.getElementById("quality_"+id).value;for(let f of [...e.target.files]){let blob=await processImage(f,q),pid=uid("img");await imagePut(pid,blob,{quality:q,name:f.name});m.photos.push(pid)}e.target.value="";renderMemoEditor();updateStorage()}
async function renderMemoPhotos(m){let el=document.getElementById("photos_"+m.id);if(!el)return;el.innerHTML="";for(let pid of m.photos||[]){let rec=await imageGet(pid);if(!rec)continue;let u=URL.createObjectURL(rec.blob),d=document.createElement("div");d.className="photo-tile";d.innerHTML=`<img src="${u}"><button type="button" onclick="removeMemoPhoto('${m.id}','${pid}')">×</button>`;d.querySelector("img").onclick=()=>openImage(u);el.appendChild(d)}}
async function removeMemoPhoto(mid,pid){if(!confirm("この写真をCarLogから削除しますか？"))return;await imageDelete(pid);let m=memoDraft.find(x=>x.id===mid);m.photos=(m.photos||[]).filter(x=>x!==pid);renderMemoPhotos(m);updateStorage()}
async function selectVehiclePhoto(e){let f=e.target.files?.[0];if(!f)return;if(pendingVehiclePhoto)await imageDelete(pendingVehiclePhoto);let blob=await processImage(f,"high"),id=uid("img");await imagePut(id,blob,{quality:"high",name:f.name});pendingVehiclePhoto=id;e.target.value="";renderVehiclePhoto();updateStorage()}
async function removeVehiclePhoto(){if(!pendingVehiclePhoto)return;if(!confirm("車両写真をCarLogから削除しますか？"))return;await imageDelete(pendingVehiclePhoto);pendingVehiclePhoto=null;renderVehiclePhoto();updateStorage()}
function renderVehicleColorPreview(){renderBodyTypeChoices()}
async function renderVehiclePhoto(){
 let empty=`<div class="vehicle-photo-empty"><span>＋</span><strong>画像を追加</strong></div>`;
 vehiclePhotoPreview.innerHTML=empty;
 if(pendingVehiclePhoto){
  let r=await imageGet(pendingVehiclePhoto);
  if(r){let u=URL.createObjectURL(r.blob);vehiclePhotoPreview.innerHTML=`<img src="${u}" onclick="openImage('${u}')">`}
 }
}
function openImage(url){let w=window.open();if(w)w.document.write(`<meta name="viewport" content="width=device-width"><body style="margin:0;background:#111;display:grid;place-items:center;min-height:100vh"><img src="${url}" style="max-width:100%;max-height:100vh"></body>`)}

function renderHomeMemos(c){let ms=(c.memos||[]).slice(0,3);homeMemos.innerHTML=ms.length?ms.map(m=>`<button class="memo-home-row" onclick="openVehicleNotes()"><b>${esc(m.title||"無題")}</b><span>${esc((m.content||"").slice(0,70))}</span></button>`).join(""):'<p class="help">車両メモはまだありません。</p>'}
async function openVehicleNotes(){show("vehicleNotes");let c=car(),ms=c?.memos||[];vehicleNotesList.innerHTML=ms.length?ms.map(m=>`<div class="card note-view"><h3>${esc(m.title||"無題")}</h3><div class="note-content">${esc(m.content||"").replace(/\n/g,"<br>")}</div><div id="viewphotos_${m.id}" class="photo-grid"></div></div>`).join(""):'<div class="card">車両メモはありません。</div>';for(let m of ms){let el=document.getElementById("viewphotos_"+m.id);for(let pid of m.photos||[]){let rec=await imageGet(pid);if(!rec)continue;let u=URL.createObjectURL(rec.blob),img=document.createElement("img");img.src=u;img.className="note-photo";img.onclick=()=>openImage(u);el.appendChild(img)}}}
function openSettings(){show("settings")}function openHelp(){show("help")}
function openQuick(){quickBackdrop.classList.remove("hidden")}function closeQuick(e){if(e&&e.target!==quickBackdrop)return;quickBackdrop.classList.add("hidden")}

function idb(){return new Promise((res,rej)=>{let q=indexedDB.open("CarLogDB",1);q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains("images"))q.result.createObjectStore("images",{keyPath:"id"})};q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)})}
async function imagePut(id,blob,meta={}){let db=await idb();return new Promise((res,rej)=>{let tx=db.transaction("images","readwrite");tx.objectStore("images").put({id,blob,...meta,createdAt:new Date().toISOString()});tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)})}
async function imageGet(id){if(!id)return null;let db=await idb();return new Promise((res,rej)=>{let q=db.transaction("images").objectStore("images").get(id);q.onsuccess=()=>res(q.result||null);q.onerror=()=>rej(q.error)})}
async function imageDelete(id){if(!id)return;let db=await idb();return new Promise((res,rej)=>{let tx=db.transaction("images","readwrite");tx.objectStore("images").delete(id);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)})}
async function allImages(){let db=await idb();return new Promise((res,rej)=>{let q=db.transaction("images").objectStore("images").getAll();q.onsuccess=()=>res(q.result||[]);q.onerror=()=>rej(q.error)})}
async function processImage(file,q){if(q==="original")return file;let max=q==="high"?2400:1600,quality=q==="high"?.92:.82,bmp=await createImageBitmap(file),scale=Math.min(1,max/Math.max(bmp.width,bmp.height)),c=document.createElement("canvas");c.width=Math.round(bmp.width*scale);c.height=Math.round(bmp.height*scale);c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);return new Promise(r=>c.toBlob(r,"image/jpeg",quality))}
function bytes(n){if(n<1024)return n+" B";if(n<1048576)return(n/1024).toFixed(1)+" KB";if(n<1073741824)return(n/1048576).toFixed(1)+" MB";return(n/1073741824).toFixed(2)+" GB"}
async function updateStorage(){return}

function blobToDataURL(b){return new Promise(r=>{let fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(b)})}async function dataURLBlob(s){return(await fetch(s)).blob()}
async function exportBackup(withPhotos=false){let data={version:"0.33",exportedAt:new Date().toISOString(),vehicles,activeId,fuelRecords,maintenanceRecords,expenseRecords};if(withPhotos){let imgs=await allImages();data.images=[];for(let x of imgs)data.images.push({id:x.id,quality:x.quality,name:x.name,createdAt:x.createdAt,data:await blobToDataURL(x.blob)})}download(JSON.stringify(data),"CarLog_"+(withPhotos?"Full":"Data")+"_Backup_"+today()+".json","application/json")}
function importBackup(e){let f=e.target.files?.[0];if(!f)return;let rd=new FileReader();rd.onload=async()=>{try{let d=JSON.parse(rd.result);if(!confirm("現在のCarLogデータをバックアップ内容に置き換えますか？"))return;vehicles=d.vehicles||(d.vehicle?[d.vehicle]:[]);activeId=d.activeId||vehicles[0]?.id||"";fuelRecords=d.fuelRecords||[];maintenanceRecords=d.maintenanceRecords||[];expenseRecords=d.expenseRecords||[];save(KEY.vehicles,vehicles);localStorage.setItem(KEY.active,activeId);persistRecords();if(d.images){for(let x of d.images)await imagePut(x.id,await dataURLBlob(x.data),x)}refreshStoreNames();goHome()}catch(err){console.error(err);alert("バックアップファイルを読み込めませんでした。")}};rd.readAsText(f);e.target.value=""}
function csv(v){return'"'+String(v??"").replaceAll('"','""')+'"'}function exportCSV(){let rows=[["車両","種別","日付","回数","走行距離","内容","店名","金額","燃費","メモ"]];vehicles.forEach(v=>{fuelRecords.filter(r=>r.vehicleId===v.id).forEach(r=>rows.push([v.name,"給油",r.date,r.count||"",r.odometer,r.liters+" L",r.store||"",r.amount,r.fuelEconomy||"",r.fullTank?"満タン":""]));maintenanceRecords.filter(r=>r.vehicleId===v.id).forEach(r=>rows.push([v.name,"整備・修理",r.date,r.count||"",r.odometer??"",r.type,r.store||"",r.amount,"",r.memo||""]));expenseRecords.filter(r=>r.vehicleId===v.id).forEach(r=>rows.push([v.name,"その他支出",r.date,r.count||"","",r.category,r.store||"",r.amount,"",r.memo||""]))});download("\uFEFF"+rows.map(r=>r.map(csv).join(",")).join("\r\n"),"CarLog_"+today()+".csv","text/csv;charset=utf-8")}
function download(data,name,type){let a=document.createElement("a"),u=URL.createObjectURL(new Blob([data],{type}));a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1000)}


function renderReferenceDashboard(){
 try{
  const c=car(), km=currentKm();
  const totalKm=document.getElementById("refTotalKm"); if(totalKm) totalKm.textContent=nf(km)+" km";
  const d=new Date(), y=d.getFullYear(), m=d.getMonth()+1, mc=costs(y,m);
  const set=(id,val)=>{const el=document.getElementById(id);if(el)el.textContent=val};
  set("refDonutTotal",nf(mc.total)+"円"); set("refFuelCost",nf(mc.fuel)+"円"); set("refMaintCost",nf(mc.maint)+"円"); set("refOtherCost",nf(mc.other)+"円");
  const total=Math.max(1,mc.total), pf=mc.fuel/total*100, pm=mc.maint/total*100;
  const donut=document.getElementById("refDonut"); if(donut) donut.style.background=`conic-gradient(#ff5962 0 ${pf}%,#20b58b ${pf}% ${pf+pm}%,#8061dc ${pf+pm}% 100%)`;
  const fs=fuels().filter(r=>+r.fuelEconomy>0).sort((a,b)=>stamp(a).localeCompare(stamp(b))).slice(-7);
  const chart=document.getElementById("refEcoChart");
  if(chart){
   if(!fs.length) chart.innerHTML='<p class="help">燃費記録がありません</p>';
   else{
    const vals=fs.map(x=>+x.fuelEconomy), min=Math.min(...vals)-1,max=Math.max(...vals)+1, span=Math.max(1,max-min);
    const pts=vals.map((v,i)=>`${i*(100/(Math.max(1,vals.length-1)))},${82-(v-min)/span*58}`).join(" ");
    chart.innerHTML=`<svg viewBox="0 0 100 90" preserveAspectRatio="none"><defs><linearGradient id="ecoFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1683f3" stop-opacity=".25"/><stop offset="1" stop-color="#1683f3" stop-opacity="0"/></linearGradient></defs><polyline points="0,84 ${pts} 100,84" fill="url(#ecoFill)" stroke="none"/><polyline points="${pts}" fill="none" stroke="#1683f3" stroke-width="2"/><g>${vals.map((v,i)=>`<circle cx="${i*(100/(Math.max(1,vals.length-1)))}" cy="${82-(v-min)/span*58}" r="2.2" fill="#fff" stroke="#1683f3" stroke-width="1.4"/>`).join("")}</g></svg><div class="chart-months">${fs.map(x=>`<span>${+x.date.slice(5,7)}月</span>`).join("")}</div>`;
   }
  }
  const bars=document.getElementById("refYearBars");
  if(bars){
   let monthly=Array.from({length:12},(_,i)=>costs(y,i+1));
   let maxv=Math.max(1,...monthly.map(x=>x.total));
   bars.innerHTML=monthly.map((x,i)=>{let f=x.fuel/maxv*100,ma=x.maint/maxv*100,o=x.other/maxv*100;return `<div class="yb"><div class="yb-stack"><i class="o" style="height:${o}%"></i><i class="m" style="height:${ma}%"></i><i class="f" style="height:${f}%"></i></div><small>${i+1}月</small></div>`}).join("");
  }
 }catch(e){console.warn("reference dashboard",e)}
}



const BODY_TYPES=[
 ["kei","軽自動車"],["kei-tall","軽ハイト"],["compact","コンパクト"],["sedan","セダン"],["wagon","ワゴン"],
 ["compact-minivan","コンパクトミニバン"],["minivan","ミニバン"],["suv","SUV"],["coupe","スポーツ"],["van","商用バン"]
];
function renderBodyTypeChoices(){
 const el=document.getElementById("bodyTypeChoices"); if(!el)return;
 const cur=document.getElementById("editCarBodyType")?.value||"compact-minivan";
 el.innerHTML=BODY_TYPES.map(([v,n])=>`<button type="button" class="body-choice ${cur===v?"selected":""}" onclick="selectBodyType('${v}')"><span>${vehicleImageMarkup(v,editCarColor?.value||"white","selector-car")}</span><b>${n}</b></button>`).join("");
}
function selectBodyType(v){editCarBodyType.value=v;renderBodyTypeChoices();renderVehicleColorPreview()}


function decorateRecentRecords(){
 const root=document.getElementById("recent"); if(!root)return;
 const rows=[...root.children];
 rows.forEach(row=>{
  if(row.classList.contains("recent-fixed"))return;
  const raw=(row.textContent||"").trim();
  let kind="other",ico="¥";
  if(raw.includes("給油")){kind="fuel";ico="⛽"}
  else if(raw.includes("オイル")||raw.includes("整備")){kind="maint";ico="🔧"}
  else if(raw.includes("洗車")){kind="wash";ico="🚙"}
  else if(raw.includes("タイヤ")){kind="tire";ico="◉"}
  row.classList.add("recent-fixed");
  const icon=document.createElement("span");icon.className=`record-icon ${kind}`;icon.textContent=ico;
  row.prepend(icon);
  if(!row.querySelector(".record-chevron")){const ch=document.createElement("span");ch.className="record-chevron";ch.textContent="›";row.append(ch)}
 });
}


function renderRecentStable(){
 const root=document.getElementById("recent"); if(!root)return;
 const vid=car()?.id;
 const all=[];
 fuels().filter(x=>!vid||x.vehicleId===vid).forEach(x=>all.push({...x,_kind:"fuel",_title:"給油",_amount:Number(x.amount||0),_place:x.store||"",_detail:(x.liters?`${x.liters} L`:"")}));
 maints().filter(x=>!vid||x.vehicleId===vid).forEach(x=>all.push({...x,_kind:"maint",_title:x.type||"整備",_amount:Number(x.amount||0),_place:x.store||"",_detail:x.memo||""}));
 expenses().filter(x=>!vid||x.vehicleId===vid).forEach(x=>all.push({...x,_kind:"other",_title:x.category||"その他",_amount:Number(x.amount||0),_place:x.store||"",_detail:x.memo||""}));
 all.sort((a,b)=>(b.date||"").localeCompare(a.date||"")||Number(b.count||0)-Number(a.count||0)||Number(b.createdAt||0)-Number(a.createdAt||0));
 root.innerHTML=all.slice(0,5).map(r=>{
   let kind=r._kind,ico=kind==="fuel"?"⛽":"¥";
   const txt=(r._title+" "+r._detail).toLowerCase();
   if(kind==="maint"){ico="🔧"; if(txt.includes("洗車")){kind="wash";ico="🚙"} else if(txt.includes("タイヤ")){kind="tire";ico="◉"}}
   else if(txt.includes("洗車")){kind="wash";ico="🚙"}
   else if(txt.includes("タイヤ")){kind="tire";ico="◉"}
   const nth="";
   const line2=[r._place,r._detail].filter(Boolean).join("　");
   return `<button class="recent-item" type="button">
    <span class="record-icon ${kind}">${ico}</span>
    <span class="recent-copy"><b>${escapeHtml(r._title)}<small>${escapeHtml(r.date||"")}${nth}</small></b><span>${escapeHtml(line2)}</span></span>
    <strong class="recent-price">${nf(r._amount)} 円</strong><span class="record-chevron">›</span>
   </button>`;
 }).join("")||'<div class="empty">まだ記録がありません</div>';
}

function escapeHtml(s){return String(s??"").replace(/[&<>"\']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","\'":"&#39;"}[c]))}


const PHOTO_VEHICLE_ASSETS={
 "kei|white":"assets/vehicles/kei_white.webp",
 "kei|black":"assets/vehicles/kei_black.webp",
 "kei|silver":"assets/vehicles/kei_silver.webp",
 "kei|gray":"assets/vehicles/kei_gray.webp",
 "kei|red":"assets/vehicles/kei_red.webp",
 "kei|blue":"assets/vehicles/kei_blue.webp",
 "kei|brown":"assets/vehicles/kei_brown.webp",
 "kei|beige":"assets/vehicles/kei_beige.webp",
 "kei-tall|white":"assets/vehicles/kei-tall_white.webp",
 "kei-tall|black":"assets/vehicles/kei-tall_black.webp",
 "kei-tall|silver":"assets/vehicles/kei-tall_silver.webp",
 "kei-tall|gray":"assets/vehicles/kei-tall_gray.webp",
 "kei-tall|red":"assets/vehicles/kei-tall_red.webp",
 "kei-tall|blue":"assets/vehicles/kei-tall_blue.webp",
 "kei-tall|brown":"assets/vehicles/kei-tall_brown.webp",
 "kei-tall|beige":"assets/vehicles/kei-tall_beige.webp",
 "compact|white":"assets/vehicles/compact_white.webp",
 "compact|black":"assets/vehicles/compact_black.webp",
 "compact|silver":"assets/vehicles/compact_silver.webp",
 "compact|gray":"assets/vehicles/compact_gray.webp",
 "compact|red":"assets/vehicles/compact_red.webp",
 "compact|blue":"assets/vehicles/compact_blue.webp",
 "compact|brown":"assets/vehicles/compact_brown.webp",
 "compact|beige":"assets/vehicles/compact_beige.webp",
 "sedan|white":"assets/vehicles/sedan_white.webp",
 "sedan|black":"assets/vehicles/sedan_black.webp",
 "sedan|silver":"assets/vehicles/sedan_silver.webp",
 "sedan|gray":"assets/vehicles/sedan_gray.webp",
 "sedan|red":"assets/vehicles/sedan_red.webp",
 "sedan|blue":"assets/vehicles/sedan_blue.webp",
 "sedan|brown":"assets/vehicles/sedan_brown.webp",
 "sedan|beige":"assets/vehicles/sedan_beige.webp",
 "wagon|white":"assets/vehicles/wagon_white.webp",
 "wagon|black":"assets/vehicles/wagon_black.webp",
 "wagon|silver":"assets/vehicles/wagon_silver.webp",
 "wagon|gray":"assets/vehicles/wagon_gray.webp",
 "wagon|red":"assets/vehicles/wagon_red.webp",
 "wagon|blue":"assets/vehicles/wagon_blue.webp",
 "wagon|brown":"assets/vehicles/wagon_brown.webp",
 "wagon|beige":"assets/vehicles/wagon_beige.webp",
 "compact-minivan|white":"assets/heroes/compact-minivan_white.webp",
 "compact-minivan|black":"assets/vehicles/compact-minivan_black.webp",
 "compact-minivan|silver":"assets/vehicles/compact-minivan_silver.webp",
 "compact-minivan|gray":"assets/vehicles/compact-minivan_gray.webp",
 "compact-minivan|red":"assets/vehicles/compact-minivan_red.webp",
 "compact-minivan|blue":"assets/vehicles/compact-minivan_blue.webp",
 "compact-minivan|brown":"assets/vehicles/compact-minivan_brown.webp",
 "compact-minivan|beige":"assets/vehicles/compact-minivan_beige.webp",
 "minivan|white":"assets/vehicles/minivan_white.webp",
 "minivan|black":"assets/vehicles/minivan_black.webp",
 "minivan|silver":"assets/vehicles/minivan_silver.webp",
 "minivan|gray":"assets/vehicles/minivan_gray.webp",
 "minivan|red":"assets/vehicles/minivan_red.webp",
 "minivan|blue":"assets/vehicles/minivan_blue.webp",
 "minivan|brown":"assets/vehicles/minivan_brown.webp",
 "minivan|beige":"assets/vehicles/minivan_beige.webp",
 "suv|white":"assets/vehicles/suv_white.webp",
 "suv|black":"assets/vehicles/suv_black.webp",
 "suv|silver":"assets/vehicles/suv_silver.webp",
 "suv|gray":"assets/vehicles/suv_gray.webp",
 "suv|red":"assets/vehicles/suv_red.webp",
 "suv|blue":"assets/vehicles/suv_blue.webp",
 "suv|brown":"assets/vehicles/suv_brown.webp",
 "suv|beige":"assets/vehicles/suv_beige.webp",
 "coupe|white":"assets/vehicles/coupe_white.webp",
 "coupe|black":"assets/vehicles/coupe_black.webp",
 "coupe|silver":"assets/vehicles/coupe_silver.webp",
 "coupe|gray":"assets/vehicles/coupe_gray.webp",
 "coupe|red":"assets/vehicles/coupe_red.webp",
 "coupe|blue":"assets/vehicles/coupe_blue.webp",
 "coupe|brown":"assets/vehicles/coupe_brown.webp",
 "coupe|beige":"assets/vehicles/coupe_beige.webp",
 "van|white":"assets/vehicles/van_white.webp",
 "van|black":"assets/vehicles/van_black.webp",
 "van|silver":"assets/vehicles/van_silver.webp",
 "van|gray":"assets/vehicles/van_gray.webp",
 "van|red":"assets/vehicles/van_red.webp",
 "van|blue":"assets/vehicles/van_blue.webp",
 "van|brown":"assets/vehicles/van_brown.webp",
 "van|beige":"assets/vehicles/van_beige.webp"
};
function vehicleAssetPath(bodyType,color){
 return PHOTO_VEHICLE_ASSETS[`${bodyType||"compact-minivan"}|${color||"white"}`]||"";
}
function vehicleImageMarkup(bodyType,color,cls=""){
 const p=vehicleAssetPath(bodyType,color);
 return p?`<img class="photo-car ${cls}" src="${p}" alt="">`:carSvg(color,bodyType);
}


function syncHeroMileage(){
 const el=document.getElementById("heroMileageInline");
 if(el) el.textContent=nf(currentKm())+" km";
}

function syncApprovedHero(){
 const km=nf(currentKm())+" km";
 const a=document.getElementById("homeKm"); if(a)a.textContent=km;
 const b=document.getElementById("refTotalKm"); if(b)b.textContent=km;
}

function monthCostFor(y,m){return costs(y,m)}
function diffText(cur,prev){
 const d=cur-prev;if(!prev&&!cur)return "";
 const sign=d>0?"+":"";return `前月比 ${sign}${nf(d)} 円`;
}
function renderCorrectDashboard(c){
 const d=new Date(),y=d.getFullYear(),m=d.getMonth()+1;
 const cur=monthCostFor(y,m);
 const pd=new Date(y,m-2,1),prev=monthCostFor(pd.getFullYear(),pd.getMonth()+1);
 const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v};
 set("dashFuel",nf(cur.fuel)+" 円"); set("dashMaint",nf(cur.maint)+" 円"); set("dashOther",nf(cur.other)+" 円"); set("dashTotal",nf(cur.total)+" 円");
 [["dashFuelDiff",cur.fuel,prev.fuel],["dashMaintDiff",cur.maint,prev.maint],["dashOtherDiff",cur.other,prev.other],["dashTotalDiff",cur.total,prev.total]].forEach(([id,a,b])=>{
   const e=document.getElementById(id);if(e){e.textContent=diffText(a,b);e.className=a>b?"up":a<b?"down":""}
 });
 set("dashDonutTotal",nf(cur.total)+" 円");set("dashFuelLegend",nf(cur.fuel)+" 円");set("dashMaintLegend",nf(cur.maint)+" 円");set("dashOtherLegend",nf(cur.other)+" 円");
 const total=Math.max(1,cur.total),pf=cur.fuel/total*100,pm=cur.maint/total*100;
 const donut=document.getElementById("dashDonut");if(donut)donut.style.background=`conic-gradient(#57a9ee 0 ${pf}%,#ff9a2f ${pf}% ${pf+pm}%,#68b95b ${pf+pm}% 100%)`;
 const months=Array.from({length:12},(_,i)=>monthCostFor(y,i+1)),max=Math.max(1,...months.map(x=>x.total));
 const bars=document.getElementById("dashMonthBars");
 if(bars)bars.innerHTML=months.map((x,i)=>{
   const fh=x.fuel/max*100,mh=x.maint/max*100,oh=x.other/max*100;
   return `<div class="dm"><div class="dm-stack"><i class="o" style="height:${oh}%"></i><i class="m" style="height:${mh}%"></i><i class="f" style="height:${fh}%"></i></div><small>${i+1}</small></div>`
 }).join("");
 set("dashMaker",c.maker||"---");set("dashCarName",c.name||"---");set("dashModel",c.model||"---");set("dashColor",COLOR_LABELS[c.color]||c.color||"---");
 }


const HERO_SCENE_ASSETS={
 "compact-minivan|white":"assets/heroes/compact-minivan_white.webp"
};
function heroScenePath(c){
 if(!c) return "";
 return HERO_SCENE_ASSETS[`${c.bodyType||"compact-minivan"}|${c.color||"white"}`]||"";
}
function applyHomeHeroScene(c){
 const hero=document.querySelector(".correct-hero");
 const thumb=document.getElementById("homeCarThumb");
 if(!hero||!thumb)return;
 const scene=heroScenePath(c);
 // A user-supplied photo remains the highest priority.
 if(scene && !c.photoId){
   hero.classList.add("full-scene-vehicle");
   hero.style.setProperty("--vehicle-hero",`url("${scene}")`);
   thumb.innerHTML="";
   thumb.setAttribute("aria-hidden","true");
 }else{
   hero.classList.remove("full-scene-vehicle");
   hero.style.removeProperty("--vehicle-hero");
   thumb.removeAttribute("aria-hidden");
 }
}
