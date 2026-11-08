import { Mirror, isCoreKind, isStreamControl, toGenericCard, type ActInput, type Action, type Capabilities, type StreamItem } from "@openrig-seats/seat-protocol";
import { element, field, record, text } from "./dom.js";
import { createActionForm } from "./forms.js";

export interface Snapshot { cursor: string; kinds: Record<string, Record<string, unknown>[]> }
export interface UIOptions {
  capabilities: Capabilities;
  act: (input: ActInput) => Promise<unknown>;
  terminal?: (seatId: string, offset: number, output: (text: string) => void, signal: AbortSignal) => Promise<void>;
}

/** A protocol-only renderer. Stream redraws reuse forms and terminal nodes to retain drafts. */
export class SeatUI {
  readonly mirror = new Mirror();
  cursor: string | undefined;
  private selected: string | undefined;
  private readonly forms = new Map<string, { signature: string; node: HTMLFormElement }>();
  private terminalNode: HTMLElement | undefined;
  private terminalId: string | undefined;
  private terminalAbort: AbortController | undefined;
  private readonly content = element("div", undefined, "workspace");
  constructor(private readonly root: HTMLElement, private readonly options: UIOptions) {
    const caps = options.capabilities;
    const about = element("details"); about.append(element("summary", `Protocol ${caps.protocol.version} · ${caps.kinds.length} declared kinds`));
    about.append(element("pre", JSON.stringify(caps, null, 2)));
    root.replaceChildren(about, this.content); this.render();
  }
  snapshot(snapshot: Snapshot): void {
    this.mirror.clear();
    for (const [kind, items] of Object.entries(snapshot.kinds)) for (const item of items) {
      if (typeof item.id === "string") this.mirror.apply({ kind, id: item.id, op: "upsert", data: item });
    }
    this.cursor = snapshot.cursor; this.render();
  }
  apply(item: StreamItem): void {
    this.mirror.apply(item);
    if (isStreamControl(item)) { if (item.type === "reset") this.cursor = undefined; }
    else this.cursor = item.cursor;
    this.render();
  }
  selectSeat(id: string): void { this.selected = id; this.render(); }
  dispose(): void { this.terminalAbort?.abort(); this.forms.clear(); this.root.replaceChildren(); }

  private actionForms(kind: string, item: Record<string, unknown>): HTMLElement {
    const box = element("div", undefined, "actions");
    if (this.options.capabilities.features.act !== true) return box;
    const declared = new Map<string, Action>();
    for (const declaration of this.options.capabilities.actions ?? []) if (declaration.kind === kind) declared.set(declaration.action.id, declaration.action);
    if (Array.isArray(item.actions)) for (const value of item.actions) {
      const action = record(value);
      if (typeof action.id === "string" && typeof action.label === "string") declared.set(action.id, action as Action);
    }
    for (const action of declared.values()) {
      const key = JSON.stringify([kind, item.id, action.id]);
      const signature = JSON.stringify(action);
      let cached = this.forms.get(key);
      if (cached?.signature !== signature) {
        cached = { signature, node: createActionForm(kind, String(item.id), action, this.options.act) }; this.forms.set(key, cached);
      }
      box.append(cached.node);
    }
    return box;
  }
  private card(kind: string, item: Record<string, unknown>): HTMLElement {
    const generic = toGenericCard({ kind, id: text(item.id), data: item });
    const card = element("article", undefined, "entity");
    card.dataset.kind = kind; card.dataset.id = text(item.id);
    const title = text(item.name) || generic.title;
    if (kind === "seat") {
      const select = element("button", title, "seat-link"); select.type = "button";
      select.setAttribute("aria-pressed", String(this.selected === item.id));
      select.addEventListener("click", () => this.selectSeat(String(item.id))); card.append(select);
    } else card.append(element("h3", title));
    if (item.state) card.append(element("span", text(item.state), "state"));
    if (generic.summary) card.append(element("p", generic.summary));
    for (const key of ["activity", "harness", "reason", "impact", "severity", "generationId", "waitingOnHuman"]) if (item[key] !== undefined) {
      const row = element("p", undefined, "metadata"); row.append(element("strong", `${key}: `), document.createTextNode(text(item[key]))); card.append(row);
    }
    if (kind === "turn" && Array.isArray(item.parts)) {
      card.append(element("p", `${text(item.role)} · ${text(item.updatedAt)}`, "metadata"));
      for (const partValue of item.parts) {
        const part = record(partValue);
        const block = element("div", undefined, "turn-part");
        switch (part.type) {
          case "text": block.append(element("pre", text(part.text))); break;
          case "tool": block.append(element("strong", `${text(part.name)} · ${text(part.status)}`), element("p", text(part.summary))); break;
          case "status": block.append(element("p", `${text(part.state)}${part.label ? ` · ${text(part.label)}` : ""}`)); break;
          case "question": {
            block.append(element("p", text(part.prompt)));
            const list = element("ul");
            for (const value of Array.isArray(part.options) ? part.options : []) { const option = record(value); list.append(element("li", `${text(option.name)} (${text(option.kind)})`)); }
            block.append(list); if (part.answeredOptionId) block.append(element("p", `Answered: ${text(part.answeredOptionId)}`));
            break;
          }
          default: block.append(element("p", `Part: ${text(part.type)}`));
        }
        card.append(block);
      }
    }
    card.append(this.actionForms(kind, item));
    return card;
  }
  private section(title: string, kind: string, items: Record<string, unknown>[]): HTMLElement {
    const section = element("section"); section.append(element("h2", `${title} (${items.length})`));
    if (!items.length) section.append(element("p", "No items.", "empty"));
    for (const item of items) section.append(this.card(kind, item));
    return section;
  }
  private terminal(seatId: string): HTMLElement | undefined {
    const caps = this.options.capabilities;
    if (caps.features.terminal !== true || !caps.terminal || caps.terminal.readOnly !== true) return;
    if (this.terminalNode && this.terminalId === seatId) return this.terminalNode;
    this.terminalAbort?.abort(); this.terminalId = seatId;
    const panel = element("section"); panel.setAttribute("aria-label", "Read-only terminal");
    panel.append(element("h2", "Terminal · read only"));
    const output = element("pre", "Waiting for output…", "terminal"); output.tabIndex = 0; output.setAttribute("aria-label", "Terminal output");
    const status = element("p", "Scroll only; keyboard input is never sent.", "metadata");
    panel.append(status);
    if (this.options.terminal) {
      const offset = element("input"); offset.type = "number"; offset.min = "0"; offset.max = "100000"; offset.step = "1"; offset.value = "0";
      const scroll = element("button", "View scroll offset"); scroll.type = "button";
      const open = () => {
        if (!offset.checkValidity()) { offset.reportValidity(); return; }
        const value = Number(offset.value); if (!Number.isInteger(value) || value < 0 || value > 100000) return;
        this.terminalAbort?.abort(); const abort = new AbortController(); this.terminalAbort = abort;
        output.textContent = "Waiting for output…";
        void this.options.terminal!(seatId, value, (value) => { if (!abort.signal.aborted) output.textContent = value; }, abort.signal)
          .catch(() => { if (!abort.signal.aborted) status.textContent = "Terminal connection unavailable. Choose the offset again to reconnect."; });
      };
      scroll.addEventListener("click", open);
      panel.append(field("Lines above live output (0 = live)", offset), scroll); open();
    } else status.textContent = "Use the standalone UI server for authenticated terminal viewing; browsers cannot set a WebSocket bearer header.";
    panel.append(output); this.terminalNode = panel; return panel;
  }
  private render(): void {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : undefined;
    const scrollTop = this.terminalNode?.querySelector("pre")?.scrollTop;
    const list = element("div", undefined, "inventory");
    list.append(this.section("Hosts", "host", this.mirror.list("host")), this.section("Rigs", "rig", this.mirror.list("rig")), this.section("Seats", "seat", this.mirror.list("seat")));
    const detail = element("div", undefined, "detail");
    const seat = this.selected ? this.mirror.get("seat", this.selected) : undefined;
    if (seat) {
      detail.append(element("h2", "Seat detail"), this.card("seat", seat));
      detail.append(this.section("Turns", "turn", this.mirror.list("turn").filter((t) => t.seatId === this.selected)));
      detail.append(this.section("Attention", "attention", this.mirror.list("attention").filter((a) => a.seatId === this.selected || a.rigId === seat.rigId || (Array.isArray(seat.attentionIds) && seat.attentionIds.includes(a.id)))));
      detail.append(this.section("Work", "work", this.mirror.list("work").filter((w) => w.assigneeSeatId === this.selected || w.creatorSeatId === this.selected)));
      const terminal = this.terminal(String(seat.id)); if (terminal) detail.append(terminal);
    } else {
      detail.append(element("h2", "Select a seat"), element("p", "Choose a seat to inspect its turns, attention, work and declared actions.", "empty"));
      for (const [title, kind] of [["Turns", "turn"], ["Attention", "attention"], ["Work", "work"]]) detail.append(this.section(title!, kind!, this.mirror.list(kind!)));
      this.terminalAbort?.abort(); this.terminalNode = undefined; this.terminalId = undefined;
    }
    for (const kind of this.mirror.kinds().filter((k) => !isCoreKind(k))) detail.append(this.section(kind, kind, this.mirror.list(kind)));
    // Selected-seat forms live only in detail; do not move one node into two simultaneous views.
    if (seat) for (const card of list.querySelectorAll<HTMLElement>('[data-kind="seat"]')) if (card.dataset.id === this.selected) card.querySelector(".actions")?.replaceChildren();
    const live = new Set(this.mirror.kinds().flatMap((kind) => this.mirror.list(kind).map((item) => JSON.stringify([kind, item.id]))));
    for (const key of this.forms.keys()) { const [kind, id] = JSON.parse(key) as string[]; if (!live.has(JSON.stringify([kind, id]))) this.forms.delete(key); }
    this.content.replaceChildren(list, detail);
    if (active?.isConnected) {
      active.focus({ preventScroll: true });
      if (selection && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.type !== "number" && active.type !== "checkbox") active.setSelectionRange(selection[0]!, selection[1]!);
    }
    if (scrollTop !== undefined) this.terminalNode?.querySelector("pre")?.scrollTo?.(0, scrollTop);
  }
}
