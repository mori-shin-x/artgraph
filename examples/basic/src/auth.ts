// @impl REQ-001
export function signIn(email: string, password: string): boolean {
  return email.length > 0 && password.length > 0;
}
