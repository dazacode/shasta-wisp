// A `NodeTCPSocket`-shaped TCP socket backed by the Direct Sockets API (`TCPSocket`).
//
// `ServerConnection` takes a `TCPSocket` class and calls `new SocketImpl(hostname, port)` on it,
// then uses only this surface: `hostname`, `defineProperty`s-free `connect()`, `recv()`, `send()`,
// `close()`, `pause()`, `resume()`. That is what this class implements, so the *unmodified*
// Wisp server runs in a browser tab with real sockets underneath.
//
// `globalThis.TCPSocket` is an Isolated Web App-only API. It is read lazily (not at import) so the
// module loads on Node too, and so a test can install a fake before constructing a socket.

import { AsyncQueue } from "../../websocket.mjs";

export class DirectSocketsUnavailable extends Error {
  constructor() {
    super("TCPSocket is not available: this needs an Isolated Web App with the direct-sockets permission");
    this.name = "DirectSocketsUnavailable";
  }
}

/** Read bytes into a pre-allocated buffer instead of letting the stream allocate (BYOB). */
const READ_BUFFER_BYTES = 64 * 1024;

export class BrowserTCPSocket {
  constructor(hostname, port) {
    // Availability is checked in `connect()`, not here: `ServerConnection.create_stream` calls
    // `new SocketImpl(...)` synchronously outside its try/catch, so a constructor throw would
    // silently drop the stream instead of closing it with a reason.
    this.hostname = hostname;
    this.port = port;
    this.recv_buffer_size = 128;

    this.socket = null;
    this.reader = null;
    this.writer = null;
    this.connected = false;
    this.paused = false;
    /** @type {null | (() => void)} */
    this._resume_gate = null;
    this.data_queue = new AsyncQueue(this.recv_buffer_size);
    this._read_task = null;
  }

  async connect() {
    const Constructor = globalThis.TCPSocket;
    if (typeof Constructor !== "function") throw new DirectSocketsUnavailable();
    this.socket = new Constructor(this.hostname, this.port, { noDelay: true });
    const { readable, writable } = await this.socket.opened;
    this.reader = readable.getReader({ mode: "byob" });
    this.writer = writable.getWriter();
    this.connected = true;
    this._read_task = this._read_loop().catch(() => this._finish());
  }

  async _read_loop() {
    while (true) {
      if (this.paused) await new Promise((resolve) => (this._resume_gate = resolve));
      let result;
      try {
        result = await this.reader.read(new Uint8Array(READ_BUFFER_BYTES));
      } catch {
        break;
      }
      // A BYOB reader returns a *view into the buffer we passed in*; copy before reusing it.
      const chunk = result.value ? new Uint8Array(result.value) : null;
      if (result.done) break;
      if (chunk && chunk.byteLength) await this.data_queue.put(chunk);
    }
    this._finish();
  }

  /** Close the queue so `recv()` resolves `null` and the stream is torn down once. */
  _finish() {
    if (this.socket) {
      this.socket = null;
      try {
        this.reader?.releaseLock();
      } catch {
        /* ignore */
      }
      try {
        this.writer?.releaseLock();
      } catch {
        /* ignore */
      }
    }
    this.data_queue.close();
    this._resume_gate?.();
    this._resume_gate = null;
  }

  async recv() {
    return await this.data_queue.get();
  }

  async send(data) {
    if (!this.writer) throw new Error("socket is not connected");
    // `write()` resolves when the chunk is accepted by the pipe: the same shape as
    // `socket.write(data, callback)` on Node, so upstream's wait-for-flush semantics hold.
    await this.writer.write(data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  async close() {
    if (!this.socket) {
      this.data_queue.close();
      return;
    }
    const socket = this.socket;
    this.socket = null;
    try {
      await this.writer?.close();
    } catch {
      /* ignore */
    }
    try {
      await socket.close();
    } catch {
      /* ignore */
    }
    this._finish();
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    const gate = this._resume_gate;
    this._resume_gate = null;
    gate?.();
  }
}
