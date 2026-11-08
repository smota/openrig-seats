import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ActInput, Action, Json } from "@openrig-seats/seat-protocol";
import { element, field, record, text } from "./dom.js";

type Schema = boolean | Record<string, unknown>;
function freshAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, addUsedSchema: false, allErrors: true, validateFormats: true });
  addFormats.default(ajv); return ajv;
}
function guardSchema(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error("Schema exceeds 32 levels");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "pattern" && typeof child === "string" && child.length > 500) ||
      (key === "patternProperties" && child && typeof child === "object" && Object.keys(child).some((pattern) => pattern.length > 500))) throw new Error("Pattern exceeds 500 characters");
    guardSchema(child, depth + 1);
  }
}
function stableJSON(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => child && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
}
/** Own both caches: evicting a validator also releases Ajv's schema-object cache. */
export class ActionFormValidators {
  private ajv = freshAjv();
  private readonly cache = new Map<string, { schema: Schema; validate: ValidateFunction }>();
  constructor(private readonly limit = 200) {}
  get size(): number { return this.cache.size; }
  compile(schema: Schema): ValidateFunction {
    guardSchema(schema);
    const key = stableJSON(schema);
    let entry = this.cache.get(key);
    if (entry) this.cache.delete(key);
    else {
      try { entry = { schema, validate: this.ajv.compile(schema) }; }
      catch (error) { this.ajv.removeSchema(schema); throw error; }
    }
    this.cache.set(key, entry);
    if (this.cache.size > this.limit) {
      const oldest = this.cache.keys().next().value!;
      this.ajv.removeSchema(this.cache.get(oldest)!.schema); this.cache.delete(oldest);
    }
    return entry.validate;
  }
  errorsText(validate: ValidateFunction): string { return this.ajv.errorsText(validate.errors, { separator: "; " }); }
  dispose(): void { this.cache.clear(); this.ajv = freshAjv(); }
}
const defaultValidators = new ActionFormValidators();
function idempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
type Control = { node: HTMLElement; read: () => unknown };

/** Small, native form subset; everything else gets a JSON editor and the same full validator. */
function nativeSchema(schema: Schema, depth = 0): boolean {
  if (typeof schema === "boolean" || depth > 8) return false;
  const simple = new Set(["type", "title", "description", "default", "examples", "enum", "const", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "properties", "required", "additionalProperties", "$schema", "$id"]);
  if (Object.keys(schema).some((k) => !simple.has(k))) return false;
  if (Array.isArray(schema.enum) || Object.hasOwn(schema, "const")) return true;
  if (["string", "number", "integer", "boolean", "null"].includes(String(schema.type))) return true;
  if (schema.type !== "object") return false;
  return Object.values(record(schema.properties)).every((s) => typeof s === "object" && s !== null && nativeSchema(s as Record<string, unknown>, depth + 1));
}

function control(schema: Record<string, unknown>, name: string, required: boolean): Control {
  if (schema.type === "object" && !Array.isArray(schema.enum) && !Object.hasOwn(schema, "const")) {
    const box = element("fieldset"); box.append(element("legend", text(schema.title) || name));
    const fields: Array<{ key: string; child: Control; include?: HTMLInputElement }> = [];
    for (const [key, value] of Object.entries(record(schema.properties))) {
      const childSchema = record(value);
      const needed = Array.isArray(schema.required) && schema.required.includes(key);
      const child = control(childSchema, `${name}.${key}`, needed);
      const wrapper = element("div", undefined, "form-field");
      let include: HTMLInputElement | undefined;
      if (!needed) {
        include = element("input"); include.type = "checkbox"; include.checked = childSchema.default !== undefined;
        wrapper.append(field(`Include ${key}`, include));
        const toggle = () => { if (child.node instanceof HTMLFieldSetElement || child.node instanceof HTMLInputElement || child.node instanceof HTMLSelectElement) child.node.disabled = !include!.checked; };
        include.addEventListener("change", toggle); toggle();
      }
      if (childSchema.type === "object") wrapper.append(child.node);
      else wrapper.append(field(text(childSchema.title) || key, child.node));
      if (childSchema.description) wrapper.append(element("small", text(childSchema.description)));
      box.append(wrapper); fields.push({ key, child, ...(include ? { include } : {}) });
    }
    return { node: box, read: () => Object.fromEntries(fields.filter((f) => !f.include || f.include.checked).map((f) => [f.key, f.child.read()])) };
  }
  if (Array.isArray(schema.enum) || Object.hasOwn(schema, "const")) {
    const values: unknown[] = Array.isArray(schema.enum) ? schema.enum : [schema.const];
    const select = element("select"); select.name = name; select.required = required;
    values.forEach((value, index) => { const option = element("option", text(value)); option.value = String(index); select.append(option); });
    const defaultIndex = values.findIndex((v) => JSON.stringify(v) === JSON.stringify(schema.default));
    if (defaultIndex >= 0) select.value = String(defaultIndex);
    return { node: select, read: () => values[Number(select.value)] };
  }
  if (schema.type === "null") return { node: element("output", "null"), read: () => null };
  const input = element("input"); input.name = name; input.required = required;
  input.type = schema.type === "boolean" ? "checkbox" : ["integer", "number"].includes(String(schema.type)) ? "number" : "text";
  if (input.type === "checkbox") { input.required = false; input.checked = schema.default === true; }
  else if (schema.default !== undefined) input.value = text(schema.default);
  if (typeof schema.minLength === "number") input.minLength = schema.minLength;
  if (typeof schema.maxLength === "number") input.maxLength = schema.maxLength;
  if (typeof schema.pattern === "string") input.pattern = schema.pattern;
  if (typeof schema.minimum === "number") input.min = String(schema.minimum);
  if (typeof schema.maximum === "number") input.max = String(schema.maximum);
  if (input.type === "number") input.step = schema.type === "integer" ? "1" : "any";
  return { node: input, read: () => input.type === "checkbox" ? input.checked : input.type === "number" ? (input.value === "" ? undefined : Number(input.value)) : input.value };
}

export function createActionForm(
  kind: string, id: string, action: Pick<Action, "id" | "label" | "input" | "danger">,
  submit: (input: ActInput) => Promise<unknown>, confirm: (message: string) => boolean = (message) => window.confirm(message),
  validators: ActionFormValidators = defaultValidators,
): HTMLFormElement {
  const form = element("form", undefined, "action-form");
  form.setAttribute("aria-label", action.label); form.noValidate = true;
  form.append(element("h4", action.label));
  let validate: ValidateFunction | undefined;
  let compileError = "";
  if (action.input !== undefined) {
    try { validate = validators.compile(action.input); }
    catch { compileError = "This input schema cannot be resolved locally. Submission is unavailable."; }
  }
  const native = !compileError && typeof action.input === "object" && nativeSchema(action.input);
  const nativeControl = native ? control(action.input as Record<string, unknown>, "input", true) : undefined;
  const json = element("textarea"); json.name = "input-json"; json.rows = 5; json.spellcheck = false;
  json.value = JSON.stringify(typeof action.input === "object" ? action.input.default ?? (action.input.type === "object" ? {} : action.input.type === "array" ? [] : null) : null, null, 2);
  const jsonField = field("Input (JSON)", json);
  let jsonMode = !nativeControl;
  if (nativeControl) {
    const nativeBox = element("div");
    nativeBox.append(nativeControl.node instanceof HTMLFieldSetElement ? nativeControl.node : field(text(record(action.input).title) || "Input", nativeControl.node));
    form.append(nativeBox);
    const mode = element("input"); mode.type = "checkbox";
    form.append(field("Edit input as JSON (all schema fields)", mode));
    mode.addEventListener("change", () => {
      jsonMode = mode.checked;
      if (jsonMode) json.value = JSON.stringify(nativeControl.read(), null, 2);
      nativeBox.hidden = jsonMode; jsonField.hidden = !jsonMode;
    });
  }
  if (action.input !== undefined && action.input !== false) {
    jsonField.hidden = !jsonMode; form.append(jsonField);
  }
  const button = element("button", action.label); button.type = "submit";
  if (action.danger) button.className = "danger";
  const result = element("output"); result.setAttribute("aria-live", "polite");
  button.disabled = action.input === false || compileError !== "";
  if (action.input === false) result.textContent = "This action accepts no valid input and cannot be submitted.";
  if (compileError) result.textContent = compileError;
  form.append(button, result);
  let pending = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); if (pending || button.disabled) return;
    let value: unknown;
    try {
      if (action.input !== undefined) value = jsonMode ? JSON.parse(json.value) : nativeControl!.read();
      if (validate && !validate(value)) {
        result.textContent = `Invalid input: ${validators.errorsText(validate)}`; return;
      }
    } catch { result.textContent = "Invalid input: enter valid JSON."; return; }
    if (action.danger && !confirm(`Run “${action.label}” on ${id}?`)) return;
    let key: string;
    try { key = idempotencyKey(); }
    catch { result.textContent = "Unable to generate a secure submission key. Please try again."; return; }
    pending = true; button.disabled = true; result.textContent = "Submitting…";
    const input: ActInput = { kind, id, action: action.id, ...(action.input !== undefined ? { input: value as Json } : {}), idempotencyKey: key };
    try { result.textContent = JSON.stringify(await submit(input), null, 2); }
    catch { result.textContent = "Submission failed. Check the item before submitting again."; }
    finally { pending = false; button.disabled = false; }
  });
  return form;
}
