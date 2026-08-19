// Public contract path for /btw history: dialog-btw.tsx resolves this module via a
// non-literal dynamic import, and the submit interceptor imports read() from here.
// The implementation lives in the sibling .impl module so a test-file mock of this
// path (dialog-btw.test.tsx) cannot poison internal consumers in the same process.
export { append, read, __setStateDir } from "./btw-history.impl"
export type { BtwEntry } from "./btw-history.impl"
