import { Hono } from "hono";
import {
  signInController,
  signUpController,
  signOutController,
  forgotPasswordController,
  sessionCheckController,
  configController,
  googleStartController,
  googleExchangeController,
} from "./auth.controllers";

export const authRoutes = new Hono();

// Password & registration
authRoutes.post("/signin", signInController);
authRoutes.post("/login", signInController); // Backward compatibility
authRoutes.post("/signup", signUpController);
authRoutes.post("/signout", signOutController);
authRoutes.post("/forgot", forgotPasswordController);

// Session checks (Server-to-server & client)
authRoutes.post("/session", sessionCheckController);

// Google OAuth
authRoutes.get("/config", configController);
authRoutes.get("/google/start", googleStartController);
authRoutes.post("/google/start", googleStartController);
authRoutes.post("/google/exchange", googleExchangeController);
