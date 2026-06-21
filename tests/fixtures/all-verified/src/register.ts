// @impl VER-001
export function register(email: string): string {
  return `user_${email}`;
}
