// The whole Wisp *server*, running inside the page.
//
// This wires the unmodified `ServerConnection` (the real Wisp server logic) to a `MessageChannel`
// link (./link.mjs) and Direct Sockets backends (./tcp.mjs, ./udp.mjs). The result is a Wisp relay
// with no host: `libcurl.js` / `epoxy` connect to `wss://local/wisp/` and the bytes go straight out
// of the tab over real TCP/UDP.
//
// Two ways to use it:
//   * `installWebSocket()` swaps `globalThis.WebSocket` so an *unmodified* transport finds the
//     local server for URLs under `url`. This is how libcurl.js and epoxy are reached, because
//     both ultimately do `new WebSocket(wisp_url)`.
//   * `createClient(protocols)` returns that same client socket, for a caller that would rather
//     inject it than monkey-patch the global (and for tests, which run on Node).
//
// A fresh server connection is created per client socket, matching how a relay behaves across
// reconnects.

import { ServerConnection, HandshakeError } from "../connection.mjs";
import { options } from "../options.mjs";
import { set_resolver } from "../resolver.mjs";
import { BrowserTCPSocket } from "./tcp.mjs";
import { BrowserUDPSocket } from "./udp.mjs";
import { createDohResolver } from "./dns.mjs";
import { createLocalWispLink } from "./link.mjs";

export const DEFAULT_LOCAL_WISP_URL = "wss://local/wisp/";

const asProtocols = (protocols) =>
  protocols == null ? [] : Array.isArray(protocols) ? protocols : String(protocols).split(/ *, */).filter(Boolean);

function sameWispEndpoint(candidate, base) {
  try {
    const a = new URL(candidate);
    const b = new URL(base);
    return a.host === b.host && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

export class LocalWispServer {
  /**
   * @param {object} [options_]
   * @param {string} [options_.url] the endpoint transports should treat as the relay
   * @param {boolean} [options_.useDoh] install a DNS-over-HTTPS resolver for the SSRF filter
   * @param {boolean} [options_.patchOptions] apply Shasta's hardened defaults to `options`
   * @param {object} [options_.connectionOptions] extra `ServerConnection` options (TCPSocket, ...)
   */
  constructor({ url = DEFAULT_LOCAL_WISP_URL, useDoh = true, patchOptions = true, connectionOptions = {} } = {}) {
    this.url = url;
    this._connectionOptions = connectionOptions;
    /** @type {Set<ServerConnection>} live connections, for `stats()`/`close()` */
    this._connections = new Set();
    /** @type {Set<() => void>} */
    this._restorers = [];
    this._closed = false;
    this.started = 0;
    this.refused = 0;

    if (patchOptions) {
      // the same hardening server.mjs applies on Node
      options.allow_private_ips = false;
      options.allow_loopback_ips = false;
      options.allow_udp_streams = false;
      if (options.stream_limit_total === -1) options.stream_limit_total = 500;
    }
    if (useDoh && typeof globalThis.fetch === "function") {
      this._resolver = createDohResolver();
      set_resolver(this._resolver);
    }
  }

  /** @param {string[]|string|null} protocols */
  createClient(protocols = null) {
    if (this._closed) throw new Error("local wisp server is closed");
    const requested = asProtocols(protocols);
    const wisp_version = requested.includes("wisp-v2") ? 2 : 1;

    const link = createLocalWispLink(this.url);
    link.client.protocol = wisp_version === 2 ? "wisp-v2" : "";

    const conn = new ServerConnection(link.server, "/", {
      TCPSocket: BrowserTCPSocket,
      UDPSocket: BrowserUDPSocket,
      ...this._connectionOptions,
      wisp_version,
    });
    this._connections.add(conn);
    const drop = () => this._connections.delete(conn);
    link.client.addEventListener("close", drop);
    link.server.addEventListener("close", drop);

    (async () => {
      try {
        await conn.setup();
        this.started++;
        await conn.run();
      } catch (error) {
        if (!(error instanceof HandshakeError)) this.refused++;
        try {
          link.client.close();
        } catch {
          /* ignore */
        }
      }
    })();

    return link.client;
  }

  /**
   * Make `new WebSocket(url)` (under this server's `url`) return a local client socket.
   * @returns {() => void} a restorer for the original constructor
   */
  installWebSocket() {
    const Original = globalThis.WebSocket;
    if (typeof Original !== "function") throw new Error("globalThis.WebSocket is missing");
    const base = this.url;
    const server = this;

    const Shim = function WebSocket(url, protocols) {
      if (typeof url === "string" && sameWispEndpoint(url, base)) return server.createClient(protocols ?? null);
      return new Original(url, protocols);
    };
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Shim[key] = Original[key];
    Shim.original = Original;
    Shim.prototype = Original.prototype;

    globalThis.WebSocket = Shim;
    const restore = () => {
      if (globalThis.WebSocket === Shim) globalThis.WebSocket = Original;
      this._restorers = this._restorers.filter((r) => r !== restore);
    };
    this._restorers.push(restore);
    return restore;
  }

  get stats() {
    return { connections: this._connections.size, started: this.started, refused: this.refused };
  }

  close() {
    this._closed = true;
    for (const restore of [...this._restorers]) restore();
    for (const conn of this._connections) {
      try {
        conn.cleanup();
      } catch {
        /* ignore */
      }
    }
    this._connections.clear();
  }
}

export function createLocalWispServer(options_) {
  return new LocalWispServer(options_);
}
