// An in-process, WebSocket-shaped link between a Wisp client and a Wisp server.
//
// A Wisp client (the one inside libcurl.js or epoxy) only ever does this to reach a relay:
//
//   const ws = new WebSocket("wss://relay.example/wisp/");
//   ws.binaryType = "arraybuffer";
//   ws.onmessage = (event) => handle(new Uint8Array(event.data));
//   ws.onclose = ...; ws.onerror = ...;
//   ws.send(bytes); ws.close();
//
// and the Wisp server side (`AsyncWebSocket` in ../websocket.mjs) does the same shape:
// `onopen`/`onmessage`/`onclose`, `readyState === ws.OPEN`, `send(...)`, `close(code, reason)`,
// `bufferedAmount`, and an optional `ping()`. Both ends are satisfied by the object below, so the
// *real* client and the *real* `ServerConnection` can be wired together with no server and no
// protocol changes: only the transport underneath the frames is different (a `MessageChannel`
// instead of a TCP websocket).
//
// Two things a naive shim gets wrong, handled here:
//   * The server speaks first (the v2 INFO / initial CONTINUE is sent from `setup()`), but the
//     client only assigns `onmessage` once its transport has constructed it. Events are therefore
//     queued per end and flushed as soon as a handler (or `addEventListener`) is attached.
//   * A real close travels both ways. `close()` notifies the peer with a tagged frame so the
//     other `onclose` fires, then closes the port.

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const DATA = "d";
const CLOSE = "c";

class LinkEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    Object.assign(this, init);
  }
}

export class LocalWebSocket extends EventTarget {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  // instance copies: the server reads `this.ws.OPEN`
  CONNECTING = CONNECTING;
  OPEN = OPEN;
  CLOSING = CLOSING;
  CLOSED = CLOSED;

  /** @param {MessagePort} port an end of a `MessageChannel` */
  constructor(port, url = "local:") {
    super();
    this.url = url;
    this.protocol = "";
    this.extensions = "";
    this.binaryType = "arraybuffer";
    this.readyState = OPEN;
    this._port = port;
    this._closed = false;
    this._handlers = { open: null, message: null, close: null, error: null };
    this._pending = [];
    this._counts = new Map();
    this._port.onmessage = (event) => this._deliver(event.data);

    // A socket is already established; announce it like the real API does.
    queueMicrotask(() => this._push(new LinkEvent("open")));
  }

  _push(event) {
    this._pending.push(event);
    this._flush();
  }

  _flush() {
    while (this._pending.length) {
      const head = this._pending[0];
      const type = head.type;
      const handler = this._handlers[type];
      const hasListener = (this._counts.get(type) ?? 0) > 0;
      const attached = typeof handler === "function" || hasListener;
      // `message`/`close` must survive until something listens (the server speaks first, and the
      // client only assigns `onmessage` once its transport has built it). `open`/`error` are
      // point-in-time events: with no handler they are dropped, like the real API.
      const sticky = type === "message" || type === "close";
      if (!attached && !sticky) {
        this._pending.shift();
        continue;
      }
      if (!attached) return;
      const event = this._pending.shift();
      if (typeof handler === "function") handler.call(this, event);
      this.dispatchEvent(event);
    }
  }

  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    this._counts.set(type, (this._counts.get(type) ?? 0) + 1);
    this._flush();
  }

  _deliver(message) {
    if (this._closed) return;
    if (message && message.t === CLOSE) {
      this._shutdown(message.code ?? 1000, message.reason ?? "", false);
      return;
    }
    const data = message && message.t === DATA ? message.b : message;
    this._push(new LinkEvent("message", { data }));
  }

  _shutdown(code, reason, notifyPeer) {
    if (this._closed) return;
    this._closed = true;
    this.readyState = CLOSED;
    this._push(new LinkEvent("close", { code, reason, wasClean: true }));
    if (notifyPeer) {
      try {
        this._port.postMessage({ t: CLOSE, code, reason });
      } catch {
        /* port already gone */
      }
    }
    try {
      this._port.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * Bytes out. Accepts what a real `WebSocket.send` accepts; frames use `ArrayBuffer`.
   * Per the WebSocket spec, a send in CONNECTING throws and a send while CLOSING/CLOSED is
   * discarded silently — not thrown — which matters because `AsyncWebSocket.send` does not guard.
   */
  send(data) {
    if (this.readyState === CONNECTING) throw new DOMException("socket is still connecting", "InvalidStateError");
    if (this.readyState > OPEN) return;
    this._port.postMessage({ t: DATA, b: toArrayBuffer(data) });
  }

  close(code = 1000, reason = "") {
    if (this._closed) return;
    this.readyState = CLOSING;
    this._shutdown(code, reason, true);
  }

  /** No real pings in-process, but `AsyncWebSocket` installs an interval if this exists. */
  ping() {}

  /** No backpressure worth modelling in-process; `AsyncWebSocket` throttles only above 32 MiB. */
  get bufferedAmount() {
    return 0;
  }
}

// `onopen` / `onmessage` / `onclose` / `onerror` as flushing accessors.
for (const name of ["open", "message", "close", "error"]) {
  Object.defineProperty(LocalWebSocket.prototype, "on" + name, {
    configurable: true,
    get() {
      return this._handlers[name];
    },
    set(fn) {
      this._handlers[name] = typeof fn === "function" ? fn : null;
      this._flush();
    },
  });
}

/** @param {unknown} data */
function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (typeof data === "string") {
    const bytes = new TextEncoder().encode(data);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  throw new TypeError("unsupported send() payload");
}

/**
 * A connected pair: `server` goes to `ServerConnection`, `client` stands in for the
 * `WebSocket` the Wisp client would have opened to a relay.
 *
 * @returns {{ server: LocalWebSocket, client: LocalWebSocket, close: () => void }}
 */
export function createLocalWispLink(url = "wss://local/wisp/") {
  const channel = new MessageChannel();
  const server = new LocalWebSocket(channel.port1, url);
  const client = new LocalWebSocket(channel.port2, url);
  return {
    server,
    client,
    close: () => {
      client.close();
      server.close();
    },
  };
}

export const LINK_STATES = { CONNECTING, OPEN, CLOSING, CLOSED };
