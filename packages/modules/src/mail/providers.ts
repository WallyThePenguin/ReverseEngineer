// Which adapter talks to an account's mail service (D15).
import type { ActionContext } from "@hearth/kernel";
import { GOOGLE_SERVICE, type GoogleClient } from "../google/client.ts";
import { GmailProvider } from "../google/gmail-api.ts";
import type { MailProvider } from "./provider.ts";
import type { AccountRow } from "./store.ts";

export function providerFor(ctx: ActionContext, account: AccountRow): MailProvider {
  if (account.provider === "gmail")
    return new GmailProvider(ctx.service<GoogleClient>(GOOGLE_SERVICE), ctx.tx);
  throw new Error(`No mail provider called ${account.provider}`);
}
