const CACHE='pricelog-v091';
const ASSETS=['./','./index.html','./guide.html','./style.css?v=0.91','./config.js?v=0.91','./merge-core.js?v=0.91','./app.js?v=0.91','./cloud.js?v=0.91','./manifest.webmanifest?v=0.91','./icon-192-v058.png','./icon-512-v058.png','./ads.js?v=0.91','./ad-pc.html','./ad-sp.html'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>{e.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()]))});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);
  if(url.origin!==self.location.origin)return;
  e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match(e.request).then(r=>r||(e.request.mode==='navigate'?caches.match('./index.html'):new Response('Offline',{status:503})))))
});
