"""Echo prototype server.

Serves the browser room (static/) and five small JSON endpoints that map to the
architecture in Section 4.4 of the paper:

  POST /api/caption   caption simplifier      (simple English + Punjabi/Hindi glosses)
  POST /api/check     private assistant       (private check + phrasing help)
  POST /api/nudge     nudge text              (gentle, specific, private)
  POST /api/peer      simulated peer uptake   (a peer builds on a shared idea)
  POST /api/summary   joint answer            (credits idea originators)

The endpoints call an LLM when a key is configured: OpenAI (OPENAI_API_KEY) or
Claude (ANTHROPIC_API_KEY).  Without a key, or on any API error, they fall back
to deterministic offline responses so the demo always runs.  Nothing is written
to disk: no audio, no video, no transcripts.

Keys can live in a local .env file next to this script (see .env.example).

Run:  uv run server.py            (live AI if a key is set)
      python3 server.py           (offline demo, no dependencies)
"""

import json
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent
STATIC = HERE / "static"


def load_dotenv(path):
    """Minimal .env reader (KEY=value lines); real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_dotenv(HERE / ".env")
PORT = int(os.environ.get("PORT", "8027"))

# --------------------------------------------------------------------------
# LLM client (optional). ECHO_PROVIDER=openai|anthropic overrides auto-detection.
# --------------------------------------------------------------------------

PROVIDER = os.environ.get("ECHO_PROVIDER") or (
    "openai" if os.environ.get("OPENAI_API_KEY") else "anthropic" if os.environ.get("ANTHROPIC_API_KEY") else None
)
if os.environ.get("ECHO_OFFLINE") == "1":
    PROVIDER = None
DEFAULT_MODELS = {"openai": "gpt-4.1-mini", "anthropic": "claude-opus-5-5"}
MODEL = os.environ.get("ECHO_MODEL") or DEFAULT_MODELS.get(PROVIDER)

client = None
llm_error = None
if PROVIDER:
    try:
        if PROVIDER == "openai":
            import openai

            client = openai.OpenAI(timeout=30.0, max_retries=1)
        else:
            import anthropic

            client = anthropic.Anthropic(timeout=30.0, max_retries=1)
    except Exception as e:  # missing package or bad config: stay offline
        llm_error = f"{type(e).__name__}: {e}"
        client = None


class Refused(Exception):
    pass


LATENCY_NOTE = "\n\nLatency-sensitive; this runs live during a classroom discussion. Answer immediately and briefly."


def ask_llm(system, user, schema):
    """One structured-output (JSON schema) call. Raises on any failure so callers can fall back."""
    if PROVIDER == "openai":
        resp = client.chat.completions.create(
            model=MODEL,
            max_tokens=1500,
            messages=[{"role": "system", "content": system + LATENCY_NOTE}, {"role": "user", "content": user}],
            response_format={"type": "json_schema", "json_schema": {"name": "echo_output", "strict": True, "schema": schema}},
        )
        msg = resp.choices[0].message
        if getattr(msg, "refusal", None):
            raise Refused()
        return json.loads(msg.content)

    resp = client.beta.messages.create(
        model=MODEL,
        max_tokens=4000,
        betas=["server-side-fallback-2026-07-01"],
        extra_body={"fallbacks": "default"},
        system=system + LATENCY_NOTE,
        messages=[{"role": "user", "content": user}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
    )
    if resp.stop_reason == "refusal":
        raise Refused()
    text = next(b.text for b in resp.content if b.type == "text")
    return json.loads(text)


def obj(props, required=None):
    return {
        "type": "object",
        "properties": props,
        "required": required or list(props),
        "additionalProperties": False,
    }


STR = {"type": "string"}
GLOSS = obj({"en": STR, "pa": STR, "hi": STR})
KEYWORD = obj({"en": STR, "home": STR})

LANG_NAMES = {"pa": "Punjabi (Gurmukhi script)", "hi": "Hindi (Devanagari script)", "en": "English"}

# --------------------------------------------------------------------------
# Prompts. The design rules from Section 4.2 are written into each one.
# --------------------------------------------------------------------------

CAPTION_SYSTEM = """You are the caption simplifier inside Echo, a tool for Class 11 students in Punjab, India, whose home languages are Punjabi and Hindi, during an English group discussion.

Rewrite the utterance into simple English (CEFR A2-B1, short sentences, at most about 25 words) that keeps the speaker's meaning and stance. Keep topic key terms unchanged (for example: stream, commerce, non-medical, social media).
Then pick the 1-3 words or phrases a hesitant English learner is most likely not to know, and give a short gloss for each in Punjabi (Gurmukhi script) and in Hindi (Devanagari script). Use everyday words a 16-year-old in Punjab would use, not formal or Sanskritised vocabulary. If no word is hard, return an empty list."""

CHECK_SYSTEM = """You are Echo, a private helper for one Class 11 student in Punjab, India, during an English group discussion with four classmates. Nobody else can see this conversation: not the group and not the teacher.

The student has an idea but is hesitant to say it in English. They wrote or spoke it to you, possibly in Punjabi, Hindi, English or a mix.

Follow these rules strictly:
1. Never judge the idea as right or wrong, good or bad. Do not correct its content, add facts, or argue. Treat it as worth testing with the group, e.g. "Interesting idea, let's test it with the group." Do not call it good, great, correct, smart, ਵਧੀਆ, ਸਹੀ, अच्छा or सही: praise is also a judgment. Say it is interesting or worth sharing.
2. The student speaks, not you. Give ONE suggested way to say their idea in simple English (CEFR A2-B1, at most about 25 words, natural spoken style, first person). Keep their meaning; do not make it smarter or longer than what they said. It is a suggestion they will put in their own words.
3. Give a short "starter" that links the idea to what the group just said (e.g. "Building on Meera's point, ..." or "Can I add something?").
4. Give 1-3 key English words from the suggestion with their meaning in the student's home language.
5. warm_reply: one or two short sentences TO the student, written in the student's own language/script (match how they wrote; if they mixed, you may mix). Encourage them to share. No lecturing.
6. If the message is not an idea about the discussion (e.g. they feel nervous, or ask what a word means), still respond helpfully and kindly in warm_reply, and put a simple English sentence they could say (or an empty string) in simple_english.
7. If the student expresses distress or anything about harm, respond kindly and suggest they talk to their teacher or a trusted adult; put an empty string in simple_english."""

NUDGE_SYSTEM = """You are Echo, a private helper for one quiet Class 11 student in an English group discussion in Punjab, India. The student has been silent for a while. Write ONE gentle private nudge that makes speaking easy: a concrete, low-risk question or short idea they could say, tied to what the group just said (e.g. "You could ask what happens if parents and students disagree."). Never pressure, never mention their silence, never evaluate them. nudge_en: simple English, at most 20 words. nudge_home: the same nudge in the student's home language and script."""

PEER_SYSTEM = """You simulate classmates in an online English group discussion among Class 11 students in Punjab, India (a research prototype; the peers are simulated, the student is real). A student has just shared an idea. Write the NEXT turn, by one of the listed peers, that genuinely takes up the idea: builds on it, asks a friendly question about it, or adopts it into the group's answer. Use natural, fluent but not fancy Indian-English teen speech, 1-2 sentences, at most 35 words. If the idea was shared anonymously, do not guess who said it; refer to it as "that idea" or "the point in the chat". Also give a simple-English caption and 1-2 glosses as for captions (Punjabi in Gurmukhi, Hindi in Devanagari)."""

SUMMARY_SYSTEM = """You help a five-student group in Punjab, India, finish a discussion by drafting their joint answer to the prompt, in simple English (3-4 sentences, at most 80 words). Use only ideas actually present in the transcript; do not add your own. Then list who contributed which idea, crediting the originator of each idea once. Ideas marked as anonymous must be credited to "A group member (anonymous)". Do not rank or evaluate students."""


def transcript_text(turns, limit=14):
    lines = []
    for t in (turns or [])[-limit:]:
        who = t.get("speaker", "?")
        if t.get("anonymous"):
            who = "A group member (anonymous, via chat)"
        lines.append(f"{who}: {t.get('text', '')}")
    return "\n".join(lines) or "(discussion has just started)"


# --------------------------------------------------------------------------
# Offline fallbacks (deterministic, honest about being canned)
# --------------------------------------------------------------------------

GURMUKHI = re.compile(r"[਀-੿]")
DEVANAGARI = re.compile(r"[ऀ-ॿ]")


def detect_lang(text, hint="en"):
    if GURMUKHI.search(text or ""):
        return "pa"
    if DEVANAGARI.search(text or ""):
        return "hi"
    return hint if hint in LANG_NAMES else "en"


# Ideas from the paper's walkthrough and their canned simple-English versions, so the
# offline demo can show the full private-check flow.  Matched by keywords.
OFFLINE_IDEAS = [
    {
        "keys": ["ਮਾਪ", "ਮੰਮੀ", "ਪਾਪਾ", "माता", "पापा", "parents", "ਮਾਤਾ"],
        "keys2": ["ਪਸੰਦ", "पसंद", "enjoy", "like", "ਮਿਲ", "मिल", "together", "ਨੌਕਰੀ", "नौकरी", "job"],
        "simple": "Parents know about careers, but students know what they enjoy. Both should decide together.",
        "words": [("careers", "ਨੌਕਰੀਆਂ / ਪੇਸ਼ੇ", "नौकरियाँ / पेशे"), ("decide together", "ਮਿਲ ਕੇ ਫੈਸਲਾ ਕਰਨਾ", "मिलकर फैसला करना")],
    },
    {
        "keys": ["ਫ਼ੋਨ", "ਫੋਨ", "फोन", "फ़ोन", "phone", "mobile", "ਮੋਬਾਈਲ", "मोबाइल"],
        "keys2": ["ਕਲਾਸ", "क्लास", "class", "ਜਮ੍ਹਾ", "जमा", "submit", "ban", "ਬੰਦ", "बंद"],
        "simple": "We should not ban phones fully. But students can keep phones away during class time.",
        "words": [("ban", "ਪਾਬੰਦੀ ਲਾਉਣਾ", "पाबंदी लगाना"), ("during class", "ਕਲਾਸ ਦੌਰਾਨ", "क्लास के दौरान")],
    },
]

WARM = {
    "pa": "ਦਿਲਚਸਪ ਵਿਚਾਰ ਹੈ! ਆਓ ਇਸਨੂੰ ਗਰੁੱਪ ਨਾਲ ਪਰਖੀਏ। ਤੁਸੀਂ ਇਸਨੂੰ ਆਪਣੇ ਸ਼ਬਦਾਂ ਵਿੱਚ ਕਹਿ ਸਕਦੇ ਹੋ।",
    "hi": "दिलचस्प विचार है! चलो इसे ग्रुप के साथ परखते हैं। तुम इसे अपने शब्दों में कह सकते हो।",
    "en": "Interesting idea! Let's test it with the group. You can say it in your own words.",
}


def offline_check(body):
    idea = body.get("idea", "")
    lang = detect_lang(idea, body.get("lang", "en"))
    low = idea.lower()
    for item in OFFLINE_IDEAS:
        if any(k.lower() in low for k in item["keys"]) and any(k.lower() in low for k in item["keys2"]):
            return {
                "warm_reply": WARM[lang],
                "simple_english": item["simple"],
                "starter": "Can I add something? ",
                "key_words": [{"en": en, "home": pa if lang == "pa" else hi} for en, pa, hi in item["words"]],
            }
    if lang == "en" and idea.strip():
        simple = idea.strip()
        simple = simple[0].upper() + simple[1:]
        if not simple.endswith((".", "?", "!")):
            simple += "."
    else:
        simple = ""  # cannot translate offline; the UI shows sentence starters instead
    return {
        "warm_reply": WARM[lang],
        "simple_english": simple,
        "starter": "I think ... because ...",
        "key_words": [],
    }


OFFLINE_NUDGES = {
    "stream": [
        ("You could ask what happens if parents and students disagree.",
         "ਤੁਸੀਂ ਪੁੱਛ ਸਕਦੇ ਹੋ: ਜੇ ਮਾਪੇ ਅਤੇ ਬੱਚੇ ਸਹਿਮਤ ਨਾ ਹੋਣ ਤਾਂ ਕੀ ਹੋਵੇ?",
         "तुम पूछ सकते हो: अगर माता-पिता और बच्चे सहमत न हों तो क्या हो?"),
        ("You could say one thing that helped you choose, or ask who should help students choose.",
         "ਤੁਸੀਂ ਪੁੱਛ ਸਕਦੇ ਹੋ: ਬੱਚਿਆਂ ਨੂੰ ਚੁਣਨ ਵਿੱਚ ਕੌਣ ਮਦਦ ਕਰੇ?",
         "तुम पूछ सकते हो: बच्चों को चुनने में कौन मदद करे?"),
        ("You could add one short sentence for the joint answer.",
         "ਤੁਸੀਂ ਸਾਂਝੇ ਜਵਾਬ ਲਈ ਇੱਕ ਛੋਟਾ ਵਾਕ ਜੋੜ ਸਕਦੇ ਹੋ।",
         "तुम साझा जवाब के लिए एक छोटा वाक्य जोड़ सकते हो।"),
    ],
    "phones": [
        ("You could ask: is the problem the phone, or how we use it?",
         "ਤੁਸੀਂ ਪੁੱਛ ਸਕਦੇ ਹੋ: ਸਮੱਸਿਆ ਫ਼ੋਨ ਹੈ ਜਾਂ ਅਸੀਂ ਇਸਨੂੰ ਕਿਵੇਂ ਵਰਤਦੇ ਹਾਂ?",
         "तुम पूछ सकते हो: समस्या फ़ोन है या हम उसे कैसे इस्तेमाल करते हैं?"),
        ("You could share one way phones help you study.",
         "ਤੁਸੀਂ ਦੱਸ ਸਕਦੇ ਹੋ ਕਿ ਫ਼ੋਨ ਪੜ੍ਹਾਈ ਵਿੱਚ ਕਿਵੇਂ ਮਦਦ ਕਰਦਾ ਹੈ।",
         "तुम बता सकते हो कि फ़ोन पढ़ाई में कैसे मदद करता है।"),
        ("You could add one short sentence for the joint answer.",
         "ਤੁਸੀਂ ਸਾਂਝੇ ਜਵਾਬ ਲਈ ਇੱਕ ਛੋਟਾ ਵਾਕ ਜੋੜ ਸਕਦੇ ਹੋ।",
         "तुम साझा जवाब के लिए एक छोटा वाक्य जोड़ सकते हो।"),
    ],
}


def offline_nudge(body):
    topic = body.get("topic_id", "stream")
    i = int(body.get("index", 0)) % 3
    en, pa, hi = OFFLINE_NUDGES.get(topic, OFFLINE_NUDGES["stream"])[i]
    return {"nudge_en": en, "nudge_home": pa if body.get("home_lang") == "pa" else hi}


def offline_peer(body):
    peers = body.get("peers") or ["Meera"]
    speaker = peers[int(body.get("index", 0)) % len(peers)]
    if body.get("anonymous"):
        text = "That point in the chat is really interesting. I think we should add it to our joint answer. What do others think?"
    else:
        text = f"That's a good point, {body.get('student', 'yaar')}. I hadn't thought of it that way. Can we build our answer around it?"
    return {
        "speaker": speaker,
        "text": text,
        "caption": {"simple": text, "glosses": []},
    }


def offline_summary(body):
    ideas = body.get("ideas", [])
    credits = [{"name": i.get("name", "?"), "idea": i.get("text", "")} for i in ideas]
    answer = " ".join(i.get("text", "").strip() for i in ideas[:3]) or "The group discussed both sides of the question."
    return {"joint_answer": answer, "credits": credits}


# --------------------------------------------------------------------------
# Endpoint handlers
# --------------------------------------------------------------------------


def h_caption(body):
    return ask_llm(
        CAPTION_SYSTEM,
        f"Discussion prompt: {body.get('prompt', '')}\nSpeaker: {body.get('speaker', '')}\nUtterance: {body.get('text', '')}",
        obj({"simple": STR, "glosses": {"type": "array", "items": GLOSS}}),
    )


def h_check(body):
    lang = detect_lang(body.get("idea", ""), body.get("lang", "en"))
    home = body.get("home_lang", "pa")
    return ask_llm(
        CHECK_SYSTEM,
        (
            f"Discussion prompt: {body.get('prompt', '')}\n"
            f"Student's home language: {LANG_NAMES.get(home, 'Punjabi')}\n"
            f"Language the student used now: {LANG_NAMES.get(lang, 'mixed')}\n\n"
            f"Recent discussion:\n{transcript_text(body.get('turns'))}\n\n"
            f"Student's private message to Echo:\n{body.get('idea', '')}"
        ),
        obj({
            "warm_reply": STR,
            "simple_english": STR,
            "starter": STR,
            "key_words": {"type": "array", "items": KEYWORD},
        }),
    )


def h_nudge(body):
    home = body.get("home_lang", "pa")
    return ask_llm(
        NUDGE_SYSTEM,
        (
            f"Discussion prompt: {body.get('prompt', '')}\n"
            f"Student's home language: {LANG_NAMES.get(home, 'Punjabi')}\n\n"
            f"Recent discussion:\n{transcript_text(body.get('turns'), 8)}"
        ),
        obj({"nudge_en": STR, "nudge_home": STR}),
    )


def h_peer(body):
    peers = body.get("peers") or ["Meera", "Arjun", "Rohan"]
    who = "an anonymous group member (posted in the chat)" if body.get("anonymous") else body.get("student", "the student")
    return ask_llm(
        PEER_SYSTEM,
        (
            f"Discussion prompt: {body.get('prompt', '')}\n"
            f"Peers you may speak as: {', '.join(peers)}\n"
            f"Peer personalities: {body.get('personas', '')}\n\n"
            f"Recent discussion:\n{transcript_text(body.get('turns'))}\n\n"
            f"The idea just shared by {who}:\n{body.get('idea', '')}"
        ),
        obj({
            "speaker": {"type": "string", "enum": peers},
            "text": STR,
            "caption": obj({"simple": STR, "glosses": {"type": "array", "items": GLOSS}}),
        }),
    )


def h_summary(body):
    return ask_llm(
        SUMMARY_SYSTEM,
        f"Discussion prompt: {body.get('prompt', '')}\n\nTranscript:\n{transcript_text(body.get('turns'), 60)}",
        obj({"joint_answer": STR, "credits": {"type": "array", "items": obj({"name": STR, "idea": STR})}}),
    )


ROUTES = {
    "/api/caption": (h_caption, None),  # offline captions come pre-baked in the client scripts
    "/api/check": (h_check, offline_check),
    "/api/nudge": (h_nudge, offline_nudge),
    "/api/peer": (h_peer, offline_peer),
    "/api/summary": (h_summary, offline_summary),
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_message(self, fmt, *args):  # keep the console quiet; no request content is logged
        if not self.path.startswith("/api/"):
            return
        sys.stderr.write(f"{self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}\n")

    def send_json(self, code, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/status":
            return self.send_json(200, {"live": client is not None, "provider": PROVIDER if client else None, "model": MODEL if client else None, "error": llm_error})
        return super().do_GET()

    def do_POST(self):
        route = ROUTES.get(self.path)
        if not route:
            return self.send_json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {"error": "bad json"})
        live_fn, offline_fn = route
        if client is not None:
            try:
                return self.send_json(200, {"source": "live", **live_fn(body)})
            except Refused:
                sys.stderr.write(f"{self.path}: model declined; using offline response\n")
            except Exception as e:  # network, auth, schema: never break the classroom session
                sys.stderr.write(f"{self.path}: {type(e).__name__}: {e}; using offline response\n")
        if offline_fn is None:
            return self.send_json(200, {"source": "none"})
        return self.send_json(200, {"source": "offline", **offline_fn(body)})


if __name__ == "__main__":
    mode = f"LIVE AI ({PROVIDER}: {MODEL})" if client else "OFFLINE DEMO (put OPENAI_API_KEY in .env and run `uv run server.py` for live AI)"
    if llm_error:
        mode += f"  [client error: {llm_error}]"
    print(f"Echo prototype on http://localhost:{PORT}  -  {mode}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
