/*
 * IPCS LMS — bulk PDF downloader  (v4: also extracts documents from the on-site PDF viewer)
 * Runs inside your own logged-in browser tab, using your existing session.
 *
 * 1. Log in at https://study.personalcarescience.com.au and open any unit page
 *    (e.g. /_students/units.aspx?id=<course>&m=<module>&u=<unit>).  Reload it (F5) if a
 *    previous run is still going.
 * 2. Open DevTools → Console  (F12, or Cmd+Opt+J on Mac).
 *    If Chrome refuses the paste, type:  allow pasting   and press Enter first.
 * 3. Paste this whole file and press Enter — once.
 * 4. When the browser asks "Download multiple files?", click Allow.
 *
 * Two passes:
 *   A. direct PDF links on every unit page of the course
 *   B. documents shown in the site's PDF viewer (Syncfusion). Each unit page is
 *      loaded in a hidden, sandboxed frame; the viewer's own save routine is
 *      switched back on and the loaded document is saved.
 *
 * Unstable network: files are pulled in small pieces, each retried on its own.
 * Re-running skips finished files. Start over:  localStorage.removeItem('ipcs-pdf-done')
 *
 * Safety: GET requests only (plus the viewer's own save call). Hidden frames are
 * sandboxed: no form submits, no popups, can't navigate this tab. Skips logout /
 * quiz / exam / assessment-attempt pages.
 */
(async () => {
  // ─── Settings ───────────────────────────────────────────────────────────
  const CRAWL_COURSE  = true;  // visit every other unit page in this course (same ?id=)
  const VIEWER        = true;  // pass B: pull documents out of the on-site PDF viewer
  const DOWNLOAD      = true;  // false = dry run: list what it finds, download nothing
  const RESUME        = true;  // skip files saved by an earlier run of this script
  const CHUNK_KB      = 256;   // piece size; shrinks automatically (to 32 KB) when pieces keep failing
  const RETRIES       = 6;     // retries per request/piece on network errors
  const VIEWER_WAIT_S = 90;    // max wait for the viewer to finish loading a document
  const MAX_PAGES     = 300;   // safety cap on pages visited
  const DELAY_MS      = 900;   // pause between downloads so the browser doesn't drop any

  if (window.__ipcsRunning) {
    console.warn('Already running in this tab. Reload the page (F5), then paste once.');
    return;
  }
  window.__ipcsRunning = true;

  try {
  // ─── Setup ──────────────────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const start = new URL(location.href);
  const courseId = start.searchParams.get('id');
  const PDF = /\.pdf(?:$|[?#&])/i;
  const HANDLER = /\.ashx|download|getfile|viewfile|showfile|openfile|attachment|document|viewer/i;
  const SAFE_ASHX = /(file|download|doc|pdf|attach|media)[^/]*\.ashx/i;   // .ashx names that look like file handlers
  // never follow these (non-PDF URLs only — a .pdf fetch has no side effects)
  const SKIP = /log-?out|log-?off|sign-?out|delete|remove|submit|quiz|exam|assess|attempt|exit|save|clear|lock|update/i;
  const norm = u => { const x = new URL(u); x.hash = ''; return x.href; };
  const short = u => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop()) || u; } catch { return u; } };
  const size = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
  const trunc = (s, k = 90) => typeof s !== 'string' ? String(s ?? '') : s.length > k ? `${s.slice(0, k)}… (${s.length} chars)` : s;
  const unitOf = url => new URL(url).searchParams.get('u');
  const CHUNK = CHUNK_KB * 1024, MIN_CHUNK = 32 * 1024;
  const courseTitle = (document.querySelector('h1')?.textContent || '').trim().replace(/\s+/g, ' ');

  const STORE = 'ipcs-pdf-done';
  let done = {};
  if (RESUME) { try { done = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch {} }
  const remember = (keys, name) => {
    keys.forEach(k => { done[k] = name; });
    try { localStorage.setItem(STORE, JSON.stringify(done)); } catch {}
  };

  const visited = new Set(), queued = new Set(), checked = new Set(), savedUrls = new Set();
  const seenHashes = new Set(), viewerPages = new Set();
  const found = [], failed = [], viewerReport = [];
  let skipped = 0;
  let n = Math.max(0, ...Object.values(done).map(s => parseInt(s, 10) || 0)); // continue numbering

  const isCoursePage = u =>
    u.origin === start.origin &&
    u.pathname.toLowerCase() === start.pathname.toLowerCase() &&
    (!courseId || u.searchParams.get('id') === courseId) &&
    !SKIP.test(u.href);

  const pageLabel = (doc, url) => {
    const hs = [...doc.querySelectorAll('h1, h2, h3, h4')]
      .map(h => h.textContent.trim().replace(/\s+/g, ' '))
      .filter(t => t && t.length < 100 && t !== courseTitle);
    const u = unitOf(url);
    return (hs[0] || 'Unit') + (u ? ` [u=${u}]` : '');
  };

  // ─── Network ────────────────────────────────────────────────────────────
  const OPTS = { credentials: 'include', cache: 'no-store' };
  const online = () => navigator.onLine ? Promise.resolve() : new Promise(r => {
    console.warn('   … offline, waiting for the connection to come back');
    addEventListener('online', r, { once: true });
  });
  const isMedia = type => /^(image|video|audio)\/|css|javascript/.test(type);

  async function retry(label, fn) {
    let err;
    for (let i = 0; i <= RETRIES; i++) {
      try { await online(); return await fn(); }
      catch (e) {
        err = e;
        if (i < RETRIES) {
          const s = Math.min(2 * (i + 1), 10);
          console.warn(`   ↻ network dropped, retry ${i + 1}/${RETRIES} in ${s}s: ${label}`);
          await sleep(s * 1000);
        }
      }
    }
    throw err;
  }

  // whole response in one request (small pages, or servers without range support)
  const whole = url => retry(short(url), async () => {
    const res = await fetch(url, OPTS);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const media = isMedia(type);
    const blob = res.ok && !media ? await res.blob() : null;
    return { res, type, media, blob };
  });

  // file in small ranged pieces; a drop only costs the current piece
  async function chunked(url, total) {
    const parts = [];
    let pos = 0, piece = CHUNK, fails = 0, streak = 0, nextLog = 0.25;
    if (total > CHUNK) console.log(`     ↓ ${short(url)} — ${size(total)}, downloading in pieces`);
    while (pos < total) {
      const end = Math.min(pos + piece, total) - 1;
      try {
        await online();
        const r = await fetch(url, { ...OPTS, headers: { Range: `bytes=${pos}-${end}` } });
        if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        if (buf.byteLength !== end - pos + 1) throw new Error('short read');
        parts.push(buf);
        pos = end + 1; fails = 0;
        if (++streak >= 4) { piece = Math.min(CHUNK, piece * 2); streak = 0; }  // grow back slowly
        if (total > 4 * CHUNK && pos / total >= nextLog && pos < total) {
          console.log(`       ${Math.round(pos / total * 100)}% (${size(pos)} of ${size(total)})`);
          nextLog += 0.25;
        }
      } catch (e) {
        if (++fails > RETRIES * 2) throw e;
        streak = 0;
        piece = Math.max(MIN_CHUNK, piece >> 1);
        const s = Math.min(fails, 8);
        console.warn(`   ↻ dropped at ${size(pos)} of ${size(total)} — retrying a ${size(piece)} piece in ${s}s`);
        await sleep(s * 1000);
      }
    }
    return new Blob(parts);
  }

  async function get(url) {
    // tiny probe: learns type + size, and whether the server supports ranges
    const probe = await retry(short(url), async () => {
      const res = await fetch(url, { ...OPTS, headers: { Range: 'bytes=0-0' } });
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const media = isMedia(type);
      if (res.status === 206) return { res, type, media, blob: null };
      // no range support → this response is the whole thing; read it now
      const blob = res.ok && !media ? await res.blob() : null;
      return { res, type, media, blob };
    });
    const { res, type, media } = probe;
    if (res.status === 416) return whole(url);
    if (res.status !== 206 || media) return probe;

    const total = +((res.headers.get('content-range') || '').split('/')[1]);
    const enc = (res.headers.get('content-encoding') || 'identity').toLowerCase();
    if (!(total > 0) || enc !== 'identity' || type.includes('text/html')) return whole(url);

    const blob = await chunked(url, total);
    if (blob.size !== total) throw new Error('size mismatch');
    return { res, type, media: false, blob };
  }

  // ─── Saving ─────────────────────────────────────────────────────────────
  const isBlob = b => b && typeof b.slice === 'function' && typeof b.size === 'number';  // works across frames
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
  const numbered = name => {
    name = clean(name) || 'document';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    return `${String(++n).padStart(3, '0')} - ${name}`;
  };

  async function save(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 120000);
    await sleep(DELAY_MS);
  }

  // save a confirmed PDF once (identical files are skipped by content hash)
  async function keep(blob, { name, page, source, keys = [] }) {
    const h = await sha(blob);
    if (h && (seenHashes.has(h) || done['sha:' + h])) {
      skipped++;
      console.log(`   · same file as ${done['sha:' + h] || 'one saved earlier'} — skipped`);
      if (DOWNLOAD) remember(keys, done['sha:' + h] || 'dup');
      return;
    }
    if (h) seenHashes.add(h);
    const file = numbered(name);
    found.push({ '#': n, file, page, size: size(blob.size), source: trunc(source, 70) });
    console.log(`   ✓ ${file} (${size(blob.size)})`);
    if (DOWNLOAD) {
      await save(new Blob([blob], { type: 'application/pdf' }), file);
      remember([...keys, ...(h ? ['sha:' + h] : [])], file);
    }
  }

  // ─── Pass A: find PDF candidates in a document ─────────────────────────
  function scan(doc, baseUrl, page) {
    const out = [];
    const add = (raw, label, embedded, weak) => {
      if (!raw) return;
      raw = raw.trim();
      if (!raw || /^(javascript:|mailto:|tel:|data:|blob:|#)/i.test(raw)) return;
      let u; try { u = new URL(raw, baseUrl); } catch { return; }
      // unwrap viewers like viewer.html?file=/docs/notes.pdf or ?url=...pdf
      for (const [, v] of u.searchParams) {
        if (PDF.test(v)) { try { u = new URL(v, u); } catch {} break; }
      }
      if (!/^https?:$/.test(u.protocol)) return;
      const isPdfUrl = PDF.test(u.href);
      if (!isPdfUrl && SKIP.test(u.href)) return;
      const same = u.origin === start.origin;
      if (isPdfUrl || (same && (embedded || HANDLER.test(u.pathname + u.search))))
        out.push({ url: norm(u.href), label: (label || '').trim().replace(/\s+/g, ' '), page, weak: !!weak });
    };

    doc.querySelectorAll('iframe[src], frame[src], embed[src], object[data]').forEach(el =>
      add(el.getAttribute('src') || el.getAttribute('data'), el.getAttribute('title'), true));
    doc.querySelectorAll('a[href]').forEach(a => add(a.getAttribute('href'), a.textContent, false));

    // quoted strings first (handles spaces in file names), then bare paths.
    // `.pdf` must end the name, so e.g. "ej.pdfviewer.PdfViewer" doesn't count.
    const pdfPaths = s => {
      const q = [...s.matchAll(/(['"])([^'"<>]+?\.pdf(?:\?[^'"<>]*)?)\1/gi)].map(m => m[2]);
      return q.length ? q : [...s.matchAll(/[^'"\s()<>=]+\.pdf(?![\w])(?:\?[^'"\s()<>]*)?/gi)].map(m => m[0]);
    };
    const attrPaths = s => {
      const q = [...s.matchAll(/(['"])([^'"<>]+?\.(?:pdf|ashx)(?:\?[^'"<>]*)?)\1/gi)].map(m => m[2]);
      const p = q.length ? q : [...s.matchAll(/[^'"\s()<>=]+\.(?:pdf|ashx)(?![\w])(?:\?[^'"\s()<>]*)?/gi)].map(m => m[0]);
      return p.filter(x => /\.pdf/i.test(x) || SAFE_ASHX.test(x));   // skip app endpoints like GetNotes.ashx
    };

    // paths hidden in data-* attributes or onclick handlers
    doc.querySelectorAll('[data-src], [data-url], [data-file], [onclick]').forEach(el => {
      for (const k of ['data-src', 'data-url', 'data-file', 'onclick']) {
        const v = el.getAttribute(k); if (!v) continue;
        const p = attrPaths(v);
        if (p.length) p.forEach(x => add(x, el.textContent, false, true));
        else if (k !== 'onclick' && /\.pdf/i.test(v)) add(v, el.textContent, false, true);
      }
    });
    // .pdf paths inside inline scripts (never .ashx — those are the app's own endpoints)
    doc.querySelectorAll('script:not([src])').forEach(s => pdfPaths(s.textContent).forEach(x => add(x, '', false, true)));
    return out;
  }

  // PDFs the page already loaded via JavaScript (current tab only)
  function liveCandidates(page) {
    const out = [], wins = [window];
    document.querySelectorAll('iframe, frame').forEach(f => {
      try { if (f.contentWindow.location.origin === start.origin) wins.push(f.contentWindow); } catch {}
    });
    for (const w of wins) {
      try {
        w.performance.getEntriesByType('resource').forEach(e => {
          if (PDF.test(e.name)) out.push({ url: norm(e.name), label: '', page, weak: true });
        });
        if (w !== window) out.push(...scan(w.document, w.location.href, page));
      } catch {}
    }
    return out;
  }

  // fetch a candidate; save it if it's really a PDF
  async function resolve(c, depth = 0) {
    if (checked.has(c.url)) return;
    checked.add(c.url);
    if (done[c.url]) { skipped++; console.log(`   · already saved: ${done[c.url]}`); return; }

    let r;
    try { r = await get(c.url); }
    catch {
      const same = new URL(c.url).origin === start.origin;
      failed.push({ why: same ? 'network error — re-run to retry' : 'blocked (other site)', page: c.page, url: c.url });
      console.warn(`   ✗ gave up on ${short(c.url)} — re-run the script later to pick it up`);
      return;
    }
    const { res, type, media, blob } = r;
    if (!res.ok) { if (!(c.weak && res.status === 404)) failed.push({ why: `HTTP ${res.status}`, page: c.page, url: c.url }); return; }   // names found in scripts aren't always URLs
    if (media || !blob) return;

    if (type.includes('text/html')) {
      if (depth > 0) return;                     // wrapper/viewer page: look one level inside
      const doc = new DOMParser().parseFromString(await blob.text(), 'text/html');
      for (const d of scan(doc, res.url, c.page)) await resolve({ ...d, label: d.label || c.label }, depth + 1);
      return;
    }

    if (!(await isPdf(blob))) return;
    const key = norm(res.url);
    if (savedUrls.has(key)) return;
    savedUrls.add(key);
    if (done[key]) { skipped++; console.log(`   · already saved: ${done[key]}`); return; }

    const cd = res.headers.get('content-disposition') || '';
    let name = '';
    const star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
    const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (star) { try { name = decodeURIComponent(star[1].replace(/"/g, '')); } catch {} }
    if (!name && plain) name = plain[1];
    if (!name && /\.pdf$/i.test(short(res.url))) name = short(res.url);
    await keep(blob, { name: name || c.label || c.page, page: c.page, source: key, keys: [c.url, key] });
  }

  // ─── Pass B: the site's PDF viewer (Syncfusion EJ2) ────────────────────
  function findViewers(w) {
    const out = [];
    try {
      w.document.querySelectorAll('*').forEach(el => {
        (el.ej2_instances || []).forEach(inst => {
          try { if (inst.getModuleName && inst.getModuleName() === 'PdfViewer' && !out.includes(inst)) out.push(inst); } catch {}
        });
      });
    } catch {}
    return out;
  }

  async function waitForViewers(w) {
    const t0 = Date.now();
    let told = false;
    while (Date.now() - t0 < VIEWER_WAIT_S * 1000) {
      const vs = findViewers(w);
      if (vs.length && vs.every(v => v.pageCount > 0)) return vs;
      if (!vs.length && Date.now() - t0 > 15000) return [];          // no viewer on this page
      if (vs.length && !told && Date.now() - t0 > 3000) { console.log('     … waiting for the viewer to load the document'); told = true; }
      await sleep(500);
    }
    return findViewers(w).filter(v => v.pageCount > 0);
  }

  function loadInFrame(url) {
    return new Promise(resolveFrame => {
      const f = document.createElement('iframe');
      // sandboxed: scripts run (so the viewer loads), but no form posts, popups or top navigation
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads');
      f.style.cssText = 'position:fixed;left:-12000px;top:0;width:1280px;height:900px;border:0;';
      const t = setTimeout(() => resolveFrame(f), 60000);
      f.addEventListener('load', () => { clearTimeout(t); resolveFrame(f); }, { once: true });
      f.src = url;
      document.body.appendChild(f);
    });
  }

  async function grabFromViewer(v, w, label) {
    const dp = typeof v.documentPath === 'string' ? v.documentPath.trim() : '';
    const dpIsData = /^data:/i.test(dp) || (dp.length > 300 && !/^(https?:)?\/\//i.test(dp) && !dp.startsWith('/'));
    let dpName = '';
    if (dp && !dpIsData) { try { dpName = short(new URL(dp, w.location.href).href); } catch {} }
    const name = v.downloadFileName || (/\.pdf$/i.test(dpName) ? dpName : '') || label;
    let error = '';

    // already saved as a direct link in pass A?
    if (dp && !dpIsData) {
      try {
        const k = norm(new URL(dp, w.location.href).href);
        if (savedUrls.has(k) || done[k]) return { blob: null, how: 'already saved', name };
      } catch {}
    }

    // 1) the viewer's own save routine, with its download switch turned back on
    try {
      v.enableDownload = true;
      const p = v.saveAsBlob();
      if (p) {
        let b = await Promise.race([p, sleep(120000).then(() => 'timeout')]);
        if (b === 'timeout') error = 'viewer save timed out';
        else {
          if (typeof b === 'string' && /^data:|^JVBER/.test(b)) b = dataToBlob(b);
          if (await isPdf(b)) return { blob: b, how: 'viewer save', name };
          error = 'viewer save returned no PDF';
        }
      } else error = 'viewer save unavailable';
    } catch (e) { error = 'viewer save: ' + (e?.message || e); }

    // 2) where the viewer got the document from (embedded data or a URL)
    if (dpIsData) {
      try { const b = dataToBlob(dp); if (await isPdf(b)) return { blob: b, how: 'embedded data', name }; }
      catch (e) { error += ' | data: ' + e.message; }
    } else if (dp) {
      try {
        const u = new URL(dp, w.location.href);
        if (/^https?:$/.test(u.protocol)) {
          const r = await get(u.href);
          if (await isPdf(r.blob)) return { blob: r.blob, how: 'document URL', name };
          error += ` | url: HTTP ${r.res.status}, not a PDF`;
        }
      } catch (e) { error += ' | url: ' + e.message; }
    }

    // 3) last resort: the viewer's own download action (browser saves it directly)
    try {
      v.enableDownload = true;
      v.download();
      await sleep(4000);
      return { blob: null, how: 'viewer download triggered', name, error };
    } catch (e) { error += ' | download: ' + (e?.message || e); }
    return { blob: null, how: 'failed', name, error };
  }

  // ─── Crawl (pass A) ────────────────────────────────────────────────────
  console.log('%cIPCS PDF downloader — starting', 'font-weight:bold');
  if (RESUME && Object.keys(done).length) console.log('(resuming — files saved by earlier runs will be skipped)');
  const queue = [start.href];
  queued.add(norm(start.href));
  while (queue.length && visited.size < MAX_PAGES) {
    const url = queue.shift(), key = norm(url);
    if (visited.has(key)) continue;
    visited.add(key);

    let doc, html;
    if (key === norm(location.href)) {
      doc = document;
      html = document.documentElement.innerHTML;
      if (findViewers(window).length) viewerPages.add(key);
    } else {
      let r;
      try { r = await get(url); }
      catch { console.warn(`   ✗ couldn't load page ${url} — re-run later to cover it`); continue; }
      if (r.res.redirected && !isCoursePage(new URL(r.res.url))) {
        console.warn('Redirected away from the course — session probably expired. Log in again and re-run.');
        break;
      }
      if (!r.res.ok || !r.blob) continue;
      html = await r.blob.text();
      doc = new DOMParser().parseFromString(html, 'text/html');
    }
    if (/pdfviewer/i.test(html)) viewerPages.add(key);

    const label = pageLabel(doc, url);
    console.log(`[page ${visited.size}] ${label}${viewerPages.has(key) ? '  (has PDF viewer)' : ''}`);
    const cands = scan(doc, url, label);
    if (doc === document) cands.push(...liveCandidates(label));
    for (const c of cands) {
      try { await resolve(c); }
      catch (e) { if (!c.weak) failed.push({ why: `error: ${e.message}`, page: c.page, url: c.url }); }
    }

    if (CRAWL_COURSE) doc.querySelectorAll('a[href]').forEach(a => {
      try {
        const u = new URL(a.getAttribute('href'), url), k = norm(u.href);
        if (isCoursePage(u) && !queued.has(k)) { queued.add(k); queue.push(u.href); }
      } catch {}
    });
  }

  // ─── Viewer documents (pass B) ─────────────────────────────────────────
  let framingBlocked = false;
  if (VIEWER && viewerPages.size) {
    console.log(`%cPDF viewer — checking ${viewerPages.size} page(s)`, 'font-weight:bold');
    for (const pageUrl of viewerPages) {
      if (done['viewerpage:' + pageUrl]) { skipped++; console.log(`   · viewer on u=${unitOf(pageUrl)} already done`); continue; }
      let w = null, frame = null;
      if (pageUrl === norm(location.href)) w = window;
      else {
        frame = await loadInFrame(pageUrl);
        try { w = frame.contentWindow; void w.document.body.innerHTML; } catch { w = null; }
        if (!w || w.location.href === 'about:blank') {
          framingBlocked = true;
          viewerReport.push({ page: `u=${unitOf(pageUrl)}`, how: 'failed', error: 'page could not be loaded in a hidden frame' });
          frame.remove();
          continue;
        }
        if (!isCoursePage(new URL(w.location.href))) {
          console.warn('Redirected away from the course — session probably expired. Log in again and re-run.');
          frame.remove();
          break;
        }
      }
      const label = pageLabel(w.document, pageUrl);
      console.log(`[viewer] ${label}`);
      const viewers = await waitForViewers(w);
      if (!viewers.length) {
        viewerReport.push({ page: label, how: 'no document', error: 'no loaded viewer found on this page' });
        frame?.remove();
        continue;
      }
      let allOk = true;
      for (const [i, v] of viewers.entries()) {
        const r = await grabFromViewer(v, w, label);
        viewerReport.push({
          page: label, how: r.how, pages: v.pageCount, mode: v.serviceUrl ? 'server' : 'standalone',
          documentPath: trunc(v.documentPath), serviceUrl: v.serviceUrl || '', error: r.error || '',
        });
        if (r.blob) await keep(r.blob, { name: r.name, page: label, source: `viewer (${r.how})` });
        else if (r.how === 'already saved') { skipped++; console.log(`   · viewer shows ${r.name} — already saved`); }
        else if (r.how === 'viewer download triggered') console.log(`   ↓ viewer download started: ${r.name} (check your Downloads)`);
        else { allOk = false; console.warn(`   ✗ couldn't extract the viewer document on ${label}: ${r.error}`); }
      }
      if (allOk && DOWNLOAD) remember(['viewerpage:' + pageUrl], 'done');
      frame?.remove();
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────
  console.log(`%cDone — ${found.length} new PDF(s) from ${visited.size} page(s)` +
    (skipped ? `, ${skipped} already saved earlier` : '') + '.', 'font-weight:bold;color:green');
  if (found.length) console.table(found);
  if (viewerReport.length) { console.log('PDF viewer results:'); console.table(viewerReport); }
  if (failed.length) {
    console.warn(`${failed.length} file(s) not downloaded — re-run the script to retry, or open these manually:`);
    console.table(failed);
  }
  if (framingBlocked)
    console.warn('The site blocked loading some unit pages in a hidden frame. Open those units yourself and run the script on each — it grabs the viewer on the current page.');
  const viewerTrouble = viewerReport.some(r => r.how === 'failed');
  if (viewerTrouble || (!found.length && !skipped)) {
    const report = JSON.stringify({ pages: visited.size, found: found.map(f => f.file), viewer: viewerReport, failed: failed.slice(0, 20) }, null, 1);
    try { copy(report); console.warn('Not everything could be extracted. A short diagnostic report was copied to your clipboard — include it when reporting an issue.'); }
    catch { console.warn('Not everything could be extracted. Copy the tables above and include them when reporting an issue.'); }
  }

  if (DOWNLOAD && (found.length || failed.length)) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const lines = ['#\tfile\tpage\tsource', ...found.map(f => `${f['#']}\t${f.file}\t${f.page}\t${f.source}`)];
    if (failed.length) lines.push('', 'NOT DOWNLOADED (re-run to retry, or open manually):', ...failed.map(f => `${f.why}\t${f.page}\t${f.url}`));
    await save(new Blob([lines.join('\n')], { type: 'text/plain' }), `000 - index ${stamp}.txt`);
  }
  } finally {
    window.__ipcsRunning = false;
  }
})();
