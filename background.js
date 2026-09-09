// background.js — 정기 확인과 재차단 실행.
//
// 팝업은 닫히면 죽으므로 실제 작업은 전부 여기서 한다.
// 결과는 chrome.storage에 넣고, 팝업은 그걸 읽어서 보여준다.

import {
  HOURS_31D, analyzeCode, blockCodes, collectByDuration, fetchRowsForCode,
  collectActivity, checkGallog, pickGallogTargets,
  isBusy, localDateKey, jitter, CHECK_DELAY_MS, GALLOG_DELAY_MS, GALLOG_FAIL_STREAK,
  rowHealth, carryOver,
} from "./dc.js";

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
// (300명 조회가 1.2초 간격이라 조회 시간까지 9분대. 30분이면 여유가 있다.
//  조회 인원 상한을 1000명 넘게 올리면 이 여유가 사라진다 — 아래 touchBusy가 받쳐준다)

// 30분이 넘는 정상 작업도 있을 수 있다(조회 인원을 크게 잡은 경우).
// 그대로 두면 작업 도중에 잠금이 만료돼 두 번째 실행이 겹친다. 살아 있다고 알린다.
async function touchBusy() {
  const { status } = await chrome.storage.local.get("status");
  if (status && status.busy) {
    await chrome.storage.local.set({ status: { ...status, busySince: Date.now() } });
  }
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
    // 후보를 지우지 않는다. 하루 한도에 걸려 남겨둔 사람이 여기서 조용히
    // 사라지곤 했다. 조회를 안 했으면 판정이 바뀔 이유도 없다.
    await chrome.storage.local.set({ lastCheck: now });
    const { candidates: kept = [] } = await chrome.storage.local.get("candidates");
    return { ok: true, candidates: kept };
  }

  await setStatus("차단 목록 확인 중...", true);
  await log(
    `명단 ${enabled.length}명 중 ${targets.length}명을 조회합니다` +
    (sweep.length ? ` (만료 ${due.length}명 + 점검 ${sweep.length}명)` : "") +
    (due.length > cap ? ` — ${due.length}명 중 ${cap}명, 나머지는 다음 차례에` : "")
  );
  if (targets.length > 60) {
    // 1.2를 리터럴로 적어두면 간격을 고칠 때 같이 안 고쳐진다. 실제로 이 줄은
    // 간격이 400ms인데 갤로그의 1.2초로 계산하고 있어서 3배 부풀려 있었다.
    // 난수는 평균이 base라 간격이 그대로 예상 시간이 된다(조회 시간은 그 위에 붙는다).
    const mins = Math.ceil((targets.length * (CHECK_DELAY_MS / 1000)) / 60);
    await log(`  (${mins}분쯤 걸립니다. 창을 닫아도 계속 진행됩니다)`);
  }

  const candidates = [];
  const manual = [];
  const updates = new Map();     // code → 갱신할 값
  let retired = 0;
  let parseFailures = 0;   // 표에 있는 행을 못 읽음
  let stateFailures = 0;   // 차단/해제 칸을 못 읽음
  let idFailures = 0;      // 식별자를 못 읽음

  try {
    for (let i = 0; i < targets.length; i++) {
      const entry = targets[i];
      const rows = await fetchRowsForCode(settings.galleryId, entry.value);
      const result = analyzeCode(rows, entry.value, entry);

      // 행 수 대조만으로는 부족하다. 표는 멀쩡히 읽었는데 칸 하나가 안 읽히면
      // missedRows가 0이라 아무 경고도 안 뜬다. v1.5.2에서 실제로 그렇게 멈췄다.
      const health = rowHealth(rows);

      // 상태 칸을 못 읽으면 released가 전부 false가 되어 해제된 사람이
      // '차단 중'으로 보인다. 후보가 0건인데 화면은 조용한, 최악의 실패다.
      if (health.badState) {
        stateFailures++;
        await log(
          `  [경고] ${entry.value}: ${health.badState}개 행의 차단/해제 칸을 읽지 못했습니다. ` +
          `해제된 사람이 '차단 중'으로 보일 수 있습니다.`
        );
      }
      // 식별자를 못 읽은 행은 analyzeCode가 남의 것으로 보고 버린다.
      if (health.badIdentity) {
        idFailures++;
        await log(`  [경고] ${entry.value}: ${health.badIdentity}개 행의 식별자를 읽지 못했습니다.`);
      }
      // 표에는 행이 있는데 우리가 못 읽은 경우. 마크업이 바뀌면 여기가 먼저 운다.
      // 이걸 안 보면 "이력 없음"으로 조용히 넘어가고, 아무도 안 막힌 채
      // 60일 뒤 명단이 자동 중지된다.
      if (health.missed) {
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

      // 400ms 고정이었다. 일정한 간격 자체가 사람이 만들 수 없는 신호다.
      await new Promise((r) => setTimeout(r, jitter(CHECK_DELAY_MS)));
    }
  } catch (e) {
    await log(`[오류] ${e.message}`);
    // 로그인이 풀렸거나 권한이 없으면 여기로 온다. 그런데 만료 예정 시각은
    // 이미 명단에 저장돼 있어서 디시에 묻지 않고도 셀 수 있다. 아무 말도 안
    // 하면 완장은 그냥 창을 닫고, 재차단할 사람이 있어도 모르고 지나간다.
    const waiting = enabled.filter((t) => t.nextCheckAt && now >= t.nextCheckAt).length;
    if (waiting) {
      await log(
        `  저장된 기록으로는 ${waiting}명이 이미 만료 예정 시각을 지났습니다. ` +
        `디시에 로그인한 뒤 다시 확인해 주세요.`
      );
    }
    await setStatus("오류 발생", false);
    await saveWatchlistUpdates(updates);
    return { ok: false, error: e.message };
  }

  await saveWatchlistUpdates(updates);

  // 이번에 조회한 사람만 결과를 갈아끼운다. 안 본 사람의 옛 판정은 남긴다.
  //
  // 이게 없으면 '완장이 직접 해제' 목록이 한 번 더 확인할 때 통째로 사라진다.
  // manual 판정은 nextCheckAt이 7일 뒤라 다음 조회 대상에서 빠지는데,
  // 그대로 덮어쓰면 빈 배열이 되어 '명단에서 빼기' 버튼까지 같이 없어진다.
  // 사용자는 아무 안내도 못 받고 목록만 비는 것을 본다.
  //
  // 후보도 마찬가지다. 하루 차단 한도에 걸려 못 보낸 사람을 후보에 남겨뒀는데,
  // 그 뒤 조회 한 번이면 그 사람들이 조용히 사라진다.
  const checkedNow = new Set(targets.map((t) => t.value));
  const stillWatched = new Set(
    watchlist.filter((t) => t.enabled !== false).map((t) => t.value)
  );
  const prev = await chrome.storage.local.get(["candidates", "manual"]);
  const keep = (list) => carryOver(list, checkedNow, stillWatched);

  const allCandidates = [...candidates, ...keep(prev.candidates)];
  const allManual = [...manual, ...keep(prev.manual)];
  const carried = allCandidates.length - candidates.length;

  await chrome.storage.local.set({
    candidates: allCandidates,
    manual: allManual,
    lastCheck: now,
  });

  // 셋 중 하나라도 있으면 이번 판정을 믿으면 안 된다.
  // 특히 후보가 0건일 때가 위험하다. 아무 일도 안 일어난 것과 구별이 안 된다.
  const brokenChecks = parseFailures + stateFailures + idFailures;
  if (brokenChecks) {
    if (parseFailures) {
      await log(`[경고] ${parseFailures}명의 조회에서 표의 행을 다 읽지 못했습니다.`);
    }
    if (stateFailures) {
      await log(
        `[경고] ${stateFailures}명의 조회에서 차단/해제 상태를 읽지 못했습니다. ` +
        `후보가 0건으로 나와도 그대로 믿지 마세요.`
      );
    }
    if (idFailures) {
      await log(`[경고] ${idFailures}명의 조회에서 식별자를 읽지 못했습니다.`);
    }
    await log(`  디시 화면 구조가 바뀐 것 같습니다. 관리 화면에서 직접 확인해 주세요.`);
    notify(
      "차단 목록을 읽지 못했습니다",
      `${brokenChecks}건에서 표 구조가 예상과 다릅니다. 결과를 믿지 마세요.`
    );
  }
  if (retired) {
    await log(`[안내] ${retired}명은 60일간 기록이 없어 자동으로 중지했습니다.`);
  }
  if (allManual.length) {
    await log(
      `[안내] ${allManual.length}명은 차단 기간이 남았는데 해제돼 있습니다. ` +
      `완장이 직접 풀어준 것으로 보여 재차단하지 않았습니다.`
    );
  }
  if (carried) {
    await log(`[안내] 이번에 조회하지 않은 후보 ${carried}명은 목록에 그대로 뒀습니다.`);
  }

  if (allCandidates.length) {
    await log(
      `재차단 후보 ${allCandidates.length}건입니다` +
      (carried ? ` (이번에 새로 찾은 것 ${candidates.length}건)` : "") + "."
    );
    await setStatus(`후보 ${allCandidates.length}건 — 확인 후 실행하세요`, false);
    if (settings.notify && candidates.length) {
      notify("재차단 후보 발견", `${candidates.length}명의 차단이 풀렸습니다.`);
    }
    if (auto && settings.autoApply) {
      // 표를 제대로 못 읽은 조회가 섞여 있으면 후보 목록도 못 믿는다.
      // 그 상태로 자동 실행하면 잘못 읽은 판정으로 사람을 막게 된다.
      if (brokenChecks) {
        await log("[중단] 목록을 제대로 읽지 못한 조회가 있어 자동 실행을 건너뜁니다.");
        await log("  화면에서 후보를 확인한 뒤 직접 실행해 주세요.");
      } else {
        await log("자동 실행이 켜져 있어 바로 재차단합니다.");
        return await runApply();
      }
    }
  } else {
    await log("재차단할 대상이 없습니다.");
    await setStatus(brokenChecks ? "경고 — 목록을 읽지 못함" : "이상 없음", false);
  }
  return { ok: true, candidates: allCandidates, parseFailures, stateFailures, idFailures };
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
  // 하루 차단 한도에 걸려 못 보낸 사람들. 후보에 남겨두고 다음에 다시 시도한다.
  let remaining = [];
  let limitHit = false;
  let limitMessage = "";

  try {
    for (const [reason, group] of Object.entries(byReason)) {
      if (limitHit) {
        // 이미 한도에 걸렸다면 남은 사유도 보낼 수 없다
        remaining.push(...group);
        continue;
      }

      const codes = group.map((c) => c.code);
      await log(`재차단 실행: 사유 '${reason}' ${codes.length}건`);

      const result = await blockCodes(
        settings.galleryId, codes, reason, HOURS_31D,
        async (msg) => { await log(msg); await touchBusy(); }
      );
      const done = new Set(result.verified);
      await log(`  → ${result.message}`);

      if (result.limitHit) {
        limitHit = true;
        limitMessage = result.limitMessage || "";
      }

      // 아예 보내지 못한 사람은 이력에 남기지 않는다.
      // 시도조차 안 한 걸 '실패'로 적으면 나중에 이력을 못 믿게 된다.
      const notSent = new Set(result.notSent || []);
      for (const c of group) {
        if (notSent.has(c.code)) { remaining.push(c); continue; }
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

  if (limitHit) {
    await log(`[중단] 하루 차단 한도에 걸렸습니다.`);
    if (limitMessage) await log(`  디시가 알려준 문구: ${limitMessage}`);
    await log(
      `  ${remaining.length}명을 못 보냈습니다. 후보 목록에 그대로 남겨둡니다.`
    );
    // 한도는 '장시간 차단'만 막는다. 1시간과 6시간은 여전히 걸린다(2026-09-08 확인).
    // 급한 분탕은 관리 화면에서 짧게 눌러두고 내일 31일로 다시 걸면 된다.
    await log(
      `  한도에 걸려도 1시간·6시간 차단은 됩니다. 당장 막아야 할 사람이 있으면 ` +
      `관리 화면에서 짧게 걸어두고 내일 다시 실행하세요.`
    );
    await log(
      `  내일 다시 하거나, 후보 탭의 '남은 후보 복사'로 다른 완장에게 넘기세요.`
    );
    notify(
      "하루 차단 한도에 걸렸습니다",
      `${remaining.length}명이 남았습니다. 후보 목록에 그대로 있습니다.`
    );
  }

  const okCount = records.filter((r) => r.ok).length;
  await chrome.storage.local.set({
    history: [...history, ...records].slice(-500),
    candidates: remaining,
  });

  if (!records.length) {
    // 한 명도 못 보낸 경우. '완료: 0/0건 확인'은 성공처럼 읽힌다.
    // 후보는 그대로 남아 있으므로 그 사실을 말해준다.
    await log(`재차단된 사람이 없습니다. 후보 ${remaining.length}명은 그대로 남아 있습니다.`);
    await setStatus(
      limitHit ? `하루 한도 — 후보 ${remaining.length}명 대기` : "재차단 없음",
      false
    );
  } else if (okCount === records.length) {
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

async function runScan(pages = 10, untilDate = "", includeReleased = false) {
  const { settings, watchlist, status } = await getState();
  if (!settings.galleryId) {
    await log("갤러리 ID가 설정되지 않았습니다.");
    return { ok: false };
  }
  // 수백 페이지를 훑으면 몇 분이 걸린다. 그 사이 또 누르면 두 개가 같이 돈다.
  if (isBusy(status)) {
    await log("이미 다른 작업이 돌고 있습니다. 끝난 뒤에 다시 눌러주세요.");
    return { ok: false };
  }

  await setStatus("31일 차단 목록을 훑는 중...", true);
  await log(
    `차단 목록에서 31일 차단을 모읍니다` +
    (untilDate ? ` (${untilDate}까지)` : ` (최대 ${pages}페이지)`)
  );
  if (untilDate) {
    await log(`  날짜 기준입니다. ${pages}페이지는 안전장치일 뿐이고, 보통 그 전에 멈춥니다.`);
  }
  if (pages >= 100 || untilDate) {
    await log(`  페이지가 많으면 몇 분에서 수십 분 걸립니다. 창을 닫아도 계속 진행됩니다.`);
  }

  try {
    // 페이지가 많으면 기록이 진행 표시로만 가득 차 버린다(기록은 200줄만 남는다).
    const step = pages > 50 ? 25 : 3;
    let ticks = 0;
    const { items, releasedSkipped, pages: read, more, missed, repeated, scanned, reachedDate, oldest } =
      await collectByDuration(
        settings.galleryId, "31일", pages,
        async (page, found, atDate) => {
          // 잠금 갱신은 자주 해야 한다. 서비스워커는 30초쯤 조용하면 종료된다.
          if (++ticks % 10 === 0) await touchBusy();
          if (page % step === 0) {
            await log(`  ${page}페이지째 (${atDate}), ${found}명 발견`);
          }
        },
        untilDate, includeReleased
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

    await chrome.storage.local.set({ imports: fresh, importsAt: Date.now() });
    // 걸러낸 사람 수를 말해준다. 말없이 줄어들면 그것도 조용한 실패다.
    if (releasedSkipped) {
      await log(
        `  이미 차단이 해제된 ${releasedSkipped}명은 뺐습니다. ` +
        `필요하면 '이미 해제된 사람도 보기'를 켜고 다시 불러오세요.`
      );
    }
    await log(
      `${read}페이지에서 31일 차단 ${items.length}명 발견, ` +
      `그중 명단에 없는 사람 ${fresh.length}명.` +
      (reachedDate ? ` (${untilDate}까지 훑고 멈췄습니다)` : "") +
      (more
        ? ` (${pages}페이지 상한에 걸렸습니다. 가장 오래된 행이 ${oldest} 입니다` +
          (untilDate ? `, 아직 ${untilDate}까지 못 갔습니다` : "") + ")"
        : "")
    );
    // 다음에 '할 일' 탭에서 한 번에 불러올 때 어디부터 보면 되는지 쓴다.
    // 완장이 매번 날짜를 고르지 않아도 되게 하려는 것이다.
    await chrome.storage.local.set({ lastScanAt: Date.now() });
    await setStatus(`명단 후보 ${fresh.length}명`, false);
    return { ok: true, found: fresh.length };
  } catch (e) {
    await log(`[오류] ${e.message}`);
    await setStatus("오류 발생", false);
    return { ok: false, error: e.message };
  }
}

// --------------------------------------------------------------- 스케줄

// 예정 시각 비교는 로컬 시간(setHours)으로 한다. 그러니 '오늘' 키도 로컬이어야
// 한다. toISOString은 UTC라 KST에서 09:00 이전 확인 시각을 넣으면 날짜가 어긋난다.

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

// ── 명단 정리 ──────────────────────────────────────────────
// 명단이 커지면 이미 떠난 사람이 계속 남는다. 두 가지로 걸러낸다.
//   활동 점검: 갤 글 목록을 한 번 훑어 최근에 글을 쓴 식별코드를 모은다.
//              명단이 몇 명이든 요청 수가 같다.
//   갤로그 점검: 탈퇴한 계정을 찾는다. 이건 1인당 1요청이라 비싸다.
//              활동 점검으로 대상을 줄인 뒤에 돌리는 게 좋다.
//
// 어느 쪽도 자동으로 지우지 않는다. 표시만 하고 완장이 확인 후 지운다.
// 글 목록에는 댓글이 안 나오므로 '댓글로만 활동하는 사람'을 글 없음으로 본다.
// 이것 하나 때문에라도 자동 삭제는 안 된다.

async function runActivity(months = 3, maxPages = 2000) {
  const { settings, watchlist, status } = await getState();
  if (!settings.galleryId) {
    await log("갤러리 ID가 설정되지 않았습니다.");
    return { ok: false };
  }
  if (isBusy(status)) {
    await log("이미 다른 작업이 돌고 있습니다.");
    return { ok: false };
  }
  if (!watchlist.length) {
    await log("명단이 비어 있습니다.");
    return { ok: false };
  }

  const cut = new Date();
  cut.setMonth(cut.getMonth() - months);
  const untilDate = localDateKey(cut);

  await setStatus("갤 글 목록을 훑는 중...", true);
  await log(`활동 점검: ${untilDate} 이후 글쓴이를 모읍니다 (최대 ${maxPages}페이지)`);
  await log(`  한 페이지 100개씩 읽습니다. 갤이 크면 몇 분 걸립니다.`);

  try {
    let ticks = 0;
    const r = await collectActivity(
      settings.galleryId, maxPages,
      async (page, found, oldest) => {
        if (++ticks % 10 === 0) await touchBusy();
        if (page % 25 === 0) await log(`  ${page}페이지째 (${oldest}), 글쓴이 ${found}명`);
      },
      untilDate
    );

    await log(`  ${r.pages}페이지에서 글 ${r.scanned}개를 읽었습니다. 글쓴이 ${r.lastPost.size}명.`);
    if (r.repeated) {
      await log(`  [안내] 다음 페이지가 앞 페이지와 같아 멈췄습니다. page 파라미터를 확인하세요.`);
    }
    if (r.missed) {
      await log(`  [경고] 날짜를 못 읽은 줄이 ${r.missed}개 있습니다. 화면 구조가 바뀐 것 같습니다.`);
      notify("글 목록을 읽지 못했습니다", `${r.missed}줄을 건너뛰었습니다.`);
    }
    if (r.more) {
      await log(`  [안내] ${maxPages}페이지 상한에 걸렸습니다. 가장 오래된 글이 ${r.oldest} 입니다.`);
      await log(`  ${untilDate}까지 못 갔으므로 '글 없음' 판정은 믿지 마세요. 페이지 수를 늘리세요.`);
    }

    // 상한에 걸렸으면 판정하지 않는다. 덜 훑고 '글 없음'이라 하면 거짓말이 된다.
    const trustworthy = !r.more && !r.repeated;
    const now = Date.now();
    let quiet = 0;

    for (const t of watchlist) {
      if (t.kind !== "code") continue;
      const stamp = r.lastPost.get(t.value);
      if (stamp) {
        t.lastPostAt = new Date(stamp.replace(" ", "T")).getTime();
        t.noPostSince = 0;
      } else if (trustworthy) {
        t.lastPostAt = 0;
        t.noPostSince = untilDate;     // 이 날짜 이후로 글이 없다
        quiet++;
      }
      if (trustworthy) t.activityCheckedAt = now;
    }
    await chrome.storage.local.set({ watchlist });

    const msg = trustworthy
      ? `명단 ${watchlist.length}명 중 ${quiet}명이 ${months}개월간 글이 없습니다.`
      : `점검이 끝까지 가지 못해 판정을 남기지 않았습니다.`;
    await log(msg);
    await setStatus("대기 중", false);
    if (trustworthy) notify("활동 점검 완료", msg);
    return { ok: true, quiet, trustworthy };
  } catch (e) {
    await log(`[오류] ${e.message}`);
    await setStatus("오류 발생", false);
    return { ok: false, error: e.message };
  }
}

// 갤로그 점검은 한 명당 한 요청이라 이 확장에서 가장 위험한 경로다.
// 2026-09-08에 300명 × 400ms 고정 간격으로 돌린 직후 파딱 계정의 IP가 막혔다.
// 그래서 세 가지를 바꿨다.
//   1. 간격을 1200ms로 늘리고 난수로 흔든다 (일정한 간격 자체가 신호다)
//   2. 기본 인원을 50명으로 줄인다. 오래된 사람부터 도니 며칠에 걸쳐 다 돈다
//   3. 연속으로 실패하면 즉시 멈춘다. 이미 막힌 뒤에 계속 두드리지 않는다
async function runGallog(limit = 50, months = 0, onlyCodes = null) {
  const { watchlist, status } = await getState();
  if (isBusy(status)) {
    await log("이미 다른 작업이 돌고 있습니다.");
    return { ok: false };
  }

  const now = Date.now();

  // 누구를 볼지는 dc.js가 정한다. 규칙을 여기 두면 검사가 그 규칙을 베껴
  // 적게 되고, 그러면 실제 코드가 바뀌어도 검사가 통과해버린다.
  const { targets, fresh, tooSoon, waiting } =
    pickGallogTargets(watchlist, { now, limit, months, onlyCodes });

  if (!targets.length) {
    const why = [];
    if (fresh.length) why.push(`${fresh.length}명은 12시간 안에 이미 확인했습니다`);
    if (tooSoon.length) {
      why.push(`${tooSoon.length}명은 기록한 지 ${months}개월이 안 돼 아직 볼 필요가 없습니다`);
    }
    await log(
      "갤로그를 확인할 대상이 없습니다." + (why.length ? ` ${why.join(". ")}.` : "")
    );
    return { ok: true, checked: 0 };
  }

  // 인원이 적으면 몇 초다. Math.ceil로 분만 쓰면 2명짜리도 '1분'이 되어
  // 안내가 실제와 안 맞는다(2026-09-08 실제로 3초 걸린 작업에 1분이라고 했다).
  const secs = Math.round((targets.length * GALLOG_DELAY_MS) / 1000);
  const eta = secs < 60 ? `${secs}초` : `${Math.ceil(secs / 60)}분`;
  await setStatus(`갤로그 확인 중 (0/${targets.length})`, true);
  await log(`갤로그 점검: ${targets.length}명을 확인합니다. 한 명당 한 번씩 요청합니다.`);
  await log(`  글·댓글 수도 같이 기록합니다. 다음 점검 때와 비교해 변동이 없으면 알려줍니다.`);
  await log(`  ${eta}쯤 걸립니다. 디시가 IP를 막지 않도록 일부러 천천히 돕니다.`);
  await log(
    `  한 번 누르면 ${targets.length}명만 보고 끝납니다. ` +
    `다시 누르면 다음 사람들입니다. 오래 안 본 사람부터 돕니다.`
  );
  if (fresh.length) {
    await log(`  (12시간 안에 확인한 ${fresh.length}명은 건너뜁니다)`);
  }
  if (tooSoon.length) {
    await log(
      `  (기록한 지 ${months}개월이 안 된 ${tooSoon.length}명은 건너뜁니다. ` +
      `기간이 지나야 비교할 뜻이 생깁니다)`
    );
  }
  if (waiting > 0) await log(`  (${waiting}명은 다음 차례입니다)`);

  const tally = { deleted: 0, notfound: 0, alive: 0, other: 0, error: 0 };
  let counted = 0, uncounted = 0;
  let streak = 0, aborted = false, lastBytes = 0;
  let done = 0;

  try {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const { state, counts, bytes } = await checkGallog(t.value);
      done++;
      t.gallogState = state;
      t.gallogCheckedAt = now;
      tally[state] = (tally[state] || 0) + 1;

      if (counts) {
        counted++;
        streak = 0;
        t.gallogCountedAt = now;
        t.gallogPosts = counts.posts;
        t.gallogComments = counts.comments;
        // 숫자가 그대로면 gallogSince를 건드리지 않는다. 그래야 '언제부터
        // 이 숫자였는지'가 쌓인다. 바뀌었으면 그 순간부터 다시 센다.
        // 줄어든 것도 '변동'이다. 글을 지운 것도 활동한 흔적이니 명단에 남긴다.
        if (t.gallogTotal !== counts.total) {
          t.gallogTotal = counts.total;
          t.gallogSince = now;
        }
      } else if (state === "alive") {
        uncounted++;
        streak++;
        lastBytes = bytes;
      } else if (state === "error" || state === "other") {
        // 응답 자체가 안 오는 것도 막혔다는 신호다.
        streak++;
        lastBytes = bytes;
      } else {
        streak = 0;   // deleted/notfound 는 정상적인 결과다
      }

      // 이미 막혔는데 계속 두드리면 차단만 길어진다. 실제 사고 때 258번을 더 보냈다.
      if (streak >= GALLOG_FAIL_STREAK) {
        aborted = true;
        break;
      }

      if ((i + 1) % 10 === 0) {
        await touchBusy();
        await setStatus(`갤로그 확인 중 (${i + 1}/${targets.length})`, true);
      }
      if (i + 1 < targets.length) {
        await new Promise((r) => setTimeout(r, jitter(GALLOG_DELAY_MS)));
      }
    }
    await chrome.storage.local.set({ watchlist });

    await log(
      `  ${done}명 확인 — 탈퇴 ${tally.deleted}명, 코드 확인 필요 ${tally.notfound}명, ` +
      `정상 ${tally.alive}명, 판단 불가 ${tally.other + tally.error}명`
    );
    if (counted) {
      await log(`  ${counted}명의 글·댓글 수를 기록했습니다.`);
    }

    if (aborted) {
      // 여기가 핵심이다. 예전에는 이 상황을 '화면 구조가 바뀐 것 같다'고만 말했다.
      // 실제 원인은 IP 차단이었고, 엉뚱한 곳을 고치러 갈 뻔했다.
      await log(`  [중단] ${GALLOG_FAIL_STREAK}명 연속으로 갤로그를 읽지 못해 멈췄습니다.`);
      await log(`  마지막 응답 본문이 ${lastBytes}바이트였습니다.`);
      if (lastBytes < 500) {
        await log(`  본문이 거의 비어 있습니다. 디시가 접속을 막았을 가능성이 큽니다.`);
        await log(`  브라우저로 gall.dcinside.com 에 들어가 보세요. 하얀 화면이면 IP 차단입니다.`);
        await log(`  30분쯤 기다리거나 인터넷 연결(IP)을 바꾸면 풀립니다. 남은 사람은 다음에 이어서 봅니다.`);
      } else {
        await log(`  본문은 정상 길이입니다. 갤로그 화면 구조가 바뀌었을 수 있습니다.`);
        await log(`  갤로그를 열어 F12로 게시글·댓글 수 부분의 HTML을 떠서 알려주세요.`);
      }
      notify(
        "갤로그 점검을 중단했습니다",
        lastBytes < 500
          ? "디시가 접속을 막은 것 같습니다. 기록 창을 확인하세요."
          : "갤로그를 읽지 못했습니다. 기록 창을 확인하세요."
      );
    } else if (uncounted) {
      // 중간중간 섞여 실패한 경우. 연속이 아니라서 차단은 아닐 가능성이 크다.
      // 숫자를 못 읽었으면 0으로 두면 안 된다. 그대로 두고 눈에 보이게 남긴다.
      await log(
        `  [경고] ${uncounted}명은 갤로그가 열렸는데 글·댓글 수를 읽지 못했습니다. ` +
        `그 사람들의 옛 숫자는 그대로 두었습니다.`
      );
      notify("갤로그 숫자를 읽지 못했습니다", `${uncounted}명. 결과를 믿지 마세요.`);
    }

    if (tally.notfound) {
      await log(`  [안내] 404가 나온 코드는 자동으로 지우지 않습니다. 직접 확인해 주세요.`);
    }
    // 이번에 못 본 사람. tooSoon은 '아직 볼 필요가 없는' 사람이라 빼고 센다.
    const left = targets.length - done + waiting;
    if (left > 0) {
      await log(`  아직 ${left}명이 남았습니다. 다음에 다시 누르면 이어서 봅니다.`);
    }
    await setStatus(aborted ? "갤로그 점검 중단됨" : "대기 중", false);
    if (tally.deleted) {
      notify("탈퇴한 계정을 찾았습니다", `${tally.deleted}명. 명단 → 빼기 에서 확인하세요.`);
    }
    return { ok: !aborted, checked: done, tally, aborted };
  } catch (e) {
    await chrome.storage.local.set({ watchlist });   // 여기까지 읽은 것은 살린다
    await log(`[오류] ${e.message}`);
    await setStatus("오류 발생", false);
    return { ok: false, error: e.message };
  }
}

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
      else if (msg.type === "scan") sendResponse(await runScan(msg.pages, msg.until, msg.includeReleased));
      else if (msg.type === "recheckAll") sendResponse(await runRecheckAll());
      else if (msg.type === "activity") sendResponse(await runActivity(msg.months, msg.pages));
      else if (msg.type === "gallog") sendResponse(await runGallog(msg.limit, msg.months, msg.codes));
      else sendResponse({ ok: false, error: "알 수 없는 요청" });
    } catch (e) {
      await log(`[오류] ${e.message}`);
      await setStatus("오류 발생", false);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;   // 비동기 응답
});
