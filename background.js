// background.js — 정기 확인과 재차단 실행.
//
// 팝업은 닫히면 죽으므로 실제 작업은 전부 여기서 한다.
// 결과는 chrome.storage에 넣고, 팝업은 그걸 읽어서 보여준다.

import { HOURS_31D, analyzeCode, blockCodes, collectByDuration, fetchRowsForCode } from "./dc.js";

const DEFAULTS = {
  galleryId: "",
  checkTimes: ["09:30", "21:30"],
  maxPerRun: 100,
  maxChecksPerRun: 300,
  sweepPerRun: 20,
  autoApply: false,
  notify: true,
};

// MV3 서비스워커는 작업 도중에도 종료될 수 있다. 그러면 busy가 true인 채 남아
// 이후 알람 틱이 전부 되돌아가고 팝업 버튼도 굳는다. 확장이 조용히 멈추는 것이다.
// 그래서 시작 시각을 같이 적어두고, 이 시간을 넘긴 잠금은 없는 것으로 본다.
// (300명 조회가 400ms 간격이라 2분대. 30분이면 정상 작업이 걸릴 일은 없다)
const BUSY_TIMEOUT_MS = 30 * 60 * 1000;

// 30분이 넘는 정상 작업도 있을 수 있다(조회 인원을 크게 잡은 경우).
// 그대로 두면 작업 도중에 잠금이 만료돼 두 번째 실행이 겹친다. 살아 있다고 알린다.
async function touchBusy() {
  const { status } = await chrome.storage.local.get("status");
  if (status && status.busy) {
    await chrome.storage.local.set({ status: { ...status, busySince: Date.now() } });
  }
}

function isBusy(status, now = Date.now()) {
  if (!status || !status.busy) return false;
  return now - (status.busySince || 0) < BUSY_TIMEOUT_MS;
}

async function getState() {
  const s = await chrome.storage.local.get(null);
  return {
    settings: { ...DEFAULTS, ...(s.settings || {}) },
    watchlist: s.watchlist || [],
    candidates: s.candidates || [],
    manual: s.manual || [],
    imports: s.imports || [],
    history: s.history || [],
    status: s.status || { text: "대기 중", busy: false, busySince: 0 },
    lastCheck: s.lastCheck || null,
    ranToday: s.ranToday || [],
  };
}

async function setStatus(text, busy) {
  await chrome.storage.local.set({
    status: { text, busy, busySince: busy ? Date.now() : 0 },
  });
}

async function log(message) {
  const { logs = [] } = await chrome.storage.local.get("logs");
  logs.push({ time: Date.now(), message });
  await chrome.storage.local.set({ logs: logs.slice(-200) });
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon128.png",
      title,
      message,
    });
  } catch { /* 아이콘이 없으면 조용히 넘어간다 */ }
}

// 조회 결과를 명단에 반영한다. 명단이 클 수 있으므로 한 번에 모아서 쓴다.
async function saveWatchlistUpdates(updates) {
  if (!updates.size) return;
  const { watchlist } = await getState();
  for (const t of watchlist) {
    const u = updates.get(t.value);
    if (u) Object.assign(t, u);
  }
  await chrome.storage.local.set({ watchlist });
}

// --------------------------------------------------------------- 확인

async function runCheck({ auto = false } = {}) {
  const { settings, watchlist } = await getState();

  if (!settings.galleryId) {
    await log("갤러리 ID가 설정되지 않았습니다. 설정 탭에서 입력하세요.");
    await setStatus("설정 필요", false);
    return { ok: false };
  }

  const enabled = watchlist.filter((t) => t.enabled !== false);
  if (!enabled.length) {
    await log("명단이 비어 있습니다. 명단 탭에서 식별코드를 추가하세요.");
    await setStatus("명단 없음", false);
    return { ok: false };
  }

  const now = Date.now();
  const DAY = 24 * 3600 * 1000;

  // 31일 차단 중인 사람은 만료 전까지 상태가 안 바뀐다. 그때까지 조회하지 않는다.
  // 명단이 수만 명이 되면 이 판단이 전부다. 하루에 실제로 볼 사람은
  // 그날 만료되는 몇백 명뿐이 된다.
  const due = enabled
    .filter((t) => !t.nextCheckAt || now >= t.nextCheckAt)
    .sort((a, b) => (a.nextCheckAt || 0) - (b.nextCheckAt || 0));

  const cap = Math.max(1, Number(settings.maxChecksPerRun) || 300);

  // 예약해둔 만료 시각이 실제와 어긋날 수 있다. 완장이 손으로 풀어줬다면
  // 우리는 31일 내내 모르고 지나간다. 그래서 남는 여유만큼 오래 확인 안 한
  // 사람을 몇 명씩 섞어서 본다. 어긋난 기록이 저절로 바로잡힌다.
  // Number(undefined)는 NaN이고 NaN ?? 20 은 NaN이다. ??로는 안 걸러진다.
  const sweepRaw = Number(settings.sweepPerRun);
  const sweepMax = Number.isFinite(sweepRaw) ? Math.max(0, sweepRaw) : 20;
  const dueSet = new Set(due.map((t) => t.value));
  const sweep = enabled
    .filter((t) => !dueSet.has(t.value))
    .sort((a, b) => (a.lastVerifiedAt || 0) - (b.lastVerifiedAt || 0))
    .slice(0, Math.max(0, Math.min(sweepMax, cap - due.length)));

  const targets = [...due.slice(0, cap), ...sweep];

  if (!targets.length) {
    const soonest = Math.min(...enabled.map((t) => t.nextCheckAt || 0));
    const hours = Math.max(0, Math.round((soonest - now) / 3600000));
    await log(`확인할 대상이 없습니다. 명단 ${enabled.length}명 모두 차단 중으로 기록돼 있습니다.`);
    await log(`  (마지막 확인 기준. 가장 이른 만료까지 약 ${hours}시간)`);
    await log(`  손으로 해제하셨다면 명단 탭의 '전체 다시 확인'을 눌러주세요.`);
    await setStatus("이상 없음", false);
    await chrome.storage.local.set({ candidates: [], lastCheck: now });
    return { ok: true, candidates: [] };
  }

  await setStatus("차단 목록 확인 중...", true);
  await log(
    `명단 ${enabled.length}명 중 ${targets.length}명을 조회합니다` +
    (sweep.length ? ` (만료 ${due.length}명 + 점검 ${sweep.length}명)` : "") +
    (due.length > cap ? ` — ${due.length}명 중 ${cap}명, 나머지는 다음 차례에` : "")
  );
  if (targets.length > 60) {
    const mins = Math.ceil((targets.length * 1.2) / 60);
    await log(`  (${mins}분쯤 걸립니다. 창을 닫아도 계속 진행됩니다)`);
  }

  const candidates = [];
  const manual = [];
  const updates = new Map();     // code → 갱신할 값
  let retired = 0;
  let parseFailures = 0;

  try {
    for (let i = 0; i < targets.length; i++) {
      const entry = targets[i];
      const rows = await fetchRowsForCode(settings.galleryId, entry.value);
      const result = analyzeCode(rows, entry.value, entry);

      // 식별자를 못 읽었거나, 차단/해제 상태를 못 읽은 행. 후자를 빼먹으면
      // 해제된 사람이 전원 '차단 중'으로 보이는데 경고가 안 뜬다.
      const unparsed = rows.filter((r) => !r.identity || r.stateUnknown).length;
      if (unparsed) {
        await log(`  [경고] ${entry.value}: ${unparsed}개 행의 식별자를 읽지 못했습니다.`);
      }
      // 표에는 행이 있는데 우리가 못 읽은 경우. 마크업이 바뀌면 여기가 먼저 운다.
      // 이걸 안 보면 "이력 없음"으로 조용히 넘어가고, 아무도 안 막힌 채
      // 60일 뒤 명단이 자동 중지된다.
      if (rows.missedRows) {
        parseFailures++;
        await log(
          `  [경고] ${entry.value}: 표에 ${rows.expectedRows}행이 있는데 ` +
          `${rows.length}행만 읽었습니다. 디시 화면 구조가 바뀐 것 같습니다.`
        );
      }

      const upd = { nextCheckAt: result.nextCheckAt, lastVerifiedAt: now };

      if (result.status === "none") {
        // 해제 목록은 30일만 보관된다. 오래 안 보이면 추적할 방법이 없으므로
        // 계속 조회해봐야 요청만 낭비된다. 자동으로 쉬게 한다.
        const firstMiss = entry.missingSince || now;
        upd.missingSince = firstMiss;
        if (now - firstMiss > 60 * DAY) {
          upd.enabled = false;
          upd.memo = (entry.memo || "") + " / 60일간 기록 없어 자동 중지";
          retired++;
        }
      } else {
        upd.missingSince = null;
        upd.lastSeen = now;
      }
      updates.set(entry.value, upd);

      if (result.status === "candidate") candidates.push(result.candidate);
      if (result.status === "manual") manual.push(result);

      // 조회 진행 상황은 많을 때만 띄엄띄엄 남긴다
      if ((i + 1) % 25 === 0) await touchBusy();

      if (targets.length <= 20 || (i + 1) % 25 === 0 || i + 1 === targets.length) {
        const verdict = {
          candidate: "재차단 필요",
          manual: "완장이 직접 해제 — 건너뜀",
          active: "이상 없음",
          none: "이력 없음",
        }[result.status];
        await log(`  [${i + 1}/${targets.length}] ${entry.value}: ${rows.length}건 조회 — ${verdict}`);
      }

      await new Promise((r) => setTimeout(r, 400));   // 서버 부담 최소화
    }
  } catch (e) {
    await log(`[오류] ${e.message}`);
    await setStatus("오류 발생", false);
    await saveWatchlistUpdates(updates);
    return { ok: false, error: e.message };
  }

  await saveWatchlistUpdates(updates);
  await chrome.storage.local.set({ candidates, manual, lastCheck: now });

  if (parseFailures) {
    await log(
      `[경고] ${parseFailures}명의 조회에서 표를 제대로 읽지 못했습니다. ` +
      `판정 결과를 믿지 마시고, 관리 화면에서 직접 확인해 주세요.`
    );
    notify(
      "차단 목록을 읽지 못했습니다",
      `${parseFailures}건에서 표 구조가 예상과 다릅니다. 결과를 믿지 마세요.`
    );
  }
  if (retired) {
    await log(`[안내] ${retired}명은 60일간 기록이 없어 자동으로 중지했습니다.`);
  }
  if (manual.length) {
    await log(
      `[안내] ${manual.length}명은 차단 기간이 남았는데 해제돼 있습니다. ` +
      `완장이 직접 풀어준 것으로 보여 재차단하지 않았습니다.`
    );
  }

  if (candidates.length) {
    await log(`재차단 후보 ${candidates.length}건을 찾았습니다.`);
    await setStatus(`후보 ${candidates.length}건 — 확인 후 실행하세요`, false);
    if (settings.notify) {
      notify("재차단 후보 발견", `${candidates.length}명의 차단이 풀렸습니다.`);
    }
    if (auto && settings.autoApply) {
      await log("자동 실행이 켜져 있어 바로 재차단합니다.");
      return await runApply();
    }
  } else {
    await log("재차단할 대상이 없습니다.");
    await setStatus(parseFailures ? "경고 — 목록을 읽지 못함" : "이상 없음", false);
  }
  return { ok: true, candidates, parseFailures };
}

// --------------------------------------------------------------- 실행

async function runApply() {
  const { settings, candidates, history } = await getState();
  if (!candidates.length) return { ok: true };

  if (candidates.length > settings.maxPerRun) {
    await log(
      `[중단] 후보 ${candidates.length}건이 한도(${settings.maxPerRun}건)를 넘습니다.`
    );
    await setStatus("한도 초과로 중단", false);
    return { ok: false };
  }

  await setStatus("재차단 실행 중...", true);

  // 사유가 다르면 한 번에 보낼 수 없으므로 사유별로 나눈다
  const byReason = {};
  for (const c of candidates) (byReason[c.reason] ||= []).push(c);

  const stamp = Date.now();
  const records = [];

  try {
    for (const [reason, group] of Object.entries(byReason)) {
      const codes = group.map((c) => c.code);
      await log(`재차단 실행: 사유 '${reason}' ${codes.length}건`);

      const result = await blockCodes(
        settings.galleryId, codes, reason, HOURS_31D,
        async (msg) => { await log(msg); await touchBusy(); }
      );
      const done = new Set(result.verified);
      await log(`  → ${result.message}`);

      for (const c of group) {
        records.push({
          time: stamp, code: c.code, label: c.label, reason,
          hours: HOURS_31D, ok: done.has(c.code),
        });
      }
    }
  } catch (e) {
    await log(`[오류] ${e.message}`);
    await setStatus("오류 발생", false);
    return { ok: false, error: e.message };
  }

  // 재차단에 성공했으면 31일 뒤에 다시 보면 된다
  const okCodes = new Set(records.filter((r) => r.ok).map((r) => r.code));
  if (okCodes.size) {
    const next = Date.now() + HOURS_31D * 3600 * 1000 + 60 * 1000;
    const upd = new Map();
    for (const c of okCodes) upd.set(c, { nextCheckAt: next, lastSeen: Date.now() });
    await saveWatchlistUpdates(upd);
  }

  const okCount = records.filter((r) => r.ok).length;
  await chrome.storage.local.set({
    history: [...history, ...records].slice(-500),
    candidates: [],
  });

  if (okCount === records.length) {
    await log(`완료: ${okCount}/${records.length}건 확인`);
    await setStatus(`재차단 ${okCount}건 완료`, false);
  } else {
    await log(`[주의] ${okCount}/${records.length}건만 확인됐습니다.`);
    await setStatus(`일부 실패 (${okCount}/${records.length})`, false);
  }
  return { ok: true };
}

// 예약을 전부 지워 다음 확인 때 명단 전원을 다시 보게 한다.
// 손으로 차단을 풀었거나 뭔가 어긋났다 싶을 때 쓴다.
async function runRecheckAll() {
  const { watchlist } = await getState();
  for (const t of watchlist) t.nextCheckAt = 0;
  await chrome.storage.local.set({ watchlist });
  await log(`명단 ${watchlist.length}명의 예약을 지웠습니다. 전원을 다시 확인합니다.`);
  return await runCheck({ auto: false });
}

// --------------------------------------------------------------- 명단 채우기

async function runScan(pages = 10) {
  const { settings, watchlist } = await getState();
  if (!settings.galleryId) {
    await log("갤러리 ID가 설정되지 않았습니다.");
    return { ok: false };
  }

  await setStatus("31일 차단 목록을 훑는 중...", true);
  await log(`차단 목록에서 31일 차단을 모읍니다 (최대 ${pages}페이지)`);

  try {
    const { items, pages: read, more, missed, repeated, scanned } =
      await collectByDuration(
        settings.galleryId, "31일", pages,
        (page, found) => { if (page % 3 === 0) log(`  ${page}페이지째, ${found}명 발견`); }
      );

    await log(`  ${read}페이지에서 차단 이력 ${scanned}행을 읽었습니다.`);

    // 페이지 넘기기가 실제로 먹었는지 눈에 보이게 남긴다.
    // 예전에 링크를 못 읽어 1페이지만 훑고도 조용히 끝난 적이 있다.
    if (repeated) {
      await log(
        `  [안내] 다음 페이지가 앞 페이지와 같은 내용이라 여기서 멈췄습니다.`
      );
      await log(
        `  목록이 ${read}페이지뿐이면 정상입니다. 실제로 더 있는데 이 줄이 떴다면 알려주세요.`
      );
    }
    if (missed) {
      await log(
        `  [경고] 표에 있는데 못 읽은 행이 ${missed}개 있습니다. ` +
        `불러온 명단이 실제보다 적습니다. 디시 화면 구조가 바뀐 것 같습니다.`
      );
      notify("차단 목록을 읽지 못했습니다", `${missed}행을 읽지 못했습니다. 결과가 불완전합니다.`);
    }

    const known = new Set(watchlist.map((t) => t.value));
    const fresh = items.filter((i) => !known.has(i.code));

    await chrome.storage.local.set({ imports: fresh });
    await log(
      `${read}페이지에서 31일 차단 ${items.length}명 발견, ` +
      `그중 명단에 없는 사람 ${fresh.length}명.` +
      (more ? ` (${pages}페이지 상한에 걸렸습니다. 페이지 수를 늘려보세요)` : "")
    );
    await setStatus(`명단 후보 ${fresh.length}명`, false);
    return { ok: true };
  } catch (e) {
    await log(`[오류] ${e.message}`);
    await setStatus("오류 발생", false);
    return { ok: false, error: e.message };
  }
}

// --------------------------------------------------------------- 스케줄

// 예정 시각 비교는 로컬 시간(setHours)으로 한다. 그러니 '오늘' 키도 로컬이어야
// 한다. toISOString은 UTC라 KST에서 09:00 이전 확인 시각을 넣으면 날짜가 어긋난다.
function localDateKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 브라우저가 꺼졌다 켜졌으면 진행 중이던 작업은 이미 죽은 것이다. 잠금을 푼다.
async function clearStaleLock() {
  const { status } = await chrome.storage.local.get("status");
  if (status && status.busy) {
    await chrome.storage.local.set({
      status: { text: "대기 중", busy: false, busySince: 0 },
    });
    await log("[안내] 끝나지 않은 채 남아 있던 작업 표시를 풀었습니다.");
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("tick", { periodInMinutes: 15 });
});
chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create("tick", { periodInMinutes: 15 });
  await clearStaleLock();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "tick") return;

  const { settings, status, ranToday } = await getState();
  if (isBusy(status)) return;
  if (status.busy) await clearStaleLock();   // 시간이 지난 잠금은 풀고 진행한다

  const now = new Date();
  const today = localDateKey(now);
  const keep = ranToday.filter((k) => k.startsWith(today));

  for (const t of settings.checkTimes) {
    const key = `${today} ${t}`;
    if (keep.includes(key)) continue;

    const [hh, mm] = t.split(":").map(Number);
    const due = new Date(now);
    due.setHours(hh, mm, 0, 0);

    // 예정 시각을 지났고 30분 이내일 때만. 브라우저가 꺼져 있던 시간은 건너뛴다.
    const diff = now - due;
    if (diff >= 0 && diff < 30 * 60 * 1000) {
      keep.push(key);
      await chrome.storage.local.set({ ranToday: keep });
      await log(`예정된 확인 시각(${t})입니다.`);
      await runCheck({ auto: true });
      return;
    }
  }
  await chrome.storage.local.set({ ranToday: keep });
});

// --------------------------------------------------------------- 팝업 요청

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      // 이미 돌고 있는데 또 누르면 같은 작업이 겹친다. 다만 굳은 잠금은 풀어준다.
      const { status } = await chrome.storage.local.get("status");
      if (isBusy(status)) {
        sendResponse({ ok: false, error: "작업이 진행 중입니다. 끝나면 다시 눌러주세요." });
        return;
      }
      if (status && status.busy) await clearStaleLock();

      if (msg.type === "check") sendResponse(await runCheck({ auto: false }));
      else if (msg.type === "apply") sendResponse(await runApply());
      else if (msg.type === "scan") sendResponse(await runScan(msg.pages));
      else if (msg.type === "recheckAll") sendResponse(await runRecheckAll());
      else sendResponse({ ok: false, error: "알 수 없는 요청" });
    } catch (e) {
      await log(`[오류] ${e.message}`);
      await setStatus("오류 발생", false);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;   // 비동기 응답
});
