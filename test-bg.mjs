// test-bg.mjs — 실제 background.js 를 돌려서 재차단 실행 경로를 검사한다.
//
//   node test-bg.mjs
//
// 왜 필요했나.
// v1.7.6 의 '실행 전에 후보를 다시 확인' 은 검사 257개를 전부 통과하면서도
// 켜는 순간 터졌다. analyzeCode 에 entry 를 안 넘겨서 "아직 풀려 있다"는
// 정상 경로에서 TypeError 가 났다. 그때 검사는 background.js 를 문자열로 읽어
// `if (settings.recheckBeforeApply)` 가 있는지, 중단 문구가 있는지만 봤다.
// 소스에 글자가 있는지 보는 검사는 그 글자가 실제로 도는지는 말해주지 않는다.
//
// 그래서 test-popup.mjs 와 같은 방식으로 원본을 그대로 돌린다. 가짜 디시를
// 세워 두고 fetch 를 받아서, 요청이 몇 번 나갔는지까지 센다.
// 검사 대상 로직을 여기 옮겨 적지 않는다. 옮겨 적으면 복사본만 검사하게 된다.

import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as dcMod from "./dc.js";
import { row, table } from "./fixtures.mjs";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${extra}`); }
}
function eq(name, got, want) {
  ok(name, got === want, `기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`);
}

// 실행 경로에는 1.2초 간격과 검증 전 1초 대기가 박혀 있다. 그대로 두면 검사
// 하나에 몇 초씩 걸린다. 순서(매크로태스크)는 그대로 두고 시간만 0으로 만든다.
// dc.js 도 이 전역을 쓰므로 여기서 한 번 바꾸면 양쪽에 다 먹는다.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...rest) => realSetTimeout(fn, 0, ...rest);

// ── 가짜 디시 ────────────────────────────────────────────────
// 코드별 현재 상태를 들고 있다가 목록 요청에 그대로 그려 준다.
// POST 가 들어오면 실제로 상태를 바꾼다. 서버 응답만 흉내내면
// "차단되었습니다 라고 답하고 아무 일도 안 한다"는 실제 디시의 성질을
// 검사가 못 보게 된다 (원칙 1번).

const world = new Map();   // code → { state, duration, date, time, reason, nik }
let requests = [];         // 나간 요청 전부. 몇 번 나갔는지가 이 프로젝트에선 중요하다.
let failNextFetch = null;  // 다음 조회를 실패시킬 때
let breakTable = false;    // 상태 칸을 못 읽는 표를 돌려줄 때

function put(code, o = {}) {
  world.set(code, {
    nik: "ㅇㅇ", state: "해제됨", duration: "31일", reason: "음란성",
    date: "2026.08.01", time: "10:00:00", ...o,
  });
}

function listHtml(codes) {
  const rows = codes.map((code, i) => {
    const w = world.get(code);
    const html = row({ num: 600 + i, dataNum: 900 + i, code, ...w });
    // 상태 칸 클래스를 망가뜨리면 parseBlockList 가 stateUnknown 으로 표시한다.
    // 실제로 v1.5.2 에서 이 자리가 깨져 전원이 '차단 중'으로 보였다.
    return breakTable ? html.replace('class="blockstate txtbtn"', 'class="blahstate"') : html;
  });
  return `<html><body>${table(rows)}</body></html>`;
}

// dc.js 는 진짜 모듈로 import 되므로 sandbox 가 아니라 전역의 fetch/chrome 을 쓴다.
// 여기를 안 바꾸면 진짜 fetch 가 나가서 "fetch failed" 로 전부 실패한다.
const fakeFetch = async (url, opts = {}) => {
  requests.push({ url: String(url), method: opts.method || "GET" });

  if (String(url) === dcMod.AVOID_API) {
    const body = new URLSearchParams(opts.body);
    const codes = body.get("user_codes").split("\n").filter(Boolean);
    const label = Object.entries(dcMod.HOURS_BY_LABEL)
      .find(([, h]) => String(h) === body.get("avoid_hour"))?.[0] || "31일";
    for (const c of codes) {
      put(c, { ...world.get(c), state: "차단 중", duration: label, date: "2026.09.12", time: "12:00:00" });
    }
    return { ok: true, text: async () => JSON.stringify({ result: true, msg: "차단되었습니다" }) };
  }

  const u = new URL(String(url));
  const keyword = u.searchParams.get("s_keyword");
  const page = Number(u.searchParams.get("p") || 1);

  if (keyword) {
    if (failNextFetch) { const e = failNextFetch; failNextFetch = null; throw new Error(e); }
    return { ok: true, text: async () => listHtml(world.has(keyword) ? [keyword] : []) };
  }
  // 전체 목록. 1페이지에 전부 있고 2페이지부터 비어서 순회가 끝난다.
  return {
    ok: true,
    text: async () => (page > 1 ? listHtml([]) : listHtml([...world.keys()])),
  };
};

// ── 가짜 크롬 ────────────────────────────────────────────────
let stored = {};
let msgListener = null;
const alarms = [];
const chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null || keys === undefined) return { ...stored };
        const ks = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
        const out = {};
        for (const k of ks) if (k in stored) out[k] = stored[k];
        return out;
      },
      async set(patch) { Object.assign(stored, patch); },
    },
  },
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { msgListener = fn; } },
  },
  alarms: { create(...a) { alarms.push(a); }, onAlarm: { addListener() {} } },
  notifications: { create() {} },
  cookies: { async get() { return { value: "fake-ci-token" }; } },
};

// ── background.js 를 원본 그대로 돌린다 ──────────────────────
// popup.js 와 같은 방식이다. vm 은 import 를 못 하므로 그 줄만 걷어내고
// 가져오려던 것을 sandbox 에 넣는다. 규칙은 dc.js 의 진짜 함수를 그대로 쓴다.
const raw = readFileSync(new URL("./background.js", import.meta.url), "utf8");
const RE_IMPORT = /import\s*\{([\s\S]*?)\}\s*from\s*"\.\/dc\.js";?/g;
const wanted = [...raw.matchAll(RE_IMPORT)]
  .flatMap((m) => m[1].split(",").map((x) => x.trim()).filter(Boolean));
if (!wanted.length) throw new Error("background.js 에서 dc.js import 를 찾지 못했습니다");

// keepAlive 가 실제로 걸리는지 보려고 감싼다. background.js 는 setInterval 로
// 20초마다 chrome API 를 부른다. MV3 서비스워커는 30초 동안 chrome API 호출이
// 없으면 종료되는데 fetch 와 setTimeout 은 그 타이머를 되살리지 못한다.
const intervals = [];
const sandbox = {
  chrome, console, fetch: fakeFetch,
  setInterval: (fn, ms) => { intervals.push({ ms, fn, live: true }); return intervals.length; },
  clearInterval: (id) => { if (intervals[id - 1]) intervals[id - 1].live = false; },
  setTimeout: globalThis.setTimeout, clearTimeout, Date, Math, JSON,
  Set, Map, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
  URLSearchParams, URL, isNaN, parseInt, parseFloat, Infinity,
};
for (const name of wanted) {
  if (!(name in dcMod)) throw new Error(`dc.js 에 없는 것을 background.js 가 가져오려 합니다: ${name}`);
  sandbox[name] = dcMod[name];
}
sandbox.globalThis = sandbox;
globalThis.fetch = fakeFetch;     // dc.js 쪽
globalThis.chrome = chrome;       // dc.js 의 getCiToken 이 쿠키를 읽는다
vm.createContext(sandbox);
vm.runInContext(raw.replace(RE_IMPORT, ""), sandbox, { filename: "background.js" });

ok("background.js 가 통째로 돈다", msgListener !== null);

// 메시지 핸들러는 sendResponse 로 답한다. 약속으로 감싼다.
function send(msg) {
  return new Promise((resolve) => {
    msgListener(msg, {}, resolve);
  });
}

// ── 판 깔기 ──────────────────────────────────────────────────
async function setup({ codes, recheck = true, maxPerRun = 100, candidatesAt = Date.now() }) {
  world.clear();
  intervals.length = 0;
  requests = [];
  failNextFetch = null;
  breakTable = false;
  for (const [code, o] of Object.entries(codes)) put(code, o);

  stored = {
    settings: {
      galleryId: "90_00_memory", checkTimes: ["09:30", "21:30"],
      maxPerRun, maxChecksPerRun: 300, sweepPerRun: 20,
      autoApply: false, notify: false, recheckBeforeApply: recheck,
    },
    watchlist: Object.keys(codes).map((c) => ({ kind: "code", value: c, reason: "음란성", enabled: true })),
    candidates: Object.keys(codes).map((c) => ({ code: c, reason: "음란성", nick: "ㅇㅇ", label: `ㅇㅇ (${c})`, memo: "" })),
    manual: [], imports: [], history: [], logs: [],
    candidatesAt,
    status: { text: "대기 중", busy: false, busySince: 0 },
  };
}

const logText = () => (stored.logs || []).map((l) => (typeof l === "string" ? l : l.text || l.message || JSON.stringify(l))).join("\n");
const searches = () => requests.filter((r) => r.method === "GET" && r.url.includes("s_keyword=")).length;
const posts = () => requests.filter((r) => r.method === "POST").length;
const isBlocked = (c) => world.get(c).state === "차단 중" && world.get(c).duration === "31일";

// ── [1] 재확인을 켜도 아직 풀려 있는 사람은 그대로 보낸다 ────
// v1.7.6 이 여기서 터졌다. 가장 흔한 경로이고, 이 기능을 켜는 이유 그 자체다.
console.log("\n[1] 재확인 켬 — 아직 풀려 있으면 보낸다");
{
  await setup({ codes: { capture6180: {}, chip3298: {} } });
  const res = await send({ type: "apply" });

  ok("터지지 않고 끝난다", res && res.ok !== false, JSON.stringify(res));
  ok("오류가 기록에 없다", !/Cannot read properties|undefined/.test(logText()), logText());
  ok("두 명 다 31일로 걸렸다", isBlocked("capture6180") && isBlocked("chip3298"));
  ok("모두 풀려 있다고 알린다", /모두 아직 풀려 있습니다/.test(logText()));
  ok("차단 요청이 실제로 나갔다", posts() >= 1, `POST ${posts()}회`);
  ok("후보가 비워졌다", (stored.candidates || []).length === 0);
  ok("이력에 2건 남았다", (stored.history || []).length >= 1);
}

// ── [2] 사유가 승계된다 ──────────────────────────────────────
// entry 를 안 넘기면 터지고, 아무거나 넘기면 사유가 바뀐다. 둘 다 아닌지 본다.
// 파딱 갤 4533명이 전원 직접 입력 사유라 이 자리가 중요하다.
console.log("\n[2] 재확인을 거쳐도 사유가 그대로 간다");
{
  await setup({ codes: { leaf4517: { reason: "벌레" } } });
  stored.candidates = [{ code: "leaf4517", reason: "벌레", nick: "ㅇㅇ", label: "ㅇㅇ (leaf4517)", memo: "메모" }];
  await send({ type: "apply" });

  const sent = requests.find((r) => r.method === "POST");
  ok("직접 입력 사유로 보냈다", /avoid_reason=0/.test(String(sent && sent.url)) || /벌레/.test(logText()), logText());
  ok("사유가 기록에 남았다", /벌레/.test(logText()));
}

// ── [3] 그 사이 다른 완장이 차단했으면 뺀다 ──────────────────
console.log("\n[3] 이미 차단된 사람은 빼고 보낸다");
{
  await setup({ codes: { aaa0001: {}, aaa0002: { state: "차단 중", date: "2026.09.11" } } });
  const res = await send({ type: "apply" });

  ok("한 명만 보냈다", res.ok !== false && isBlocked("aaa0001"));
  ok("몇 명을 뺐는지 알린다", /1명은 그 사이에 이미 차단됐습니다/.test(logText()), logText());
  ok("한도를 아꼈다고 말한다", /하루 차단 한도를 아꼈습니다/.test(logText()));
}

// ── [4] 전원이 이미 차단돼 있으면 한 건도 안 보낸다 ──────────
console.log("\n[4] 전원 이미 차단 — 보내지 않는다");
{
  await setup({ codes: { bbb1: { state: "차단 중" }, bbb2: { state: "차단 중" } } });
  const res = await send({ type: "apply" });

  eq("차단 요청 0회", posts(), 0);
  ok("보낼 사람이 없다고 말한다", /보낼 사람이 없습니다/.test(logText()), logText());
  ok("후보를 비운다", (stored.candidates || []).length === 0);
  ok("실패로 적지 않는다", !/실패/.test(logText()), logText());
  eq("skipped 로 돌려준다", res.skipped, 2);
}

// ── [5] 판정이 바뀐 사람은 '이미 차단됨'으로 뭉개지 않는다 ──
// 목록에서 사라진 것(해제 기록 30일 보관 만료)과 이미 차단된 것은 다르다.
// 한 문장으로 뭉개면 왜 안 막혔는지 알 수 없게 된다 (원칙 2번).
console.log("\n[5] 판정이 바뀐 사람은 따로 알린다");
{
  await setup({ codes: { ccc1: {} } });
  stored.candidates = [
    { code: "ccc1", reason: "음란성", nick: "ㅇㅇ", label: "ㅇㅇ (ccc1)", memo: "" },
    { code: "ghost999", reason: "음란성", nick: "ㅇㅇ", label: "ㅇㅇ (ghost999)", memo: "" },
  ];
  await send({ type: "apply" });

  ok("목록에 없는 사람을 따로 말한다", /판정이 바뀌어/.test(logText()), logText());
  ok("어느 코드인지 적는다", /ghost999/.test(logText()));
  ok("이미 차단됐다고 하지 않는다", !/ghost999.*이미 차단/.test(logText()));
  ok("나머지 한 명은 보냈다", isBlocked("ccc1"));
}

// ── [6] 한도 검사가 재확인보다 먼저다 ────────────────────────
// 순서가 반대면 후보 수만큼 조회를 전부 내보낸 뒤에 중단한다. 한 명도 못 막으면서
// 사람당 한 요청이 나가는 것이라 IP 차단 사고와 모양이 같다 (5-5절).
console.log("\n[6] 한도를 넘으면 조회조차 하지 않는다");
{
  await setup({ codes: { d1: {}, d2: {}, d3: {} }, maxPerRun: 2 });
  const res = await send({ type: "apply" });

  ok("실행하지 않는다", res.ok === false);
  eq("재확인 조회 0회", searches(), 0);
  eq("차단 요청 0회", posts(), 0);
  ok("한도 때문이라고 말한다", /한도\(2건\)를 넘습니다/.test(logText()), logText());
  ok("후보는 그대로 남는다", (stored.candidates || []).length === 3);
}

// ── [7] 재확인 중 조회가 실패하면 보내지 않는다 ──────────────
console.log("\n[7] 재확인이 실패하면 한 명도 안 보낸다");
{
  await setup({ codes: { e1: {}, e2: {} } });
  failNextFetch = "로그인이 풀린 것 같습니다. 디시에 다시 로그인해 주세요.";
  const res = await send({ type: "apply" });

  ok("실행하지 않는다", res.ok === false);
  eq("차단 요청 0회", posts(), 0);
  ok("중단이라고 말한다", /\[중단\] 다시 확인하는 중에 실패/.test(logText()), logText());
  ok("후보를 그대로 둔다", (stored.candidates || []).length === 2);
  ok("잠금을 푼다", stored.status.busy === false);
}

// ── [8] 표를 못 읽으면 그 판정으로 사람을 빼지 않는다 ────────
// 상태 칸을 못 읽으면 released 가 전부 false 라, 아직 풀려 있는 사람이
// '이미 차단됨'으로 보인다. 그대로 빼면 조용히 재차단을 건너뛴다.
console.log("\n[8] 표를 못 읽으면 멈춘다");
{
  await setup({ codes: { f1: {}, f2: {} } });
  breakTable = true;
  const res = await send({ type: "apply" });

  ok("실행하지 않는다", res.ok === false);
  eq("차단 요청 0회", posts(), 0);
  ok("제대로 못 읽었다고 말한다", /제대로 읽지 못했습니다/.test(logText()), logText());
  ok("'이미 차단됨'으로 넘어가지 않는다", !/이미 차단됐습니다/.test(logText()));
  ok("후보를 그대로 둔다", (stored.candidates || []).length === 2);
}

// ── [9] 재확인을 끄면 조회가 아예 안 나간다 ──────────────────
// 완장이 한 명뿐인 갤에서는 조회만 늘고 얻는 게 없다. 기본이 꺼짐인 이유다.
console.log("\n[9] 재확인 끔 — 조회가 늘지 않는다");
{
  await setup({ codes: { g1: {}, g2: {} }, recheck: false });
  const before = searches();
  await send({ type: "apply" });

  ok("재확인 문구가 없다", !/다시 봅니다/.test(logText()), logText());
  ok("두 명 다 걸렸다", isBlocked("g1") && isBlocked("g2"));
  ok("조회는 검증용만 나갔다", searches() >= before);
}

// ── [10] 도는 동안 잠기고, 끝나면 풀린다 ─────────────────────
// 재확인도 사람당 한 요청씩 나가는 긴 작업이다. 안 잠그면 그 사이 알람이
// 정기 확인을 띄워 두 경로가 겹쳐 돈다. 요청이 두 배가 된다.
console.log("\n[10] 재확인 도는 동안 잠긴다");
{
  await setup({ codes: { h1: {}, h2: {} } });
  let sawBusyDuringRecheck = false;
  const spy = new Proxy(fakeFetch, {
    apply(target, thisArg, args) {
      if (String(args[0]).includes("s_keyword=") && stored.status && stored.status.busy) {
        sawBusyDuringRecheck = true;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  sandbox.fetch = spy;
  globalThis.fetch = spy;
  await send({ type: "apply" });
  sandbox.fetch = fakeFetch;
  globalThis.fetch = fakeFetch;

  ok("재확인 조회 때 잠겨 있다", sawBusyDuringRecheck);
  ok("끝나면 풀린다", stored.status.busy === false);
}

// ── [11] 후보가 없으면 아무 일도 안 한다 ─────────────────────
console.log("\n[11] 후보 0명");
{
  await setup({ codes: {} });
  stored.candidates = [];
  const res = await send({ type: "apply" });
  ok("조용히 끝난다", res.ok === true);
  eq("요청 0회", requests.length, 0);
}

// ── [12] 긴 작업 동안 워커를 살려 둔다 ──────────────────────
// MV3 서비스워커는 30초 동안 chrome API 호출이 없으면 종료된다. fetch 와
// setTimeout 은 그 타이머를 되살리지 못한다. 2026-09-12 파딱 기록에서 300명
// 조회가 50명에서 죽었다 — 진행 기록이 25명마다라 33초 간격이었기 때문이다.
console.log("\n[12] 긴 작업 동안 워커 유지");
{
  await setup({ codes: { k1: {}, k2: {} } });
  await send({ type: "apply" });

  const ka = intervals[0];
  ok("keepAlive 가 걸린다", !!ka);
  ok("30초 문턱보다 짧다", ka && ka.ms < 30000, ka ? `${ka.ms}ms` : "없음");
  ok("끝나면 해제된다", ka && ka.live === false);

  // 콜백이 실제로 chrome API 를 부르는지. 안 부르면 타이머만 돌고 워커는 죽는다.
  stored.status = { text: "도는 중", busy: true, busySince: 1 };
  await ka.fn();
  await new Promise((r) => realSetTimeout(r, 0));
  ok("콜백이 chrome API 를 불러 잠금을 갱신한다", stored.status.busySince > 1,
     String(stored.status.busySince));
}

// ── [13] 죽어도 그때까지 조회한 것은 남는다 ──────────────────
// 끝에 한꺼번에 저장하면 워커가 죽을 때 통째로 사라지고, 그 사람들은
// nextCheckAt 이 그대로라 다음 차례에 똑같이 뽑혀 똑같은 자리에서 또 죽는다.
console.log("\n[13] 조회 결과를 중간에 저장한다");
{
  const bg = readFileSync(new URL("./background.js", import.meta.url), "utf8");
  const loop = bg.slice(bg.indexOf("for (let i = 0; i < targets.length; i++)"),
                        bg.indexOf("} catch (e) {", bg.indexOf("for (let i = 0; i < targets.length; i++)")));
  ok("루프 안에서 명단을 저장한다", /saveWatchlistUpdates\(updates\)/.test(loop), "루프 안에 없음");
  ok("저장한 뒤 비운다", /updates\.clear\(\)/.test(loop), "clear 가 없음");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
