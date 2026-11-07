import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

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
function rootPath(options: SessionDiscoveryOptions, relative: string): string {
  if (options.root) return options.root;
  if (options.home) return join(options.home, relative);
  throw new Error("session discovery requires an injected home or root");
}
/** Read directory entries only; symlinks and transcript contents are never followed. */
export async function discoverAgySessions(
  options: SessionDiscoveryOptions,
): Promise<string[]> {
  const result: string[] = [];
  for (const session of await directories(
    rootPath(options, ".gemini/antigravity-cli/brain"),
  )) {
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
  return result.sort();
}
export async function discoverPiSessions(
  options: SessionDiscoveryOptions,
): Promise<string[]> {
  const result: string[] = [];
  for (const project of await directories(
    rootPath(options, ".pi/agent/sessions"),
  )) {
    for (const entry of await readdir(project, { withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith(".jsonl"))
        result.push(join(project, entry.name));
  }
  return result.sort();
}
