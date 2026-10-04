import { describe, expect, it } from "vitest";
import {
  fromEditForm,
  mentionContext,
  parseMentions,
  renderMention,
  stripMentions,
  toEditForm,
} from "./mentions.ts";

const TASK = "018f3a2b-0000-7000-8000-000000000abc";
const JARVIS = "00000000-0000-4000-8000-000000000002";

describe("mentions", () => {
  it("renders and parses a mention, escaping the label", () => {
    const tag = renderMention({ type: "task", id: TASK, label: "Fix <login> & co" });
    expect(tag).toBe(`<m-ref type="task" id="${TASK}">Fix &lt;login&gt; &amp; co</m-ref>`);
    const [m] = parseMentions(`See ${tag} today`);
    expect(m).toMatchObject({
      type: "task",
      id: TASK,
      label: "Fix <login> & co",
      occurrence: 0,
      index: 4,
    });
  });

  it("numbers repeated mentions of the same target", () => {
    const j = renderMention({ type: "agent", id: JARVIS, label: "Jarvis" });
    const t = renderMention({ type: "task", id: TASK, label: "T" });
    const ms = parseMentions(`${j} one ${t} two ${j}`);
    expect(ms.map((m) => `${m.type}#${m.occurrence}`)).toEqual(["agent#0", "task#0", "agent#1"]);
  });

  it("ignores malformed tags", () => {
    expect(parseMentions(`<m-ref type="task">x</m-ref> <m-ref id="${TASK}">y</m-ref>`)).toEqual([]);
  });

  it("ignores a tag whose id isn't a record's, so saving the text can't fail on it", () => {
    const bad = `<m-ref type="agent" id="jarvis">Jarvis</m-ref> <m-ref type="task" id="1; drop">x</m-ref>`;
    expect(parseMentions(bad)).toEqual([]);
  });

  it("strips tags to labels and finds the paragraph a mention sits in", () => {
    const j = renderMention({ type: "agent", id: JARVIS, label: "Jarvis" });
    const body = `Intro line.\n\n${j} can you draft the agenda?\nThanks\n\nOutro.`;
    expect(stripMentions(body)).toContain("@Jarvis can you draft");
    const [m] = parseMentions(body);
    expect(mentionContext(body, m!.index)).toBe("@Jarvis can you draft the agenda?\nThanks");
  });

  it("round-trips through the edit form", () => {
    const body = `Ask ${renderMention({ type: "task", id: TASK, label: "Fix ] bracket" })} now`;
    const edit = toEditForm(body);
    expect(edit).toBe(`Ask @[Fix \\] bracket](task:${TASK}) now`);
    expect(fromEditForm(edit)).toBe(body);
  });
});
