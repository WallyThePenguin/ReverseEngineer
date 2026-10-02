# Research: Polar (polarbrowser.com)

Sources, all read on 2026-10-02: Polar's website (home, pricing, templates, download page,
privacy policy, terms), its four blog posts, the website's public JavaScript, the public release
endpoints and the macOS update feed, and the Instagram reel you sent. Press and company details
come from a web search, with links at the end. The installer was not downloaded, installed or
run, and no Polar account was created.

**Verdict: copy the ideas, not the code, and use open tools to build them.** Polar is closed
source, and its terms forbid reverse engineering, decompiling, probing the service, and using it
to build a competing AI product (Terms §1.4). So there is nothing to lift. What is worth taking is
the shape of its agent: one orchestrator with parallel subagents, small fast models for the
individual clicks, a shared scratch space per run, per-site memory, and saved prompts on a
schedule. Polar has published all of that itself. Jarvis can do the same inside Hearth's
existing policy, with an open-source engine driving a dedicated Chrome profile on your PC.

## At a glance

| | |
|---|---|
| What | "The AI browser that actually does work for you": a Chromium-based browser with an agent that clicks, types and navigates logged in as you, for minutes or hours |
| Maker | Recursive Intelligence, Inc., 629 Market St, San Francisco. Three founders. $5.7M seed led by Madrona. |
| Lineage | **Composer** (alpha, 2026-01-26), an agent app on Electron; then **Polar** (2026-05-18), a Chromium fork, macOS only at first; then a Windows beta |
| Version | 0.1.97, built 2026-10-01 |
| Platforms | Windows beta (`PolarSetup.exe`, 229 MB, per-user install with no admin rights). From Windows the site shows only that build, but Apple-silicon (198 MB) and Intel (216 MB) Mac builds of the same version are on the release server, and the Mac version came first. |
| License | Proprietary. Terms §1.4 forbid reverse engineering, derivative works and building a competitor with it. |
| Models | Model-agnostic, mixing several frontier models plus smaller ones for quick steps. Providers aren't named. They say providers keep no data and don't train on it. |
| Price | Credits per agent run. Free: 3,000 to start plus 100 a day (up to 1,000). Pro $20 a month (10k credits), Pro+ $60 (36k), Max $200 (160k); annual billing saves 17%. Teams: $50 or $100 per seat with pooled credits. |
| Security claims | You can watch and take over at any time, and "guardrails" stop it taking high-risk actions on its own. SOC 2 is in progress. Nothing published on prompt-injection defenses. |

## Where the Instagram post fits

The post ([instagram.com/p/Dcy8Druggzc](https://www.instagram.com/p/Dcy8Druggzc/)) is a video reel
by **kayvon.ai**, an AI creator account with about 484K followers, posted 2026-09-02 (129 likes
when read). Its caption is Polar's homepage tagline and sub-headline, word for word. It's creator
marketing for Polar, not a separate tool. Polar's website runs Meta, TikTok and LinkedIn ad pixels,
which fits a paid creator push. We couldn't tell whether the post carries a "Paid partnership"
label, and no other sponsored creator posts were found. The video's audio wasn't transcribed, so
the note relies on the caption.

## How Polar works

Everything here is Polar's own description (blog posts, privacy policy, templates page). None of it
is independently verified.

### From Electron app to Chromium fork

Composer launched in January 2026 as an agent on Electron that didn't use a real browser. In May,
the team said this made several things very hard: keeping logins alive, handling complex UIs,
supporting extensions, and building a live memory of your work. Their fix was a fork of Chromium.
They say three people with no browser experience did the fork using coding agents, and that a team
of agents built the Windows version in a little over a week.

What we could confirm from outside agrees. The Mac app updates through a
[Sparkle](https://sparkle-project.org) appcast (EdDSA-signed, minimum macOS 14), as Chromium
browsers like Arc and Dia do. There's no Electron-style update feed (`latest.yml`), and the
installers are browser-sized.

### The agent

- **Orchestrator plus parallel subagents.** One agent plans and delegates. Because a browser session
  can be copied across many windows, subagents work in parallel on research and prospecting. They
  report runs of 10,000+ model calls across hundreds of subagents lasting over 10 hours, and one task
  over 15 hours.
- **Small models for the clicks.** Simple synchronous steps, like working through a menu or filling a
  form, go to smaller, faster models. That keeps the orchestrator's context for the plan.
- **A shared virtual filesystem in the cloud.** Each run gets a scratch space for tracking the task,
  running scripts and keeping memory. All subagents share it, so it also coordinates them and stops
  duplicate work. The privacy policy calls this the "cloud sandbox".
- **Purpose-built tools for hard UIs:** spreadsheets, maps, docs and social media.
- **Memory:** memory files, a generated profile summary (top domains, recent pages, which sites
  you're logged into) and **per-site preference files**.
- **Tab grants.** The agent works on tabs you give it (the privacy policy lists "granted tab
  information"). You can hand a tab to an agent and take it back mid-run.
- **Connectors.** Besides the browser, Polar connects to Google (Gmail, Drive, Calendar, Docs and
  Sheets) through OAuth, and to Slack.

### Where it runs, and what leaves your machine

The agent drives the browser **on your own device**. Their reason applies to Jarvis too:
2FA, SSO and passkeys are tied to a device more and more, and many sites block data-center IPs, so
long tasks need the real machine. Cloud agents are on their list for later.

Model calls, the sandbox, memory and run history are in Polar's cloud. Per the privacy policy, it
sends page context and screenshots, the tabs you grant, tool calls and results, token and cost data,
and profile summaries. History, cookies, bookmarks and saved passwords stay on the device. Run data
and screenshots are kept "for the periods needed". There's no self-serve account deletion; you
email them.

### Workflows and templates

A workflow is a saved prompt that can run on a schedule (hourly, daily, weekly or custom) and
carries the same context into every run. The gallery has 260+ templates across ops, research,
sales, data, marketing, personal, career, docs, engineering, monitoring and recruiting. The ones
that overlap with Jarvis's mandate:

| Polar template | Schedule | Hearth equivalent |
|---|---|---|
| Morning briefing from Slack, calendar and inbox | Daily 7 a.m. | Jarvis's brief (8:15 a.m.) |
| Brief me on everyone I'm meeting today | Weekdays 7 a.m. | M5 prep packets |
| Triage and label my Gmail inbox | Daily 7 a.m. | M2 email triage |
| Draft replies to emails waiting on me | Weekdays 5 p.m. | M2, drafts await your yes |
| Follow up on sent emails with no reply | Weekdays 8 a.m. | A reflex on sent mail |
| Watch any page and tell me when it changes | Daily 8 a.m. | A `watch` record that needs a browser |
| Find recurring charges I should cancel | On demand | Needs your bank, which stays out of scope |
| Find the best price for this exact item | On demand | Needs a browser |

### Benchmarks

The homepage shows Polar at 98.0, ahead of Aside (75.5), Browser Use (70.0), GPT-5.4 (60.8) and
Claude Opus 4.6 (44.5), on the "Odysseys" and "BU Bench V1" benchmarks. Back in January, Composer
claimed #1 on Online-Mind2Web, WebVoyager (human-graded) and the hard subset of WebArena-Verified,
plus a head-to-head on 30 in-house long tasks. Polar's own post admits these benchmarks don't
reflect real knowledge work.

**Nobody outside Polar has checked these numbers, and the chart mixes sources.**
- **Odysseys** is a Carnegie Mellon benchmark (Jang, Koh, Fried, Salakhutdinov; arXiv 2604.24964,
  2026-04-27). It has 200 long tasks across several live websites. Each task is graded against an
  average of 6.1 rubric items by an LLM judge that sees every screenshot. A task counts only if
  every item passes. Hard tasks make up 109 of the 200.
- **The comparison bars don't come from one run.** Claude Opus 4.6's 44.5 is the paper's own result
  for the bare model (97.8% on easy tasks, 11.0% on hard ones). The paper scores GPT-5.4 at
  **33.5, not the 60.8 on Polar's chart**. Aside's 75.5 is Aside's own self-reported run, and no
  source was found for Browser Use's 70.0. So Polar's full product, with its own harness, is being
  compared with bare models and with other vendors' self-reported scores.
- **BU Bench V1** comes from Browser Use, a competitor: 100 tasks judged pass or fail by
  gemini-2.5-flash. Browser Use was criticized for ranking its own product first on its own
  benchmark.
- **Polar's evidence** is the repo `recursive-hq/polar-evals`: one commit (2026-07-03), no stars,
  graded by Polar itself. It reports Odysseys 196/200 (98.0%) and BU Bench V1 95/100, with scores
  and judge reasoning as JSON. As far as we found, it isn't on the Odysseys public leaderboard.

What this tells us for Jarvis: Odysseys is a good public yardstick for long browser tasks. Even a
frontier model on its own passes only about one hard task in nine, so the harness matters more
than the model. That's why Polar's design is worth studying, even though its numbers aren't
proven.

## The company

Recursive Intelligence, Inc. has three founders: Kevin Jiang (CEO, who worked on Perplexity's
Comet browser), Vishaal Ram and Howard Zhong. Polar says the team comes from MIT, Jane Street,
Citadel, Apple, Perplexity and Modal, but press only confirms MIT, Perplexity and "quantitative
funds", and no source ties any company to a specific founder. No evidence was found of a YC batch.

The $5.7M seed led by Madrona was announced on 2026-07-29, the day Polar launched publicly. Angels
include Thomas Dohmke (former GitHub CEO) and Erik Bernhardsson (Modal). The launch was covered by
TechCrunch, TechRepublic, Digital Trends and Clubic. TechRepublic told IT teams to test Polar's
prompt-injection defenses themselves. No security incidents were found. The closest competitor is
**Aside** (YC F25), also a three-person San Francisco team building a Chromium fork, which also
self-reports Odysseys and BU Bench scores. Polar's earlier posts also compare it with Comet, ChatGPT
Atlas, Claude for Chrome and Manus.

## What we could see of their stack

These come only from public pages, the website's own JavaScript, and response headers on the
download links.

| Part | What it is |
|---|---|
| Website | Next.js (Turbopack build) on Vercel |
| API | `api.polarbrowser.com` behind Cloudflare. Its errors use FastAPI's `{"detail": ...}` shape, so it's probably Python. The API docs aren't public. |
| Login | Auth0 on its own domain `auth.polar.so`, with MFA. The API's token audience is still `https://trycomposer.ai`, the old Composer domain, which now redirects to polarbrowser.com. |
| Billing | Stripe |
| Releases | `api.polarbrowser.com/api/v1/releases/download/latest/<file>` redirects to versioned files on CloudFront (S3), for example `releases/v0.1.97/PolarSetup.exe` |
| Updates | Mac: a Sparkle appcast at `releases/v<version>/appcast.xml`. Windows: not found. |
| Tracking on the website | PostHog (with session recording), Google Analytics 4 and Tag Manager, Meta Pixel with Conversions API, TikTok and LinkedIn pixels, Sentry |

## Open-source engines to build it on

You pointed at Browser Use ([openalternative.co/browser-use](https://openalternative.co/browser-use)).
It's the strongest open project in this space, and it's one of the systems Polar benchmarks itself
against. Facts as of 2026-10-02:

| | Browser Use | Playwright MCP | Stagehand |
|---|---|---|---|
| Repo | `browser-use/browser-use` | `microsoft/playwright-mcp` | `browserbase/stagehand` |
| Language, license | Python, MIT | TypeScript, Apache-2.0 | TypeScript, MIT |
| Stars, latest | ~117k, 0.13.10 (2026-09-04) | ~38k, v0.0.83 (2026-09-28) | ~26k, 3.7.3 (2026-08-28) |
| What it is | A full agent loop: give it a goal and it plans and acts. Parallel agents, vision plus DOM, saved sessions, any LLM. | Browser tools for an agent you already have: snapshot, click, type, navigate. Can attach to a tab in your real browser through an extension. | An SDK with `act`, `extract` and `observe` calls, mixing written code with AI steps |
| How it drives Chrome | Directly over the DevTools protocol (`cdp-use`). Playwright is no longer a dependency, so openalternative's "playwright" tag is out of date. | Playwright | Playwright or CDP |
| Fits Hearth's stack | Needs a Python sidecar. It ships an MCP server (`browser_use/mcp/server.py`). | Native TypeScript, same as Hearth's existing Playwright tests | Native TypeScript |
| Watch for | PostHog telemetry is on by default (set `ANONYMIZED_TELEMETRY=false`). It bundles a TOTP library, which would let an agent fill 2FA codes; Jarvis must not. It has its own model loop, which would bypass Jarvis's budget unless pointed at the Max plan. | Low level, so Jarvis does the planning, and every step costs a turn | Built around Browserbase's cloud browsers, though local mode works |

**Recommendation: start with Playwright MCP's tools, wrapped as Hearth actions, on a dedicated Chrome
profile.** It's TypeScript, it leaves planning to Jarvis (one brain, one budget, one policy), and its
extension mode later gives a "do this in my own tab" option. Keep Browser Use in reserve for big
parallel research runs, where its agent loop and parallel sessions match what Polar does. It would
run as a sidecar process that Jarvis calls through one coarse action ("run this research job").

## What this means for Hearth

### The trap to avoid

Jarvis's Claude brain marks a turn untrusted only when the model calls `WebSearch` or `WebFetch`
(`WEB_TOOLS` in `packages/jarvis/src/brains/claude.ts`). If a browser MCP server were added straight
to the agent's `mcpServers`, page content would reach Jarvis without lowering the turn's trust. Its
clicks would also bypass `decide()` in `packages/kernel/src/policy.ts`. That's a side door, which
`tools.ts` exists to prevent. So the browser must be a Hearth module whose actions go through the
registry like everything else, and every read from a page must lower the turn's origin to
`untrusted`.

### What to take from Polar, and what to change

| Polar does | Hearth should | Why |
|---|---|---|
| Runs the agent on your device, logged in as you | Same, on the always-on PC, but in a **separate Chrome profile** that only holds the sites you sign it into | Polar wants to be your main browser for context. With your bank and main email signed in there, one successful prompt injection is too costly. |
| Watch it work and take over any time | Stream the run's steps and screenshots to the Jarvis pane, with Stop | Same idea, and it fits the event log |
| "Guardrails" against high-risk actions (unspecified) | Every step gets a risk class: reading and navigating are `read`; submit, send, post and buy are `outward` and wait for your yes, with a screenshot; credentials are `secret` and always denied | Hearth's policy already does this. Polar hasn't published how its guardrails work. |
| Per-site preference files | `memory_note` records scoped to a domain ("on LinkedIn, never send a connection note") | Same benefit, but versioned and visible in the graph |
| A shared cloud filesystem per run | A run record in the graph with notes and files attached, which subagents read and write | Coordination without sending anything to a third party |
| Small models for the clicks | Use the fast lane for single steps, and the deep lane to plan | Max-plan rate limits make this matter even more than credits do for Polar |
| Hundreds of parallel subagents | Cap parallelism at a few, under the daily turn budget | Shared Max plan. Polar's 10,000-call runs would use up your day. |
| Workflows: saved prompt plus schedule plus carried context | A routine (already on the scheduler) whose tools include browser actions | Hearth already has routines and the scheduler |
| 260 templates to solve the "blank slate" | A short list of browser routines in Settings, based on the table above | You're one user, so a handful is enough |
| Sends page context and screenshots to its servers | Nothing leaves the PC except model calls on your Max plan | Your rule: keep cost at or near zero, keep data local |

### Where it would fit in the plan

After M1, as the earlier discussion suggested. Three steps, each useful on its own:
1. **Read-only browsing and page watches.** `browser.open`, `browser.read` and `browser.screenshot`
   as `read` actions, plus `watch` records that check a page on the scheduler without a model turn
   and wake Jarvis only when something changes.
2. **Actions that wait for your yes.** Click, type and submit as gated actions, with a per-site
   allowlist. Banking and password-manager domains are blocked outright.
3. **Long jobs.** Browser routines on a schedule and, if needed, the Browser Use sidecar for large
   parallel research.

None of this is in `PLAN.md` yet. It's waiting for your go-ahead.

## Sources

- Polar: [home](https://polarbrowser.com), [pricing](https://polarbrowser.com/pricing),
  [templates](https://polarbrowser.com/templates), [privacy](https://polarbrowser.com/privacy),
  [terms](https://polarbrowser.com/terms)
- Polar blog: [Introducing Composer](https://polarbrowser.com/blog/introducing-composer) (2026-01-26),
  [A New Interface for Composer](https://polarbrowser.com/blog/new-interface) (2026-05-07),
  [Introducing Polar](https://polarbrowser.com/blog/introducing-polar) (2026-07-29),
  [Frontier Problems](https://polarbrowser.com/blog/frontier-problems) (2026-08-18)
- Mac update feed: `https://d3quve83qxtsii.cloudfront.net/releases/v0.1.97/appcast.xml`
- Instagram reel by kayvon.ai: [Dcy8Druggzc](https://www.instagram.com/p/Dcy8Druggzc/)
- [openalternative.co/browser-use](https://openalternative.co/browser-use),
  [browser-use/browser-use](https://github.com/browser-use/browser-use),
  [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp),
  [browserbase/stagehand](https://github.com/browserbase/stagehand)
- Benchmarks: [Odysseys paper (arXiv 2604.24964)](https://arxiv.org/html/2604.24964),
  [Odysseys leaderboard](https://odysseysbench.com/leaderboard),
  [recursive-hq/polar-evals](https://github.com/recursive-hq/polar-evals),
  [at-inc/aside-benchmarks](https://github.com/at-inc/aside-benchmarks),
  [criticism of BU Bench](https://agentmarketcap.ai/blog/2026/07/27/browser-use-bu-ultra-throughput-benchmark-conflict)
- Press: [TechCrunch](https://techcrunch.com/2026/07/29/perplexity-employee-who-worked-on-comet-launches-an-ai-browser-aimed-at-knowledge-work/),
  [TechRepublic](https://www.techrepublic.com/article/news-polar-ai-browser-security/),
  [Digital Trends](https://www.digitaltrends.com/cool-tech/former-perplexity-engineer-launches-new-polar-ai-browser-which-aims-to-automate-repetitive-tasks/),
  [Business Wire release via pulse2](https://pulse2.com/polar-the-ai-browser-that-does-real-work-raises-5-7-million/),
  [Aside overview](https://eesel.ai/blog/aside-ai-browser)
