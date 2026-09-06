// dc.js — 디시 관리 페이지 조회 / 차단 실행.
//
// MV3 서비스워커에는 DOMParser가 없어서 정규식으로 표를 파싱한다.
// 뽑아낼 게 표 몇 칸뿐이라 이걸로 충분하다.

export const BLOCK_URL = "https://gall.dcinside.com/mgallery/management/block";
export const AVOID_API =
  "https://gall.dcinside.com/ajax/managements_ajax/user_code_avoid";

export const HOURS_31D = 744;

export const HOURS_BY_LABEL = {
  "1시간": 1, "6시간": 6, "1일": 24, "7일": 168, "14일": 336, "31일": 744,
};

export const REASON_VALUES = {
  "음란성": "1", "광고": "2", "욕설": "3", "도배": "4",
  "혐오 콘텐츠": "5", "저작권 침해": "6", "명예훼손": "7",
};

export function labelForHours(hours) {
  for (const [label, h] of Object.entries(HOURS_BY_LABEL)) {
    if (h === hours) return label;
  }
  return `${hours}시간`;
}

// --------------------------------------------------------------- 식별자

export const KIND = { CODE: "code", CODE_IP: "code_ip", IP: "ip" };

const IP_MASKED = /^\d{1,3}\.\d{1,3}\.\*\.\*$/;
const IP_FULL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function isIp(text) {
  const t = (text || "").trim();
  return IP_MASKED.test(t) || IP_FULL.test(t);
}

// 파이썬 identity.py와 같은 규칙.
// code와 code_ip는 같은 사람이므로 매칭 키를 코드값 하나로 합친다.
// IP는 자동 갱신 대상이 아니라서 matchKey가 null이다.
export function makeIdentity(kind, value, nick = "") {
  return {
    kind, value, nick,
    label: kind === KIND.CODE_IP ? `${value} + IP` : value,
    matchKey: kind === KIND.IP ? null : value,
  };
}

// --------------------------------------------------------------- 파싱

function stripTags(html) {
  return (html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function decode(text) {
  return (text || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function pick(html, re) {
  const m = html.match(re);
  return m ? decode(m[1]).trim() : "";
}

function parseNikCell(cellHtml) {
  // <script> 템플릿이 섞여 있으므로 먼저 걷어낸다.
  const clean = cellHtml.replace(/<script[\s\S]*?<\/script>/gi, "");

  // '+ IP' 여부는 태그로 판정한다. 텍스트로 뽑기 전에 먼저 봐야 한다.
  const hasIpTag = /class="txtip"/.test(clean);

  // 검색 결과에서는 디시가 검색어를 태그로 감싸 강조한다.
  // 그래서 HTML 상태로 괄호 안을 찾으면 실패한다. 태그를 다 걷어낸 뒤 텍스트에서 뽑는다.
  // 이때 태그를 공백으로 바꾸면 안 된다. 강조가 단어 중간에 걸리면
  // (lea<span>f451</span>7) 처럼 되어 코드가 쪼개진다.
  const text = decode(clean.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

  const matches = [...text.matchAll(/\(([^()]+)\)/g)];
  if (matches.length === 0) return null;

  const last = matches[matches.length - 1];
  const value = last[1].trim();
  const nick = text.slice(0, last.index).trim();

  if (isIp(value)) return makeIdentity(KIND.IP, value, nick);
  return makeIdentity(hasIpTag ? KIND.CODE_IP : KIND.CODE, value, nick);
}

export function parseBlockList(html) {
  const tableMatch = html.match(
    /<table class="minor_block_list"[\s\S]*?<\/table>/i
  );
  if (!tableMatch) return [];

  const body = tableMatch[0].split(/<tbody[^>]*>/i)[1] || "";
  const rows = [];

  for (const trMatch of body.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const tr = trMatch[1];
    if (!/class="blocknum"/.test(tr)) continue;

    const dataNum = pick(tr, /class="blocknum"\s+data-num="(\d+)"/);
    const num = pick(tr, /class="blocknum"[^>]*>([^<]*)</);

    const nikCell = (tr.match(/<td class="blocknik"[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || "";
    const identity = parseNikCell(nikCell);

    const stateCell = (tr.match(/<td class="blockstate[^"]*"[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || "";
    const stateText = stripTags(stateCell);

    rows.push({
      num,
      dataNum,
      identity,
      reason: pick(tr, /<td class="blockreason"[^>]*>([^<]*)</i),
      duration: pick(tr, /<td class="blocktime"[^>]*>([^<]*)</i),
      date: pick(tr, /class="block_date"[^>]*>([^<]*)</i),
      // 처리 시각은 숨겨진 툴팁 안에 있다
      time: pick(tr, /class="block_time"[^>]*>\s*처리 시간\s*:\s*([^<]*)</i),
      handler: pick(tr, /class="block_conduct"[^>]*>\s*처리자\s*:\s*([^<]*)</i),
      stateText,
      released: stateText.includes("해제됨"),
    });
  }
  return rows;
}

// --------------------------------------------------------------- 통신

export async function getCiToken() {
  const cookie = await chrome.cookies.get({
    url: "https://gall.dcinside.com",
    name: "ci_c",
  });
  if (!cookie || !cookie.value) {
    throw new Error("ci_c 쿠키를 찾지 못했습니다. 디시에 로그인되어 있는지 확인하세요.");
  }
  return cookie.value;
}

function searchUrl(galleryId, code) {
  const params = new URLSearchParams({
    id: galleryId,
    s: "",
    s_type: "search_user_id",
    s_keyword: code,
  });
  return `${BLOCK_URL}?${params.toString()}`;
}

export async function fetchRowsForCode(galleryId, code) {
  const res = await fetch(searchUrl(galleryId, code), {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`목록 조회 실패 (HTTP ${res.status})`);
  const html = await res.text();

  if (!/minor_block_list/.test(html)) {
    if (/로그인/.test(html) && !/로그아웃/.test(html)) {
      throw new Error("로그인이 풀린 것 같습니다. 디시에 다시 로그인해 주세요.");
    }
    throw new Error("차단 목록을 읽지 못했습니다. 매니저 권한이 있는 갤러리인지 확인하세요.");
  }
  return parseBlockList(html);
}

// 검색은 코드별로 하므로 목록이 몇 페이지든 상관없다.
// 한 사람 이력이 한 페이지를 넘기는 경우가 드물어 첫 페이지만 본다.

// textarea 제한이 500자다. 한 번에 다 보내면 잘리므로 나눠서 보낸다.
const CODES_MAXLEN = 500;

export function chunkCodes(codes, maxlen = CODES_MAXLEN) {
  const batches = [];
  let cur = [], len = 0;
  for (const c of codes) {
    const add = c.length + (cur.length ? 1 : 0);
    if (cur.length && len + add > maxlen) {
      batches.push(cur);
      cur = [c];
      len = c.length;
    } else {
      cur.push(c);
      len += add;
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ?id=g 와 ?id=g&page=1 은 같은 페이지다. 정규화하지 않으면 1페이지를 두 번 읽는다.
function normalizeUrl(raw) {
  const u = new URL(raw, BLOCK_URL);
  const params = [...u.searchParams.entries()]
    .filter(([k, v]) => v !== "" && !(k === "page" && v === "1"))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = new URLSearchParams(params).toString();
  return u.toString();
}

function pageLinks(html) {
  const m = html.match(/<div class="bottom_paging_box[^"]*">([\s\S]*?)<\/div>/i);
  if (!m) return [];
  return [...m[1].matchAll(/href="([^"]+)"/g)]
    .map((x) => normalizeUrl(decode(x[1])));
}

// 차단 목록을 페이지 단위로 훑는다.
// 페이지네이션은 현재 페이지를 링크로 주지 않으므로, 방문한 주소를 기억하며
// 새로 나오는 링크만 큐에 넣는 방식으로 돈다.
async function crawlList(galleryId, maxPages, onPage) {
  const start = normalizeUrl(`${BLOCK_URL}?id=${encodeURIComponent(galleryId)}`);
  const seen = new Set([start]);
  const queue = [start];
  let pages = 0;

  while (queue.length && pages < maxPages) {
    const url = queue.shift();
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) {
      if (pages === 0) throw new Error(`목록 조회 실패 (HTTP ${res.status})`);
      break;
    }
    const html = await res.text();
    if (!/minor_block_list/.test(html)) {
      if (pages === 0) {
        throw new Error("차단 목록을 읽지 못했습니다. 갤러리 ID와 매니저 권한을 확인하세요.");
      }
      break;
    }

    pages++;
    onPage(parseBlockList(html), pages);

    for (const link of pageLinks(html)) {
      if (!seen.has(link)) {
        seen.add(link);
        queue.push(link);
      }
    }
    if (queue.length && pages < maxPages) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return { pages, more: queue.length > 0 };
}

// 차단 목록에서 특정 기간으로 '지금 차단 중'인 코드를 모은다.
// 방금 건 차단은 목록 맨 위에 오므로, 한 명씩 검색하는 것보다 요청이 훨씬 적다.
async function fetchRecentlyBlocked(galleryId, durationLabel, maxPages = 4) {
  const found = new Set();
  await crawlList(galleryId, maxPages, (rows) => {
    for (const r of rows) {
      if (!r.released && r.duration === durationLabel &&
          r.identity && r.identity.matchKey) {
        found.add(r.identity.matchKey);
      }
    }
  });
  return found;
}

// 명단 채우기용. 지정한 기간으로 걸린 사람을 최근 것부터 모아 준다.
// 같은 코드가 여러 번 나오면 가장 최근 것 하나만 남긴다.
export async function collectByDuration(galleryId, durationLabel, maxPages, onProgress) {
  const map = new Map();
  const { pages, more } = await crawlList(galleryId, maxPages, (rows, page) => {
    for (const r of rows) {
      if (r.duration !== durationLabel) continue;
      if (!r.identity || !r.identity.matchKey) continue;   // IP는 제외
      if (map.has(r.identity.matchKey)) continue;
      map.set(r.identity.matchKey, {
        code: r.identity.matchKey,
        label: r.identity.label,
        nick: r.identity.nick,
        reason: r.reason,
        date: r.date,
        time: r.time,
        released: r.released,
      });
    }
    if (onProgress) onProgress(page, map.size);
  });
  return { items: [...map.values()], pages, more };
}

export async function blockCodes(galleryId, codes, reason, hours = HOURS_31D, onProgress) {
  if (!codes.length) return { ok: true, verified: [], failed: [] };

  const reasonValue = REASON_VALUES[reason];
  if (!reasonValue) throw new Error(`알 수 없는 사유: ${reason}`);

  const ciT = await getCiToken();
  const batches = chunkCodes(codes);

  for (let i = 0; i < batches.length; i++) {
    if (onProgress && batches.length > 1) {
      onProgress(`  묶음 ${i + 1}/${batches.length} (${batches[i].length}명) 전송`);
    }

    const body = new URLSearchParams({
      ci_t: ciT,
      gallery_id: galleryId,
      _GALLTYPE_: "M",
      user_codes: batches[i].join("\n"),
      avoid_hour: String(hours),
      avoid_reason: reasonValue,
      avoid_reason_txt: "",
    });

    const res = await fetch(AVOID_API, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        accept: "application/json, text/javascript, */*; q=0.01",
      },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`차단 요청 실패 (HTTP ${res.status})`);

    if (i + 1 < batches.length) await new Promise((r) => setTimeout(r, 800));
  }

  // 서버 응답은 믿지 않는다. 목록을 다시 읽어서 실제로 걸렸는지 확인한다.
  // (목록 체크박스 경로가 성공 알림만 띄우고 아무 일도 안 했던 전례가 있다)
  const want = labelForHours(hours);
  await new Promise((r) => setTimeout(r, 1000));

  const blocked = await fetchRecentlyBlocked(galleryId, want);
  const verified = codes.filter((c) => blocked.has(c));
  let failed = codes.filter((c) => !blocked.has(c));

  // 목록 앞쪽에서 못 찾은 것만 개별 검색으로 한 번 더 본다.
  // 여기서 다 뒤지면 인원이 많을 때 요청이 폭증하므로 상한을 둔다.
  const RECHECK_LIMIT = 20;
  if (failed.length && failed.length <= RECHECK_LIMIT) {
    const still = [];
    for (const code of failed) {
      try {
        const rows = await fetchRowsForCode(galleryId, code);
        const ok = rows.some(
          (r) => !r.released && r.duration === want &&
                 r.identity && r.identity.matchKey === code
        );
        if (ok) verified.push(code);
        else still.push(code);
      } catch {
        still.push(code);
      }
    }
    failed = still;
  }

  const msg = failed.length
    ? `${verified.length}건 확인됨, ${failed.length}건 실패: ${failed.slice(0, 10).join(", ")}`
      + (failed.length > 10 ? ` 외 ${failed.length - 10}건` : "")
    : `${verified.length}건 모두 ${want} 차단 확인됨.`;

  return { ok: failed.length === 0, verified, failed, message: msg };
}

// --------------------------------------------------------------- 후보 판정

// 시계 오차나 초 단위 반올림을 감안한 여유. 이 안쪽은 만료로 본다.
const MANUAL_MARGIN_MS = 10 * 60 * 1000;

export function blockedAt(row) {
  if (!row.date) return null;
  const m = row.date.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (!m) return null;
  const [hh, mi, ss] = (row.time || "00:00:00").split(":").map(Number);
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    hh || 0, mi || 0, ss || 0
  );
}

export function expiresAt(row) {
  const start = blockedAt(row);
  const hours = HOURS_BY_LABEL[(row.duration || "").trim()];
  if (!start || !hours) return null;
  return new Date(start.getTime() + hours * 3600 * 1000);
}

// 예정 만료 시각 전에 '해제됨'이 됐다면 사람이 직접 푼 것이다.
// (신문고 민원 등으로 완장이 풀어준 경우) 이걸 자동 재차단하면
// 완장의 판단을 12시간 만에 뒤집어버린다.
export function isManualRelease(row, now = new Date()) {
  if (!row.released) return false;
  const exp = expiresAt(row);
  if (!exp) return false;
  return now.getTime() < exp.getTime() - MANUAL_MARGIN_MS;
}

// 파이썬 blocker.find_candidates와 같은 규칙 + 수동 해제 구분 + 다음 확인 시각.
//
// 판정은 가장 최근 행만 본다. 재차단하면 옛 해제됨 줄이 30일간 남고,
// 중복 차단 때 옛 줄이 만료 전에 해제되기도 해서 옛 줄로 판단하면 오판한다.
//
// nextCheckAt: 이 사람을 언제 다시 볼지. 31일 차단 중인 사람을 매번 조회하는 건
// 낭비다. 명단이 수만 명이 되면 그 낭비가 전부다.
export function analyzeCode(rows, code, entry, now = new Date()) {
  const mine = rows.filter((r) => r.identity && r.identity.matchKey === code);
  const day = 24 * 3600 * 1000;

  if (!mine.length) {
    // 목록에 흔적이 없다. 해제 목록은 30일만 보관되므로 오래된 사람은 여기로 온다.
    return { status: "none", nextCheckAt: now.getTime() + day };
  }

  const active = mine.find((r) => !r.released);
  if (active) {
    const exp = expiresAt(active);
    return {
      status: "active",
      // 만료 예정 시각 직후에 다시 본다. 계산이 안 되면 하루 뒤.
      nextCheckAt: exp ? exp.getTime() + 60 * 1000 : now.getTime() + day,
    };
  }

  const latest = mine[0];   // 목록은 최신순

  if (isManualRelease(latest, now)) {
    const exp = expiresAt(latest);
    return {
      status: "manual",
      code,
      label: latest.identity.label,
      releasedFrom: `${latest.date} ${latest.time}`.trim(),
      // chrome.storage는 Date 객체를 담지 못하고 빈 값으로 바꾼다. 숫자로 넘긴다.
      wouldExpire: exp ? exp.getTime() : null,
      duration: latest.duration,
      // 완장이 푼 사람은 자주 볼 이유가 없다
      nextCheckAt: now.getTime() + 7 * day,
    };
  }

  return {
    status: "candidate",
    nextCheckAt: now.getTime(),
    candidate: {
      code,
      kind: latest.identity.kind,
      label: latest.identity.label,
      nick: latest.identity.nick,
      reason: entry.reason || latest.reason || "음란성",
      memo: entry.memo || "",
      prevDuration: latest.duration,
      prevHandled: `${latest.date} ${latest.time}`.trim(),
    },
  };
}

// 이전 버전 호환용
export function pickCandidate(rows, code, entry) {
  const r = analyzeCode(rows, code, entry);
  return r.status === "candidate" ? r.candidate : null;
}
