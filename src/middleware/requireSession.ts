import type { MiddlewareHandler } from "hono";
import { readSession } from "../modules/auth/auth.services";
import type { Session } from "../modules/auth/auth.types";

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
