import { foo } from "./utils";
import defaultFn from "./defaults";

export function useFoo() {
  return foo();
}

export function useDefault() {
  return defaultFn();
}
