/* ── Page: KB Sources (Upload + File Table) ────────────────────────────────── */

import { api } from '../api.js';
import { esc, fmtBytes, statusInfo, fileRowId } from '../utils.js';
import { toast } from '../toast.js';
import { showModal } from '../modal.js';
import { watchJob } from '../sse.js';
import { state, activeJobs, navigate, setBreadcrumb, setTopbarActions, registerPage } from '../state.js';

// Active URL fetch jobs: key = `url:${kb}/${slug}` → {job_id}
const _activeUrlJobs = new Map();

registerPage('kb-sources', renderKbSources);

async function renderKbSources() {
  const { kb } = state;
  setBreadcrumb([
    { label: 'Knowledge Bases', page: 'kb-list' },
    { label: kb, page: 'kb-sources', kb },
  ]);
  setTopbarActions(`
    <button class="btn btn-ghost" id="download-all-output-btn">
      <svg viewBox="0 0 16 16" fill="none" style="width:14px;height:14px">
        <path d="M8 2.5v7M5.5 7.5L8 10l2.5-2.5M3 12.5h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Download All Outputs
    </button>
    <button class="btn btn-ghost" id="add-urls-btn">
      <svg viewBox="0 0 16 16" fill="none" style="width:14px;height:14px">
        <path d="M9 2.5A4.5 4.5 0 1 1 2.5 9 4.5 4.5 0 0 1 9 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M2 14l3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M12 6h2M13 5v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
      </svg>
      Add URLs
    </button>`);

  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="page-enter">
      <!-- Upload zone -->
      <div id="upload-area" class="upload-zone" role="button" tabindex="0" aria-label="Upload document">
        <input type="file" id="file-input" accept=".pdf,.docx,.doc" multiple />
        <svg class="upload-zone-icon" viewBox="0 0 24 24" fill="none">
          <path d="M12 15V4M8 8l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 17v1a2 2 0 002 2h12a2 2 0 002-2v-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <div class="upload-zone-text">Drop files here or click to browse</div>
        <div class="upload-zone-sub">PDF, DOCX, DOC supported</div>
      </div>

      <!-- File table -->
      <div id="file-list-container"></div>

      <!-- URL sources table -->
      <div id="url-list-container"></div>
    </div>`;

  setupUploadZone(kb);
  setupAddUrlsBtn(kb);
  setupDownloadAllBtn(kb);
  await Promise.all([refreshFileList(kb), refreshUrlList(kb)]);
}

function setupDownloadAllBtn(kb) {
  const btn = document.getElementById('download-all-output-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    downloadAllOutputs(kb);
  });
}

async function downloadAllOutputs(kb) {
  try {
    const response = await fetch(
      `/api/knowledge-bases/${encodeURIComponent(kb)}/output/download-all`
    );
    if (!response.ok) {
      let message = response.statusText;
      try {
        const data = await response.json();
        message = data.detail || message;
      } catch {
        // Ignore JSON parsing failures for non-JSON error bodies.
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = `${kb}_output.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  } catch (e) {
    toast('error', 'Download failed', e.message);
  }
}

function setupUploadZone(kb) {
  const zone  = document.getElementById('upload-area');
  const input = document.getElementById('file-input');
  if (!zone || !input) return;

  ['dragenter', 'dragover'].forEach(evt =>
    zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach(evt =>
    zone.addEventListener(evt, () => zone.classList.remove('drag-over')));

  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    uploadFiles(kb, e.dataTransfer.files);
  });

  input.addEventListener('change', () => {
    uploadFiles(kb, input.files);
    input.value = '';
  });
}

async function uploadFiles(kb, fileList) {
  for (const file of fileList) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api.upload(`/knowledge-bases/${encodeURIComponent(kb)}/files`, fd);
      toast('success', 'Uploaded', file.name);
    } catch (e) {
      toast('error', `Upload failed: ${file.name}`, e.message);
    }
  }
  await refreshFileList(kb);
}

async function refreshFileList(kb) {
  const container = document.getElementById('file-list-container');
  if (!container) return;

  let files;
  try {
    files = await api.get(`/knowledge-bases/${encodeURIComponent(kb)}/files`);
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div class="empty-title">Failed to load</div></div>`;
    return;
  }

  if (files.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none"><rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M8 8h8M8 12h8M8 16h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        <div class="empty-title">No files yet</div>
        <div class="empty-sub">Upload a PDF or DOCX to get started</div>
      </div>`;
    return;
  }

  const hasActive = [...activeJobs.keys()].some(k => k.startsWith(kb + '/'));
  container.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <button class="btn ${hasActive ? 'btn-danger' : 'btn-primary'}" id="parse-all-btn" data-mode="${hasActive ? 'stop' : 'parse'}">${hasActive ? 'Stop All' : 'Parse All'}</button>
    </div>
    <div class="file-table-wrap">
      <table class="file-table">
        <thead>
          <tr>
            <th>Filename</th>
            <th>Size</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="file-tbody"></tbody>
      </table>
    </div>`;

  const tbody = document.getElementById('file-tbody');

  files.forEach(file => {
    const { cls, label } = statusInfo(file.status);
    const jobKey = `${kb}/${file.name}`;
    const isRunning = activeJobs.has(jobKey);
    const jobId = isRunning ? (activeJobs.get(jobKey).job_id || '') : '';
    const actualCls = isRunning ? 'pending' : cls;
    const actualLabel = isRunning ? 'Queued' : label;

    const row = document.createElement('tr');
    const rowId = fileRowId(kb, file.name);
    row.id = rowId;
    row.innerHTML = `
      <td class="col-name">
        <span class="file-name-link" title="${esc(file.name)}" data-kb="${esc(kb)}" data-filename="${esc(file.name)}" style="cursor:pointer;color:var(--vermillion)">${esc(file.name)}</span>
      </td>
      <td class="col-size">${fmtBytes(file.size)}</td>
      <td class="col-status"><span class="status-pill ${actualCls}">${actualLabel}</span></td>
      <td class="col-actions">
        <div style="display:flex;gap:6px;align-items:center;justify-content:flex-end">
          <button class="btn btn-ghost btn-parse" style="padding:4px 10px" data-kb="${esc(kb)}" data-filename="${esc(file.name)}" ${isRunning ? 'disabled' : ''}>
            ${isRunning ? 'Running\u2026' : (file.has_output ? 'Re\u2011parse' : 'Parse')}
          </button>
          <button class="btn btn-ghost btn-stop-file" id="stop-${rowId}" style="padding:4px 10px${isRunning ? '' : ';display:none'}" data-job-id="${esc(jobId)}">Stop</button>
          <button class="btn btn-icon btn-delete-file" data-kb="${esc(kb)}" data-filename="${esc(file.name)}" title="Delete">
            <svg viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V3h4v1M5 4l.5 9h5L11 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </td>`;
    tbody.appendChild(row);

    // Progress row (hidden by default)
    const progressRow = document.createElement('tr');
    progressRow.id = `prog-${row.id}`;
    progressRow.hidden = true;
    progressRow.innerHTML = `<td colspan="4" style="padding:0 16px 10px">
      <div class="progress-bar-track"><div class="progress-bar-fill indeterminate" id="pb-${row.id}"></div></div>
      <div style="font-size:11px;color:var(--ink-muted);margin-top:4px" id="pm-${row.id}">Waiting to start\u2026</div>
    </td>`;
    tbody.appendChild(progressRow);
  });

  // File name click → navigate to doc-view (stream if active, else view existing)
  tbody.querySelectorAll('.file-name-link').forEach(link => {
    link.addEventListener('click', () => {
      const { kb: kbName, filename } = link.dataset;
      const jobKey = `${kbName}/${filename}`;
      if (activeJobs.has(jobKey)) {
        navigate('doc-view', { kb: kbName, filename, jobId: activeJobs.get(jobKey).job_id });
      } else {
        navigate('doc-view', { kb: kbName, filename });
      }
    });
  });

  // Parse buttons → start job in-place (no navigation)
  tbody.querySelectorAll('.btn-parse').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { kb: kbName, filename } = btn.dataset;
      const jobKey = `${kbName}/${filename}`;
      if (activeJobs.has(jobKey)) return;
      btn.disabled = true;
      btn.textContent = 'Starting\u2026';
      try {
        const data = await api.post(
          `/knowledge-bases/${encodeURIComponent(kbName)}/parse?filename=${encodeURIComponent(filename)}`
        );
        activeJobs.set(jobKey, { job_id: data.job_id });
        _trackJob(kbName, filename, data.job_id);
        updateParseAllBtn(kbName);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Parse';
        toast('error', 'Failed to start parse', e.message);
      }
    });
  });

  // Stop buttons
  tbody.querySelectorAll('.btn-stop-file').forEach(btn => {
    btn.addEventListener('click', () => {
      const jobId = btn.dataset.jobId;
      if (jobId) api.del(`/jobs/${encodeURIComponent(jobId)}`).catch(() => {});
    });
  });

  // Parse All / Stop All button
  const parseAllBtn = document.getElementById('parse-all-btn');
  if (parseAllBtn) {
    parseAllBtn.addEventListener('click', () => {
      if (parseAllBtn.dataset.mode === 'stop') {
        stopAll(kb);
      } else {
        parseAll(kb);
      }
    });
  }

  // Delete file buttons
  tbody.querySelectorAll('.btn-delete-file').forEach(btn => {
    btn.addEventListener('click', () => {
      const { kb: kbName, filename } = btn.dataset;
      showModal(
        `Delete \u201c${filename}\u201d?`,
        `<p style="color:var(--ink-soft);font-size:13px;line-height:1.6">This will remove the file and its parsed output.</p>`,
        {
          confirmLabel: 'Delete',
          confirmClass: 'btn-danger',
          onConfirm: async () => {
            try {
              await api.del(`/knowledge-bases/${encodeURIComponent(kbName)}/files?filename=${encodeURIComponent(filename)}`);
              toast('success', 'Deleted', filename);
              refreshFileList(kbName);
            } catch (e) {
              toast('error', 'Delete failed', e.message);
            }
          }
        }
      );
    });
  });

  // Wire up any already-running jobs to update the UI
  files.forEach(file => {
    const jobKey = `${kb}/${file.name}`;
    if (activeJobs.has(jobKey)) {
      const { job_id } = activeJobs.get(jobKey);
      _trackJob(kb, file.name, job_id);
    }
  });
}

function _trackJob(kb, filename, job_id) {
  const jobKey = `${kb}/${filename}`;
  const rowId  = fileRowId(kb, filename);

  const stopBtn = document.getElementById(`stop-${rowId}`);
  if (stopBtn) { stopBtn.dataset.jobId = job_id; stopBtn.style.display = ''; }

  const row0 = document.getElementById(rowId);
  if (row0) {
    const parseBtn = row0.querySelector('.btn-parse');
    if (parseBtn) { parseBtn.disabled = true; parseBtn.textContent = 'Running\u2026'; }
  }
  const progEl = document.getElementById(`prog-${rowId}`);
  if (progEl) progEl.hidden = false;

  function updateRow(statusCls, statusLabel, progressPct, progressMsg, done) {
    const row = document.getElementById(rowId);
    const progRow = document.getElementById(`prog-${rowId}`);
    const pb  = document.getElementById(`pb-${rowId}`);
    const pm  = document.getElementById(`pm-${rowId}`);
    if (row) {
      const pill = row.querySelector('.status-pill');
      if (pill) { pill.className = `status-pill ${statusCls}`; pill.textContent = statusLabel; }
    }
    if (progRow) progRow.hidden = done;
    if (pb && progressPct !== null) {
      pb.classList.remove('indeterminate');
      pb.style.width = `${progressPct}%`;
    } else if (pb && progressPct === 0) {
      pb.classList.remove('indeterminate');
      pb.style.width = '0%';
    }
    if (pm && progressMsg) pm.textContent = progressMsg;
    if (done) {
      const sb = document.getElementById(`stop-${rowId}`);
      if (sb) sb.style.display = 'none';
      const parseBtn = row?.querySelector('.btn-parse');
      if (parseBtn) { parseBtn.disabled = false; parseBtn.textContent = 'Re\u2011parse'; }
    }
  }

  watchJob(job_id, event => {
    if (event.type === 'queued') {
      updateRow('pending', 'Queued', 0, event.message || 'Waiting to start…', false);
    } else if (event.type === 'pages') {
      updateRow('parsing', `0/${event.total} pages`, 0, event.message, false);
    } else if (event.type === 'progress') {
      const completed = Number.isFinite(event.completed) ? event.completed : (event.page || 0);
      const pct = event.total > 0 ? Math.round((completed / event.total) * 100) : null;
      updateRow('parsing', `Page ${event.page}/${event.total}`, pct, event.message, false);
    } else if (event.type === 'status') {
      updateRow('parsing', 'Parsing\u2026', null, event.message, false);
    } else if (event.type === 'done') {
      activeJobs.delete(jobKey);
      updateRow('done', 'Done', 100, 'Complete', true);
      updateParseAllBtn(kb);
      setTimeout(() => refreshFileList(kb), 600);
    } else if (event.type === 'error') {
      activeJobs.delete(jobKey);
      updateRow('error', 'Error', null, event.message, true);
      updateParseAllBtn(kb);
    } else if (event.type === 'cancelled') {
      activeJobs.delete(jobKey);
      updateRow('pending', 'Cancelled', null, 'Cancelled', true);
      updateParseAllBtn(kb);
    }
  });
}

function updateParseAllBtn(kb) {
  const btn = document.getElementById('parse-all-btn');
  if (!btn) return;
  const hasActive = [...activeJobs.keys()].some(k => k.startsWith(kb + '/'));
  if (hasActive) {
    btn.textContent = 'Stop All';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-danger');
    btn.dataset.mode = 'stop';
  } else {
    btn.textContent = 'Parse All';
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-primary');
    btn.dataset.mode = 'parse';
  }
}

async function parseAll(kb) {
  let data;
  try {
    data = await api.post(`/knowledge-bases/${encodeURIComponent(kb)}/parse-all`);
  } catch (e) {
    toast('error', 'Failed to start all', e.message);
    return;
  }
  for (const { job_id, filename } of data.jobs) {
    const jobKey = `${kb}/${filename}`;
    activeJobs.set(jobKey, { job_id });
    _trackJob(kb, filename, job_id);
  }
  updateParseAllBtn(kb);
}

async function stopAll(kb) {
  const toStop = [...activeJobs.entries()].filter(([k]) => k.startsWith(kb + '/'));
  await Promise.all(toStop.map(([, { job_id }]) =>
    api.del(`/jobs/${encodeURIComponent(job_id)}`).catch(() => {})
  ));
}


/* ── URL Sources ─────────────────────────────────────────────────────────────── */

function urlRowId(slug) {
  return 'ur__' + slug.replace(/\W/g, '_');
}

function setupAddUrlsBtn(kb) {
  const btn = document.getElementById('add-urls-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    showModal(
      'Add URLs',
      `<label style="display:block;font-size:12px;color:var(--ink-muted);margin-bottom:6px">
        One URL per line &mdash; HTTP and HTTPS only. Duplicates are skipped.
       </label>
       <textarea id="url-input-ta" rows="6"
         style="width:100%;resize:vertical;font-family:var(--mono);font-size:12px;
                border:1px solid var(--border-color);border-radius:var(--radius);
                padding:8px;box-sizing:border-box;background:var(--paper);
                color:var(--ink);line-height:1.6"
         placeholder="https://example.com/page-one&#10;https://example.com/page-two"></textarea>`,
      {
        confirmLabel: 'Fetch',
        onConfirm: async () => {
          const ta   = document.getElementById('url-input-ta');
          const urls = (ta?.value || '').split('\n').map(l => l.trim()).filter(Boolean);
          if (!urls.length) return;
          try {
            const data = await api.post(
              `/knowledge-bases/${encodeURIComponent(kb)}/urls`, { urls }
            );
            const jobs = data.jobs || [];
            if (!jobs.length) {
              toast('info', 'No new URLs', 'All URLs already added or were invalid');
              return;
            }
            toast('success', `Fetching ${jobs.length} URL(s)\u2026`, '');
            await refreshUrlList(kb);
            for (const { job_id, slug } of jobs) {
              _trackUrlJob(kb, slug, job_id);
            }
          } catch (e) {
            toast('error', 'Failed to add URLs', e.message);
          }
        },
      }
    );
    setTimeout(() => document.getElementById('url-input-ta')?.focus(), 50);
  });
}

async function refreshUrlList(kb) {
  const container = document.getElementById('url-list-container');
  if (!container) return;

  let urls;
  try {
    urls = await api.get(`/knowledge-bases/${encodeURIComponent(kb)}/urls`);
  } catch {
    return; // silent – file section already covers main content
  }

  if (!urls.length) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <h3 style="font-size:12px;font-weight:600;color:var(--ink-muted);letter-spacing:.07em;
               text-transform:uppercase;margin:var(--sp-6) 0 var(--sp-3)">URL Sources</h3>
    <div class="file-table-wrap">
      <table class="file-table">
        <thead>
          <tr>
            <th>Title / URL</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="url-tbody"></tbody>
      </table>
    </div>`;

  const tbody = document.getElementById('url-tbody');

  urls.forEach(src => {
    const { cls, label } = statusInfo(src.status);
    const jobKey     = `url:${kb}/${src.slug}`;
    const isRunning  = _activeUrlJobs.has(jobKey);
    const actualCls  = isRunning ? 'parsing' : cls;
    const actualLbl  = isRunning ? 'Fetching\u2026' : label;
    const rowId      = urlRowId(src.slug);
    const shortUrl   = src.url.replace(/^https?:\/\//, '').slice(0, 55) +
                       (src.url.replace(/^https?:\/\//, '').length > 55 ? '\u2026' : '');

    const row = document.createElement('tr');
    row.id = rowId;
    row.innerHTML = `
      <td class="col-name">
        <div style="display:flex;flex-direction:column;gap:2px">
          <span class="url-title-link"
            data-slug="${esc(src.slug)}"
            style="cursor:${src.has_output ? 'pointer' : 'default'};
                   color:${src.has_output ? 'var(--vermillion)' : 'var(--ink)'};
                   font-weight:500;white-space:nowrap;overflow:hidden;
                   text-overflow:ellipsis;max-width:380px"
            title="${esc(src.title)}">${esc(src.title)}</span>
          <a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer"
             style="font-size:11px;color:var(--ink-muted);white-space:nowrap;
                    overflow:hidden;text-overflow:ellipsis;max-width:380px;display:block"
             title="${esc(src.url)}">${esc(shortUrl)}</a>
        </div>
      </td>
      <td class="col-status"><span class="status-pill ${actualCls}">${actualLbl}</span></td>
      <td class="col-actions">
        <div style="display:flex;gap:6px;align-items:center;justify-content:flex-end">
          <button class="btn btn-ghost btn-refetch" style="padding:4px 10px"
            data-slug="${esc(src.slug)}" ${isRunning ? 'disabled' : ''}>
            ${isRunning ? 'Fetching\u2026' : (src.has_output ? 'Re\u2011fetch' : 'Fetch')}
          </button>
          <button class="btn btn-icon btn-delete-url" data-slug="${esc(src.slug)}" title="Delete">
            <svg viewBox="0 0 16 16" fill="none">
              <path d="M3 4h10M6 4V3h4v1M5 4l.5 9h5L11 4"
                stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </td>`;
    tbody.appendChild(row);

    // Progress row (hidden by default)
    const progressRow = document.createElement('tr');
    progressRow.id = `prog-${rowId}`;
    progressRow.hidden = true;
    progressRow.innerHTML = `<td colspan="3" style="padding:0 16px 10px">
      <div class="progress-bar-track">
        <div class="progress-bar-fill indeterminate" id="pb-${rowId}"></div>
      </div>
      <div style="font-size:11px;color:var(--ink-muted);margin-top:4px" id="pm-${rowId}">Fetching\u2026</div>
    </td>`;
    tbody.appendChild(progressRow);
  });

  // Title click → doc-view
  tbody.querySelectorAll('.url-title-link').forEach(link => {
    link.addEventListener('click', () => {
      const src = urls.find(u => u.slug === link.dataset.slug);
      if (src?.has_output) navigate('doc-view', { kb, filename: src.slug, sourceUrl: src.url });
    });
  });

  // Re-fetch buttons
  tbody.querySelectorAll('.btn-refetch').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { slug } = btn.dataset;
      const jobKey = `url:${kb}/${slug}`;
      if (_activeUrlJobs.has(jobKey)) return;
      btn.disabled = true;
      btn.textContent = 'Starting\u2026';
      try {
        const data = await api.post(
          `/knowledge-bases/${encodeURIComponent(kb)}/urls/${encodeURIComponent(slug)}/refetch`
        );
        _activeUrlJobs.set(jobKey, { job_id: data.job_id });
        _trackUrlJob(kb, slug, data.job_id);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Fetch';
        toast('error', 'Failed to start fetch', e.message);
      }
    });
  });

  // Delete buttons
  tbody.querySelectorAll('.btn-delete-url').forEach(btn => {
    btn.addEventListener('click', () => {
      const { slug } = btn.dataset;
      const src = urls.find(u => u.slug === slug);
      showModal(
        'Delete URL source?',
        `<p style="color:var(--ink-soft);font-size:13px;line-height:1.6">
           This will remove <strong>${esc(src?.title || slug)}</strong> and its parsed output.
         </p>`,
        {
          confirmLabel: 'Delete',
          confirmClass: 'btn-danger',
          onConfirm: async () => {
            try {
              await api.del(
                `/knowledge-bases/${encodeURIComponent(kb)}/urls/${encodeURIComponent(slug)}`
              );
              toast('success', 'Deleted', src?.title || slug);
              refreshUrlList(kb);
            } catch (e) {
              toast('error', 'Delete failed', e.message);
            }
          },
        }
      );
    });
  });

  // Re-attach trackers for already-running jobs
  urls.forEach(src => {
    const jobKey = `url:${kb}/${src.slug}`;
    if (_activeUrlJobs.has(jobKey)) {
      _trackUrlJob(kb, src.slug, _activeUrlJobs.get(jobKey).job_id);
    }
  });
}

function _trackUrlJob(kb, slug, job_id) {
  const jobKey = `url:${kb}/${slug}`;
  const rowId  = urlRowId(slug);
  _activeUrlJobs.set(jobKey, { job_id });

  const progEl = document.getElementById(`prog-${rowId}`);
  if (progEl) progEl.hidden = false;

  const row = document.getElementById(rowId);
  if (row) {
    const btn  = row.querySelector('.btn-refetch');
    if (btn)  { btn.disabled = true; btn.textContent = 'Fetching\u2026'; }
    const pill = row.querySelector('.status-pill');
    if (pill) { pill.className = 'status-pill parsing'; pill.textContent = 'Fetching\u2026'; }
  }

  function updateUrlRow(statusCls, statusLabel, msg, done) {
    const r  = document.getElementById(rowId);
    const pr = document.getElementById(`prog-${rowId}`);
    const pm = document.getElementById(`pm-${rowId}`);
    if (r) {
      const pill = r.querySelector('.status-pill');
      if (pill) { pill.className = `status-pill ${statusCls}`; pill.textContent = statusLabel; }
    }
    if (pr) pr.hidden = done;
    if (pm && msg) pm.textContent = msg;
    if (done) {
      const btn = r?.querySelector('.btn-refetch');
      if (btn) { btn.disabled = false; btn.textContent = 'Re\u2011fetch'; }
    }
  }

  watchJob(job_id, event => {
    if (event.type === 'status') {
      updateUrlRow('parsing', 'Fetching\u2026', event.message, false);
    } else if (event.type === 'done') {
      _activeUrlJobs.delete(jobKey);
      updateUrlRow('done', 'Done', 'Complete', true);
      setTimeout(() => refreshUrlList(kb), 600);
    } else if (event.type === 'error') {
      _activeUrlJobs.delete(jobKey);
      updateUrlRow('error', 'Error', event.message, true);
    } else if (event.type === 'cancelled') {
      _activeUrlJobs.delete(jobKey);
      updateUrlRow('pending', 'Cancelled', 'Cancelled', true);
    }
  });
}

