const C='ayh-v40',A=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
// Mise en cache tolérante : un fichier absent n'empêche plus l'installation du service worker.
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>Promise.all(A.map(u=>c.add(u).catch(()=>{})))))});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!=C).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET')return;
// bibliothèques PDF (cdnjs) : gardées en cache après le premier chargement pour l'export hors connexion
if(u.hostname==='cdnjs.cloudflare.com'){e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(x=>{const c=x.clone();caches.open(C).then(k=>k.put(e.request,c));return x})));return}
if(u.origin!==location.origin)return;
e.respondWith(fetch(e.request).then(r=>{if(r&&r.ok){const c=r.clone();caches.open(C).then(x=>x.put(e.request,c))}return r}).catch(()=>caches.match(e.request).then(r=>r||(e.request.mode==='navigate'?caches.match('./index.html').then(x=>x||caches.match('./')):undefined))))});
