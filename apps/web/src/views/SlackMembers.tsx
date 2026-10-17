// Who Jarvis's bot answers in your Slack, and how (D62): the switch that lets people talk to it at
// all, the one that lets its replies go out without your yes, everyone it knows with their tier,
// and the answers you've written down for it to share. Everyone starts at relay (Jarvis passes
// their message on to you); schedule (your free time and meeting requests) is yours to give, one
// person at a time. Guests, people from other orgs and deactivated users are never answered.

import { createSignal, For, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { orBack } from "../lib/orBack.ts";
import { act, useAction } from "../lib/query.ts";

type Tier = "blocked" | "relay" | "schedule";

interface Member {
  id: string;
  name: string;
  email: string | null;
  tier: Tier;
  replies: "auto" | "review";
  vip: boolean;
  notAMember: string | null;
  lastWrote: string | null;
}

interface Answer {
  id: string;
  title: string;
  body: string;
  users: string[] | null;
}

interface Candidate {
  id: string;
  name: string;
  email: string | null;
  guest: boolean;
}

const TIERS: { value: Tier; label: string }[] = [
  { value: "relay", label: "Pass messages on" },
  { value: "schedule", label: "Also share free time" },
  { value: "blocked", label: "Blocked" },
];

const NOT_A_MEMBER: Record<string, string> = {
  guest: "a guest: never answered",
  external: "in another org: never answered",
  deactivated: "deactivated",
  bot: "a bot",
};

const select = "rounded-md border border-line bg-panel px-2 py-1 text-sm";
const field = "min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1 text-sm";

/** The two switches: members at all, and replies without your yes. */
export function MemberSwitches(props: { membersOn: boolean; answersOnOwn: boolean }) {
  const set = (input: { membersOn?: boolean; answersOnOwn?: boolean }) =>
    act("slack.bot_settings", input);
  return (
    <div class="space-y-1">
      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          checked={props.membersOn}
          onChange={(e) =>
            void orBack(
              e.currentTarget,
              set({ membersOn: e.currentTarget.checked }),
              () => props.membersOn,
            )
          }
        />
        People in your workspace can talk to the Jarvis bot
      </label>
      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          checked={props.answersOnOwn}
          disabled={!props.membersOn}
          onChange={(e) =>
            void orBack(
              e.currentTarget,
              set({ answersOnOwn: e.currentTarget.checked }),
              () => props.answersOnOwn,
            )
          }
        />
        The Jarvis bot answers members on its own (in DMs; channels and anyone on review still wait
        for your yes)
      </label>
    </div>
  );
}

function MemberRow(props: { m: Member }) {
  const set = (patch: Partial<Pick<Member, "tier" | "replies" | "vip">>) =>
    act("slack.member_set", { user: props.m.id, ...patch });
  return (
    <li class="flex flex-wrap items-center gap-2 border-t border-line py-2">
      <div class="min-w-40 flex-1">
        <p class="font-medium">{props.m.name}</p>
        <p class="text-xs text-faint">
          {[props.m.email ?? "no email", props.m.id].join(" · ")}
          <Show when={props.m.lastWrote}>{(at) => ` · wrote ${ago(at())}`}</Show>
        </p>
        <Show when={props.m.notAMember}>
          {(why) => <p class="text-xs text-warn">{NOT_A_MEMBER[why()] ?? why()}</p>}
        </Show>
      </div>
      <select
        class={select}
        aria-label={`What the Jarvis bot does for ${props.m.name}`}
        value={props.m.tier}
        onChange={(e) =>
          void orBack(
            e.currentTarget,
            set({ tier: e.currentTarget.value as Tier }),
            () => props.m.tier,
          )
        }
      >
        <For each={TIERS}>{(t) => <option value={t.value}>{t.label}</option>}</For>
      </select>
      <select
        class={select}
        aria-label={`Replies to ${props.m.name}`}
        value={props.m.replies}
        onChange={(e) =>
          void orBack(
            e.currentTarget,
            set({ replies: e.currentTarget.value as Member["replies"] }),
            () => props.m.replies,
          )
        }
      >
        <option value="auto">Replies go out</option>
        <option value="review">Replies wait for you</option>
      </select>
      <label class="flex items-center gap-1 text-xs">
        <input
          type="checkbox"
          checked={props.m.vip}
          onChange={(e) =>
            void orBack(e.currentTarget, set({ vip: e.currentTarget.checked }), () => props.m.vip)
          }
        />
        VIP
      </label>
    </li>
  );
}

/** Finds someone in your workspace, to set them before they write. */
function AddMember() {
  const [q, setQ] = createSignal("");
  const [found, setFound] = createSignal<Candidate[]>([]);
  const search = async (e: Event) => {
    e.preventDefault();
    const r = await act<{ candidates: Candidate[] }>("slack.find_member", { query: q().trim() });
    if (r) setFound(r.candidates);
  };
  const add = async (c: Candidate) => {
    if (await act("slack.member_set", { user: c.id, tier: "schedule" })) {
      toast.show(`${c.name} can see your free time now.`);
      setFound([]);
      setQ("");
    }
  };
  return (
    <div class="space-y-1">
      <form class="flex gap-2" onSubmit={search}>
        <input
          class={field}
          placeholder="Find someone to share your free time with"
          aria-label="Find someone in Slack"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        <Button small submit disabled={!q().trim()}>
          Find
        </Button>
      </form>
      <ul>
        <For each={found()}>
          {(c) => (
            <li class="flex items-center gap-2 py-1">
              <span class="flex-1">
                {c.name} <span class="text-xs text-faint">{c.email ?? c.id}</span>
              </span>
              <Show when={!c.guest} fallback={<span class="text-xs text-faint">a guest</span>}>
                <Button small onClick={() => void add(c)}>
                  Share free time
                </Button>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

/** One shared answer, read or being changed. */
function AnswerForm(props: { answer?: Answer; onDone: () => void }) {
  const [title, setTitle] = createSignal(props.answer?.title ?? "");
  const [body, setBody] = createSignal(props.answer?.body ?? "");
  const [users, setUsers] = createSignal(props.answer?.users?.join(", ") ?? "");
  const save = async (e: Event) => {
    e.preventDefault();
    const ids = users()
      .split(/[\s,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    const r = await act("slack.answer_save", {
      ...(props.answer ? { id: props.answer.id } : {}),
      title: title().trim(),
      body: body().trim(),
      users: ids.length ? ids : null,
    });
    if (r) props.onDone();
  };
  return (
    <form class="space-y-1" onSubmit={save}>
      <input
        class={`${field} w-full`}
        placeholder="Title, like Office hours"
        aria-label="Answer title"
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
      />
      <textarea
        class={`${field} w-full`}
        rows={3}
        maxLength={4000}
        placeholder="What the Jarvis bot may tell people, word for word"
        aria-label="Answer text"
        value={body()}
        onInput={(e) => setBody(e.currentTarget.value)}
      />
      <input
        class={`${field} w-full`}
        placeholder="Only for these Slack ids (leave empty for everyone)"
        aria-label="Who it's for"
        value={users()}
        onInput={(e) => setUsers(e.currentTarget.value)}
      />
      <div class="flex gap-2">
        <Button small kind="primary" submit disabled={!body().trim()}>
          Save
        </Button>
        <Button small onClick={props.onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SharedAnswers() {
  const answers = useAction<Answer[]>("slack.answers");
  const [editing, setEditing] = createSignal<string | null>(null);
  const remove = async (a: Answer) => {
    if (confirm(`Stop sharing "${a.title || a.body.slice(0, 40)}"?`))
      await act("slack.answer_delete", { id: a.id });
  };
  return (
    <div class="space-y-2">
      <h4 class="font-medium">What the Jarvis bot may share</h4>
      <p class="text-xs text-muted">
        Office hours, your status, how to reach you. It shares nothing else, and only links you
        write here.
      </p>
      <ul class="space-y-2">
        <For each={answers.data ?? []}>
          {(a) => (
            <li class="rounded border border-line p-2">
              <Show
                when={editing() === a.id}
                fallback={
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <p class="font-medium">{a.title || "Untitled"}</p>
                      <p class="whitespace-pre-wrap text-muted">{a.body}</p>
                      <p class="text-xs text-faint">
                        {a.users ? `Only for ${a.users.join(", ")}` : "For everyone"}
                      </p>
                    </div>
                    <Button small onClick={() => setEditing(a.id)}>
                      Edit
                    </Button>
                    <Button small kind="danger" onClick={() => void remove(a)}>
                      Delete
                    </Button>
                  </div>
                }
              >
                <AnswerForm answer={a} onDone={() => setEditing(null)} />
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show
        when={editing() === "new"}
        fallback={
          <Button small onClick={() => setEditing("new")}>
            Add an answer
          </Button>
        }
      >
        <AnswerForm onDone={() => setEditing(null)} />
      </Show>
    </div>
  );
}

/** Everyone Jarvis knows in your Slack, and what it may share with them. */
export function SlackMembers() {
  const members = useAction<Member[]>("slack.members");
  return (
    <div class="space-y-3">
      <div class="space-y-1">
        <h4 class="font-medium">People</h4>
        <Show
          when={(members.data ?? []).length > 0}
          fallback={<p class="text-xs text-faint">Nobody has written to the Jarvis bot yet.</p>}
        >
          <ul>
            <For each={members.data}>{(m) => <MemberRow m={m} />}</For>
          </ul>
        </Show>
        <AddMember />
      </div>
      <SharedAnswers />
    </div>
  );
}
