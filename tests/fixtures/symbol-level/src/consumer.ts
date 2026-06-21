import { foo, bar as myBar } from "./utils";
import defaultFn from "./defaults";

export function useFoo() {
  return foo();
}

export function useBar() {
  return myBar();
}

export function useDefault() {
  return defaultFn();
}
