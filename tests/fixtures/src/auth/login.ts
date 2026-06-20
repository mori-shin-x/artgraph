// @impl AUTH-001
import { createSession } from "./session.js";

export interface LoginRequest {
  email: string;
  password: string;
}

export async function login(req: LoginRequest): Promise<string> {
  if (!req.email || !req.password) {
    throw new Error("Invalid credentials");
  }
  return createSession(req.email);
}
