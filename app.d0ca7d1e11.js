/* Litera reader core.
   One viewer for both readers: the one-file flipbook the editors pass around (every page inside the file, CFG.mode 'embed')
   and the web reader for everyone (pages as separate files in two sizes, CFG.mode 'web').
   Layers: Assets (getting page pictures ready and letting them go) / Book (the 8-strip leaves, unchanged) /
   Navigation (turning, jumps, the address) / View (tilt, zoom, pan) / Input (pointer, keys) / Reading view / Boot. */
(function(){
'use strict';
const $=id=>document.getElementById(id);
const MSG={E1:'책 정보를 읽지 못했습니다',E2:'책을 펼치지 못했습니다',E3:'첫 쪽을 불러오지 못했습니다'};
function fail(code,err){                    // the loading screen says what went wrong (with a code to report) instead of turning forever
  try{ console.error('[Litera '+code+']',err); }catch(_){}
  const l=$('load'); if(!l) return;
  l.style.opacity='1'; l.classList.add('err');
  l.querySelector('.m').textContent=MSG[code]+' ('+code+'). 새로 고침하거나 다른 브라우저로 열어 주세요.'+(err&&err.message?' — '+err.message:'');
}
const rl=$('reload'); if(rl) rl.onclick=()=>location.reload();
let CFG=null;
try{ CFG=window.LITERA_CFG||JSON.parse($('cfg').textContent); }catch(e){ fail('E1',e); return; }
const WEB=CFG.mode==='web';
try{

const N=CFG.N, NC=4, NS=NC+8, BLANK=new Set(CFG.blank), PAGES=CFG.pages||232;
const RM=!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
const stage=$('stage'), scene=$('scene'), book=$('book');
let W=0,H=0,D=0,T=0,SWS=[],SXS=[];   // strip widths and positions: four narrow strips at the spine (the curve into the binding), eight for the rest
let s=0;                 // leaves turned to the left (the spread in view)
let fl=null;             // the leaf in motion: {i, dir, p, to}
let busy=false, raf=0;
let want=null;           // the spread asked for while a leaf was turning (only the last request is kept)
let view3d=true, autoView=true, rx=38, rz=-12, zoom=1, panX=0, panY=0;
const leaves=new Map();
function visibleFaces(){ const v=[]; for(const [i] of leaves) v.push(2*i,2*i+1); return v; }

// ===================================================== Assets =====================================================
// embed: each page is base64 text in the file. A page in or near view gets a blob URL (decoded once); pages that fall
//        far behind give their URL back and are made again from the same text if the reader returns.
// web:   each page is a file, in a small and a large size; the size follows how big the page is on screen (zoom included).
//        The browser (and the offline copy) keeps the files; only the decoding work is tracked here.
function EmbedAssets(){
  const url=new Map(), size=new Map(), dec=new Map(), bad=new Set(), tries=new Map();
  const ALWAYS=new Set([0,2*N-1]); const CAP=48e6; let bytes=0;
  function get(f){
    if(BLANK.has(f)||bad.has(f)) return null;
    if(url.has(f)){ const u=url.get(f); url.delete(f); url.set(f,u); return u; }
    const el=document.getElementById('f'+f); if(!el){ bad.add(f); return null; }
    try{
      const b=atob(el.textContent.trim()), a=new Uint8Array(b.length);
      for(let i=0;i<b.length;i++) a[i]=b.charCodeAt(i);
      const u=URL.createObjectURL(new Blob([a],{type:'image/webp'}));
      url.set(f,u); size.set(f,a.length); bytes+=a.length; return u;
    }catch(e){ bad.add(f); try{ console.warn('[Litera] page image could not be read',f,e); }catch(_){} return null; }
  }
  function warm(f){                          // decode once; a second request for the same page waits on the first
    if(BLANK.has(f)||bad.has(f)) return Promise.resolve(false);
    if(dec.has(f)) return dec.get(f);
    const u=get(f); if(!u) return Promise.resolve(false);
    const p=decodeURL(u).then(()=>true,e=>{
      dec.delete(f); const n=(tries.get(f)||0)+1; tries.set(f,n);
      if(n>=2) bad.add(f); drop(f); refresh(f);
      try{ console.warn('[Litera] page image could not be decoded',f,e); }catch(_){} return false; });
    dec.set(f,p); return p;
  }
  function drop(f){ const u=url.get(f); if(u){ URL.revokeObjectURL(u); url.delete(f); bytes-=size.get(f)||0; size.delete(f); } dec.delete(f); }
  function trim(keep){
    for(const f of [...url.keys()]) if(!keep.has(f)&&!ALWAYS.has(f)) drop(f);
    if(bytes>CAP){ const shown=new Set(visibleFaces()); for(const f of [...url.keys()]){ if(bytes<=CAP) break; if(!shown.has(f)&&!ALWAYS.has(f)) drop(f); } }
  }
  return {get,warm,trim,bad,retune(){},size:()=>url.size,bytes:()=>bytes,tier:()=>0};
}
function WebAssets(){
  const TI=CFG.tiers, dec=new Map(), bad=new Set(), tries=new Map(); let tier=-1, pend=-1;
  function want_(){ const need=(H||fitH())*(window.devicePixelRatio||1)*zoom; for(let k=0;k<TI.length;k++) if(TI[k].h>=need*0.85) return k; return TI.length-1; }
  function url(f,t){ const n=TI[t].files[f]; return n?TI[t].dir+n:null; }
  function cur(){ if(tier<0) tier=want_(); return tier; }   // the first pages already come in the size the screen needs
  function get(f){ return (BLANK.has(f)||bad.has(f))?null:url(f,cur()); }
  function warm(f,t){
    t=t===undefined?cur():t; if(BLANK.has(f)||bad.has(f)) return Promise.resolve(false);
    const k=t+':'+f; if(dec.has(k)) return dec.get(k);
    const u=url(f,t); if(!u) return Promise.resolve(false);
    const p=decodeURL(u).then(()=>{ tries.delete(k); return true; },e=>{
      dec.delete(k); const n=(tries.get(k)||0)+1; tries.set(k,n);
      if(t===tier){ if(n>=2){ bad.add(f); refresh(f); if(!navigator.onLine) offlineNote(); } else return new Promise(r=>setTimeout(r,1200)).then(()=>warm(f,t)); }
      try{ console.warn('[Litera] page image could not be loaded',u,e); }catch(_){} return false; });
    dec.set(k,p); return p;
  }
  function trim(keep){ for(const k of [...dec.keys()]) if(!keep.has(+k.split(':')[1])) dec.delete(k); }
  function retune(){                         // a larger page on screen (zoom, a bigger window) gets the larger files once they are ready;
    const t=want_(); if(t===tier||t===pend) return; pend=t; const fs=visibleFaces().filter(f=>!BLANK.has(f));   // offline without them, it stays as it is
    Promise.all(fs.map(f=>warm(f,t))).then(r=>{ if(pend!==t) return; pend=-1;
      if(t<tier||r.every(Boolean)){ tier=t; fs.forEach(refresh); prefetch(); } });
  }
  addEventListener('online',()=>{ bad.clear(); tries.clear(); dec.clear(); visibleFaces().forEach(refresh); prefetch(); retune(); });
  return {get,warm,trim,bad,retune,size:()=>dec.size,bytes:()=>0,tier:cur};
}
function decodeURL(u){ const im=new Image(); im.decoding='async'; im.src=u;
  return im.decode?im.decode():new Promise((ok,no)=>{ im.onload=ok; im.onerror=no; }); }
const Assets=WEB?WebAssets():EmbedAssets();
function texURL(k){ return WEB?'url('+CFG.tex[k]+')':'url(data:'+(k==='spine'||k==='spineM'?'image/webp':'image/png')+';base64,'+window.LITERA_TEX[k]+')'; }
function refresh(f){                       // a page that could not be shown gets its stand-in (or its picture back)
  for(const [,L] of leaves) for(const S of L.st) for(const d of [S.f,S.b]) if(d._f===f) paint(d);
}
let offT=0;
function offlineNote(){ clearTimeout(offT); offT=setTimeout(()=>toast('인터넷에 연결되어 있지 않아 일부 쪽을 불러오지 못했습니다. 연결되면 다시 불러옵니다.'),300); }

// ===================================================== Book =====================================================
function fitH(){                          // small screens keep less room around the book (no fixed smallest size: it never runs off)
  const bw=stage.clientWidth, bh=stage.clientHeight, mv=bh<520?16:64, mh=bw<640?12:48;
  return Math.max(40,Math.floor(Math.min(bh-mv,(bw-mh)/2*CFG.PH/CFG.PW)));
}
function layout(){
  H=fitH();
  W=H*CFG.PW/CFG.PH; D=H*CFG.SPINE/CFG.PH/N; T=N*D; book.style.setProperty('--gw',(W*0.13)+'px');
  const c=W*0.12; SWS=[0.16,0.21,0.28,0.35].map(f=>c*f); for(let k=NC;k<NS;k++) SWS.push((W-c)/(NS-NC));
  SXS=[]; let x=0; for(const w of SWS){ SXS.push(x); x+=w; }
  curves.clear();
  for(const [,L] of leaves){ L.el.remove(); } leaves.clear();
  const fore=texURL('fore');
  Object.assign($('foreR').style,{top:-H/2+'px',height:H+'px',left:W+'px',transformOrigin:'0 50%',transform:'rotateY(-90deg)',backgroundImage:fore,backgroundSize:(N*D)+'px '+H+'px'});
  Object.assign($('foreL').style,{top:-H/2+'px',height:H+'px',transformOrigin:'100% 50%',transform:'rotateY(90deg)',backgroundImage:fore,backgroundSize:(N*D)+'px '+H+'px'});
  for(const [id,tex,x,org,rot] of [['headR','headR',0,'50% 0','rotateX(90deg)'],['headL','headL',-W,'50% 0','rotateX(90deg)'],
                                   ['tailR','tailR',0,'50% 100%','rotateX(-90deg)'],['tailL','tailL',-W,'50% 100%','rotateX(-90deg)']])
    Object.assign($(id).style,{left:x+'px',width:W+'px',transformOrigin:org,transform:rot,backgroundImage:texURL(tex),backgroundSize:W+'px '+(N*D)+'px'});
  Object.assign($('spine').style,{left:'0px',top:-H/2+'px',width:T+'px',height:H+'px',transformOrigin:'0 50%',transform:'rotateY(-90deg)',backgroundSize:T+'px '+H+'px'});
  Object.assign($('shL').style,{left:-W+'px',top:-H/2+'px',width:W+'px',height:H+'px'});
  Object.assign($('shR').style,{left:'0px',top:-H/2+'px',width:W+'px',height:H+'px'});
  render(); setScene(false); Assets.retune();
}
// one leaf = 12 vertical strips, each hinged on the one before it: the leaf bends while it turns, and, when the open book
// is seen at an angle, its first four strips curve down into the binding, the way a bound book lies open
function paint(d){
  const f=d._f; d.querySelectorAll('u').forEach(x=>x.remove());
  if(BLANK.has(f)){ d.style.background=CFG.paper; return; }
  d.style.backgroundColor=CFG.paper; d.style.backgroundSize=W+'px '+H+'px';
  const u=Assets.bad.has(f)?null:Assets.get(f);
  d.style.backgroundImage=u?'url("'+u+'")':'none';
  if(!u&&d._k===0){                          // a page that could not be read: say so on the page, not with a broken picture
    const m=document.createElement('u'); const pn=facePage(f);
    m.style.width=W+'px'; m.textContent=(pn?pn+'쪽을':'이 쪽을')+' 불러오지 못했습니다';
    if(d._back&&d.parentNode&&d.style.width!==W+'px') m.style.left=-(W-SWS[0])+'px';
    d.appendChild(m);
  }
}
function makeFace(f,k,back){
  const d=document.createElement('div'); d.className='face '+(back?'b':'f');
  d.style.width=(SWS[k]+OV)+'px'; d._k=k; d._back=back; d._f=f;
  if(k===0&&!(f===0||f===2*N-1)) d.classList.add('gut');
  d._bp=(back? -(W-SXS[k]-SWS[k]) : -SXS[k])+'px 0'; d.style.backgroundPosition=d._bp;
  paint(d);
  const sh=document.createElement('i'); d.appendChild(sh); d._sh=sh; return d;
}
function makeLeaf(i){
  const el=document.createElement('div'); el.className='leaf';
  el.style.width=W+'px'; el.style.height=H+'px'; el.style.top=(-H/2)+'px';
  let parent=el; const st=[];
  for(let k=0;k<NS;k++){
    const s_=document.createElement('div'); s_.className='strip'; s_.style.width=SWS[k]+'px'; s_.style.height=H+'px'; s_.style.left=(k?SWS[k-1]:0)+'px';
    const f=makeFace(2*i,k,false), b=makeFace(2*i+1,k,true); s_.append(f,b); parent.appendChild(s_); parent=s_; st.push({el:s_,f,b});
  }
  // the shadow of a turning leaf on the page under it: on the whole page when the page lies flat, on its flat part when it curves
  const cast=(host,w)=>{ const f=document.createElement('div'), b=document.createElement('div'); f.className='cast f'; b.className='cast b';
    for(const c of [f,b]){ c.style.width=w+'px'; c.style.height=H+'px'; } host.append(f,b); return [f,b]; };
  const [cf,cb]=cast(st[0].el,W), [cf2,cb2]=cast(st[NC].el,W-SXS[NC]);
  const L={i,el,st,cf,cb,cf2,cb2,live:true}; setMode(L,false); return L;
}
function setMode(L,live){                 // resting flat leaves are one piece (no seams); a turning or curving leaf is twelve strips
  if(L.live===live) return; L.live=live; L.el.style.willChange=live?'transform':'';   // a layer of its own only while it moves
  L.st.forEach((S,k)=>{
    if(k===0){ for(const f of [S.f,S.b]){ f.style.width=(live?SWS[0]+OV:W)+'px'; f.style.backgroundPosition=live?f._bp:'0 0';
      const m=f.querySelector('u'); if(m) m.style.left=(f._back&&live)?-(W-SWS[0])+'px':'0'; } }
    else { S.f.style.display=S.b.style.display=live?'':'none'; }
  });
}
// the curve into the binding: strip j of the first four rises at Φ·CA[j]; Φ is found so that the curve climbs exactly `rise`
const CA=[1,0.78,0.5,0.2], curves=new Map(), OV=2;   // OV: each strip reaches 2px under the next, so no hairline shows between them
function curve(rise){
  if(!(rise>0.05)) return null;
  const key=Math.round(rise*8); if(curves.has(key)) return curves.get(key);
  const R=key/8, up=P=>{ let y=0; for(let j=0;j<NC;j++) y+=SWS[j]*Math.sin(P*CA[j]); return y; };
  let lo=0, hi=Math.PI/2*0.97;
  if(up(hi)<=R) lo=hi; else for(let it=0;it<24;it++){ const m=(lo+hi)/2; if(up(m)<R) lo=m; else hi=m; }
  const ph=[], pts=[]; let x=0, y=0;
  for(let j=0;j<NC;j++){ const a=lo*CA[j]; ph.push(a*180/Math.PI); x+=SWS[j]*Math.cos(a); y+=SWS[j]*Math.sin(a); pts.push([x,y]); }
  const c={ph,pts,dx:SXS[NC]-x,rise:y}; if(curves.size>400) curves.clear(); curves.set(key,c); return c;
}
function opened(){                         // 0 closed … 1 open; the curve shows only when the book is seen at an angle
  if(!view3d) return 0;
  if(fl&&fl.i===0) return fl.p; if(fl&&fl.i===N-1) return 1-fl.p;
  return (s>0&&s<N)?1:0;
}
const smooth=t=>{ t=Math.max(0,Math.min(1,t)); return t*t*(3-2*t); };
const OCC=[0.16,0.085,0.04,0.012,0];      // the shade deep in the gutter, at the strip edges from the spine out
function shade(el,a,b){                    // a strip is shaded with a gradient between its two edges, so the curve shows no bands
  const v=(a<0.004&&b<0.004)?'':'linear-gradient(to right,rgba(0,0,0,'+a.toFixed(3)+'),rgba(0,0,0,'+b.toFixed(3)+'))';
  if(el._v!==v){ el._v=v; el.style.background=v||'transparent'; el.style.opacity=v?'1':'0'; }
}
const TH=new Float64Array(16), FD=new Float64Array(17), BD=new Float64Array(17);
function pose(L,p,dir,turning){
  const i=L.i, cover=(i===0||i===N-1), O=opened(), zb=D;
  const hR=(N-i)*D, hL=(i+1)*D, bound=O>0&&!cover;
  const live=turning||bound; setMode(L,live); L.el.classList.toggle('bd',bound);
  const wR=turning?1-smooth(p/0.3):(p<0.5?1:0), wL=turning?smooth((p-0.7)/0.3):(p<0.5?0:1);
  const cR=bound?curve(O*(hR-zb)*wR):null, cL=bound?curve(O*(hL-zb)*wL):null;
  let z;
  if(!bound) z=hR+(hL-hR)*p+(turning?Math.sin(Math.PI*p)*H*0.015:0);
  else if(turning) z=zb+(1-O)*(hR+(hL-hR)*p-zb);
  else z=p<0.5?hR-(cR?cR.rise:0):hL-(cL?cL.rise:0);
  L.el.style.transform='translateZ('+z.toFixed(2)+'px)';
  const stiff=cover?0.25:1;
  const B=turning?46*stiff*Math.sin(Math.PI*p):0;
  let prev=0;
  for(let k=0;k<NS;k++){
    let th=180*p+dir*B*((SXS[k]+SWS[k]/2)/W-0.5);
    if(k<NC){ if(cR) th+=cR.ph[k]; if(cL) th-=cL.ph[k]; }
    th=Math.max(0,Math.min(180,th)); TH[k]=th;
    L.st[k].el.style.transform='rotateY('+(-(th-prev)).toFixed(3)+'deg)'; prev=th;
  }
  if(!live){ for(const S of L.st){ shade(S.f._sh,0,0); shade(S.b._sh,0,0); } return; }
  for(let e=0;e<=NS;e++){                  // darkness at each strip edge: from the angle of the paper, and from the gutter
    const th=e===0?TH[0]:e===NS?TH[NS-1]:(TH[e-1]+TH[e])/2, c=Math.cos(th*Math.PI/180), g=bound&&e<=NC?OCC[e]*O:0;
    FD[e]=th<90?0.36*(1-c)+g*wR:0; BD[e]=th>90?0.30*(1+c)+g*wL:0;
  }
  for(let k=0;k<NS;k++){ const S=L.st[k]; shade(S.f._sh,FD[k],FD[k+1]); shade(S.b._sh,BD[k+1],BD[k]); }
}
function visible(){
  const v=new Set([0,N-1]); for(const i of [s-2,s-1,s,s+1]) if(i>=0&&i<N) v.add(i);
  if(fl){ for(const i of [fl.i-1,fl.i,fl.i+1]) if(i>=0&&i<N) v.add(i); }
  return v;
}
function render(){                         // the 3D book only; the page label, slider and contents are updated when a spread is settled
  const v=visible(), O=opened();
  for(const [i,L] of leaves) if(!v.has(i)){ L.el.remove(); leaves.delete(i); }
  for(const i of v){
    let L=leaves.get(i); if(!L){ L=makeLeaf(i); leaves.set(i,L); book.appendChild(L.el); }
    if(fl&&fl.i===i) pose(L,fl.p,fl.dir,true); else pose(L,i<s?1:0,1,false);
    // curved leaves under the top ones would meet them at the binding: at rest only the top leaves (and the covers) are drawn
    L.el.style.visibility=(O>0&&!fl&&i!==s-1&&i!==s&&i!==0&&i!==N-1)?'hidden':'';
    L.cf.style.opacity=L.cb.style.opacity=L.cf2.style.opacity=L.cb2.style.opacity='0';
  }
  if(fl){ const a=Math.sin(Math.PI*fl.p)*0.5, R=leaves.get(fl.i+1), Lf=leaves.get(fl.i-1);
    if(R) (R.live&&O>0?R.cf2:R.cf).style.opacity=(a*(1-fl.p)*1.4).toFixed(3);
    if(Lf) (Lf.live&&O>0?Lf.cb2:Lf.cb).style.opacity=(a*fl.p*1.4).toFixed(3); }
  edges(O); shift();
}
// the page block seen from the side: at the head and tail it narrows into the binding along the same curve as the top leaf,
// and its fore-edge leans in a little (a curved leaf reaches less far)
function edges(O){
  const rc=N-(fl?fl.i+1:s), lc=fl?fl.i:s;
  const cvR=O>0&&rc>1?curve(O*(rc-1)*D):null, cvL=O>0&&lc>1?curve(O*(lc-1)*D):null;
  const fr=$('foreR'), fL=$('foreL');
  fr.style.display=rc>0?'block':'none'; fr.style.width=(rc*D)+'px'; fr.style.backgroundPosition='0 0';
  fr.style.transform='rotateY('+(-90-(cvR?Math.asin(Math.min(1,cvR.dx/(rc*D)))*180/Math.PI:0)).toFixed(3)+'deg)';
  fL.style.display=lc>0?'block':'none'; fL.style.width=(lc*D)+'px'; fL.style.left=(-W-lc*D)+'px'; fL.style.backgroundPosition=((lc-N)*D)+'px 0';
  fL.style.transform='rotateY('+(90+(cvL?Math.asin(Math.min(1,cvL.dx/(lc*D)))*180/Math.PI:0)).toFixed(3)+'deg)';
  for(const [id,c,top,cv,left] of [['headR',rc,true,cvR,false],['tailR',rc,false,cvR,false],['headL',lc,true,cvL,true],['tailL',lc,false,cvL,true]]){
    const e=$(id), hgt=c*D; e.style.display=c>0?'block':'none'; e.style.height=hgt+'px';
    e.style.top=top?(-H/2)+'px':(H/2-hgt)+'px';
    e.style.backgroundPosition='0 '+(top?0:-(N-c)*D)+'px';
    if(!cv){ e.style.clipPath='none'; continue; }
    const base=hgt-cv.rise, P=[[0,0],[0,base]].concat(cv.pts.map(([x,y])=>[x,base+y]),[[W-cv.dx,hgt],[W,0]]);
    e.style.clipPath='polygon('+P.map(([x,z])=>(left?W-x:x).toFixed(2)+'px '+(top?z:hgt-z).toFixed(2)+'px').join(',')+')';
  }
  const sp=$('spine'); const closed=!fl&&(s===0||s===N);
  sp.style.display=closed?'block':'none';
  if(closed){ const k=s===0?'spine':'spineM'; if(sp._k!==k){ sp._k=k; sp.style.backgroundImage=texURL(k); } }
  const shO=(c,cov)=>c>0?1:(fl&&fl.i===cov?smooth(((cov===0?fl.p:1-fl.p)-0.55)/0.45):0);   // no shadow where no pages lie yet
  for(const [id,o] of [['shL',shO(lc,0)],['shR',shO(rc,N-1)]]){ const e=$(id); e.style.display=o>0?'block':'none'; e.style.opacity=o.toFixed(3); }
}
function tx(){
  if(fl&&fl.i===0) return -W/2*(1-fl.p);
  if(fl&&fl.i===N-1) return W/2*fl.p;
  return s===0?-W/2:(s===N?W/2:0);
}
function shift(){ book.style.transform='translateX('+tx().toFixed(2)+'px)'; }

// ===================================================== pages, label, contents =====================================================
const seek=$('seek'); seek.max=N;
function facePage(f){ return (f>=2&&f<=2*N-3)?f-1:null; }
function sOfPage(n){ const f=n+1; return (f%2)?(f>>1)+1:(f>>1); }
function spreadText(t){
  if(t===0) return '앞표지'; if(t===N) return '뒤표지';
  const a=facePage(2*t-1), b=facePage(2*t); return (a&&b?a+' – '+b:(a||b)+'')+' / '+PAGES;
}
let seeking=false, shownS=-1;
function updateUI(){                       // once per settled spread (not every frame of a turn)
  if(shownS===s) return; shownS=s;
  const t=spreadText(s);
  $('pg').textContent=t; if(!seeking) seek.value=s; seek.setAttribute('aria-valuetext',t);
  $('bprev').disabled=$('bfirst').disabled=s===0; $('bnext').disabled=$('blast').disabled=s===N;
  const cur=document.querySelector('#tocl a.cur'); if(cur){ cur.classList.remove('cur'); cur.removeAttribute('aria-current'); }
  const now=document.querySelector('#tocl a[data-s="'+s+'"]'); if(now){ now.classList.add('cur'); now.setAttribute('aria-current','page'); }
}
function buildToc(){
  const box=$('tocl');
  for(const [title,who,page,kind,pre] of CFG.toc){
    const a=document.createElement('a'); a.className=kind;
    const sv=kind==='cover'?(page===0?0:N):sOfPage(page); a.dataset.s=sv; a.href=hashOf(sv);
    const t=document.createElement('span'); t.className='t'; t.textContent=title;
    if(pre){ const k=document.createElement('span'); k.className='k'; k.textContent=pre; t.prepend(k); }
    if(who){ const w=document.createElement('span'); w.className='w'; w.textContent=who; t.appendChild(w); }
    const n=document.createElement('span'); n.className='n'; n.textContent=kind==='cover'?'':page;
    a.append(t,n);
    a.onclick=e=>{ e.preventDefault(); jump(sv); if(innerWidth<900) toc(false); };
    box.appendChild(a);
  }
}
function toc(open){ const t=$('toc'); open=open===undefined?!t.classList.contains('open'):open;
  t.classList.toggle('open',open); $('btoc').classList.toggle('on',open); $('btoc').setAttribute('aria-expanded',open?'true':'false'); }

// ===================================================== the address: #p=14 opens on page 14 (#cover, #back) =====================================================
function hashOf(t){ return t===0?'#cover':t===N?'#back':'#p='+(facePage(2*t-1)||facePage(2*t)); }
function fromHash(h){
  h=decodeURIComponent((h||'').replace(/^#/,'')); if(!h) return null;
  if(h==='cover') return 0; if(h==='back') return N;
  const m=/^(?:p=)?(\d{1,3})$/.exec(h); if(!m) return null;
  const n=Math.max(1,Math.min(PAGES,+m[1])); return sOfPage(n);
}
let lastHash='';
function mark(push){                       // a turn of the page replaces the address; a jump (contents, slider, ends) adds one
  const h=hashOf(s); if(h===lastHash) return; lastHash=h;
  try{ (push?history.pushState:history.replaceState).call(history,{s},'',h); }catch(_){ /* some in-app browsers refuse: the book still works */ }
}
function fromAddress(){ const t=fromHash(location.hash); if(t!==null&&location.hash!==lastHash){ lastHash=location.hash; goTo(t); } }
addEventListener('popstate',fromAddress); addEventListener('hashchange',fromAddress);

// ===================================================== turning =====================================================
const ease=u=>u<.5?4*u*u*u:1-Math.pow(-2*u+2,3)/2;
function run(i,dir,p0,p1,dur,done,to){
  cancelAnimationFrame(raf); fl={i,dir,p:p0,to}; const t0=performance.now();
  if(RM) dur=1;
  const step=t=>{ const u=Math.min(1,(t-t0)/dur); fl.p=p0+(p1-p0)*ease(u); render(); if(u<1) raf=requestAnimationFrame(step); else done(); };
  raf=requestAnimationFrame(step);
}
let pushNext=false;
function settle(newS){
  fl=null; busy=false; s=newS; render(); updateUI(); mark(pushNext); pushNext=false; prefetch();
  if(autoView&&view3d&&s>0&&s<N){ autoView=false; setView(false); }
  if(want!==null){ const t=want; want=null; if(t!==s) goTo(t); }
}
function dest(){ return want!==null?want:(fl&&fl.to!=null?fl.to:s); }
function next(){ peekStop(); if(busy){ want=Math.min(N,dest()+1); return; } if(s>=N) return; busy=true; run(s,1,0,1,720,()=>settle(s+1),s+1); }
function prev(){ peekStop(); if(busy){ want=Math.max(0,dest()-1); return; } if(s<=0) return; busy=true; run(s-1,-1,1,0,720,()=>settle(s-1),s-1); }
function goTo(t){
  peekStop(); t=Math.max(0,Math.min(N,t)); if(busy){ want=t; return; } want=null; if(t===s) return;
  if(Math.abs(t-s)>1){ s=t>s?t-1:t+1; fl=null; render(); }
  t>s?next():prev();
}
function jump(t){ pushNext=true; goTo(t); }
function place(t,push){                    // straight to a spread without turning (the reading view moves the book behind it)
  peekStop(); cancelAnimationFrame(raf); if(drag) drag=null; fl=null; busy=false; want=null;
  s=Math.max(0,Math.min(N,t)); render(); updateUI(); mark(push); prefetch();
  if(view3d&&s>0&&s<N){ autoView=false; setView(false); }
}

// ===================================================== getting pages ready ahead, one at a time =====================================================
const idle=window.requestIdleCallback?(fn=>requestIdleCallback(fn,{timeout:250})):(fn=>setTimeout(fn,24));
let gen=0;
function prefetch(){
  const g=++gen, c=2*s-0.5, list=[];
  for(let f=Math.max(0,2*s-7);f<=Math.min(2*N-1,2*s+8);f++) if(!BLANK.has(f)) list.push(f);
  list.sort((a,b)=>Math.abs(a-c)-Math.abs(b-c));
  const keep=new Set(); for(let f=Math.max(0,2*s-11);f<=Math.min(2*N-1,2*s+12);f++) keep.add(f);
  for(const f of visibleFaces()) keep.add(f);
  Assets.trim(keep);
  let k=0; const step=()=>{ if(g!==gen||k>=list.length) return; Assets.warm(list[k++]).then(()=>idle(step)); };
  idle(step);
}
document.addEventListener('visibilitychange',()=>{ if(document.hidden) gen++; else prefetch(); });

// ===================================================== view: tilt and turn the whole book, zoom, pan =====================================================
function setScene(animate){
  scene.classList.toggle('ease',!!animate&&!RM);
  const k=view3d?0.8:1;
  scene.style.transform='translate3d('+panX.toFixed(1)+'px,'+panY.toFixed(1)+'px,0) scale('+(zoom*k).toFixed(4)+') rotateX('+(view3d?rx:0).toFixed(2)+'deg) rotateZ('+(view3d?rz:0).toFixed(2)+'deg)';
  $('b3d').classList.toggle('on',view3d); $('b3dt').textContent=view3d?'입체':'정면';
  $('bzo').disabled=zoom<=1;
}
function setView(v3){ view3d=v3; if(!v3){ rx=38; rz=-12; } setScene(true); render(); }
let retuneT=0;
function setZoom(z,cx,cy,animate){
  z=Math.max(1,Math.min(4,z)); const r=stage.getBoundingClientRect();
  const px=(cx??r.width/2)-r.width/2, py=(cy??r.height/2)-r.height/2;
  panX=px-(px-panX)*(z/zoom); panY=py-(py-panY)*(z/zoom); zoom=z; if(zoom===1){ panX=0; panY=0; } clampPan(); setScene(animate!==false);
  clearTimeout(retuneT); retuneT=setTimeout(()=>Assets.retune(),220);
}
function clampPan(){ const r=stage.getBoundingClientRect(); const mx=Math.max(0,(W*2*zoom-r.width)/2+40), my=Math.max(0,(H*zoom-r.height)/2+40);
  panX=Math.max(-mx,Math.min(mx,panX)); panY=Math.max(-my,Math.min(my,panY)); }

// ===================================================== pointer =====================================================
// one pointer: tap or drag a page to turn it, drag outside the book to turn the book, drag a zoomed page to move it
// two pointers: pinch to zoom (the page being dragged goes back first); a cancelled or lost pointer turns nothing
let drag=null, pinch=null; const ptrs=new Map();
function spineX(p){ const r=stage.getBoundingClientRect(); let t;
  if(p===undefined) t=tx(); else { const f=fl; t=(f&&f.i===0)?-W/2*(1-p):(f&&f.i===N-1)?W/2*p:tx(); }
  return r.left+r.width/2+t; }
function hit(x,y){
  if(view3d||zoom!==1) return null; const r=stage.getBoundingClientRect(), cy=r.top+r.height/2;
  if(y<cy-H/2||y>cy+H/2) return null; const sx=spineX();
  if(s<N&&x>=sx&&x<=sx+W) return 'R'; if(s>0&&x<=sx&&x>=sx-W) return 'L'; return null;
}
function letGo(){                          // put back a page held halfway, turning nothing
  if(!drag) return; const d=drag; drag=null;
  if(d.kind==='flip'&&d.moved&&fl){ const i=fl.i, dir=fl.dir, p=fl.p;
    run(i,dir,p,dir>0?0:1,Math.max(160,400*(dir>0?p:1-p)),()=>settle(s),s); }
}
stage.addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse'&&e.button!==0) return; hideHint(); peekStop(); wake();
  ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});
  try{ stage.setPointerCapture(e.pointerId); }catch(_){}
  if(ptrs.size===2){
    letGo(); const [a,b]=[...ptrs.values()];
    if(view3d){ autoView=false; setView(false); }
    pinch={d0:Math.max(20,Math.hypot(a.x-b.x,a.y-b.y)),z0:zoom,mx:(a.x+b.x)/2,my:(a.y+b.y)/2};
    return;
  }
  if(ptrs.size>2||drag) return;            // a third finger, or a second pointer while one is already held: ignored
  const h=hit(e.clientX,e.clientY);
  drag={id:e.pointerId,x0:e.clientX,y0:e.clientY,x:e.clientX,y:e.clientY,t:performance.now(),moved:false,v:0,
        kind:zoom>1?'pan':(h&&!busy?'flip':'orbit'),side:h,rx0:rx,rz0:rz,px0:panX,py0:panY};
  if(drag.kind==='flip'){ const sx=spineX(); drag.a=Math.max(.25,Math.min(1,Math.abs(e.clientX-sx)/W)); }
});
stage.addEventListener('pointermove',e=>{
  if(ptrs.has(e.pointerId)) ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pinch&&ptrs.size>=2){
    const [a,b]=[...ptrs.values()], r=stage.getBoundingClientRect();
    const mx=(a.x+b.x)/2, my=(a.y+b.y)/2, d=Math.hypot(a.x-b.x,a.y-b.y);
    panX+=mx-pinch.mx; panY+=my-pinch.my; pinch.mx=mx; pinch.my=my;
    setZoom(pinch.z0*d/pinch.d0,mx-r.left,my-r.top,false); return;
  }
  if(!drag||e.pointerId!==drag.id) return; const dx=e.clientX-drag.x0, dy=e.clientY-drag.y0, now=performance.now();
  drag.v=(e.clientX-drag.x)/Math.max(1,now-drag.t); drag.x=e.clientX; drag.y=e.clientY; drag.t=now;
  if(!drag.moved&&Math.hypot(dx,dy)<6) return;
  if(!drag.moved){ drag.moved=true;
    if(drag.kind==='flip'){ if(busy){ drag.kind='orbit'; } else { busy=true; cancelAnimationFrame(raf); fl=drag.side==='R'?{i:s,dir:1,p:0}:{i:s-1,dir:-1,p:1}; } }
    if(drag.kind==='orbit'&&!view3d){ view3d=true; autoView=false; rx=0; rz=0; drag.rx0=0; drag.rz0=0; render(); } }
  if(drag.kind==='flip'){
    let p=fl.p; for(let it=0;it<3;it++){ const c=Math.max(-1,Math.min(1,(e.clientX-spineX(p))/(drag.a*W))); p=Math.acos(c)/Math.PI; }
    fl.p=p; render();
  } else if(drag.kind==='orbit'){ rz=drag.rz0+dx*0.3; rx=Math.max(-25,Math.min(80,drag.rx0+dy*0.3)); setScene(false); }
  else { panX=drag.px0+dx; panY=drag.py0+dy; clampPan(); setScene(false); }
});
function endDrag(e){
  const known=ptrs.delete(e.pointerId);
  if(pinch){ if(ptrs.size<2){ pinch=null; if(zoom<1.05) setZoom(1); } return; }
  if(!drag||e.pointerId!==drag.id) return;
  if(e.type!=='pointerup'){ letGo(); return; }        // cancelled by the system, or the capture lost: nothing is turned
  const d=drag; drag=null;
  if(d.kind==='flip'){
    if(!d.moved){ d.side==='R'?next():prev(); return; }
    const p=fl.p, i=fl.i, dir=fl.dir;
    if(dir>0){ const go=p>0.4||d.v<-0.35; run(i,1,p,go?1:0,Math.max(180,520*(go?1-p:p)),()=>settle(go?s+1:s),go?s+1:s); }
    else { const go=p<0.6||d.v>0.35; run(i,-1,p,go?0:1,Math.max(180,520*(go?p:1-p)),()=>settle(go?s-1:s),go?s-1:s); }
  } else if(d.kind==='orbit'&&!d.moved&&view3d){
    const r=stage.getBoundingClientRect(); if(s===0) next(); else if(s===N) prev(); else (d.x0>r.left+r.width/2)?next():prev();
  }
  return known;
}
stage.addEventListener('pointerup',endDrag); stage.addEventListener('pointercancel',endDrag);
stage.addEventListener('lostpointercapture',e=>{ if(drag&&e.pointerId===drag.id&&ptrs.has(e.pointerId)) endDrag(e); });
stage.addEventListener('wheel',e=>{
  e.preventDefault(); wake(); const r=stage.getBoundingClientRect();
  if(e.ctrlKey||e.metaKey){ if(view3d&&zoom===1){ autoView=false; setView(false); } setZoom(zoom*Math.exp(-e.deltaY*0.0025),e.clientX-r.left,e.clientY-r.top,false); }
  else if(zoom>1){ panX-=e.deltaX; panY-=e.deltaY; clampPan(); setScene(false); }
},{passive:false});
for(const ev of ['gesturestart','gesturechange']) stage.addEventListener(ev,e=>e.preventDefault(),{passive:false});   // Safari: zoom the book, not the page

// ===================================================== reading view: the words of the open pages =====================================================
let TEXT=null, textP=null, ri=-1;
function loadText(){
  if(TEXT) return Promise.resolve(TEXT); if(textP) return textP;
  textP=(WEB?fetch(CFG.text).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }):Promise.resolve(window.LITERA_TEXT))
    .then(t=>{ if(!t||!t.length) throw new Error('no text'); TEXT=t; return t; },e=>{ textP=null; throw e; });
  return textP;
}
function pieceAt(t){
  if(t<=0) return 0; if(t>=N) return TEXT.length-1;
  const a=facePage(2*t-1)||facePage(2*t), b=facePage(2*t)||a;
  let i=TEXT.findIndex(p=>p.start<=b&&p.end>=a); if(i<0) i=TEXT.findIndex(p=>p.start>=a); return i<0?TEXT.length-1:i;
}
function actOf(page){ let a=''; for(const [title,,pg,kind] of CFG.toc) if(kind==='act'&&pg<=page) a=title; return a; }
function showPiece(){
  const p=TEXT[ri], box=$('readart'); box.textContent='';
  const add=(tag,cls,txt)=>{ const e=document.createElement(tag); if(cls) e.className=cls; e.textContent=txt; box.appendChild(e); return e; };
  add('p','k',p.sec!==undefined?p.sec:actOf(p.start));
  const h=add('h2','',p.title); h.id='readtitle'; h.tabIndex=-1;
  for(const [k,txt] of p.blocks){
    if(k==='t') continue;
    if(k==='d') add('p','d',txt); else if(k==='b') add('p','by',txt);
    else if(k==='h') add('h3','',txt); else if(k==='q') add('p','q',txt);
    else if(k==='n') add('p',/^주$|^각주$/.test(txt)?'nh':'n',txt); else if(k==='r') add('p','r',txt);
    else if(k==='xh') add('h4','xh',txt); else if(k==='x') add('p','x',txt);
    else add('p','',txt);
  }
  add('p','pp',(p.end>p.start?p.start+'~'+p.end+'쪽':p.start+'쪽')+' · '+(ri+1)+' / '+TEXT.length);
  $('rsp').textContent=p.title;
  $('rprev').disabled=ri<=0; $('rnext').disabled=ri>=TEXT.length-1;
  $('read').scrollTop=0;
}
function openRead(){
  loadText().then(()=>{
    ri=pieceAt(s); showPiece(); $('read').classList.add('open'); $('btext').classList.add('on'); $('btext').setAttribute('aria-expanded','true');
    toc(false); const t=$('readtitle'); if(t) t.focus({preventScroll:true});
  }).catch(e=>{ toast(WEB?'글을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.':'글을 불러오지 못했습니다.'); try{ console.warn('[Litera] text',e); }catch(_){} });
}
function closeRead(){ $('read').classList.remove('open'); $('btext').classList.remove('on'); $('btext').setAttribute('aria-expanded','false'); stage.focus({preventScroll:true}); }
function readGo(d){ const n=ri+d; if(!TEXT||n<0||n>=TEXT.length) return; ri=n; showPiece(); place(sOfPage(TEXT[ri].start),true); const t=$('readtitle'); if(t) t.focus({preventScroll:true}); }
function readFont(d){ const a=$('read'); const v=Math.max(14,Math.min(24,(parseFloat(a.style.getPropertyValue('--rf'))||17)+d)); a.style.setProperty('--rf',v+'px');
  try{ localStorage.setItem('litera-rf',v); }catch(_){} }
try{ const v=+localStorage.getItem('litera-rf'); if(v>=14&&v<=24) $('read').style.setProperty('--rf',v+'px'); }catch(_){}

// ===================================================== messages, menu, help =====================================================
let toastT=0;
function toast(msg,label,fn,ms){
  const t=$('toast'); t.querySelector('span').textContent=msg; const b=t.querySelector('button');
  b.style.display=label?'':'none'; b.textContent=label||''; b.onclick=()=>{ t.classList.remove('show'); if(fn) fn(); };
  t.classList.add('show'); clearTimeout(toastT); if(ms!==0) toastT=setTimeout(()=>t.classList.remove('show'),ms||6000);
}
const MENU=[];
function menuAdd(item){ MENU.push(item); }
function menuOpen(open){
  const m=$('menu'); open=open===undefined?!m.classList.contains('open'):open;
  if(open){ m.textContent='';
    for(const it of MENU){ if(it.show&&!it.show()) continue; const b=document.createElement('button'); b.type='button'; b.setAttribute('role','menuitem');
      b.textContent=typeof it.label==='function'?it.label():it.label;
      const sub=typeof it.sub==='function'?it.sub():it.sub; if(sub){ const sm=document.createElement('small'); sm.textContent=sub; b.appendChild(sm); }
      b.onclick=()=>{ menuOpen(false); it.fn(); }; m.appendChild(b); }
  }
  m.classList.toggle('open',open); $('bmore').setAttribute('aria-expanded',open?'true':'false');
  if(open){ const f=m.querySelector('button'); if(f) f.focus(); }
}
menuAdd({label:'글로 읽기',sub:'펼친 쪽의 글을 글자로 (화면 낭독기에도)',fn:openRead});
menuAdd({label:()=>view3d?'정면으로 보기':'입체로 보기',show:()=>$('b3d').offsetParent===null,fn:()=>$('b3d').click()});
menuAdd({label:'전체 화면',show:()=>!!(document.documentElement.requestFullscreen||document.documentElement.webkitRequestFullscreen),fn:()=>$('bfs').click()});
menuAdd({label:'도움말',sub:'넘기기·확대·바로 가기 키',fn:()=>help(true)});
function help(open){ $('help').classList.toggle('open',open); if(open){ const x=$('help').querySelector('.x'); if(x) x.focus(); } else stage.focus({preventScroll:true}); }

// ===================================================== controls =====================================================
$('bnext').onclick=next; $('bprev').onclick=prev; $('bfirst').onclick=()=>jump(0); $('blast').onclick=()=>jump(N);
$('b3d').onclick=()=>{ autoView=false; if(zoom>1){ zoom=1; panX=panY=0; } setView(!view3d); };
$('bzi').onclick=()=>{ if(view3d){ autoView=false; setView(false); } setZoom(zoom*1.5); }; $('bzo').onclick=()=>setZoom(zoom/1.5);
$('bfs').onclick=()=>{ const d=document, el=d.documentElement;
  if(d.fullscreenElement||d.webkitFullscreenElement){ (d.exitFullscreen||d.webkitExitFullscreen).call(d); }
  else { const f=el.requestFullscreen||el.webkitRequestFullscreen; if(f) try{ const r=f.call(el); if(r&&r.catch) r.catch(()=>{}); }catch(_){} } };
if(!(document.documentElement.requestFullscreen||document.documentElement.webkitRequestFullscreen)) $('bfs').classList.add('nofs');
$('btoc').onclick=()=>toc();
$('btext').onclick=()=>$('read').classList.contains('open')?closeRead():openRead();
$('bmore').onclick=()=>menuOpen();
$('rclose').onclick=closeRead; $('rprev').onclick=()=>readGo(-1); $('rnext').onclick=()=>readGo(1);
$('rsm').onclick=()=>readFont(-1); $('rbg').onclick=()=>readFont(1);
$('rbook').onclick=()=>{ const p=TEXT&&TEXT[ri]; closeRead(); if(p) place(sOfPage(p.start),true); };
$('help').addEventListener('click',e=>{ if(e.target===$('help')||e.target.classList.contains('x')) help(false); });
document.addEventListener('click',e=>{ const m=$('menu'); if(m.classList.contains('open')&&!m.contains(e.target)&&e.target.closest('#bmore')===null) menuOpen(false); });
seek.addEventListener('input',()=>{ seeking=true; $('pg').textContent=spreadText(+seek.value); });
seek.addEventListener('change',()=>{ seeking=false; shownS=-1; jump(+seek.value); });
addEventListener('keydown',e=>{
  wake();
  if(e.key==='Escape'){
    if($('help').classList.contains('open')) return help(false);
    if($('menu').classList.contains('open')) return menuOpen(false);
    if($('read').classList.contains('open')) return closeRead();
    if(zoom>1) setZoom(1); toc(false); return;
  }
  if($('help').classList.contains('open')) return;
  if(e.target.tagName==='INPUT'||e.altKey||e.ctrlKey||e.metaKey) return;
  if($('read').classList.contains('open')){        // in the reading view the arrows go from piece to piece (up and down scroll)
    if(e.key==='ArrowRight'){ e.preventDefault(); readGo(1); } else if(e.key==='ArrowLeft'){ e.preventDefault(); readGo(-1); }
    return;
  }
  if(e.target.closest&&e.target.closest('#menu')) return;
  if(['ArrowRight','PageDown',' '].includes(e.key)){ if(e.target.tagName==='BUTTON'&&e.key===' ') return; e.preventDefault(); next(); }
  else if(['ArrowLeft','PageUp'].includes(e.key)){ e.preventDefault(); prev(); }
  else if(e.key==='Home'){ e.preventDefault(); jump(0); } else if(e.key==='End'){ e.preventDefault(); jump(N); }
  else if(e.key==='f'||e.key==='F') $('bfs').click();
  else if(e.key==='t'||e.key==='T') $('btext').click();
  else if(e.key==='+'||e.key==='=') $('bzi').click(); else if(e.key==='-') $('bzo').click();
  else if(e.key==='?') help(true);
});
function hideHint(){ $('hint').style.opacity='0'; }
// in full screen the bar steps out of the way after a few still seconds, and comes back with any movement
let idleT=0;
function wake(){ document.body.classList.remove('idle'); clearTimeout(idleT);
  if(document.fullscreenElement||document.webkitFullscreenElement) idleT=setTimeout(()=>{ if(!$('toc').classList.contains('open')&&!$('read').classList.contains('open')) document.body.classList.add('idle'); },3000); }
addEventListener('pointermove',wake,{passive:true});
document.addEventListener('fullscreenchange',wake); document.addEventListener('webkitfullscreenchange',wake);
// size changes (window, rotation, a phone's address bar, the stage itself) re-lay the book on the next frame; the zoom stays
let lastW=0, lastH=0, sizeT=0;
function sized(){ clearTimeout(sizeT); sizeT=setTimeout(()=>requestAnimationFrame(()=>{
  const w=stage.clientWidth, h=stage.clientHeight; if(!w||!h||(w===lastW&&Math.abs(h-lastH)<2)) return; lastW=w; lastH=h;
  layout(); clampPan(); setScene(false); }),120); }
if(window.ResizeObserver) new ResizeObserver(sized).observe(stage); else addEventListener('resize',sized);

// ===================================================== a first nudge: the cover lifts a little, once =====================================================
let peekOn=false;
function peek(){
  if(RM||busy||s!==0||drag) return; peekOn=true; busy=true;
  run(0,1,0,0.07,520,()=>{ if(!peekOn) return; run(0,1,0.07,0,520,()=>{ if(!peekOn) return; peekOn=false; fl=null; busy=false; render(); },0); },0);
}
function peekStop(){ if(!peekOn) return; peekOn=false; cancelAnimationFrame(raf); fl=null; busy=false; render(); }

// ===================================================== in-app browsers: a closable note, nothing blocked =====================================================
(function(){
  const ua=navigator.userAgent||'';
  if(!/KAKAOTALK|Instagram|FBAN|FBAV|NAVER\(inapp|Line\/|DaumApps|everytimeApp|BAND\//i.test(ua)) return;
  try{ if(localStorage.getItem('litera-note')==='x') return; }catch(_){}
  const n=$('note'); n.querySelector('p').textContent='앱 안의 브라우저에서는 책장이 느리게 넘어가거나 멈출 수 있습니다. 그럴 때는 '+(WEB?'오른쪽 아래 ⋯ 메뉴의 ‘다른 브라우저로 열기’로 ':'')+'Chrome이나 Safari에서 열어 주세요.';
  n.classList.add('show');
  $('noteX').onclick=()=>{ n.classList.remove('show'); try{ localStorage.setItem('litera-note','x'); }catch(_){} };
})();

// ===================================================== start =====================================================
const ready=[];
window.LITERA={spread:()=>s,page:()=>facePage(2*s-1)||facePage(2*s)||0,urls:()=>Assets.size(),bytes:()=>Assets.bytes(),tier:()=>Assets.tier(),
  bad:()=>[...Assets.bad],zoom:()=>zoom,flat:()=>!view3d,go:t=>jump(t),place,toast,menuAdd,hashOf,web:WEB,
  onReady:fn=>{ if(ready===null) fn(); else ready.push(fn); }};
buildToc();
if(innerWidth<700&&innerHeight>innerWidth) $('hint').textContent='쪽을 눌러 넘깁니다 · 두 손가락으로 벌려 확대 · ‘글로 읽기’는 Aa 단추';
const start=fromHash(location.hash); if(start!==null){ s=start; lastHash=location.hash; } else lastHash=hashOf(0);   // opened plainly: a plain address until a page turns
const first=[]; for(const i of [s-1,s,0,N-1]) if(i>=0&&i<N){ first.push(2*i,2*i+1); }
const firstU=[...new Set(first)].filter(f=>!BLANK.has(f)); let done=0;
const lm=$('load').querySelector('.m'); lm.textContent='첫 쪽을 준비하는 중입니다';
const firstReady=Promise.all(firstU.map(f=>Assets.warm(f).then(ok=>{ done++; lm.textContent='첫 쪽을 준비하는 중입니다 ('+done+'/'+firstU.length+')'; return ok; })));
const tooLong=new Promise(r=>setTimeout(()=>r('slow'),15000));
Promise.race([firstReady,tooLong]).then(res=>{
  if(Array.isArray(res)&&res.length&&res.every(ok=>!ok)){ fail('E3',new Error(WEB&&!navigator.onLine?'인터넷에 연결되어 있지 않습니다':'page images')); return; }
  layout(); lastW=stage.clientWidth; lastH=stage.clientHeight;
  if(s>0&&s<N){ autoView=false; view3d=false; setScene(false); }
  updateUI(); mark(false); prefetch();
  const l=$('load'); requestAnimationFrame(()=>{ l.style.opacity='0'; setTimeout(()=>l.remove(),600); });
  setTimeout(hideHint,7000);
  if(s===0) setTimeout(peek,1400);
  if(res==='slow') toast('첫 쪽이 늦게 열렸습니다. 나머지 쪽은 넘기는 대로 불러옵니다.');
  else if(Assets.bad.size) toast('일부 쪽을 불러오지 못했습니다.');
  const r=ready.splice(0); ready.length=0; for(const fn of r) try{ fn(); }catch(e){ console.warn(e); }
}).catch(err=>fail('E2',err));

}catch(err){ fail('E2',err); }
})();
