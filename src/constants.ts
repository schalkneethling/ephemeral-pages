export const NETLIFY_EDGE_RATE_LIMIT_WINDOW_SECONDS = 60;
export const NETLIFY_EDGE_RATE_LIMIT_REQUESTS = 120;

export const NETLIFY_EDGE_RATE_LIMIT: {
  aggregateBy: string[];
  windowSize: number;
  windowLimit: number;
} = {
  aggregateBy: ["ip", "domain"],
  windowSize: NETLIFY_EDGE_RATE_LIMIT_WINDOW_SECONDS,
  windowLimit: NETLIFY_EDGE_RATE_LIMIT_REQUESTS,
};
