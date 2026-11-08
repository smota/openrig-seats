import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActInput, Capabilities } from "@openrig-seats/seat-protocol";
import { createActionForm } from "../src/forms.js";
import { fixtureData } from "../src/fixtures.js";
import { SeatUI } from "../src/ui.js";

const fixtures = resolve(import.meta.dirname, "../../seat-protocol/schemas/fixtures/valid");
const fixture = (kind: string, file: string) => JSON.parse(readFileSync(resolve(fixtures, kind, file), "utf8"));
const caps = (): Capabilities => fixture("capabilities", "minimal.json");
const roots: HTMLElement[] = [];
function ui(capabilities = caps()) {
  const root = document.createElement("div"); document.body.append(root); roots.push(root);
  return { root, ui: new SeatUI(root, { capabilities, act: async (input) => ({ idempotencyKey: input.idempotencyKey!, status: "completed", replayed: false }) }) };
}
afterEach(() => { for (const root of roots.splice(0)) root.remove(); vi.restoreAllMocks(); });

describe("valid schema fixtures", () => {
  for (const kind of ["host", "rig", "seat", "turn", "attention", "work"]) {
    for (const file of readdirSync(resolve(fixtures, kind)).filter((f) => f.endsWith(".json"))) {
      it(`renders ${kind}/${file}`, () => {
        const { root, ui: view } = ui();
        const item = fixture(kind, file);
        view.snapshot({ cursor: "snapshot-1", kinds: { [kind]: [item] } });
        if (kind === "seat") view.selectSeat(item.id);
        expect(root.textContent).toContain(item.name ?? item.title ?? item.id);
        expect(root.querySelector("script,img,iframe")).toBeNull();
      });
    }
  }
  for (const file of readdirSync(resolve(fixtures, "capabilities"))) {
    it(`renders capabilities/${file}`, () => {
      const { root } = ui(fixture("capabilities", file));
      expect(root.textContent).toContain("1.0");
    });
  }
  it("renders unknown kinds and declared actions generically", () => {
    const { root, ui: view } = ui({ ...caps(), features: { act: true } });
    view.apply(fixture("stream-envelope", "extension-generic-card.json"));
    expect(root.textContent).toContain("Grant spend");
    expect(root.textContent).toContain("EUR 40");
    expect([...root.querySelectorAll("button")].some((b) => b.textContent === "Grant")).toBe(true);
  });
});

it("applies snapshot, updates, deletes and resets without losing a form draft", () => {
  const { root, ui: view } = ui(fixture("capabilities", "with-actions.json"));
  const seat = fixture("seat", "minimal.json");
  view.snapshot({ cursor: "opaque-snapshot", kinds: { seat: [seat] } }); view.selectSeat("s1");
  const text = root.querySelector<HTMLInputElement>('[name="input.text"]')!;
  text.value = "draft"; text.focus();
  view.apply({ cursor: "opaque-next", kind: "seat", id: "s1", op: "upsert", data: { ...seat, state: "idle" } });
  expect(root.querySelector('[name="input.text"]')).toBe(text);
  expect(text.value).toBe("draft"); expect(document.activeElement).toBe(text);
  expect(view.cursor).toBe("opaque-next");
  view.apply({ cursor: "opaque-delete", kind: "seat", id: "s1", op: "delete" });
  expect(root.textContent).not.toContain(seat.name);
  view.apply({ type: "reset", reason: "cursor-unknown" });
  expect(view.cursor).toBeUndefined(); expect(view.mirror.kinds()).toEqual([]);
});

it("generates an input form and submits a new UUID per submission", async () => {
  const submit = vi.fn(async (_input: ActInput) => ({ status: "completed" }));
  const action = fixture("action", "form-danger.json");
  const form = createActionForm("attention", "a1", action, submit, () => true);
  document.body.append(form);
  const reason = form.querySelector<HTMLInputElement>('[name="input.reason"]')!;
  expect(reason.required).toBe(true); reason.value = "too risky";
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0]?.[0]).toMatchObject({ kind: "attention", id: "a1", action: "decline", input: { reason: "too risky" }, idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  await vi.waitFor(() => expect(form.querySelector("button")!.disabled).toBe(false));
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submit.mock.calls[1]?.[0].idempotencyKey).not.toBe(submit.mock.calls[0]?.[0].idempotencyKey);
  form.remove();
});

it("validates complex schemas using a JSON editor and disables false schemas", async () => {
  const submit = vi.fn(async () => ({}));
  const form = createActionForm("work", "w", { id: "custom", label: "Custom", input: { oneOf: [{ type: "integer", minimum: 5 }, { type: "array", items: { type: "boolean" } }] } }, submit);
  const json = form.querySelector("textarea")!;
  json.value = "2"; form.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(submit).not.toHaveBeenCalled(); expect(form.textContent).toContain("Invalid input");
  json.value = "[true,false]"; form.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(createActionForm("work", "w", { id: "x", label: "X", input: false }, submit).querySelector("button")!.disabled).toBe(true);
});

it("requires confirmation before danger actions", () => {
  const submit = vi.fn(async () => ({})); const confirm = vi.fn(() => false);
  const form = createActionForm("seat", "s", { id: "stop", label: "Stop", danger: true }, submit, confirm);
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(confirm).toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
});

it("hides terminal unless advertised and exposes no key input", () => {
  const { root, ui: view } = ui();
  view.snapshot({ cursor: "x", kinds: { seat: [fixture("seat", "minimal.json")] } }); view.selectSeat("s1");
  expect(root.querySelector('[aria-label="Read-only terminal"]')).toBeNull();
  const terminalCaps = fixture("capabilities", "with-terminal.json");
  const advertised = ui(terminalCaps); advertised.ui.snapshot({ cursor: "x", kinds: { seat: [fixture("seat", "minimal.json")] } }); advertised.ui.selectSeat("s1");
  const terminal = advertised.root.querySelector('[aria-label="Read-only terminal"]')!;
  expect(terminal).not.toBeNull(); expect(terminal.querySelector('[contenteditable], textarea, input[type="text"]')).toBeNull();
});

it("renders an XSS fixture as inert text in content, labels and forms", () => {
  const attack = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/xss.json"), "utf8"));
  const { root, ui: view } = ui({ ...caps(), features: { act: true } });
  view.snapshot({ cursor: "x", kinds: { "x-example.card": [attack] } });
  expect(root.textContent).toContain(attack.title); expect(root.querySelector("img,script,iframe,svg")).toBeNull();
  expect((window as unknown as Record<string, unknown>).pwned).toBeUndefined();
});


it("loads the bundled fixture demonstration with complete entities", () => {
  const data = fixtureData();
  for (const items of Object.values(data.snapshot.kinds)) for (const item of items) expect(typeof item.id).toBe("string");
  const { root, ui: view } = ui(data.capabilities); view.snapshot(data.snapshot); view.selectSeat("s1");
  expect(root.textContent).toContain("Review PR");
});

it("compiles reused schema IDs independently for each item's action form", () => {
  const action = { id: "set", label: "Set", input: { $id: "https://example.test/input", type: "string" } };
  const submit = async () => ({});
  const a = createActionForm("seat", "a", structuredClone(action), submit);
  const b = createActionForm("seat", "b", structuredClone(action), submit);
  expect(a.querySelector("button")!.disabled).toBe(false); expect(b.querySelector("button")!.disabled).toBe(false);
});

it("keeps unchecked nested optional fields disabled when their parent is enabled", () => {
  const form = createActionForm("seat", "s", { id: "set", label: "Set", input: { type: "object", properties: { parent: { type: "object", properties: { nested: { type: "string" } } } } } }, async () => ({}));
  const parent = [...form.querySelectorAll("label")].find((l) => l.textContent === "Include parent")!.querySelector("input")!;
  parent.checked = true; parent.dispatchEvent(new Event("change"));
  expect(form.querySelector<HTMLInputElement>('[name="input.parent.nested"]')!.disabled).toBe(true);
});


for (const file of readdirSync(resolve(fixtures, "action"))) {
  it(`renders declared action fixture ${file}`, () => {
    const action = fixture("action", file);
    const form = createActionForm("work", "w", action, async () => ({}));
    expect(form.querySelector("button")!.textContent).toBe(action.label);
    expect(form.querySelector("button")!.disabled).toBe(action.input === false);
    if (action.input === true) expect(form.querySelector("textarea")).not.toBeNull();
  });
}

it("disables unresolved remote schema references without fetching them", () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  const form = createActionForm("work", "w", { id: "remote", label: "Remote", input: { $ref: "https://example.test/unavailable.json" } }, async () => ({}));
  expect(form.querySelector("button")!.disabled).toBe(true); expect(form.textContent).toContain("cannot be resolved locally");
  expect(fetcher).not.toHaveBeenCalled();
});
