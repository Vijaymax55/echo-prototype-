import { PEERS, TOPICS, ROUND_SIZE } from "./scripts.js";

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
async function api(path, body) {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { source: "error" }; }
}
function segValue(id) { return $(id).querySelector(".on")?.dataset.v; }
function bindSeg(id, onChange) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    onChange?.(b.dataset.v);
  });
}

// Normalised Gini of turn counts (Section 5.4): 0 = equal, 1 = one person does all the talking.
function gini(xs) {
  const n = xs.length, sum = xs.reduce((a, b) => a + b, 0);
  if (n < 2 || sum === 0) return 0;
  const mean = sum / n;
  let d = 0;
  for (const a of xs) for (const b of xs) d += Math.abs(a - b);
  return (d / (2 * n * n * mean)) * (n / (n - 1));
}

const LANG_CODE = { pa: "pa-IN", hi: "hi-IN", en: "en-IN" };
const HOME_NORMS = { pa: "ਹਰ ਵਿਚਾਰ ਮਾਇਨੇ ਰੱਖਦਾ ਹੈ।", hi: "हर विचार मायने रखता है।" };
// ?shot=<state> fast-forwards to one moment and freezes it, for screenshots.
const SHOT = new URLSearchParams(location.search).get("shot");
let SPEED = location.hash === "#selftest" || SHOT ? 0.05 : 1; // self-test and shots run the peers 20x faster
const NUDGE_CAP = 3;            // max nudges per session (Section 4.4, rule 5)
const ASSIST_WINDOW_MS = 120000; // a contribution within 2 min of Echo help counts as assisted

// ---------------------------------------------------------------- state
let S = null;
let LIVE = false;

function newState() {
  const topic = TOPICS[segValue("f-topic")];
  const name = ($("f-name").value || "Simran").trim().slice(0, 24);
  const history = store.get("echo.sessions", []);
  return {
    sessionId: (crypto.randomUUID?.() || String(Date.now())).slice(0, 8),
    name, home: segValue("f-home"), cond: segValue("f-cond"), topic,
    voices: $("f-voices").checked,
    participants: [...Object.keys(PEERS), name],
    counts: Object.fromEntries([...Object.keys(PEERS), name].map((p) => [p, 0])),
    turns: [], queue: [], scriptIdx: 0, peerTurns: 0, round: 1,
    studentSpokeThisRound: false, silentRounds: 0,
    nudgesSent: 0, nudgesDeclined: 0, nudgesTried: 0, nudgeOpen: false,
    lastHelpAt: 0, helpCount: 0, anonCount: 0,
    ideas: [], giniByRound: [], events: [],
    paused: false, running: false, ended: false,
    start: Date.now(),
    priorUnassisted: history.length ? history[history.length - 1].unassistedShare : null,
    captionCache: new Map(),
  };
}
const log = (type, data = {}) => S.events.push({ t: +((Date.now() - S.start) / 1000).toFixed(1), type, ...data });
const hasCaptions = () => S.cond !== "C0";
const hasEcho = () => S.cond === "C2";

// Help fades (rule 5): every unassisted contribution adds one more silent round
// before a nudge; a strong unassisted share in the previous session adds one more.
function nudgeThreshold() {
  const unassisted = S.ideas.filter((i) => !i.assisted).length;
  return 2 + unassisted + (S.priorUnassisted != null && S.priorUnassisted >= 0.6 ? 1 : 0);
}

// ---------------------------------------------------------------- setup screen
bindSeg("f-home", (v) => { $("norm-home").textContent = `Every idea counts. Nobody laughs at language. · ${HOME_NORMS[v]}`; });
bindSeg("f-topic");
bindSeg("f-cond");
bindSeg("check-lang");

const statusReady = fetch("/api/status").then((r) => r.json()).then((s) => {
  LIVE = !!s.live;
  $("mode-line").classList.toggle("live", LIVE);
  $("mode-line").querySelector("span").textContent = LIVE ? `Live AI · ${s.model}` : "Offline demo";
  $("mode-line").title = LIVE ? "" : "Captions are pre-made. Add OPENAI_API_KEY to echo/.env for live AI.";
}).catch(() => { $("mode-line").querySelector("span").textContent = "Server not reachable. Start it with: python3 server.py"; });

$("btn-start").addEventListener("click", startSession);

function show(id) { document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id)); }

// ---------------------------------------------------------------- room
function startSession() {
  S = newState();
  log("session_start", { condition: S.cond, topic: S.topic.id, home: S.home, live: LIVE });
  show("room");
  $("r-prompt").textContent = S.topic.prompt;
  $("r-prompt-home").textContent = hasCaptions() ? S.topic[`prompt_${S.home}`] : "";
  $("room").querySelector(".room-grid").classList.toggle("no-echo", !hasEcho());
  $("echo").hidden = !hasEcho();
  document.querySelectorAll(".t-name").forEach((x) => (x.textContent = S.name));
  $("feed").innerHTML = "";
  $("history").innerHTML = "";
  resetEchoPanel();
  $("nudge").hidden = true;
  $("cue").hidden = true;
  $("btn-pause").textContent = "⏸";
  $("check-lang").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === S.home));
  renderTiles();
  sys("Every idea counts. Nobody laughs at language.");
  S.running = true;
  S.timer = setInterval(tick, 1000);
  peerLoop();
}

function tick() {
  const s = Math.floor((Date.now() - S.start) / 1000);
  $("r-timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function colorOf(name) { return PEERS[name]?.color || "#5b4bd6"; }
function initials(name) { return name.slice(0, 1).toUpperCase(); }

function renderTiles(speaking) {
  const t = $("tiles"); t.innerHTML = "";
  for (const p of S.participants) {
    const me = p === S.name;
    const tile = el("div", `person${me ? " me" : ""}${p === speaking ? " speaking" : ""}`);
    tile.append(el("div", "avatar", initials(p)));
    tile.querySelector(".avatar").style.background = colorOf(p);
    tile.append(el("div", "nm", esc(me ? "You" : p)));
    t.append(tile);
  }
}

function sys(text) { const d = el("div", "sys", esc(text)); $("feed").append(d); scrollFeed(); }
function scrollFeed() { const f = $("feed"); f.scrollTop = f.scrollHeight; }

// Render one turn in the shared feed. Captions (C1/C2) show simple English + glosses.
function renderTurn(turn) {
  const me = turn.speaker === S.name && !turn.anonymous;
  const shownName = turn.anonymous ? "A group member" : turn.speaker;
  const m = el("div", `msg${me ? " me" : ""}${turn.anonymous ? " anon" : ""}`);
  const av = el("div", "av", turn.anonymous ? "?" : initials(turn.speaker));
  av.style.background = colorOf(turn.speaker);
  const body = el("div");
  const tag = turn.anonymous ? `<span class="tag">anonymous</span>` : "";
  body.append(el("div", "who", `${esc(me ? "You" : shownName)}${tag}`));
  if (hasCaptions() && turn.caption && !turn.isStudent) {
    m.classList.add("captioned");
    body.append(el("div", "cap", esc(turn.caption)));
    if (turn.glosses?.length) {
      const gl = el("div", "gl");
      for (const g of turn.glosses) gl.append(el("span", null, `<b>${esc(g.en)}</b> ${esc(S.home === "pa" ? g.pa : g.hi)}`));
      body.append(gl);
    }
    const d = el("details"); d.innerHTML = `<summary>Original</summary><div class="orig">${esc(turn.text)}</div>`;
    body.append(d);
  } else {
    body.append(el("div", "orig", esc(turn.text)));
  }
  turn.node = body;
  m.append(av, body);
  $("feed").append(m);
  scrollFeed();
}

// ---------------------------------------------------------------- simulated peers
// True while session `s` is the current one and still running. Guards every await so a
// finished session's loop never keeps going into the next session.
const alive = (s) => S === s && s.running;
async function waitWhilePaused(s) { while (s.paused && alive(s)) await sleep(250); }

async function captionFor(turn) {
  // Live: ask the caption simplifier. Offline or on failure: the pre-made caption.
  if (!hasCaptions() || !LIVE) return;
  const key = turn.text;
  if (!S.captionCache.has(key)) {
    S.captionCache.set(key, api("/api/caption", { prompt: S.topic.prompt, speaker: turn.speaker, text: turn.text }));
  }
  const r = await S.captionCache.get(key);
  if (r?.source === "live" && r.simple) { turn.caption = r.simple; turn.glosses = r.glosses || []; }
}

async function peerLoop() {
  const s = S;
  await sleep(1500 * SPEED);
  while (alive(s)) {
    await waitWhilePaused(s);
    if (!alive(s)) break;
    let turn;
    if (S.queue.length) {
      turn = S.queue.shift();
    } else if (S.scriptIdx < S.topic.turns.length) {
      const st = S.topic.turns[S.scriptIdx++];
      turn = { speaker: st.s, text: st.t, caption: st.c, glosses: st.gl };
      // prefetch the next caption so live captions don't lag
      const nx = S.topic.turns[S.scriptIdx];
      if (nx && LIVE && hasCaptions()) captionFor({ speaker: nx.s, text: nx.t, caption: nx.c, glosses: nx.gl });
    } else {
      sys("Time is almost up. Press Finish to write your joint answer.");
      S.running = false;
      $("btn-end").classList.add("primary");
      break;
    }
    await captionFor(turn);
    if (!alive(s)) break;
    await peerSpeak(turn);
    if (!alive(s)) break;
    onPeerTurnDone();
  }
}

function speak(text, who) {
  return new Promise((resolve) => {
    if (!S.voices || !("speechSynthesis" in window)) return resolve(false);
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const v = voices.find((x) => x.lang === "en-IN") || voices.find((x) => x.lang?.startsWith("en"));
    if (v) u.voice = v;
    u.lang = v?.lang || "en-IN";
    const p = { Arjun: [0.9, 1.08], Meera: [1.25, 1.05], Rohan: [1.0, 1.0], Harpreet: [1.15, 0.88] }[who] || [1, 1];
    u.pitch = p[0]; u.rate = p[1];
    u.onend = u.onerror = () => resolve(true);
    speechSynthesis.speak(u);
    setTimeout(() => resolve(true), 20000);
  });
}

async function peerSpeak(turn) {
  const s = S;
  addTurn(turn);
  renderTiles(turn.speaker);
  const spoke = await speak(turn.text, turn.speaker);
  const base = spoke ? 1100 : 3800 + turn.text.length * 40;
  await sleep(base * SPEED);
  if (alive(s)) renderTiles();
}

function addTurn(turn) {
  turn.id = S.turns.length;
  S.turns.push(turn);
  S.counts[turn.speaker] = (S.counts[turn.speaker] || 0) + 1;
  log("turn", { speaker: turn.anonymous ? "anonymous" : turn.speaker, isStudent: !!turn.isStudent, assisted: !!turn.assisted,
    anonymous: !!turn.anonymous, buildsOnIdea: turn.buildsOnIdea ?? null, round: S.round });
  renderTurn(turn);
}

function onPeerTurnDone() {
  S.peerTurns++;
  if (S.peerTurns % ROUND_SIZE !== 0) return;
  // a round has ended
  S.giniByRound.push({ round: S.round, gini: +gini(Object.values(S.counts)).toFixed(3) });
  S.silentRounds = S.studentSpokeThisRound ? 0 : S.silentRounds + 1;
  log("round_end", { round: S.round, studentSpoke: S.studentSpokeThisRound, silentRounds: S.silentRounds, gini: S.giniByRound.at(-1).gini });
  S.studentSpokeThisRound = false;
  S.round++;
  renderTeacher();
  if (hasEcho() && S.silentRounds >= nudgeThreshold() && S.nudgesSent < NUDGE_CAP && !S.nudgeOpen && $("check").hidden && $("reply").hidden) {
    sendNudge();
  }
}

// ---------------------------------------------------------------- student contributions
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("say").value.trim();
  if (!text) return;
  $("say").value = "";
  contribute(text, { anonymous: false, typed: !S.lastWasVoice });
  S.lastWasVoice = false;
});

function contribute(text, { anonymous, typed }) {
  if (!S || S.ended) return;
  const assisted = hasEcho() && Date.now() - S.lastHelpAt < ASSIST_WINDOW_MS;
  const turn = { speaker: S.name, text, isStudent: true, anonymous, typed, assisted };
  S.studentSpokeThisRound = true;
  S.silentRounds = 0;
  addTurn(turn);
  renderTiles();
  const idea = { turnId: turn.id, name: anonymous ? "A group member (anonymous)" : S.name, text, assisted, anonymous, takenUp: false, by: null, round: S.round };
  S.ideas.push(idea);
  if (assisted) S.lastHelpAt = 0; // one piece of help counts for one contribution
  $("cue").hidden = true;
  if (hasEcho() && anonymous) {
    addHistory("You shared an idea anonymously. Next time you could add your name to it. 🙂");
  } else if (hasEcho() && !assisted) {
    addHistory("You spoke on your own. Echo will step back a little.");
  }
  renderTeacher();
  requestUptake(idea);
}

// A peer takes up the idea as the very next turn (RQ2 is measured on real groups;
// here the simulated peers respond so the student sees their idea land).
async function requestUptake(idea) {
  const s = S;
  const peers = Object.keys(PEERS).filter((p) => p !== "Harpreet");
  const r = await api("/api/peer", {
    prompt: S.topic.prompt, peers, student: S.name, anonymous: idea.anonymous, idea: idea.text,
    index: S.ideas.length, turns: S.turns.map(slim),
    personas: Object.entries(PEERS).map(([k, v]) => `${k}: ${v.persona}`).join("; "),
  });
  if (!r?.text || !alive(s)) return;
  const turn = { speaker: r.speaker || peers[0], text: r.text, caption: r.caption?.simple || r.text, glosses: r.caption?.glosses || [], buildsOnIdea: idea.turnId };
  idea.takenUp = true; idea.by = turn.speaker;
  S.queue.unshift(turn);
  log("uptake", { ideaTurn: idea.turnId, by: turn.speaker });
  setTimeout(() => {
    const ideaTurn = S.turns[idea.turnId];
    if (ideaTurn?.node && !ideaTurn.node.querySelector(".uptake")) ideaTurn.node.append(el("div", "uptake", `↳ ${esc(turn.speaker)} is building on this`));
  }, 400);
  if (hasEcho() && !idea.anonymous) addHistory(`${turn.speaker} is building on your idea.`);
  renderTeacher();
}
const slim = (t) => ({ speaker: t.speaker, text: t.text, anonymous: !!t.anonymous });

// ---------------------------------------------------------------- Echo: private check + phrasing help
function resetEchoPanel() {
  $("check").hidden = true; $("reply").hidden = true; $("btn-idea").hidden = false;
  $("check-text").value = "";
  S && (S.pending = null);
}

$("btn-idea").addEventListener("click", () => {
  $("btn-idea").hidden = true; $("check").hidden = false; $("reply").hidden = true;
  $("nudge").hidden = true; S.nudgeOpen = false;
  $("check-text").focus();
  log("idea_button");
});
$("check-cancel").addEventListener("click", resetEchoPanel);
$("btn-example").addEventListener("click", () => {
  $("check-text").value = S.topic.sample_idea;
  const lang = /[਀-੿]/.test(S.topic.sample_idea) ? "pa" : "hi";
  $("check-lang").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === lang));
});

$("check-send").addEventListener("click", async () => {
  const idea = $("check-text").value.trim();
  if (!idea) return $("check-text").focus();
  const btn = $("check-send"); btn.disabled = true; btn.textContent = "Echo is thinking…";
  log("private_check", { lang: segValue("check-lang") }); // content is never logged
  const r = await api("/api/check", { prompt: S.topic.prompt, idea, lang: segValue("check-lang"), home_lang: S.home, turns: S.turns.map(slim) });
  btn.disabled = false; btn.textContent = "Check with Echo";
  S.helpCount++;
  S.lastHelpAt = Date.now();
  S.pending = { idea, simple: r.simple_english || "" };
  $("check").hidden = true; $("reply").hidden = false;
  $("reply-warm").textContent = r.warm_reply || "Interesting idea. Let's test it with the group.";
  if (r.simple_english) {
    $("reply-simple").textContent = r.simple_english;
  } else {
    $("reply-simple").innerHTML = `<span class="loading">“I think … because …” or “What if …?”</span>`;
  }
  $("reply-starter").textContent = r.starter ? `Start with: “${r.starter.trim()}”` : "";
  const kw = $("reply-kw"); kw.innerHTML = "";
  for (const k of r.key_words || []) kw.append(el("span", null, `<b>${esc(k.en)}</b> = ${esc(k.home)}`));
});

$("share-own").addEventListener("click", () => {
  const p = S.pending;
  $("cue-text").textContent = p?.simple || "I think … because …";
  $("cue").hidden = false;
  addHistory("Your cue is above the chat box. Say it your way.");
  log("share_choice", { choice: "own_words" });
  resetEchoPanel();
  $("say").focus();
});
$("share-anon").addEventListener("click", () => {
  const p = S.pending; if (!p) return;
  const text = p.simple || p.idea;
  S.anonCount++;
  log("share_choice", { choice: "anonymous" });
  resetEchoPanel();
  contribute(text, { anonymous: true, typed: true });
});
$("share-keep").addEventListener("click", () => {
  log("share_choice", { choice: "keep_private" });
  addHistory("You kept your idea private. That's okay. It's still yours.");
  resetEchoPanel();
});
$("cue-x").addEventListener("click", () => ($("cue").hidden = true));

function addHistory(text) {
  const h = el("div", "h", esc(text));
  $("history").prepend(h);
}

// ---------------------------------------------------------------- nudges (timing barrier)
async function sendNudge() {
  const s = S;
  S.nudgesSent++;
  S.nudgeOpen = true;
  S.silentRounds = 0;
  log("nudge", { n: S.nudgesSent, threshold: nudgeThreshold() });
  const r = await api("/api/nudge", { prompt: S.topic.prompt, topic_id: S.topic.id, home_lang: S.home, index: S.nudgesSent - 1, turns: S.turns.map(slim) });
  if (!alive(s) || !S.nudgeOpen) return;
  $("nudge-en").textContent = r.nudge_en || "You could ask the group a question.";
  $("nudge-home").textContent = r.nudge_home || "";
  $("nudge").hidden = false;
  S.currentNudge = r.nudge_en;
}
$("nudge-no").addEventListener("click", () => {
  S.nudgesDeclined++; S.nudgeOpen = false; $("nudge").hidden = true;
  log("nudge_response", { response: "not_now" });
  addHistory("Okay. Echo will stay quiet for a while.");
  S.silentRounds = -1; // one extra round of quiet after a "Not now"
});
$("nudge-try").addEventListener("click", () => {
  S.nudgesTried++; S.nudgeOpen = false; $("nudge").hidden = true;
  S.lastHelpAt = Date.now(); S.helpCount++;
  log("nudge_response", { response: "try" });
  $("cue-text").textContent = S.currentNudge || "";
  $("cue").hidden = false;
  $("say").focus();
});

// ---------------------------------------------------------------- speech input (optional)
let rec = null;
function toggleMic(btn, lang, onText) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert("Speech input needs Chrome or Edge. You can type instead."); return; }
  if (rec) { rec.stop(); return; }
  rec = new SR();
  rec.lang = LANG_CODE[lang] || "en-IN";
  rec.interimResults = true;
  rec.continuous = false;
  btn.classList.add("on");
  rec.onresult = (e) => onText(Array.from(e.results).map((r) => r[0].transcript).join(" "));
  rec.onend = rec.onerror = () => { btn.classList.remove("on"); rec = null; };
  rec.start();
}
$("mic-group").addEventListener("click", () => toggleMic($("mic-group"), "en", (t) => { $("say").value = t; S.lastWasVoice = true; }));
$("mic-check").addEventListener("click", () => toggleMic($("mic-check"), segValue("check-lang"), (t) => { $("check-text").value = t; }));

// ---------------------------------------------------------------- pause / teacher / finish
$("btn-pause").addEventListener("click", () => {
  S.paused = !S.paused;
  $("btn-pause").textContent = S.paused ? "▶" : "⏸";
  if ("speechSynthesis" in window) S.paused ? speechSynthesis.pause() : speechSynthesis.resume();
});
$("btn-teacher").addEventListener("click", () => { renderTeacher(); $("teacher").hidden = false; });
$("teacher-x").addEventListener("click", () => ($("teacher").hidden = true));
$("teacher").addEventListener("click", (e) => { if (e.target.id === "teacher") $("teacher").hidden = true; });

function statTiles(items) {
  return items.map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");
}

function renderTeacher() {
  if (!S) return;
  const counts = S.participants.map((p) => S.counts[p]);
  const g = gini(counts);
  const mine = S.ideas;
  const unassisted = mine.filter((i) => !i.assisted).length;
  const taken = mine.filter((i) => i.takenUp).length;
  $("t-stats").innerHTML = statTiles([
    [g.toFixed(2), "Gini now"],
    [mine.length ? `${taken}/${mine.length}` : "—", "ideas taken up"],
    [hasEcho() ? (mine.length ? `${Math.round((100 * unassisted) / mine.length)}%` : "—") : "n/a", "unassisted share"],
  ]);
  const max = Math.max(1, ...counts);
  $("t-bars").innerHTML = S.participants.map((p) =>
    `<div class="bar"><span>${esc(p)}</span><div class="track"><div class="fill" style="width:${(100 * S.counts[p]) / max}%;background:${colorOf(p)}"></div></div><span class="n">${S.counts[p]}</span></div>`
  ).join("");
  $("t-gini").innerHTML = giniChart(S.giniByRound);
  $("t-ideas").innerHTML = mine.length
    ? mine.map((i) => `<div class="idea-row">${esc(i.text)}<div class="meta-line">${i.takenUp ? `<span class="ok">Taken up by ${esc(i.by)}</span>` : "Not taken up yet"} · ${i.anonymous ? "anonymous" : "named"} · ${i.assisted ? "with Echo help" : "on their own"}</div></div>`).join("")
    : `<p class="fine">No contributions yet.</p>`;
}

function giniChart(pts) {
  if (!pts.length) return `<p class="fine">Shown after the first round.</p>`;
  const W = 500, H = 140, P = 28;
  const x = (i) => P + (pts.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (pts.length - 1));
  const y = (v) => H - P - v * (H - 2 * P);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.gini)}`).join(" ");
  const dots = pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.gini)}" r="4" fill="var(--echo)"><title>Round ${p.round}: ${p.gini}</title></circle><text x="${x(i)}" y="${H - 8}" text-anchor="middle">R${p.round}</text><text x="${x(i)}" y="${y(p.gini) - 9}" text-anchor="middle">${p.gini.toFixed(2)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Gini by round">
    <line x1="${P}" x2="${W - P}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/><line x1="${P}" x2="${W - P}" y1="${y(1)}" y2="${y(1)}" stroke="var(--line)" stroke-dasharray="3 4"/>
    <text x="4" y="${y(0) + 4}">0</text><text x="4" y="${y(1) + 4}">1</text>
    <path d="${path}" fill="none" stroke="var(--echo)" stroke-width="2.5"/>${dots}</svg>`;
}

$("btn-end").addEventListener("click", finish);

async function finish() {
  if (!S || S.ended) return;
  S.running = false; S.ended = true; S.paused = false;
  clearInterval(S.timer);
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  $("btn-end").classList.remove("primary");
  S.giniByRound.push({ round: S.round, gini: +gini(Object.values(S.counts)).toFixed(3), final: true });
  log("session_end");
  show("end");
  $("e-prompt").textContent = S.topic.prompt;
  $("e-answer").innerHTML = `<div class="loading">Writing the group's answer…</div>`;
  renderEndStats();
  const r = await api("/api/summary", { prompt: S.topic.prompt, turns: S.turns.map(slim), ideas: S.ideas });
  $("e-answer").innerHTML = `<div class="answer">${esc(r.joint_answer || "")}</div>` +
    (r.credits?.length ? `<ul class="credits">${r.credits.map((c) => `<li><span><b>${esc(c.name)}</b> · ${esc(c.idea)}</span></li>`).join("")}</ul>` : "");
}

// Reflection: three 1-5 tap scales
const RATINGS = { "q-wtc": 3, "q-anx": 3, "q-heard": 3 };
for (const id of Object.keys(RATINGS)) {
  $(id).innerHTML = [1, 2, 3, 4, 5].map((n) => `<button data-v="${n}"${n === 3 ? ' class="on"' : ""} aria-label="${n} of 5">${n}</button>`).join("");
  bindSeg(id, (v) => { RATINGS[id] = +v; });
}

function renderEndStats() {
  const mine = S.ideas;
  const un = mine.filter((i) => !i.assisted).length;
  const share = mine.length ? un / mine.length : null;
  S.unassistedShare = share;
  const final = S.giniByRound.at(-1).gini;
  S.finalGini = final;
  $("e-stats").innerHTML = statTiles([
    [S.counts[S.name], "times you spoke"],
    [mine.filter((i) => i.takenUp).length, "ideas the group used"],
    [hasEcho() ? (share == null ? "—" : `${Math.round(share * 100)}%`) : "n/a", "said on your own"],
  ]);
  const hist = store.get("echo.sessions", []).filter((h) => h.cond === "C2" && h.unassistedShare != null);
  const series = hasEcho() && share != null ? [...hist.map((h) => h.unassistedShare), share] : hist.map((h) => h.unassistedShare);
  $("e-indep").hidden = !hasEcho() || series.length < 2;
  if ($("e-indep").hidden) return;
  const W = 500, H = 120, P = 26, bw = Math.min(46, (W - 2 * P) / series.length - 8);
  const bars = series.map((v, i) => {
    const x = P + i * ((W - 2 * P) / series.length) + 4, h = v * (H - 2 * P);
    return `<rect x="${x}" y="${H - P - h}" width="${bw}" height="${h}" rx="4" fill="var(--echo)" opacity="${i === series.length - 1 ? 1 : .55}"/><text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">S${i + 1}</text><text x="${x + bw / 2}" y="${H - P - h - 5}" text-anchor="middle">${Math.round(v * 100)}%</text>`;
  }).join("");
  $("e-indep").innerHTML = `<b>Needing Echo less</b><p class="fine">Share of what you said on your own, per session</p><svg viewBox="0 0 ${W} ${H}" width="100%">${bars}</svg>`;
}

$("btn-save").addEventListener("click", () => {
  const reflection = { wtc: RATINGS["q-wtc"], anxiety: RATINGS["q-anx"], heard: RATINGS["q-heard"] };
  const hist = store.get("echo.sessions", []);
  if (!S.saved) {
    hist.push({ date: new Date().toISOString(), cond: S.cond, topic: S.topic.id, turns: S.counts[S.name], unassistedShare: S.unassistedShare, reflection });
    store.set("echo.sessions", hist);
    S.saved = true;
  }
  const counts = S.participants.map((p) => ({ participant: p === S.name ? "student" : p, proficiency: p === S.name ? "student" : PEERS[p].proficiency, simulated: p !== S.name, turns: S.counts[p] }));
  const logData = {
    note: "Echo prototype research log. One real student with four SIMULATED peers; not study data. Private Echo messages are never recorded.",
    session: { id: S.sessionId, condition: S.cond, topic: S.topic.id, prompt: S.topic.prompt, homeLanguage: S.home, liveAI: LIVE, sessionNumber: hist.length, startedAt: new Date(S.start).toISOString(), durationSec: Math.round((Date.now() - S.start) / 1000) },
    participation: { counts, giniByRound: S.giniByRound },
    ideas: S.ideas.map(({ turnId, text, assisted, anonymous, takenUp, by, round }) => ({ turnId, text, assisted, anonymous, takenUp, takenUpBy: by, round })),
    echo: hasEcho() ? { privateChecks: S.helpCount, nudgesSent: S.nudgesSent, nudgesDeclined: S.nudgesDeclined, nudgesTried: S.nudgesTried, anonymousShares: S.anonCount, unassistedShare: S.unassistedShare } : null,
    reflection,
    transcript: S.turns.map((t) => ({ id: t.id, speaker: t.anonymous ? "anonymous" : t.speaker === S.name ? "student" : t.speaker, text: t.text })),
    events: S.events,
  };
  const blob = new Blob([JSON.stringify(logData, null, 2)], { type: "application/json" });
  const a = el("a"); a.href = URL.createObjectURL(blob); a.download = `echo-log-${S.cond}-${S.sessionId}.json`; a.click();
  $("btn-save").textContent = "Saved ✓";
});

$("btn-again").addEventListener("click", () => { $("btn-save").textContent = "Save"; show("setup"); });

if (location.hash === "#selftest") import("./selftest.js").then((m) => setTimeout(m.run, 800));

// ---------------------------------------------------------------- screenshot presets
// /?shot=captions | nudge | idea | reply | cue | uptake | teacher | end
// Optional: &lang=hi, &topic=phones, &c=C1, &theme=dark
async function runShot(shot) {
  const q = new URLSearchParams(location.search);
  const pick = (seg, v) => v && $(seg).querySelector(`[data-v="${v}"]`)?.click();
  pick("f-home", q.get("lang")); pick("f-topic", q.get("topic")); pick("f-cond", q.get("c"));
  if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");
  if (shot === "setup") return;
  await statusReady;
  $("f-voices").checked = false;
  startSession();
  const s = S;
  s.start = Date.now() - 6 * 60000 - 23000; // a believable clock
  const until = async (fn) => { while (!fn()) await sleep(100); };
  const freeze = () => { s.paused = true; SPEED = 1; $("btn-pause").textContent = "⏸"; };
  if (shot === "captions") { await until(() => s.turns.length >= 5); return freeze(); }
  if (shot === "nudge") { await until(() => !$("nudge").hidden); return freeze(); }
  await until(() => s.turns.length >= 6); freeze();
  $("btn-idea").click();
  $("btn-example").click();
  if (shot === "idea") return;
  $("check-send").click();
  await until(() => !$("reply").hidden);
  if (shot === "reply") return;
  $("share-own").click();
  if (shot === "cue") return;
  $("say").value = $("cue-text").textContent;
  $("composer").requestSubmit();
  s.paused = false; SPEED = 0.05;
  await until(() => s.turns.some((t) => t.buildsOnIdea != null) && !s.queue.length);
  await sleep(150);
  if (shot !== "uptake") {
    // a second idea, said without help, and a few more rounds for the Gini chart
    $("say").value = "Also, schools should give every student a proper career talk.";
    $("composer").requestSubmit();
    await until(() => s.peerTurns >= 12);
  }
  freeze();
  if (shot === "teacher") { $("btn-teacher").click(); return; }
  if (shot === "end") return finish();
}
if (SHOT) runShot(SHOT);
