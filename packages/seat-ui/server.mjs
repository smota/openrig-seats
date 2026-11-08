import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { Readable } from "node:stream";
import WebSocket from "ws";

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d+)?$/i;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const fail = (status, message) => new Response(message, { status, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
const upstreamURL = (base, path) => new URL(base.href.replace(/\/$/, "") + path);

/** Fixed-target, same-origin adapter. No bearer is retained beyond its request/terminal connection. */
export function createSeatUIHandler({ gatewayUrl = "http://127.0.0.1:8088", rootDir = fileURLToPath(new URL("./dist", import.meta.url)), fetch: fetcher = globalThis.fetch, connectTerminal = (url, options) => new WebSocket(url, options) } = {}) {
  const base = new URL(gatewayUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("SEAT_GATEWAY_URL must be a fixed HTTP(S) URL without credentials or query");
  let viewers = 0;
  const root = resolve(rootDir);
  const requestUpstream = async (url, init) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try { return await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.any([init.signal, abort.signal]) }); }
    finally { clearTimeout(timer); }
  };
  return async (request) => {
    const url = new URL(request.url);
    const host = request.headers.get("host") ?? url.host;
    if (!LOOPBACK.test(host)) return fail(403, "Host refused");
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return fail(403, "Origin refused");
    if (url.pathname.startsWith("/gateway/")) {
      const authorization = request.headers.get("authorization");
      if (!/^Bearer\s+\S[^\r\n]*$/i.test(authorization ?? "")) return fail(401, "Bearer required");
      const path = url.pathname.slice("/gateway".length);
      const terminal = /^\/terminal\/([^/]+)$/.exec(path);
      const query = [...url.searchParams.keys()];
      const allowed = path === "/capabilities" && !query.length || /^\/snapshot(?:\/[^/]+)?$/.test(path) && query.every((k) => k === "kind") || path === "/stream" && query.every((k) => k === "cursor");
      const act = path === "/act" && !query.length;
      if (terminal && !query.length && request.method === "GET" && request.headers.get("accept") === "application/x-seat-terminal") {
        const raw = request.headers.get("x-seat-ui-scroll-offset") ?? "0";
        if (!/^\d{1,6}$/.test(raw) || Number(raw) > 100000) return fail(400, "Invalid scroll offset");
        let caps;
        try {
          const res = await requestUpstream(upstreamURL(base, "/capabilities"), { headers: { authorization, accept: "application/json" }, signal: request.signal });
          if (!res.ok) { await res.body?.cancel(); return fail(res.status, "Terminal authorization refused"); }
          caps = await res.json();
        } catch { return fail(502, "Gateway unavailable"); }
        const descriptor = caps?.terminal;
        if (caps?.features?.terminal !== true || descriptor?.transport !== "websocket" || descriptor?.readOnly !== true || descriptor?.path !== "/terminal/{seatId}" || descriptor?.output !== "ansi-text" || !Array.isArray(descriptor.clientFrames) || !descriptor.clientFrames.includes("scroll")) return fail(404, "Terminal not advertised");
        const max = Math.min(1048576, Number(descriptor.maxFrameBytes));
        const limit = Math.min(8, Number(descriptor.maxViewers));
        if (!Number.isInteger(max) || max < 1 || !Number.isInteger(limit) || limit < 1) return fail(502, "Invalid terminal descriptor");
        if (viewers >= limit) return fail(503, "Viewer limit reached");
        if (request.signal.aborted) return fail(499, "Disconnected");
        const endpoint = upstreamURL(base, path); endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        let socket;
        try { socket = connectTerminal(endpoint.href, { headers: { authorization }, maxPayload: max, handshakeTimeout: 10000, followRedirects: false, perMessageDeflate: false }); }
        catch { return fail(502, "Terminal unavailable"); }
        viewers++;
        const encoder = new TextEncoder(); let ended = false; let streamController;
        const cleanup = () => {
          if (ended) return; ended = true; clearTimeout(timer); viewers--; request.signal.removeEventListener("abort", cleanup);
          socket.terminate(); try { streamController?.close(); } catch { /* cancelled */ }
        };
        const timer = setTimeout(cleanup, 10000);
        request.signal.addEventListener("abort", cleanup, { once: true });
        const stream = new ReadableStream({
          start(controller) {
            streamController = controller;
            socket.on("open", () => { clearTimeout(timer); if (!ended) socket.send(JSON.stringify({ type: "scroll", offset: Number(raw) })); });
            socket.on("message", (data, binary) => {
              if (ended) return;
              if (binary || Buffer.byteLength(data) > max || controller.desiredSize <= 0) { cleanup(); return; }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data.toString("utf8"))}\n\n`));
            });
            socket.on("close", cleanup); socket.on("error", cleanup);
          },
          cancel: cleanup,
        }, { highWaterMark: 1 });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }
      if (!allowed && !act) return fail(404, "Route not available");
      if (request.method !== (act ? "POST" : "GET")) return fail(405, "Method refused");
      const headers = new Headers({ authorization, accept: path === "/stream" ? "text/event-stream" : "application/json" });
      const last = request.headers.get("last-event-id"); if (last && path === "/stream") headers.set("last-event-id", last);
      let body;
      if (act) {
        if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return fail(415, "JSON required");
        headers.set("content-type", "application/json");
        const chunks = []; let size = 0;
        if (request.body) for await (const chunk of request.body) {
          size += chunk.byteLength; if (size > 256 * 1024) return fail(413, "Body too large"); chunks.push(Buffer.from(chunk));
        }
        body = Buffer.concat(chunks);
      }
      try {
        const res = await requestUpstream(upstreamURL(base, path + url.search), { method: request.method, headers, ...(body ? { body } : {}), signal: request.signal });
        return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      } catch { return fail(502, "Gateway unavailable"); }
    }
    if (request.method !== "GET" || url.search) return fail(404, "Not found");
    let path;
    try { path = resolve(root, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)); }
    catch { return fail(400, "Invalid path"); }
    if (!path.startsWith(root + sep)) return fail(404, "Not found");
    const mime = MIME[extname(path)]; if (!mime) return fail(404, "Not found");
    try {
      return new Response(await readFile(path), { headers: { "content-type": mime, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; connect-src 'self' http: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" } });
    } catch { return fail(404, "Build the UI first"); }
  };
}

/** Node adapter applies backpressure and aborts upstream work when a browser disconnects. */
export function startSeatUI({ port = Number(process.env.PORT ?? 5173), gatewayUrl = process.env.SEAT_GATEWAY_URL ?? "http://127.0.0.1:8088" } = {}) {
  const handle = createSeatUIHandler({ gatewayUrl });
  const server = createServer(async (req, res) => {
    const abort = new AbortController(); res.on("close", () => abort.abort());
    try {
      const request = new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, { method: req.method, headers: req.headers, signal: abort.signal, ...(["GET", "HEAD"].includes(req.method ?? "GET") ? {} : { body: Readable.toWeb(req), duplex: "half" }) });
      const response = await handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).on("error", () => res.destroy()).pipe(res);
      else res.end();
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  server.listen(port, "127.0.0.1", () => console.error(`seat-ui: http://127.0.0.1:${server.address().port}`));
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = startSeatUI();
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.closeAllConnections(); server.close(); });
}
