import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { config } from "../config.js";

/**
 * Shared bearer gate for every /internal route (status, announce, pass refresh, gift mint).
 * No INTERNAL_STATUS_TOKEN in the environment => 404 (feature off), so none of the ops
 * routes are discoverable in a demo deployment; a wrong token => 401. Constant-time compare,
 * parity with the HMAC/cap paths. Returns false after writing the refusal.
 */
export function authInternal(req: Request, res: Response): boolean {
  const expected = config.INTERNAL_STATUS_TOKEN;
  if (!expected) {
    res.status(404).end();
    return false;
  }
  const got = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";
  let ok = got.length === expected.length;
  try {
    ok = ok && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    ok = false;
  }
  if (!ok) {
    res.status(401).end();
    return false;
  }
  return true;
}
