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
    history: s.history || [],
    logs: s.logs || [],
    status: s.status || { text: "대기 중", busy: false, busySince: 0 },
  };
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
  const rowsAll = state.watchlist
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !q ||
      t.value.toLowerCase().includes(q) ||
      (t.memo || "").toLowerCase().includes(q));
  const LIST_LIMIT = 200;
  const shown = rowsAll.slice(0, LIST_LIMIT);

  const off = state.watchlist.filter((t) => t.enabled === false).length;
  $("listCount").textContent =
    `전체 ${state.watchlist.length}명` +
    (off ? ` (중지 ${off}명)` : "") +
    (q ? ` · 검색 ${rowsAll.length}명` : "") +
    (rowsAll.length > LIST_LIMIT ? ` · ${LIST_LIMIT}명만 표시` : "");

  const lb = $("listBody");
  lb.innerHTML = shown.map(({ t, i }) => `
    <tr>
      <td>${esc(t.value)}</td>
      <td>${esc(t.reason)}</td>
      <td>${t.enabled === false ? "<span class='muted'>중지</span>" : "<span class='ok'>사용</span>"}</td>
      <td class="muted">${esc(t.memo || "")}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="linkbtn" data-toggle="${i}">${t.enabled === false ? "사용" : "중지"}</button>
        <button class="linkbtn" data-del="${i}">삭제</button>
      </td>
    </tr>`).join("");
  $("listEmpty").classList.toggle("hidden", state.watchlist.length > 0);

  // 명단 채우기
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

$("btnCheck").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "check" });
});

$("btnApply").addEventListener("click", () => {
  const names = state.candidates.map((c) => `· ${c.label} (${c.reason})`).join("\n");
  if (confirm(`아래 ${state.candidates.length}명을 31일 재차단합니다.\n\n${names}\n\n실행할까요?`)) {
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

  state.watchlist.push({
    kind: "code",
    value,
    reason: $("newReason").value,
    memo: $("newMemo").value.trim(),
    enabled: true,
  });
  await chrome.storage.local.set({ watchlist: state.watchlist });
  $("newCode").value = "";
  $("newMemo").value = "";
  render();
});

$("listBody").addEventListener("click", async (e) => {
  const del = e.target.dataset.del;
  const toggle = e.target.dataset.toggle;

  if (del !== undefined) {
    const t = state.watchlist[Number(del)];
    if (!confirm(`'${t.value}' 를 명단에서 지울까요?`)) return;
    state.watchlist.splice(Number(del), 1);
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
let scanReasons = null;
const scanUnchecked = new Set();
const NO_REASON = "(사유 없음)";
const reasonOf = (it) => it.reason || NO_REASON;

// scanReasons 가 null 이면 전체. Set 이면 그 사유만.
// 빈 Set 을 전체로 되돌리지 않는 것이 중요하다. 그러면 사용자는 아무것도
// 안 고른 줄 아는데 화면에는 전원이 떠서, 그대로 추가하면 엉뚱한 사람이 들어간다.
function visibleImports() {
  if (!scanReasons) return state.imports;
  return state.imports.filter((it) => scanReasons.has(reasonOf(it)));
}

$("btnScan").addEventListener("click", () => {
  const pages = Math.max(1, Math.min(100, Number($("scanPages").value) || 10));
  chrome.runtime.sendMessage({ type: "scan", pages });
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
  let added = 0;
  for (const it of state.imports) {
    if (!pickedSet.has(it.code) || known.has(it.code)) continue;
    state.watchlist.push({
      kind: "code",
      value: it.code,
      reason: it.reason || "음란성",
      memo: `${it.date} 31일 차단에서 추가`,
      enabled: true,
    });
    known.add(it.code);
    added++;
  }
  state.imports = state.imports.filter((it) => !pickedSet.has(it.code));
  for (const code of picked) scanUnchecked.delete(code);
  await chrome.storage.local.set({ watchlist: state.watchlist, imports: state.imports });
  render();
  alert(`${added}명을 명단에 추가했습니다.`);
});

$("listSearch").addEventListener("input", render);

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
