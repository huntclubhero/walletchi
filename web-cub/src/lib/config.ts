// Central env access. The only thing the browser needs is the API base.
const raw = process.env.NEXT_PUBLIC_API_URL?.trim();

/** SALMON RUN / PUNCHCARD API base, no trailing slash. Defaults to the local server. */
export const API_URL = (raw && raw.replace(/\/$/, "")) || "http://localhost:8080";
