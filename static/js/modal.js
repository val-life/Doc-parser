/* ── Modal ──────────────────────────────────────────────────────────────────── */

import { esc } from './utils.js';

const overlay   = () => document.getElementById('modal-overlay');
const titleEl   = () => document.getElementById('modal-title');
const bodyEl    = () => document.getElementById('modal-body');
const confirmEl = () => document.getElementById('modal-confirm');
const cancelEl  = () => document.getElementById('modal-cancel');

export function showModal(title, bodyHTML, { confirmLabel = 'Confirm', confirmClass = 'btn-primary', onConfirm } = {}) {
  titleEl().textContent = title;
  bodyEl().innerHTML = bodyHTML;
  const btn = confirmEl();
  btn.textContent = confirmLabel;
  btn.className = `btn ${confirmClass}`;
  overlay().hidden = false;

  btn.onclick = () => {
    closeModal();
    onConfirm?.();
  };
}

export function closeModal() {
  overlay().hidden = true;
}

export function initModal() {
  cancelEl().addEventListener('click', closeModal);
  overlay().addEventListener('click', e => {
    if (e.target === overlay()) closeModal();
  });
}
