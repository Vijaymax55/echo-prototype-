# Echo: a private, language-inclusive helper for quiet students in group discussion

> Working prototype for the paper ***The Quiet Student Was Right*** (CSCL 2027 draft).
> One real student joins an English group discussion with four simulated Class 11 peers. Echo helps that student, privately and in their own language, to get their idea into the conversation.

---

## The idea in one paragraph

In many Indian classrooms, students discuss in English, which is often their second or third language. The students who speak most are usually the most fluent ones, not the ones with the best ideas. A student who thinks in Punjabi or Hindi may have the right answer and still say nothing. Echo is a private helper for that student. They can check an idea in their home language without anyone seeing. Echo then gives them a simple English way to say it, a sentence starter and key words. **The student still does the talking.** Echo never speaks for the student, never posts in the group, and never says whether an idea is right or wrong. Its help fades as the student needs it less.

## Why it matters

- **Participation is unequal, and fluency decides who talks.** In collaborative learning, a few students do most of the talking. When the discussion language is not the students' home language, fluency, not understanding, decides who speaks.
- **Groups lose good ideas.** A student who is silent because of language is still thinking. When their idea never reaches the group, the joint answer is worse. The paper's title, *The Quiet Student Was Right*, refers to this.
- **Silence becomes a habit.** Each discussion a student sits out makes the next one harder. Low confidence in English turns into low confidence in the subject.
- **Existing tools miss the problem.** Captions and translation help a student *follow* the conversation. They do nothing to help the student *speak*. Many AI tutors judge answers or answer for the student, which takes the student's voice away.
- **The setting is under-served.** Most CSCL research assumes monolingual, often Western, classrooms. Multilingual Indian classrooms (here: Class 11 in Punjab, with home languages Punjabi and Hindi) are rarely designed for.

## Objectives

1. **Remove four barriers between a quiet student's idea and the group:**
   | Barrier | What stops the student | What Echo offers |
   |---|---|---|
   | 1. Doubt | "Is my idea even worth saying?" | A private check in their home language, with no judgment |
   | 2. Language | Can't follow fast, fluent peers | Bilingual captions: simple English plus Punjabi or Hindi glosses |
   | 3. Phrasing | Knows the idea but not the English | A simple-English suggestion, a sentence starter, key words |
   | 4. Timing | Never finds the moment to speak | A gentle private nudge after silent rounds |
2. **Keep the student's voice.** Echo supports speaking. It never replaces it.
3. **Make participation more equal** (measured with the normalised Gini coefficient of turns).
4. **Make sure the student's ideas are taken up** by the group, not just spoken.
5. **Build independence over time (RQ4).** The share of contributions the student makes *without* help should rise across sessions.
6. **Respect privacy.** No faces, no emotion detection, no video, no stored audio. Teachers see counts, never private messages.

## The five design rules (paper §4.2)

These rules are written into every AI prompt in `server.py`:

1. **Private by default.** Only the student sees their conversation with Echo. Their group and their teacher do not.
2. **Never judge.** Echo does not call an idea right, wrong, good or smart (praise is also a judgment). Every idea is "worth testing with the group."
3. **The student speaks, not Echo.** Echo gives one suggestion and a cue card. The student says it in their own words. Echo never posts in the group.
4. **Anonymity as a first step.** A student can share an idea anonymously as "A group member", and Echo encourages a named contribution next time.
5. **Help fades.** Nudges are capped at 3 per session. Each contribution made without help adds another quiet round before the next nudge.

## Research design and process

**Conditions (compared in the study):**
- **C0:** a plain group call
- **C1:** captions only (Echo's bilingual captions, without the private helper)
- **C2:** full Echo (captions, private check, phrasing help, nudges, anonymity, fading)

**Session procedure (paper §5.3):**
1. **Norms.** The group reads the shared norms: every idea matters, and no one laughs at language.
2. **Prompt.** For example, choosing a stream after Class 10, or phones and social media.
3. **Discussion** in rounds. A round is 4 peer turns.
4. **Joint answer.** The group writes one answer. Each idea's originator is credited, and anonymous ideas stay anonymous.
5. **Reflection.** Three short questions for the student.

**How a student moves through Echo (C2):**
```
peers talk ──► captions (simple English + ਪੰਜਾਬੀ / हिंदी glosses)
     │
student silent 2 rounds ──► private nudge  [Try it] [Not now]
     │
💡 "I have an idea" ──► student writes or speaks in Punjabi / Hindi / English
     │
Echo (private): warm reply in their language, simple-English version, starter, key words
     │
student says it IN THEIR OWN WORDS (cue card only)  ── or ──  shares anonymously
     │
a peer takes up the idea ──► tracker updates turns, uptake, assisted vs unassisted
```

**Measures (paper §5.4):**
- Normalised Gini of turns per participant, per round (0 = equal, 1 = one person does all the talking)
- Turns per participant
- Idea uptake: whether the group builds on the student's idea
- Unassisted share: contributions made without Echo's help, tracked across sessions (RQ4)
- Nudges sent, accepted and declined
- Reflection answers

## Architecture

```
Browser (static/)                                   server.py (Python stdlib HTTP)
 setup → room → wrap-up screens                       POST /api/caption   caption simplifier
 peer loop, rounds, nudges, fading, Gini   ──JSON──►  POST /api/check     private check + phrasing help
 teacher view, research-log export                    POST /api/nudge     private nudge text
 Web Speech API for the mic (Chrome/Edge)             POST /api/peer      simulated peer takes up idea
                                                      POST /api/summary   joint answer, credits originators
                                                              │
                                     OpenAI or Claude (structured JSON output)
                                     └─ on any failure: deterministic offline fallback
```
Nothing is written to disk on the server: no audio, no video, no transcripts.

## Status

This is a **prototype for demos and for testing the pipeline.** It is not the study system. The peers are simulated, so the logs it exports are not research data. See *What is simulated* and *Path to the study version* below.

---

## How to use the code

### 1. One-time setup
You need **Python 3** (already on macOS) and **uv** (already installed here; elsewhere: `curl -LsSf https://astral.sh/uv/install.sh | sh`).

Put your API key in `echo/.env`. Copy `.env.example` to `.env`; the file should look like this:
```
OPENAI_API_KEY=sk-proj-...
```
`.env` is listed in `.gitignore`. Never commit it or paste the key into code.

### 2. Start the server
```bash
cd echo   # or wherever you cloned the repo
uv run server.py
```
The first run installs the `openai` package automatically. The terminal should print:
```
Echo prototype on http://localhost:8027  -  LIVE AI (openai: gpt-4.1-mini)
```
If it says `OFFLINE DEMO`, the key was not found. Check `.env`. Press **Ctrl+C** to stop the server.

No key or no internet? `python3 server.py` runs the offline demo with no installs.

### 3. Open the room
Go to **http://localhost:8027** in **Chrome or Edge** (the microphone buttons need one of these; typing works anywhere).

On the setup screen, pick:
- **Your name** (default: Simran)
- **I think best in:** ਪੰਜਾਬੀ or हिंदी. This sets the caption glosses and Echo's replies.
- **Today's topic:** choosing a stream, or phones at school
- **Research settings** (collapsed): the study condition (C0 plain call, C1 captions, C2 Echo; default C2) and whether peers' turns are read aloud (default off)

Then click **Join discussion**.

### 4. A 5-minute demo (shows the paper's argument)
1. **Run C1 first** (open *Research settings*, pick *C1 · Captions*). Peers argue fluently; captions help you follow. There is nothing to help you *speak*.
2. **Finish, then start a new session in C2 (Echo)**, the default.
3. Stay silent. After about 2 rounds, a **private nudge** appears on the right. Click **Not now**.
4. Click **💡 I have an idea**, write or speak an idea in Punjabi or Hindi (or click *Example*), then **Check**.
5. Echo replies in your language with a **"You could say"** simple-English version, a sentence starter and key words. It never says right or wrong.
6. Click **I'll say it myself**. A cue card appears above the chat box. Type or speak *your own* version and press **Send**. Alternatively, try **Share anonymously**.
7. A peer **takes up your idea** in the next turn.
8. Open **Teacher**: live Gini, turns, idea uptake, and how much the student said on their own vs with help. No private text is shown.
9. Click **Finish** to see the joint answer (ideas credited, anonymous ones kept anonymous) and the reflection. Then click **Save** to download a JSON research log.
10. Do a second C2 session: the end screen charts your unassisted share across sessions (RQ4).

Controls in the room: **⏸** pauses the peers, **Teacher** opens the dashboard, **Finish** ends the discussion.

### Screenshots for slides and the paper
Add `?shot=` to the URL. The app fast-forwards to that moment and freezes it, ready to capture (best at 1440×900):

| URL | Shows |
|---|---|
| `/?shot=setup` | the join screen |
| `/?shot=captions` | peers talking, with simple-English captions and glosses |
| `/?shot=nudge` | a private nudge after silent rounds |
| `/?shot=idea` | the student typing an idea in Punjabi |
| `/?shot=reply` | Echo's private reply: "You could say…", starter, key words |
| `/?shot=cue` | the cue card above the chat box |
| `/?shot=uptake` | the student's idea in the group, and a peer building on it |
| `/?shot=teacher` | the teacher dashboard (Gini, turns, uptake) |
| `/?shot=end` | the joint answer, stats and reflection |

Optional extras: `&lang=hi` (Hindi), `&topic=phones`, `&c=C1` (captions-only condition), `&theme=dark`. Example: `http://localhost:8027/?shot=reply&lang=hi&theme=dark`. With live AI the wording varies between runs; run offline (`ECHO_OFFLINE=1 uv run server.py`) to get the same shot every time.

### 5. Settings (in `.env` or as environment variables)
| Variable | Meaning | Default |
|---|---|---|
| `OPENAI_API_KEY` | use OpenAI | |
| `ANTHROPIC_API_KEY` | use Claude instead | |
| `ECHO_PROVIDER` | force `openai` or `anthropic` | auto |
| `ECHO_MODEL` | model name | `gpt-4.1-mini` (OpenAI), `claude-opus-5-5` (Claude) |
| `ECHO_OFFLINE=1` | ignore keys and run offline | |
| `PORT` | server port | `8027` |

`gpt-4.1-mini` is fast and cheap (about 3 s per reply). For better Punjabi, try `ECHO_MODEL=gpt-4.1`.

### 6. Troubleshooting
- **"Address already in use":** another copy is running. Stop it, or run `PORT=8030 uv run server.py`.
- **Mic button does nothing:** use Chrome or Edge and allow microphone access.
- **A reply looks canned:** that AI call failed, and the terminal shows the error. The session continues with offline responses.
- **Self-test:** open `http://localhost:8027/#selftest` to watch the whole C2 flow run by itself (peers run 20× faster).

### Live AI vs offline
- **Offline demo:** captions are pre-written. Phrasing help covers the two example ideas and tidies up ideas typed in English. Nudges and peer replies come from templates.
- **Live AI:** captions, phrasing help for any Punjabi, Hindi, English or mixed idea, nudges tied to the conversation, peers who respond to the student's idea, and the joint-answer draft. All use structured JSON output. If one call fails, only that response falls back to offline.

## How it maps to the paper

| Paper | Where in the prototype |
|---|---|
| Barrier 1, doubt: private check (§4.1) | **💡 I have an idea**. The student writes or speaks privately in ਪੰਜਾਬੀ, हिंदी or English. Echo replies warmly in the same language and never says right or wrong (rule 2). |
| Barrier 2, language: bilingual captions | Each peer turn shows simple English plus Punjabi or Hindi glosses for hard words, with the original words one tap away. Captions appear in C1 and C2. |
| Barrier 3, phrasing: phrasing help | An "In simple English" suggestion, a sentence starter, and key words. **I'll say it myself** shows a cue card only. Echo never posts into the group (rule 3). |
| Barrier 4, timing: nudges | After 2 silent rounds (a round is 4 peer turns), Echo sends a private nudge with **Try it** or **Not now**. At most 3 per session. |
| Rule 4, anonymity as a first step | **Share anonymously** posts the idea as "A group member", and Echo encourages a named contribution next time. |
| Rule 5, help fades | Each contribution made without help adds one more quiet round before the next nudge. A high unassisted share in the previous session adds another. |
| §4.4 participation tracker | Counts turns only. No faces, no emotions, no video. |
| §5.3 procedure | Norms, prompt, discussion, joint answer (originators credited, anonymous ideas stay anonymous), then a 3-question reflection. |
| §5.4 measures | **Teacher** shows the live normalised Gini (the paper's formula), turns per participant, idea uptake and the unassisted share (nudge counts go in the research log). Private Echo text is never shown. |
| RQ4, independence | The end screen charts your unassisted share across sessions, stored in this browser only. |
| Research log | **Save** on the end screen exports JSON with counts, Gini by round, ideas (assisted, anonymous, taken up), nudge events, reflection answers and the group transcript. It never includes private Echo messages. |

The **opt-in face and lip readiness signal (§4.4.6) is deliberately not built.** The paper itself treats it as exploratory and in need of ethics and legal review (DPDP Act §9). The voluntary "I have an idea" button is the mechanism used here.

## What is simulated (read before demoing or citing)

- The four peers are scripted (16 turns per prompt). With live AI, the peer who **takes up the student's idea** is generated. Every shared idea gets taken up, so the prototype shows what uptake *feels like*. It is **not a measurement of RQ2.**
- Exported logs come from one real student plus simulated peers. They are pipeline-test data, **not study data**, and the log says so.
- Browser speech recognition (Chrome's Web Speech API) sends audio to the browser vendor's servers. For the real study, swap in the paper's per-student ASR with transcribe-then-delete handling.

## Path to the study version

1. Replace simulated peers with a real multi-party room (open-source, e.g. Jitsi or LiveKit) that gives each student their own audio channel (§4.4).
2. Add per-student Punjabi, Hindi and English ASR, and report its accuracy, especially on code-mixed speech (§9).
3. Keep `server.py`'s endpoints as they are. Captions, private check, nudges and the tracker already work per student.

## Files

```
.env                 your API key (private, git-ignored); .env.example shows the format
server.py            stdlib HTTP server + OpenAI/Claude calls + offline fallbacks (prompts encode §4.2 rules)
static/index.html    setup → room → wrap-up screens
static/app.js        peer loop, rounds, nudge/fade logic, Gini, teacher view, log export
static/scripts.js    peers, two prompts, pre-made captions with Gurmukhi/Devanagari glosses
static/selftest.js   headless smoke test (open /#selftest); not loaded normally
```
