/* ── Page: Knowledge Bases List ─────────────────────────────────────────────── */

import { api } from '../api.js';
import { esc } from '../utils.js';
import { toast } from '../toast.js';
import { showModal } from '../modal.js';
import { state, navigate, setBreadcrumb, setTopbarActions, registerPage } from '../state.js';

registerPage('kb-list', renderKbList);

async function renderKbList() {
  setBreadcrumb([{ label: 'Knowledge Bases', page: 'kb-list' }]);
  setTopbarActions(`
    <button class="btn btn-primary" id="btn-new-kb">
      <svg viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      New KB
    </button>`);

  const content = document.getElementById('content');
  content.innerHTML = `<div class="page-enter">
    <div class="section-title">Knowledge Bases</div>
    <div class="section-subtitle">Document collections for your RAG pipeline</div>
    <div id="kb-grid-container"></div>
  </div>`;

  document.getElementById('btn-new-kb')?.addEventListener('click', onNewKb);
  await refreshKbGrid();
}

async function refreshKbGrid() {
  const container = document.getElementById('kb-grid-container');
  if (!container) return;

  container.innerHTML = `<div class="kb-grid stagger">${
    '<div class="skeleton" style="height:160px;border-radius:var(--radius-md)"></div>'.repeat(3)
  }</div>`;

  let kbs;
  try {
    kbs = await api.get('/knowledge-bases');
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div class="empty-title">Failed to load</div><div class="empty-sub">${esc(e.message)}</div></div>`;
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'kb-grid stagger';

  kbs.forEach(kb => {
    const card = document.createElement('div');
    card.className = 'kb-card';
    card.dataset.kb = kb.name;
    card.innerHTML = `
      <div class="kb-card-icon">
        <svg viewBox="0 0 20 20" fill="none">
          <rect x="3" y="2" width="11" height="14" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
          <path d="M6 6h5M6 9h5M6 12h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          <rect x="8" y="10" width="9" height="8" rx="1.5" fill="var(--paper)" stroke="var(--vermillion)" stroke-width="1.3"/>
          <path d="M10.5 14h4M12.5 12v4" stroke="var(--vermillion)" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="kb-card-name">${esc(kb.name)}</div>
      <div class="kb-card-stats">
        <span class="stat-pill files">${kb.total} file${kb.total !== 1 ? 's' : ''}</span>
      </div>
      <div class="kb-card-actions">
        <button class="btn btn-icon btn-delete-kb" title="Delete KB" data-kb="${esc(kb.name)}">
          <svg viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V3h4v1M5 4l.5 9h5L11 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>`;
    card.addEventListener('click', e => {
      if (e.target.closest('.btn-delete-kb')) return;
      navigate('kb-sources', { kb: kb.name });
    });
    grid.appendChild(card);
  });

  // Add-new card
  const addCard = document.createElement('button');
  addCard.className = 'kb-add-card';
  addCard.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>New Knowledge Base</span>`;
  addCard.addEventListener('click', onNewKb);
  grid.appendChild(addCard);

  container.innerHTML = '';
  container.appendChild(grid);

  // Delete buttons
  grid.querySelectorAll('.btn-delete-kb').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const kbName = btn.dataset.kb;
      showModal(
        `Delete \u201c${kbName}\u201d?`,
        `<p style="color:var(--ink-soft);font-size:13px;line-height:1.6">This will permanently remove all files and parsed output in <strong style="color:var(--ink)">${esc(kbName)}</strong>. This cannot be undone.</p>`,
        {
          confirmLabel: 'Delete',
          confirmClass: 'btn-danger',
          onConfirm: async () => {
            try {
              await api.del(`/knowledge-bases/${encodeURIComponent(kbName)}`);
              toast('success', 'Deleted', `\u201c${kbName}\u201d removed`);
              refreshKbGrid();
            } catch (e) {
              toast('error', 'Delete failed', e.message);
            }
          }
        }
      );
    });
  });
}

function onNewKb() {
  showModal(
    'New Knowledge Base',
    `<div class="form-group">
      <label class="form-label" for="kb-name-input">Name</label>
      <input class="form-input" id="kb-name-input" placeholder="e.g. research-papers" autofocus />
    </div>
    <p style="color:var(--ink-muted);font-size:12px">Use letters, numbers, hyphens and underscores only.</p>`,
    {
      confirmLabel: 'Create',
      onConfirm: async () => {
        const name = document.getElementById('kb-name-input')?.value.trim();
        if (!name) return;
        try {
          await api.post('/knowledge-bases', { name });
          toast('success', 'Created', `\u201c${name}\u201d ready`);
          refreshKbGrid();
        } catch (e) {
          toast('error', 'Create failed', e.message);
        }
      }
    }
  );
  requestAnimationFrame(() => document.getElementById('kb-name-input')?.focus());
}
