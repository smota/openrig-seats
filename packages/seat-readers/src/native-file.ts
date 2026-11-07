import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Read a discovered native transcript without following a final-component symlink. */
export async function readNativeSession(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("native session must be a regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
