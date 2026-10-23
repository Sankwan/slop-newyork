// tools/lib/overpass.mjs
// A polite Overpass client: sequential use expected, several mirrors, retries with growing pauses.
// `fetchImpl` and `sleep` are injectable so the retry logic can be tested without a network.
//
// Mirrors are ranked by how they behave during the run: one that answers moves to the front, one that times out or
// refuses moves to the back and gets a shorter wait. An instant gateway error (502/503/504 in under 5 s) usually
// clears within seconds, so it gets a short pause before the next mirror.

export const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

const USER_AGENT = 'accra-city-sim/0.1 (open-data city simulation; contact via GitHub Sankwan)';

// Shared across calls within one process: endpoint -> score (higher is better)
const health = new Map();
export function resetHealth() {
  health.clear();
}
function ranked(endpoints) {
  return endpoints
    .map((ep, i) => ({ ep, i, s: health.get(ep) ?? 0 }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.ep);
}
const bump = (ep, d) => health.set(ep, Math.max(-6, Math.min(6, (health.get(ep) ?? 0) + d)));

export async function overpass(query, endpoints = DEFAULT_ENDPOINTS, opts = {}) {
  const {
    tries = 4,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    warn = console.warn,
    timeoutMs = 120000,
    slowTimeoutMs = 45000,
    now = () => Date.now()
  } = opts;
  const host = (ep) => {
    try {
      return new URL(ep).host;
    } catch {
      return ep;
    }
  };
  for (let t = 1; t <= tries; t++) {
    for (const ep of ranked(endpoints)) {
      const limit = (health.get(ep) ?? 0) < -1 ? slowTimeoutMs : timeoutMs;
      const t0 = now();
      warn(`    try ${t}/${tries} ${host(ep)} (waits up to ${Math.round(limit / 1000)}s)...`);
      try {
        const res = await fetchImpl(ep, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(limit)
        });
        const secs = Math.round((now() - t0) / 1000);
        if (res.ok) {
          const json = await res.json();
          if (!json.remark) {
            bump(ep, 2);
            warn(`    ${host(ep)}: ok in ${secs}s`);
            return json;
          }
          bump(ep, -1);
          warn(`    ${host(ep)}: server remark: ${json.remark}`);
        } else {
          warn(`    ${host(ep)}: HTTP ${res.status} after ${secs}s`);
          if ([502, 503, 504, 429].includes(res.status) && secs < 5) {
            bump(ep, -0.5);
            await sleep(res.status === 429 ? 15000 : 4000);
          } else {
            bump(ep, -2);
          }
        }
      } catch (err) {
        bump(ep, -3);
        warn(`    ${host(ep)}: ${err.name === 'TimeoutError' ? 'no answer within the time limit' : err.message}`);
      }
    }
    if (t < tries) {
      warn(`    all mirrors busy; pausing ${t * 5}s before round ${t + 1}`);
      await sleep(t * 5000);
    }
  }
  throw new Error('all Overpass endpoints failed');
}

/** Quick health probe: asks each mirror for its status page. Returns [{endpoint, ok, ms, note}]. */
export async function probe(endpoints = DEFAULT_ENDPOINTS, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const out = [];
  for (const ep of endpoints) {
    const t0 = Date.now();
    try {
      const res = await fetchImpl(ep.replace(/interpreter$/, 'status'), { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
      const text = (await res.text()).split('\n').find((l) => /slot/i.test(l)) || '';
      out.push({ endpoint: ep, ok: res.ok, ms: Date.now() - t0, note: res.ok ? text.trim() : `HTTP ${res.status}` });
    } catch (err) {
      out.push({ endpoint: ep, ok: false, ms: Date.now() - t0, note: err.message });
    }
  }
  return out;
}
