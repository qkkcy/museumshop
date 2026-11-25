// 오디움 뮤지엄샵 - 푸시 알림 전용 Service Worker
// (캐시는 사용하지 않아요. 앱 업데이트가 바로 반영되도록 하기 위해서예요.)
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));

self.addEventListener('push',event=>{
  let p={};
  try{p=event.data?event.data.json():{};}
  catch(e){try{p={data:{body:event.data.text()}};}catch(_){}}
  const d=p.data||p.notification||p||{};
  const title=d.title||'오디움 뮤지엄샵';
  const options={
    body:d.body||'',
    icon:'./icon-192.png',
    badge:'./icon-192.png',
    tag:d.tag||'reorder',
    renotify:true,
    data:{url:d.url||'./'}
  };
  // iOS는 푸시를 받으면 반드시 알림을 보여줘야 해요.
  event.waitUntil(self.registration.showNotification(title,options));
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const url=new URL((event.notification.data&&event.notification.data.url)||'./',self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
      for(const c of list){
        if(c.url.startsWith(self.registration.scope)&&'focus' in c)return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
