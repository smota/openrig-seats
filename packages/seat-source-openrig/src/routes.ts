/** Source and Core app routes. App answers are POST; the other routes here are GET. */
export const ROUTES = {
  appCapabilities: "/api/apps/v1/capabilities",
  appNeedsMe: (actor: string) => `/api/apps/v1/needs-me?actor=${encodeURIComponent(actor)}`,
  appResult: (requestId: string, actor: string) => `/api/apps/v1/requests/${encodeURIComponent(requestId)}/result?actor=${encodeURIComponent(actor)}`,
  appAnswer: (answerId: string) => `/api/apps/v1/answers/${encodeURIComponent(answerId)}`,
  appEvents: "/api/apps/v1/events",
  uiEnabled: "/api/config/ui.enabled",
  terminal: (session: string) => `/api/terminal/${encodeURIComponent(session)}`,
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
