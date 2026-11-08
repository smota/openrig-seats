import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ActInput, Action, Json } from "@openrig-seats/seat-protocol";
import { element, field, record, text } from "./dom.js";

const ajv = new Ajv2020({ strict: false, addUsedSchema: false, allErrors: true, validateFormats: true });
addFormats.default(ajv);
type Schema = boolean | Record<string, unknown>;
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
): HTMLFormElement {
  const form = element("form", undefined, "action-form");
  form.setAttribute("aria-label", action.label); form.noValidate = true;
  form.append(element("h4", action.label));
  let validate: ValidateFunction | undefined;
  let compileError = "";
  if (action.input !== undefined) {
    try { validate = ajv.compile(action.input); }
    catch { compileError = "This input schema cannot be resolved locally. Submission is unavailable."; }
  }
  const native = typeof action.input === "object" && nativeSchema(action.input);
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
        result.textContent = `Invalid input: ${ajv.errorsText(validate.errors, { separator: "; " })}`; return;
      }
    } catch { result.textContent = "Invalid input: enter valid JSON."; return; }
    if (action.danger && !confirm(`Run “${action.label}” on ${id}?`)) return;
    pending = true; button.disabled = true; result.textContent = "Submitting…";
    const input: ActInput = { kind, id, action: action.id, ...(action.input !== undefined ? { input: value as Json } : {}), idempotencyKey: crypto.randomUUID() };
    try { result.textContent = JSON.stringify(await submit(input), null, 2); }
    catch { result.textContent = "Submission failed. Check the item before submitting again."; }
    finally { pending = false; button.disabled = false; }
  });
  return form;
}
