/* ── API Client ─────────────────────────────────────────────────────────────── */

async function _req(method, path, body) {
  const opts = { method, headers: {} };
  if (body && !(body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    opts.body = body;
  }
  const r = await fetch('/api' + path, opts);
  if (!r.ok) {
    let msg;
    try { msg = (await r.json()).detail || r.statusText; }
    catch { msg = r.statusText; }
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  get:    (p)     => _req('GET',    p),
  post:   (p, b)  => _req('POST',   p, b),
  put:    (p, b)  => _req('PUT',    p, b),
  del:    (p)     => _req('DELETE',  p),
  upload: (p, fd) => _req('POST',   p, fd),
};
