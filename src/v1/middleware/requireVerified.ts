import type { MiddlewareHandler } from "hono";
import type { AuthContext } from "./requireSession";
import { freshEmailVerified } from "../firebase";

export const requireVerified: MiddlewareHandler<AuthContext> = async (c, next) => {
  const session = c.get("session");
  if (!session) {
    return c.json({ ok: false, code: "unauthenticated" }, 401);
  }

  const isVerified = session.emailVerified || (await freshEmailVerified(session.uid));
  if (!isVerified) {
    return c.json({ ok: false, code: "unverified", message: "Email verification required" }, 403);
  }

  await next();
};
