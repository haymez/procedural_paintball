// Debug hooks shared by every tool page and read by scripts/shot.mjs. Pages
// shouldn't redeclare these (two differing declarations fail the typecheck);
// cast __debug to a page-local type where a precise shape helps.
export {};
declare global {
  interface Window {
    __ready?: boolean;
    __stats?: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __debug?: any;
  }
}
