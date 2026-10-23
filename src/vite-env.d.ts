/// <reference types="vite/client" />

// Test-only typing shim: the palette test reads src/styles.css from disk so it can
// assert the shipped tokens instead of a copy. Vitest runs in Node; the project does
// not depend on @types/node, so only the single API that is used is declared here.
declare module "node:fs/promises" {
  export function readFile(path: string, encoding: string): Promise<string>;
}
