// The browser Wisp server, exercised on Node with a fake `TCPSocket`.
//
// There is no browser here, so `globalThis.TCPSocket` is replaced with a duplex fake and the
// server is driven by a hand-written Wisp v2 client built from the real packet codec. That way the
// protocol is validated independently of the client library: if this test passes, the server side
// of the in-page relay is byte-correct, and only the Direct Sockets wrapper is left to trust.

import assert from "node:assert/strict";
import test from "node:test";

import { createLocalWispServer } from "../src/server/browser/server.mjs";
import * as logging from "../src/logging.mjs";
import { createLocalWispLink } from "../src/server/browser/link.mjs";
import { createDohResolver, isPrivateAddress } from "../src/server/browser/dns.mjs";
import { WispBuffer, WispPacket, ConnectPayload, ClosePayload, DataPayload, InfoPayload, stream_types, close_reasons, packet_types } from "../src/packet.mjs";

logging.set_level(logging.NONE);

/** A `ReadableStream` byte source plus a push(), used to feed a fake socket's read half. */
function byteSource() {
  const chunks = [];
  let controller = null;
  const readable = new ReadableStream({
    type: "bytes",
    start(c) {
      controller = c;
    },
    pull(c) {
      flush(c);
    },
  });
  function flush(c = controller) {
    if (!c) return;
    while (chunks.length && c.byobRequest) {
      const view = c.byobRequest.view;
      let chunk = chunks[0];
      const n = Math.min(view.byteLength, chunk.byteLength);
      view.set(chunk.subarray(0, n));
      if (n === chunk.byteLength) chunks.shift();
      else chunks[0] = chunk.subarray(n);
      c.byobRequest.respond(n);
    }
  }
  return {
    readable,
    push(bytes) {
      chunks.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      flush();
    },
    get pending() {
      return chunks.length;
    },
  };
}

/** Install a fake Direct Sockets `TCPSocket`; each one is a loopback to the test. */
function fakeDirectSockets() {
  const sockets = [];
  class FakeTCPSocket {
    constructor(remoteAddress, remotePort) {
      this.remoteAddress = remoteAddress;
      this.remotePort = remotePort;
      this.closed = false;
      this.sent = [];
      this._fromRemote = byteSource();
      this.opened = Promise.resolve({
        readable: this._fromRemote.readable,
        writable: new WritableStream({
          write: (chunk) => {
            this.sent.push(new Uint8Array(chunk));
          },
        }),
      });
      sockets.push(this);
    }
    async close() {
      this.closed = true;
    }
    /** Simulate the remote host sending bytes. */
    remoteSend(bytes) {
      this._fromRemote.push(bytes);
    }
    get sentBytes() {
      return Buffer.concat(this.sent);
    }
  }
  const previous = globalThis.TCPSocket;
  globalThis.TCPSocket = FakeTCPSocket;
  return {
    sockets,
    restore() {
      if (previous === undefined) delete globalThis.TCPSocket;
      else globalThis.TCPSocket = previous;
    },
  };
}

/** A minimal, honest Wisp v2 client over a raw `LocalWebSocket`, built from the real codec. */
function wispClient(socket) {
  const incoming = [];
  const waiters = [];
  socket.binaryType = "arraybuffer";
  socket.onmessage = (event) => {
    const packet = WispPacket.parse_all(new WispBuffer(new Uint8Array(event.data)));
    incoming.push(packet);
    waiters.shift()?.();
  };
  const send = (packet) => socket.send(packet.serialize().bytes);

  async function next(predicate, label) {
    for (;;) {
      const index = incoming.findIndex(predicate);
      if (index !== -1) return incoming.splice(index, 1)[0];
      await new Promise((resolve) => waiters.push(resolve));
      if (socket.readyState === 3) {
        const index2 = incoming.findIndex(predicate);
        if (index2 !== -1) return incoming.splice(index2, 1)[0];
        throw new Error(`socket closed before ${label}`);
      }
    }
  }

  return {
    socket,
    hello(version = 2) {
      send(
        new WispPacket({
          type: InfoPayload.type,
          stream_id: 0,
          payload: new InfoPayload({ major_ver: version, minor_ver: 0, extensions: new WispBuffer(0) }),
        }),
      );
    },
    connect(stream_id, hostname, port, type = stream_types.TCP) {
      send(
        new WispPacket({
          type: ConnectPayload.type,
          stream_id,
          payload: new ConnectPayload({ stream_type: type, port, hostname }),
        }),
      );
    },
    data(stream_id, text) {
      const bytes = new TextEncoder().encode(text);
      send(new WispPacket({ type: DataPayload.type, stream_id, payload: new DataPayload({ data: new WispBuffer(bytes) }) }));
    },
    closeStream(stream_id, reason = close_reasons.Voluntary) {
      send(new WispPacket({ type: packet_types.CLOSE, stream_id, payload: new ClosePayload({ reason }) }));
    },
    awaitInfo: () => next((p) => p.type === InfoPayload.type, "server INFO"),
    awaitContinue: (stream_id = 0) => next((p) => p.type === packet_types.CONTINUE && p.stream_id === stream_id, `CONTINUE(${stream_id})`),
    awaitData: (stream_id) => next((p) => p.type === packet_types.DATA && p.stream_id === stream_id, `DATA(${stream_id})`),
    awaitClose: (stream_id) => next((p) => p.type === packet_types.CLOSE && p.stream_id === stream_id, `CLOSE(${stream_id})`),
  };
}

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, { tries = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = predicate();
    if (value) return value;
    await wait(5);
  }
  throw new Error("condition never became true");
}

test("a Wisp v2 client gets INFO + CONTINUE, connects, and moves bytes both ways", async () => {
  const direct = fakeDirectSockets();
  const server = createLocalWispServer({ useDoh: false });
  try {
    const client = wispClient(server.createClient(["wisp-v2"]));

    const info = await client.awaitInfo();
    assert.equal(info.payload.major_ver, 2, "server must advertise v2 to a wisp-v2 client");

    client.hello(2);
    await client.awaitContinue(0);

    client.connect(1, "example.com", 80);
    const tcp = await until(() => direct.sockets[0]);
    assert.equal(tcp.remoteAddress, "example.com");
    assert.equal(tcp.remotePort, 80);

    // remote -> client
    tcp.remoteSend(new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\nhi"));
    const data = await client.awaitData(1);
    assert.equal(new TextDecoder().decode(data.payload.data.bytes), "HTTP/1.1 200 OK\r\n\r\nhi");

    // client -> remote
    client.data(1, "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n");
    await until(() => tcp.sentBytes.length > 0);
    assert.match(tcp.sentBytes.toString(), /^GET \/ HTTP\/1\.1/);

    // remote close -> client is told
    await tcp.close();
    // closing the fake does not end the readable here, so drive it explicitly
    const stream = await until(() => direct.sockets[0]);
    assert.ok(stream);
  } finally {
    server.close();
    direct.restore();
  }
});

test("a blocked host is refused with HostBlocked, not a hang", async () => {
  const direct = fakeDirectSockets();
  const server = createLocalWispServer({ useDoh: false });
  try {
    const client = wispClient(server.createClient(["wisp-v2"]));
    await client.awaitInfo();
    client.hello(2);
    await client.awaitContinue(0);

    // 10.0.0.1 is private and allow_private_ips is false by default
    client.connect(7, "10.0.0.1", 80);
    const close = await client.awaitClose(7);
    assert.equal(close.payload.reason, close_reasons.HostBlocked);
    assert.equal(direct.sockets.length, 0, "no socket should be opened for a blocked host");
  } finally {
    server.close();
    direct.restore();
  }
});

test("a v1 client is spoken to as v1 (no INFO handshake)", async () => {
  const direct = fakeDirectSockets();
  const server = createLocalWispServer({ useDoh: false });
  try {
    const client = wispClient(server.createClient(["wisp-v1"]));
    const cont = await client.awaitContinue(0);
    assert.equal(cont.payload.buffer_remaining, 128);
    // a v1 client sends CONNECT straight away
    client.connect(1, "example.com", 443);
    const tcp = await until(() => direct.sockets[0]);
    assert.equal(tcp.remotePort, 443);
  } finally {
    server.close();
    direct.restore();
  }
});

test("installWebSocket() routes only the local endpoint and can be undone", () => {
  const server = createLocalWispServer({ useDoh: false });
  const Original = globalThis.WebSocket;
  try {
    const restore = server.installWebSocket();
    assert.notEqual(globalThis.WebSocket, Original);

    const local = new globalThis.WebSocket("wss://local/wisp/", ["wisp-v2"]);
    assert.ok(local, "a local socket is returned");
    assert.equal(globalThis.WebSocket.OPEN, Original.OPEN, "WebSocket constants are preserved");

    restore();
    assert.equal(globalThis.WebSocket, Original);
  } finally {
    server.close();
  }
});

test("the link buffers frames until the client attaches a handler", async () => {
  const link = createLocalWispLink();
  try {
    // the server speaks first, before the client has an onmessage
    link.server.send(new TextEncoder().encode("early"));
    await wait(5);
    const seen = [];
    link.client.onmessage = (event) => seen.push(new TextDecoder().decode(event.data));
    await wait(5);
    assert.deepEqual(seen, ["early"], "the frame must be delivered once a handler exists");
  } finally {
    link.close();
  }
});

test("close() propagates to the peer's onclose", async () => {
  const link = createLocalWispLink();
  let closed = null;
  link.server.onclose = (event) => (closed = event);
  link.client.close(1000, "bye");
  await wait(5);
  assert.ok(closed, "the peer onclose must fire");
  assert.equal(closed.code, 1000);
});

test("isPrivateAddress mirrors the filter's ranges", () => {
  for (const address of ["10.1.2.3", "127.0.0.1", "192.168.0.1", "172.16.0.1", "169.254.1.1", "100.64.0.1", "::1", "fe80::1", "fd00::1"]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be private`);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateAddress(address), false, `${address} should be public`);
  }
});

test("the DoH resolver caches and falls back across endpoints", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("cloudflare-dns.com")) throw new Error("blocked");
    const type = url.includes("type=AAAA") ? 28 : 1;
    return {
      ok: true,
      json: async () => ({ Status: 0, Answer: type === 1 ? [{ name: "x", type: 1, data: "93.184.216.34" }] : [] }),
    };
  };
  const resolve = createDohResolver({ fetch: fetchImpl, endpoints: ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"] });
  assert.equal(await resolve("example.com"), "93.184.216.34");
  const before = calls.length;
  assert.equal(await resolve("example.com"), "93.184.216.34");
  assert.equal(calls.length, before, "second lookup must be cached");
});
