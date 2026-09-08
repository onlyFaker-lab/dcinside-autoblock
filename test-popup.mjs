// test-popup.mjs — 실제 popup.js 를 돌려서 화면 동작을 검사한다.
//
// 인수인계서에는 jsdom 을 쓰라고 되어 있는데, 설치 없이 돌아가도록
// 필요한 만큼만 DOM 을 흉내냈다. 검사 대상 함수를 여기 옮겨 적지 않는다.
// popup.js 원본을 그대로 읽어서 실행하므로, 원본이 바뀌면 여기서 잡힌다.
//
//   node test-popup.mjs

import { readFileSync } from "node:fs";
import vm from "node:vm";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

// ── 최소 DOM ────────────────────────────────────────────────
// popup.html 에 실제로 있는 id 만 요소로 만든다. 없는 id 를 부르면
// 바로 터지므로, popup.js 가 오타난 id 를 쓰면 여기서 걸린다.

function makeEl(id, tag = "div", attrs = {}) {
  const el = {
    id, tagName: tag.toUpperCase(),
    value: attrs.value || "", textContent: "", innerHTML: "",
    checked: false, indeterminate: false, disabled: false,
    dataset: { ...(attrs.dataset || {}) },
    _classes: new Set((attrs.class || "").split(/\s+/).filter(Boolean)),
    _handlers: {},
    addEventListener(type, fn) { (this._handlers[type] ||= []).push(fn); },
    dispatchEvent(ev) {
      for (const fn of this._handlers[ev.type] || []) fn({ ...ev, target: ev.target || this });
    },
    insertAdjacentHTML(_pos, html) { this.innerHTML += html; },
    focus() {},
    click() { this.dispatchEvent({ type: "click", target: this }); },
    closest(sel) {
      const cls = sel.replace(/^\./, "");
      return this._classes.has(cls) ? this : null;
    },
    querySelectorAll: () => [],
  };
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c),
    toggle: (c, on) => (on === undefined
      ? (el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c))
      : (on ? el._classes.add(c) : el._classes.delete(c))),
  };
  return el;
}

const html = readFileSync(new URL("./popup.html", import.meta.url), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const els = new Map();
for (const id of ids) els.set(id, makeEl(id));

// 화면에 그려진 체크박스는 tbody 의 innerHTML 에서 뽑아 만든다.
// popup.js 가 만든 HTML 을 실제로 읽으므로, 클래스 이름이 어긋나면 잡힌다.
function scrapeChecks(cls) {
  const out = [];
  for (const el of els.values()) {
    if (!el.innerHTML) continue;
    const re = new RegExp(`<input[^>]*class="${cls}"[^>]*>`, "g");
    for (const m of el.innerHTML.match(re) || []) {
      const code = (m.match(/data-code="([^"]*)"/) || [])[1] || "";
      const box = makeEl("", "input", { class: cls, dataset: { code } });
      box.checked = / checked/.test(m);
      out.push(box);
    }
  }
  return out;
}

const document = {
  getElementById(id) {
    if (!els.has(id)) throw new Error(`popup.html 에 없는 id: ${id}`);
    return els.get(id);
  },
  querySelectorAll(sel) {
    if (sel === ".tab" || sel === ".panel") return [];
    return scrapeChecks(sel.replace(/^\./, ""));
  },
  createElement: (tag) => makeEl("", tag),
};

// ── chrome / 브라우저 API ───────────────────────────────────
const stored = {};
const sent = [];
let confirmAnswer = true;
const alerts = [];

const chrome = {
  storage: {
    local: {
      get: async (k) => (k === null ? { ...stored } : { [k]: stored[k] }),
      set: async (obj) => Object.assign(stored, obj),
    },
    onChanged: { addListener() {} },
  },
  runtime: { sendMessage: (m) => sent.push(m) },
};

const saved = [];
const sandbox = {
  document, chrome, console,
  confirm: () => confirmAnswer,
  alert: (m) => alerts.push(m),
  setTimeout, clearTimeout, Date, Math, JSON, Set, Map, Object, Array, String, Number,
  RegExp, Error, Promise, isNaN, parseInt, parseFloat,
  navigator: { clipboard: { writeText: async () => {} } },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  Blob: class { constructor(parts) { saved.push(String(parts[0])); } },
  Event: class { constructor(type) { this.type = type; } },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const src = readFileSync(new URL("./popup.js", import.meta.url), "utf8");
vm.runInContext(src, sandbox, { filename: "popup.js" });

// popup.js 는 마지막에 load() 를 부른다. storage 가 비어 있어도 render() 까지
// 무사히 도는지가 첫 검사다. 여기서 터지면 팝업이 백지로 뜬다는 뜻이다.
await new Promise((r) => setTimeout(r, 0));

console.log("\n[1] 빈 상태에서 화면이 그려진다");
ok("load/render 통과", els.get("cleanEmpty").innerHTML !== undefined);
ok("머리글 체크박스 꺼짐", els.get("cleanAll").disabled === true);

// 상태를 심고 다시 그린다
async function seed(patch) {
  Object.assign(stored, {
    settings: { galleryId: "90_00_memory", checkTimes: ["09:30"], maxPerRun: 100,
                maxChecksPerRun: 300, sweepPerRun: 20, autoApply: false, notify: true },
    watchlist: [], candidates: [], manual: [], imports: [], history: [], logs: [],
    status: { text: "대기 중", busy: false, busySince: 0 },
    ...patch,
  });
  await sandbox.load();
}

console.log("\n[2] 날짜를 넣으면 페이지 수가 아니라 날짜가 기준이다");
{
  await seed({});
  const pages = els.get("scanPages");
  const until = els.get("scanUntil");

  pages.value = "10";
  until.value = "";
  until.dispatchEvent({ type: "change" });
  ok("날짜 없으면 페이지 입력 살아 있음", pages.disabled === false);
  sent.length = 0;
  els.get("btnScan").click();
  ok("날짜 없으면 입력한 페이지 수", sent[0].pages === 10, JSON.stringify(sent[0]));

  until.value = "2026-06-01";
  until.dispatchEvent({ type: "change" });
  ok("날짜 넣으면 페이지 입력 잠김", pages.disabled === true);
  ok("안내 문구 뜸", els.get("scanMode").textContent.includes("날짜 기준"));
  sent.length = 0;
  els.get("btnScan").click();
  ok("페이지 상한이 안전장치로 올라감", sent[0].pages === 3000, String(sent[0].pages));
  ok("날짜가 그대로 전달됨", sent[0].until === "2026-06-01");

  until.value = "";
  until.dispatchEvent({ type: "change" });
  ok("날짜 지우면 되돌아옴", pages.disabled === false);
  sent.length = 0;
  els.get("btnScan").click();
  ok("다시 페이지 기준", sent[0].pages === 10);
}

console.log("\n[3] 명단 내보내기는 메모까지, 후보 내보내기는 코드와 사유만");
{
  await seed({
    watchlist: [
      { kind: "code", value: "capture6180", reason: "도배", memo: "짤 도배범", enabled: true },
      { kind: "code", value: "chip3298", reason: "혐오 콘텐츠", memo: "", enabled: false },
    ],
    candidates: [
      { code: "leaf4517", reason: "욕설", label: "leaf4517", nick: "ㅇㅇ", memo: "비밀 메모" },
    ],
  });

  saved.length = 0;
  confirmAnswer = true;
  els.get("btnExportList").click();
  const list = JSON.parse(saved[0]);
  ok("명단 파일 what", list.what === "watchlist");
  ok("메모 보존", list.items[0].memo === "짤 도배범");
  ok("사유 보존", list.items[1].reason === "혐오 콘텐츠");
  ok("사용 여부 보존", list.items[1].enabled === false);

  saved.length = 0;
  els.get("btnExportCand").click();
  const cand = JSON.parse(saved[0]);
  ok("후보 파일 what", cand.what === "candidates");
  ok("후보에 메모 없음", cand.items[0].memo === undefined, JSON.stringify(cand.items[0]));
  ok("후보에 닉 없음", cand.items[0].nick === undefined);
  ok("후보 사유는 있음", cand.items[0].reason === "욕설");
}

console.log("\n[4] 명단 파일을 다시 불러오면 사유와 메모가 살아난다");
{
  await seed({});
  const file = {
    kind: "dcblock-share", what: "watchlist", formatVersion: 2,
    gallery: "90_00_memory", exportedAt: new Date().toISOString(), count: 3,
    items: [
      { code: "capture6180", reason: "도배", memo: "짤 도배범", enabled: true },
      { code: "chip3298", reason: "혐오 콘텐츠", memo: "", enabled: false },
      { code: "read7286", reason: "정치갤러", memo: "옛 사유", enabled: true },
    ],
  };
  alerts.length = 0;
  confirmAnswer = true;
  await sandbox.importItems(file.items, file.exportedAt);

  const wl = stored.watchlist;
  ok("3명 들어감", wl.length === 3, String(wl.length));
  ok("사유가 음란성으로 뭉개지지 않음", wl[0].reason === "도배", wl[0].reason);
  ok("공백 있는 사유도 보존", wl[1].reason === "혐오 콘텐츠", wl[1].reason);
  ok("메모 복원", wl[0].memo === "짤 도배범", wl[0].memo);
  ok("사용 여부 복원", wl[1].enabled === false);
  ok("모르는 사유는 음란성으로", wl[2].reason === "음란성", wl[2].reason);

  // 옛 파일(formatVersion 1, 메모 없음)도 그대로 읽혀야 한다
  await seed({});
  await sandbox.importItems([{ code: "leaf4517", reason: "욕설" }], null);
  ok("옛 파일도 읽힘", stored.watchlist[0].reason === "욕설");
  ok("메모 없으면 빈 문자열", stored.watchlist[0].memo === "");
  ok("메모 없어도 사용은 켜짐", stored.watchlist[0].enabled === true);
}

console.log("\n[5] 명단 정리 표의 머리글 체크박스");
{
  await seed({
    watchlist: [
      { kind: "code", value: "aaa1111", reason: "도배", memo: "", enabled: true,
        gallogState: "deleted" },
      { kind: "code", value: "bbb2222", reason: "욕설", memo: "", enabled: true,
        gallogState: "notfound" },
      { kind: "code", value: "ccc3333", reason: "광고", memo: "", enabled: true,
        noPostSince: "2026-06-01" },
      { kind: "code", value: "ddd4444", reason: "광고", memo: "", enabled: true },
    ],
  });

  const head = els.get("cleanAll");
  ok("정리 대상 3명만 표에 뜸", (els.get("cleanBody").innerHTML.match(/cleanchk/g) || []).length === 3);
  ok("처음엔 전원 선택", head.checked === true && head.indeterminate === false);
  ok("삭제 버튼 살아 있음", els.get("btnCleanDel").disabled === false);

  head.checked = false;
  head.dispatchEvent({ type: "change", target: head });
  ok("머리글 해제 → 전원 해제", els.get("cleanCount").textContent.includes("3명 중 0명"),
     els.get("cleanCount").textContent);
  ok("머리글도 꺼짐", els.get("cleanAll").checked === false);
  ok("삭제 버튼 잠김", els.get("btnCleanDel").disabled === true);

  head.checked = true;
  head.dispatchEvent({ type: "change", target: head });
  ok("머리글 선택 → 전원 선택", els.get("cleanCount").textContent.includes("3명 중 3명"));

  // 한 명만 손으로 풀면 중간 표시가 되어야 한다
  els.get("cleanBody").dispatchEvent({
    type: "change",
    target: makeEl("", "input", { class: "cleanchk", dataset: { code: "aaa1111" } }),
  });
  ok("일부 선택은 중간 표시", els.get("cleanAll").indeterminate === true);
  ok("일부 선택 개수", els.get("cleanCount").textContent.includes("3명 중 2명"));
}

console.log("\n[6] 갤로그 변동 없는 사람이 목록에 오른다");
{
  const DAY = 24 * 3600 * 1000;
  const now = Date.now();
  await seed({
    watchlist: [
      // 100일째 숫자 그대로 → 3개월(90일) 넘음
      { kind: "code", value: "quiet001", reason: "도배", memo: "", enabled: true,
        gallogState: "alive", gallogTotal: 361, gallogPosts: 29, gallogComments: 332,
        gallogSince: now - 100 * DAY },
      // 10일째 → 아직 아님
      { kind: "code", value: "fresh002", reason: "욕설", memo: "", enabled: true,
        gallogState: "alive", gallogTotal: 50, gallogPosts: 10, gallogComments: 40,
        gallogSince: now - 10 * DAY },
      // 방금 첫 기록 → 비교 대상이 없으니 나오면 안 된다
      { kind: "code", value: "first003", reason: "광고", memo: "", enabled: true,
        gallogState: "alive", gallogTotal: 7, gallogPosts: 7, gallogComments: 0,
        gallogSince: now },
    ],
  });

  const body = els.get("cleanBody").innerHTML;
  ok("오래 조용한 사람은 목록에", body.includes("quiet001"));
  ok("최근에 활동한 사람은 제외", !body.includes("fresh002"));
  ok("첫 기록은 제외", !body.includes("first003"), "첫 점검에서 판정하면 안 된다");
  ok("숫자를 보여줌", body.includes("글 29 / 댓 332"), body.slice(0, 400));
  ok("며칠째인지 보여줌", body.includes("100일째 그대로"));

  // 기간을 12개월로 올리면 100일짜리는 빠져야 한다
  els.get("cleanMonths").value = "12";
  await sandbox.load();
  ok("기간을 늘리면 빠짐", !els.get("cleanBody").innerHTML.includes("quiet001"));
  els.get("cleanMonths").value = "3";
  await sandbox.load();
  ok("되돌리면 다시 나옴", els.get("cleanBody").innerHTML.includes("quiet001"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
