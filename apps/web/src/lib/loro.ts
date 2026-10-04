// Loro for production builds, which point "loro-crdt" here (vite.config.ts). Its default browser
// build downloads and compiles its 3 MB of WebAssembly synchronously as soon as it's imported,
// freezing the page. This one fetches and compiles it in the background, and only once the doc
// editor (the one thing that uses Loro) is first opened.
import * as web from "loro-crdt/web";

// The web build's default export starts it; its type declarations leave that out.
await (web as unknown as { default: () => Promise<unknown> }).default();

export * from "loro-crdt/web";
