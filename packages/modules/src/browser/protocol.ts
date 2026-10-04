// What the server expects of the Hearth extension (D52). The extension keeps its own copies, in
// apps/extension/rules.js and its manifest's key; protocol.test.ts checks they agree.

/** The link's protocol version. An extension that speaks an older one is told to reload. */
export const BRIDGE_PROTOCOL = 2;

/** The extension's ID, fixed by the public key in its manifest wherever its folder is. */
export const EXTENSION_ID = "jcpelnnklghgcdhcmdbmpflehbehpkhh";
