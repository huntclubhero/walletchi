import type { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 does NOT forward a rejected async handler to the error middleware:
// the rejection becomes a process-level unhandledRejection (a crash by Node
// default). Every async route is wrapped with this so a thrown DB/RPC error
// lands in next(err) -> the JSON 500 error middleware in app.ts instead.
// NOTE: the wrap erases Express's route-literal param inference, so handlers
// read matched params as `req.params.x!` (guaranteed present on a matched
// route; same style as the pre-existing tokenId! reads).
export function wrap(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
