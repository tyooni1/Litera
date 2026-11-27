/* Litera web reader: what only the web edition has — the offline copy (service worker), installing it as an app,
   updates, links to a page, and leaving an in-app browser. The book itself is core.js. */
(function(){
'use strict';
const $=id=>document.getElementById(id);
let CFG={}; try{ CFG=JSON.parse($('cfg').textContent); }catch(_){}
const L=window.LITERA;
const toast=(...a)=>{ if(L) L.toast(...a); };
const ua=navigator.userAgent||'';
const IOS=/iPhone|iPad|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const ANDROID=/Android/i.test(ua);
const INAPP=/KAKAOTALK|Instagram|FBAN|FBAV|NAVER\(inapp|Line\/|DaumApps|everytimeApp|BAND\//i.test(ua);
const standalone=()=>(window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true;
const MB=b=>Math.max(1,Math.round(b/1e6))+'MB';
const store=(k,v)=>{ try{ if(v===undefined) return localStorage.getItem(k); if(v===null) localStorage.removeItem(k); else localStorage.setItem(k,v); }catch(_){ return null; } };

// ---------------- the service worker: keeps the reader and the pages for reading without a connection ----------------
const SW='serviceWorker' in navigator&&window.isSecureContext;
let saved=store('litera-saved')==='1', saving=false, wantReload=false;
function post(msg){ const c=navigator.serviceWorker&&navigator.serviceWorker.controller; if(c){ c.postMessage(msg); return true; } return false; }
if(SW){
  navigator.serviceWorker.register('sw.js',{scope:'./'}).then(reg=>{
    const ready=w=>{ if(w&&navigator.serviceWorker.controller) toast('리테라를 새로 고친 판이 나왔습니다.','새 판으로 보기',()=>{ wantReload=true; w.postMessage({type:'skip'}); },0); };
    if(reg.waiting) ready(reg.waiting);
    reg.addEventListener('updatefound',()=>{ const w=reg.installing; if(w) w.addEventListener('statechange',()=>{ if(w.state==='installed') ready(w); }); });
    setInterval(()=>reg.update().catch(()=>{}),3600e3);
  }).catch(e=>{ try{ console.warn('[Litera] service worker',e); }catch(_){} });
  navigator.serviceWorker.addEventListener('controllerchange',()=>{ if(wantReload){ wantReload=false; location.reload(); } });
  navigator.serviceWorker.addEventListener('message',e=>{
    const d=e.data||{};
    if(d.type==='progress'){ saving=true; toast('이 기기에 책을 저장하는 중입니다 ('+Math.floor(100*d.done/d.total)+'%)','',null,0); }
    else if(d.type==='saved'){ saving=false; saved=true; store('litera-saved','1');
      toast(d.failed?'일부 쪽('+d.failed+'쪽)을 저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 저장해 주세요.':'저장했습니다. 이제 인터넷 없이도 이 기기에서 읽을 수 있습니다.'); }
    else if(d.type==='cleared'){ saved=false; store('litera-saved',null); toast('저장한 책을 지웠습니다.'); }
    else if(d.type==='status'){ saved=d.have>=d.total; store('litera-saved',saved?'1':null); }
  });
  navigator.serviceWorker.ready.then(()=>post({type:'status'})).catch(()=>{});
}
function save(){
  if(!SW){ toast('이 브라우저에서는 저장할 수 없습니다. Chrome이나 Safari에서 열어 주세요.'); return; }
  if(!navigator.onLine){ toast('인터넷에 연결된 상태에서 저장할 수 있습니다.'); return; }
  if(navigator.storage&&navigator.storage.persist) navigator.storage.persist().catch(()=>{});
  const go=()=>{ if(!post({type:'save'})) toast('잠시 뒤에 다시 눌러 주세요.'); else toast('이 기기에 책을 저장하는 중입니다 (0%)','',null,0); };
  if(navigator.serviceWorker.controller) go(); else navigator.serviceWorker.ready.then(()=>setTimeout(go,300));
}

// ---------------- installing as an app ----------------
let deferred=null;
addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); deferred=e; });
addEventListener('appinstalled',()=>{ deferred=null; toast('홈 화면에 리테라를 추가했습니다.'); });
function install(){
  if(deferred){ const d=deferred; deferred=null; d.prompt(); if(d.userChoice) d.userChoice.catch(()=>{}); return; }
  if(IOS) help(true,'ios'); else help(true,'install');
}

// ---------------- a link to the open page ----------------
function share(){
  const url=location.href.split('#')[0]+(L?L.hashOf(L.spread()):'');
  const data={title:'LITERA No. 1',url};
  if(navigator.share&&(IOS||ANDROID)){ navigator.share(data).catch(()=>{}); return; }
  if(navigator.clipboard&&window.isSecureContext) navigator.clipboard.writeText(url).then(()=>toast('이 쪽으로 오는 링크를 복사했습니다.'),()=>toast(url,'',null,12000));
  else toast(url,'',null,12000);
}

// ---------------- out of an in-app browser ----------------
function outside(){
  const url=location.href;
  if(/KAKAOTALK/i.test(ua)){ location.href='kakaotalk://web/openExternal?url='+encodeURIComponent(url); return; }
  if(/Line\//i.test(ua)){ location.href=url+(url.includes('?')?'&':'?')+'openExternalBrowser=1'; return; }
  if(ANDROID){ const u=new URL(url); location.href='intent://'+u.host+u.pathname+u.search+u.hash+'#Intent;scheme='+u.protocol.replace(':','')+';package=com.android.chrome;end'; return; }
  toast('오른쪽 위나 아래의 ⋯ 메뉴에서 ‘Safari로 열기’(또는 ‘기본 브라우저로 열기’)를 눌러 주세요.','',null,10000);
}

// ---------------- help: installing and saving ----------------
const HELP={
  install:'<h3>앱처럼 쓰기</h3><ul><li>Chrome이나 Edge에서는 주소 표시줄의 설치 단추나 ⋮ 메뉴의 ‘앱 설치’ 또는 ‘홈 화면에 추가’를 누릅니다.</li><li>설치하면 브라우저 창 없이 책만 열립니다.</li></ul>',
  ios:'<h3>아이폰·아이패드에서 홈 화면에 추가하기</h3><ul><li>Safari로 이 페이지를 엽니다. (카카오톡 등 앱 안에서 열었다면 ⋯ 메뉴의 ‘Safari로 열기’)</li><li>아래쪽 가운데의 공유 단추(네모에서 화살표가 나오는 모양)를 누릅니다.</li><li>‘홈 화면에 추가’를 누르고 ‘추가’를 누릅니다.</li></ul>',
  save:'<h3>인터넷 없이 읽기</h3><ul><li>⋯ 메뉴의 ‘이 기기에 저장’을 누르면 책 전체(약 '+MB(CFG.saveBytes||0)+')를 이 기기에 저장합니다. 그 뒤로는 비행기 모드에서도 열립니다.</li><li>한 번 넘겨 본 쪽은 저장하지 않아도 다시 열 때 인터넷 없이 보입니다.</li><li>확대해서 보는 큰 그림은 인터넷에 연결되어 있을 때만 받아 옵니다.</li><li>저장한 책은 ⋯ 메뉴의 ‘저장한 책 지우기’로 지웁니다.</li></ul>'
};
function help(open,which){
  const x=$('helpx'); if(x){ x.innerHTML=(which==='ios'?HELP.ios+HELP.install:HELP.install+HELP.ios)+HELP.save; }
  $('help').classList.toggle('open',open);
  if(open){ const b=$('help').querySelector('.x'); if(b) b.focus();
    if(which){ const h=[...x.querySelectorAll('h3')].find(h=>which==='ios'?/아이폰/.test(h.textContent):/앱처럼/.test(h.textContent)); if(h) h.scrollIntoView({block:'start'}); } }
}
const hx=$('helpx'); if(hx) hx.innerHTML=HELP.install+HELP.ios+HELP.save;

// ---------------- menu ----------------
if(L){
  if(INAPP) L.menuAdd({label:'다른 브라우저로 열기',sub:'Chrome이나 Safari에서 더 부드럽게 넘어갑니다',fn:outside});
  L.menuAdd({label:'이 쪽 링크 보내기',sub:'받은 사람은 이 쪽부터 봅니다',fn:share});
  L.menuAdd({label:()=>saved?'이 기기에 저장됨':'이 기기에 저장',sub:()=>saved?'인터넷 없이도 열립니다 · 다시 누르면 새로 받습니다':'인터넷 없이 읽기 · 약 '+MB(CFG.saveBytes||0),show:()=>SW&&!saving,fn:save});
  L.menuAdd({label:'저장한 책 지우기',show:()=>SW&&saved&&!saving,fn:()=>post({type:'clear'})});
  L.menuAdd({label:'홈 화면에 추가',sub:'앱처럼 바로 열기',show:()=>!standalone()&&!INAPP&&(!!deferred||IOS||ANDROID||SW),fn:install});
  L.onReady(()=>{ if(!navigator.onLine&&!saved) toast('인터넷에 연결되어 있지 않습니다. 넘겨 본 적 없는 쪽은 열리지 않을 수 있습니다.'); });
}
addEventListener('offline',()=>{ if(!saved) toast('인터넷 연결이 끊겼습니다. 넘겨 본 적 없는 쪽은 열리지 않을 수 있습니다.'); });
})();
