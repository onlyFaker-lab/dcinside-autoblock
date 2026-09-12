// test-popup.mjs — 실제 popup.js 를 돌려서 화면 동작을 검사한다.
//
// 인수인계서에는 jsdom 을 쓰라고 되어 있는데, 설치 없이 돌아가도록
// 필요한 만큼만 DOM 을 흉내냈다. 검사 대상 함수를 여기 옮겨 적지 않는다.
// popup.js 원본을 그대로 읽어서 실행하므로, 원본이 바뀌면 여기서 잡힌다.
//
//   node test-popup.mjs

import { readFileSync } from "node:fs";
import * as dcMod from "./dc.js";
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
    // 자기 innerHTML 에서 요소를 긁어온다. popup.js 가 그린 HTML 을 실제로
    // 읽으므로 클래스 이름이나 value 가 어긋나면 여기서 잡힌다.
    querySelectorAll(sel) {
      const cls = sel.replace(/^\./, "");
      const out = [];
      const re = new RegExp(`<input[^>]*class="${cls}"[^>]*>`, "g");
      for (const m of (this.innerHTML || "").match(re) || []) {
        const el = makeEl("", "input", { class: cls });
        el.value = (m.match(/value="([^"]*)"/) || [])[1] || "";
        el.checked = / checked/.test(m);
        el.dataset.code = (m.match(/data-code="([^"]*)"/) || [])[1] || "";
        out.push(el);
      }
      return out;
    },
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
const confirmTexts = [];
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
  confirm: (m) => { confirmTexts.push(String(m)); return confirmAnswer; },
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

// popup.js 는 브라우저에서 type="module" 로 실려서 import 가 된다. vm 은 안 되므로
// import 줄만 걷어내고, 가져오려던 것을 sandbox 에 직접 넣어준다. 규칙 자체는
// dc.js 의 진짜 함수를 그대로 쓰므로 검사가 복사본을 보는 일은 없다.
const raw = readFileSync(new URL("./popup.js", import.meta.url), "utf8");
const wanted = [...raw.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\/dc\.js";?/g)]
  .flatMap((m) => m[1].split(",").map((x) => x.trim()).filter(Boolean));
for (const name of wanted) {
  if (!(name in dcMod)) throw new Error(`dc.js 에 없는 것을 popup.js 가 가져오려 합니다: ${name}`);
  sandbox[name] = dcMod[name];
}
const src = raw.replace(/import\s*\{[^}]+\}\s*from\s*"\.\/dc\.js";?/g, "");
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
  // 예전엔 드롭다운 7개에 없으면 '음란성'으로 바꿨다. 그게 파딱 갤 4533명을
  // 통째로 음란성으로 만든 원인이다. 완장들은 '직접 입력'을 주로 쓴다.
  ok("직접 입력 사유는 원문 그대로", wl[2].reason === "정치갤러", wl[2].reason);

  // 사유 칸이 아예 없는 항목만 음란성으로 간다. 이건 복원할 방법이 없다.
  await seed({});
  await sandbox.importItems([{ code: "leaf4517", memo: "", enabled: true }], null);
  ok("사유 없는 항목만 음란성", stored.watchlist[0].reason === "음란성",
     stored.watchlist[0].reason);

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


// ── 명단 사유 수정 / 중지만 보기 / 직접 입력 사유 ──────────
// 파딱 요청(2026-09-09):
//  · 이미 등록된 사람의 사유·메모를 고칠 수 있게
//  · 중지된 사람만 모아볼 수 있게
//  · 명단에 넣을 때도 직접 입력 사유를 쓸 수 있게 (파딱 갤 4533명이 전원 직접 입력)
{
  console.log("\n[명단 수정 · 거르기 · 직접 입력 사유]");
  const click = (el, dataset) =>
    el.dispatchEvent({ type: "click", target: { dataset, closest: () => null } });

  await seed({
    watchlist: [
      { kind: "code", value: "aaa1111", reason: "벌레", memo: "메모A", enabled: true },
      { kind: "code", value: "bbb2222", reason: "광고", memo: "메모B", enabled: false },
      { kind: "code", value: "ccc3333", reason: "음란성", memo: "", enabled: true },
    ],
  });
  const lb = els.get("listBody");

  ok("수정 버튼이 생겼다", lb.innerHTML.includes("수정"), lb.innerHTML.slice(0, 200));
  ok("중지/삭제도 그대로", lb.innerHTML.includes("중지") && lb.innerHTML.includes("삭제"));

  // ── 중지만 보기 ─────────────────────────────────────────
  els.get("listFilter").value = "off";
  els.get("listFilter").dispatchEvent({ type: "change" });
  ok("중지만: 중지된 사람만", lb.innerHTML.includes("bbb2222"));
  ok("중지만: 사용 중인 사람 제외", !lb.innerHTML.includes("aaa1111"));

  els.get("listFilter").value = "on";
  els.get("listFilter").dispatchEvent({ type: "change" });
  ok("사용만: 중지된 사람 제외", !lb.innerHTML.includes("bbb2222"));
  ok("사용만: 사용 중인 사람 포함", lb.innerHTML.includes("ccc3333"));

  els.get("listFilter").value = "all";
  els.get("listFilter").dispatchEvent({ type: "change" });
  ok("전체로 되돌림", lb.innerHTML.includes("bbb2222") && lb.innerHTML.includes("aaa1111"));

  // ── 사유로 찾기 ─────────────────────────────────────────
  els.get("listSearch").value = "벌레";
  els.get("listSearch").dispatchEvent({ type: "input" });
  ok("직접 입력 사유로도 찾힌다", lb.innerHTML.includes("aaa1111"));
  ok("사유가 다른 사람은 빠진다", !lb.innerHTML.includes("ccc3333"));
  els.get("listSearch").value = "";
  els.get("listSearch").dispatchEvent({ type: "input" });

  // ── 수정 → 저장 ─────────────────────────────────────────
  click(lb, { edit: "0" });
  ok("수정 모드에 입력칸이 뜬다", lb.innerHTML.includes("editReason"), lb.innerHTML.slice(0, 300));
  ok("기존 사유가 채워져 있다", lb.innerHTML.includes('value="벌레"'));
  ok("저장·취소 버튼", lb.innerHTML.includes("저장") && lb.innerHTML.includes("취소"));

  // 입력칸 값을 바꾼 것처럼 innerHTML 을 고쳐두고 저장한다
  lb.innerHTML = lb.innerHTML
    .replace('value="벌레"', 'value="분탕"')
    .replace('value="메모A"', 'value="메모A 수정"');
  click(lb, { save: "0" });
  await new Promise((r) => setTimeout(r, 0));
  ok("사유가 바뀌었다", stored.watchlist[0].reason === "분탕", stored.watchlist[0].reason);
  ok("메모도 바뀌었다", stored.watchlist[0].memo === "메모A 수정", stored.watchlist[0].memo);
  ok("식별코드는 안 건드림", stored.watchlist[0].value === "aaa1111");
  ok("사용 여부도 그대로", stored.watchlist[0].enabled === true);

  // ── 취소하면 안 바뀐다 ──────────────────────────────────
  click(lb, { edit: "2" });
  lb.innerHTML = lb.innerHTML.replace('value="음란성"', 'value="바뀌면안됨"');
  click(lb, { cancel: "2" });
  await new Promise((r) => setTimeout(r, 0));
  ok("취소하면 그대로", stored.watchlist[2].reason === "음란성", stored.watchlist[2].reason);

  // ── 20자를 넘기면 자른다 (디시 한도) ────────────────────
  click(lb, { edit: "2" });
  lb.innerHTML = lb.innerHTML.replace('value="음란성"', `value="${"가".repeat(30)}"`);
  click(lb, { save: "2" });
  await new Promise((r) => setTimeout(r, 0));
  ok("20자로 잘림", [...stored.watchlist[2].reason].length === 20,
     `${[...stored.watchlist[2].reason].length}자`);

  // ── 빈 사유는 거절 ──────────────────────────────────────
  const before = stored.watchlist[2].reason;
  click(lb, { edit: "2" });
  lb.innerHTML = lb.innerHTML.replace(/class="editReason"[^>]*value="[^"]*"/,
                                      'class="editReason" value="   "');
  click(lb, { save: "2" });
  await new Promise((r) => setTimeout(r, 0));
  ok("빈 사유는 저장 안 됨", stored.watchlist[2].reason === before, stored.watchlist[2].reason);

  // ── 한 명 추가에서 직접 입력 사유 ───────────────────────
  els.get("listFilter").value = "all";
  els.get("newCode").value = "ddd4444";
  els.get("newReason").value = "__custom__";
  els.get("newReason").dispatchEvent({ type: "change" });
  ok("직접 입력을 고르면 칸이 보인다",
     !els.get("newReasonTxt").classList.contains("hidden"));
  els.get("newReasonTxt").value = "벌레";
  els.get("btnAdd").click();
  await new Promise((r) => setTimeout(r, 0));
  const added = stored.watchlist.find((t) => t.value === "ddd4444");
  ok("직접 입력 사유로 추가된다", added && added.reason === "벌레",
     added ? added.reason : "안 들어감");

  // 아는 사유를 고르면 칸이 숨는다
  els.get("newReason").value = "광고";
  els.get("newReason").dispatchEvent({ type: "change" });
  ok("아는 사유면 칸이 숨는다", els.get("newReasonTxt").classList.contains("hidden"));

  // ── 여러 명 한 번에도 직접 입력이 돼야 한다 ─────────────
  // 파딱 갤은 4533명을 한꺼번에 넣는다. 여기가 막히면 소용이 없다.
  els.get("bulkText").value = "eee5555\nfff6666";
  els.get("bulkReason").value = "__custom__";
  els.get("bulkReason").dispatchEvent({ type: "change" });
  ok("여러 명: 직접 입력 칸이 보인다",
     !els.get("bulkReasonTxt").classList.contains("hidden"));
  els.get("bulkReasonTxt").value = "분탕";
  els.get("btnBulkAdd").click();
  await new Promise((r) => setTimeout(r, 0));
  const bulk = stored.watchlist.filter((t) => ["eee5555", "fff6666"].includes(t.value));
  ok("여러 명이 다 들어감", bulk.length === 2, `${bulk.length}명`);
  ok("전원 직접 입력 사유", bulk.every((t) => t.reason === "분탕"),
     JSON.stringify(bulk.map((t) => t.reason)));

  // 직접 입력을 골라놓고 비워두면 막아야 한다. 그냥 넣으면 사유가 빈 채로
  // 명단에 들어가고, 재차단할 때 디시가 거절한다.
  const n = stored.watchlist.length;
  els.get("bulkText").value = "ggg7777";
  els.get("bulkReasonTxt").value = "";
  els.get("btnBulkAdd").click();
  await new Promise((r) => setTimeout(r, 0));
  ok("빈 직접 입력은 막는다", stored.watchlist.length === n, `${stored.watchlist.length} vs ${n}`);
}

// ── 갤로그 기록 공유 ───────────────────────────────────────
// 이미 명단에 있는 사람이라도 갤로그 기록은 받아와야 한다. 예전에는 코드가
// 겹치면 통째로 건너뛰어서, 명단이 같은 완장끼리는 아무것도 못 넘겼다.
console.log("\n[갤로그 기록 공유]");
{
  const DAY = 86400000, now = Date.now();
  await seed({
    watchlist: [
      { kind: "code", value: "capture6180", reason: "벌레", memo: "", enabled: true,
        gallogTotal: 100, gallogSince: now - 10 * DAY, gallogCountedAt: now - 1 * DAY },
      { kind: "code", value: "chip3298", reason: "벌레", memo: "", enabled: true },
    ],
  });
  alerts.length = 0;
  confirmAnswer = true;
  await sandbox.importItems([
    { code: "capture6180", reason: "벌레",
      gallogTotal: 100, gallogSince: now - 90 * DAY, gallogCountedAt: now - 30 * DAY },
    { code: "chip3298", reason: "벌레",
      gallogTotal: 42, gallogSince: now - 60 * DAY, gallogCountedAt: now - 60 * DAY },
  ], null);

  const wl = stored.watchlist;
  ok("사람은 안 늘어남", wl.length === 2, String(wl.length))
  ok("처음 본 시각이 넓어짐", wl[0].gallogSince === now - 90 * DAY, String(wl[0].gallogSince))
  ok("마지막으로 잰 시각은 유지", wl[0].gallogCountedAt === now - 1 * DAY, String(wl[0].gallogCountedAt))
  ok("기록 없던 사람은 받아옴", wl[1].gallogTotal === 42, String(wl[1].gallogTotal))
  ok("몇 명분 받았는지 알려줌",
     alerts.some((m) => /갤로그 기록/.test(m)), alerts.join(" | "));
}

// 내보낸 파일에 갤로그 기록이 들어가야 넘길 수 있다.
console.log("\n[갤로그 기록 내보내기]");
{
  const now = Date.now();
  await seed({
    watchlist: [
      { kind: "code", value: "leaf4517", reason: "실험2", memo: "", enabled: true,
        gallogTotal: 7, gallogSince: now - 5000, gallogCountedAt: now - 100 },
      { kind: "code", value: "read7286", reason: "벌레", memo: "", enabled: true },
    ],
  });
  saved.length = 0;
  confirmAnswer = true;
  els.get("btnExportList").dispatchEvent(new sandbox.Event("click"));
  const file = JSON.parse(saved[saved.length - 1]);
  ok("두 명 다 나감", file.items.length === 2, String(file.items.length))
  ok("갤로그 숫자가 들어감", file.items[0].gallogTotal === 7, String(file.items[0].gallogTotal))
  ok("잰 적 없는 사람은 칸이 없다", file.items[1].gallogTotal === undefined,
     JSON.stringify(file.items[1]));
}



// ── 실행 전 재확인 토글 ────────────────────────────────────
// 완장이 한 명뿐인 갤에서는 조회만 늘고 얻는 게 없다. 기본은 꺼져 있어야 하고,
// 꺼져 있으면 '다시 봅니다' 안내가 뜨면 안 된다. 그 문구가 뜨는데 실제로는
// 안 보면, 완장은 걸러진 줄 알고 안심하게 된다.
console.log("\n[실행 전 재확인 토글]");
{
  const cand = [{ code: "capture6180", label: "ㅇㅇ", reason: "벌레" }];

  await seed({ candidates: cand, settings: { galleryId: "g" } });
  ok("기본값은 꺼짐", els.get("cfgRecheck").checked === false);
  confirmAnswer = true;
  sent.length = 0;
  els.get("btnApply").dispatchEvent(new sandbox.Event("click"));
  const offMsg = confirmTexts[confirmTexts.length - 1] || "";
  ok("꺼져 있으면 다시 본다고 하지 않음", !/다시 봅니다/.test(offMsg), offMsg);

  await seed({ candidates: cand, settings: { galleryId: "g", recheckBeforeApply: true } });
  ok("설정을 켜면 켜져 보임", els.get("cfgRecheck").checked === true);
  els.get("btnApply").dispatchEvent(new sandbox.Event("click"));
  const onMsg = confirmTexts[confirmTexts.length - 1] || "";
  ok("켜져 있으면 다시 본다고 알림", /다시 봅니다/.test(onMsg), onMsg);
  ok("이미 차단된 사람은 뺀다고 알림", /빼고 보냅니다/.test(onMsg), onMsg);
}

// ── 채우기에서 담을 때 만료 예정 시각이 따라간다 ────────────
// 안 따라가면 nextCheckAt 이 0 이 되고, 0 은 '한 번도 못 봤다'는 뜻이라
// 만료가 한 달 남은 사람까지 매번 조회 대상이 된다. 파딱 갤 4577명이 그랬다.
console.log("\n[채우기 → 명단, 만료 예정 시각]");
{
  const AUG1 = new Date("2026-08-01T10:00:00").getTime();
  const EXP = AUG1 + 744 * 3600 * 1000;          // 31일 뒤
  await seed({
    imports: [
      { code: "aaa1111", reason: "음란성", date: "2026.08.01", expireAt: EXP },
      { code: "bbb2222", reason: "벌레", date: "2026.08.01", expireAt: null },
      { code: "ccc3333", reason: "음란성", date: "2026.08.01", expireAt: EXP },
    ],
    // 이미 명단에 있고 만료 시각을 모르는 사람. 옛 버전으로 담은 명단이 이 모양이다.
    watchlist: [{ kind: "code", value: "ccc3333", reason: "음란성", enabled: true, nextCheckAt: 0 }],
  });

  confirmAnswer = true;
  alerts.length = 0;
  els.get("btnScanAdd").click();
  await new Promise((r) => setTimeout(r, 0));

  const byCode = new Map(stored.watchlist.map((t) => [t.value, t]));
  ok("만료 시각을 아는 사람은 그때까지 안 본다", byCode.get("aaa1111").nextCheckAt === EXP + 60000,
     String(byCode.get("aaa1111").nextCheckAt));
  ok("모르는 사람은 0 (바로 조회 대상)", byCode.get("bbb2222").nextCheckAt === 0,
     String(byCode.get("bbb2222").nextCheckAt));
  ok("이미 있던 사람은 중복으로 안 담긴다", stored.watchlist.filter((t) => t.value === "ccc3333").length === 1);
  ok("이미 있던 사람의 빈 만료 시각을 채운다", byCode.get("ccc3333").nextCheckAt === EXP + 60000,
     String(byCode.get("ccc3333").nextCheckAt));
  ok("몇 명을 채웠는지 알린다", /만료 예정 시각을 채웠습니다/.test(alerts.join("\n")), alerts.join(" | "));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
