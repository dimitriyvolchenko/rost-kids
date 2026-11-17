/* Increment BUILD whenever app files change. program.json updates independently. */
const BUILD='rost-v1.1.0';
const PREFIX='rost-shell-'+encodeURIComponent(new URL(self.registration.scope).pathname)+'-';
const CACHE=PREFIX+BUILD;
const CORE=['./','index.html','styles.css','app.js','program.json','manifest.webmanifest','icon-192.png','icon-512.png','icon.svg','install.html'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE))));
// Intentionally no automatic skipWaiting: an open session keeps its current app version.
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const k of await caches.keys())if(k.startsWith(PREFIX)&&k!==CACHE)await caches.delete(k);await self.clients.claim();})()));
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting();});
self.addEventListener('fetch',event=>{
 const req=event.request,url=new URL(req.url),base=new URL(self.registration.scope);
 if(req.method!=='GET'||url.origin!==base.origin||!url.pathname.startsWith(base.pathname))return;
 // The application validates JSON and retains the last valid program in localStorage.
 // Cache only the installed baseline; a bad network program must never overwrite it.
 if(url.pathname===new URL('program.json',base).pathname){event.respondWith(fetch(req).catch(async()=>{const r=await caches.open(CACHE).then(c=>c.match(new URL('program.json',base).href));if(!r)return Response.error();const headers=new Headers(r.headers);headers.set('X-Rost-Offline','1');return new Response(await r.arrayBuffer(),{status:200,headers});}));return;}
 if(req.mode==='navigate'){event.respondWith(caches.open(CACHE).then(async c=>(await c.match(req,{ignoreSearch:true}))||(url.pathname===base.pathname+'index.html'||url.pathname===base.pathname?await c.match(new URL('index.html',base).href):null)||fetch(req)));return;}
 event.respondWith(caches.open(CACHE).then(c=>c.match(req,{ignoreSearch:true})).then(hit=>hit||fetch(req)));
});
