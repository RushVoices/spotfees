// Vercel looks for /api at the project root; the real route lives in app/api.
export const config = { runtime: "edge" };
export { default } from "../app/api/rpc";
