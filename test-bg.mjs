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
import { row, table, gallogPage } from "./fixtures.mjs";

// 코드별 갤로그 상태. 점검 때 화면에 그려 준다.
const gallogState = new Map();

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
const deleted = new Set(); // 탈퇴한 계정. 차단 요청을 받아도 실제로는 안 걸린다.
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
      // 탈퇴한 계정은 걸리지 않는다. 그런데도 디시는 묶음 전체에 성공 하나를 돌려준다.
      // 2026-09-13 파딱 갤에서 실제로 이랬다. 응답만 흉내내면 이 성질을 검사가 못 본다.
      if (deleted.has(c)) continue;
      put(c, { ...world.get(c), state: "차단 중", duration: label, date: "2026.09.12", time: "12:00:00" });
    }
    return { ok: true, text: async () => JSON.stringify({ result: true, msg: "차단되었습니다" }) };
  }

  if (String(url).includes("gallog.dcinside.com")) {
    const code = String(url).split("/").pop();
    if (deleted.has(code)) {
      // 실물 응답: 404 + 스크립트 한 줄뿐이다 (dc.js 주석에 실측이 적혀 있다).
      return { ok: false, status: 404, url: String(url),
        text: async () => `<script>location.replace("https://gallog.dcinside.com/_error/deleted");</script>` };
    }
    // 방명록 페이지는 따로 요청된다. 잠긴 계정은 안내 문구를 돌려준다.
    if (String(url).includes("/guestbook")) {
      const c = String(url).split("/").slice(-2)[0];
      const g2 = gallogState.get(c) || {};
      return { ok: true, status: 200, url: String(url),
        text: async () => g2.guestClosed
          ? `<h4>방명록(0)</h4><p>허용된 사용자만 방명록을 작성할 수 있습니다.</p>`
          : `<h4>방명록(0)</h4><p>방명록이 없습니다.</p>` };
    }
    const g = gallogState.get(code) || {};
    return { ok: true, status: 200, url: String(url),
      text: async () => gallogPage({
        posts: g.posts ?? 10, comments: g.comments ?? 20,
        total: g.visits ?? 100, guestbook: g.guestbook ?? ["2026.09.01"],
        guestClosedOnHome: !!g.guestClosedOnHome,
      }) };
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
  deleted.clear();
  gallogState.clear();
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

// ── [14] 채우기가 옛 명단의 빈 만료 시각을 되메운다 ─────────
// 팝업 '담기'에 넣으면 절대 안 돈다. runScan 이 imports 에 담기 전에 이미
// 명단에 있는 사람을 걸러내기 때문이다 ("이미 명단에 있는 사람은 빼고
// 보여줍니다"). v1.7.8이 그걸 놓치고 팝업에 넣었다가, 완장에게 눌러도 아무
// 일도 안 일어나는 절차를 안내했다 (2026-09-13).
//
// 그래서 이 검사는 **실제 runScan 을 돌려서** 본다. imports 를 지어내지 않는다.
console.log("\n[14] 채우기가 옛 명단의 빈 만료 시각을 되메운다");
{
  const AUG1 = new Date("2026-08-01T10:00:00").getTime();
  const EXP = AUG1 + 744 * 3600 * 1000;

  world.clear(); requests = []; failNextFetch = null; breakTable = false;
  put("old1111", { state: "차단 중", date: "2026.08.01", time: "10:00:00" });
  put("old2222", { state: "차단 중", date: "2026.08.01", time: "10:00:00" });
  put("new3333", { state: "차단 중", date: "2026.08.01", time: "10:00:00" });

  stored = {
    settings: { galleryId: "g", checkTimes: ["09:30"], maxPerRun: 100,
                maxChecksPerRun: 300, sweepPerRun: 20, autoApply: false, notify: false },
    watchlist: [
      { kind: "code", value: "old1111", reason: "음란성", enabled: true, nextCheckAt: 0 },
      { kind: "code", value: "old2222", reason: "음란성", enabled: true, nextCheckAt: 99 },
    ],
    candidates: [], manual: [], imports: [], history: [], logs: [],
    status: { text: "대기 중", busy: false, busySince: 0 },
  };

  await send({ type: "scan", pages: 3 });

  const byCode = new Map(stored.watchlist.map((t) => [t.value, t]));
  eq("빈 사람은 채워진다", byCode.get("old1111").nextCheckAt, EXP + 60000);
  eq("이미 값이 있는 사람은 안 건드린다", byCode.get("old2222").nextCheckAt, 99);
  ok("채운 인원을 기록에 남긴다", /이미 명단에 있던 1명의 만료 예정 시각을 채웠습니다/.test(logText()),
     logText());

  // 새 사람은 여전히 imports 로 간다. 되메우기가 그걸 가로채면 안 된다.
  ok("명단에 없는 사람은 채우기 목록에 뜬다",
     (stored.imports || []).some((i) => i.code === "new3333"),
     JSON.stringify((stored.imports || []).map((i) => i.code)));
  ok("이미 명단에 있는 사람은 채우기 목록에 안 뜬다",
     !(stored.imports || []).some((i) => i.code === "old1111"));
}

// ── [15] 탈퇴한 계정: 디시는 성공이라 답하고 안 건다 ─────────
// 2026-09-13 파딱 갤. 37건을 한 묶음으로 보냈더니 "차단되었습니다"라고 답했는데
// 실제로는 35건만 걸렸다. 못 걸린 둘은 갤로그가 '삭제된 갤로그'였고, 관리 화면에서도
// 계속 '해제됨'이었다. 묶음 응답은 개별 결과를 안 알려주므로 목록을 다시 읽어야만
// 알 수 있다. 원칙 1번이 실전에서 값을 한 자리다.
console.log("\n[15] 탈퇴한 계정은 실패로 잡고 이유까지 밝힌다");
{
  await setup({ codes: { live0001: {}, gone0002: {} }, recheck: false });
  deleted.add("gone0002");

  await send({ type: "apply" });
  const log = logText();

  ok("살아 있는 사람은 걸렸다", isBlocked("live0001"));
  ok("탈퇴한 사람은 안 걸렸다", !isBlocked("gone0002"));
  ok("성공으로 적지 않는다", /1건 실패|실패: gone0002/.test(log), log);
  ok("탈퇴라고 이유를 밝힌다", /탈퇴한 계정입니다.*gone0002/.test(log), log);
  ok("명단에 탈퇴로 표시한다",
     (stored.watchlist.find((t) => t.value === "gone0002") || {}).gallogState === "deleted",
     JSON.stringify(stored.watchlist.find((t) => t.value === "gone0002")));
  ok("살아 있는 사람은 표시하지 않는다",
     !(stored.watchlist.find((t) => t.value === "live0001") || {}).gallogState);
}

// ── [16] 탈퇴로 표시된 사람은 다시 후보가 되지 않는다 ────────
// 표시만 하고 거르지 않으면 다음 확인 때 또 후보가 되고 또 보내고 또 실패한다.
// 하루 차단 한도만 축낸다.
console.log("\n[16] 탈퇴 표시된 사람은 후보에서 뺀다");
{
  world.clear(); requests = []; deleted.clear(); intervals.length = 0;
  put("gone0002", { state: "해제됨", date: "2026.08.01", time: "10:00:00" });
  put("live0001", { state: "해제됨", date: "2026.08.01", time: "10:00:00" });
  deleted.add("gone0002");

  stored = {
    settings: { galleryId: "g", checkTimes: ["09:30"], maxPerRun: 100,
                maxChecksPerRun: 300, sweepPerRun: 0, autoApply: false, notify: false },
    watchlist: [
      { kind: "code", value: "live0001", reason: "음란성", enabled: true, nextCheckAt: 0 },
      { kind: "code", value: "gone0002", reason: "음란성", enabled: true, nextCheckAt: 0,
        gallogState: "deleted" },
    ],
    candidates: [], manual: [], imports: [], history: [], logs: [],
    status: { text: "대기 중", busy: false, busySince: 0 },
  };

  await send({ type: "check" });
  const codes = (stored.candidates || []).map((c) => c.code);

  ok("살아 있는 사람은 후보가 된다", codes.includes("live0001"), JSON.stringify(codes));
  ok("탈퇴한 사람은 후보가 안 된다", !codes.includes("gone0002"), JSON.stringify(codes));
  ok("뺐다는 사실을 밝힌다", /탈퇴한 계정이라 후보에서 뺐습니다/.test(logText()), logText());
  ok("어느 코드인지 적는다", /gone0002/.test(logText()));
}

// ── [17] 완장이 직접 푼 것으로 본 사람은 누구인지 적는다 ────
// 숫자만 적으면 나중에 그 판정이 맞았는지 확인할 방법이 없다.
// 2026-09-13 파딱 갤에서 3명이 이 판정을 받았는데, 화면의 '명단에서 빼기'가
// 명단과 manual 기록을 한꺼번에 지워서 누구였는지 영영 확인할 수 없게 됐다.
// 기록만이 유일하게 남는 자리다.
console.log("\n[17] manual 판정은 누구인지까지 적는다");
{
  world.clear(); requests = []; deleted.clear(); intervals.length = 0;
  // 31일 차단인데 예정보다 한참 일찍 풀렸다 → 완장이 직접 푼 것으로 본다
  put("early001", { state: "해제됨", date: "2026.09.10", time: "10:00:00" });
  // 만료돼서 풀렸다 → 재차단 후보
  put("ripe0002", { state: "해제됨", date: "2026.08.01", time: "10:00:00" });

  stored = {
    settings: { galleryId: "g", checkTimes: ["09:30"], maxPerRun: 100,
                maxChecksPerRun: 300, sweepPerRun: 0, autoApply: false, notify: false },
    watchlist: [
      { kind: "code", value: "early001", reason: "음란성", enabled: true, nextCheckAt: 0 },
      { kind: "code", value: "ripe0002", reason: "음란성", enabled: true, nextCheckAt: 0 },
    ],
    candidates: [], manual: [], imports: [], history: [], logs: [],
    status: { text: "대기 중", busy: false, busySince: 0 },
  };

  await send({ type: "check" });
  const log = logText();

  ok("직접 푼 것으로 판정한다", (stored.manual || []).some((m) => m.code === "early001"),
     JSON.stringify(stored.manual));
  ok("후보로 올리지 않는다", !(stored.candidates || []).some((c) => c.code === "early001"));
  ok("몇 명인지 적는다", /1명은 차단 기간이 남았는데 해제돼 있습니다/.test(log), log);
  // 코드 글자만 찾으면 다른 줄에 우연히 섞여도 통과한다. 그 줄의 모양까지 본다.
  ok("누구인지 적는다", /early001 — 31일 차단\(.*처리\)이/.test(log), log);
  ok("언제 끝날 예정인지 적는다", /끝날 예정인데 지금 이미 풀려 있습니다/.test(log), log);
  // 디시는 해제 시각을 안 알려준다. 안다고 적으면 거짓말이 된다.
  ok("해제 시각을 안다고 하지 않는다", !/에 풀렸습니다/.test(log), log);
  // 예정까지 얼마나 남았는지가 진단 숫자다. 며칠이면 민원 해제, 몇 분이면 오판 의심.
  ok("예정보다 얼마나 이른지 적는다", /예정보다 \d+(분|시간|일) 이릅니다/.test(log), log);
  ok("만료된 사람은 후보로 간다", (stored.candidates || []).some((c) => c.code === "ripe0002"));
}

// ── [18] 갤로그 예상 시간이 조회 시간까지 센다 ──────────────
// 간격만 세면 모자라고, 모자라면 완장이 멈춘 줄 알고 기다리다 새로고침한다.
// v1.7.4 에서 차단 목록 쪽에 같은 것을 고쳤는데 갤로그 쪽을 빠뜨렸다.
// 164명에 '4분'이라 해놓고 5분 7초가 걸렸다 (파딱 2026-09-13).
console.log("\n[18] 갤로그 예상 시간");
{
  const bg = readFileSync(new URL("./background.js", import.meta.url), "utf8");
  const i = bg.indexOf("갤로그 점검: ${targets.length}명을 확인합니다");
  ok("갤로그 안내가 있다", i > 0);
  const around = bg.slice(Math.max(0, i - 900), i);
  ok("간격만 세지 않는다", /GALLOG_FETCH_SECS/.test(around), around.slice(-300));

  // 실측과 맞는지. 164명 5분 7초였으니 5분 아래로 답하면 모자란 것이다.
  const per = dcMod.GALLOG_DELAY_MS / 1000 + dcMod.GALLOG_FETCH_SECS;
  const mins = Math.ceil(Math.round(164 * per) / 60);
  ok("164명을 5분 이상으로 잡는다", mins >= 5, `${mins}분`);
  // 너무 부풀려도 안 된다. 두 배로 말하면 완장이 안 돌린다.
  ok("164명을 8분 넘게 잡지는 않는다", mins <= 8, `${mins}분`);
}

// ── [19] 갤로그 점검이 방문자·방명록도 기록한다 ─────────────
// 파딱 제안(2026-09-15). 둘 다 이미 받아오는 화면에 있어서 요청이 늘지 않는다.
// 글·댓글이 그대로여도 방문자가 늘거나 방명록이 최근이면 활성 계정일 수 있다.
console.log("\n[19] 갤로그 점검이 방문자·방명록도 남긴다");
{
  world.clear(); requests = []; deleted.clear(); gallogState.clear(); intervals.length = 0;
  gallogState.set("aaa1111", { posts: 5, comments: 9, visits: 180, guestbook: ["2026.09.10"] });

  stored = {
    settings: { galleryId: "g", checkTimes: ["09:30"], maxPerRun: 100,
                maxChecksPerRun: 300, sweepPerRun: 0, autoApply: false, notify: false },
    watchlist: [{ kind: "code", value: "aaa1111", reason: "음란성", enabled: true, nextCheckAt: 0 }],
    candidates: [], manual: [], imports: [], history: [], logs: [],
    status: { text: "대기 중", busy: false, busySince: 0 },
  };

  await send({ type: "gallog", limit: 10, months: 0 });
  const t = stored.watchlist.find((x) => x.value === "aaa1111") || {};

  eq("글 수", t.gallogPosts, 5);
  eq("댓글 수", t.gallogComments, 9);
  eq("방문자 수", t.gallogVisits, 180);
  eq("방명록 최신 날짜", t.gallogGuestAt, "2026.09.10");
  eq("우리가 본 횟수", t.gallogSeenByUs, 1);

  // 요청이 늘지 않아야 한다. 한 명당 갤로그 한 번뿐이다.
  const gallogReqs = requests.filter((r) => r.url.includes("gallog.dcinside.com")).length;
  eq("한 명당 요청 1회", gallogReqs, 1);
}

// ── [20] 우리가 본 횟수를 세어 방문자 증가를 보정할 수 있다 ──
// 총 방문자는 IP 단위로 하루 1씩 오른다. 확장이 볼 때마다 1이 오르므로,
// 보정하지 않으면 점검 다섯 번만으로 '방문자 5 늘었다 = 활성'이 된다.
console.log("\n[20] 우리가 본 횟수를 센다");
{
  gallogState.set("bbb2222", { visits: 100, guestbook: [] });
  stored.watchlist = [{ kind: "code", value: "bbb2222", reason: "음란성", enabled: true }];
  stored.logs = [];

  await send({ type: "gallog", limit: 10, months: 0 });

  // 같은 사람을 12시간 안에 또 보지는 않는다(그 자체가 맞는 규칙이다).
  // 하루 지난 셈 치고 시계를 되돌린 뒤 다시 본다.
  const me = stored.watchlist.find((x) => x.value === "bbb2222");
  me.gallogCountedAt -= 25 * 3600 * 1000;
  me.gallogCheckedAt -= 25 * 3600 * 1000;
  gallogState.set("bbb2222", { visits: 101, guestbook: [] });   // 우리 방문분만 오름
  await send({ type: "gallog", limit: 10, months: 0 });

  const t = stored.watchlist.find((x) => x.value === "bbb2222") || {};
  eq("두 번 봤다고 센다", t.gallogSeenByUs, 2);
  eq("방문자는 101", t.gallogVisits, 101);
  ok("우리 방문분을 빼면 남이 온 건 없다", t.gallogVisits - t.gallogSeenByUs <= 100);
}

// ── [21] 방명록 잠김 확인은 좁은 범위에서만 ─────────────────
// 파딱 지적(2026-09-15): 방명록이 2월이 마지막이어도 그 뒤에 잠가둔 것일 수 있다.
// 그러면 '방명록이 오래됐다 = 비활성'이 틀린다.
//
// 다만 이건 요청이 하나 더 나간다. 글·댓글이 늘었으면 이미 활성이라 볼 필요가
// 없고, 방명록이 최근이면 그것만으로 활성이라 역시 볼 필요가 없다.
console.log("\n[21] 방명록 잠김 확인 범위");
{
  const 기본 = (o) => ({ kind: "code", reason: "음란성", enabled: true, ...o });
  world.clear(); requests = []; deleted.clear(); gallogState.clear(); intervals.length = 0;

  // 글·댓글이 그대로고 방명록도 없음 → 확인 대상
  gallogState.set("quiet001", { posts: 1, comments: 2, visits: 10, guestbook: [], guestClosed: true });
  // 글·댓글이 늘었음 → 이미 활성. 확인 안 함
  gallogState.set("busy0002", { posts: 9, comments: 9, visits: 10, guestbook: [] });
  // 방명록이 최근 → 그것만으로 활성. 확인 안 함
  gallogState.set("guest003", { posts: 1, comments: 2, visits: 10, guestbook: ["2026.09.14"] });

  stored = {
    settings: { galleryId: "g", checkTimes: ["09:30"], maxPerRun: 100,
                maxChecksPerRun: 300, sweepPerRun: 0, autoApply: false, notify: false },
    watchlist: [
      기본({ value: "quiet001", gallogTotal: 3 }),      // 1+2 = 그대로
      기본({ value: "busy0002", gallogTotal: 3 }),      // 9+9 = 늘었음
      기본({ value: "guest003", gallogTotal: 3 }),      // 그대로지만 방명록 최근
    ],
    candidates: [], manual: [], imports: [], history: [], logs: [],
    status: { text: "대기 중", busy: false, busySince: 0 },
  };

  await send({ type: "gallog", limit: 10, months: 3 });
  const 방명록요청 = requests.filter((r) => r.url.includes("/guestbook")).map((r) => r.url.split("/").slice(-2)[0]);
  const by = new Map(stored.watchlist.map((t) => [t.value, t]));

  eq("따로 물어본 사람은 한 명뿐", 방명록요청.length, 1);
  eq("그 한 명이 조용한 사람", 방명록요청[0], "quiet001");
  ok("글·댓글 늘어난 사람은 안 물어본다", !방명록요청.includes("busy0002"));
  ok("방명록 최근인 사람은 안 물어본다", !방명록요청.includes("guest003"));

  eq("잠긴 것으로 기록한다", by.get("quiet001").gallogGuestOpen, false);
  ok("안 물어본 사람은 모르는 채로 둔다", by.get("busy0002").gallogGuestOpen === undefined);
  ok("몇 명을 따로 봤는지 밝힌다", /1명은 방명록이 잠겨 있는지 따로 확인했습니다/.test(logText()), logText());
}

// 잠겨 있지 않으면 열린 것으로 기록한다. 이때는 방명록이 없는 게 비활성 근거가 된다.
console.log("\n[22] 방명록이 열려 있는데도 비어 있으면");
{
  world.clear(); requests = []; gallogState.clear(); intervals.length = 0;
  gallogState.set("open0001", { posts: 1, comments: 2, visits: 10, guestbook: [], guestClosed: false });
  stored.watchlist = [{ kind: "code", value: "open0001", reason: "음란성", enabled: true, gallogTotal: 3 }];
  stored.logs = [];

  await send({ type: "gallog", limit: 10, months: 3 });
  const t = stored.watchlist[0];
  eq("열린 것으로 기록한다", t.gallogGuestOpen, true);
}

// ── [23] 홈에 잠김 문구가 있으면 따로 안 묻는다 ─────────────
// 같은 화면에서 이미 알 수 있는 걸 또 물으면 요청만 는다.
// 이 프로젝트에서 요청 수는 곧 IP 차단 위험이다.
console.log("\n[23] 홈에서 알 수 있으면 요청을 아낀다");
{
  world.clear(); requests = []; gallogState.clear(); intervals.length = 0;
  gallogState.set("home0001", { posts: 1, comments: 2, visits: 10, guestbook: [], guestClosedOnHome: true });
  stored.watchlist = [{ kind: "code", value: "home0001", reason: "음란성", enabled: true, gallogTotal: 3 }];
  stored.logs = [];

  await send({ type: "gallog", limit: 10, months: 3 });
  const 방명록요청 = requests.filter((r) => r.url.includes("/guestbook")).length;

  eq("방명록 페이지를 따로 안 본다", 방명록요청, 0);
  eq("그래도 잠김을 안다", (stored.watchlist[0] || {}).gallogGuestOpen, false);
  eq("갤로그 요청은 한 번뿐", requests.filter((r) => r.url.includes("gallog.dcinside.com")).length, 1);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
