/* ── SSE Job Watcher ────────────────────────────────────────────────────────── */

export function watchJob(jobId, onEvent) {
  const es = new EventSource(`/api/events/${jobId}`);
  let finished = false;
  es.onmessage = e => {
    const data = JSON.parse(e.data);
    onEvent(data);
    if (data.type === 'done' || data.type === 'error' || data.type === 'cancelled') {
      finished = true;
      es.close();
    }
  };
  es.onerror = () => {
    es.close();
    if (!finished) onEvent({ type: 'error', message: 'Connection lost' });
  };
  return es;
}
