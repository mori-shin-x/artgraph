// @impl REQ-7f3a REQ-a1b2

export function createSession(email: string): string {
  return `session_${email}_${Date.now()}`;
}

export function refreshSession(token: string): string {
  return `refreshed_${token}`;
}
