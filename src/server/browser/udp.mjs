// A `NodeUDPSocket`-shaped UDP socket backed by the Direct Sockets API (`UDPSocket`).
//
// Same idea as `./tcp.mjs`: mirror the surface `ServerConnection` uses so the unmodified server
// can open UDP streams in a browser. `UDPSocket` is only created in "connected mode" (one peer),
// which is what a Wisp UDP stream is.
//
// Upstream's `NodeUDPSocket.pause`/`resume` are no-ops, so these are too, for parity.

import { AsyncQueue } from "../../websocket.mjs";

export class BrowserUDPSocket {
  constructor(hostname, port) {
    this.hostname = hostname;
    this.port = port;
    this.recv_buffer_size = 128;

    this.socket = null;
    this.reader = null;
    this.writer = null;
    this.connected = false;
    this.data_queue = new AsyncQueue(this.recv_buffer_size);
    this._read_task = null;
  }

  async connect() {
    const Constructor = globalThis.UDPSocket;
    if (typeof Constructor !== "function") throw new Error("UDPSocket is not available");
    this.socket = new Constructor({ remoteAddress: this.hostname, remotePort: this.port });
    const { readable, writable } = await this.socket.opened;
    this.reader = readable.getReader();
    this.writer = writable.getWriter();
    this.connected = true;
    this._read_task = this._read_loop().catch(() => this._finish());
  }

  async _read_loop() {
    while (true) {
      let result;
      try {
        result = await this.reader.read();
      } catch {
        break;
      }
      if (result.done) break;
      const data = result.value?.data ?? result.value;
      if (data && data.byteLength) await this.data_queue.put(new Uint8Array(data));
    }
    this._finish();
  }

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
  }

  async recv() {
    return await this.data_queue.get();
  }

  async send(data) {
    if (!this.writer) throw new Error("socket is not connected");
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

  pause() {}
  resume() {}
}
