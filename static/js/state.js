/* ── App State & Navigation ─────────────────────────────────────────────────── */

import { esc } from './utils.js';

// ── State ─────────────────────────────────────────────────────────────────────
export const state = {
  page:       'kb-list',
  kb:         null,
  filename:   null,
  startParse: false,
  jobId:      null,
  sourceUrl:  null,
};

// Active parse jobs: key = `${kb}/${filename}` → {jobId, es}
export const activeJobs = new Map();

// Page cleanup callbacks — run on each navigate() to release EventSources etc.
const _cleanups = [];
export function addCleanup(fn) { _cleanups.push(fn); }
function _runCleanups() { while (_cleanups.length) _cleanups.pop()(); }

// Page renderers — registered from page modules
const _renderers = {};

export function registerPage(name, renderFn) {
  _renderers[name] = renderFn;
}

// ── Navigation ────────────────────────────────────────────────────────────────
export function navigate(page, params = {}) {
  _runCleanups();
  Object.assign(state, { kb: null, filename: null, startParse: false, jobId: null, sourceUrl: null }, params, { page });
  // Reset doc-split-mode when navigating away from doc-view
  if (page !== 'doc-view') {
    document.getElementById('content')?.classList.remove('doc-split-mode');
  }
  updateNav();
  renderPage();
}

function updateNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    const active = btn.dataset.page === state.page ||
                   (btn.dataset.page === 'kb-list' && state.page === 'kb-sources') ||
                   (btn.dataset.page === 'kb-list' && state.page === 'doc-view');
    btn.setAttribute('aria-current', active ? 'true' : 'false');
    btn.classList.toggle('active', active);
  });
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────
export function setBreadcrumb(items) {
  const bc = document.getElementById('breadcrumb');
  bc.innerHTML = items.map((item, i) => {
    const isCurrent = i === items.length - 1;
    if (isCurrent) {
      return `<span class="bc-item current">${esc(item.label)}</span>`;
    }
    return `<span class="bc-item" data-nav="${esc(item.page)}" data-kb="${esc(item.kb || '')}" data-filename="${esc(item.filename || '')}">${esc(item.label)}</span>
            <span class="bc-sep">/</span>`;
  }).join('');

  bc.querySelectorAll('.bc-item[data-nav]').forEach(el => {
    el.addEventListener('click', () => {
      navigate(el.dataset.nav, {
        kb: el.dataset.kb || null,
        filename: el.dataset.filename || null,
      });
    });
  });
}

export function setTopbarActions(html) {
  document.getElementById('topbar-actions').innerHTML = html;
}

// ── Page dispatcher ───────────────────────────────────────────────────────────
async function renderPage() {
  const content = document.getElementById('content');
  content.style.opacity = '0';
  content.style.transform = 'translateY(6px)';

  const render = _renderers[state.page];
  if (!render) return;

  await render();

  requestAnimationFrame(() => {
    content.style.transition = 'opacity 220ms ease, transform 220ms ease';
    content.style.opacity = '1';
    content.style.transform = '';
    setTimeout(() => { content.style.transition = ''; }, 250);
  });
}

// ── Init sidebar wiring ───────────────────────────────────────────────────────
export function initNav() {
  document.getElementById('sidebar-nav').addEventListener('click', e => {
    const btn = e.target.closest('.nav-item[data-page]');
    if (!btn) return;
    navigate(btn.dataset.page);
  });
}
