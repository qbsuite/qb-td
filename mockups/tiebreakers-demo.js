// Throwaway mock (tiebreakers-hub.html): the demo backend, plus what the
// mock needs from it: each fixture room as a room of the tournament, and
// schedule saves (kept in the browser, so the hub's own fills survive a
// reload and the mock public page sees them).
import { demoPub as realPub, reset } from '../app/js/demo.js';
import fixture from '../app/demo/fixture.js';

// a fresh start each load: the real demo's uploads and round don't apply here
reset();

export { reset };
export async function demoPub(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  if (path === '/a/demo/schedule' && method === 'POST') {
    fixture.schedule = JSON.parse(JSON.stringify(opts.json));
    localStorage.setItem(fixture.scheduleKey, JSON.stringify(fixture.schedule));
    return { ok: true, brackets: true };
  }
  const out = await realPub(path, opts);
  if (path === '/a/demo' && method === 'GET') {
    const created = out.tournament.created;
    out.buckets = fixture.rooms.map((room_name, i) => ({ id: i + 1, room_name, secret: 'demo-' + i, created }));
  }
  return out;
}
