/** Every daemon route this repository reads. Nothing outside this package names one. All are GET. */
export const ROUTES = {
  health: "/healthz",
  ps: "/api/ps",
  nodes: (rigId: string) => `/api/rigs/${encodeURIComponent(rigId)}/nodes`,
  attention: "/api/attention",
  /** The queue route has no paging: a full page means the set may be incomplete (see QUEUE_PAGE). */
  queueActive: "/api/queue/list?activeOnly=1&limit=500",
  queueProbe: "/api/queue/list?limit=1",
  /** `replay` is always sent: the daemon's log is unbounded and `replay` absent means "the whole log". */
  events: (replay: number) => `/api/events?replay=${replay}`,
} as const;

/** Rows requested from the queue route; an answer this long is treated as a partial page. */
export const QUEUE_PAGE = 500;
