import { describe, expect, it } from "vitest";
import {
  fromEditForm,
  mentionAnchor,
  mentionContext,
  newMentionId,
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

  it("anchors a mention by its own id, wherever it moves, and the rest by occurrence", () => {
    const old = renderMention({ type: "agent", id: JARVIS, label: "Jarvis" });
    const asked = renderMention({ type: "agent", id: JARVIS, label: "Jarvis", mid: "q1" });
    expect(asked).toBe(`<m-ref type="agent" id="${JARVIS}" data-mid="q1">Jarvis</m-ref>`);
    const before = parseMentions(`${old} first\n\n${asked} second`).map(mentionAnchor);
    // A new question written above both: the old ones keep their anchors.
    const fresh = renderMention({ type: "agent", id: JARVIS, label: "Jarvis", mid: "q2" });
    const after = parseMentions(`${fresh} new\n\n${old} first\n\n${asked} second`).map(
      mentionAnchor,
    );
    expect(before).toEqual(["#0", "mid:q1"]);
    expect(after).toEqual(["mid:q2", "#0", "mid:q1"]);
    // A pasted copy shares the original's anchor; an id that isn't one is ignored.
    expect(parseMentions(`${asked} ${asked}`).map(mentionAnchor)).toEqual(["mid:q1", "mid:q1"]);
    const odd = `<m-ref type="agent" id="${JARVIS}" data-mid="a b">J</m-ref>`;
    expect(parseMentions(odd).map(mentionAnchor)).toEqual(["#0"]);
    expect(newMentionId()).toMatch(/^[0-9a-f]{12}$/);
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
