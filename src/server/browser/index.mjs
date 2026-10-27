// Browser Wisp: the whole relay, in the page.
//
// Needs the Direct Sockets API, which is an Isolated Web App feature (`isolated-app://` origin +
// `permissions_policy: { "direct-sockets": ["self"] }`). On a plain page everything still loads;
// `createClient()` simply closes each stream with a NetworkError until a socket is available.
//
// ```js
// import { createLocalWispServer } from "@mercuryworkshop/wisp-js/browser";
// const server = createLocalWispServer();
// server.installWebSocket();              // libcurl.js / epoxy now reach wss://local/wisp/ locally
// document.querySelector("#wisp").value = server.url;
// ```
//
// Nothing above touches the wire format, so a client that is talking to a remote relay and a client
// talking to this one are indistinguishable.

export { LocalWispServer, createLocalWispServer, DEFAULT_LOCAL_WISP_URL } from "./server.mjs";
export { createLocalWispLink, LocalWebSocket, LINK_STATES } from "./link.mjs";
export { BrowserTCPSocket, DirectSocketsUnavailable } from "./tcp.mjs";
export { BrowserUDPSocket } from "./udp.mjs";
export { createDohResolver, isPrivateAddress, DOH_ENDPOINTS } from "./dns.mjs";

/** Whether this context can actually open sockets (i.e. is an IWA). */
export function hasDirectSockets() {
  return typeof globalThis.TCPSocket === "function";
}
