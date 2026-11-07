import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SessionDiscoveryOptions {
  /** Explicit home directory; never defaults to the process user's home. */
  home?: string;
  /** Overrides home: Antigravity brain directory or Pi sessions directory. */
  root?: string;
}
async function directories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
function isInside(base: string, path: string): boolean {
  const offset = relative(base, path);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}
async function discoveryRoot(
  options: SessionDiscoveryOptions,
  suffix: string,
): Promise<{ root: string; base: string } | undefined> {
  const injected = options.root || options.home;
  if (!injected)
    throw new Error("session discovery requires an injected home or root");
  const base = resolve(injected);
  const root = options.root || join(injected, suffix);
  try {
    let component = base;
    for (const part of relative(base, root).split(sep).filter(Boolean)) {
      component = join(component, part);
      // Dirent checks below cannot detect symlinks in the discovery root's path.
      if (!(await lstat(component)).isDirectory()) return undefined;
    }
    const realBase = await realpath(base);
    if (!isInside(realBase, await realpath(root))) return undefined;
    return { root, base: realBase };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function containedSessions(files: string[], base: string): Promise<string[]> {
  const result: string[] = [];
  for (const file of files) {
    try {
      if (isInside(base, await realpath(file))) result.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result.sort();
}
/** Discover native files within the injected base, without reading transcript contents. */
export async function discoverAgySessions(
  options: SessionDiscoveryOptions,
): Promise<string[]> {
  const boundary = await discoveryRoot(options, ".gemini/antigravity-cli/brain");
  if (!boundary) return [];
  const result: string[] = [];
  for (const session of await directories(boundary.root)) {
    const logs = join(session, ".system_generated/logs");
    try {
      if (
        !(await lstat(join(session, ".system_generated"))).isDirectory() ||
        !(await lstat(logs)).isDirectory()
      )
        continue;
      if (
        (await readdir(logs, { withFileTypes: true })).some(
          (e) => e.isFile() && e.name === "transcript.jsonl",
        )
      )
        result.push(join(logs, "transcript.jsonl"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return containedSessions(result, boundary.base);
}
export async function discoverPiSessions(
  options: SessionDiscoveryOptions,
): Promise<string[]> {
  const boundary = await discoveryRoot(options, ".pi/agent/sessions");
  if (!boundary) return [];
  const result: string[] = [];
  for (const project of await directories(boundary.root)) {
    for (const entry of await readdir(project, { withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith(".jsonl"))
        result.push(join(project, entry.name));
  }
  return containedSessions(result, boundary.base);
}
