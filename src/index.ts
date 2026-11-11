import { app } from "./app";
import { env } from "./config/env";

export { app };

export default {
  port: Number(env.PORT) || 3005,
  fetch: app.fetch,
};
