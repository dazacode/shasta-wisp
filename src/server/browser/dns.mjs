// A DNS-over-HTTPS resolver, so the SSRF filter still works off-Node.
//
// In a browser bundle `net.lookup_ip` returns the bare hostname, so `filter.is_stream_allowed`
// never learned an address and every private/loopback range check passed. `TCPSocket` resolves
// the hostname itself, but the filter needs an IP *before* the socket opens. DoH over `fetch`
// gives it one; an IWA may `fetch()` https origins, so this is the intended route (it is what
// socket.iwa does for Tor).
//
// Results are cached with a TTL. A and AAAA are both queried: a host whose AAAA is a private
// address must not slip through on the strength of a public A record.

const A = 1;
const AAAA = 28;

/** Public JSON DoH endpoints. Google's sends permissive CORS headers; Cloudflare's is the default. */
export const DOH_ENDPOINTS = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * @param {object} [options]
 * @param {string[]} [options.endpoints]
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {number} [options.ttl] cache seconds
 * @returns {(hostname: string) => Promise<string>} a `resolve_host`-compatible function
 */
export function createDohResolver({ endpoints = DOH_ENDPOINTS, fetch: fetchImpl = globalThis.fetch, ttl = 120 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is required for the DoH resolver");
  const cache = new Map();

  /** @param {string} hostname @param {number} type */
  async function query(hostname, type, endpoint) {
    const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=${type === A ? "A" : "AAAA"}`;
    const response = await fetchImpl(url, { headers: { accept: "application/dns-json" } });
    if (!response.ok) throw new Error(`DoH ${response.status} from ${endpoint}`);
    const body = await response.json();
    if (body.Status !== 0) return null;
    const answers = (body.Answer ?? []).filter((a) => a.type === type);
    return answers.length ? String(answers[0].data) : null;
  }

  return async function resolve_host(hostname) {
    if (IPV4_RE.test(hostname) || hostname.includes(":")) return hostname;

    const now = Date.now();
    const hit = cache.get(hostname);
    if (hit && now - hit.time < ttl * 1000) return hit.address;
    if (hit && hit.error) throw hit.error;

    const errors = [];
    for (const endpoint of endpoints) {
      try {
        const v4 = await query(hostname, A, endpoint);
        const v6 = await query(hostname, AAAA, endpoint);
        const address = v4 ?? v6;
        if (!address) throw new Error("no address");
        cache.set(hostname, { time: now, address });
        return address;
      } catch (error) {
        errors.push(`${endpoint}: ${error}`);
      }
    }
    const error = new Error(`DoH resolution of ${hostname} failed (${errors.join("; ")})`);
    cache.set(hostname, { time: now, error });
    throw error;
  };
}

/**
 * The same rules the Node path applies, but for a whole lookup: an address is checked as-is.
 * Exposed so a host can decide between A/AAAA without importing the filter.
 */
export function isPrivateAddress(address) {
  if (!address) return false;
  if (address.includes(":")) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd") || lower === "::";
  }
  const [a, b] = address.split(".").map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
