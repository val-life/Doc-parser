/* ── Page: Models ──────────────────────────────────────────────────────────── */

import { api } from '../api.js';
import { esc } from '../utils.js';
import { toast } from '../toast.js';
import { watchJob } from '../sse.js';
import { setBreadcrumb, setTopbarActions, registerPage } from '../state.js';

registerPage('models', renderModels);

async function renderModels() {
  setBreadcrumb([{ label: 'Models', page: 'models' }]);
  setTopbarActions('');

  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="page-enter">
      <div class="section-title">Models</div>
      <div class="section-subtitle">OCR models used for document parsing</div>
      <div id="model-grid-container"></div>
    </div>`;

  await refreshModelGrid();
}

async function refreshModelGrid() {
  const container = document.getElementById('model-grid-container');
  if (!container) return;

  let models;
  try {
    models = await api.get('/models');
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div class="empty-title">Failed to load</div></div>`;
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'model-grid stagger';

  models.forEach(m => {
    const card = document.createElement('div');
    card.className = 'model-card';
    card.id = `model-card-${m.slug}`;
    card.innerHTML = `
      <div class="model-card-head">
        <div>
          <div class="model-card-name">${esc(m.name)}</div>
          <div class="model-card-label">${esc(m.label)}</div>
        </div>
        <span class="model-status-badge ${m.local ? 'local' : 'remote'}">${m.local ? 'Local' : 'Not downloaded'}</span>
      </div>
      <div class="model-card-meta">
        Size on disk: ${esc(m.size)}
        <div class="model-card-path">${esc(m.path)}</div>
      </div>
      <div id="model-prog-${m.slug}" style="margin-bottom:12px;display:none">
        <div class="progress-bar-track" style="margin-bottom:6px">
          <div class="progress-bar-fill indeterminate" id="mpb-${m.slug}"></div>
        </div>
        <div style="font-size:11px;color:var(--ink-muted)" id="mpm-${m.slug}">Initialising\u2026</div>
      </div>
      <button class="btn btn-primary btn-dl-model" data-slug="${esc(m.slug)}">
        ${m.local ? 'Re-download' : 'Download Model'}
      </button>`;
    grid.appendChild(card);
  });

  container.innerHTML = '';
  container.appendChild(grid);

  grid.querySelectorAll('.btn-dl-model').forEach(btn => {
    btn.addEventListener('click', () => downloadModel(btn.dataset.slug));
  });
}

async function downloadModel(slug) {
  let data;
  try {
    data = await api.post(`/models/${encodeURIComponent(slug)}/download`);
  } catch (e) {
    toast('error', 'Download failed', e.message);
    return;
  }

  const progDiv = document.getElementById(`model-prog-${slug}`);
  const pmEl    = document.getElementById(`mpm-${slug}`);
  if (progDiv) progDiv.style.display = '';

  watchJob(data.job_id, event => {
    if (event.type === 'status') {
      if (pmEl) pmEl.textContent = event.message;
    } else if (event.type === 'done') {
      toast('success', 'Download complete!', 'Model ready');
      if (progDiv) progDiv.style.display = 'none';
      refreshModelGrid();
    } else if (event.type === 'error') {
      toast('error', 'Download failed', event.message);
      if (progDiv) progDiv.style.display = 'none';
    }
  });
}
