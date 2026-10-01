// A software passkey for tests: makes real WebAuthn registration and login responses.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private counter = 0;
  readonly origin: string;

  constructor(origin: string) {
    this.origin = origin;
  }

  private authData(flags: number, extra: Uint8Array = new Uint8Array()) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([
      sha256(new URL(this.origin).hostname),
      Buffer.from([flags]),
      counter,
      extra,
    ]);
  }

  register(options: { challenge: string }) {
    const clientData = JSON.stringify({
      type: "webauthn.create",
      challenge: options.challenge,
      origin: this.origin,
    });
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const coseKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLen, this.credentialId, coseKey]);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ["fmt", "none"],
        ["attStmt", new Map<string, string>()],
        ["authData", this.authData(0x45, attested)],
      ]),
    );
    return {
      id: b64(this.credentialId),
      rawId: b64(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64(clientData),
        attestationObject: b64(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  login(options: { challenge: string }) {
    this.counter += 1;
    const clientData = JSON.stringify({
      type: "webauthn.get",
      challenge: options.challenge,
      origin: this.origin,
    });
    const authenticatorData = this.authData(0x05);
    const signature = sign(
      "sha256",
      Buffer.concat([authenticatorData, sha256(clientData)]),
      this.keys.privateKey,
    );
    return {
      id: b64(this.credentialId),
      rawId: b64(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authenticatorData),
        signature: b64(signature),
      },
      clientExtensionResults: {},
    };
  }
}
