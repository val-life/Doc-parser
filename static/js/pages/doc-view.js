/* ── Page: Document View ────────────────────────────────────────────────────── */

import { api } from '../api.js';
import { esc } from '../utils.js';
import { toast } from '../toast.js';
import { watchJob } from '../sse.js';
import { state, setBreadcrumb, setTopbarActions, registerPage } from '../state.js';

registerPage('doc-view', renderDocView);

async function renderDocView() {
  const { kb, filename, jobId, sourceUrl } = state;
  const isUrlSource = !!sourceUrl;

  setBreadcrumb([
    { label: 'Knowledge Bases', page: 'kb-list' },
    { label: kb, page: 'kb-sources', kb },
    { label: filename, page: 'doc-view', kb, filename },
  ]);

  const stem = isUrlSource ? filename : filename.replace(/\.[^.]+$/, '');
  const ext  = isUrlSource ? '' : (filename.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const isPreviewable = ['.pdf', '.docx', '.doc'].includes(ext);

  // Enable full-height split layout
  const content = document.getElementById('content');
  content.classList.add('doc-split-mode');

  const previewSrc = `/api/knowledge-bases/${encodeURIComponent(kb)}/preview/${encodeURIComponent(filename)}`;

  // Left panel: URL sources try to embed in an iframe; files get the PDF iframe
  const leftPanelHTML = isUrlSource
    ? `<div style="position:relative;flex:1;min-height:0;display:flex;flex-direction:column">
         <iframe class="doc-preview-frame" id="url-preview-frame"
           src="${esc(sourceUrl)}"
           title="Original page"
           sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
           referrerpolicy="no-referrer"></iframe>
         <!-- Default overlay: shown until the iframe proves it loaded something -->
         <div id="url-frame-blocked" style="
           position:absolute;inset:0;
           display:flex;flex-direction:column;align-items:center;justify-content:center;
           background:var(--paper);gap:14px;padding:24px;text-align:center;
           transition:opacity .3s">
           <svg viewBox="0 0 24 24" fill="none" width="36" height="36">
             <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.4"/>
             <path d="M12 3c-2 3-3 5.5-3 9s1 6 3 9M12 3c2 3 3 5.5 3 9s-1 6-3 9M3 12h18" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
           </svg>
           <div style="font-size:13px;color:var(--ink-muted);line-height:1.6;max-width:220px">
             Many sites block embedding.<br>Open the original in a new tab:
           </div>
           <a id="url-open-btn" href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer"
             class="btn btn-primary" style="display:inline-flex;align-items:center;gap:6px">
             Open in browser
             <svg viewBox="0 0 12 12" fill="none" width="11" height="11">
               <path d="M5 2H2v8h8V7M7 2h3v3M10 2L5 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
             </svg>
           </a>
           <button id="url-try-embed" class="btn btn-ghost" style="font-size:11px;padding:4px 10px">
             Try to load inline \u2193
           </button>
         </div>
       </div>`
    : isPreviewable
       ? `<div style="position:relative;flex:1;min-height:0;display:flex;flex-direction:column">
         ${ext !== '.pdf' ? `<div id="preview-converting" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--paper);z-index:1;font-size:13px;color:var(--ink-muted)">Converting to PDF\u2026</div>` : ''}
         <iframe class="doc-preview-frame" id="file-preview-frame" src="${ext === '.pdf' ? esc(previewSrc) : 'about:blank'}" data-preview-src="${esc(previewSrc)}" title="Original document"></iframe>
         </div>`
      : `<div class="doc-preview-placeholder">
           <svg viewBox="0 0 24 24" fill="none" width="40" height="40"><rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M8 8h8M8 12h8M8 16h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
           <div>Preview unavailable for ${esc(ext.replace(/^\./, '').toUpperCase())} files</div>
           <a class="btn btn-ghost" href="${esc(previewSrc)}" download="${esc(filename)}" style="margin-top:12px">Download original</a>
         </div>`;

  content.innerHTML = `
    <div class="doc-split-view page-enter">
      <!-- Left: original file / URL -->
      <div class="doc-split-left">
        <div class="doc-split-header">Original</div>
        ${leftPanelHTML}
      </div>

      <!-- Right: parsed output -->
      <div class="doc-split-right">
        <div class="doc-split-header">
          <span class="doc-filename" title="${esc(filename)}">${esc(filename)}</span>
          <span id="stream-status" class="stream-status"></span>
        </div>
        <div class="tab-bar">
          <button class="tab-btn active" data-tab="rendered">Rendered</button>
          <button class="tab-btn" data-tab="raw">Raw</button>
        </div>
        <div id="doc-output"><div class="empty-state"><div class="empty-title">Loading\u2026</div></div></div>
      </div>
    </div>`;

  setTopbarActions(`
    <button class="btn btn-ghost" id="btn-copy-md">
      <svg viewBox="0 0 16 16" fill="none"><rect x="5" y="4" width="8" height="10" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M3 3v9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      Copy
    </button>
    <a class="btn btn-ghost" id="btn-dl-md" download="${esc(stem)}.md">
      <svg viewBox="0 0 16 16" fill="none"><path d="M8 3v8M5 8l3 3 3-3M3 13h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Download
    </a>`);

  let markdown      = '';
  let activeTab     = 'rendered';
  let isStreaming   = false;
  let renderTimer   = null;

  // URL source: the blocked overlay is shown by default.
  // Hide it only when the iframe fires 'load' for same-origin content,
  // or when the user explicitly clicks "Try to load inline".
  if (isUrlSource) {
    const frame   = document.getElementById('url-preview-frame');
    const blocked = document.getElementById('url-frame-blocked');
    const tryBtn  = document.getElementById('url-try-embed');

    if (frame && blocked) {
      // If user clicks "Try to load inline" → hide the overlay so the iframe shows
      tryBtn?.addEventListener('click', () => {
        blocked.style.opacity = '0';
        setTimeout(() => { blocked.style.display = 'none'; }, 300);
      });

      // If the iframe somehow loads same-origin content (rare for external URLs)
      // automatically hide the overlay
      frame.addEventListener('load', () => {
        try {
          const href = frame.contentWindow?.location?.href;
          // Same-origin and has real content → hide overlay
          if (href && href !== 'about:blank' && href !== '') {
            blocked.style.opacity = '0';
            setTimeout(() => { blocked.style.display = 'none'; }, 300);
          }
        } catch {
          // Cross-origin: can't read location, leave overlay visible
        }
      });
    }
  }

  if (!isUrlSource && isPreviewable && ext !== '.pdf') {
    const previewFrame = document.getElementById('file-preview-frame');
    const previewOverlay = document.getElementById('preview-converting');
    const previewUrl = previewFrame?.dataset.previewSrc || previewSrc;

    const hidePreviewOverlay = () => {
      previewOverlay?.remove();
    };

    const showPreviewError = (message) => {
      if (!previewOverlay) return;
      previewOverlay.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px;text-align:center;max-width:280px">
          <div>${esc(message)}</div>
          <a class="btn btn-ghost" href="${esc(previewUrl)}" target="_blank" rel="noopener noreferrer">Open preview</a>
        </div>`;
    };

    previewFrame?.addEventListener('load', hidePreviewOverlay, { once: true });
    previewFrame?.addEventListener('error', () => showPreviewError('Preview failed to load'));

    fetch(previewUrl, { method: 'HEAD' })
      .then(response => {
        if (!response.ok) throw new Error(`Preview request failed (${response.status})`);
        if (previewFrame) {
          previewFrame.src = previewUrl;
          window.setTimeout(hidePreviewOverlay, 1200);
        }
      })
      .catch(() => {
        showPreviewError('Could not generate a PDF preview for this document');
      });
  }

  const statusEl = document.getElementById('stream-status');
  const outputEl = document.getElementById('doc-output');

  function setStatus(msg, cls = '') {
    if (statusEl) { statusEl.textContent = msg; statusEl.className = `stream-status ${cls}`; }
  }

  function scheduleRender() {
    if (activeTab !== 'rendered') return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => renderRendered(markdown), isStreaming ? 300 : 0);
  }

  function renderRendered(md) {
    if (activeTab !== 'rendered') return;
    let html = '';
    if (typeof marked !== 'undefined') {
      marked.setOptions({ gfm: true, breaks: false });
      html = marked.parse(md);
    } else {
      html = `<pre>${esc(md)}</pre>`;
    }
    outputEl.innerHTML = `<div class="markdown-body">${html}</div>`;
  }

  function renderRaw(md, editable) {
    if (editable) {
      outputEl.innerHTML = `
        <textarea id="raw-editor" class="raw-editor" spellcheck="false">${esc(md)}</textarea>
        <div class="raw-actions">
          <button class="btn btn-primary" id="btn-save-md">Save</button>
          <span id="save-status" class="save-status"></span>
        </div>`;
      document.getElementById('raw-editor')?.addEventListener('input', e => {
        markdown = e.target.value;
        wireButtons(markdown);
      });
      document.getElementById('btn-save-md')?.addEventListener('click', () => saveMarkdown(kb, filename));
    } else {
      outputEl.innerHTML = `<pre class="raw-view">${esc(md)}</pre>`;
    }
  }

  function showTab(tab) {
    activeTab = tab;
    if (tab === 'rendered') {
      renderRendered(markdown);
    } else {
      renderRaw(markdown, !isStreaming);
    }
  }

  function onDone() {
    isStreaming = false;
    setStatus('Done', 'done');
    renderRendered(markdown);
    if (activeTab === 'raw') renderRaw(markdown, true);
    wireButtons(markdown);
  }

  function wireButtons(md) {
    const copyBtn = document.getElementById('btn-copy-md');
    const dlBtn   = document.getElementById('btn-dl-md');
    if (copyBtn) {
      copyBtn.onclick = () => navigator.clipboard.writeText(md).then(() => toast('success', 'Copied', 'Markdown in clipboard'));
    }
    if (dlBtn) {
      const blob = new Blob([md], { type: 'text/markdown' });
      dlBtn.href = URL.createObjectURL(blob);
    }
  }

  // Tab switching
  content.querySelector('.tab-bar')?.addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    content.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    showTab(btn.dataset.tab);
  });

  wireButtons(markdown);

  // ── Streaming parse (reconnect to active job) ────────────────────────────────
  if (jobId) {
    isStreaming = true;
    setStatus('Connecting\u2026', 'streaming');
    outputEl.innerHTML = `<div class="stream-placeholder"><div class="stream-cursor"></div></div>`;

    const es = watchJob(jobId, event => {
      if (event.type === 'token') {
        markdown += event.text;
        if (activeTab === 'rendered') {
          scheduleRender();
        } else {
          // Live update raw pre (not textarea yet — that comes after done)
          const pre = outputEl.querySelector('.raw-view');
          if (pre) pre.textContent = markdown;
          else if (!outputEl.querySelector('#raw-editor')) {
            outputEl.innerHTML = `<pre class="raw-view">${esc(markdown)}</pre>`;
          }
        }
      } else if (event.type === 'queued') {
        setStatus(event.message || 'Queued', 'streaming');
      } else if (event.type === 'status') {
        setStatus(event.message, 'streaming');
      } else if (event.type === 'pages') {
        setStatus(`0/${event.total} pages`, 'streaming');
      } else if (event.type === 'progress') {
        setStatus(event.message || `Page ${event.page || 0}/${event.total}`, 'streaming');
      } else if (event.type === 'done') {
        onDone();
      } else if (event.type === 'error') {
        isStreaming = false;
        setStatus('Error', 'error');
        toast('error', 'Parse failed', event.message);
      } else if (event.type === 'cancelled') {
        isStreaming = false;
        setStatus('Cancelled', '');
      }
    });
    addCleanup(() => es.close());

    return;
  }

  // ── Load existing output ─────────────────────────────────────────────────────
  try {
    const res = await api.get(
      `/knowledge-bases/${encodeURIComponent(kb)}/output?filename=${encodeURIComponent(filename)}`
    );
    markdown = res.markdown;
  } catch (e) {
    const isNotFound = e.message === 'Output not found' || e.message === 'Not Found';
    outputEl.innerHTML = isNotFound
      ? `<div class="empty-state"><div class="empty-title">Not yet parsed</div><div class="empty-sub">Go back and click Parse to generate output for this document</div></div>`
      : `<div class="empty-state"><div class="empty-title">Failed to load output</div><div class="empty-sub">${esc(e.message)}</div></div>`;
    return;
  }

  setStatus('');
  renderRendered(markdown);
  wireButtons(markdown);
}

async function saveMarkdown(kb, filename) {
  const editor   = document.getElementById('raw-editor');
  const statusEl = document.getElementById('save-status');
  const markdown = editor?.value ?? '';
  if (statusEl) statusEl.textContent = 'Saving\u2026';
  try {
    await api.put(
      `/knowledge-bases/${encodeURIComponent(kb)}/output?filename=${encodeURIComponent(filename)}`,
      { markdown }
    );
    if (statusEl) { statusEl.textContent = 'Saved'; statusEl.className = 'save-status saved'; }
    toast('success', 'Saved', 'Markdown updated');
  } catch (e) {
    if (statusEl) { statusEl.textContent = 'Save failed'; statusEl.className = 'save-status error'; }
    toast('error', 'Save failed', e.message);
  }
}

