const $ = (id) => document.getElementById(id);
const els = {
  cloudName:$('cloudName'), uploadPreset:$('uploadPreset'), folderName:$('folderName'), backendUrl:$('backendUrl'), openRouterKey:$('openRouterKey'), openRouterModels:$('openRouterModels'),
  saveSettingsBtn:$('saveSettingsBtn'), settingsStatus:$('settingsStatus'), setupBadge:$('setupBadge'), setupCard:$('setupCard'), setupForm:$('setupForm'), setupSaved:$('setupSaved'), editSettingsBtn:$('editSettingsBtn'),
  titleInput:$('titleInput'), imageCount:$('imageCount'), findBtn:$('findBtn'), stopBtn:$('stopBtn'), finderGrid:$('finderGrid'), finderStatus:$('finderStatus'), activityLine:$('activityLine'),
  imageUrl:$('imageUrl'), convertBtn:$('convertBtn'), dropZone:$('dropZone'), fileInput:$('fileInput'), status:$('status'), progressBar:$('progressBar'), singleResult:$('singleResult'), clearBtn:$('clearBtn'), historyList:$('historyList'), clearHistoryBtn:$('clearHistoryBtn'), newImageBtn:$('newImageBtn')
};


// Works both as Chrome extension and as a Vercel-hosted web dashboard.
// On Vercel there is no chrome.* API, so we use safe browser/localStorage fallbacks.
(function ensureBrowserFallbacks(){
  if(window.chrome && chrome.storage && chrome.storage.local) return;
  const local = {
    async get(keys){
      const out = {};
      const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
      for(const k of list){
        try{ const v = localStorage.getItem('wcsm_'+k); out[k] = v ? JSON.parse(v) : undefined; }catch(e){ out[k] = undefined; }
      }
      return out;
    },
    async set(obj){
      for(const [k,v] of Object.entries(obj || {})) localStorage.setItem('wcsm_'+k, JSON.stringify(v));
    }
  };
  window.chrome = window.chrome || {};
  chrome.storage = chrome.storage || {local};
  chrome.storage.local = chrome.storage.local || local;
  chrome.runtime = chrome.runtime || {
    getURL:(x)=>x,
    async sendMessage(msg){
      if(!msg || msg.type !== 'FETCH_URL') throw new Error('Unsupported web message');
      const endpoint = '/api/convert?fetch=1&asText=' + (msg.asText ? '1' : '0') + '&url=' + encodeURIComponent(msg.url || '');
      const r = await fetch(endpoint, {cache:'no-store'});
      if(!r.ok) throw new Error('HTTP '+r.status);
      return await r.json();
    }
  };
  chrome.downloads = chrome.downloads || null;
})();


window.addEventListener('error', (ev)=>{
  try{
    const box = document.getElementById('status') || document.getElementById('finderStatus');
    if(box){ box.className='status error'; box.innerHTML = `<span></span><div><strong>Dashboard error fixed mode</strong><p>${escapeHtml(ev.message||'Unknown error')}</p></div>`; }
  }catch(e){}
});

let settings = {};
let history = [];
let stopFlag = false;
let running = false;
let settingsEditing = false;
let hasSavedSettings = false;
const DEFAULT_IMAGE_MODELS = [
  'recraft/recraft-v4.1-pro',
  'recraft/recraft-v4.1',
  'black-forest-labs/flux.2-max',
  'black-forest-labs/flux.2-pro',
  'black-forest-labs/flux-dev',
  'google/gemini-2.5-flash-image-preview'
];
const DEFAULT_SETTINGS = {
  cloudName: 'dwxaockg7',
  uploadPreset: 'webp_unsigned',
  folderName: 'webp-cdn-source-maker',
  backendUrl: (location.origin && /^https?:/i.test(location.origin) ? location.origin + '/api/convert' : 'https://backend-tdnn.vercel.app/api/convert'),
  openRouterKey: '',
  openRouterModels: DEFAULT_IMAGE_MODELS.join(', ')
};

// Performance guardrails: keep the extension smooth and avoid slowing Chrome profiles.
try{ document.documentElement.classList.add('perfMode'); }catch(e){}
const MAX_HISTORY_ITEMS = 25;
const MAX_RENDERED_HISTORY = 8;
const IMAGE_TARGET_W = 1280;
const IMAGE_TARGET_H = 720;
const PREVIEW_URL_TTL = 45000;
const activePreviewUrls = new Set();
function makePreviewUrl(blob){
  if(!(blob instanceof Blob)) return '';
  const u = URL.createObjectURL(blob);
  activePreviewUrls.add(u);
  setTimeout(()=>releasePreviewUrl(u), PREVIEW_URL_TTL);
  return u;
}
function releasePreviewUrl(u){
  if(u && activePreviewUrls.has(u)){
    activePreviewUrls.delete(u);
    try{ URL.revokeObjectURL(u); }catch(e){}
  }
}
function clearPreviewUrls(){
  [...activePreviewUrls].forEach(releasePreviewUrl);
}

const FREE_TEXT_MODELS = [
  // Free OpenRouter models from your list. These do NOT generate images directly; they are used only to build a better image prompt.
  'nvidia/nemotron-3-super-120b-a12b:free',
  'poolside/laguna-m.1:free',
  'openai/gpt-oss-120b:free',
  'z-ai/glm-4.5-air:free',
  'deepseek/deepseek-v4-flash:free',
  'minimax/minimax-m2.5:free',
  'arcee-ai/trinity-large-thinking:free',
  'poolside/laguna-xs.2:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'openai/gpt-oss-20b:free',
  'baidu/cobuddy:free',
  'google/gemma-4-31b-it:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'openrouter/free'
];

const DEFAULT_MODELS = DEFAULT_IMAGE_MODELS;

function escapeHtml(s){return String(s||'').replace(/[&<>\"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));}
function rnd(){return Math.random().toString(36).slice(2,12)+Date.now().toString(36).slice(-4);}
function normalizeTitle(t){return String(t||'').replace(/\s+/g,' ').trim();}
function cleanFileName(t){return normalizeTitle(t).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,32)||'image';}
function shortPublicId(){return 'img-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);}
function getModels(){return (settings.openRouterModels||'').split(',').map(x=>x.trim()).filter(Boolean).concat(DEFAULT_IMAGE_MODELS).filter((v,i,a)=>a.indexOf(v)===i);}
function getFreeTextModels(){return FREE_TEXT_MODELS;}
function looksLikeTextOnlyModel(model){return /:free$/i.test(model) || /^(nvidia\/|poolside\/|openai\/|z-ai\/|deepseek\/|minimax\/|arcee-ai\/|baidu\/|google\/gemma|qwen\/|meta-llama\/|liquid\/|nousresearch\/|openrouter\/free)/i.test(model);}
function getLocal(keys){return chrome.storage.local.get(keys);}
function saveLocal(obj){return chrome.storage.local.set(obj);}

async function init(){
  const d = await getLocal(['settings','history']);
  hasSavedSettings = !!d.settings;
  settings = {...DEFAULT_SETTINGS, ...(d.settings || {})};
  history = Array.isArray(d.history) ? d.history.filter(x=>x && /^https?:\/\//i.test(String(x.url||''))).slice(0, MAX_HISTORY_ITEMS) : [];
  if(Array.isArray(d.history) && d.history.length !== history.length) saveLocal({history});
  settingsEditing = !hasSavedSettings;
  els.cloudName.value = settings.cloudName;
  els.uploadPreset.value = settings.uploadPreset;
  els.folderName.value = settings.folderName;
  els.backendUrl.value = settings.backendUrl;
  if(els.openRouterKey) els.openRouterKey.value = settings.openRouterKey || '';
  if(els.openRouterModels) els.openRouterModels.value = settings.openRouterModels;
  updateSetup();
  renderHistory();
}
function updateSetup(){
  const hasCore = !!(settings.cloudName && settings.uploadPreset);
  const hasKey = !!(settings.openRouterKey && settings.openRouterKey.trim());
  const liveKey = (els.openRouterKey && els.openRouterKey.value && els.openRouterKey.value.trim()) || (settings.openRouterKey && settings.openRouterKey.trim());
  const ok = hasCore;
  const shouldHideForm = ok && !settingsEditing;

  els.setupBadge.textContent = ok ? 'Setup Ready' : 'Not ready';
  els.setupBadge.className = ok ? 'readyBadge' : 'notReadyBadge';

  if(els.setupCard){
    els.setupCard.classList.toggle('setupComplete', shouldHideForm);
    els.setupCard.classList.toggle('setupNeedsKey', !hasKey);
  }
  if(els.setupForm){
    els.setupForm.classList.toggle('hidden', shouldHideForm);
    els.setupForm.style.display = shouldHideForm ? 'none' : '';
  }
  if(els.setupSaved){
    els.setupSaved.classList.toggle('hidden', !shouldHideForm);
    els.setupSaved.style.display = shouldHideForm ? 'flex' : 'none';
    const p = els.setupSaved.querySelector('p');
    if(p) p.textContent = 'Settings saved. Dashboard ready to convert image/page links.';
  }
}
function setActivity(msg, mode='working'){
  if(!els.activityLine) return;
  els.activityLine.className = 'activityLine ' + mode;
  els.activityLine.textContent = msg;
}

function setStatus(a,b,err=false){
  els.status.className = 'status ' + (err?'error':'ready');
  els.status.innerHTML = `<span></span><div><strong>${escapeHtml(a)}</strong><p>${escapeHtml(b)}</p></div>`;
}
function setFinderStatus(a,b,err=false){
  els.finderStatus.className = 'status ' + (err?'error':'ready');
  els.finderStatus.innerHTML = `<span></span><div><strong>${escapeHtml(a)}</strong><p>${escapeHtml(b)}</p></div>`;
}
function progress(n){els.progressBar.style.width = Math.max(0,Math.min(100,n))+'%';}
function showToast(msg){els.settingsStatus.textContent = msg; setTimeout(()=>{ if(els.settingsStatus.textContent===msg) els.settingsStatus.textContent='Settings saved locally.'; },2500);}

function setButtonBusy(btn, text){
  if(!btn) return;
  btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
  btn.textContent = text;
  btn.classList.add('is-working');
  btn.disabled = true;
}
function setButtonDone(btn, text='Done ✓'){
  if(!btn) return;
  const original = btn.dataset.originalText || btn.textContent;
  btn.textContent = text;
  btn.classList.remove('is-working');
  btn.classList.add('is-done');
  btn.disabled = false;
  setTimeout(()=>{
    btn.textContent = original;
    btn.classList.remove('is-done','is-working');
  }, 1400);
}
function setButtonError(btn, text='Failed'){
  if(!btn) return;
  const original = btn.dataset.originalText || btn.textContent;
  btn.textContent = text;
  btn.classList.remove('is-working');
  btn.classList.add('is-error');
  btn.disabled = false;
  setTimeout(()=>{
    btn.textContent = original;
    btn.classList.remove('is-error','is-working');
  }, 1800);
}
async function copyWithFeedback(btn, text, label='Copied ✓'){
  try{
    setButtonBusy(btn, 'Copying...');
    await navigator.clipboard.writeText(text);
    setButtonDone(btn, label);
  }catch(e){
    setButtonError(btn, 'Copy failed');
    throw e;
  }
}
async function downloadWithFeedback(btn, url, title){
  try{
    setButtonBusy(btn, 'Downloading...');
    await downloadWebp(url, title);
    setButtonDone(btn, 'Downloaded ✓');
  }catch(e){
    setButtonError(btn, 'Failed');
  }
}
function openWithFeedback(btn, url){
  setButtonBusy(btn, 'Opening...');
  const w = window.open(url, '_blank');
  if(w){ setButtonDone(btn, 'Opened ✓'); }
  else { setButtonError(btn, 'Popup blocked'); }
}



async function fetchViaBackground(url, asText=false){
  if(!chrome?.runtime?.sendMessage) throw new Error('background messaging unavailable');
  const res = await chrome.runtime.sendMessage({type:'FETCH_URL', url, asText});
  if(!res || !res.ok) throw new Error(res?.error || ('fetch failed '+(res?.status||'')));
  if(asText) return res.text || '';
  const bin = atob(res.base64 || '');
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  return new Blob([arr], {type: res.contentType || 'application/octet-stream'});
}
function extractBgUrl(style){
  const m = String(style||'').match(/url\(["']?([^"')]+)["']?\)/i);
  return m ? m[1] : '';
}
async function scrapeImageByOpeningTab(pageUrl){
  if(!chrome?.tabs?.create || !chrome?.scripting?.executeScript) return '';
  let tab;
  try{
    tab = await chrome.tabs.create({url: pageUrl, active:false});
    await new Promise((resolve)=>{
      const done = (tabId, info)=>{
        if(tabId === tab.id && info.status === 'complete'){
          chrome.tabs.onUpdated.removeListener(done);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(done);
      setTimeout(()=>{ try{chrome.tabs.onUpdated.removeListener(done);}catch(e){} resolve(); }, 9000);
    });
    // give JS-heavy pages a little time to render images
    await new Promise(r=>setTimeout(r, 2500));
    const injected = await chrome.scripting.executeScript({
      target:{tabId:tab.id},
      func:()=>{
        const abs=(u)=>{try{return new URL(u, location.href).href}catch(e){return u||''}};
        const bad=/logo|icon|avatar|sprite|placeholder|tracking|pixel|adsbygoogle/i;
        const candidates=[];
        const push=(url,score=0,context='')=>{ if(!url) return; url=abs(url); if(!/^https?:|^data:image\//i.test(url)) return; if(bad.test(url)) score-=200; if(!candidates.some(x=>x.url===url)) candidates.push({url,score,context}); };
        ['meta[property="og:image:secure_url"]','meta[property="og:image"]','meta[name="twitter:image"]','meta[name="twitter:image:src"]','link[rel="image_src"]'].forEach(sel=>{
          const el=document.querySelector(sel); push(el?.content||el?.href, 10000, sel);
        });
        document.querySelectorAll('script[type="application/ld+json"]').forEach(sc=>{
          try{
            const walk=(x)=>{ if(!x) return; if(typeof x==='string'){ if(/\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(x) || x.includes('res.cloudinary.com')) push(x,7000); return; } if(Array.isArray(x)) x.forEach(walk); else if(typeof x==='object') Object.values(x).forEach(walk); };
            walk(JSON.parse(sc.textContent||'{}'));
          }catch(e){}
        });
        document.querySelectorAll('img, picture source').forEach(el=>{
          const src = el.currentSrc || el.src || el.srcset?.split(',').pop()?.trim().split(' ')[0] || el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original') || el.getAttribute('data-url') || '';
          const r = el.getBoundingClientRect?.() || {width:0,height:0};
          const w = el.naturalWidth || el.width || r.width || 0;
          const h = el.naturalHeight || el.height || r.height || 0;
          push(src, Math.round(w*h) + (r.top>=0 && r.top<900 ? 3000 : 0), (el.outerHTML||'') + ' ' + (el.closest('a')?.href||''));
        });
        document.querySelectorAll('[style]').forEach(el=>{
          const m = String(el.getAttribute('style')||'').match(/url\(["']?([^"')]+)["']?\)/i);
          const r = el.getBoundingClientRect?.() || {width:0,height:0,top:0};
          if(m) push(m[1], Math.round(r.width*r.height) + (r.top>=0 && r.top<900 ? 2000 : 0), el.outerHTML||'');
        });
        const pageMatch = location.pathname.match(/\/free-(?:ai-image|photo)\/[^\/]+_(\d+)\.htm/i);
        const pageId = pageMatch ? pageMatch[1] : '';
        const wrongMagnific = (x)=>{
          if(!/magnific\.com$/i.test(location.hostname.replace(/^www\./,'')) || !pageId) return false;
          const ids=[...String(x.url+' '+(x.context||'')).matchAll(/\/free-(?:ai-image|photo)\/[^\s"'<>)]*?_(\d+)(?:\.htm|\.(?:jpg|jpeg|png|webp|avif))/gi)].map(m=>m[1]);
          if(ids.some(id=>id!==pageId)) return true;
          if(/cross[_-]?selling|related|recommend|similar|suggested/i.test(String(x.context||'')) && !String(x.context||'').includes(pageId)) return true;
          return false;
        };
        const pageSlug = (location.pathname.match(/\/free-(?:ai-image|photo)\/([^\/]+)_\d+\.htm/i)||[])[1] || '';
        const scoreExact=(x)=>{ const t=String((x.url||'')+' '+(x.context||'')).toLowerCase(); let s=x.score||0; if(pageId && t.includes(pageId)) s+=200000; if(pageSlug && t.includes(pageSlug.toLowerCase())) s+=160000; if(/og:image|twitter:image|image_src|primary|main|hero|featured|preview|detail|asset/i.test(x.context||'')) s+=50000; if(/cross[_-]?selling|related|recommend|similar|suggested|from_element/i.test(t)) s-=250000; return s; };
        const clean = candidates.filter(x=>!wrongMagnific(x));
        clean.sort((a,b)=>scoreExact(b)-scoreExact(a));
        return clean[0]?.url || '';
      }
    });
    return injected?.[0]?.result || '';
  }catch(e){ return ''; }
  finally{ if(tab?.id) try{ await chrome.tabs.remove(tab.id); }catch(e){} }
}
async function fetchImageAsBlobBest(url){
  try{
    const b = await fetchViaBackground(url, false);
    if((b.type||'').startsWith('image/') || b.size > 1000) return b;
  }catch(e){ console.debug('background image fetch failed', e.message); }
  return await urlToBlobWithTimeout(url, 65000);
}

function isLikelyDirectImageUrl(url){
  if(!/^https?:\/\//i.test(url||'')) return false;
  try{
    const u = new URL(url);
    return /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(u.pathname || '');
  }catch(e){
    return /\.(png|jpe?g|webp|gif|avif|bmp|svg)(\?|#|$)/i.test(url||'');
  }
}
function absolutizeUrl(u, base){
  try{return new URL(u, base).href;}catch(e){return u;}
}
function pickUrlFromAnyJson(obj){
  const found=[];
  const walk=(x)=>{
    if(!x) return;
    if(typeof x==='string'){
      if(/^https?:\/\//i.test(x) && (/\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(x) || x.includes('res.cloudinary.com'))) found.push(x);
      return;
    }
    if(Array.isArray(x)){x.forEach(walk); return;}
    if(typeof x==='object') Object.values(x).forEach(walk);
  };
  walk(obj);
  return found[0] || '';
}

function decodeDeep(value){
  let out = String(value || '').trim();
  for(let i=0;i<4;i++){
    try{
      const dec = decodeURIComponent(out);
      if(dec === out) break;
      out = dec;
    }catch(e){ break; }
  }
  return out.replace(/&amp;/g,'&');
}
function collectUrlCandidatesFromText(text, base=''){
  const candidates=[];
  const seen=new Set();
  const add=(u, score=0)=>{
    if(!u) return;
    u = decodeDeep(u).replace(/[\s"'<>]+$/g,'');

    // If a page URL contains another direct image URL inside query/hash,
    // prefer the nested real image instead of treating the whole page URL as an image.
    const secondHttp = u.indexOf('http', 8);
    if(secondHttp > -1){
      add(u.slice(secondHttp), score + 9500);
    }

    try{ if(base && !/^https?:\/\//i.test(u)) u = new URL(u, base).href; }catch(e){}
    if(!/^https?:\/\//i.test(u) && !/^data:image\//i.test(u)) return;
    if(seen.has(u)) return;
    seen.add(u);
    if(isLikelyDirectImageUrl(u) || /^data:image\//i.test(u)) score += 10000;
    if(/img\.|images?\.|cdn|cloudinary|free-photo|photo|image|media|uploads?/i.test(u)) score += 1200;
    if(/logo|icon|avatar|sprite|placeholder|tracking|pixel|adsbygoogle/i.test(u)) score -= 5000;
    candidates.push({url:u, score});
  };
  const raw = decodeDeep(text);
  // Pull normal and encoded URLs from the whole string.
  (raw.match(/https?:\/\/[^\s"'<>]+/gi) || []).forEach((u,i)=>add(u, 100-i));
  (raw.match(/https?%3A%2F%2F[^\s"'<>]+/gi) || []).forEach((u,i)=>add(u, 90-i));
  // Pull values from query parameters such as ?query=https%3A%2F%2F...jpg
  try{
    const u = new URL(raw);
    for(const [k,v] of u.searchParams.entries()){
      const val = decodeDeep(v);
      add(val, /url|image|img|src|query|photo|media/i.test(k) ? 9000 : 3000);
      (val.match(/https?:\/\/[^\s"'<>]+/gi) || []).forEach(x=>add(x, 8500));
      (val.match(/https?%3A%2F%2F[^\s"'<>]+/gi) || []).forEach(x=>add(x, 8400));
    }
    if(u.hash){
      const h = decodeDeep(u.hash.slice(1));
      (h.match(/https?:\/\/[^\s"'<>]+/gi) || []).forEach(x=>add(x, 6500));
      try{
        const hp = new URLSearchParams(h.replace(/^#/,''));
        for(const [k,v] of hp.entries()){
          const val = decodeDeep(v);
          add(val, /url|image|img|src|query|photo|media/i.test(k) ? 12000 : 4000);
          (val.match(/https?:\/\/[^\s"'<>]+/gi) || []).forEach(x=>add(x, 11000));
        }
      }catch(e){}
    }
  }catch(e){}
  candidates.sort((a,b)=>b.score-a.score);
  return candidates.map(x=>x.url);
}


function magnificInfo(pageUrl){
  try{
    const u = new URL(pageUrl);
    if(!/magnific\.com$/i.test(u.hostname.replace(/^www\./,''))) return null;
    const m = u.pathname.match(/\/free-(?:ai-image|photo)\/([^\/]+)_(\d+)\.htm/i);
    if(!m) return null;
    return {slug:m[1].toLowerCase(), id:m[2]};
  }catch(e){return null;}
}
function isWrongMagnificCandidate(candidateUrl, pageUrl, context=''){
  const info = magnificInfo(pageUrl);
  if(!info) return false;
  const cand = String(candidateUrl||'');
  const ctx = String(context||'');
  const txt = cand + ' ' + ctx;
  const ids = [...txt.matchAll(/\/free-(?:ai-image|photo)\/[^\s"'<>)]*?_(\d+)(?:\.htm|\.(?:jpg|jpeg|png|webp|avif))/gi)].map(m=>m[1]);
  if(ids.some(id=>id !== info.id)) return true;
  if(/cross[_-]?selling|related|recommend|similar|suggested/i.test(ctx) && !ctx.includes(info.id) && !ctx.toLowerCase().includes(info.slug)) return true;
  return false;
}
function magnificExactScore(candidateUrl, pageUrl, context=''){
  const info = magnificInfo(pageUrl);
  if(!info) return 0;
  const txt = (String(candidateUrl||'') + ' ' + String(context||'')).toLowerCase();
  let score = 0;
  if(txt.includes(info.id)) score += 200000;
  if(txt.includes(info.slug)) score += 160000;
  if(/og:image|twitter:image|image_src|primary|main|hero|featured|preview|detail|asset/i.test(context)) score += 50000;
  if(/cross[_-]?selling|related|recommend|similar|suggested|from_element/i.test(txt)) score -= 250000;
  return score;
}
function collectMagnificExactCandidates(text, pageUrl){
  const info = magnificInfo(pageUrl);
  if(!info) return [];
  const raw = decodeDeep(text||'');
  const out=[];
  const addWindow=(idx, radius=4500)=>{
    if(idx<0) return;
    const win = raw.slice(Math.max(0, idx-radius), Math.min(raw.length, idx+radius));
    collectUrlCandidatesFromText(win, pageUrl).forEach(u=>{
      if(!isWrongMagnificCandidate(u, pageUrl, win)) out.push({url:u, score:magnificExactScore(u,pageUrl,win)+50000});
    });
  };
  let pos = raw.indexOf(info.id);
  while(pos>=0){ addWindow(pos); pos = raw.indexOf(info.id, pos+info.id.length); }
  const low=raw.toLowerCase();
  pos = low.indexOf(info.slug);
  while(pos>=0){ addWindow(pos); pos = low.indexOf(info.slug, pos+info.slug.length); }
  out.sort((a,b)=>b.score-a.score);
  return [...new Set(out.map(x=>x.url))];
}
function filterExactPageCandidates(list, pageUrl){
  const info = magnificInfo(pageUrl);
  if(!info) return list;
  return list.filter(u=>!isWrongMagnificCandidate(u, pageUrl));
}

function directFromKnownPageUrl(input){
  // Safe known-source shortcuts can be added here later.
  // Magnific is intentionally disabled here because its page slug/id is not always
  // the real img.magnific.com file slug/id; generating that URL caused 404 errors.
  return '';
}

function extractDirectImageUrlFromAnyInput(input){
  const urls = collectUrlCandidatesFromText(input);
  return urls.find(isLikelyDirectImageUrl) || '';
}

async function tryBackendResolve(url){
  const endpoint = (settings.backendUrl||'').trim();
  if(!endpoint) return '';
  const payloads = [{url},{imageUrl:url},{pageUrl:url},{input:url}];
  let last='';
  for(const body of payloads){
    try{
      const r = await fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
      const ct = r.headers.get('content-type')||'';
      if(!r.ok){ last = 'backend '+r.status; continue; }
      if(ct.includes('application/json')){
        const j = await r.json().catch(()=>({}));
        const direct = j.url || j.webpUrl || j.secure_url || j.imageUrl || j.source || j.result || j.cdnUrl || pickUrlFromAnyJson(j);
        if(direct) return direct;
      } else {
        const txt = await r.text().catch(()=> '');
        const m = txt.match(/https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp|gif|avif)(?:\?[^\s"'<>]*)?/i);
        if(m) return m[0];
      }
    }catch(e){ last=e.message; }
  }
  return '';
}
async function extractImageFromPageUrl(pageUrl){
  let html = '';
  try{ html = await fetchViaBackground(pageUrl, true); }
  catch(bgErr){
    const r = await fetch(pageUrl, {cache:'no-store', credentials:'omit'});
    if(!r.ok) throw new Error('page loading '+r.status);
    html = await r.text();
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const selectors = [
    'meta[property="og:image:secure_url"]','meta[property="og:image"]','meta[name="twitter:image"]','meta[name="twitter:image:src"]','link[rel="image_src"]'
  ];
  for(const sel of selectors){
    const el = doc.querySelector(sel);
    const val = el?.content || el?.href;
    if(val && !isWrongMagnificCandidate(val, pageUrl, sel)) return absolutizeUrl(val, pageUrl);
  }
  for(const script of [...doc.querySelectorAll('script[type="application/ld+json"]')]){
    try{
      const data = JSON.parse(script.textContent||'{}');
      const direct = pickUrlFromAnyJson(data);
      if(direct && !isWrongMagnificCandidate(direct, pageUrl, script.textContent||'')) return absolutizeUrl(direct, pageUrl);
    }catch(e){}
  }
  const imgs=[...doc.images].map(img=>({
    src: img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || '',
    context: (img.outerHTML||'') + ' ' + (img.closest('a')?.href||''),
    w: parseInt(img.getAttribute('width')||img.naturalWidth||'0',10),
    h: parseInt(img.getAttribute('height')||img.naturalHeight||'0',10)
  })).filter(x=>x.src && !/logo|icon|avatar|sprite/i.test(x.src) && !isWrongMagnificCandidate(x.src, pageUrl, x.context));
  imgs.sort((a,b)=>(b.w*b.h)-(a.w*a.h));
  if(imgs[0]) return absolutizeUrl(imgs[0].src, pageUrl);
  const exactHtml = collectMagnificExactCandidates(html, pageUrl).find(u=>isLikelyDirectImageUrl(u));
  if(exactHtml) return absolutizeUrl(exactHtml, pageUrl);
  const fromHtml = collectUrlCandidatesFromText(html, pageUrl).find(u=>isLikelyDirectImageUrl(u) && !isWrongMagnificCandidate(u, pageUrl, u));
  if(fromHtml) return absolutizeUrl(fromHtml, pageUrl);
  throw new Error('no image found on page');
}

async function extractImageViaReader(pageUrl){
  const readerUrl = 'https://r.jina.ai/http://' + String(pageUrl).replace(/^https?:\/\//i,'');
  const txt = await fetchViaBackground(readerUrl, true).catch(async()=>{
    const r = await fetch(readerUrl, {cache:'no-store', credentials:'omit'});
    if(!r.ok) throw new Error('reader '+r.status);
    return await r.text();
  });
  const exact = collectMagnificExactCandidates(txt, pageUrl).find(u=>isLikelyDirectImageUrl(u));
  if(exact) return absolutizeUrl(exact, pageUrl);
  const direct = collectUrlCandidatesFromText(txt, pageUrl).find(u=>isLikelyDirectImageUrl(u) && !isWrongMagnificCandidate(u, pageUrl, u));
  if(direct) return absolutizeUrl(direct, pageUrl);
  throw new Error('no image found by reader');
}

async function resolveInputUrlForUpload(url){
  url = decodeDeep(url);
  if(isLikelyDirectImageUrl(url)) return url;

  // IMPORTANT FIX:
  // Magnific/Freepik viewer links can contain an OLD/Wrong encoded query image.
  // So first open the real page and read the actually visible image from the rendered page.
  try{
    const viaTab = await scrapeImageByOpeningTab(url);
    if(viaTab) return viaTab;
  }catch(e){}

  try{
    const viaHtml = await extractImageFromPageUrl(url);
    if(viaHtml) return viaHtml;
  }catch(e){}

  try{
    const viaReader = await extractImageViaReader(url);
    if(viaReader) return viaReader;
  }catch(e){}

  try{
    const viaBackend = await tryBackendResolve(url);
    if(viaBackend && !isWrongMagnificCandidate(viaBackend, url)) return viaBackend;
  }catch(e){}

  // Known page resolver is only for safe sources. Magnific shortcut is disabled because it can create 404 URLs.
  const knownPageDirect = directFromKnownPageUrl(url);
  if(knownPageDirect) return knownPageDirect;

  // Last fallback only: nested direct image URLs from pasted text.
  // This is intentionally after page/known/backend extraction to avoid wrong-page images.
  const nestedDirect = extractDirectImageUrlFromAnyInput(url);
  if(nestedDirect && !isWrongMagnificCandidate(nestedDirect, url)) return nestedDirect;

  throw new Error('No image found on page');
}

function webpCloudinaryUrl(url){
  if(!url) return '';
  if(url.includes('/image/upload/') && !url.includes('/f_webp,')) return url.replace('/image/upload/','/image/upload/f_webp,fl_lossless,q_100/').replace(/\.(jpg|jpeg|png|gif|avif|webp)(\?.*)?$/i,'.webp');
  return url;
}
async function uploadToCloudinary(input, title='image'){
  if(!settings.cloudName || !settings.uploadPreset) throw new Error('Cloudinary setup missing');
  const fd = new FormData();
  fd.append('upload_preset', settings.uploadPreset);
  if(settings.folderName) fd.append('folder', settings.folderName);
  fd.append('public_id', shortPublicId());
  if(input instanceof Blob){
    fd.append('file', input, 'source-image');
  }else{
    if(input instanceof Blob){ fd.append('file', input, 'source-image.jpg'); } else { fd.append('file', input); }
  }
  const r = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(settings.cloudName)}/image/upload`, {method:'POST', body:fd});
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message || 'Cloudinary upload failed');
  const finalUrl = webpCloudinaryUrl(j.secure_url || j.url);
  return {url: finalUrl, raw:j.secure_url || j.url};
}
function dataUrlToBlob(dataUrl){
  const [head, body] = dataUrl.split(',');
  const mime = (head.match(/data:([^;]+)/)||[])[1] || 'image/png';
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  return new Blob([arr], {type:mime});
}
async function imageSourceToUploadable(src){
  if(!src) throw new Error('No image source returned');
  if(src.startsWith('data:image/')) return dataUrlToBlob(src);
  if(/^https?:\/\//i.test(src)) return src;
  if(/^[A-Za-z0-9+/=\s]+$/.test(src) && src.length>500) return dataUrlToBlob('data:image/png;base64,'+src.replace(/\s/g,''));
  throw new Error('Unsupported image response');
}

async function downloadWebp(url, title='webp-image'){
  try{
    if(!url) throw new Error('Download URL missing');
    const filename = cleanFileName(title || 'webp-image') + '.webp';
    let blobUrl = '';
    try{
      const r = await fetch(url, {mode:'cors', cache:'no-store'});
      if(!r.ok) throw new Error('fetch '+r.status);
      const blob = await r.blob();
      // Keep the same Cloudinary q_100 WebP file. Do not resize or recompress locally.
      const webpBlob = blob.type === 'image/webp' ? blob : new Blob([blob], {type:'image/webp'});
      blobUrl = URL.createObjectURL(webpBlob);
    }catch(fetchErr){
      // Cloudinary attachment fallback still keeps original transformed HD WebP URL quality.
      blobUrl = url.includes('/image/upload/')
        ? url.replace('/image/upload/','/image/upload/fl_attachment/').replace(/\.(jpg|jpeg|png|gif|avif)(\?.*)?$/i,'.webp')
        : url;
    }
    if(chrome?.downloads?.download){
      chrome.downloads.download({url: blobUrl, filename, saveAs:true}, ()=>{
        if(chrome.runtime.lastError){
          const a=document.createElement('a'); a.href=blobUrl; a.download=filename; a.click();
        }
        if(blobUrl.startsWith('blob:')) setTimeout(()=>URL.revokeObjectURL(blobUrl), 30000);
      });
    }else{
      const a=document.createElement('a'); a.href=blobUrl; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
      if(blobUrl.startsWith('blob:')) setTimeout(()=>URL.revokeObjectURL(blobUrl), 30000);
    }
  }catch(e){
    setStatus('Download error: '+e.message,'Open button se image khol kar manually save bhi kar sakte hain.',true);
  }
}

function extractImageSource(data){
  const found = [];
  const push = (x)=>{ if(!x) return; if(typeof x === 'string') found.push(x); else if(x.url) found.push(x.url); else if(x.image_url?.url) found.push(x.image_url.url); else if(x.b64_json) found.push('data:image/png;base64,'+x.b64_json); else if(x.data) found.push(x.data); };
  if(Array.isArray(data.images)) data.images.forEach(push);
  if(Array.isArray(data.data)) data.data.forEach(push);
  for(const ch of (data.choices||[])){
    const msg = ch.message || {};
    if(Array.isArray(msg.images)) msg.images.forEach(push);
    if(msg.image_url) push(msg.image_url);
    if(Array.isArray(msg.content)) msg.content.forEach(part=>{ push(part.image_url); push(part); if(part.type==='text') scanText(part.text); });
    if(typeof msg.content === 'string') scanText(msg.content);
  }
  function scanText(text){
    if(!text) return;
    const md = [...String(text).matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m=>m[1]);
    md.forEach(push);
    const urls = String(text).match(/https?:\/\/\S+\.(?:png|jpg|jpeg|webp)(?:\?\S*)?/gi) || [];
    urls.forEach(u=>push(u.replace(/[)\]]$/,'')));
    const dataUrls = String(text).match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) || [];
    dataUrls.forEach(push);
  }
  return found.find(x=>x && (x.startsWith('data:image/') || /^https?:\/\//i.test(x) || x.length>500));
}
function titleTokens(title){
  return normalizeTitle(title).toLowerCase().replace(/https?:\/\/\S+/g,' ').replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(Boolean);
}
function visualBriefFromTitle(title){
  const t = normalizeTitle(title).toLowerCase();
  const baseAvoid = 'any readable text, letters, words, numbers, fake watermark, fake logo, signature, caption, poster typography, UI text, brand marks, distorted face, low quality, blur, random animals';
  if(/\b(location|locator|gps|map|maps|tracking|privacy|accuracy|pin location|find location|unflte location|unfilte location)\b/.test(t)){
    return {cat:'location',
      subject:'secure GPS location finder app concept, smartphone showing a clean map without readable labels, glowing route line, location pins, privacy shield, accuracy rings, satellite grid, cyber security atmosphere',
      avoid:baseAvoid + ', human portrait, fashion model, unrelated city portrait'};
  }
  if(/social media|influencer|sensation|creator|tiktok|instagram|youtube|viral|online personality|profile|journey|biography|celebrity|famous|sydneebeeyxo/.test(t)){
    return {cat:'social',
      subject:'cinematic social media creator journey concept, generic digital creator seen from back or side, smartphone in hand, camera setup, floating abstract app notification icons with no letters, colorful creator studio, online fame and audience growth atmosphere',
      avoid:baseAvoid + ', written name, title text, readable app logos, cat, animal, random street statue'};
  }
  if(/call recorder|phone recorder|voice recorder|dialer|podcast|audio recording|recording|unflte call|unfilte call/.test(t)){
    return {cat:'audio', subject:'smartphone call recorder concept, microphone, waveform, headphones, glowing audio timeline, clean dark tech desk, privacy recording interface without text', avoid:baseAvoid + ', unrelated portrait'};
  }
  if(/watch|smartwatch|huawei|fit 5|fitness tracker/.test(t)) return {cat:'smartwatch',subject:'premium smartwatch lifestyle product scene, fitness tracking visual, AMOLED watch glow, sports health dashboard without readable text',avoid:baseAvoid};
  if(/weton|javanese|calendar|tradition/.test(t)) return {cat:'culture',subject:'Javanese traditional calendar concept, cultural pattern, warm ceremonial objects, heritage atmosphere, elegant editorial layout',avoid:baseAvoid};
  if(/career|karriere|job|hiring|resume/.test(t)) return {cat:'career',subject:'professional career page concept, laptop, job search dashboard without text, office desk, clean business atmosphere',avoid:baseAvoid};
  if(/ai image|image generator|artificial intelligence|automation|software|api|coding|dashboard|tool/.test(t)) return {cat:'ai',subject:'AI software tool concept, neural network, creative digital canvas, modern dashboard shapes without text, glowing computer workspace',avoid:baseAvoid};
  if(/mobile|app|android|iphone|phone/.test(t)) return {cat:'mobile',subject:'modern mobile app concept, smartphone with clean abstract interface without text, premium technology background',avoid:baseAvoid};
  if(/fashion|style|outfit|dress|beauty/.test(t)) return {cat:'fashion',subject:'premium fashion editorial scene, stylish outfit details, clean studio lighting, magazine quality without text',avoid:baseAvoid};
  if(/travel|hotel|flight|tour|city/.test(t)) return {cat:'travel',subject:'premium travel editorial scene, destination view, map pins, suitcase, city atmosphere, cinematic landscape',avoid:baseAvoid};
  if(/food|recipe|restaurant|coffee/.test(t)) return {cat:'food',subject:'premium food editorial photography, appetizing dish or restaurant mood, soft natural light, clean composition',avoid:baseAvoid};
  if(/gaming|game|console|player|esports/.test(t)) return {cat:'gaming',subject:'premium gaming featured image, controller, neon gaming setup, esports atmosphere, no readable screen text',avoid:baseAvoid};
  if(/finance|money|loan|bank|trading|crypto|business|startup/.test(t)) return {cat:'finance',subject:'premium fintech/business analytics concept, charts as abstract shapes without numbers, laptop, money growth atmosphere',avoid:baseAvoid};
  return {cat:'editorial', subject:'premium editorial feature image that clearly visualizes the main object, tool, person type, or action implied by the article topic', avoid:baseAvoid};
}
function buildAIPrompt(title, idx, total){
  const brief = visualBriefFromTitle(title);
  const seed = `${idx+1}/${total}-${Math.random().toString(36).slice(2,8)}`;
  return `Ultra sharp professional featured image. Main visual subject: ${brief.subject}.

Style: high-end AI stock image, realistic cinematic lighting, crisp details, HD, strong depth of field, clean 16:9 landscape composition, editorial blog hero image, modern premium aesthetic, no crop issues.

Hard rules: image must contain absolutely NO readable text, NO letters, NO numbers, NO title words, NO watermark, NO logos, NO fake app names, NO captions, NO typography. Use only abstract icon shapes if icons are needed. Avoid: ${brief.avoid}.

Variation: ${seed}. Return image only.`;
}
async function improvePromptWithFreeModel(title, index, total){
  return buildAIPrompt(title,index,total);
}
function pollinationsUrlFromPrompt(prompt, title, index, salt=''){
  // Do not include the raw article title in image prompt URL. Raw titles/names make free models write ugly text on the image.
  const clean = prompt.replace(/\n+/g,' ').replace(/[^a-zA-Z0-9 ,.:;!?()\-]/g,' ').replace(/\s+/g,' ').slice(0,1050);
  const negative = 'text, letters, words, numbers, logo, watermark, caption, typography, signature, blurry, low quality, low resolution, distorted, bad anatomy, duplicate face, poster, label, written name';
  const seed = Math.abs(hashCode(normalizeTitle(title)+'-'+index+'-'+salt+'-'+Date.now())) % 999999999;
  return 'https://image.pollinations.ai/prompt/' + encodeURIComponent(clean) +
    `?width=1536&height=864&seed=${seed}&nologo=true&private=true&safe=true&enhance=true&model=flux&negative=${encodeURIComponent(negative)}`;
}
async function callOpenRouterForImage(title, index, total){
  const prompt = await improvePromptWithFreeModel(title,index,total);
  let lastErr = '';

  if(settings.openRouterKey){
    const models = getModels().filter(m=>!looksLikeTextOnlyModel(m));
    for(let attempt=0; attempt<models.length && !stopFlag; attempt++){
      const model = models[(index + attempt) % models.length];
      try{
        const body = {
          model,
          messages:[{role:'user', content: prompt}],
          modalities: ['image','text'],
          image_config: { aspect_ratio: '16:9', width: 1536, height: 864 }
        };
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method:'POST',
          headers:{
            'Authorization':'Bearer '+settings.openRouterKey,
            'Content-Type':'application/json',
            'HTTP-Referer':'https://webp-cdn-source-maker.local',
            'X-Title':'WebP CDN Source Maker'
          },
          body:JSON.stringify(body)
        });
        const j = await r.json().catch(()=>({}));
        if(!r.ok) throw new Error(j.error?.message || `${r.status} ${r.statusText}`);
        const src = extractImageSource(j);
        if(!src) throw new Error('No image returned by image model');
        return {src, model};
      } catch(e){
        lastErr = `${model}: ${e.message}`;
        console.debug('Image model failed', lastErr);
      }
    }
  }

  return {src: pollinationsUrlFromPrompt(prompt, title, index, 'main'), model: lastErr ? 'free-hd-fallback' : 'free-hd'};
}
function hashCode(str){
  let h=0; for(let i=0;i<str.length;i++){ h=((h<<5)-h)+str.charCodeAt(i); h|=0; } return h;
}


function keywordQueryFromTitle(title){
  const t = normalizeTitle(title).toLowerCase();
  if(/\b(location|locator|gps|map|maps|tracking|privacy|accuracy|unflte location|unfilte location|pin location|find location)\b/.test(t)) return 'gps,map,location-pin,smartphone,privacy';
  if(/call recorder|phone recorder|voice recorder|dialer|podcast|audio recording|recording|unfilte|unflte/.test(t)) return 'smartphone,microphone,podcast,audio-recorder';
  if(/watch|smartwatch|huawei|fit 5|fitness tracker/.test(t)) return 'smartwatch,fitness,technology';
  if(/weton|javanese|calendar|tradition/.test(t)) return 'javanese,culture,calendar';
  if(/career|karriere|job|hiring|resume/.test(t)) return 'career,office,laptop';
  if(/ai image|image generator|artificial intelligence|automation/.test(t)) return 'artificial-intelligence,computer';
  if(/mobile|app|android|iphone|phone/.test(t)) return 'smartphone,app,technology';
  if(/fashion|style|outfit|dress|beauty/.test(t)) return 'fashion,style';
  if(/travel|hotel|flight|tour|city/.test(t)) return 'travel,city';
  if(/food|recipe|restaurant|coffee/.test(t)) return 'food,restaurant';
  const words = t.replace(/https?:\/\/\S+/g,' ').replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>w.length>3 && !['guide','features','complete','comprehensive','what','with','home','page','best','free','maximizing'].includes(w)).slice(0,4);
  return (words.length ? words.join(',') : 'technology,editorial');
}
function stockImageCandidates(title,index){
  const q = keywordQueryFromTitle(title);
  const seed = Math.abs(hashCode(normalizeTitle(title)+'-stock-'+index)) % 999999;
  const cleanQ = encodeURIComponent(q.replace(/,/g,','));
  // High quality stock-photo fallback. Avoid loremflickr because it can return unrelated cats/animals.
  return [
    `https://source.unsplash.com/1280x720/?${cleanQ}`,
    `https://source.unsplash.com/1600x900/?${cleanQ},editorial,technology`,
    `https://picsum.photos/seed/${encodeURIComponent(q+'-'+seed)}/1792/1008`
  ];
}

async function firstWorkingStockBlob(title,index){
  const list = stockImageCandidates(title,index);
  let last='';
  for(const u of list){
    try{ return {blob: await urlToBlobWithTimeout(u, 25000), src:u, label:'topic-stock-fallback'}; }
    catch(e){ last=e.message; console.debug('stock fallback failed', u, e.message); }
  }
  throw new Error(last || 'stock failed');
}

function categoryFromTitle(title){
  const t = normalizeTitle(title).toLowerCase();
  if(/\b(location|locator|gps|map|maps|tracking|privacy|accuracy|unflte location|unfilte location|pin location|find location)\b/.test(t)) return 'location';
  if(/glock|gun|firearm|pistol|rifle|weapon|tactical|shooting/.test(t)) return 'tactical';
  if(/bike|motorcycle|engine|oil|10w|0w|5w|synthetic|garage/.test(t)) return 'motor';
  if(/fashion|style|outfit|dress|clothing|streetwear|handbag|beauty|makeup/.test(t)) return 'fashion';
  if(/call recorder|phone recorder|voice recorder|dialer|podcast|audio recording|recording/.test(t)) return 'audio';
  if(/ai|artificial intelligence|automation|software|app|dashboard|saas|tech|coding|python|api/.test(t)) return 'tech';
  if(/finance|money|loan|bank|trading|crypto|business|startup|fundraising/.test(t)) return 'business';
  if(/travel|hotel|flight|paris|dubai|canada|tour|city/.test(t)) return 'travel';
  if(/food|recipe|restaurant|coffee|pizza|kitchen/.test(t)) return 'food';
  if(/fitness|gym|workout|health|running|sport/.test(t)) return 'fitness';
  if(/social media|influencer|sensation|creator|tiktok|instagram|youtube|viral|online personality|sydneebeeyxo/.test(t)) return 'social';
  if(/biography|celebrity|actor|singer|rhett|hartzog|profile|life story/.test(t)) return 'bio';
  return 'editorial';
}
function colorSet(cat, i){
  const sets = {
    tactical: [['#0b1018','#1b2634','#46515f'],['#111827','#2b2f38','#5d697a'],['#090d12','#263240','#758195']],
    motor: [['#111827','#2d3748','#f59e0b'],['#101820','#243b53','#38bdf8'],['#18181b','#3f3f46','#f97316']],
    fashion: [['#160b1f','#7c3aed','#f0abfc'],['#111827','#be185d','#fda4af'],['#1f102b','#db2777','#f9a8d4']],
    audio: [['#08111f','#3b82f6','#22d3ee'],['#111827','#7c3aed','#a78bfa'],['#0f172a','#0ea5e9','#67e8f9']],
    location: [['#06111f','#0f766e','#22d3ee'],['#0b1220','#2563eb','#34d399'],['#111827','#0891b2','#a7f3d0']],
    tech: [['#06121f','#0e7490','#22d3ee'],['#0f172a','#2563eb','#7dd3fc'],['#111827','#6366f1','#a78bfa']],
    business: [['#0f172a','#334155','#f8fafc'],['#111827','#0f766e','#5eead4'],['#171717','#525252','#eab308']],
    travel: [['#0c4a6e','#38bdf8','#fde68a'],['#164e63','#2dd4bf','#fef3c7'],['#1e3a8a','#93c5fd','#fb923c']],
    food: [['#3b1706','#a16207','#fed7aa'],['#431407','#ea580c','#fde68a'],['#1c1917','#84cc16','#fef3c7']],
    fitness: [['#052e16','#16a34a','#bbf7d0'],['#111827','#ef4444','#fecaca'],['#082f49','#0284c7','#bae6fd']],
    social: [['#0b1020','#7c3aed','#22d3ee'],['#111827','#db2777','#f97316'],['#07111f','#2563eb','#f0abfc']],
    bio: [['#18181b','#57534e','#f5f5f4'],['#111827','#7c2d12','#fed7aa'],['#0f172a','#4338ca','#c7d2fe']],
    editorial: [['#111827','#334155','#94a3b8'],['#0f172a','#0e7490','#67e8f9'],['#18181b','#7c3aed','#ddd6fe']]
  };
  return (sets[cat]||sets.editorial)[i % (sets[cat]||sets.editorial).length];
}
async function urlToBlobWithTimeout(url, ms=65000){
  try{
    const b = await fetchViaBackground(url, false);
    if((b.type||'').startsWith('image/') && b.size > 10000) return b;
  }catch(e){}
  const ac = new AbortController();
  const timer = setTimeout(()=>ac.abort(), ms);
  try{
    const r = await fetch(url, {signal: ac.signal, mode:'cors', cache:'no-store'});
    if(!r.ok) throw new Error('image fetch '+r.status);
    const b = await r.blob();
    if(!b.type.startsWith('image/')) throw new Error('not image');
    if(b.size < 10000) throw new Error('image too small');
    return b;
  } finally { clearTimeout(timer); }
}

async function cleanFeaturedImageBlob(blob){
  // Free image engines often add fake text/watermarks near the top-left or bottom edge.
  // This routine crops only the risky edges, reframes to 16:9 HD, and applies light sharpening.
  try{
    if(!(blob instanceof Blob) || !blob.type.startsWith('image/')) return blob;
    const img = await new Promise((resolve,reject)=>{
      const u = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = ()=>{URL.revokeObjectURL(u); resolve(im);};
      im.onerror = ()=>{URL.revokeObjectURL(u); reject(new Error('image decode failed'));};
      im.src = u;
    });
    const targetW = IMAGE_TARGET_W, targetH = IMAGE_TARGET_H;
    const edgeTop = Math.round(img.naturalHeight * 0.18);
    const edgeBottom = Math.round(img.naturalHeight * 0.20);
    const edgeLeft = Math.round(img.naturalWidth * 0.06);
    const edgeRight = Math.round(img.naturalWidth * 0.04);
    let sx=edgeLeft, sy=edgeTop, sw=img.naturalWidth-edgeLeft-edgeRight, sh=img.naturalHeight-edgeTop-edgeBottom;
    const ratio = targetW/targetH;
    if(sw/sh > ratio){ const nw = Math.round(sh*ratio); sx += Math.round((sw-nw)/2); sw = nw; }
    else { const nh = Math.round(sw/ratio); sy += Math.round((sh-nh)/2); sh = nh; }
    const canvas = document.createElement('canvas');
    canvas.width = targetW; canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
    // subtle contrast/sharpness pass
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.035;
    ctx.drawImage(canvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    return await new Promise(resolve=>canvas.toBlob(b=>resolve(b||blob),'image/jpeg',0.88));
  }catch(e){
    console.debug('image clean skipped', e.message);
    return blob;
  }
}
function makeLocalFallbackBlob(title, index, total){
  return new Promise((resolve)=>{
    const cat = categoryFromTitle(title);
    const [a,b,c] = colorSet(cat,index);
    const canvas = document.createElement('canvas');
    canvas.width = IMAGE_TARGET_W; canvas.height = IMAGE_TARGET_H;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0,0,IMAGE_TARGET_W,IMAGE_TARGET_H);
    g.addColorStop(0,a); g.addColorStop(.55,b); g.addColorStop(1,c);
    ctx.fillStyle = g; ctx.fillRect(0,0,IMAGE_TARGET_W,IMAGE_TARGET_H);
    ctx.globalAlpha = .06;
    for(let k=0;k<10;k++){
      ctx.beginPath();
      ctx.arc((k*173 + index*91)%IMAGE_TARGET_W, (k*97 + index*53)%IMAGE_TARGET_H, 60+(k%6)*35, 0, Math.PI*2);
      ctx.fillStyle = k%2 ? '#ffffff' : '#000000';
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.strokeStyle = 'rgba(255,255,255,.38)';
    ctx.lineWidth = 8;
    function rounded(x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
    // category-specific premium icon/scene, no readable text
    ctx.save();
    ctx.translate(896,504);
    ctx.scale(1.35,1.35);
    if(cat==='tactical'){
      ctx.rotate(-0.12); rounded(-300,-35,600,70,35); ctx.fill(); ctx.stroke(); rounded(40,30,120,150,34); ctx.fill(); ctx.stroke(); rounded(-165,36,110,72,30); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-360,-20); ctx.lineTo(-470,-70); ctx.lineTo(-455,35); ctx.closePath(); ctx.fill();
    } else if(cat==='motor'){
      ctx.beginPath(); ctx.arc(-220,120,95,0,Math.PI*2); ctx.arc(230,120,95,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-220,120); ctx.lineTo(-60,-40); ctx.lineTo(150,-38); ctx.lineTo(230,120); ctx.lineTo(10,120); ctx.lineTo(-60,-40); ctx.stroke(); rounded(-20,-100,210,105,22); ctx.fill(); ctx.stroke();
    } else if(cat==='fashion'){
      ctx.beginPath(); ctx.moveTo(0,-210); ctx.bezierCurveTo(-100,-90,-150,150,-230,230); ctx.lineTo(230,230); ctx.bezierCurveTo(150,150,100,-90,0,-210); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.beginPath(); ctx.arc(0,-240,45,0,Math.PI*2); ctx.stroke();
    } else if(cat==='location'){
      // smartphone map + GPS pin + privacy shield, no text
      rounded(-185,-245,370,490,54); ctx.fill(); ctx.stroke();
      ctx.globalAlpha=.45;
      for(let y=-170;y<=170;y+=70){ctx.beginPath();ctx.moveTo(-145,y);ctx.bezierCurveTo(-50,y-35,50,y+35,145,y);ctx.stroke()}
      for(let x=-120;x<=120;x+=80){ctx.beginPath();ctx.moveTo(x,-190);ctx.lineTo(x,190);ctx.stroke()}
      ctx.globalAlpha=1;
      ctx.beginPath(); ctx.arc(0,-20,70,0,Math.PI*2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0,-125); ctx.bezierCurveTo(-85,-105,-90,-5,0,105); ctx.bezierCurveTo(90,-5,85,-105,0,-125); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0,-45,30,0,Math.PI*2); ctx.stroke();
      ctx.globalAlpha=.55; ctx.beginPath(); ctx.arc(205,-110,72,0,Math.PI*2); ctx.stroke(); rounded(170,-103,70,88,18); ctx.stroke(); ctx.globalAlpha=1;
    } else if(cat==='audio'){
      rounded(-145,-245,290,490,48); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0,-105,62,0,Math.PI*2); ctx.stroke();
      for(let x=-85;x<=85;x+=28){ctx.beginPath();ctx.moveTo(x,60-Math.abs(x)*0.45);ctx.lineTo(x,155+Math.abs(x)*0.25);ctx.stroke()}
      ctx.beginPath();ctx.arc(-260,-20,95,0,Math.PI*2);ctx.stroke(); ctx.beginPath();ctx.arc(260,-20,95,0,Math.PI*2);ctx.stroke();
    } else if(cat==='tech'){
      rounded(-310,-170,620,340,38); ctx.stroke(); for(let x=-240;x<=240;x+=80){ctx.beginPath();ctx.moveTo(x,-120);ctx.lineTo(x,120);ctx.stroke()} for(let y=-100;y<=100;y+=50){ctx.beginPath();ctx.moveTo(-260,y);ctx.lineTo(260,y);ctx.stroke()} ctx.beginPath();ctx.arc(0,0,74,0,Math.PI*2);ctx.stroke();
    } else if(cat==='social'){
      // premium creator/social-media concept: no readable text, only icons and interface shapes
      rounded(-360,-190,720,380,46); ctx.stroke();
      ctx.beginPath(); ctx.arc(0,-55,82,0,Math.PI*2); ctx.fill(); ctx.stroke();
      rounded(-150,40,300,220,90); ctx.fill(); ctx.stroke();
      for(let k=0;k<18;k++){
        const ang=(k/18)*Math.PI*2 + index*.35;
        const rr=250+(k%3)*35;
        const x=Math.cos(ang)*rr, y=Math.sin(ang)*rr*.58;
        ctx.globalAlpha=.55;
        ctx.beginPath(); ctx.arc(x,y,24+(k%2)*6,0,Math.PI*2); ctx.fill(); ctx.stroke();
        ctx.globalAlpha=1;
      }
      ctx.beginPath(); ctx.moveTo(-330,150); ctx.bezierCurveTo(-130,-40,160,220,340,-120); ctx.stroke();
    } else if(cat==='bio'){
      ctx.beginPath(); ctx.arc(0,-95,88,0,Math.PI*2); ctx.fill(); ctx.stroke(); rounded(-170,15,340,240,80); ctx.fill(); ctx.stroke(); ctx.globalAlpha=.38; ctx.beginPath(); ctx.arc(0,0,250,0,Math.PI*2); ctx.stroke(); ctx.globalAlpha=1;
    } else if(cat==='business'){
      for(let x=-260;x<=260;x+=130){rounded(x,-60,70,250,18);ctx.fill();ctx.stroke()} ctx.beginPath();ctx.moveTo(-320,170);ctx.lineTo(330,170);ctx.stroke(); ctx.beginPath();ctx.moveTo(-310,80);ctx.lineTo(-110,-20);ctx.lineTo(70,45);ctx.lineTo(300,-120);ctx.stroke();
    } else {
      rounded(-310,-180,620,360,40); ctx.stroke(); ctx.beginPath();ctx.arc(-110,0,120,0,Math.PI*2);ctx.stroke(); ctx.beginPath();ctx.arc(135,0,120,0,Math.PI*2);ctx.stroke();
    }
    ctx.restore();
    // add light streaks for premium look
    ctx.globalAlpha=.55; ctx.strokeStyle='rgba(255,255,255,.25)'; ctx.lineWidth=2;
    for(let k=0;k<9;k++){ctx.beginPath();ctx.moveTo(-180+k*250,1015);ctx.bezierCurveTo(380+k*80,620,700+k*45,310,1810,30+k*45);ctx.stroke();}
    ctx.globalAlpha=1;
    canvas.toBlob(blob=>resolve(blob),'image/jpeg',0.88);
  });
}

function cardTemplate(id, title){
  return `<div class="imageCard" id="${id}"><img alt=""><div class="imageBody"><div class="imageTitle">${escapeHtml(title)}</div><div class="imageState">Generating • creating image...</div><div class="actions"><button disabled>Copy URL</button><button disabled>Copy HTML</button><button disabled>Open</button></div></div></div>`;
}
function updateCard(id, data){
  const el = document.getElementById(id); if(!el) return;
  if(data.preview) el.querySelector('img').src = data.preview;
  if(data.title) el.querySelector('.imageTitle').textContent = data.title;
  if(data.state) el.querySelector('.imageState').textContent = data.state;
  if(data.url){
    const html = `<img src="${data.url}" alt="" loading="lazy">`;
    el.querySelector('.actions').innerHTML = `<button data-copy="url">Copy URL</button><button data-copy="html">Copy HTML</button><button data-download>Download WebP</button><button data-open>Open</button>`;
    el.querySelector('[data-copy="url"]').onclick = (e)=>copyWithFeedback(e.currentTarget, data.url, 'URL Copied ✓');
    el.querySelector('[data-copy="html"]').onclick = (e)=>copyWithFeedback(e.currentTarget, html, 'HTML Copied ✓');
    el.querySelector('[data-download]').onclick = (e)=>downloadWithFeedback(e.currentTarget, data.url, data.title || el.querySelector('.imageTitle')?.textContent || 'webp-image');
    el.querySelector('[data-open]').onclick = (e)=>openWithFeedback(e.currentTarget, data.url);
  }
}
function addHistory(item){
  history.unshift(item);
  history = history.slice(0, MAX_HISTORY_ITEMS);
  saveLocal({history});
  renderHistory();
}
function renderHistory(){
  if(!els.historyList) return;
  if(!history.length){els.historyList.innerHTML='<div class="empty">No previous images yet.</div>'; return;}
  const visible = history.slice(0, MAX_RENDERED_HISTORY);
  // Performance mode: do not auto-load previous CDN thumbnails on extension startup.
  // Old versions loaded many remote images at once and could freeze weak Chrome profiles.
  els.historyList.innerHTML = visible.map((h,i)=>`<div class="historyItem noThumb"><div class="thumbLite">IMG</div><div><div class="historyTitle">${escapeHtml(h.title||'Image')}</div><div class="historyMeta">${new Date(h.time||Date.now()).toLocaleString()}</div><div class="actions historyActions" style="margin-top:8px"><button data-copyh="${i}">Copy</button><button data-downh="${i}">Download</button><button data-openh="${i}">Open</button></div></div><button class="xBtn" data-delh="${i}">×</button></div>`).join('') + (history.length>visible.length ? `<div class="empty">Showing latest ${visible.length}. Older items hidden for speed.</div>` : '');
  els.historyList.querySelectorAll('[data-copyh]').forEach(b=>b.onclick=(e)=>copyWithFeedback(e.currentTarget, history[+b.dataset.copyh].url, 'Copied ✓'));
  els.historyList.querySelectorAll('[data-downh]').forEach(b=>b.onclick=(e)=>downloadWithFeedback(e.currentTarget, history[+b.dataset.downh].url, history[+b.dataset.downh].title || 'webp-image'));
  els.historyList.querySelectorAll('[data-openh]').forEach(b=>b.onclick=(e)=>openWithFeedback(e.currentTarget, history[+b.dataset.openh].url));
  els.historyList.querySelectorAll('[data-delh]').forEach(b=>b.onclick=()=>{history.splice(+b.dataset.delh,1); saveLocal({history}); renderHistory();});
}


function stockQueriesForTitle(title){
  const t = normalizeTitle(title).toLowerCase();
  if(/social media|influencer|sensation|creator|viral|online personality|sydneebeeyxo/.test(t)) return ['social media influencer creator','digital creator social media','woman social media icons','content creator studio'];
  if(/location|locator|gps|map|tracking|privacy|accuracy/.test(t)) return ['gps map smartphone privacy','location tracking app map','cyber security map pins','navigation map phone'];
  if(/call recorder|voice recorder|podcast|recording/.test(t)) return ['smartphone audio recording microphone','podcast microphone phone','voice recorder app'];
  if(/fashion|style|outfit|beauty/.test(t)) return ['fashion editorial model','premium fashion outfit'];
  if(/finance|money|bank|trading|crypto/.test(t)) return ['fintech dashboard business','finance analytics laptop'];
  if(/gaming|game|esports/.test(t)) return ['gaming setup esports','neon gaming controller'];
  if(/travel|hotel|tour|city/.test(t)) return ['travel city suitcase','premium travel destination'];
  if(/food|recipe|restaurant|coffee/.test(t)) return ['food photography restaurant','coffee restaurant mood'];
  if(/ai|software|app|tool|dashboard|api/.test(t)) return ['ai technology dashboard','software workspace'];
  return [keywordQueryFromTitle(title).replace(/,/g,' '), 'premium editorial technology'];
}
function hdSourceCandidates(title, index, total){
  const prompt = buildAIPrompt(title, index, total);
  const qs = stockQueriesForTitle(title);
  const seed = Math.abs(hashCode(normalizeTitle(title)+'-'+index+'-'+Date.now())) % 999999999;
  const list = [];
  // AI first: stronger title match. Extra variations retry automatically.
  ['main','clean','sharp','editorial'].forEach((salt,k)=>{
    list.push({url:pollinationsUrlFromPrompt(prompt + `\nCamera: sharp focus, professional DSLR, high detail, no writing anywhere, no symbols that look like text, no fake watermark, clean stock-photo quality, wide blog hero composition.`, title, index+k*13, salt), label:'free-ai-hd'});
  });
  // Stock fallback only from query-safe sources; avoid random animal fallback.
  qs.forEach((q,k)=>{
    const cleanQ = encodeURIComponent(q);
    list.push({url:`https://source.unsplash.com/1280x720/?${cleanQ},editorial,photo&sig=${seed+k}`, label:'hd-stock'});
  });
  return list;
}
async function getCleanUploadableFromSources(title, index, total, id){
  const candidates = hdSourceCandidates(title, index, total);
  let lastErr = '';
  // If user added a working image API key, try it once but still validate/fetch as blob.
  try{
    const ai = await callOpenRouterForImage(title,index,total);
    if(ai?.src && /^https?:\/\//i.test(ai.src)) candidates.unshift({url:ai.src, label:ai.model || 'image-engine'});
    else if(ai?.src && ai.src.startsWith('data:image/')) return await cleanFeaturedImageBlob(dataUrlToBlob(ai.src));
  }catch(e){ lastErr = e.message; }
  for(const c of candidates){
    if(stopFlag) throw new Error('Stopped');
    try{
      updateCard(id,{state:`Trying ${c.label} • HD source...`});
      let blob = await urlToBlobWithTimeout(c.url, 35000);
      if(blob.size < 25000) throw new Error('low quality source');
      blob = await cleanFeaturedImageBlob(blob);
      return {uploadable: blob, label: c.label};
    }catch(e){
      lastErr = e.message;
      console.debug('source failed', c.label, e.message);
    }
  }
  throw new Error(lastErr || 'all HD sources failed');
}

async function generateTitleImages(){
  const title = normalizeTitle(els.titleInput.value);
  const count = Math.max(1, Math.min(10, parseInt(els.imageCount.value||'5',10)));
  if(!title){setFinderStatus('Error: title missing','Article title paste karein.',true); return;}
  if(!settings.cloudName || !settings.uploadPreset){setFinderStatus('Error: Cloudinary setup missing','Cloud name aur unsigned preset save karein.',true); return;}
  clearPreviewUrls(); stopFlag=false; running=true; els.findBtn.disabled=true; els.stopBtn.disabled=false; els.finderGrid.innerHTML='';
  setFinderStatus('Generating images...','HD image sources retry honge. Placeholder/fake cards show nahi hongy.'); setActivity('Image finder started • creating title-matched images', 'working');
  const ids = Array.from({length:count},(_,i)=>'aiCard_'+Date.now()+'_'+i);
  els.finderGrid.innerHTML = ids.map((id,i)=>cardTemplate(id, `${title} • ${i+1}`)).join('');
  let done=0, success=0;
  const concurrency = Math.min(count, 2);
  let cursor=0;
  async function worker(){
    while(cursor<count && !stopFlag){
      const i = cursor++;
      const id = ids[i];
      try{
        updateCard(id,{state:'Generating • finding clean HD image...'});
        setActivity(`Image ${i+1}/${count}: finding title-matched HD source`, 'working');
        const got = await getCleanUploadableFromSources(title, i, count, id);
        let uploadable = got.uploadable;
        const localPreview = uploadable instanceof Blob ? makePreviewUrl(uploadable) : '';
        if(localPreview) updateCard(id,{preview: localPreview});
        updateCard(id,{state:'Uploading • converting to WebP CDN...'});
        setActivity(`Image ${i+1}/${count}: uploading to Cloudinary WebP CDN`, 'working');
        let up;
        try{
          up = await uploadToCloudinary(uploadable, title);
        }catch(upErr){
          console.debug('upload failed, retry another HD source', upErr.message);
          const got2 = await getCleanUploadableFromSources(title + ' professional social media featured image no text', i+77, count, id);
          const retryBlob = got2.uploadable;
          updateCard(id,{preview:makePreviewUrl(retryBlob), state:'Retrying upload • another HD image...'});
          up = await uploadToCloudinary(retryBlob, 'image');
        }
        success++;
        const label = `${title} • Image ${i+1}`;
        updateCard(id,{preview:up.url, title:label, state:`Ready • WebP source ready`, url:up.url});
        addHistory({url:up.url,title:label,time:Date.now()});
      } catch(e){
        console.debug('card failed', e.message);
        const el = document.getElementById(id);
        if(el) el.remove();
      } finally{
        done++; setFinderStatus(success?`Done ${success}/${count} images ready`:`Working ${done}/${count}`, stopFlag?'Stopped by user':'Images generate/upload ho rahi hain.');
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,count)},worker));
  running=false; els.findBtn.disabled=false; els.stopBtn.disabled=true;
  if(success){ setFinderStatus('Done. Images ready.','Copy URL ya Copy HTML use karein.'); setActivity('Complete • all available images are ready to copy, open, or download', 'done'); }
  else if(stopFlag){ setFinderStatus('Stopped.','Jo images ready hui hain woh use kar sakte hain.'); setActivity('Stopped • process cancelled by user', 'error'); }
  else { setFinderStatus('Error: images upload failed.','Cloudinary preset/settings check karein. Fallback image bhi automatically try hoti hai.',true); setActivity('Failed • check Cloudinary preset/settings', 'error'); }
}

function getGoogleDocId(url){
  const m = String(url||'').match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/i);
  return m ? m[1] : '';
}
function mimeFromZipName(name){
  if(/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if(/\.png$/i.test(name)) return 'image/png';
  if(/\.webp$/i.test(name)) return 'image/webp';
  if(/\.gif$/i.test(name)) return 'image/gif';
  return 'image/jpeg';
}
function readU16(dv,o){ return dv.getUint16(o,true); }
function readU32(dv,o){ return dv.getUint32(o,true); }
async function inflateRawZipBytes(bytes){
  if(typeof DecompressionStream === 'undefined') throw new Error('ZIP inflate unavailable in this browser');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}
async function extractImagesFromZipBlob(zipBlob){
  const buf = await zipBlob.arrayBuffer();
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const entries = [];
  // Prefer central directory because local headers can use data descriptors.
  for(let off=0; off < u8.length - 46; off++){
    if(readU32(dv, off) !== 0x02014b50) continue;
    const method = readU16(dv, off+10);
    const compSize = readU32(dv, off+20);
    const uncompSize = readU32(dv, off+24);
    const nameLen = readU16(dv, off+28);
    const extraLen = readU16(dv, off+30);
    const commentLen = readU16(dv, off+32);
    const localOff = readU32(dv, off+42);
    const name = new TextDecoder().decode(u8.slice(off+46, off+46+nameLen));
    entries.push({name, method, compSize, uncompSize, localOff});
    off += 46 + nameLen + extraLen + commentLen - 1;
  }
  const images=[];
  for(const e of entries){
    if(!/^word\/media\//i.test(e.name) || !/\.(png|jpe?g|webp|gif)$/i.test(e.name)) continue;
    const lo = e.localOff;
    if(readU32(dv, lo) !== 0x04034b50) continue;
    const nameLen = readU16(dv, lo+26);
    const extraLen = readU16(dv, lo+28);
    const dataStart = lo + 30 + nameLen + extraLen;
    const comp = u8.slice(dataStart, dataStart + e.compSize);
    let raw;
    if(e.method === 0) raw = comp;
    else if(e.method === 8) raw = await inflateRawZipBytes(comp);
    else continue;
    const blob = new Blob([raw], {type:mimeFromZipName(e.name)});
    if(blob.size > 8000) images.push({name:e.name, blob});
  }
  images.sort((a,b)=>{
    const na = parseInt((a.name.match(/image(\d+)/i)||[])[1]||'9999',10);
    const nb = parseInt((b.name.match(/image(\d+)/i)||[])[1]||'9999',10);
    return na-nb;
  });
  return images;
}
async function extractGoogleDocOriginalImages(url){
  const id = getGoogleDocId(url);
  if(!id) return [];
  const exportUrl = `https://docs.google.com/document/d/${id}/export?format=docx`;
  setActivity('Google Docs detected • downloading original DOCX images', 'working');
  const docxBlob = await fetchViaBackground(exportUrl, false);
  if(!docxBlob || docxBlob.size < 1000) throw new Error('Google Docs export failed. Make sure document is accessible in this browser.');
  const imgs = await extractImagesFromZipBlob(docxBlob);
  return imgs;
}
function cardTemplateReady(id, title){
  return `<div class="imageCard" id="${id}"><img alt=""><div class="imageBody"><div class="imageTitle">${escapeHtml(title)}</div><div class="imageState">Waiting...</div><div class="actions"><button disabled>Copy URL</button><button disabled>Copy HTML</button><button disabled>Open</button></div></div></div>`;
}
async function convertGoogleDocImages(url){
  if(!settings.cloudName || !settings.uploadPreset) throw new Error('Cloudinary setup missing');
  progress(8);
  setStatus('Google Docs image extraction...','Original embedded DOCX images nikali ja rahi hain. Screenshot/crop use nahi hoga.');
  const images = await extractGoogleDocOriginalImages(url);
  if(!images.length) throw new Error('No original images found in Google Doc export');
  els.singleResult.classList.remove('hidden');
  els.singleResult.innerHTML = `<div class="docImagesWrap"><h3>Extracted original images</h3><p>Only real embedded images. No cropped screenshots, no icons.</p><div id="docImagesGrid" class="resultGrid docImagesGrid"></div></div>`;
  const grid = document.getElementById('docImagesGrid');
  const ids = images.map((_,i)=>'docImg_'+Date.now()+'_'+i);
  grid.innerHTML = ids.map((id,i)=>cardTemplateReady(id, i===0?'Main image':`Extracted image ${i+1}`)).join('');
  let done=0;
  for(let i=0;i<images.length;i++){
    const id = ids[i];
    const item = images[i];
    const preview = makePreviewUrl(item.blob);
    updateCard(id,{preview, state:'Uploading original image • converting to WebP CDN...'});
    progress(10 + Math.round((i/images.length)*80));
    setActivity(`Google Docs image ${i+1}/${images.length}: uploading original file`, 'working');
    const up = await uploadToCloudinary(item.blob, i===0?'main-image':`doc-image-${i+1}`);
    updateCard(id,{preview:up.url, title:i===0?'Main image':`Extracted image ${i+1}`, state:'Ready • original full image converted to WebP', url:up.url});
    addHistory({url:up.url,title:i===0?'Main image':`Google Doc image ${i+1}`,time:Date.now()});
    done++;
  }
  progress(100);
  setStatus(`Done. ${done} original images ready.`, 'Head/crop issue fixed: images DOCX original media se nikli hain.');
  setActivity('Complete • Google Docs original images ready', 'done');
  return true;
}

async function convertSingle(){
  try{
    const url = els.imageUrl.value.trim();
    if(!url) throw new Error('Image URL missing');
    if(!settings.cloudName || !settings.uploadPreset) throw new Error('Cloudinary setup missing');
    setStatus('Checking link...','Direct image hai to upload hoga. Page link hai to source image nikaalne ki koshish hogi.'); setActivity('Single URL conversion started • checking source', 'working'); progress(18);
    if(getGoogleDocId(url)){
      await convertGoogleDocImages(url);
      return;
    }
    const resolvedUrl = await resolveInputUrlForUpload(url);
    if(!resolvedUrl) throw new Error('No usable image found');
    setStatus('Processing...','Image download/upload ho rahi hai.'); setActivity('Processing • downloading image and uploading WebP CDN', 'working'); progress(45);
    let uploadInput = resolvedUrl;
    try{ uploadInput = await fetchImageAsBlobBest(resolvedUrl); }catch(fetchBlobErr){ console.debug('using URL upload fallback', fetchBlobErr.message); }
    const up = await uploadToCloudinary(uploadInput, 'single-image');
    progress(100); setStatus('Done. WebP source link ready.','URL aur HTML code copy kar sakte hain.'); setActivity('Complete • WebP CDN source link is ready', 'done');
    renderSingle(up.url);
    addHistory({url:up.url,title:'Single image',time:Date.now()});
  }catch(e){
    const msg = String(e.message||e);
    const hint = /403|Forbidden|page loading/i.test(msg)
      ? 'Ye site direct scraping block kar rahi hai. Image par right-click karke direct image address paste karein, ya image download/drag-drop karein. Advanced URL resolver configured ho to woh pehle try hoga.'
      : 'Is page se image auto nikalne ki koshish hui. Agar site block kare to page URL, direct image URL, encoded image URL, ya drag/drop image use karein. Magnific/Freepik style query links bhi supported hain.';
    setStatus('Error: '+msg, hint, true);
  }
}
function renderSingle(url){
  const html = `<img src="${url}" alt="" loading="lazy">`;
  els.singleResult.classList.remove('hidden');
  els.singleResult.innerHTML = `<img src="${url}"><div><label>WebP CDN URL</label><div class="copyBlock"><input readonly value="${url}"><button id="copyUrlBtn">Copy</button></div><label>HTML source code</label><div class="copyBlock"><textarea readonly>${html}</textarea><button id="copyHtmlBtn">Copy</button></div><button id="downloadSingleBtn" class="primary downloadBtn">Download HD WebP</button></div>`;
  $('copyUrlBtn').onclick=(e)=>copyWithFeedback(e.currentTarget, url, 'Copied ✓'); $('copyHtmlBtn').onclick=(e)=>copyWithFeedback(e.currentTarget, html, 'Copied ✓'); $('downloadSingleBtn').onclick=(e)=>downloadWithFeedback(e.currentTarget, url, 'single-image');
}
async function handleFile(file){
  try{
    if(!file) throw new Error('No file selected');
    if(!/^image\//i.test(file.type || '')) throw new Error('Please select an image file');
    if(!settings.cloudName || !settings.uploadPreset) throw new Error('Cloudinary setup missing');
    setStatus('Uploading...','File WebP CDN par upload ho rahi hai.'); setActivity('File upload started • converting to WebP CDN', 'working');
    progress(40);
    const up=await uploadToCloudinary(file,file.name||'uploaded-image');
    progress(100);
    setStatus('Done. WebP source link ready.','URL aur HTML code copy kar sakte hain.'); setActivity('Complete • uploaded file CDN link is ready', 'done');
    renderSingle(up.url);
    addHistory({url:up.url,title:file.name||'Uploaded image',time:Date.now()});
  }
  catch(e){setStatus('Error: '+e.message,'Cloudinary settings check karein.',true)}
}

document.addEventListener('click', e=>{
  const btn = e.target.closest('button');
  if(!btn || btn.disabled) return;
  btn.classList.remove('clicked');
  void btn.offsetWidth;
  btn.classList.add('clicked');
  setTimeout(()=>btn.classList.remove('clicked'), 380);
});

if(els.editSettingsBtn){
  els.editSettingsBtn.onclick = ()=>{
    settingsEditing = true;
    updateSetup();
    setTimeout(()=>els.cloudName?.focus(), 60);
  };
}

async function saveSettingsNow(e){
  e?.preventDefault?.();
  try{
    setButtonBusy(els.saveSettingsBtn, 'Saving...');
    settings = {cloudName:els.cloudName.value.trim() || DEFAULT_SETTINGS.cloudName, uploadPreset:els.uploadPreset.value.trim() || DEFAULT_SETTINGS.uploadPreset, folderName:els.folderName.value.trim()||'webp-cdn-source-maker', backendUrl:els.backendUrl.value.trim() || DEFAULT_SETTINGS.backendUrl, openRouterKey:els.openRouterKey?.value.trim()||'', openRouterModels:els.openRouterModels?.value.trim()||DEFAULT_IMAGE_MODELS.join(', ')};
    await saveLocal({settings});
    hasSavedSettings=true; settingsEditing=false;
    updateSetup();
    showToast('Settings saved successfully ✅');
    setButtonDone(els.saveSettingsBtn, 'Saved ✓');
  }catch(err){
    setButtonError(els.saveSettingsBtn, 'Save failed');
    showToast('Save error: '+(err.message||err));
  }
}
function startFinderNow(e){
  e?.preventDefault?.();
  if(running) return;
  setButtonBusy(els.findBtn, 'Starting...');
  setTimeout(()=>{ if(!running) setButtonDone(els.findBtn, 'Started ✓'); }, 500);
  generateTitleImages().finally(()=>{ if(!els.findBtn.disabled) setButtonDone(els.findBtn, 'Done ✓'); });
}
function convertSingleNow(e){
  e?.preventDefault?.();
  setButtonBusy(els.convertBtn, 'Converting...');
  convertSingle().finally(()=>setButtonDone(els.convertBtn, 'Done ✓'));
}
function clearNow(e){
  e?.preventDefault?.();
  clearPreviewUrls(); els.imageUrl.value=''; els.singleResult.classList.add('hidden'); els.finderGrid.innerHTML=''; els.finderStatus.classList.add('hidden'); els.activityLine?.classList.add('hidden'); setStatus('Ready.','Paste link, drag image, or upload image.'); progress(0); setButtonDone(els.clearBtn, 'Cleared ✓');
}
function clearHistoryNow(e){
  e?.preventDefault?.();
  history=[]; saveLocal({history}); renderHistory(); setButtonDone(els.clearHistoryBtn, 'Cleared ✓');
}
function newImageNow(e){
  e?.preventDefault?.();
  window.scrollTo({top:0,behavior:'smooth'}); els.titleInput.focus(); setButtonDone(els.newImageBtn, 'Ready ✓');
}
els.saveSettingsBtn.addEventListener('click', saveSettingsNow);
els.findBtn.addEventListener('click', startFinderNow);
els.titleInput.addEventListener('keydown', e=>{if(e.key==='Enter') startFinderNow(e);});
els.stopBtn.addEventListener('click', e=>{e.preventDefault(); stopFlag=true; setFinderStatus('Stopping...','Current running image finish hone ke baad process stop ho jayega.'); setButtonDone(els.stopBtn,'Stopping ✓');});
els.convertBtn.addEventListener('click', convertSingleNow);
els.clearBtn.addEventListener('click', clearNow);
els.clearHistoryBtn.addEventListener('click', clearHistoryNow);
els.newImageBtn.addEventListener('click', newImageNow);
// Stop browser from opening the dropped image in the tab.
['dragenter','dragover','dragleave','drop'].forEach(evt=>{
  document.addEventListener(evt, e=>{ e.preventDefault(); e.stopPropagation(); }, false);
});

els.dropZone.addEventListener('click', ()=>els.fileInput && els.fileInput.click());
els.dropZone.addEventListener('keydown', e=>{
  if(e.key==='Enter' || e.key===' '){ e.preventDefault(); els.fileInput && els.fileInput.click(); }
});
els.fileInput?.addEventListener('change', e=>{
  const f=e.target.files?.[0];
  if(f) handleFile(f);
  e.target.value='';
});
els.dropZone.addEventListener('dragenter', ()=>els.dropZone.classList.add('drag'));
els.dropZone.addEventListener('dragover', e=>{e.preventDefault(); e.dataTransfer.dropEffect='copy'; els.dropZone.classList.add('drag');});
els.dropZone.addEventListener('dragleave', e=>{
  if(!els.dropZone.contains(e.relatedTarget)) els.dropZone.classList.remove('drag');
});
els.dropZone.addEventListener('drop', e=>{
  e.preventDefault();
  e.stopPropagation();
  els.dropZone.classList.remove('drag');
  const f=e.dataTransfer.files?.[0];
  if(f) handleFile(f);
  else setStatus('Error: no image found','Image file drag karein ya click karke upload karein.',true);
});
init();
