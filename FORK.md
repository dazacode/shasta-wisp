# Fork notice: shasta-wisp

This is a **fork of [MercuryWorkshop/wisp-js](https://github.com/MercuryWorkshop/wisp-js)**,
maintained for the [Shasta](https://github.com/dazacode/Shastaweb) browser OS.

It exists for two reasons:

1. **A browser-side Wisp server.** Shasta can run the whole relay *inside the page*, with no host,
   on a browser that has real sockets (Chromium Isolated Web App + Direct Sockets). That code has
   to be versioned, tested and rolled back on its own.
2. **Small, upstreamable fixes** to the server that Shasta hits in production.

The fork is **public** on purpose: rolling back is a checkout of a tag, and nothing depends on a
private artefact.

## Attribution

wisp-js is Copyright (C) Mercury Workshop and its contributors, licensed
**LGPL-3.0-or-later** (it relicensed from AGPL-3.0 in upstream commit `38a363f`). Everything below
the first Shasta commit is theirs, with its original history and authorship intact. `LICENSE` is
upstream's own LGPL-3.0 text, unmodified.

When we change a file, we change only what the change needs. New code goes in new files
(`src/server/browser/`) wherever possible, so `git diff upstream/master` stays readable and a
future rebase onto upstream is a small job.

## Branches

| Branch | What it is | Rule |
|---|---|---|
| `master` | Upstream, fast-forward only | never commit here; only `git merge --ff-only upstream/master` |
| `shasta` | Our integration branch, the default branch, what Shasta pins | where all work happens |

Tags: `shasta-vX.Y.Z` mark what Shasta has pinned. A tag is immutable once Shasta's submodule
has been pointed at it.

## What is different from upstream

Tracked as `git diff upstream/master`; keep this table in step with it.

### Fixes carried from Shasta

| Commit | File(s) | Why |
|---|---|---|
| `fix(dns): await the resolver before indexing the answer` | `src/server/net.mjs` | upstream 0.5.0/0.5.1 wrote `await resolve_first(hostname)[0]`, which awaits `promise[0]` (= `undefined`), so **every** lookup threw "address not resolved" and `dns_method: "resolve"` was unusable |
| `fix(filter): resolve through an injectable resolver` | `src/server/filter.mjs`, `src/server/resolver.mjs` (new) | the SSRF check called `net.lookup_ip` directly, which on a non-Node build returns the *hostname*, so every private/loopback range check silently passed |

Both are candidates to drop if upstream fixes them: the first is a plain bug, the second is a
one-line seam.

### Additive: the browser server

New files only, plus an entrypoint and a `package.json` export. Nothing in the Node path changes
behaviour.

| File | What |
|---|---|
| `src/server/browser/server.mjs` | `LocalWispServer` / `createLocalWispServer`: runs the real `ServerConnection` over an in-process link; `installWebSocket()` makes `new WebSocket(wss://local/wisp/)` resolve locally |
| `src/server/browser/link.mjs` | `LocalWebSocket`: a `WebSocket`-shaped `MessageChannel` end, with per-end buffering so the server (which speaks first) cannot lose a frame the client has not started listening for |
| `src/server/browser/tcp.mjs` | `BrowserTCPSocket`: `NodeTCPSocket` surface over the Direct Sockets `TCPSocket` |
| `src/server/browser/udp.mjs` | `BrowserUDPSocket`: same over `UDPSocket` |
| `src/server/browser/dns.mjs` | DNS-over-HTTPS resolver for the SSRF filter, with a TTL cache and endpoint fallback |
| `src/entrypoints/browser.mjs` | `@dazacode/shasta-wisp/browser` |
| `test/browser.test.mjs` | drives the whole browser server on Node with a fake `TCPSocket` and a hand-written v2 client, over the real packet codec |

`assert_on_node()` in `net.mjs`/`http.mjs` is deliberately **not** touched: the browser path builds
`ServerConnection` directly with injected socket classes and never calls `routeRequest`.

## Sync from upstream

```sh
git fetch upstream
git switch master && git merge --ff-only upstream/master
git switch shasta && git rebase master
node --test test/            # must stay green
git push --force-with-lease origin shasta
```

Then bump Shasta's pin (below). A rebase conflict will be in `src/server/net.mjs` or
`src/server/filter.mjs`; the conflict is either "upstream fixed it" (drop the commit) or "upstream
moved around it" (rebase the hunk). The `src/server/browser/` tree is new files and does not
conflict.

Rebasing rather than merging keeps `git diff upstream/master` equal to the two tables above, which
is what makes this cheap to maintain.

## Using it

```js
// a hosted relay (unchanged from upstream)
import { server as wisp } from "@dazacode/shasta-wisp/server";

// the in-page relay (Isolated Web App; needs the direct-sockets permission)
import { createLocalWispServer, hasDirectSockets } from "@dazacode/shasta-wisp/browser";
const server = createLocalWispServer();
server.installWebSocket();   // libcurl.js / epoxy now reach wss://local/wisp/ with no relay
```

## Releasing a pin

1. `node --test test/` is green on `shasta`.
2. `git tag -s shasta-vX.Y.Z -m "…"` and push the tag.
3. In Shasta: `git -C wisp fetch --tags && git -C wisp checkout shasta-vX.Y.Z`.
4. Commit the gitlink bump in Shasta and run its checks.

## Roll back

Rolling back is a checkout:

```sh
# in Shasta
git -C wisp checkout shasta-vX.Y.0     # the previous tag
```

To drop the fork entirely and go back to plain upstream, point the submodule at an upstream
commit: `git -C wisp checkout v0.5.1`. Only the two fixes and the browser entrypoint are lost; the
hosted server keeps working.

## Licensing

LGPL-3.0-or-later, as upstream. Shasta itself is AGPL-3.0-only; LGPL-3.0 code used as a library
inside an AGPL application is compatible.

| Component | License |
|---|---|
| wisp-js, `src/**` | LGPL-3.0-or-later |
| `ipaddr.js`, `ws`, `commander`, `bufferutil` | MIT |
| the Wisp protocol specification (not code, not shipped here) | CC-BY-4.0 |
