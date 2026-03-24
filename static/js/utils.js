/* ── Shared helpers ─────────────────────────────────────────────────────────── */

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtBytes(b) {
  if (b < 1024)    return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return                  `${(b / 1048576).toFixed(1)} MB`;
}

export function statusInfo(raw) {
  if (!raw || raw === 'pending') return { cls: 'pending',  label: 'Pending' };
  if (raw === 'parsing')         return { cls: 'parsing',  label: 'Parsing\u2026' };
  if (raw.startsWith('\u2705'))  return { cls: 'done',     label: 'Done' };
  if (raw.startsWith('\u274C'))  return { cls: 'error',    label: 'Error' };
  return                                { cls: 'pending',  label: raw };
}

export function fileRowId(kb, filename) {
  const key = [kb, filename].map(s => s.replace(/\W/g, '_')).join('__');
  return 'fr__' + key;
}
