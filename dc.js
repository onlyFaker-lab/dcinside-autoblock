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

// class 속성은 값 하나만 있다고 보지 않는다. 디시가 class="blocknum on" 처럼
// 뭘 하나 더 붙이거나 속성 순서를 바꿔도 견디게 한다.
const RE_ROW_MARK = /class="[^"]*\bblocknum\b/i;
const RE_ROW_MARK_G = /class="[^"]*\bblocknum\b/gi;

// 기간·사유는 값을 그대로 비교(HOURS_BY_LABEL, REASON_VALUES)하는 데 쓰인다.
// 셀 안에 뭐가 더 붙어도 아는 값으로 떨어지게 뽑는다.
function parseDuration(cellHtml) {
  const text = stripTags(cellHtml);
  const m = text.match(/(\d+)\s*(시간|일)/);
  return m ? `${m[1]}${m[2]}` : text;
}

// 화면 표기와 REASON_VALUES 키의 공백이 다를 수 있다('혐오콘텐츠' 대 '혐오 콘텐츠').
// 그대로 두면 나중에 blockCodes가 '알 수 없는 사유'로 그룹 전체를 날린다.
// 공백을 무시하고 맞춰본 뒤, 아는 값으로 되돌려 준다.
function parseReason(cellHtml) {
  const text = stripTags(cellHtml);
  const flat = text.replace(/\s+/g, "");
  for (const known of Object.keys(REASON_VALUES)) {
    if (flat.includes(known.replace(/\s+/g, ""))) return known;
  }
  return text;
}

// prefix=true면 이름 뒤에 뭐가 붙어도 잡는다. blockstate가 그렇다.
// v1.5.1의 정규식이 class="blockstate[^"]*" 였던 건 실제 화면에 접미사가
// 붙은 걸 봤다는 뜻이다. \b로 조이면 blockstate2 를 놓친다.
function cell(tr, className, prefix = false) {
  const tail = prefix ? '[^"]*' : "\\b";
  const re = new RegExp(
    `<td[^>]*class="[^"]*\\b${className}${tail}[^"]*"[^>]*>([\\s\\S]*?)</td>`, "i"
  );
  return (tr.match(re) || [])[1] || "";
}

// parseBlockList는 배열을 돌려주되, 표에 있던 행 수(expectedRows)와
// 그중 못 읽은 수(missedRows)를 같이 달아 보낸다.
//
// 이게 필요한 이유: 마크업이 바뀌어 한 행도 못 읽으면 결과는 그냥 빈 배열이고,
// 호출부는 "이력 없음"으로 읽는다. 아무도 안 막히는데 화면은 조용하다.
// 빈 결과 자체는 정상일 수 있으므로(이력 없는 코드 검색) 행 표시 개수와
// 실제 파싱 수를 대조해야 구분이 된다.

// ── 공용 헬퍼 ──────────────────────────────────────────────
// background.js 도 이걸 가져다 쓴다. 양쪽에 같은 식을 적어두면
// 한쪽만 고쳤을 때 테스트가 눈치채지 못한다.

// 차단 목록 한 페이지는 30행이다 (2026-09-06 실제 화면 확인).
// 여유 2페이지는 그새 다른 완장이 차단을 걸어 목록이 밀리는 경우를 위한 것.
export const ROWS_PER_PAGE = 30;
export function listPagesFor(count) {
  return Math.min(20, Math.max(4, Math.ceil(count / ROWS_PER_PAGE) + 2));
}

// 서비스워커는 작업 도중에도 종료된다. busy 가 true 인 채 남으면
// 이후 알람이 전부 되돌아가 확장이 조용히 멈춘다. 오래된 잠금은 무시한다.
export const BUSY_TIMEOUT_MS = 30 * 60 * 1000;
export function isBusy(status, now = Date.now()) {
  if (!status || !status.busy) return false;
  return now - (status.busySince || 0) < BUSY_TIMEOUT_MS;
}

// 예정 시각 비교는 로컬 시간으로 하므로 날짜 키도 로컬이어야 한다.
// toISOString() 은 UTC 라서 KST 오전 9시 이전 시각에서 날짜가 어긋난다.
export function localDateKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseBlockList(html) {
  const rows = [];
  const meta = (found, expected) => {
    rows.tableFound = found;
    rows.expectedRows = expected;
    rows.missedRows = Math.max(0, expected - rows.length);
    return rows;
  };

  const tableMatch = html.match(
    /<table[^>]*class="[^"]*\bminor_block_list\b[^"]*"[\s\S]*?<\/table>/i
  );
  if (!tableMatch) return meta(false, 0);

  const table = tableMatch[0];
  // tbody가 없는 마크업이 와도 표 전체를 훑어서 건진다.
  const body = table.split(/<tbody[^>]*>/i)[1] || table;
  const expected = (body.match(RE_ROW_MARK_G) || []).length;

  for (const trMatch of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tr = trMatch[1];
    if (!RE_ROW_MARK.test(tr)) continue;

    const dataNum = pick(tr, /class="[^"]*\bblocknum\b[^"]*"[^>]*\sdata-num="(\d+)"/i);
    const num = pick(tr, /class="[^"]*\bblocknum\b[^"]*"[^>]*>([^<]*)</i);

    const identity = parseNikCell(cell(tr, "blocknik"));
    const stateText = stripTags(cell(tr, "blockstate", true));

    rows.push({
      num,
      dataNum,
      identity,
      reason: parseReason(cell(tr, "blockreason")),
      duration: parseDuration(cell(tr, "blocktime")),
      date: pick(tr, /class="[^"]*\bblock_date\b[^"]*"[^>]*>([^<]*)</i),
      // 처리 시각은 숨겨진 툴팁 안에 있다
      time: pick(tr, /class="[^"]*\bblock_time\b[^"]*"[^>]*>\s*처리 시간\s*:\s*([^<]*)</i),
      handler: pick(tr, /class="[^"]*\bblock_conduct\b[^"]*"[^>]*>\s*처리자\s*:\s*([^<]*)</i),
      stateText,
      // 상태 칸을 못 읽으면 released가 false가 되어 전원 '차단 중'으로 보인다.
      // 후보가 한 명도 안 잡히는데 경고도 없는 상태가 되므로 따로 표시해둔다.
      stateUnknown: !stateText,
      released: stateText.includes("해제됨"),
    });
  }
  return meta(true, expected);
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

// 차단 목록을 페이지 단위로 훑는다.
//
// 예전에는 화면의 페이지네이션에서 링크를 긁어 큐에 넣었다. 그런데 그 방식은
// 페이징 영역의 마크업에 통째로 의존한다. 클래스 순서가 다르거나 링크가
// href 없이 자바스크립트로 돌면 링크가 하나도 안 잡히고, 그러면 큐가 비어서
// 1페이지만 읽고 조용히 끝난다. 실제 갤러리에서 이 일이 났다.
//
// 그래서 링크를 보지 않고 page 번호를 직접 올린다. 끝은 내용으로 판단한다.
// 페이지 파라미터는 'page'가 아니라 'p'다. 't=u'는 이용자 차단 탭(이미지 차단은 t=i).
// 실제 페이저가 내보내는 주소를 그대로 따랐다 (2026-09-06 확인):
//   /mgallery/management/block?id=90_00_memory&s=&t=u&p=2
function listUrl(galleryId, page) {
  const params = new URLSearchParams({ id: galleryId, t: "u" });
  if (page > 1) params.set("p", String(page));
  return `${BLOCK_URL}?${params.toString()}`;
}

// 같은 행인지 알아보는 열쇠.
// data-num이 내부 차단 ID라 가장 믿을 만하지만, 그것만 쓰면 안 된다.
// 값이 비었거나 행마다 같은 값이 오는 마크업을 만나면 2페이지가 통째로
// '이미 본 것'이 되어 1페이지만 읽고 멈춘다. 지금 고치는 그 버그가
// 다른 문으로 다시 들어오는 셈이다. 그래서 다른 칸까지 묶어서 만든다.
function rowKey(r) {
  const code = (r.identity && r.identity.value) || "";
  return [r.dataNum, r.num, code, r.date, r.time, r.duration].join("|");
}

// 반환값
//   pages     실제로 읽은 페이지 수
//   more      상한에 걸려서 멈췄다 (더 있을 수 있음)
//   missed    표에 있었는데 못 읽은 행 수 합계
//   repeated  다음 페이지가 이미 본 내용이라 멈췄다
async function crawlList(galleryId, maxPages, onPage) {
  const seen = new Set();
  let pages = 0, missed = 0;
  let more = false, repeated = false;

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(listUrl(galleryId, page), { credentials: "include" });
    if (!res.ok) {
      if (page === 1) throw new Error(`목록 조회 실패 (HTTP ${res.status})`);
      break;
    }
    const html = await res.text();
    if (!/minor_block_list/.test(html)) {
      if (page === 1) {
        throw new Error("차단 목록을 읽지 못했습니다. 갤러리 ID와 매니저 권한을 확인하세요.");
      }
      break;
    }

    const rows = parseBlockList(html);
    missed += rows.missedRows || 0;

    if (!rows.length) break;   // 여기서 끝

    // 범위를 넘은 page를 주면 디시가 1페이지를 되돌려주기도 한다.
    // 이미 본 행만 있으면 더 가봐야 같은 걸 다시 읽는다.
    const keys = rows.map(rowKey);
    if (page > 1 && keys.every((k) => seen.has(k))) {
      repeated = true;
      break;
    }
    for (const k of keys) seen.add(k);

    pages++;
    onPage(rows, pages);

    if (page === maxPages) { more = true; break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { pages, more, missed, repeated };
}

// 차단 목록에서 특정 기간으로 '지금 차단 중'인 코드를 모은다.
// 방금 건 차단은 목록 맨 위에 오므로, 한 명씩 검색하는 것보다 요청이 훨씬 적다.
async function fetchRecentlyBlocked(galleryId, durationLabel, maxPages) {
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
  let scanned = 0;
  const { pages, more, missed, repeated } = await crawlList(galleryId, maxPages, (rows, page) => {
    scanned += rows.length;
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
  return { items: [...map.values()], pages, more, missed, repeated, scanned };
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

  // 방금 건 차단은 목록 위쪽에 몰려 있지만, 인원이 많으면 여러 페이지로 밀린다.
  // 4페이지 고정이면 뒤로 밀린 사람이 멀쩡히 걸렸는데도 '실패'로 찍힌다.
  // 인원에 맞춰 페이지를 늘린다. 실제 화면에서 한 페이지 30행을 확인했다(2026-09-06).
  // 여유 2페이지는 그새 다른 완장이 차단을 걸어 목록이 밀리는 경우를 위한 것이다.
  const listPages = listPagesFor(codes.length);

  const blocked = await fetchRecentlyBlocked(galleryId, want, listPages);
  const verified = codes.filter((c) => blocked.has(c));
  let failed = codes.filter((c) => !blocked.has(c));

  // 목록에서 못 찾은 사람은 전원 개별 검색으로 한 번 더 본다.
  // 상한을 두면 그 위로는 확인 없이 실패 처리돼 이력이 거짓말을 하게 된다.
  // 어차피 후보는 maxPerRun으로 막혀 있어 요청이 폭증하지 않는다.
  if (failed.length) {
    if (onProgress) {
      onProgress(`  목록에서 못 찾은 ${failed.length}건을 개별 확인합니다`);
    }
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
      await new Promise((r) => setTimeout(r, 400));
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
