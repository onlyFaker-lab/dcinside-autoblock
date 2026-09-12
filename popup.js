// popup.js — 화면 표시와 입력만 담당한다. 실제 작업은 background.js가 한다.

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  galleryId: "",
  checkTimes: ["09:30", "21:30"],
  maxPerRun: 100,
  maxChecksPerRun: 300,
  sweepPerRun: 20,
  autoApply: false,
  notify: true,
  recheckBeforeApply: false,
};

let state = {};

// background.js와 같은 규칙. 서비스워커가 작업 도중 죽으면 busy가 true로 남는데,
// 그대로 믿으면 버튼이 영영 disabled로 굳는다. 30분 넘은 잠금은 무시한다.
const BUSY_TIMEOUT_MS = 30 * 60 * 1000;

function isBusy(status, now = Date.now()) {
  if (!status || !status.busy) return false;
  return now - (status.busySince || 0) < BUSY_TIMEOUT_MS;
}

async function load() {
  const s = await chrome.storage.local.get(null);
  state = {
    settings: { ...DEFAULTS, ...(s.settings || {}) },
    watchlist: s.watchlist || [],
    candidates: s.candidates || [],
    manual: s.manual || [],
    imports: s.imports || [],
    importsAt: s.importsAt || 0,
    history: s.history || [],
    logs: s.logs || [],
    status: s.status || { text: "대기 중", busy: false, busySince: 0 },
    lastScanAt: s.lastScanAt || 0,
    candidatesAt: s.candidatesAt || 0,
  };

  // 명단 채우기를 다시 돌리면 체크 상태를 처음으로 되돌린다.
  // scanUnchecked는 사유 칩을 바꿔도 손으로 푼 체크를 기억하려고 두는 것인데,
  // 새 결과에까지 남아 있으면 안 된다. 파딱 피드백(2026-09-08):
  // "경우에 따라 체크가 해제되어 있기도 했지만 그렇지 않은 경우도 있다."
  // 지난 스캔에서 푼 체크가 새 결과의 같은 코드에 그대로 붙어 있던 것이다.
  if (state.importsAt !== lastImportsAt) {
    lastImportsAt = state.importsAt;
    scanUnchecked.clear();
    scanReasons = null;
  }
  render();
}

function fmtTime(v) {
  if (v === null || v === undefined) return "-";
  const d = new Date(v);
  return isNaN(d.getTime()) ? "-" : d.toLocaleString("ko-KR");
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function nextCheckText() {
  const times = state.settings.checkTimes;
  if (!times.length) return "";
  const now = new Date();
  let best = null;
  for (const t of times) {
    const [hh, mm] = t.split(":").map(Number);
    if (Number.isNaN(hh)) continue;
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    if (!best || d < best) best = d;
  }
  if (!best) return "";
  const mins = Math.round((best - now) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `다음 확인까지 ${h}시간 ${m}분`;
}

function render() {
  renderQuickScan();
  $("statusText").textContent = state.status.text;
  $("nextCheck").textContent = nextCheckText();
  const busy = isBusy(state.status);
  $("btnCheck").disabled = busy;
  $("btnApply").disabled = busy || state.candidates.length === 0;

  // 후보
  const cb = $("candBody");
  cb.innerHTML = state.candidates.map((c) => `
    <tr>
      <td>${esc(c.label)}</td>
      <td>${esc(c.reason)}</td>
      <td>${esc(c.prevDuration)}<br><span class="muted small">${esc(c.prevHandled)}</span></td>
      <td class="muted">${esc(c.memo)}</td>
    </tr>`).join("");
  $("candEmpty").classList.toggle("hidden",
    state.candidates.length > 0 || state.manual.length > 0);
  $("shareBox").classList.toggle("hidden", state.candidates.length === 0);

  // 처음 켠 완장은 빈 후보 화면만 보고 무엇부터 할지 모른다. 명단이 비어 있으면
  // 어디로 가야 하는지 알려준다. 명단이 차면 저절로 사라진다.
  $("candStart").classList.toggle("hidden", state.watchlist.length > 0);

  // 완장이 직접 풀어준 대상
  $("manualBox").classList.toggle("hidden", state.manual.length === 0);
  $("manualBody").innerHTML = state.manual.map((m) => `
    <tr>
      <td>${esc(m.label)}</td>
      <td>${esc(m.duration)}</td>
      <td class="muted">${fmtTime(m.wouldExpire)}</td>
      <td style="text-align:right">
        <button class="linkbtn" data-drop="${esc(m.code)}">명단에서 빼기</button>
      </td>
    </tr>`).join("");

  // 기록
  $("logs").textContent = state.logs
    .slice(-80)
    .map((l) => `[${new Date(l.time).toTimeString().slice(0, 8)}] ${l.message}`)
    .join("\n");
  $("logs").scrollTop = $("logs").scrollHeight;

  // 명단 — 수만 명이 될 수 있으므로 검색 + 표시 상한을 둔다
  const q = ($("listSearch").value || "").trim().toLowerCase();
  // 중지는 손으로도 걸지만 대부분 60일 자동 중지로 붙는다. 명단에서 뺄지
  // 판단하려면 그 사람들만 모아볼 수 있어야 한다(파딱 요청 2026-09-09).
  const only = $("listFilter").value;
  const rowsAll = state.watchlist
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => {
      if (only === "on" && t.enabled === false) return false;
      if (only === "off" && t.enabled !== false) return false;
      // 사유로도 찾을 수 있어야 한다. 직접 입력 사유를 쓰면 사유가 곧 분류다.
      return !q ||
        t.value.toLowerCase().includes(q) ||
        (t.memo || "").toLowerCase().includes(q) ||
        (t.reason || "").toLowerCase().includes(q);
    });
  const LIST_LIMIT = 200;
  const shown = rowsAll.slice(0, LIST_LIMIT);

  const off = state.watchlist.filter((t) => t.enabled === false).length;
  $("listCount").textContent =
    `전체 ${state.watchlist.length}명` +
    (off ? ` (중지 ${off}명)` : "") +
    (q || only !== "all" ? ` · 보이는 것 ${rowsAll.length}명` : "") +
    (rowsAll.length > LIST_LIMIT ? ` · ${LIST_LIMIT}명만 표시` : "");

  const lb = $("listBody");
  lb.innerHTML = shown.map(({ t, i }) => i === editingRow ? `
    <tr>
      <td>${esc(t.value)}</td>
      <td><input class="editReason" type="text" maxlength="${REASON_TXT_MAX}"
                 value="${esc(t.reason || "")}" style="width:110px"></td>
      <td>${t.enabled === false ? "<span class='muted'>중지</span>" : "<span class='ok'>사용</span>"}</td>
      <td><input class="editMemo" type="text" value="${esc(t.memo || "")}" style="width:100%"></td>
      <td style="text-align:right;white-space:nowrap">
        <button class="linkbtn" data-save="${i}">저장</button>
        <button class="linkbtn" data-cancel="${i}">취소</button>
      </td>
    </tr>` : `
    <tr>
      <td>${esc(t.value)}</td>
      <td>${esc(t.reason)}</td>
      <td>${t.enabled === false ? "<span class='muted'>중지</span>" : "<span class='ok'>사용</span>"}</td>
      <td class="muted">${esc(t.memo || "")}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="linkbtn" data-edit="${i}">수정</button>
        <button class="linkbtn" data-toggle="${i}">${t.enabled === false ? "사용" : "중지"}</button>
        <button class="linkbtn" data-del="${i}">삭제</button>
      </td>
    </tr>`).join("");
  $("listEmpty").classList.toggle("hidden", state.watchlist.length > 0);

  // 명단 채우기
  // ── 명단 정리 탭 ──
  const clean = cleanRows();
  const CLEAN_LIMIT = 500;
  $("cleanBody").innerHTML = clean.slice(0, CLEAN_LIMIT).map(({ t }) => `
    <tr>
      <td><input type="checkbox" class="cleanchk" data-code="${esc(t.value)}"${
        cleanUnchecked.has(t.value) ? "" : " checked"}></td>
      <td>${esc(t.memo || "-")}</td>
      <td>${esc(t.value)}</td>
      <td>${esc(t.reason)}</td>
      <td class="muted">${
        t.lastPostAt ? new Date(t.lastPostAt).toLocaleDateString("sv-SE")
        : t.noPostSince ? `${esc(t.noPostSince)} 이후 글 없음` : "-"}</td>
      <td>${gallogLabel(t)}</td>
      <td class="muted">${gallogActivity(t)}</td>
    </tr>`).join("");
  $("cleanEmpty").textContent = state.watchlist.length === 0
    ? "명단이 비어 있습니다."
    : "지울 만한 사람을 찾지 못했습니다. 위에서 점검을 돌려보세요.";
  $("cleanEmpty").classList.toggle("hidden", clean.length > 0);
  $("cleanActions").classList.toggle("hidden", clean.length === 0);
  const cleanPicked = clean.slice(0, CLEAN_LIMIT)
    .filter(({ t }) => !cleanUnchecked.has(t.value)).length;
  $("cleanCount").textContent = clean.length
    ? `${clean.length}명 중 ${cleanPicked}명 선택` : "";
  $("btnCleanDel").disabled = cleanPicked === 0;

  // 머리글 체크박스는 아래 행들을 따라간다. 일부만 골랐으면 중간 표시.
  const cleanShown = Math.min(clean.length, CLEAN_LIMIT);
  const cleanAllBox = $("cleanAll");
  cleanAllBox.checked = cleanShown > 0 && cleanPicked === cleanShown;
  cleanAllBox.indeterminate = cleanPicked > 0 && cleanPicked < cleanShown;
  cleanAllBox.disabled = cleanShown === 0;

  const sb = $("scanBody");
  const SCAN_LIMIT = 300;

  // 불러온 사람들에게 실제로 붙어 있는 사유만 칩으로 만든다.
  const counts = new Map();
  for (const it of state.imports) {
    const r = reasonOf(it);
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  const allReasons = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));

  // 다시 불러오면서 사라진 사유는 필터에서 지운다.
  if (scanReasons) {
    for (const r of [...scanReasons]) if (!counts.has(r)) scanReasons.delete(r);
  }
  if (state.imports.length === 0) scanReasons = null;

  const on = (r) => !scanReasons || scanReasons.has(r);
  $("scanFilter").innerHTML = allReasons.length === 0 ? "" :
    `<span class="chiplabel">사유</span>` + allReasons.map((r) => `
      <label class="chip${on(r) ? " on" : ""}">
        <input type="checkbox" class="rchk" data-reason="${esc(r)}"${on(r) ? " checked" : ""}>
        ${esc(r)} <b>${counts.get(r)}</b>
      </label>`).join("") +
      (scanReasons ? `<button id="btnReasonAll" class="linkbtn">전체</button>` : "");
  $("scanFilter").classList.toggle("hidden", allReasons.length < 2);

  const scanShown = visibleImports();
  sb.innerHTML = scanShown.slice(0, SCAN_LIMIT).map((it) => `
    <tr>
      <td><input type="checkbox" class="scanchk" data-code="${esc(it.code)}"${scanUnchecked.has(it.code) ? "" : " checked"}></td>
      <td>${esc(it.nick)}</td>
      <td>${esc(it.code)}</td>
      <td>${esc(it.reason)}</td>
      <td class="muted">${esc(it.date)} ${esc(it.time)}</td>
      <td class="${it.released ? "muted" : "ok"}">${it.released ? "해제됨" : "차단 중"}</td>
    </tr>`).join("");
  $("scanEmpty").textContent = state.imports.length === 0
    ? "아직 불러오지 않았습니다."
    : "고른 사유에 해당하는 사람이 없습니다. 위에서 사유를 골라주세요.";
  $("scanEmpty").classList.toggle("hidden", scanShown.length > 0);
  if (scanShown.length > SCAN_LIMIT) {
    sb.insertAdjacentHTML("beforeend",
      `<tr><td colspan="6" class="muted">${scanShown.length}명 중 ${SCAN_LIMIT}명만 표시합니다. 추가하면 나머지가 이어서 나옵니다.</td></tr>`);
  }
  $("scanActions").classList.toggle("hidden", state.imports.length === 0);

  const picked = scanShown.slice(0, SCAN_LIMIT).filter((it) => !scanUnchecked.has(it.code)).length;
  $("scanCount").textContent = scanReasons
    ? `전체 ${state.imports.length}명 중 ${scanShown.length}명 표시, ${picked}명 선택`
    : `${scanShown.length}명 중 ${picked}명 선택`;
  $("btnScanAdd").disabled = picked === 0;

  // 이력
  const hb = $("histBody");
  hb.innerHTML = [...state.history].reverse().slice(0, 200).map((r) => `
    <tr>
      <td>${fmtTime(r.time)}</td>
      <td>${esc(r.label)}</td>
      <td>${esc(r.reason)}</td>
      <td class="${r.ok ? "ok" : "bad"}">${r.ok ? "31일 차단 확인됨" : "실패"}</td>
    </tr>`).join("");
  $("histEmpty").classList.toggle("hidden", state.history.length > 0);

  // 설정
  $("cfgGallery").value = state.settings.galleryId;
  $("cfgTimes").value = state.settings.checkTimes.join(", ");
  $("cfgMax").value = state.settings.maxPerRun;
  $("cfgChecks").value = state.settings.maxChecksPerRun;
  $("cfgSweep").value = state.settings.sweepPerRun;
  $("cfgAuto").checked = !!state.settings.autoApply;
  $("cfgRecheck").checked = !!state.settings.recheckBeforeApply;
  $("cfgNotify").checked = state.settings.notify !== false;
}

// --------------------------------------------------------------- 이벤트

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("on"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("on"));
    btn.classList.add("on");
    $(`tab-${btn.dataset.tab}`).classList.add("on");
  });
});

// 명단 탭 안의 세 갈래(보기 / 채우기 / 빼기). 위 탭과 같은 방식이되
// .subpanel 만 건드려서 서로 간섭하지 않는다.
document.querySelectorAll(".seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg").forEach((b) => b.classList.remove("on"));
    document.querySelectorAll(".subpanel").forEach((p) => p.classList.remove("on"));
    btn.classList.add("on");
    $(`tab-${btn.dataset.seg}`).classList.add("on");
  });
});

$("btnCheck").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "check" });
});

$("btnApply").addEventListener("click", () => {
  const names = state.candidates.map((c) => `· ${c.label} (${c.reason})`).join("\n");
  const n = state.candidates.length;
  // 후보 목록은 판정한 그 순간의 사진이다. 그 사이에 다른 완장이 손으로
  // 갱신차단을 걸었을 수 있다. 얼마나 지났는지는 켜고 끄고와 무관하게 알린다.
  const recheck = state.settings.recheckBeforeApply;
  const mins = Math.ceil((n * (1.2 + 0.5)) / 60);
  const old = state.candidatesAt
    ? Math.round((Date.now() - state.candidatesAt) / 60000) : 0;

  if (confirm(
    `아래 ${n}명을 31일 재차단합니다.\n\n${names}\n\n` +
    (old >= 60
      ? `이 후보는 판정한 지 ${Math.round(old / 60)}시간 지났습니다.\n` +
        (recheck ? "" : "그 사이 다른 완장이 이미 차단했을 수 있습니다.\n")
      : "") +
    (recheck
      ? `보내기 전에 아직 풀려 있는지 다시 봅니다. ` +
        `${mins < 1 ? "금방" : `${mins}분쯤`} 더 걸립니다.\n` +
        `그 사이 다른 완장이 이미 차단한 사람은 빼고 보냅니다.\n`
      : "") +
    `\n실행할까요?`
  )) {
    chrome.runtime.sendMessage({ type: "apply" });
  }
});

$("btnAdd").addEventListener("click", async () => {
  const value = $("newCode").value.trim();
  if (!value) return;

  if (/^\d{1,3}\.\d{1,3}\./.test(value)) {
    alert(
      "IP는 자동 갱신 대상이 아닙니다.\n\n" +
      "뒷자리를 알 수 없어 통신사 대역을 통째로 막게 되는데, " +
      "상대는 IP를 바꾸면 그만이고 무고한 갤러만 막힙니다.\n" +
      "IP 차단은 관리 화면에서 직접 해주세요."
    );
    return;
  }
  if (state.watchlist.some((t) => t.value === value)) {
    alert(`'${value}' 는 이미 명단에 있습니다.`);
    return;
  }

  const reason = readReason("newReason", "newReasonTxt");
  if (reason === null) {
    alert("사유를 직접 입력하기로 했는데 비어 있습니다.");
    $("newReasonTxt").focus();
    return;
  }

  state.watchlist.push({
    kind: "code",
    value,
    reason,
    memo: $("newMemo").value.trim(),
    enabled: true,
  });
  await chrome.storage.local.set({ watchlist: state.watchlist });
  $("newCode").value = "";
  $("newMemo").value = "";
  render();
});

$("listBody").addEventListener("click", async (e) => {
  const d = e.target.dataset;
  const { del, toggle, edit, save, cancel } = d;

  if (edit !== undefined) {
    editingRow = Number(edit);
    render();
    return;                       // 아직 저장할 게 없다
  }
  if (cancel !== undefined) {
    editingRow = -1;
    render();
    return;
  }
  if (save !== undefined) {
    // 수정 중인 행은 언제나 하나뿐이라 listBody 안에서 바로 찾는다.
    // closest("tr") 보다 얕게 의존해서 검사하기도 쉽다.
    const t = state.watchlist[Number(save)];
    const rEl = $("listBody").querySelectorAll(".editReason")[0];
    const mEl = $("listBody").querySelectorAll(".editMemo")[0];
    if (!rEl) { editingRow = -1; render(); return; }
    const reason = rEl.value.trim();
    if (!reason) {
      alert("사유는 비워둘 수 없습니다.");
      return;
    }
    // 재차단할 때 20자를 넘으면 디시가 잘라버린다. 여기서 미리 맞춘다.
    t.reason = [...reason].slice(0, REASON_TXT_MAX).join("");
    t.memo = mEl ? mEl.value.trim() : (t.memo || "");
    editingRow = -1;
  } else if (del !== undefined) {
    const t = state.watchlist[Number(del)];
    if (!confirm(`'${t.value}' 를 명단에서 지울까요?`)) return;
    state.watchlist.splice(Number(del), 1);
    editingRow = -1;              // 번호가 밀리므로 수정 상태를 푼다
  } else if (toggle !== undefined) {
    const t = state.watchlist[Number(toggle)];
    t.enabled = t.enabled === false;
  } else {
    return;
  }
  await chrome.storage.local.set({ watchlist: state.watchlist });
  render();
});

$("btnSave").addEventListener("click", async () => {
  const times = $("cfgTimes").value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^\d{1,2}:\d{2}$/.test(t));

  if (!times.length) {
    alert("확인 시각을 09:30 형식으로 하나 이상 넣어주세요.");
    return;
  }

  // 기존 설정을 통째로 갈아엎으면 화면에 없는 항목(maxChecksPerRun, sweepPerRun)이
  // 저장할 때마다 지워진다. 남겨두고 바뀐 것만 덮어쓴다.
  state.settings = {
    ...state.settings,
    galleryId: $("cfgGallery").value.trim(),
    checkTimes: times,
    maxPerRun: Math.max(1, Number($("cfgMax").value) || 100),
    maxChecksPerRun: Math.max(1, Number($("cfgChecks").value) || DEFAULTS.maxChecksPerRun),
    sweepPerRun: Math.max(0, Number($("cfgSweep").value) || 0),
    autoApply: $("cfgAuto").checked,
    recheckBeforeApply: $("cfgRecheck").checked,
    notify: $("cfgNotify").checked,
  };
  await chrome.storage.local.set({ settings: state.settings });
  $("saved").textContent = "저장했습니다.";
  setTimeout(() => ($("saved").textContent = ""), 2000);
  render();
});

$("manualBody").addEventListener("click", async (e) => {
  const code = e.target.dataset.drop;
  if (!code) return;
  if (!confirm(`'${code}' 를 명단에서 뺄까요?\n\n앞으로 이 사람은 자동 재차단되지 않습니다.`)) return;

  state.watchlist = state.watchlist.filter((t) => t.value !== code);
  state.manual = state.manual.filter((m) => m.code !== code);
  await chrome.storage.local.set({ watchlist: state.watchlist, manual: state.manual });
  render();
});

// 명단 채우기 화면의 사유 필터 상태.
// scanReasons 가 null 이면 전체, 비어 있지 않은 Set 이면 그 사유만 보여준다.
// scanUnchecked 는 사용자가 손으로 푼 체크를 필터를 바꿔도 기억하기 위한 것이다.
// 지금 수정 중인 명단 행 번호. render()가 이 행만 입력칸으로 그린다.
// 화면에서 상태를 읽지 않고 여기 한 곳에만 둔다 (3-4절 규칙).
let editingRow = -1;

let scanReasons = null;
const scanUnchecked = new Set();
// 마지막으로 본 명단 채우기 결과의 시각. 이게 바뀌면 새로 불러온 것이므로
// 체크 상태와 사유 필터를 처음으로 되돌린다. load()에서 본다.
let lastImportsAt = 0;
const NO_REASON = "(사유 없음)";
const REASONS = ["음란성", "광고", "욕설", "도배", "혐오 콘텐츠", "저작권 침해", "명예훼손"];

// 디시 차단 창의 '직접 입력' 칸 안내가 '한글 20자 이내'다.
// popup.js 는 dc.js 를 가져오지 않으므로 여기 적어둔다.
// 두 값이 어긋나면 test.mjs 가 실패한다.
const REASON_TXT_MAX = 20;

// dc.js의 합치기 규칙을 그대로 쓴다. 여기 옮겨 적으면 규칙이 두 벌이 된다.
import { mergeGallog } from "./dc.js";
const CUSTOM_PICK = "__custom__";

// 사유 칸 하나를 묶어서 다룬다. 드롭다운에서 '직접 입력'을 고르면 텍스트 칸이
// 나오고, 그 값이 사유가 된다.
//
// 파딱 갤은 명단 4533명이 전원 직접 입력 사유('벌레' 같은)라, 7개 고정
// 드롭다운으로는 명단에 새로 넣는 모든 경로에서 그 사유를 쓸 수 없었다.
// 파일로 불러올 때만 살아남았다.
function bindReasonPicker(selId, txtId) {
  const sel = $(selId), txt = $(txtId);
  const sync = () => {
    const custom = sel.value === CUSTOM_PICK;
    txt.classList.toggle("hidden", !custom);
    if (custom) txt.focus();
  };
  sel.addEventListener("change", sync);
  sync();
}

// 고른 사유를 돌려준다. 직접 입력인데 비어 있으면 null (부르는 쪽에서 안내).
function readReason(selId, txtId) {
  const sel = $(selId), txt = $(txtId);
  if (sel.value !== CUSTOM_PICK) return sel.value;
  const v = txt.value.trim();
  if (!v) return null;
  return [...v].slice(0, REASON_TXT_MAX).join("");
}

const reasonOf = (it) => it.reason || NO_REASON;

// scanReasons 가 null 이면 전체. Set 이면 그 사유만.
// 빈 Set 을 전체로 되돌리지 않는 것이 중요하다. 그러면 사용자는 아무것도
// 안 고른 줄 아는데 화면에는 전원이 떠서, 그대로 추가하면 엉뚱한 사람이 들어간다.
function visibleImports() {
  if (!scanReasons) return state.imports;
  return state.imports.filter((it) => scanReasons.has(reasonOf(it)));
}

// 날짜를 넣었으면 그 날짜가 기준이다. 페이지 수는 안전장치로만 남긴다.
// 예전에는 둘 다 걸려서, 날짜를 넣어도 페이지 상한(기본 10)이 먼저 걸렸다.
// 날짜를 지정한 사람 입장에서는 왜 덜 훑었는지 알기 어렵다.
const SCAN_PAGE_GUARD = 3000;

function scanPagesToUse() {
  return $("scanUntil").value
    ? SCAN_PAGE_GUARD
    : Math.max(1, Math.min(SCAN_PAGE_GUARD, Number($("scanPages").value) || 10));
}

// 날짜를 넣으면 페이지 입력란은 쓰이지 않는다. 흐리게 해서 눈에 보이게 한다.
function syncScanInputs() {
  const byDate = !!$("scanUntil").value;
  $("scanPages").disabled = byDate;
  $("scanPagesLabel").classList.toggle("off", byDate);
  $("scanMode").textContent = byDate
    ? "날짜 기준으로 훑습니다. 페이지 수는 쓰지 않습니다."
    : "";
}
$("scanUntil").addEventListener("change", syncScanInputs);
$("scanUntil").addEventListener("input", syncScanInputs);
syncScanInputs();

$("btnScan").addEventListener("click", () => {
  const until = $("scanUntil").value || "";
  const includeReleased = $("scanReleased").checked;
  chrome.runtime.sendMessage({
    type: "scan", pages: scanPagesToUse(), until, includeReleased,
  });
});

// 화면을 다시 그리면 체크박스가 새로 만들어지므로 개별 요소가 아니라
// 컨테이너에 한 번만 걸어둔다.
$("scanFilter").addEventListener("change", (e) => {
  const box = e.target.closest(".rchk");
  if (!box) return;
  // 화면의 체크 상태를 훑지 않고 지금 상태에서 하나만 더하거나 뺀다.
  // render() 가 체크박스를 새로 만들기 때문에, 화면을 읽으면 방금 교체된
  // 요소를 보게 되는 경우가 생긴다.
  const all = [...document.querySelectorAll(".rchk")].map((c) => c.dataset.reason);
  const cur = new Set(scanReasons ? [...scanReasons] : all);
  if (box.checked) cur.add(box.dataset.reason);
  else cur.delete(box.dataset.reason);
  // 전부 켜져 있으면 필터를 끈 것과 같다. 하나도 안 켰으면 빈 Set 그대로 둔다.
  scanReasons = cur.size === all.length ? null : cur;
  render();
});

$("scanFilter").addEventListener("click", (e) => {
  if (!e.target.closest("#btnReasonAll")) return;
  scanReasons = null;
  render();
});

$("scanBody").addEventListener("change", (e) => {
  const box = e.target.closest(".scanchk");
  if (!box) return;
  if (box.checked) scanUnchecked.delete(box.dataset.code);
  else scanUnchecked.add(box.dataset.code);
  render();
});

// 보이는 사람에게만 적용한다. 사유로 추린 뒤 그 사람들만 담을 수 있게 하려는 것이다.
// 갤러리에 그대로 올릴 수 있는 형태로 뽑는다.
// 완장끼리 개인적으로 주고받을 수 없는 갤러리가 있어서, 공개 게시물에
// 붙여넣는 것을 전제로 한다. 그래서 닉네임이나 메모는 넣지 않는다.
$("btnCopyCand").addEventListener("click", async () => {
  const list = state.candidates;
  if (!list.length) return;

  const byReason = {};
  for (const c of list) (byReason[c.reason] ||= []).push(c.code);

  const today = new Date().toLocaleDateString("sv-SE");
  const lines = [`# 재차단 후보 ${list.length}명 (${today})`];
  for (const [reason, codes] of Object.entries(byReason)) {
    lines.push("", `# ${reason} ${codes.length}명`, ...codes);
  }
  const text = lines.join("\n");

  try {
    await navigator.clipboard.writeText(text);
    const n = Object.keys(byReason).length;
    alert(
      `${list.length}명을 복사했습니다.\n\n` +
      `갤러리에 올리시면 다른 완장이 붙여넣어 쓸 수 있습니다.\n` +
      (n > 1 ? `사유가 ${n}가지라 사유별로 나눠 적었습니다.\n` : "") +
      `\n디시 직접 차단 창은 한 번에 500자까지라 인원이 많으면 나눠 넣어야 합니다.`
    );
  } catch {
    alert("복사에 실패했습니다. 팝업을 클릭한 뒤 다시 눌러보세요.");
  }
});

// ── 파일로 주고받기 ─────────────────────────────────────────
// 확장에는 서버가 없다. 완장끼리 넘기려면 사람이 파일이나 글로 옮겨야 한다.
//
// 용도가 둘이라 담는 것도 다르다.
//   후보 내보내기 = 남에게 넘기는 것. 코드와 사유만. 갤러리에 공개로 올라갈 수 있다.
//   명단 내보내기 = 내 백업. 메모와 사용 여부까지 담는다. 지웠다 다시 깔았을 때
//                   메모가 통째로 날아가면 백업이라고 할 수가 없다.
// 그래서 명단 파일에는 메모가 들어간다. 공개된 자리에 올리지 말라고 알려준다.
const FILE_KIND = "dcblock-share";

function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportItems(what, items) {
  if (!items.length) {
    alert("내보낼 것이 없습니다.");
    return;
  }
  const gid = state.settings.galleryId || "gallery";
  const stamp = new Date().toLocaleDateString("sv-SE");
  const data = {
    kind: FILE_KIND,
    what,                       // "candidates" 또는 "watchlist"
    formatVersion: 2,           // 2부터 명단 파일에 memo/enabled가 들어간다
    gallery: gid,
    exportedAt: new Date().toISOString(),
    count: items.length,
    items,
  };
  saveFile(`dcblock-${what}-${gid}-${stamp}.json`, JSON.stringify(data, null, 2));
}

$("btnExportCand").addEventListener("click", () => {
  // 공유용. 닉네임과 메모는 넣지 않는다.
  exportItems("candidates", state.candidates.map((c) => ({
    code: c.code, reason: c.reason,
  })));
});

$("btnExportList").addEventListener("click", () => {
  const withMemo = state.watchlist.filter((t) => (t.memo || "").trim()).length;
  const withGallog = state.watchlist.filter((t) => t.gallogCountedAt).length;
  if ((withMemo || withGallog) && !confirm(
    `명단 ${state.watchlist.length}명을 파일로 내보냅니다.\n\n` +
    (withMemo ? `이 파일에는 메모가 그대로 들어갑니다 (${withMemo}명).\n` : "") +
    (withGallog
      ? `갤로그 기록도 같이 들어갑니다 (${withGallog}명).\n` +
        `  받는 쪽은 그 사람들을 다시 조회하지 않아도 됩니다.\n`
      : "") +
    `내 백업용이니 갤러리처럼 공개된 곳에는 올리지 마세요.\n\n` +
    `남에게 넘길 목적이라면 후보 탭의 '후보 내보내기'를 쓰세요.\n\n계속할까요?`
  )) return;

  exportItems("watchlist", state.watchlist.map((t) => ({
    code: t.value,
    reason: t.reason,
    memo: t.memo || "",
    enabled: t.enabled !== false,
    // 갤로그 기록. 완장이 여럿이면 한 명이 돌고 넘기면 나머지는 조회 0번으로
    // 기준점을 얻는다. 잰 적 없는 사람은 칸 자체를 안 넣어 파일을 키우지 않는다.
    ...(t.gallogCountedAt ? {
      gallogTotal: t.gallogTotal,
      gallogSince: t.gallogSince,
      gallogCountedAt: t.gallogCountedAt,
      gallogCheckedAt: t.gallogCheckedAt,
      gallogState: t.gallogState,
    } : {}),
  })));
});

$("btnPickFile").addEventListener("click", () => $("bulkFile").click());

$("bulkFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  e.target.value = "";           // 같은 파일을 다시 골라도 동작하게

  let text;
  try {
    text = await file.text();
  } catch {
    alert("파일을 읽지 못했습니다.");
    return;
  }

  // 우리가 내보낸 JSON이면 사유까지 살려서 읽고,
  // 아니면 그냥 코드 목록이 든 글로 보고 처리한다.
  let parsed = null;
  try {
    const j = JSON.parse(text);
    if (j && j.kind === FILE_KIND && Array.isArray(j.items)) parsed = j;
  } catch { /* JSON 아님 */ }

  if (!parsed) {
    $("bulkBox").classList.remove("hidden");
    $("bulkText").value = text;
    $("bulkText").dispatchEvent(new Event("input"));
    alert(
      "이 확장이 만든 파일이 아니라서, 코드만 골라내 아래 칸에 넣었습니다.\n" +
      "사유를 고르고 '명단에 추가'를 누르세요."
    );
    return;
  }

  if (parsed.gallery && state.settings.galleryId &&
      parsed.gallery !== state.settings.galleryId) {
    if (!confirm(
      `이 파일은 '${parsed.gallery}' 갤러리에서 내보낸 것입니다.\n` +
      `지금 설정된 갤러리는 '${state.settings.galleryId}' 입니다.\n\n` +
      `그래도 가져올까요?`
    )) return;
  }

  await importItems(parsed.items, parsed.exportedAt);
});

// JSON 파일에서 읽은 항목을 명단에 넣는다. 사유가 항목마다 다를 수 있다.
// 메모와 사용 여부는 파일에 있을 때만 살린다(명단 백업 파일에만 들어 있다).
async function importItems(items, exportedAt) {
  const known = new Set(state.watchlist.map((t) => t.value));
  const seen = new Set();
  const fresh = [];
  const tooLong = new Map();     // 20자 넘는 사유 → 몇 명
  let noReason = 0;                     // 사유 칸이 아예 없던 사람

  // 이미 명단에 있는 사람은 새로 담지 않지만, 갤로그 기록은 받아올 수 있다.
  // 완장이 여럿일 때 한 명이 돌고 넘기면 나머지가 조회를 건너뛰는 길이다.
  const byCode = new Map(state.watchlist.map((t) => [t.value, t]));
  const merged = [];

  for (const it of items) {
    const code = String(it.code || "").trim();
    if (!code || seen.has(code)) continue;
    if (known.has(code)) {
      seen.add(code);
      const mine = byCode.get(code);
      const upd = mergeGallog(mine, it);
      if (upd) {
        const { why, ...fields } = upd;
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined) delete mine[k]; else mine[k] = v;
        }
        merged.push(why);
      }
      continue;
    }
    seen.add(code);

    const given = String(it.reason || "").trim();
    // 예전엔 드롭다운 7개에 없는 사유를 전부 '음란성'으로 바꿨다. 그런데
    // 완장들은 퀵차단의 '직접 입력'을 주로 쓴다. 파딱 갤 명단 4533명은
    // 전원이 직접 입력 사유('벌레' 4287명 등)라 통째로 음란성이 됐다.
    // 이제는 원문을 그대로 두고, 보낼 때 avoid_reason_txt 로 나간다.
    if (given && !REASONS.includes(given)) {
      if ([...given].length > REASON_TXT_MAX) {
        tooLong.set(given, (tooLong.get(given) || 0) + 1);
      }
    }
    // 사유 칸이 비어 있는 것만은 어쩔 수 없다. 몇 명인지 알려준다.
    if (!given) noReason++;

    fresh.push({
      code,
      reason: given || "음란성",
      memo: typeof it.memo === "string" ? it.memo : "",
      enabled: it.enabled !== false,
      gallog: mergeGallog(null, it),
    });
  }
  const dup = items.length - fresh.length - merged.length;
  const gotGallog = fresh.filter((f) => f.gallog).length + merged.length;

  if (!fresh.length) {
    if (merged.length) {
      await chrome.storage.local.set({ watchlist: state.watchlist });
      render();
      alert(
        `${items.length}명 전부 이미 명단에 있습니다.\n\n` +
        `대신 ${merged.length}명의 갤로그 기록을 받아왔습니다.\n` +
        `그 사람들은 다시 조회하지 않아도 됩니다.`
      );
    } else {
      alert(`${items.length}명 전부 이미 명단에 있습니다.`);
    }
    return;
  }

  const byReason = {};
  for (const f of fresh) byReason[f.reason] = (byReason[f.reason] || 0) + 1;
  const detail = Object.entries(byReason).map(([r, n]) => `  ${r} ${n}명`).join("\n");
  const memos = fresh.filter((f) => f.memo).length;
  const odd = [...tooLong.entries()]
    .map(([r, n]) => `  '${r}' ${n}명`).join("\n");

  if (!confirm(
    `${fresh.length}명을 명단에 추가합니다.\n\n${detail}\n` +
    (memos ? `\n메모 ${memos}건도 같이 들어갑니다.\n` : "") +
    (odd ? `\n[주의] 사유가 ${REASON_TXT_MAX}자를 넘어 재차단할 때 줄여서 보냅니다:\n${odd}\n` : "") +
    (noReason
      ? `\n[주의] ${noReason}명은 파일에 사유가 없어 '음란성'으로 넣습니다.\n` +
        `  추가한 뒤 명단 탭에서 사유를 고쳐주세요.\n`
      : "") +
    (gotGallog ? `\n갤로그 기록 ${gotGallog}명분을 같이 받아옵니다. 그만큼 조회를 덜 해도 됩니다.\n` : "") +
    (dup ? `\n(이미 있거나 중복인 ${dup}명은 건너뜁니다)\n` : "") +
    (exportedAt ? `\n파일 만든 시각: ${new Date(exportedAt).toLocaleString("ko-KR")}` : "")
  )) return;

  state.watchlist.push(...fresh.map(({ code, reason, memo, enabled, gallog }) => ({
    kind: "code", value: code, reason, memo, enabled,
    ...(gallog ? (({ why, ...f }) => f)(gallog) : {}),
    nextCheckAt: 0, lastVerifiedAt: 0, lastSeen: 0, missingSince: 0,
  })));
  await chrome.storage.local.set({ watchlist: state.watchlist });
  render();
  alert(`${fresh.length}명을 명단에 넣었습니다.\n\n'지금 확인'을 누르면 재차단 후보로 올라옵니다.`);
}

$("btnBulkToggle").addEventListener("click", () => {
  const box = $("bulkBox");
  box.classList.toggle("hidden");
  if (!box.classList.contains("hidden")) $("bulkText").focus();
});

// 갤러리에 올라온 글을 통째로 붙여넣어도 되게 한다.
// '#'으로 시작하는 줄은 설명이고, 코드 뒤에 닉네임이나 사유가 붙어 있을 수 있다.
// 식별 코드는 지금까지 본 것이 전부 영문 + 숫자다
// (capture6180, chip3298, read7286, leaf4517, debate3002).
// 둘 다 들어 있어야 한다는 조건을 걸면 '2026' 같은 날짜나 'https' 같은
// 주소 조각을 코드로 잘못 집는 일이 없다.
const RE_CODE_LIKE = /^(?=[^0-9]*[0-9])(?=[^A-Za-z]*[A-Za-z])[A-Za-z0-9_-]{4,}$/;

function parseBulk(text) {
  const out = [];
  const seen = new Set();
  for (const raw of text.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // 한 줄에 닉네임과 사유가 같이 붙어 있을 수 있다.
    // 코드처럼 생긴 첫 낱말을 쓴다.
    const code = (line.match(/[A-Za-z0-9_-]+/g) || []).find((t) => RE_CODE_LIKE.test(t));
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

$("bulkText").addEventListener("input", () => {
  const n = parseBulk($("bulkText").value).length;
  $("bulkCount").textContent = n ? `${n}명 인식됨` : "";
});

$("btnBulkAdd").addEventListener("click", async () => {
  const codes = parseBulk($("bulkText").value);
  if (!codes.length) {
    alert("식별 코드를 찾지 못했습니다.");
    return;
  }
  const reason = readReason("bulkReason", "bulkReasonTxt");
  if (reason === null) {
    alert("사유를 직접 입력하기로 했는데 비어 있습니다.");
    $("bulkReasonTxt").focus();
    return;
  }
  const known = new Set(state.watchlist.map((t) => t.value));
  const fresh = codes.filter((c) => !known.has(c));
  if (!fresh.length) {
    alert(`${codes.length}명 전부 이미 명단에 있습니다.`);
    return;
  }
  const dup = codes.length - fresh.length;
  if (!confirm(
    `${fresh.length}명을 사유 '${reason}' 으로 명단에 추가합니다.` +
    (dup ? `\n(이미 명단에 있는 ${dup}명은 건너뜁니다)` : "")
  )) return;

  state.watchlist.push(...fresh.map((code) => ({
    kind: "code", value: code, reason, memo: "", enabled: true,
    nextCheckAt: 0, lastVerifiedAt: 0, lastSeen: 0, missingSince: 0,
  })));
  await chrome.storage.local.set({ watchlist: state.watchlist });
  $("bulkText").value = "";
  $("bulkCount").textContent = "";
  $("bulkBox").classList.add("hidden");
  render();
});

// ── 명단 정리 ──────────────────────────────────────────────
// 지울 만한 사람만 추린다. 판정 근거가 확실한 순서로 보여준다.
//   탈퇴      : 갤로그가 /_error/deleted 로 넘어감. 가장 확실하다.
//   코드 이상 : 404. 우리가 코드를 잘못 읽었을 수 있으니 지우지 말고 확인부터.
//   글 없음   : 목록에 안 나옴. 댓글만 다는 사람도 여기 걸린다. 제일 약한 근거다.
const cleanUnchecked = new Set();

// 갤로그 글·댓글 수가 며칠째 그대로인지. 기록이 없으면 null.
// 첫 점검에서는 비교할 대상이 없으므로 0일이고, 그래서 후보로 올라오지 않는다.
// 이건 시간이 쌓여야 쓸모가 생기는 기능이다.
const DAY = 24 * 3600 * 1000;
function gallogQuietDays(t) {
  if (!t.gallogSince || t.gallogTotal === undefined) return null;
  return Math.floor((Date.now() - t.gallogSince) / DAY);
}

// '몇 개월간' 기준은 활동 점검과 같은 선택값을 쓴다. 둘 다 뜻이 같다.
function quietCutDays() {
  const el = document.getElementById("cleanMonths");
  return (Number(el && el.value) || 3) * 30;
}
function gallogQuiet(t) {
  const d = gallogQuietDays(t);
  return d !== null && d >= quietCutDays();
}

function cleanRows() {
  return state.watchlist
    .map((t, i) => ({ t, i }))
    .filter(({ t }) =>
      t.kind === "code" &&
      (t.gallogState === "deleted" || t.gallogState === "notfound" ||
       gallogQuiet(t) || t.noPostSince)
    )
    .sort((a, b) => rank(a.t) - rank(b.t));
}
function rank(t) {
  if (t.gallogState === "deleted") return 0;
  if (t.gallogState === "notfound") return 1;
  if (gallogQuiet(t)) return 2;      // 디시 전체에서 글·댓글이 안 늘었다
  return 3;                          // 이 갤에 글이 없을 뿐. 가장 약한 근거
}
function gallogLabel(t) {
  if (t.gallogState === "deleted") return `<span class="bad">탈퇴</span>`;
  if (t.gallogState === "notfound") return `<span class="bad">코드 확인 필요</span>`;
  if (t.gallogState === "alive") return `<span class="muted">정상</span>`;
  if (t.gallogState) return `<span class="muted">판단 불가</span>`;
  return `<span class="muted">-</span>`;
}

// 갤로그 글·댓글 수와, 그 숫자가 며칠째 그대로인지.
function gallogActivity(t) {
  if (t.gallogTotal === undefined) return "-";
  const nums = `글 ${t.gallogPosts ?? "?"} / 댓 ${t.gallogComments ?? "?"}`;
  const d = gallogQuietDays(t);
  if (d === null) return esc(nums);
  if (d < 1) return `${esc(nums)} <span class="muted">(방금 기록)</span>`;
  return `${esc(nums)} <span class="${gallogQuiet(t) ? "bad" : "muted"}">${d}일째 그대로</span>`;
}

$("btnActivity").addEventListener("click", () => {
  const months = Number($("cleanMonths").value);
  const pages = Math.max(10, Math.min(5000, Number($("cleanPages").value) || 2000));
  if (!confirm(
    `갤 글 목록을 최대 ${pages}페이지까지 훑습니다.\n` +
    `갤이 크면 몇 분에서 십수 분 걸립니다. 창을 닫아도 계속 진행됩니다.\n\n시작할까요?`
  )) return;
  chrome.runtime.sendMessage({ type: "activity", months, pages });
});

$("btnGallog").addEventListener("click", () => {
  const limit = Math.max(10, Math.min(500, Number($("cleanLimit").value) || 50));
  // 입력칸 값이 아니라 실제로 볼 인원으로 계산한다. 명단이 2명인데 상한이
  // 50이면 '1분'이라고 안내하고 3초 만에 끝난다(2026-09-08 실제).
  // 이미 탈퇴로 확인된 사람은 다시 안 보므로 여기서도 뺀다.
  const pool = state.watchlist.filter(
    (t) => t.kind === "code" && t.gallogState !== "deleted"
  ).length;
  const n = Math.min(limit, pool);
  if (!n) {
    alert("갤로그를 확인할 대상이 없습니다.\n\n명단에 식별 코드를 먼저 넣어주세요.");
    return;
  }
  // 간격만 세면 늘 모자라게 나온다. 조회 시간이 그 위에 붙는다.
  // dc.js의 CHECK_DELAY_MS / FETCH_SECS 와 같은 값. 어긋나면 검사가 실패한다.
  const secs = Math.round(n * (1.2 + 0.5));
  const eta = secs < 60 ? `${secs}초` : `${Math.ceil(secs / 60)}분`;
  if (!confirm(
    `${n}명의 갤로그를 하나씩 확인합니다.\n` +
    `${eta}쯤 걸립니다. 창을 닫아도 계속 진행됩니다.\n\n` +
    `한 번 누르면 ${n}명만 보고 끝납니다. 다시 누르면 다음 사람들입니다.\n` +
    `빠르게 많이 조회하면 디시가 IP를 막습니다. 일부러 천천히 돕니다.\n` +
    `한 번에 너무 많이 잡지 마세요.\n\n시작할까요?`
  )) return;
  chrome.runtime.sendMessage({
    type: "gallog", limit, months: Number($("cleanMonths").value) || 0,
  });
});

$("cleanBody").addEventListener("change", (e) => {
  const box = e.target.closest(".cleanchk");
  if (!box) return;
  if (box.checked) cleanUnchecked.delete(box.dataset.code);
  else cleanUnchecked.add(box.dataset.code);
  render();
});

function setAllClean(checked) {
  for (const { t } of cleanRows()) {
    if (checked) cleanUnchecked.delete(t.value);
    else cleanUnchecked.add(t.value);
  }
  render();
}
$("btnCleanAll").addEventListener("click", () => setAllClean(true));
$("btnCleanNone").addEventListener("click", () => setAllClean(false));

// 표 머리글의 전체선택. 넣어만 두고 동작을 안 붙여서, 눌러도 아무 일이
// 없는 채로 나가 있었다. 표가 길면 아래 버튼까지 내려가기 번거롭다.
$("cleanAll").addEventListener("change", (e) => setAllClean(e.target.checked));

$("btnCleanDel").addEventListener("click", async () => {
  const picked = [...document.querySelectorAll(".cleanchk")]
    .filter((c) => c.checked).map((c) => c.dataset.code);
  if (!picked.length) {
    alert("지울 사람을 선택해주세요.");
    return;
  }
  const set = new Set(picked);
  const chosen = state.watchlist.filter((t) => set.has(t.value));
  const sure = chosen.filter(
    (t) => t.gallogState === "deleted" || t.gallogState === "notfound").length;
  const quiet = chosen.filter(
    (t) => t.gallogState !== "deleted" && t.gallogState !== "notfound" && gallogQuiet(t)).length;
  const weak = chosen.length - sure - quiet;

  if (!confirm(
    `${picked.length}명을 명단에서 지웁니다.\n\n` +
    (quiet
      ? `${quiet}명은 갤로그 글·댓글 수가 오래 그대로입니다.\n` +
        `디시 전체에서 조용하다는 뜻이라 근거가 제법 셉니다.\n\n`
      : "") +
    (weak
      ? `${weak}명은 '이 갤에 글이 없다'는 것뿐이고 탈퇴가 확인된 건 아닙니다.\n` +
        `글 목록에는 댓글이 나오지 않으므로, 댓글로만 활동하는 사람이 섞여 있을 수 있습니다.\n\n`
      : "") +
    `지우면 이 사람들의 차단이 풀려도 다시 막지 않습니다.`
  )) return;

  state.watchlist = state.watchlist.filter((t) => !set.has(t.value));
  for (const c of picked) cleanUnchecked.delete(c);
  await chrome.storage.local.set({ watchlist: state.watchlist });
  render();
  alert(`${picked.length}명을 명단에서 지웠습니다.`);
});

function setAllScan(checked) {
  for (const it of visibleImports()) {
    if (checked) scanUnchecked.delete(it.code);
    else scanUnchecked.add(it.code);
  }
  render();
}
$("btnScanAll").addEventListener("click", () => setAllScan(true));
$("btnScanNone").addEventListener("click", () => setAllScan(false));

$("btnScanAdd").addEventListener("click", async () => {
  // 화면에 그려진 사람만 대상으로 삼는다. 사유로 걸러 감춰둔 사람이
  // 딸려 들어가면 사유를 고른 의미가 없다.
  const pickedSet = new Set(
    [...document.querySelectorAll(".scanchk")].filter((c) => c.checked).map((c) => c.dataset.code)
  );
  const picked = [...pickedSet];
  if (!picked.length) {
    alert("추가할 사람을 선택해주세요.");
    return;
  }
  const byReason = new Map();
  for (const it of state.imports) {
    if (pickedSet.has(it.code)) byReason.set(reasonOf(it), (byReason.get(reasonOf(it)) || 0) + 1);
  }
  const detail = [...byReason.entries()].map(([r, n]) => `  ${r} ${n}명`).join("\n");
  if (!confirm(`${picked.length}명을 명단에 추가합니다.\n\n${detail}\n\n앞으로 이 사람들의 차단이 풀리면 재차단 후보로 올라옵니다.`)) return;

  const known = new Set(state.watchlist.map((t) => t.value));
  const byCode = new Map(state.watchlist.map((t) => [t.value, t]));
  let added = 0;
  let scheduled = 0;
  let backfilled = 0;
  for (const it of state.imports) {
    if (!pickedSet.has(it.code)) continue;
    // 만료 예정 시각을 알면 그때까지 조회하지 않는다 (v1.7.8).
    // 예전에는 여기를 비워둬서 nextCheckAt이 0이 됐고, 0은 '한 번도 못 봤다'는
    // 뜻이라 만료가 한 달 남은 사람도 매번 조회 대상이 됐다. 4577명을 8일에 걸쳐
    // 도는데 그중 실제로 볼 값어치가 있는 사람은 몇 명뿐이었다.
    // 이미 지난 시각이면 그대로 둔다 — 다음 확인 때 바로 뽑히는 게 맞다.
    const next = it.expireAt ? it.expireAt + 60 * 1000 : 0;

    if (known.has(it.code)) {
      // 이미 명단에 있는 사람은 새로 담지 않는다. 다만 만료 시각을 모르고 있었다면
      // 지금 채워 준다. 옛 버전으로 담은 명단을 고치는 유일한 길이다.
      // 담을 때 값을 안 넣던 시절의 명단은 전원이 0이고, 그 상태로는 정기 확인이
      // 매번 앞에서부터 300명을 훑기만 한다.
      const mine = byCode.get(it.code);
      if (mine && !mine.nextCheckAt && next) { mine.nextCheckAt = next; backfilled++; }
      continue;
    }

    if (next) scheduled++;
    state.watchlist.push({
      kind: "code",
      value: it.code,
      reason: it.reason || "음란성",
      memo: `${it.date} 31일 차단에서 추가`,
      enabled: true,
      nextCheckAt: next,
    });
    known.add(it.code);
    added++;
  }
  state.imports = state.imports.filter((it) => !pickedSet.has(it.code));
  for (const code of picked) scanUnchecked.delete(code);
  await chrome.storage.local.set({ watchlist: state.watchlist, imports: state.imports });
  render();

  // 갤로그 기록은 나중에 한꺼번에 하면 수천 명이 되어 두 시간씩 걸린다.
  // 담을 때 그 사람들만 미리 해두면 채우기를 하는 날마다 저절로 나뉜다.
  // 총 요청 수는 같지만 한 번에 몰리지 않는다.
  if ($("scanWithGallog").checked && added) {
    alert(
      `${added}명을 명단에 추가했습니다.` +
      (scheduled ? `\n그중 ${scheduled}명은 만료 예정 시각까지 조회하지 않습니다.` : "") +
      (backfilled ? `\n이미 명단에 있던 ${backfilled}명의 만료 예정 시각을 채웠습니다.` : "") +
      `\n\n이어서 이 사람들의 갤로그 숫자를 기록합니다.`
    );
    chrome.runtime.sendMessage({
      type: "gallog", limit: added, months: 0, codes: picked,
    });
  } else {
    alert(
      `${added}명을 명단에 추가했습니다.` +
      (scheduled ? `\n그중 ${scheduled}명은 만료 예정 시각까지 조회하지 않습니다.` : "") +
      (backfilled ? `\n\n이미 명단에 있던 ${backfilled}명의 만료 예정 시각을 채웠습니다.\n그 사람들도 이제 만료될 때만 조회합니다.` : "")
    );
  }
});

// ── '할 일' 탭에서 한 번에 불러오기 ────────────────────────
// 응원갤은 경기가 없는 날도 하루 100명씩 차단된다고 한다. 그걸 담으려면
// 지금은 명단 탭 → 채우기 탭 → 날짜 고르기 → 불러오기로 네 번을 눌러야 한다.
// 자주 하는 일치고 번거로워서 한 번에 끝나게 한다.
function quickScanFrom() {
  const last = Number(state.lastScanAt) || 0;
  // 처음이면 최근 7일. 마지막으로 불러온 날부터 보면 빠진 날이 없다.
  const from = last ? new Date(last) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
  return from;
}

function renderQuickScan() {
  const last = Number(state.lastScanAt) || 0;
  $("quickScanWhen").textContent = last
    ? `마지막으로 불러온 때: ${new Date(last).toLocaleString("ko-KR")}`
    : "아직 불러온 적이 없습니다. 최근 7일치를 봅니다.";
}

$("btnQuickScan").addEventListener("click", () => {
  const from = quickScanFrom();
  const until = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-` +
                `${String(from.getDate()).padStart(2, "0")}`;
  if (!confirm(
    `${until} 이후의 31일 차단을 불러옵니다.\n\n` +
    `갤이 크면 몇 분 걸립니다. 창을 닫아도 계속 진행됩니다.\n\n시작할까요?`
  )) return;

  // 채우기 화면과 값을 맞춰둔다. 끝나고 넘어갔을 때 무엇으로 불러온
  // 결과인지 화면에 그대로 보여야 한다.
  $("scanUntil").value = until;
  syncScanInputs();
  chrome.runtime.sendMessage({
    type: "scan", pages: scanPagesToUse(), until, includeReleased: false,
  });

  // 결과는 채우기 화면에 쌓이므로 미리 그쪽으로 옮겨둔다.
  document.querySelector('.tab[data-tab="mgmt"]').click();
  document.querySelector('.seg[data-seg="scan"]').click();
});

$("listSearch").addEventListener("input", () => { editingRow = -1; render(); });
$("listFilter").addEventListener("change", () => { editingRow = -1; render(); });

// 사유 드롭다운에서 '직접 입력'을 고르면 텍스트 칸이 나오게 한다.
bindReasonPicker("newReason", "newReasonTxt");
bindReasonPicker("bulkReason", "bulkReasonTxt");

$("btnRecheck").addEventListener("click", () => {
  if (!state.watchlist.length) return;
  if (!confirm(
    `명단 ${state.watchlist.length}명을 전부 다시 확인합니다.\n\n` +
    `평소에는 차단이 풀릴 때가 된 사람만 조회하지만,\n` +
    `손으로 차단을 풀었을 때처럼 기록이 어긋났을 때 쓰세요.`
  )) return;
  chrome.runtime.sendMessage({ type: "recheckAll" });
});

chrome.storage.onChanged.addListener(load);
load();
