// @impl AUTH-001
import { db } from "./db.js";

export function login(): void {
  db.connect();
}
