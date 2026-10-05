// Pages for the driver's tests (B1): frames from two sites, shadow DOM, a hidden checkbox, a tab
// that's a link, a click handled by a parent, things a page made clickable with no role, a date,
// a canvas, a pop-up, an endless list, and pages that are slow to come.
import type { Site } from "../../testing/cdp-connection.ts";

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title><meta charset="utf-8"></head><body style="margin:0">${body}</body></html>`;

export function fixtures(port: () => number): Site {
  const b = (path: string) => `http://b.test:${port()}${path}`;
  return {
    "/": page(
      "Home",
      `<h1>Home</h1><a href="/next">Next page</a><button id="go" onclick="document.title='clicked'">Go</button>`,
    ),
    "/next": page("Next", `<h1>Next</h1><p>The second page.</p><button>Back home</button>`),
    "a.test/frames": () =>
      page(
        "Frames",
        `<h1>Frames</h1><button onclick="document.title='main'">Main button</button>
        <iframe id="far" title="Far frame" src="${b("/inner")}" style="position:absolute;left:0;top:120px;width:400px;height:200px;border:0"></iframe>
        <iframe id="near" title="Near frame" src="/same" style="position:absolute;left:0;top:340px;width:400px;height:120px;border:0"></iframe>`,
      ),
    // In the far frame, "Post it" is at 10,60 to 110,90: in the tab, 60,195 is its middle.
    "b.test/inner": page(
      "Inner",
      `<button id="inner" onclick="this.textContent='Inner pressed'">Inner button</button>
      <form method="post" action="/post"><input name="q" aria-label="Comment">
      <button style="position:absolute;left:10px;top:60px;width:100px;height:30px">Post it</button></form>`,
    ),
    "/same": page(
      "Same",
      `<a href="#x" onclick="this.textContent='Same clicked';return false">Same site link</a>`,
    ),
    "/widgets": page(
      "Widgets",
      `<x-card></x-card>
      <script>customElements.define("x-card", class extends HTMLElement { connectedCallback() {
        const r = this.attachShadow({ mode: "open" });
        r.innerHTML = '<button id="sb">Shadow button</button>';
        r.querySelector("button").onclick = () => { document.title = "shadow"; };
      } });</script>
      <label style="position:relative;display:inline-block;padding:4px">
        <input type="checkbox" id="remember" style="opacity:0;position:absolute;left:0;top:0;width:1px;height:1px">
        <span>Remember me</span></label>
      <div role="tablist"><a role="tab" href="#one" aria-selected="true">First tab</a><a role="tab" href="#two" onclick="document.title='tab two';return false">Second tab</a></div>
      <div id="list"><div class="item" style="cursor:pointer;padding:4px">Open the item</div></div>
      <script>document.getElementById("list").addEventListener("click", (e) => {
        if (e.target.closest(".item")) document.title = "delegated"; });</script>
      <label>Start date <input type="date" id="date"></label>
      <label>Size <select id="size"><option>Small</option><option>Large</option></select></label>
      <label>Name <input id="name"></label>
      <form method="post" action="/order"><label>Note <input name="note"></label><button>Place order</button></form>
      <form method="post" action="/subscribe"><label>Email <input name="email"></label><button>Subscribe</button></form>
      <button onclick="window.open('/next', '_blank')">Open pop-up</button>
      <button onclick="alert('Hello')">Show alert</button>`,
    ),
    "/canvas": page(
      "Canvas",
      `<canvas id="c" width="300" height="200" style="display:block;margin:20px;border:1px solid"></canvas>
      <script>const c = document.getElementById("c");
      c.addEventListener("click", (e) => { const r = c.getBoundingClientRect();
        document.title = "at " + Math.round(e.clientX - r.left) + "," + Math.round(e.clientY - r.top); });</script>`,
    ),
    // Things the page made clickable itself, with no role: judged by their names all the same.
    "/clickables": () =>
      page(
        "Clickables",
        `<div id="del" style="cursor:pointer;padding:8px;width:240px">Delete <span>account</span></div>
      <div id="pub" style="cursor:pointer;padding:8px;width:240px">Publish</div>
      <div id="more" style="cursor:pointer;padding:8px;width:240px">Show <b>details</b></div>
      <a href="${b("/next")}">Elsewhere</a>
      <script>for (const id of ["del", "pub", "more"])
        document.getElementById(id).addEventListener("click", () => { document.title = id; });</script>`,
      ),
    "/covered": page(
      "Covered",
      `<button id="under" onclick="document.title='pressed'">Hidden under</button>
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.5)"><p>Cookie wall</p></div>`,
    ),
    "/endless": page(
      "Endless",
      `<div id="feed"></div><script>
      let n = 0; const feed = document.getElementById("feed");
      const more = () => { for (let k = 0; k < 20; k++) { const p = document.createElement("p");
        p.textContent = "Item " + (++n); p.style.height = "60px"; feed.append(p); } };
      more(); addEventListener("scroll", () => {
        if (innerHeight + scrollY > document.body.scrollHeight - 200) more(); });</script>`,
    ),
    // Its heading comes 2.5 s after the rest, so it's still loading till then, with nothing to read.
    "/slow": {
      first: `<!doctype html><html><head><title>Slow</title><meta charset="utf-8"></head><body style="margin:0">`,
      rest: "<h1>Slow</h1></body></html>",
      afterMs: 2_500,
    },
    // Nothing at all for 2.5 s, so a new tab going to it is still on its blank page till then.
    "/held": { rest: page("Held", "<h1>Held</h1>"), afterMs: 2_500 },
    // Its heading comes when a test calls finish() (or after a minute): still loading till then.
    "/unfinished": {
      first: `<!doctype html><html><head><title>Unfinished</title><meta charset="utf-8"></head><body style="margin:0"><p>The start</p>`,
      rest: "<h1>The end</h1></body></html>",
      afterMs: 60_000,
    },
    "/order": page("Ordered", "<h1>Thanks</h1>"),
    "/subscribe": page("Subscribed", "<h1>Subscribed</h1>"),
    "/post": page("Posted", "<h1>Posted</h1>"),
  };
}
