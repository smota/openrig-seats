import type { Hono } from "hono";
import type { Store } from "../../packages/seat-gateway/src/store.js";

export const DEMO_BEARER: string;
export function createFixtureExample(options?: { rootDir?: string }): {
  app: Hono;
  store: Store;
  handle: (request: Request) => Promise<Response>;
};
export function startExample(options?: { gatewayPort?: number | string; uiPort?: number | string }): Promise<{
  gatewayUrl: string;
  uiUrl: string;
  stop: () => Promise<void>;
}>;
