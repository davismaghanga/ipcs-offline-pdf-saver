/*
 * IPCS LMS — PDF viewer CAPTURE MODE
 * Saves every document you open in the site's PDF viewer, as you browse.
 *
 * 1. Log in and open any page of the course.
 * 2. DevTools → Console (F12 / Cmd+Opt+J). If Chrome blocks the paste: type  allow pasting  first.
 * 3. Paste this whole file, press Enter.
 * 4. The course reopens inside a capture window with a green bar on top.
 *    Browse normally — go through each unit and open every PDF. Each one is
 *    saved to your Downloads automatically as soon as it finishes loading.
 * 5. Click "Close" in the bar when you're done. (Allow "multiple downloads" if asked.)
 *
 * Shares its "already saved" list and numbering with ipcs-pdf-downloader.js.
 * Nothing captured? Click "Report" in the bar and include the copied text when reporting an issue.
 */
(() => {
  if (window.__ipcsCapture) { console.warn('Capture mode is already on in this tab.'); return; }
  window.__ipcsCapture = true;

  const DELAY_MS = 900, RETRIES = 6, CHUNK = 256 * 1024, MIN_CHUNK = 32 * 1024;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const short = u => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop()) || u; } catch { return u; } };
  const size = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
  const trunc = (s, k = 90) => typeof s !== 'string' ? String(s ?? '') : s.length > k ? `${s.slice(0, k)}… (${s.length} chars)` : s;
  const norm = u => { const x = new URL(u); x.hash = ''; return x.href; };

  // ─── shared "already saved" store (same as the downloader script) ──────
  const STORE = 'ipcs-pdf-done';
  let done = {};
  try { done = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch {}
  const remember = (keys, name) => {
    keys.forEach(k => { done[k] = name; });
    try { localStorage.setItem(STORE, JSON.stringify(done)); } catch {}
  };
  let n = Math.max(0, ...Object.values(done).map(s => parseInt(s, 10) || 0));
  const seenHashes = new Set();
  let savedCount = 0, lastMsg = 'Open any PDF in the course below — it will be saved automatically.';

  // ─── UI: status bar + full-screen frame ────────────────────────────────
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff;display:flex;flex-direction:column;';
  const bar = document.createElement('div');
  bar.style.cssText = 'height:44px;flex:none;display:flex;align-items:center;gap:12px;padding:0 12px;background:#0b7a3e;color:#fff;font:14px system-ui,sans-serif;';
  const label = document.createElement('div');
  label.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  const btn = (text, fn) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'background:#fff;color:#0b7a3e;border:0;border-radius:4px;padding:6px 12px;font:600 13px system-ui,sans-serif;cursor:pointer;';
    b.onclick = fn;
    return b;
  };
  const frame = document.createElement('iframe');
  // top navigation blocked so the site can't break out of the frame; everything else works as normal
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox');
  frame.style.cssText = 'flex:1;width:100%;border:0;';
  frame.src = location.href;
  const render = () => { label.textContent = `📥 Capture mode · saved ${savedCount} · ${lastMsg}`; };
  const status = msg => { lastMsg = msg; render(); console.log('[capture] ' + msg); };
  bar.append(label, btn('Report', () => report()), btn('Close', () => close()));
  wrap.append(bar, frame);
  document.body.appendChild(wrap);
  render();

  // ─── network (for the document-URL fallback) ───────────────────────────
  const OPTS = { credentials: 'include', cache: 'no-store' };
  async function retry(fn) {
    let err;
    for (let i = 0; i <= RETRIES; i++) {
      try { return await fn(); } catch (e) { err = e; if (i < RETRIES) await sleep(Math.min(2 * (i + 1), 10) * 1000); }
    }
    throw err;
  }
  async function fetchPdf(url) {
    const probe = await retry(async () => {
      const res = await fetch(url, { ...OPTS, headers: { Range: 'bytes=0-0' } });
      return { res, blob: res.status === 206 ? null : res.ok ? await res.blob() : null };
    });
    if (probe.res.status !== 206) return probe.blob;
    const total = +((probe.res.headers.get('content-range') || '').split('/')[1]);
    if (!(total > 0)) return retry(async () => (await fetch(url, OPTS)).blob());
    const parts = []; let pos = 0, piece = CHUNK, fails = 0;
    while (pos < total) {
      const end = Math.min(pos + piece, total) - 1;
      try {
        const r = await fetch(url, { ...OPTS, headers: { Range: `bytes=${pos}-${end}` } });
        if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        if (buf.byteLength !== end - pos + 1) throw new Error('short read');
        parts.push(buf); pos = end + 1; fails = 0;
      } catch (e) {
        if (++fails > RETRIES * 2) throw e;
        piece = Math.max(MIN_CHUNK, piece >> 1);
        await sleep(Math.min(fails, 8) * 1000);
      }
    }
    return new Blob(parts);
  }

  // ─── saving ────────────────────────────────────────────────────────────
  const isBlob = b => b && typeof b.slice === 'function' && typeof b.size === 'number';
  const isPdf = async b => isBlob(b) && b.size > 0 && (await b.slice(0, 1024).text()).includes('%PDF');
  const dataToBlob = s => {
    const bin = atob(s.replace(/^data:[^,]*,/, '').replace(/\s/g, ''));
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: 'application/pdf' });
  };
  const sha = async b => {
    try {
      const d = await crypto.subtle.digest('SHA-256', await b.arrayBuffer());
      return [...new Uint8Array(d)].slice(0, 12).map(x => x.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
  };
  const clean = s => (s || '').replace(/\s*:\s*/g, ' - ').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 140);
  const meaningful = s => typeof s === 'string' && /[a-z]/i.test(s) && !/\.(ashx|aspx)|^data:|^blob:/i.test(s) && s.length < 200;

  async function keep(blob, name, keys) {
    const h = await sha(blob);
    if (h && (seenHashes.has(h) || done['sha:' + h])) { status(`already saved: ${done['sha:' + h] || name}`); return; }
    if (h) seenHashes.add(h);
    name = clean(name) || 'document';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    const file = `${String(++n).padStart(3, '0')} - ${name}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
    a.download = file;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 120000);
    remember([...keys, ...(h ? ['sha:' + h] : [])], file);
    savedCount++;
    status(`✓ ${file} (${size(blob.size)})`);
    await sleep(DELAY_MS);
  }

  // ─── the viewer ────────────────────────────────────────────────────────
  function findViewers(w) {
    const out = [];
    try {
      w.document.querySelectorAll('*').forEach(el => (el.ej2_instances || []).forEach(inst => {
        try { if (inst.getModuleName && inst.getModuleName() === 'PdfViewer' && !out.includes(inst)) out.push(inst); } catch {}
      }));
    } catch {}
    return out;
  }
  const srcOf = v => (typeof v.__ipcsDoc === 'string' ? v.__ipcsDoc : typeof v.documentPath === 'string' ? v.documentPath : '');
  const docKey = v => `${v.fileName || ''}|${srcOf(v).slice(0, 300)}|${v.pageCount}`;
  const handled = new WeakMap();   // viewer instance → key of the document last captured
  let lastClick = { text: '', t: 0 };

  function pageTitle(w) {
    try {
      const hs = [...w.document.querySelectorAll('h1, h2, h3, h4')].map(h => h.textContent.trim().replace(/\s+/g, ' ')).filter(t => t && t.length < 100);
      const u = new URL(w.location.href).searchParams.get('u');
      return (hs[hs.length > 1 ? 1 : 0] || 'Unit') + (u ? ` [u=${u}]` : '');
    } catch { return 'document'; }
  }

  async function capture(v, w) {
    if (!(v.pageCount > 0)) return;
    const key = docKey(v);
    if (handled.get(v) === key) return;
    handled.set(v, key);
    await sleep(800);   // let the viewer finish settling after load

    const dp = srcOf(v).trim();
    const dpIsData = /^data:/i.test(dp) || (dp.length > 300 && !/^(https?:)?\/\//i.test(dp) && !dp.startsWith('/'));
    let dpUrl = '';
    if (dp && !dpIsData) { try { dpUrl = norm(new URL(dp, w.location.href).href); } catch {} }
    if (dpUrl && done[dpUrl]) { status(`already saved: ${done[dpUrl]}`); return; }
    const clicked = lastClick.text && Date.now() - lastClick.t < 60000 ? lastClick.text : '';
    const unit = pageTitle(w).replace(/\s*\[u=\d+\]$/, '');
    const name = [v.downloadFileName, v.fileName, short(dpUrl)].find(x => meaningful(x) && /\.pdf$/i.test(x))
              || (clicked ? `${unit} - ${clicked}` : '')
              || [v.downloadFileName, v.fileName].find(meaningful)
              || `${unit} - document`;
    const keys = dpUrl ? [dpUrl] : [];
    status(`saving ${name} (${v.pageCount} pages)…`);

    // 1) the viewer's own save routine, with its download switch turned back on
    let err = '';
    for (let i = 0; i < 3; i++) {
      try {
        v.enableDownload = true;
        const p = v.saveAsBlob();
        if (!p) { err = 'save unavailable'; break; }
        let b = await Promise.race([p, sleep(120000).then(() => 'timeout')]);
        if (b === 'timeout') { err = 'save timed out'; continue; }
        if (typeof b === 'string' && /^data:|^JVBER/.test(b)) b = dataToBlob(b);
        if (await isPdf(b)) return keep(b, name, keys);
        err = 'save returned no PDF'; break;
      } catch (e) { err = String(e?.message || e); await sleep(2000 * (i + 1)); }
    }
    // 2) where the viewer got the document from
    try {
      if (dpIsData) { const b = dataToBlob(dp); if (await isPdf(b)) return keep(b, name, keys); }
      else if (dpUrl) { const b = await fetchPdf(dpUrl); if (await isPdf(b)) return keep(b, name, keys); }
    } catch (e) { err += ' | source: ' + (e?.message || e); }
    // 3) last resort: the viewer's own download action
    try {
      v.enableDownload = true; v.download();
      savedCount++;
      status(`↓ viewer download started for ${name} — check Downloads`);
      if (dpUrl) remember([dpUrl], name);
      return;
    } catch (e) { err += ' | download: ' + (e?.message || e); }
    handled.delete(v);
    status(`✗ couldn't save ${name}: ${err} — click Report for diagnostic details`);
  }

  // hook the viewer in a window so every document load triggers a capture
  function hook(w) {
    try {
      const PV = w.ej && w.ej.pdfviewer && w.ej.pdfviewer.PdfViewer;
      if (PV && PV.prototype && !PV.prototype.__ipcsHooked && typeof PV.prototype.fireDocumentLoad === 'function') {
        const orig = PV.prototype.fireDocumentLoad;
        PV.prototype.fireDocumentLoad = function (...args) {
          const r = orig.apply(this, args);
          capture(this, w);
          return r;
        };
        const origLoad = PV.prototype.load;
        if (typeof origLoad === 'function') PV.prototype.load = function (doc, ...rest) {
          if (typeof doc === 'string') this.__ipcsDoc = doc;
          return origLoad.call(this, doc, ...rest);
        };
        PV.prototype.__ipcsHooked = true;
      }
      if (w.document && !w.document.__ipcsClicks) {
        w.document.__ipcsClicks = true;
        w.document.addEventListener('click', e => {
          const el = e.target && e.target.closest && e.target.closest('a, button, [onclick], li, td');
          const t = el ? el.textContent.trim().replace(/\s+/g, ' ') : '';
          if (t && t.length <= 80) lastClick = { text: t, t: Date.now() };
        }, true);
      }
      if (typeof w.open === 'function' && !w.open.__ipcs) {       // documents opened in a popup
        const o = w.open;
        const wrapped = function (...a) { const pw = o.apply(this, a); if (pw) popups.add(pw); return pw; };
        wrapped.__ipcs = true;
        w.open = wrapped;
      }
    } catch {}
    findViewers(w).forEach(v => capture(v, w));   // safety net: documents already open
  }

  const popups = new Set();
  let lastUrl = '';
  const tick = setInterval(() => {
    const w = frame.contentWindow;
    try {
      if (w && w.location.href !== lastUrl && w.location.href !== 'about:blank') {
        lastUrl = w.location.href;
        status(`watching ${pageTitle(w)} — open a PDF`);
      }
    } catch {}
    if (w) hook(w);
    popups.forEach(p => { try { if (p.closed) popups.delete(p); else hook(p); } catch {} });
  }, 700);

  // ─── diagnostic report (if nothing gets captured) ──────────────────────
  function report() {
    const w = frame.contentWindow;
    const r = { url: '', title: '', ej: false, ejHooked: false, viewers: [], viewerFunctions: [], triggers: [], iframes: [] };
    try {
      r.url = w.location.href; r.title = pageTitle(w);
      r.ej = !!(w.ej && w.ej.pdfviewer);
      r.ejHooked = !!(r.ej && w.ej.pdfviewer.PdfViewer.prototype.__ipcsHooked);
      r.viewers = findViewers(w).map(v => ({ fileName: v.fileName, downloadFileName: v.downloadFileName, documentPath: trunc(v.documentPath), serviceUrl: v.serviceUrl, pageCount: v.pageCount, enableDownload: v.enableDownload }));
      const fnNames = [];
      Object.getOwnPropertyNames(w).forEach(k => {
        try {
          const f = w[k];
          if (typeof f === 'function' && !/\[native code\]/.test(Function.prototype.toString.call(f))) {
            const src = Function.prototype.toString.call(f);
            if (/pdfviewer|documentPath|\.pdf/i.test(src) && src.length < 20000) { fnNames.push(k); r.viewerFunctions.push({ name: k, source: src.slice(0, 1500) }); }
          }
        } catch {}
      });
      w.document.querySelectorAll('[onclick], a[href^="javascript"], [data-file], [data-url], [data-id], [data-src]').forEach(el => {
        const attrs = [...el.attributes].map(a => `${a.name}="${a.value}"`).join(' ');
        if (fnNames.some(f => attrs.includes(f)) || /pdf|doc|file|view|resource/i.test(attrs))
          r.triggers.push(`<${el.tagName.toLowerCase()} ${attrs.slice(0, 250)}> ${el.textContent.trim().slice(0, 60)}`);
      });
      r.triggers = r.triggers.slice(0, 40);
      r.iframes = [...w.document.querySelectorAll('iframe, embed, object')].map(e => e.outerHTML.slice(0, 200));
    } catch (e) { r.error = String(e); }
    const text = JSON.stringify(r, null, 1);
    console.log(text);
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => status('diagnostic report copied to clipboard'))
      .catch(() => status('diagnostic report printed in the console'));
  }

  function close() {
    clearInterval(tick);
    wrap.remove();
    window.__ipcsCapture = false;
    console.log(`[capture] closed — ${savedCount} file(s) saved this session`);
  }

  status(lastMsg);
})();
