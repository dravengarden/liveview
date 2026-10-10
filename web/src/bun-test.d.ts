// The web tests run on Bun's test runner, but the app must type-check against
// browser globals alone: Bun's own type package widens globals such as
// `fetch`. Declare only the runner surface the tests use.
declare module "bun:test" {
  export function test(name: string, body: () => void | Promise<void>): void;
}
