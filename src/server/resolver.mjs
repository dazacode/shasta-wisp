// Where the SSRF filter gets an IP for a hostname.
//
// `filter.is_stream_allowed` has to turn a hostname into an address before it can decide whether
// the destination is private/loopback, but it used to call `net.lookup_ip` directly. That is
// fine on Node and useless in a browser bundle, where `net`/`dns` are `null` and `lookup_ip`
// returns the bare hostname (so every range check silently passed). `resolve_host` is that seam:
// the default is Node's lookup, and a browser host swaps in a DNS-over-HTTPS resolver.

import { lookup_ip as node_lookup } from "./net.mjs";

/** @type {(hostname: string) => Promise<string>} */
export let resolve_host = node_lookup;

/** Replace the resolver (browser DoH, a test stub, ...). Pass nothing to restore the default. */
export function set_resolver(fn = node_lookup) {
  resolve_host = fn;
}
