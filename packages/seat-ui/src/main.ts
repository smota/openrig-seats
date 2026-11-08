import { SeatUI } from "./ui.js";
import { connectSeat, terminalStream, gatewayURL } from "./connection.js";
import { element, field } from "./dom.js";
import "./style.css";

const app = document.querySelector<HTMLElement>("#app")!;
const heading = element("header"); heading.append(element("h1", "Seats"), element("p", "Reference protocol viewer", "subtitle"));
const form = element("form", undefined, "connection");
const gateway = element("input"); gateway.name = "gateway"; gateway.value = "/gateway"; gateway.required = true; gateway.spellcheck = false;
const token = element("input"); token.name = "token"; token.type = "password"; token.autocomplete = "off"; token.required = true;
const connect = element("button", "Connect"); connect.type = "submit";
const disconnect = element("button", "Disconnect"); disconnect.type = "button"; disconnect.disabled = true;
const fixtures = element("button", "Explore fixtures"); fixtures.type = "button";
form.append(field("Gateway URL", gateway), field("Bearer token (memory only)", token), connect, disconnect, fixtures);
const status = element("p", "Disconnected. Connect to a gateway or explore the protocol fixtures.", "connection-status"); status.setAttribute("role", "status");
const content = element("main");
app.append(heading, form, status, content);
let controller: AbortController | undefined;
let view: SeatUI | undefined;
function stop(): void {
  controller?.abort(); controller = undefined; view?.dispose(); view = undefined; token.value = "";
  disconnect.disabled = true; connect.disabled = false; status.textContent = "Disconnected. The bearer token has been forgotten.";
}
disconnect.addEventListener("click", stop);
form.addEventListener("submit", (event) => {
  event.preventDefault(); if (!form.reportValidity()) return;
  const bearer = token.value.trim();
  let base: URL;
  try {
    base = gatewayURL(gateway.value);
  } catch (error) { status.textContent = error instanceof Error ? error.message : "Invalid gateway URL."; return; }
  stop(); const abort = new AbortController(); controller = abort; disconnect.disabled = false; connect.disabled = true;
  status.textContent = "Loading capabilities and snapshot…";
  void connectSeat({
    baseUrl: base.href.replace(/\/$/, ""), token: bearer, signal: abort.signal,
    ready: (capabilities, snapshot, act) => {
      if (abort.signal.aborted) return;
      const localBridge = base.origin === location.origin && base.pathname.replace(/\/$/, "") === "/gateway";
      view = new SeatUI(content, { capabilities, act,
        ...(localBridge && capabilities.terminal ? { terminal: (id, offset, output, signal) => terminalStream(base.href, capabilities.terminal!.path, bearer, id, offset, output, signal, globalThis.fetch, capabilities.terminal!.maxFrameBytes) } : {}),
      }); view.snapshot(snapshot);
    },
    item: (item) => view?.apply(item),
    status: (message) => { if (!abort.signal.aborted) status.textContent = message; },
  }).catch((error: unknown) => {
    if (!abort.signal.aborted) { status.textContent = error instanceof RangeError ? error.message : "Connection failed. Check the gateway URL, bearer token and allowed origin configuration."; connect.disabled = false; }
  });
});
fixtures.addEventListener("click", async () => {
  stop(); const abort = new AbortController(); controller = abort; disconnect.disabled = false;
  const { fixtureData } = await import("./fixtures.js"); if (abort.signal.aborted) return;
  const data = fixtureData();
  view = new SeatUI(content, { capabilities: data.capabilities,
    act: async (input) => ({ idempotencyKey: input.idempotencyKey, status: "completed", replayed: false, result: { simulated: true, message: "Fixture demonstration only; nothing was sent." } }),
    terminal: async (_id, offset, output) => { output(`Fixture terminal (simulated)\nScroll offset: ${offset}\nRead-only output; no input is sent.`); },
  }); view.snapshot(data.snapshot); status.textContent = "Fixture mode · simulated actions and terminal · no gateway requests";
});
window.addEventListener("pagehide", stop);
