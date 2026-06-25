// @impl AUTH-001 AUTH-002

export function createSession(email: string): string {
  return `session_${email}_${Date.now()}`;
}

export function refreshSession(token: string): string {
  return `refreshed_${token}`;
}
