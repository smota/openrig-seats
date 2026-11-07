import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { READ_WINDOW_BYTES } from "./follow.js";

/** Read a discovered native transcript without following a final-component symlink. */
export async function readNativeSession(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new Error("native session must be a regular file");
    const start = Math.max(0, stat.size - READ_WINDOW_BYTES);
    const buffer = Buffer.alloc(Math.min(stat.size, READ_WINDOW_BYTES));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, start + length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    let first = 0;
    if (start > 0) {
      // A window beginning at a line boundary already contains a complete first line.
      const previous = Buffer.alloc(1);
      await handle.read(previous, 0, 1, start - 1);
      if (previous[0] !== 10) {
        const newline = buffer.subarray(0, length).indexOf(10);
        first = newline < 0 ? length : newline + 1;
      }
    }
    return buffer.subarray(first, length).toString("utf8");
  } finally {
    await handle.close();
  }
}
