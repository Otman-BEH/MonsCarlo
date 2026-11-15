/* Talking to the Mons Carlo API: requests, one cache for everything fetched, and request slots for the expensive
   questions. The page redraws (onData) whenever an answer arrives. */
export function createServer({ base, onData, isBusy }) {
  const srv = { lastErr: null };
  async function api(path, body, signal) {
    const r = await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal } : { signal });
    if (!r.ok) { let d = null; try { d = (await r.json()).detail; } catch (_) {} throw new Error(typeof d === 'string' ? d : 'the server answered ' + r.status); }
    return r;
  }
  const getJSON = async (path, body, signal) => (await api(path, body, signal)).json();
  const qs = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const iso = ms => new Date(ms).toISOString().slice(0, 19) + 'Z';
  // One cache for everything fetched: a value appears when its request returns, then the page redraws.
  const cache = new Map();
  function need(key, fn) {
    let e = cache.get(key);
    if (!e) {
      if (cache.size > 400) cache.clear();
      e = { v: undefined, err: null }; cache.set(key, e);
      fn().then(v => { e.v = v; onData(); }, err => { e.err = err; srv.lastErr = err; console.error(err); onData(); });
    }
    return e.v;
  }
  const failed = key => { const e = cache.get(key); return e && e.err ? e.err.message : null; };
  // For the expensive questions (mission, design lab, landing risk, rescue, calendar): one request slot per panel.
  // Nothing is asked while time is playing or being dragged; once the inputs settle (250 ms) the newest question is sent
  // and any older one still running is cancelled. Until the answer arrives the panel keeps showing the last one.
  const slots = {};
  function latest(slot, key, fn, delay) {
    const s = slots[slot] || (slots[slot] = { want: null, timer: 0, ctrl: null, last: undefined, lastKey: null });
    const hit = cache.get(key);
    if (hit && hit.v !== undefined) { s.last = hit.v; s.lastKey = key; return { v: hit.v, fresh: true }; }
    if (hit && hit.err) return { v: s.last, fresh: false, err: hit.err.message };
    if (s.want !== key && !isBusy()) {
      s.want = key; clearTimeout(s.timer); if (s.ctrl) { s.ctrl.abort(); s.ctrl = null; }
      s.timer = setTimeout(() => {
        const ctrl = new AbortController(), e = { v: undefined, err: null }; s.ctrl = ctrl; cache.set(key, e);
        fn(ctrl.signal).then(v => { e.v = v; if (s.ctrl === ctrl) s.ctrl = null; onData(); },
          err => { if (err.name === 'AbortError') { cache.delete(key); return; } e.err = err; srv.lastErr = err; console.error(err); onData(); });
      }, delay === undefined ? 250 : delay);
    }
    return { v: s.last, fresh: false };
  }

  return Object.assign(srv, { api, getJSON, qs, iso, cache, need, failed, latest });
}
