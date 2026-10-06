// One filter for every post Jarvis makes in Slack (D62), applied by the outbox's sender, so an
// answer to a member, a reply you approved and your own "tell Sam" all come out the same way.
// Whatever the text says, it can't ping a channel, @name someone, make a link that says one thing
// and goes to another, or unfurl a page:
// 1. Hearth's own <m-ref> tags become their labels.
// 2. In a member turn's answer, a link you didn't write word for word in a shared answer is taken
//    out: Jarvis can't be talked into handing a member someone else's address.
// 3. Markdown becomes Slack's mrkdwn, without making links: [label](url) is "label (url)".
// 4. It's cut at 3,000 characters.
// 5. & < > are escaped, so <!channel>, <@U…> and <url|label> can't be made from any text.
// 6. It's posted with no parsing, no @names and no previews (POST_FLAGS).
import { unescapeText } from "@hearth/core";

/** How a post is sent: Slack reads nothing in it as a name, a channel or a page to preview. */
export const POST_FLAGS = {
  parse: "none",
  link_names: "false",
  unfurl_links: "false",
  unfurl_media: "false",
} as const;

/** The most a post says (D62). What you send is held to it too, so the card shows all of it. */
export const POST_MAX = 3000;

export interface FilterOptions {
  /**
   * A member turn's answer: only the links in here, the ones written in your shared answers, stay
   * (D62). Unset for your own sends and fixed notes, whose words are yours.
   */
  sharedLinks?: ReadonlySet<string>;
}

/** Text as it goes to Slack. */
export function slackText(text: string, opts: FilterOptions = {}): string {
  let t = withoutRefs(text);
  if (opts.sharedLinks) t = onlyShared(t, opts.sharedLinks);
  return escapeSlack(cut(toMrkdwn(t), POST_MAX));
}

const REF = /<m-ref\b[^>]*>([\s\S]*?)<\/m-ref>/gi;

/** Hearth's link tags as their labels; a stray piece of one goes. */
export function withoutRefs(text: string): string {
  return text
    .replace(REF, (_all, label: string) => unescapeText(label))
    .replace(/<\/?m-ref\b[^>]*>?/gi, "");
}

/** Escapes what Slack reads as markup: after this, no text makes a mention or a link. */
export const escapeSlack = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** At most `max` characters (not UTF-16 halves), with an ellipsis when cut. */
export function cut(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

// A link Slack would make on its own: an email address, an address with its scheme or www, or a
// bare domain with a common ending ("evil.example.com/login" is linked too).
const TLDS =
  "com|net|org|io|co|ai|app|dev|me|us|uk|ca|de|fr|eu|info|biz|xyz|link|ly|gl|gg|so|to|tv|sh|site|online|page|cloud|tech|edu|gov";
const LINK = new RegExp(
  [
    String.raw`[\w.+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,24}`,
    String.raw`(?:https?:\/\/|www\.)[^\s<>()\[\]{}"'|]+`,
    String.raw`\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${TLDS})\b(?:\/[^\s<>()\[\]{}"'|]*)?`,
  ].join("|"),
  "gi",
);
/** What ends a sentence, not an address. */
const TRAILING = /[.,;:!?'"]+$/;

/** Every link in some text, as written. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(LINK)].map((m) => m[0].replace(TRAILING, ""));
}

/** The text with only the links in `shared`. */
function onlyShared(text: string, shared: ReadonlySet<string>): string {
  const keep = (link: string) => shared.has(link);
  return (
    text
      // [label](url): the label stays either way.
      .replace(/!?\[([^\]\n]*)\]\(([^)\s]+)\)/g, (all, label: string, url: string) =>
        keep(url) ? all : label,
      )
      .replace(LINK, (found: string) => {
        const link = found.replace(TRAILING, "");
        return keep(link) ? found : found.slice(link.length);
      })
      .replace(/[ \t]{2,}/g, " ")
  );
}

/** Markdown as Slack's mrkdwn, line by line, leaving code alone and making no links. */
export function toMrkdwn(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) return `*${inline(heading[1] ?? "")}*`;
      return inline(line.replace(/^(\s*)[-*+]\s+/, "$1• "));
    })
    .join("\n");
}

/** One line's emphasis and links, outside `code`. */
function inline(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return part;
      return (
        part
          .replace(/!?\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_all, label: string, url: string) =>
            label && label !== url ? `${label} (${url})` : url,
          )
          // Bold first, held aside so the italics below don't take it.
          .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "\u0001$2\u0001")
          .replace(/(?<![*\w])\*(?=\S)([^*]+?)(?<=\S)\*(?![*\w])/g, "_$1_")
          .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "~$1~")
          .replaceAll("\u0001", "*")
      );
    })
    .join("");
}
