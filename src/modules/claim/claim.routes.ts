import { Hono } from "hono";
import { requireSession, type AuthContext } from "../../middleware/requireSession";
import {
  claimStartController,
  claimOpenController,
  claimCompleteController,
  claimCountController,
} from "./claim.controllers";

export const claimRoutes = new Hono<AuthContext>();

claimRoutes.post("/start", claimStartController);
claimRoutes.post("/open", claimOpenController);
claimRoutes.post("/complete", requireSession, claimCompleteController);
claimRoutes.get("/count", claimCountController);
claimRoutes.get("/unclaimed-count", claimCountController); // Alias
