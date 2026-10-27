// Entry point: `@mercuryworkshop/wisp-js/browser`
//
// The browser side of the package: a complete Wisp server that runs in the page and opens real
// sockets through the Isolated Web App Direct Sockets API. See ../server/browser/index.mjs.
//
// The client and the packet codec are the same modules the Node build uses, so anything that
// already imports them keeps working.

export * from "../server/browser/index.mjs";
export * as logging from "../logging.mjs";
export * as packets from "../packet.mjs";
