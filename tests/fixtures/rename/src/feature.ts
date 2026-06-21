// @impl REQ-001
export function authenticate(email: string, password: string): boolean {
  return email.length > 0 && password.length > 0;
}

// @impl REQ-001 REQ-002
export function registerAndLogin(email: string, password: string): string {
  return `session_${email}`;
}

// This relates to REQ-001 but is not an impl tag
export function helperUtil(): void {
  // no-op
}
