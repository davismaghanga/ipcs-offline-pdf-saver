# IPCS LMS — Offline PDF Saver

Two browser-console scripts that save the course PDFs you can already read on the [IPCS student portal](https://study.personalcarescience.com.au) so you can study offline.

- **`ipcs-pdf-downloader.js`**: crawls every unit page in a course and saves PDFs that are linked directly.
- **`ipcs-viewer-capture.js`**: saves documents shown in the site's built-in PDF viewer (Syncfusion EJ2), where the download button is turned off.

Both run in your own logged-in browser tab. There's nothing to install, no credentials are involved, and there's no server.

> **Personal use only.** Not affiliated with the Institute of Personal Care Science. Course materials are the provider's copyright and are licensed to enrolled students. Use these scripts only for courses you're enrolled in, keep the files for your own study, and **don't commit or share the downloaded PDFs**.

---

## Requirements

- A Chromium browser (Chrome, Edge or Brave) with DevTools
- An active IPCS student login

## Quick start

### 1. Save directly linked PDFs

1. Log in and open any unit page, e.g. `…/_students/units.aspx?id=<course>&m=<module>&u=<unit>`.
2. Open DevTools → **Console** (`F12`, or `Cmd+Opt+J` on Mac).
   If Chrome blocks the paste, type `allow pasting` and press Enter.
3. Paste the contents of `ipcs-pdf-downloader.js` and press Enter.
4. When the browser asks to **download multiple files**, click **Allow**.

The script visits every unit in the course, saves each PDF it finds, and writes an index file. Re-running it skips files that are already saved.

### 2. Save documents from the PDF viewer

1. Open any course page, then paste `ipcs-viewer-capture.js` into the Console.
2. The course reopens inside a window with a **green status bar** at the top.
3. Browse normally and open each PDF. Every document is saved as soon as it finishes loading.
4. Click **Close** when you're done.

The script keeps running as you move between units and when a document opens in a popup, so you only paste it once.

> Turn off Chrome's **"Ask where to save each file"** setting, or you'll get a save dialog for every PDF.

---

## Output

```
000 - index 2026-09-29-10-01.txt   # map of files → unit → source (downloader)
001 - Welcome pack V2.1.pdf
002 - Unit 5 - Skin - Notes.pdf
003 - Unit 6 Reading.pdf
```

- The number prefix keeps files in the order they were found and prevents name clashes. It continues from earlier runs.
- Names come from the server's `Content-Disposition` header, then the document's own name, then the link you clicked, then the unit title.

## Configuration

Edit the constants at the top of `ipcs-pdf-downloader.js`:

| Setting | Default | Purpose |
|---|---|---|
| `CRAWL_COURSE` | `true` | Visit every unit page in the course (same `?id=`) |
| `VIEWER` | `true` | Also try to extract documents from the viewer on each unit page |
| `DOWNLOAD` | `true` | `false` = dry run: list what it finds, download nothing |
| `RESUME` | `true` | Skip files saved by earlier runs |
| `CHUNK_KB` | `256` | Size of each download piece; shrinks to 32 KB automatically on unstable connections |
| `RETRIES` | `6` | Retries per request or piece |
| `VIEWER_WAIT_S` | `90` | Maximum wait for the viewer to load a document |
| `MAX_PAGES` | `300` | Safety cap on pages visited |
| `DELAY_MS` | `900` | Pause between downloads |

**Start over from scratch** by running this in the Console to clear the saved-files list:

```js
localStorage.removeItem('ipcs-pdf-done')
```

---

## How it works

### Finding PDFs (downloader)

- Crawls `units.aspx` pages that share the starting page's course `id`, using breadth-first search with de-duplicated URLs.
- Checks links, `iframe`, `embed` and `object` sources, viewer URLs such as `viewer?file=…pdf`, `data-*` and `onclick` attributes, inline scripts, and the resources the page has already loaded.
- Confirms each candidate by its **bytes** (`%PDF` signature), not by its URL or MIME type.
- Ignores the app's own AJAX endpoints (`*.ashx` found in page scripts), so it never requests them.

### Handling unstable connections

- **Range-chunked downloads:** a tiny `Range: bytes=0-0` request learns the file size and whether the server supports ranges. The file is then fetched in 256 KB pieces, and a dropped connection only costs the piece in progress.
- **Adaptive piece size:** pieces halve after each failure, down to 32 KB, and double again after four successes in a row.
- **Retries and backoff** on every request (2 s up to 10 s). If the browser reports it's offline, the script waits for the `online` event instead of using up retries.
- Falls back to a single full request when the server doesn't support ranges or the response is compressed.

### Resume and de-duplication

- Saved URLs, viewer pages and content hashes are stored in `localStorage` under `ipcs-pdf-done`. Both scripts share this list and the file numbering.
- A **SHA-256** hash of each file's contents skips copies of the same document found on different pages or through different routes.

### Extracting documents from the viewer (Syncfusion EJ2)

- The site's viewer has `enableDownload: false`. In Syncfusion's code, `download()` and `saveAsBlob()` both check only that flag, so the scripts set it back to `true` and call `saveAsBlob()`.
- **Capture mode** patches `PdfViewer.prototype.fireDocumentLoad` (called on every document load) and `PdfViewer.prototype.load`. The `load` patch is needed because a reused viewer doesn't update `documentPath` when it loads the next document.
- It also scans `ej2_instances` as a safety net for documents already open, and wraps `window.open` to follow documents opened in popups.
- If `saveAsBlob()` fails, it tries the document source directly (a URL, fetched in chunks, or embedded base64 data), then the viewer's own `download()`.

### Safety

- The downloader only makes `GET` requests; capture mode also calls the viewer's own save routine.
- It skips logout, quiz, exam and assessment-attempt pages, and anything that looks like an action (`save`, `clear`, `lock`, `delete`, …).
- Pages are loaded in frames sandboxed **without** `allow-top-navigation`, so the site can't redirect your tab. The downloader's hidden frames also block form posts, popups and dialogs.
- A guard stops the script from running twice in the same tab.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `net::ERR_NETWORK_CHANGED` | Your connection keeps switching (VPN, Wi-Fi and Ethernet both on, Docker/WSL/VM network adapters, hotspot changing bands). The script retries automatically; a steadier connection makes it faster. |
| `Already running in this tab` | A previous run is still going. Reload the page (`F5`) and paste once. |
| Viewer pages report "no loaded viewer found" | The site only creates the viewer when you click a document. Use **capture mode** (`ipcs-viewer-capture.js`). |
| Chrome warns an iframe "can escape its sandboxing" | Expected: the frame needs scripts and same-origin access for the viewer to work. |
| "Redirected away from the course" | Your session expired. Log in again and re-run; saved files are skipped. |
| A document opens but capture mode shows no ✓ | Click **Report** in the green bar. It copies a JSON description of how that page opens documents, which you can use to adapt the script. |
| No PDFs at all | Open a document, check DevTools → **Network** filtered by `pdf`, and save the request directly. If there's no PDF request, the site is rendering images, and Print → **Save as PDF** is the only option. |

## Testing

Validated with Playwright and headless Chromium against mock versions of the site:

- **Direct links:** PDFs in iframes, `viewer?file=`, `.ashx` handlers with `Content-Disposition`, `onclick` paths containing spaces, and inline scripts. Checked that logout, quiz and other-course links are never requested.
- **Unstable network:** the mock server cuts any transfer over 150 KB. A 1.5 MB file still arrives byte-for-byte identical.
- **Resume and guards:** a second run downloads nothing new, and a second paste in the same tab is blocked.
- **Viewer:** uses the real `@syncfusion/ej2` PDF Viewer (standalone mode, `enableDownload: false`). Documents are embedded as base64, served by an `.ashx` URL, loaded on click into a reused viewer, or opened in a popup. Each output was checked with `pypdf` for content and page count.

## Limitations

- Built for this portal's Syncfusion EJ2 viewer. Other viewers (PDF.js, Google Docs viewer, flipbooks) need adapting.
- When the viewer runs in **server mode**, `saveAsBlob()` depends on the server's download action still being available. The script then falls back to the document source.
- Changes to the site's HTML or viewer version may break detection.
