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
//
// ⚠ 여기서 '이미 명단에 있는 사람'을 imports 에 넣어 검사하면 안 된다.
// background 의 runScan 이 imports 에 담기 전에 걸러내므로 그런 상태는
// 앱이 만들 수 없다. v1.7.8이 그 상태를 지어내 검사해놓고, 절대 돌지 않는
// 되메우기 코드를 통과시켰다 (2026-09-13). 되메우기 검사는 test-bg.mjs 에 있다.
console.log("\n[채우기 → 명단, 만료 예정 시각]");
{
  const AUG1 = new Date("2026-08-01T10:00:00").getTime();
  const EXP = AUG1 + 744 * 3600 * 1000;          // 31일 뒤
  await seed({
    imports: [
      { code: "aaa1111", reason: "음란성", date: "2026.08.01", expireAt: EXP },
      { code: "bbb2222", reason: "벌레", date: "2026.08.01", expireAt: null },
    ],
    watchlist: [],
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
  ok("몇 명이 예약됐는지 알린다", /만료 예정 시각까지 조회하지 않습니다/.test(alerts.join("\n")),
     alerts.join(" | "));
}

// ── 직접 풀어준 것으로 본 판정을 되돌리기 ──────────────────
// 이 판정은 사후 확인이 안 된다. 처리한 신고글은 지워지고 삭제 목록에는 검색이
// 없다(파딱 확인 2026-09-13). 그러니 완장이 이 화면을 보는 그 순간에 뒤집을 수
// 있어야 한다. 판정이 틀렸는데 그대로 두면 막아야 할 사람을 조용히 놓친다.
console.log("\n[직접 풀어준 판정 되돌리기]");
{
  await seed({
    manual: [{ code: "aaa1111", label: "ㅇㅇ (aaa1111)", kind: "code", nick: "ㅇㅇ",
               duration: "31일", releasedFrom: "2026.09.05 10:00:00",
               wouldExpire: new Date("2026-10-01T10:00:00").getTime() }],
    watchlist: [{ kind: "code", value: "aaa1111", reason: "벌레", memo: "메모", enabled: true }],
    candidates: [],
  });

  ok("표에 되돌리기 버튼이 있다", /data-back="aaa1111"/.test(els.get("manualBody").innerHTML),
     els.get("manualBody").innerHTML);

  confirmAnswer = true;
  els.get("manualBody").dispatchEvent({
    type: "click", target: makeEl("", "button", { dataset: { back: "aaa1111" } }) });
  await new Promise((r) => setTimeout(r, 0));

  const c = (stored.candidates || []).find((x) => x.code === "aaa1111");
  ok("후보로 올라간다", !!c, JSON.stringify(stored.candidates));
  ok("명단의 사유를 그대로 쓴다", c && c.reason === "벌레", c && c.reason);
  ok("메모도 따라간다", c && c.memo === "메모", c && c.memo);
  ok("직접 풀어준 목록에서 빠진다", !(stored.manual || []).some((m) => m.code === "aaa1111"));
  ok("명단에서는 안 지운다", (stored.watchlist || []).some((t) => t.value === "aaa1111"));
}

// 빼기 버튼은 기록까지 지운다. 지우기 전에 그 사실을 알려야 한다.
console.log("\n[직접 풀어준 사람 명단에서 빼기]");
{
  await seed({
    manual: [{ code: "bbb2222", label: "ㅇㅇ (bbb2222)", duration: "31일",
               releasedFrom: "2026.09.05 10:00:00", wouldExpire: Date.now() }],
    watchlist: [{ kind: "code", value: "bbb2222", reason: "음란성", enabled: true }],
  });

  confirmAnswer = false;   // 물어보는지부터 본다
  confirmTexts.length = 0;
  els.get("manualBody").dispatchEvent({
    type: "click", target: makeEl("", "button", { dataset: { drop: "bbb2222" } }) });
  await new Promise((r) => setTimeout(r, 0));

  ok("확인을 받는다", confirmTexts.length === 1, String(confirmTexts.length));
  ok("확인할 수 없게 된다고 알린다", /확인할 수 없습니다/.test(confirmTexts.join(" ")), confirmTexts.join(" | "));
  ok("작업 기록에는 남는다고 알린다", /작업 기록에는 남아/.test(confirmTexts.join(" ")));
  ok("취소하면 그대로다", (stored.watchlist || []).some((t) => t.value === "bbb2222"));

  confirmAnswer = true;
  els.get("manualBody").dispatchEvent({
    type: "click", target: makeEl("", "button", { dataset: { drop: "bbb2222" } }) });
  await new Promise((r) => setTimeout(r, 0));
  ok("확인하면 빠진다", !(stored.watchlist || []).some((t) => t.value === "bbb2222"));
}

// ── 확인해야 할 사람 알림 ──────────────────────────────────
// 정해진 시각에 로그인이 안 돼 있으면 조회가 실패하는데, 그 사실이 작업 기록에만
// 남아서 놓치기 쉽다는 파딱 지적(2026-09-14). 저장된 만료 예정 시각만으로 세므로
// 디시에 묻지 않고도 띄울 수 있다.
console.log("\n[확인해야 할 사람 알림]");
{
  const 과거 = Date.now() - 3600 * 1000;
  const 미래 = Date.now() + 30 * 24 * 3600 * 1000;

  await seed({
    watchlist: [
      { kind: "code", value: "aaa1111", enabled: true, nextCheckAt: 과거 },   // 만료됨
      { kind: "code", value: "bbb2222", enabled: true, nextCheckAt: 0 },      // 한 번도 못 봄
      { kind: "code", value: "ccc3333", enabled: true, nextCheckAt: 미래 },   // 아직 멀었음
      { kind: "code", value: "ddd4444", enabled: false, nextCheckAt: 과거 },  // 꺼둔 사람
    ],
    candidates: [],
  });

  ok("알림이 보인다", !els.get("dueBox").classList.contains("hidden"));
  ok("만료된 사람과 못 본 사람만 센다", /2명/.test(els.get("dueText").textContent),
     els.get("dueText").textContent);
  ok("갈래를 나눠 설명한다",
     /만료 예정 시각이 지난 사람 1명/.test(els.get("dueWhy").textContent) &&
     /한 번도 확인하지 못한 사람 1명/.test(els.get("dueWhy").textContent),
     els.get("dueWhy").textContent);
  ok("로그인하라고 말한다", /로그인/.test(els.get("dueWhy").textContent));

  // 버튼이 실제로 확인을 시작해야 한다.
  sent.length = 0;
  els.get("btnCheckNow").dispatchEvent({ type: "click", target: els.get("btnCheckNow") });
  await new Promise((r) => setTimeout(r, 0));
  ok("버튼이 확인을 시작한다", sent.some((m) => m && m.type === "check"), JSON.stringify(sent));
}

// 후보가 이미 떠 있으면 할 일이 보이는 상태다. 굳이 또 알리지 않는다.
console.log("\n[후보가 있으면 알림을 겹쳐 띄우지 않는다]");
{
  await seed({
    watchlist: [{ kind: "code", value: "aaa1111", enabled: true, nextCheckAt: 0 }],
    candidates: [{ code: "zzz9999", label: "ㅇㅇ (zzz9999)", reason: "음란성" }],
  });
  ok("알림이 숨는다", els.get("dueBox").classList.contains("hidden"));
}

// 볼 사람이 없으면 뜨지 않는다.
console.log("\n[확인할 사람이 없으면 알림 없음]");
{
  await seed({
    watchlist: [{ kind: "code", value: "aaa1111", enabled: true,
                  nextCheckAt: Date.now() + 30 * 24 * 3600 * 1000 }],
    candidates: [],
  });
  ok("알림이 숨는다", els.get("dueBox").classList.contains("hidden"));
}

// ── 작업 기록에 날짜가 보인다 ──────────────────────────────
// 시각만 찍으면 며칠치 기록이 한 화면에 이어 붙어 몇 시간 차이인지 알 수 없다.
// 2026-09-15 파딱 갤에서 하루 차이(23시간)를 25분으로 잘못 읽었다. 기록을 근거로
// 판단하는 도구인데 기록이 날짜를 안 알려주면 그 판단이 통째로 흔들린다.
console.log("\n[작업 기록 날짜 표시]");
{
  const d1 = new Date("2026-09-14T00:27:24").getTime();
  const d2 = new Date("2026-09-15T00:02:06").getTime();
  await seed({
    logs: [
      { time: d1, message: "재차단 실행: 사유 '벌레' 37건" },
      { time: d1 + 2000, message: "35건 확인됨" },
      { time: d2, message: "명단 4782명 중 112명을 조회합니다" },
    ],
  });

  const txt = els.get("logs").textContent;
  ok("첫날 날짜가 보인다", /2026\.09\.14/.test(txt), txt);
  ok("날이 바뀌면 다시 보인다", /2026\.09\.15/.test(txt), txt);
  ok("요일도 보인다", /\((일|월|화|수|목|금|토)\)/.test(txt), txt);
  ok("시각은 그대로 남는다", /\[00:02:06\]/.test(txt), txt);

  // 같은 날 줄마다 날짜를 반복하지 않는다. 길어지기만 한다.
  const 날짜줄 = (txt.match(/2026\.09\.14/g) || []).length;
  ok("같은 날은 한 번만 찍는다", 날짜줄 === 1, `${날짜줄}번`);
}

// ── 빼기 탭에 방문자·방명록도 보인다 ────────────────────────
// 글·댓글만 보면 클리너로 0을 맞춰둔 계정을 비활성으로 오해한다.
// 그런 계정은 방문자가 수백이고 매크로 방명록이 최근이다 (파딱 2026-09-15).
console.log("\n[빼기 탭 방문자·방명록 표시]");
{
  await seed({
    watchlist: [{
      kind: "code", value: "aaa1111", enabled: true,
      gallogTotal: 0, gallogPosts: 0, gallogComments: 0,
      // 빼기 탭은 기본 3개월(90일)째 그대로인 사람만 보여준다. 120일로 잡는다.
      gallogCountedAt: Date.now() - 120 * 24 * 3600 * 1000,
      gallogSince: Date.now() - 120 * 24 * 3600 * 1000,
      gallogVisits: 456, gallogSeenByUs: 2, gallogGuestAt: "2026.09.15",
    }],
  });

  const html = els.get("cleanBody").innerHTML;
  ok("글·댓글이 보인다", /글 0 \/ 댓 0/.test(html), html);
  ok("방문자 수가 보인다", /방문 456/.test(html), html);
  ok("우리가 본 횟수를 빼서 보여준다", /우리 2 제외 454/.test(html), html);
  ok("방명록 날짜가 보인다", /방명록 2026\.09\.15/.test(html), html);
}

// 기록이 없으면 없는 대로 둔다. 0으로 적으면 비활성 쪽으로 기울어진다.
console.log("\n[기록이 없으면 안 지어낸다]");
{
  await seed({
    watchlist: [{ kind: "code", value: "bbb2222", enabled: true,
                  gallogTotal: 5, gallogPosts: 2, gallogComments: 3,
                  gallogCountedAt: Date.now() - 120 * 24 * 3600 * 1000,
                  gallogSince: Date.now() - 120 * 24 * 3600 * 1000 }],
  });
  const html = els.get("cleanBody").innerHTML;
  ok("방문자 칸이 없다", !/방문 /.test(html), html);
  ok("방명록 칸이 없다", !/방명록 /.test(html), html);
}

// ── 방명록 잠김 표시 ────────────────────────────────────────
// 2월이 마지막이어도 그 뒤에 잠가둔 것뿐일 수 있다. 잠긴 계정은 방명록이
// 비활성 근거가 못 된다. 반대로 열려 있는데도 하나도 없으면 근거가 된다.
console.log("\n[방명록 잠김 표시]");
{
  const 옛날 = Date.now() - 120 * 24 * 3600 * 1000;
  const 기본 = { kind: "code", enabled: true, gallogTotal: 0, gallogPosts: 0,
                 gallogComments: 0, gallogCountedAt: 옛날, gallogSince: 옛날 };

  await seed({ watchlist: [{ ...기본, value: "aaa1111", gallogGuestAt: "2026.02.10", gallogGuestOpen: false }] });
  let html = els.get("cleanBody").innerHTML;
  ok("잠겼다고 보여준다", /방명록 <span class="muted">잠김<\/span>/.test(html), html);
  ok("언제까지였는지도 보여준다", /2026\.02\.10까지/.test(html), html);

  await seed({ watchlist: [{ ...기본, value: "bbb2222", gallogGuestOpen: true }] });
  html = els.get("cleanBody").innerHTML;
  ok("열려 있는데 없으면 눈에 띄게", /열려 있는데 없음/.test(html), html);

  await seed({ watchlist: [{ ...기본, value: "ccc3333" }] });
  html = els.get("cleanBody").innerHTML;
  ok("모르면 아무 말도 안 한다", !/방명록/.test(html), html);
}

// ── 빼기 탭에 마지막 활동 날짜가 보인다 ─────────────────────
// 2026-09-16 파딱 갱차 시트 3,740행 대조. 파딱이 실제로 판정에 쓴 것은
// 글·댓글 '수'가 아니라 마지막 활동 '날짜'였다. 화면에서도 그게 먼저 보여야 한다.
console.log("\n[빼기 탭 마지막 활동 날짜]");
{
  const 옛날 = Date.now() - 120 * 24 * 3600 * 1000;
  const 기본 = { kind: "code", enabled: true, gallogTotal: 0, gallogPosts: 0,
                 gallogComments: 0, gallogCountedAt: 옛날, gallogSince: 옛날 };
  const 날 = (d) => {
    const x = new Date(Date.now() - d * 24 * 3600 * 1000);
    const p2 = (n) => String(n).padStart(2, "0");
    return `${x.getFullYear()}.${p2(x.getMonth() + 1)}.${p2(x.getDate())}`;
  };

  await seed({ watchlist: [{ ...기본, value: "aaa1111",
    gallogPostAt: 날(200), gallogCommentAt: 날(150), gallogGuestAt: 날(150),
    gallogLastAt: 날(150), gallogPostsOpen: true, gallogCommentsOpen: true }] });
  let html = els.get("cleanBody").innerHTML;
  ok("마지막 활동이 보인다", /마지막 활동/.test(html), html);
  ok("며칠 전인지도 보인다", /150일 전/.test(html), html);
  ok("오래됐으면 눈에 띄게", /마지막 활동 <span class="bad">/.test(html), html);
  ok("글·댓 날짜를 갈라서 보여준다", /글 20\d\d\.\d\d\.\d\d \/ 댓 20\d\d/.test(html), html);

  // 최근이면 강조하지 않는다.
  await seed({ watchlist: [{ ...기본, value: "bbb2222",
    gallogPostAt: 날(3), gallogLastAt: 날(3), gallogPostsOpen: true }] });
  html = els.get("cleanBody").innerHTML;
  ok("최근이면 강조 안 함", !/마지막 활동 <span class="bad">/.test(html), html);

  // ⚠ 비공개는 '활동 없음'이 아니라 '못 봄'이다. 뭉개면 비공개 계정이 비활성으로 몰린다.
  await seed({ watchlist: [{ ...기본, value: "ccc3333",
    gallogPostsOpen: false, gallogCommentsOpen: false }] });
  html = els.get("cleanBody").innerHTML;
  ok("비공개면 모른다고 적는다", /비공개라 모름/.test(html), html);
  ok("비공개를 오래됐다고 하지 않는다", !/일 전/.test(html), html);

  // 기록이 아예 없으면 안 지어낸다.
  await seed({ watchlist: [{ ...기본, value: "ddd4444" }] });
  html = els.get("cleanBody").innerHTML;
  ok("모르면 아무 말도 안 한다", !/마지막 활동/.test(html), html);
}

// ── 빼기 탭 정렬과 방문자 필터 ──────────────────────────────
// v1.7.16. 기준을 우리가 정해 박아넣는 대신, 완장이 막대를 움직이며
// 몇 명이 걸리는지 눈으로 보게 한다. 파딱 명단이 4,700명이라 이게 없으면
// 후보를 눈으로 훑어야 한다.
console.log("\n[빼기 탭 정렬·필터]");
{
  const 날 = (d) => {
    const x = new Date(Date.now() - d * 24 * 3600 * 1000);
    const p2 = (n) => String(n).padStart(2, "0");
    return `${x.getFullYear()}.${p2(x.getMonth() + 1)}.${p2(x.getDate())}`;
  };
  const 사람 = (v, 방문, 며칠) => ({
    kind: "code", value: v, reason: "음란성", enabled: true,
    gallogVisits: 방문, gallogLastAt: 날(며칠), gallogPostsOpen: true,
  });

  await seed({ watchlist: [
    사람("aaa1111", 800, 400),   // 방문 많고 아주 오래됨
    사람("bbb2222", 20, 100),    // 방문 적고 오래됨
    사람("ccc3333", 60, 95),     // 중간
  ] });

  // ⚠ v1.7.15 전에는 글·댓글 수를 두 번 봐야 후보가 됐다. 날짜만으로도 올라와야 한다.
  const 코드들 = () =>
    [...new Set([...els.get("cleanBody").innerHTML.matchAll(/([a-z]{3}\d{4})/g)].map((m) => m[1]))];
  let 행 = 코드들();
  ok("날짜만으로도 후보가 된다", 행.length === 3, 행.join(","));

  els.get("cleanSort").value = "visits";
  els.get("cleanSort").dispatchEvent({ type: "change" });
  행 = 코드들();
  ok("방문자 적은 순", 행[0] === "bbb2222", 행.join(","));

  els.get("cleanSort").value = "last";
  els.get("cleanSort").dispatchEvent({ type: "change" });
  행 = 코드들();
  ok("마지막 활동 오래된 순", 행[0] === "aaa1111", 행.join(","));

  els.get("cleanMaxVisits").value = "100";
  els.get("cleanMaxVisits").dispatchEvent({ type: "input" });
  행 = 코드들();
  ok("방문자 상한이 걸린다", 행.length === 2, 행.join(","));
  ok("몇 명이 걸리는지 보여준다",
     /후보 3명 중 <b>2<\/b>명/.test(els.get("cleanFilterNote").innerHTML),
     els.get("cleanFilterNote").innerHTML);

  // ⚠ 방문자를 모르는 사람을 걸러내면 안 된다. 모르는 것은 적은 것이 아니다.
  await seed({ watchlist: [
    사람("ddd4444", 500, 200),
    { kind: "code", value: "eee5555", reason: "음란성", enabled: true, gallogLastAt: 날(200) },
  ] });
  els.get("cleanMaxVisits").value = "50";
  els.get("cleanMaxVisits").dispatchEvent({ type: "input" });
  행 = 코드들();
  ok("방문자를 모르면 남겨둔다", 행.includes("eee5555"), 행.join(","));
  ok("방문자가 상한을 넘으면 뺀다", !행.includes("ddd4444"), 행.join(","));
}

// ── 작업 중에는 요청 나가는 버튼이 전부 잠긴다 ─────────────
// 2026-09-17 파딱: '지금 확인'과 '밀린 31일 차단'을 같이 눌러두고 둘 다 되는 줄
// 알았다. 실제로는 뒤에 누른 쪽이 조용히 거절된다. 누른 것처럼 보이는데 아무
// 일도 안 하는 게 제일 나쁘다. 아예 못 누르게 한다.
console.log("\n[작업 중 버튼 잠금]");
{
  const 요청버튼 = ["btnCheck", "btnCheckNow", "btnQuickScan", "btnScan",
                    "btnRecheck", "btnActivity", "btnGallog"];

  await seed({ watchlist: [], status: { text: "대기 중", busy: false, busySince: 0 } });
  ok("놀고 있으면 다 눌린다", 요청버튼.every((id) => els.get(id).disabled === false));

  await seed({
    watchlist: [],
    status: { text: "갤로그 점검 중", busy: true, busySince: Date.now() - 60000 },
  });
  for (const id of 요청버튼) {
    ok(`작업 중이면 ${id} 잠김`, els.get(id).disabled === true);
  }
  ok("왜 못 누르는지 적어준다", /다른 작업/.test(els.get("btnCheck").title || ""),
     els.get("btnCheck").title);
}

// ── 갤로그 버튼에 인원이 박힌다 ─────────────────────────────
// 한 번 누르면 이 인원만 보고 끝난다. 여러 번 자동으로 도는 게 아니다.
console.log("\n[갤로그 버튼에 인원 표시]");
{
  const 많은명단 = Array.from({ length: 400 }, (_, i) => ({
    kind: "code", value: `pool${String(i).padStart(4, "0")}`,
    reason: "음란성", enabled: true,
  }));
  await seed({ watchlist: 많은명단, status: { text: "대기 중", busy: false, busySince: 0 } });
  els.get("cleanLimit").value = "300";
  els.get("cleanLimit").dispatchEvent({ type: "input" });
  ok("300명이면 그렇게 적는다", /300명/.test(els.get("btnGallog").textContent),
     els.get("btnGallog").textContent);

  els.get("cleanLimit").value = "50";
  els.get("cleanLimit").dispatchEvent({ type: "input" });
  ok("바꾸면 따라 바뀐다", /50명/.test(els.get("btnGallog").textContent),
     els.get("btnGallog").textContent);

  // ⚠ 버튼 글자와 실제로 보는 인원이 갈라지면 안 된다.
  //    2026-09-17: 하한이 10이라 5를 넣으면 버튼은 '5명'인데 10명을 봤다.
  els.get("cleanLimit").value = "5";
  els.get("cleanLimit").dispatchEvent({ type: "input" });
  ok("5명도 그대로 5명", /갤로그 5명 점검/.test(els.get("btnGallog").textContent),
     els.get("btnGallog").textContent);

  confirmAnswer = true;
  els.get("btnGallog").click();
  await new Promise((r) => setTimeout(r, 0));
  const 보낸것 = sent.filter((m) => m.type === "gallog").at(-1);
  ok("보낸 인원도 5명", 보낸것 && 보낸것.limit === 5, JSON.stringify(보낸것));
  ok("확인창도 5명이라고 말한다", /5명/.test(confirmTexts.at(-1) || ""), confirmTexts.at(-1));

  // 명단이 상한보다 적으면 그만큼만 본다. 버튼도 그 숫자를 말해야 한다.
  await seed({
    watchlist: 많은명단.slice(0, 7),
    status: { text: "대기 중", busy: false, busySince: 0 },
  });
  els.get("cleanLimit").value = "300";
  els.get("cleanLimit").dispatchEvent({ type: "input" });
  ok("명단이 적으면 그 인원만", /갤로그 7명 점검/.test(els.get("btnGallog").textContent),
     els.get("btnGallog").textContent);
}

// ── 보이는 사람 일괄 삭제 ───────────────────────────────────
// 2026-09-17: 3,734명을 잘못 붙여넣고 되돌릴 길이 화면에 없어 콘솔을 만져야 했다.
// ⚠ 되돌릴 수 없는 동작이다. 몇 명인지 보여주고 직접 확인하게 한다(원칙 3번).
console.log("\n[명단 일괄 삭제]");
{
  const 명단 = [
    { kind: "code", value: "keep0001", reason: "음란성", enabled: true },
    { kind: "code", value: "junk0001", reason: "광고", enabled: true },
    { kind: "code", value: "junk0002", reason: "광고", enabled: true },
    { kind: "code", value: "junk0003", reason: "광고", enabled: true },
  ];
  await seed({ watchlist: 명단, status: { text: "대기 중", busy: false, busySince: 0 } });

  // 사유로 걸러서 그 사람들만 지운다.
  els.get("listSearch").value = "광고";
  els.get("listSearch").dispatchEvent({ type: "input" });
  confirmAnswer = true;
  els.get("btnDelFiltered").click();
  await new Promise((r) => setTimeout(r, 0));

  const 남은 = (stored.watchlist || []).map((t) => t.value);
  ok("걸러진 사람만 지운다", 남은.length === 1 && 남은[0] === "keep0001", 남은.join(","));
  ok("몇 명인지 묻는다", /3명/.test(confirmTexts.at(-1) || ""), confirmTexts.at(-1));
  ok("되돌릴 수 없다고 알린다", /되돌릴 수 없/.test(confirmTexts.at(-1) || ""));

  // 아니라고 하면 아무것도 안 지운다.
  await seed({ watchlist: 명단, status: { text: "대기 중", busy: false, busySince: 0 } });
  els.get("listSearch").value = "광고";
  els.get("listSearch").dispatchEvent({ type: "input" });
  confirmAnswer = false;
  els.get("btnDelFiltered").click();
  await new Promise((r) => setTimeout(r, 0));
  ok("취소하면 그대로", (stored.watchlist || []).length === 4);

  // 명단 전체가 보이는 상태면 그렇다고 말해준다.
  await seed({ watchlist: 명단, status: { text: "대기 중", busy: false, busySince: 0 } });
  els.get("listSearch").value = "";
  els.get("listSearch").dispatchEvent({ type: "input" });
  confirmAnswer = false;
  els.get("btnDelFiltered").click();
  await new Promise((r) => setTimeout(r, 0));
  ok("전체면 전체라고 말한다", /명단 전체/.test(confirmTexts.at(-1) || ""), confirmTexts.at(-1));
}

// ── 붙여넣기: 가로로 늘어놓아도 받는다 ──────────────────────
// 2026-09-17: 코드 7개를 한 줄로 붙여넣었더니 "1명 인식됨"이 떴다.
// 갤 목록을 그대로 붙이는 걸 상정한 기능인데, 실제로는 엑셀 한 행이나
// 채팅에 적힌 목록도 붙여넣는다.
console.log("\n[붙여넣기 가로 목록]");
{
  await seed({ watchlist: [], status: { text: "대기 중", busy: false, busySince: 0 } });
  const 넣기 = (t) => {
    els.get("bulkText").value = t;
    els.get("bulkText").dispatchEvent({ type: "input" });
    return els.get("bulkCount").textContent;
  };

  ok("스페이스로 늘어놓아도 다 잡는다",
     /7명/.test(넣기("capture6180 chip3298 read7286 debate3002 leaf4517 apple8748 zzzz9999")),
     넣기("capture6180 chip3298 read7286 debate3002 leaf4517 apple8748 zzzz9999"));

  ok("쉼표로 늘어놓아도 잡는다", /3명/.test(넣기("aaa1111, bbb2222, ccc3333")));
  ok("줄바꿈은 그대로 된다", /3명/.test(넣기("aaa1111\nbbb2222\nccc3333")));
  ok("같은 코드는 한 번만", /2명/.test(넣기("aaa1111 bbb2222 aaa1111")));

  // ⚠ 닉네임과 사유가 섞인 줄에서는 첫 코드만 쓴다. 닉네임이 코드처럼 생긴
  //    경우(abc123)가 있어서 전부 집으면 엉뚱한 사람이 명단에 들어온다.
  ok("섞인 줄은 첫 코드만", /1명/.test(넣기("ㅇㅇ (capture6180) 음란성 dummy123")),
     넣기("ㅇㅇ (capture6180) 음란성 dummy123"));
  ok("# 로 시작하는 줄은 무시", /2명/.test(넣기("# 메모\naaa1111 bbb2222")));
}

// ── 명단이 비어 있으면 알린다 ───────────────────────────────
// 2026-09-17 주딱이 확장을 새 폴더에 풀어 명단·이력·설정을 통째로 잃었다.
// ⚠ 처음 켠 것인지 잃은 것인지 확장은 구분할 수 없다. 문구가 둘 다에 맞아야 한다.
console.log("\n[빈 명단 경고]");
{
  await seed({ watchlist: [], status: { text: "대기 중", busy: false, busySince: 0 } });
  ok("비면 경고가 보인다", !els.get("emptyWarn").classList.contains("hidden"));

  await seed({
    watchlist: [{ kind: "code", value: "aaa1111", reason: "음란성", enabled: true }],
    status: { text: "대기 중", busy: false, busySince: 0 },
  });
  ok("있으면 안 보인다", els.get("emptyWarn").classList.contains("hidden"));
}

// ── 전체 점검 완료 표시 ─────────────────────────────────────
// 파딱(2026-09-17): 15번째쯤부터 다 끝났는지 작업 기록을 보는 게 번거롭다.
console.log("\n[전체 점검 완료 표시]");
{
  await seed({
    watchlist: [{ kind: "code", value: "aaa1111", reason: "음란성", enabled: true }],
    status: { text: "대기 중", busy: false, busySince: 0 },
    gallogDoneAt: Date.now(),
  });
  ok("끝났으면 크게 보인다", !els.get("doneBox").classList.contains("hidden"));
  ok("안 눌러도 된다고 적는다", /안 누르셔도/.test(els.get("doneWhen").textContent),
     els.get("doneWhen").textContent);

  els.get("btnDoneOk").click();
  await new Promise((r) => setTimeout(r, 0));
  ok("확인을 누르면 사라진다", els.get("doneBox").classList.contains("hidden"));
  ok("눌렀다는 것이 남는다", stored.gallogDoneAt === 0, String(stored.gallogDoneAt));

  await seed({
    watchlist: [{ kind: "code", value: "aaa1111", reason: "음란성", enabled: true }],
    status: { text: "대기 중", busy: false, busySince: 0 },
    gallogDoneAt: 0,
  });
  ok("안 끝났으면 안 보인다", els.get("doneBox").classList.contains("hidden"));
}

// ── 자동 이어돌기 설정 ──────────────────────────────────────
console.log("\n[자동 이어돌기 설정]");
{
  await seed({ watchlist: [], settings: { galleryId: "g", checkTimes: ["09:30"] },
               status: { text: "대기 중", busy: false, busySince: 0 } });
  ok("기본은 켬", els.get("cfgGallogAuto").checked === true);

  await seed({ watchlist: [], settings: { galleryId: "g", checkTimes: ["09:30"], gallogAutoOn: false },
               status: { text: "대기 중", busy: false, busySince: 0 } });
  ok("끄면 꺼진 채로 보인다", els.get("cfgGallogAuto").checked === false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
