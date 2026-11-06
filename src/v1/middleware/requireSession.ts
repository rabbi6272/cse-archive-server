import type { MiddlewareHandler } from "hono";
import { readSession, type Session } from "../session";

export type AuthContext = {
  Variables: {
    session: Session;
  };
};

export const requireSession: MiddlewareHandler<AuthContext> = async (c, next) => {
  const session = await readSession(c);
  if (!session) {
    return c.json({ ok: false, code: "unauthenticated" }, 401);
  }
  c.set("session", session);
  await next();
};
