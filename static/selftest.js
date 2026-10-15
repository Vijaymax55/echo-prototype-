// Headless smoke test: open index.html#selftest. Drives the whole C2 flow and
// writes PASS/FAIL lines into <pre id="selftest">. Not loaded in normal use.
const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 60000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await wait(200); } return true; };
const out = [];
const ok = (name, cond) => out.push(`${cond ? "PASS" : "FAIL"} ${name}`);
export async function run() {
  $("f-voices").checked = false;
  $("btn-start").click();
  ok("room shown", $("room").classList.contains("active"));
  ok("peer turn rendered", await until(() => document.querySelectorAll("#feed .msg").length >= 2));
  ok("captions + glosses shown", !!document.querySelector("#feed .cap") && !!document.querySelector("#feed .gl span"));
  ok("nudge after 2 silent rounds", await until(() => !$("nudge").hidden, 120000));
  $("nudge-no").click();
  ok("nudge dismissed", $("nudge").hidden);
  $("btn-idea").click();
  $("btn-example").click();
  $("check-send").click();
  ok("echo reply", await until(() => !$("reply").hidden));
  ok("simple english suggestion", $("reply-simple").textContent.includes("decide together"));
  $("share-own").click();
  ok("cue card shown", !$("cue").hidden);
  $("say").value = "I think parents and students should decide together.";
  $("composer").requestSubmit();
  ok("student turn in feed", !!document.querySelector("#feed .msg.me"));
  ok("peer takes up idea", await until(() => !!document.querySelector("#feed .uptake"), 30000));
  $("say").value = "Also schools can give better counselling.";
  $("composer").requestSubmit();
  $("btn-teacher").click();
  ok("teacher stats", $("t-stats").textContent.includes("unassisted"));
  ok("teacher shows assisted + own", $("t-ideas").textContent.includes("with Echo help") && $("t-ideas").textContent.includes("on their own"));
  ok("teacher view hides private text", !$("teacher").textContent.includes("ਮਾਪਿਆਂ"));
  $("teacher-x").click();
  $("btn-end").click();
  ok("joint answer", await until(() => !!document.querySelector("#e-answer .answer")));
  ok("end stats 50% own", $("e-stats").textContent.includes("50%"));
  const pre = document.createElement("pre"); pre.id = "selftest"; pre.textContent = out.join("\n");
  document.body.append(pre);
}
