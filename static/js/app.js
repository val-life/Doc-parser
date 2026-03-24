/* ─────────────────────────────────────────────────────────────────────────────
   docparse — Entry Point
   Imports all modules and boots the SPA.
───────────────────────────────────────────────────────────────────────────── */

import { initModal } from './modal.js';
import { initNav, navigate } from './state.js';

// Page modules — side-effect imports register themselves via registerPage()
import './pages/kb-list.js';
import './pages/kb-sources.js';
import './pages/doc-view.js';
import './pages/models.js';

// ── Boot ──────────────────────────────────────────────────────────────────────
initModal();
initNav();
navigate('kb-list');
