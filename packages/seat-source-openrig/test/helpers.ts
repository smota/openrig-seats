export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 4000, what = "condition"): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
