// Vercel serverless URL resolver for WebP CDN Source Maker.
// It returns the image that belongs to the exact page URL when possible.

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg)(\?|#|$)/i;
const BAD = /logo|icon|avatar|sprite|placeholder|tracking|pixel|adsbygoogle|favicon/i;

function decodeDeep(value) {
  let out = String(value || '').trim();
  for (let i = 0; i < 4; i++) {
    try {
      const dec = decodeURIComponent(out);
      if (dec === out) break;
      out = dec;
    } catch (_) { break; }
  }
  return out.replace(/&amp;/g, '&');
}
function abs(u, base) { try { return new URL(u, base).href; } catch (_) { return u || ''; } }
function cleanUrl(u) { return decodeDeep(u).replace(/[\s"'<>]+$/g, '').replace(/[),.;]+$/g, ''); }
function isHttp(u) { return /^https?:\/\//i.test(String(u || '')); }
function isImage(u) { return isHttp(u) && (IMAGE_EXT.test(new URL(u).pathname + new URL(u).search) || /res\.cloudinary\.com|images?|cdn|media|uploads?/i.test(u)); }
function uniq(arr) { return [...new Set(arr.filter(Boolean))]; }


function magnificInfo(pageUrl) {
  try {
    const u = new URL(pageUrl);
    if (!/magnific\.com$/i.test(u.hostname.replace(/^www\./,''))) return null;
    const m = u.pathname.match(/\/free-(?:ai-image|photo)\/([^\/]+)_(\d+)\.htm/i);
    if (!m) return null;
    return { slug: m[1].toLowerCase(), id: m[2] };
  } catch (_) { return null; }
}
function isWrongMagnificCandidate(candidateUrl, pageUrl, context='') {
  const info = magnificInfo(pageUrl);
  if (!info) return false;
  const cand = String(candidateUrl || '');
  const ctx = String(context || '');
  const txt = cand + ' ' + ctx;

  // IMPORTANT: only reject when the candidate itself or its small local tag/context points
  // to another Magnific page. Do not pass the full page HTML here, because related items
  // elsewhere on the page contain many other IDs and would wrongly reject the real image.
  const ids = [...txt.matchAll(/\/free-(?:ai-image|photo)\/[^\s"'<>)]*?_(\d+)(?:\.htm|\.(?:jpg|jpeg|png|webp|avif))/gi)].map(m => m[1]);
  if (ids.some(id => id !== info.id)) return true;

  // Cross-selling/related images are only blocked when their local context clearly does
  // not belong to the current page.
  if (/cross[_-]?selling|related|recommend|similar|suggested/i.test(ctx) && !ctx.includes(info.id) && !ctx.toLowerCase().includes(info.slug)) return true;
  return false;
}

function magnificExactScore(candidateUrl, pageUrl, context='') {
  const info = magnificInfo(pageUrl);
  if (!info) return 0;
  const txt = (String(candidateUrl || '') + ' ' + String(context || '')).toLowerCase();
  let score = 0;
  if (txt.includes(info.id)) score += 200000;
  if (txt.includes(info.slug)) score += 160000;
  if (/og:image|twitter:image|image_src|primary|main|hero|featured|preview|detail|asset/i.test(context)) score += 50000;
  if (/cross[_-]?selling|related|recommend|similar|suggested|from_element/i.test(txt)) score -= 250000;
  return score;
}

function collectMagnificExactCandidates(html, pageUrl) {
  const info = magnificInfo(pageUrl);
  if (!info) return [];
  const raw = decodeDeep(html || '');
  const out = [];
  const addFromWindow = (idx, radius=4500) => {
    if (idx < 0) return;
    const win = raw.slice(Math.max(0, idx - radius), Math.min(raw.length, idx + radius));
    for (const u of collectDirectUrls(win, pageUrl)) {
      if (!isWrongMagnificCandidate(u, pageUrl, win)) out.push({ url:u, score: magnificExactScore(u, pageUrl, win) + 50000 });
    }
  };
  let pos = raw.indexOf(info.id);
  while (pos >= 0) { addFromWindow(pos); pos = raw.indexOf(info.id, pos + info.id.length); }
  pos = raw.toLowerCase().indexOf(info.slug);
  while (pos >= 0) { addFromWindow(pos); pos = raw.toLowerCase().indexOf(info.slug, pos + info.slug.length); }
  out.sort((a,b)=>b.score-a.score);
  return uniq(out.map(x=>x.url));
}
function filterExactPageCandidates(list, pageUrl) {
  const info = magnificInfo(pageUrl);
  if (!info) return list;
  return list.filter(u => !isWrongMagnificCandidate(u, pageUrl));
}

function knownPageDirect(input) {
  // Keep this for future safe known sources only.
  // Do NOT build Magnific image URLs from the page slug: the page id and image id can be different,
  // which caused 404 links like img.magnific.com/free-photo/<page-slug>.jpg.
  return '';
}

function parseMeta(html, base) {
  const out = [];
  const metaRe = /<meta\s+[^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*>/gi;
  const contentRe = /content=["']([^"']+)["']/i;
  for (const tag of html.match(metaRe) || []) {
    const m = tag.match(contentRe);
    if (m) out.push(abs(cleanUrl(m[1]), base));
  }
  const linkRe = /<link\s+[^>]*rel=["']image_src["'][^>]*>/gi;
  const hrefRe = /href=["']([^"']+)["']/i;
  for (const tag of html.match(linkRe) || []) {
    const m = tag.match(hrefRe);
    if (m) out.push(abs(cleanUrl(m[1]), base));
  }
  return out;
}

function parseJsonLd(html, base) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const walk = (x) => {
    if (!x) return;
    if (typeof x === 'string') {
      const u = abs(cleanUrl(x), base);
      if (isHttp(u) && (IMAGE_EXT.test(u) || /cloudinary|cdn|image|photo|media|upload/i.test(u))) out.push(u);
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (typeof x === 'object') Object.values(x).forEach(walk);
  };
  while ((m = re.exec(html))) {
    try { walk(JSON.parse(m[1])); } catch (_) {}
  }
  return out;
}

function bestFromImgTags(html, base) {
  const candidates = [];
  const imgRe = /<(img|source)\s+[^>]*>/gi;
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`${name}=[\"']([^\"']+)[\"']`, 'i'));
    return m ? m[1] : '';
  };
  let tag;
  while ((tag = imgRe.exec(html))) {
    const t = tag[0];
    let src = attr(t, 'src') || attr(t, 'data-src') || attr(t, 'data-lazy-src') || attr(t, 'data-original') || attr(t, 'data-url');
    const srcset = attr(t, 'srcset') || attr(t, 'data-srcset');
    if (srcset) {
      const parts = srcset.split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
      if (parts.length) src = parts[parts.length - 1];
    }
    if (!src) continue;
    src = abs(cleanUrl(src), base);
    let score = 0;
    const w = parseInt(attr(t, 'width') || '0', 10);
    const h = parseInt(attr(t, 'height') || '0', 10);
    score += (w && h) ? w * h : 1000;
    if (/hero|featured|main|image|photo|media|wp-content|uploads|cdn/i.test(t + src)) score += 5000;
    if (BAD.test(t + src)) score -= 20000;
    if (isHttp(src) && !isWrongMagnificCandidate(src, base, t)) candidates.push({ url: src, score });
  }
  candidates.sort((a,b) => b.score - a.score);
  return candidates.map(x => x.url);
}

function collectDirectUrls(text, base) {
  const out = [];
  const raw = decodeDeep(text || '');
  for (const u of raw.match(/https?:\/\/[^\s"'<>]+/gi) || []) {
    const cleaned = abs(cleanUrl(u), base);
    if (isHttp(cleaned) && (IMAGE_EXT.test(cleaned) || /cloudinary|cdn|image|photo|media|upload/i.test(cleaned)) && !BAD.test(cleaned) && !isWrongMagnificCandidate(cleaned, base, cleaned)) out.push(cleaned);
  }
  return out;
}

async function fetchText(url) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'cache-control': 'no-cache'
    }
  });
  if (!r.ok) throw new Error(`page loading ${r.status}`);
  return await r.text();
}


async function fetchReaderText(url) {
  const readerUrl = 'https://r.jina.ai/http://' + url.replace(/^https?:\/\//i, '');
  const r = await fetch(readerUrl, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36',
      'accept': 'text/plain,*/*',
      'cache-control': 'no-cache'
    }
  });
  if (!r.ok) throw new Error(`reader ${r.status}`);
  return await r.text();
}

async function resolve(input) {
  const url = decodeDeep(input);
  if (!isHttp(url)) throw new Error('Valid URL missing');
  if (IMAGE_EXT.test(new URL(url).pathname)) return url;

  let html = '';
  try {
    html = await fetchText(url);
  } catch (firstErr) {
    // Some sites block normal serverless fetches but are still readable through a text reader.
    html = await fetchReaderText(url);
  }

  const all = uniq([
    ...collectMagnificExactCandidates(html, url),
    ...parseMeta(html, url),
    ...parseJsonLd(html, url),
    ...bestFromImgTags(html, url),
    ...collectDirectUrls(html, url)
  ]).filter(u => isHttp(u) && !BAD.test(u) && !isWrongMagnificCandidate(u, url, u));

  const strict = all
    .map(u => ({ url:u, score: magnificExactScore(u, url, u) + (IMAGE_EXT.test(u) ? 20000 : 0) + (/cloudinary|cdn|image|photo|media|upload|magnific/i.test(u) ? 3000 : 0) }))
    .sort((a,b)=>b.score-a.score)
    .map(x=>x.url);

  // Exact page candidates first. Query/hash nested links from the pasted URL are intentionally not used here.
  const first = strict.find(u => IMAGE_EXT.test(u)) || strict[0];
  if (first) return first;

  const known = knownPageDirect(url);
  if (known) return known;
  throw new Error('No image found on exact page');
}

async function fetchProxy(req, res) {
  const url = req.query.url;
  const asText = req.query.asText === '1';
  try {
    const r = await fetch(url, { redirect:'follow', headers:{ 'user-agent':'Mozilla/5.0', accept: asText ? 'text/html,*/*' : 'image/avif,image/webp,image/*,*/*' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const contentType = r.headers.get('content-type') || '';
    if (asText) return res.status(200).json({ ok:true, status:r.status, contentType, text: await r.text() });
    const buf = Buffer.from(await r.arrayBuffer());
    return res.status(200).json({ ok:true, status:r.status, contentType, base64: buf.toString('base64') });
  } catch (e) {
    return res.status(200).json({ ok:false, error:e.message || String(e) });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.query && req.query.fetch === '1') return fetchProxy(req, res);
  try {
    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const input = body.url || body.imageUrl || body.pageUrl || body.input || req.query.url;
    const imageUrl = await resolve(input);
    return res.status(200).json({ ok:true, imageUrl, url:imageUrl, source:imageUrl });
  } catch (e) {
    return res.status(200).json({ ok:false, error:e.message || String(e) });
  }
};
