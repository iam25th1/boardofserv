// Stands in for the "server-only" package when tests run in Node. The real
// package throws if bundled for the browser; in a Node test there is no browser
// to protect, so this is intentionally empty.
export {};
