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

// 디시 차단 창의 사유는 라디오 7개 + '직접 입력' 칸이다. 직접 입력을 고르면
// avoid_reason 이 "0" 으로 가고 실제 사유는 avoid_reason_txt 로 간다.
// 2026-09-09 파딱 갤의 실제 요청으로 확인했다. '직접 입력'이 여덟 번째
// 라디오라 8일 거라고 짐작했는데 0이었다. 넣어보기 전에 확인해서 다행이다.
export const CUSTOM_REASON = "0";

// 입력칸 안내가 '한글 20자 이내'다. 파딱 갤 4533명의 사유 중 가장 긴 것이
// 정확히 20자라 지금은 넘는 게 없지만, 경계선이라 자르는 처리는 둔다.
export const REASON_TXT_MAX = 20;

// 사유 하나를 요청 두 칸으로 바꾼다. 아는 사유면 번호로, 모르는 사유면
// 0 + 원문으로 보낸다. 잘렸는지는 부르는 쪽이 알아야 하므로 같이 돌려준다.
export function reasonFields(reason) {
  const text = String(reason ?? "").trim();
  const known = REASON_VALUES[text];
  if (known) return { value: known, txt: "", custom: false, cut: false };
  if (!text) throw new Error("사유가 비어 있습니다");
  const txt = [...text].slice(0, REASON_TXT_MAX).join("");
  return { value: CUSTOM_REASON, txt, custom: true, cut: txt !== text };
}

// 갤로그 점검을 누가 받을지 고른다. background.js 안에 두면 테스트가 규칙을
// 베껴 적게 되고, 그러면 실제 코드가 바뀌어도 검사가 통과해버린다.
//
// 이 점검이 답하려는 질문은 '이 사람이 N개월간 디시에서 아무것도 안 했나'다.
// 답은 예전 숫자와 지금 숫자를 견주어야 나온다. 예전 숫자를 잰 지 N개월이
// 안 됐다면 지금 다시 재도 답이 안 나오므로 볼 필요가 없다. 중간에 몇 번을
// 더 재든 판정은 '처음 잰 값과 지금 값이 같은가'로 똑같다.
export const GALLOG_RECHECK_GAP_MS = 12 * 3600 * 1000;

export function pickGallogTargets(watchlist, opts = {}) {
  const now = opts.now || Date.now();
  const limit = Math.max(0, Number(opts.limit) || 0);
  const months = Math.max(0, Number(opts.months) || 0);
  const gap = opts.gapMs == null ? GALLOG_RECHECK_GAP_MS : opts.gapMs;
  const periodMs = months * 30 * 24 * 3600 * 1000;
  const pick = opts.onlyCodes ? new Set(opts.onlyCodes) : null;

  let eligible = (watchlist || [])
    .filter((t) => t && t.kind === "code" && t.gallogState !== "deleted");
  if (pick) eligible = eligible.filter((t) => pick.has(t.value));

  const rested = (t) => now - (t.gallogCheckedAt || 0) >= gap;

  const fresh = eligible.filter((t) => !rested(t));
  // 기준점이 아직 기간 안에 드는 사람. 한 번도 안 잰 사람은 여기 안 들어간다.
  const tooSoon = periodMs
    ? eligible.filter((t) => t.gallogCountedAt && rested(t) &&
        now - t.gallogCountedAt < periodMs)
    : [];
  const soon = new Set(tooSoon);

  // 숫자를 한 번도 못 읽은 사람이 먼저다. gallogCountedAt은 성공했을 때만 찍힌다.
  // gallogCheckedAt으로 정렬하면 실패한 사람도 '방금 봤다'고 처리돼 뒤로 밀린다.
  const ready = eligible
    .filter((t) => rested(t) && !soon.has(t))
    .sort((a, b) => (a.gallogCountedAt || 0) - (b.gallogCountedAt || 0));

  const targets = limit ? ready.slice(0, limit) : ready;
  return { targets, fresh, tooSoon, waiting: ready.length - targets.length };
}

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
// 요청 간격에 흔들림을 준다.
//
// 2026-09-08에 파딱 계정이 실제로 IP 차단을 당했다. 갤로그 300명을 400ms 고정
// 간격으로 조회한 직후였고, 30분 넘게 디시 전체가 하얀 화면이 됐다. 다른
// 사이트와 같은 와이파이의 폰은 멀쩡했으니 계정이 아니라 IP 단위였다.
//
// 일정한 간격은 사람이 만들 수 없는 신호다. 평균을 늦추는 것만으로는 부족하고
// 간격 자체가 흔들려야 한다. base의 60%~140% 사이에서 고른다.
export function jitter(base, spread = 0.4) {
  const lo = base * (1 - spread);
  const hi = base * (1 + spread);
  return Math.round(lo + Math.random() * (hi - lo));
}

// 갤로그는 한 명당 한 요청이라 가장 위험한 경로다. 400ms에서 올렸다.
export const GALLOG_DELAY_MS = 1200;

// 정기 확인(runCheck)도 한 명당 한 요청이라 갤로그와 모양이 같다. 그런데 이쪽은
// 사람이 누르지 않아도 알람으로 저절로 돈다. 게다가 명단 채우기로 새로 담긴
// 사람은 nextCheckAt이 0이라 전원이 한꺼번에 조회 대상이 되고, 상한(기본 300명)
// 까지 연달아 나간다. 사고가 났을 때의 '300명 × 400ms 고정'과 같은 조건이다.
// v1.6.5까지 여기만 난수가 빠져 있었다.
export const CHECK_DELAY_MS = 1200;

// 연속으로 이만큼 실패하면 중단한다. 실제 사고 때 42명까지 읽히다가 258명이
// 내리 실패했는데, 확장은 그걸 '화면 구조가 바뀐 것 같다'고 보고하며 끝까지
// 요청을 계속 보냈다. 이미 막힌 뒤에 258번을 더 두드린 셈이다.
export const GALLOG_FAIL_STREAK = 5;

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

// 행 수만 대조하면 조용한 실패를 놓친다.
// 표는 멀쩡히 읽었는데 칸 하나를 못 읽는 경우가 실제로 있었다(v1.5.2의 blockstate).
// 그때는 missedRows가 0이라 아무 경고도 안 떴고, 해제된 사람이 전원 '차단 중'으로
// 보이면서 후보가 한 명도 안 잡혔다. 무엇이 깨졌는지 종류별로 세어서 돌려준다.
//
// badState    상태 칸을 못 읽음 → 해제된 사람이 '차단 중'으로 보인다
// badIdentity 식별자를 못 읽음 → analyzeCode가 그 행을 남의 것으로 보고 버린다
// missed      표에 있는데 행 자체를 못 읽음
// 이번에 조회하지 않은 사람의 옛 판정을 남긴다.
//
// runCheck가 후보·수동해제 목록을 통째로 덮어쓰면, 이번에 안 본 사람의 판정이
// 조용히 사라진다. 실제로 두 가지가 이렇게 없어졌다.
//   - '완장이 직접 해제' 목록: manual 판정은 7일 뒤에 다시 보므로 다음 조회
//     때 대상에서 빠지고, 그 순간 목록과 '명단에서 빼기' 버튼이 같이 사라진다.
//   - 하루 차단 한도에 걸려 못 보낸 후보: 다음 조회 한 번이면 없어진다.
//
// 명단에서 빠졌거나 중지된 사람은 남기지 않는다. 그건 사용자가 뺀 것이다.
export function carryOver(prevList, checkedNow, stillWatched) {
  return (prevList || []).filter(
    (x) => x && x.code && !checkedNow.has(x.code) && stillWatched.has(x.code)
  );
}

export function rowHealth(rows) {
  let badState = 0, badIdentity = 0;
  for (const r of rows) {
    if (r.stateUnknown) badState++;
    if (!r.identity) badIdentity++;
  }
  const missed = rows.missedRows || 0;
  return {
    missed, badState, badIdentity,
    broken: missed > 0 || badState > 0 || badIdentity > 0,
  };
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

// 로그인이 풀리면 디시는 안내 문구가 아니라 **스크립트 한 줄**을 돌려준다.
// 2026-09-09 실측: 87바이트, `<script>`로 시작하고 location 으로 보내며,
// 한글이 한 글자도 없다. 갤로그 탈퇴 계정(103바이트)과 같은 모양이다.
//
// 예전에는 `/로그인/.test(html)` 로 가렸는데, 본문에 그 글자가 없으니
// 절대 안 걸렸다. 그래서 로그아웃인데도 "매니저 권한이 있는 갤러리인지
// 확인하세요"가 떴다. 완장은 자기 권한이 날아간 줄 알고 엉뚱한 곳을 본다.
//
// ⚠ ci_c 쿠키는 로그아웃해도 남는다. 쿠키가 있다고 로그인된 게 아니다.
// getCiToken()이 성공해도 여기서 다시 걸러야 한다.
function looksLoggedOut(html) {
  const body = String(html || "");
  // 본문이 짧고 스크립트로 어디론가 보내기만 하는 경우
  if (body.length < 500 && /^\s*<script/i.test(body) && /location/i.test(body)) {
    return true;
  }
  // 로그인 화면을 통째로 돌려주는 경우도 대비해 남겨둔다
  return /로그인/.test(body) && !/로그아웃/.test(body);
}

export async function fetchRowsForCode(galleryId, code) {
  const res = await fetch(searchUrl(galleryId, code), {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`목록 조회 실패 (HTTP ${res.status})`);
  const html = await res.text();

  if (!/minor_block_list/.test(html)) {
    if (looksLoggedOut(html)) {
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
// "2026.09.06" → 20260906. 날짜 비교용.
function dateNum(s) {
  const m = /(\d{4})\.(\d{2})\.(\d{2})/.exec(s || "");
  return m ? Number(m[1] + m[2] + m[3]) : 0;
}

// opts.untilDate ("2026-08-01") 를 주면 그 날짜보다 오래된 행이 나온 페이지에서
// 멈춘다. 목록이 최신순이라 그 뒤로는 볼 필요가 없다.
// 페이지 수를 감으로 찍지 않아도 되고, 필요 이상으로 훑지도 않는다.
async function crawlList(galleryId, maxPages, onPage, opts = {}) {
  const until = opts.untilDate ? Number(opts.untilDate.replace(/-/g, "")) : 0;
  // 수천 페이지를 훑을 때는 간격을 넓혀 디시 쪽 부담을 줄인다.
  const delay = maxPages > 1000 ? 500 : 300;

  // 이전 페이지의 행만 기억한다. 전체를 모으면 수천 페이지에서 메모리가 계속 는다.
  // 판별해야 하는 두 경우(범위 밖 페이지를 되돌려주는 것, 파라미터를 무시하는 것)
  // 모두 '직전 페이지와 같은 내용'으로 나타나므로 이것으로 충분하다.
  let prevKeys = new Set();
  let pages = 0, missed = 0;
  let more = false, repeated = false, reachedDate = false;

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(listUrl(galleryId, page), { credentials: "include" });
    if (!res.ok) {
      if (page === 1) throw new Error(`목록 조회 실패 (HTTP ${res.status})`);
      break;
    }
    const html = await res.text();
    if (!/minor_block_list/.test(html)) {
      if (page === 1) {
        // 여기도 로그인 풀림을 갈라야 한다. 안 그러면 로그아웃 상태에서
        // "갤러리 ID와 매니저 권한을 확인하세요"가 떠서 엉뚱한 데를 보게 된다.
        if (looksLoggedOut(html)) {
          throw new Error("로그인이 풀린 것 같습니다. 디시에 다시 로그인해 주세요.");
        }
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
    if (page > 1 && keys.every((k) => prevKeys.has(k))) {
      repeated = true;
      break;
    }
    prevKeys = new Set(keys);

    pages++;
    await onPage(rows, pages);

    // 목록은 최신순이다. 이 페이지의 마지막 행이 기준일보다 오래됐으면 끝이다.
    if (until && dateNum(rows[rows.length - 1].date) < until) {
      reachedDate = true;
      break;
    }

    if (page === maxPages) { more = true; break; }
    // 간격을 흔든다. 갤로그만큼 요청이 많진 않지만 수천 페이지를 훑을 수 있어
    // 총량은 더 클 수도 있다. 일정한 간격 자체가 신호다(5-5절).
    await new Promise((r) => setTimeout(r, jitter(delay)));
  }
  return { pages, more, missed, repeated, reachedDate };
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
// includeReleased=false(기본)면 지금 차단 중인 사람만 돌려준다.
//
// 파딱 피드백(2026-09-08): 명단 채우기에 이미 해제된 사람이 섞여 나온다.
// 대부분은 차단 중인 사람만 필요하다. 다만 해제된 사람을 명단에 넣고 싶은
// 경우도 있다고 해서 없애지 않고 옵션으로 뺐다.
//
// 거르는 순서가 중요하다. 목록이 최신순이라 같은 코드의 첫 행이 그 사람의
// 현재 상태다. 담기 전에 released를 거르면, 최신 행이 '해제됨'인 사람의
// 옛 '차단 중' 행을 주워서 지금 차단 중인 것처럼 보이게 된다.
// 그래서 최신 행으로 먼저 추리고, 거르는 건 맨 마지막에 한다.
export async function collectByDuration(
  galleryId, durationLabel, maxPages, onProgress, untilDate, includeReleased = false
) {
  const map = new Map();
  // 경계를 지났는지 알려면 기준일보다 오래된 행이 나올 때까지 읽어야 한다.
  // 그 마지막 페이지에는 기준일 밖의 행이 섞여 있으므로 담을 때 걸러낸다.
  const until = untilDate ? Number(untilDate.replace(/-/g, "")) : 0;
  let scanned = 0;
  let oldest = "";
  const { pages, more, missed, repeated, reachedDate } =
    await crawlList(galleryId, maxPages, async (rows, page) => {
    oldest = rows[rows.length - 1].date;
    scanned += rows.length;
    for (const r of rows) {
      if (r.duration !== durationLabel) continue;
      if (until && dateNum(r.date) < until) continue;   // 기준일보다 오래된 행
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
    if (onProgress) await onProgress(page, map.size, oldest);
  }, { untilDate });

  const all = [...map.values()];
  const items = includeReleased ? all : all.filter((it) => !it.released);
  return {
    items,
    // 몇 명을 걸러냈는지 알려준다. 말없이 사라지면 그것도 조용한 실패다.
    releasedSkipped: all.length - items.length,
    pages, more, missed, repeated, scanned, reachedDate, oldest,
  };
}

// 디시는 완장 계정마다 하루 차단 횟수에 한도를 둔다.
// 한도에 걸리면 31일 차단은 전부 헛수고이므로 즉시 멈춰야 한다.
//
// 2026-09-08 실제 확인한 문구 (매니저 계정, 관리 화면 직접 차단 팝업의 alert):
//   "일일 차단 횟수가 초과되어 장시간 차단이 불가능합니다."
//
// 두 가지가 여기서 드러났다.
//   1. 매니저(주딱)에게도 한도가 있다. 부매니저만이라던 예전 추정은 틀렸다.
//   2. 막히는 건 '장시간'뿐이다. 1시간과 6시간은 한도 뒤에도 걸린다.
//      우리는 31일만 걸므로 결국 전부 막힌 것과 같다. 즉시 중단이 맞다.
//
// 확인된 문구를 먼저 정확히 잡고, 문구가 조금 바뀌어도 놓치지 않게 한 겹 더 둔다.
// 놓치는 쪽이 훨씬 나쁘다. 못 알아채면 남은 인원을 전부 보내고 전부 실패로 적는다.
const RE_DAILY_LIMIT_KNOWN = /일일\s*차단\s*횟수.{0,10}초과/;
const RE_DAILY_LIMIT =
  /(차단\s*횟수|차단\s*가능\s*횟수).{0,20}(초과|소진|없|제한|사용)|장시간\s*차단.{0,15}(불가|제한)|(초과|소진).{0,10}차단\s*횟수/;

function isDailyLimit(said) {
  return RE_DAILY_LIMIT_KNOWN.test(said) || RE_DAILY_LIMIT.test(said);
}

// 응답에서 사람이 읽을 문구만 뽑아낸다. JSON이면 메시지 필드를 본다.
function serverMessage(text) {
  if (!text) return "";
  try {
    const j = JSON.parse(text);
    const m = j.msg || j.message || j.result_msg || j.error || "";
    if (m) return String(m).trim();
  } catch { /* JSON이 아니면 원문을 쓴다 */ }
  return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

export async function blockCodes(galleryId, codes, reason, hours = HOURS_31D, onProgress) {
  if (!codes.length) return { ok: true, verified: [], failed: [] };

  // 예전엔 모르는 사유면 여기서 던졌다. 파딱 갤 명단 4533명은 전원이
  // 직접 입력 사유라 한 명도 재차단되지 않았을 것이다.
  const rf = reasonFields(reason);
  if (rf.cut && onProgress) {
    onProgress(`  사유가 ${REASON_TXT_MAX}자를 넘어 '${rf.txt}'로 줄여 보냅니다.`);
  }

  const ciT = await getCiToken();
  const batches = chunkCodes(codes);
  let limitHit = false;
  let limitMessage = "";
  let sentCount = 0;

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
      avoid_reason: rf.value,
      avoid_reason_txt: rf.txt,
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

    const said = serverMessage(await res.text());
    if (said && onProgress) onProgress(`    디시 응답: ${said}`);

    if (isDailyLimit(said)) {
      limitHit = true;
      limitMessage = said;
      if (onProgress) {
        onProgress(`  하루 차단 한도에 걸렸습니다. 남은 묶음은 보내지 않습니다.`);
      }
      break;   // 더 보내봐야 전부 헛수고다
    }
    sentCount += batches[i].length;

    if (i + 1 < batches.length) await new Promise((r) => setTimeout(r, 800));
  }

  // 한도에 걸려 아예 보내지 못한 사람은 검증 대상에서 뺀다.
  // 보내지도 않은 걸 '실패'로 기록하면 이력이 거짓말을 한다.
  const attempted = limitHit ? codes.slice(0, sentCount) : codes;
  const notSent = limitHit ? codes.slice(sentCount) : [];

  // 서버 응답은 믿지 않는다. 목록을 다시 읽어서 실제로 걸렸는지 확인한다.
  // (목록 체크박스 경로가 성공 알림만 띄우고 아무 일도 안 했던 전례가 있다)
  const want = labelForHours(hours);
  await new Promise((r) => setTimeout(r, 1000));

  // 방금 건 차단은 목록 위쪽에 몰려 있지만, 인원이 많으면 여러 페이지로 밀린다.
  // 4페이지 고정이면 뒤로 밀린 사람이 멀쩡히 걸렸는데도 '실패'로 찍힌다.
  // 인원에 맞춰 페이지를 늘린다. 실제 화면에서 한 페이지 30행을 확인했다(2026-09-06).
  // 여유 2페이지는 그새 다른 완장이 차단을 걸어 목록이 밀리는 경우를 위한 것이다.
  const listPages = listPagesFor(attempted.length);

  const blocked = attempted.length
    ? await fetchRecentlyBlocked(galleryId, want, listPages)
    : new Set();
  const verified = attempted.filter((c) => blocked.has(c));
  let failed = attempted.filter((c) => !blocked.has(c));

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
      // 여기도 사람당 한 요청이다. 갤로그만큼 많지는 않지만(후보는 maxPerRun으로
      // 막혀 있다) 간격이 일정한 건 마찬가지라 흔들어 준다.
      await new Promise((r) => setTimeout(r, jitter(400)));
    }
    failed = still;
  }

  // 한 명도 못 보낸 경우(첫 묶음부터 한도에 걸림)에 "0건 모두 확인됨"이라고
  // 하면 안 된다. 아무 일도 안 일어났는데 성공한 것처럼 읽힌다.
  // 2026-09-08 주딱 계정 실제 실행에서 이 문구가 나왔다.
  let msg;
  if (!attempted.length) {
    msg = `한 명도 보내지 못했습니다.`;
  } else if (failed.length) {
    msg = `${verified.length}건 확인됨, ${failed.length}건 실패: ${failed.slice(0, 10).join(", ")}`
      + (failed.length > 10 ? ` 외 ${failed.length - 10}건` : "");
  } else {
    msg = `${verified.length}건 모두 ${want} 차단 확인됨.`;
  }
  if (limitHit) {
    msg += ` / 하루 차단 한도로 ${notSent.length}명은 보내지 못했습니다.`;
  }

  return {
    ok: failed.length === 0 && !limitHit,
    verified, failed, message: msg,
    limitHit, limitMessage, notSent,
  };
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

// ── 갤 게시판 목록 ──────────────────────────────────────────
// 글쓴이 칸에 식별코드가 data-uid 로 그대로 들어 있다(2026-09-07 확인).
//   <td class="gall_writer ub-writer" data-nick="ㅇㅇ" data-uid="nanny1568" data-ip="">
//   <td class="gall_writer ub-writer" data-nick="응붕이" data-uid="" data-ip="220.85">
// 그래서 목록을 한 번 훑으면 명단 전원의 활동 여부를 동시에 알 수 있다.
// 사람마다 조회하는 방식이 아니라서 명단이 커져도 요청이 늘지 않는다.
//
// 주의: 게시판 목록의 페이지 파라미터는 'page' 다. 차단 목록은 'p' 였다.
// 두 곳이 다르니 헷갈리지 말 것.
const BOARD_URL = "https://gall.dcinside.com/mgallery/board/lists";
export const BOARD_ROWS_PER_PAGE = 100;

function boardUrl(galleryId, page) {
  const params = new URLSearchParams({ id: galleryId, list_num: String(BOARD_ROWS_PER_PAGE) });
  if (page > 1) params.set("page", String(page));
  return `${BOARD_URL}?${params.toString()}`;
}

const RE_BOARD_ROW = /<tr[^>]*class="[^"]*\bub-content\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
const RE_BOARD_MARK = /class="[^"]*\bub-writer\b/i;
const RE_BOARD_MARK_G = /class="[^"]*\bub-writer\b/gi;

// "2026-09-07 17:05:43" → 20260907
function dayNumOf(stamp) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(stamp || "");
  return m ? Number(m[1] + m[2] + m[3]) : 0;
}

export function parseBoardList(html) {
  const rows = [];
  rows.tableFound = /\bgall_list\b/.test(html);
  rows.expectedRows = 0;
  rows.missedRows = 0;
  if (!rows.tableFound) return rows;

  const body = html.split(/<tbody[^>]*>/i)[1] || html;
  rows.expectedRows = (body.match(RE_BOARD_MARK_G) || []).length;

  for (const m of body.matchAll(RE_BOARD_ROW)) {
    const tr = m[1];
    if (!RE_BOARD_MARK.test(tr)) continue;

    // 공지는 매 페이지마다 딸려 나온다. 활동 판정에 넣으면 완장이 늘 활동 중이 된다.
    if (/data-type="icon_notice"/.test(m[0])) continue;

    const writer = (tr.match(/<td[^>]*class="[^"]*\bub-writer\b[^"]*"[^>]*>/i) || [])[0] || "";
    const at = (name) => (writer.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || "";
    const uid = at("data-uid");
    const ip = at("data-ip");
    const nick = decode(at("data-nick"));

    // 광고/설문 줄은 글쓴이 칸 형태가 달라 uid도 ip도 없다. 조용히 건너뛴다.
    if (!uid && !ip) continue;

    const stamp = (tr.match(/<td[^>]*class="[^"]*\bgall_date\b[^"]*"[^>]*title="([^"]*)"/i) || [])[1] || "";
    if (!stamp) { rows.missedRows++; continue; }

    rows.push({ uid, ip, nick, stamp, day: dayNumOf(stamp) });
  }
  return rows;
}

// 게시판 목록을 훑어 식별코드별 마지막 글 날짜를 모은다.
// untilDate("2026-06-07")보다 오래된 글이 나오면 멈춘다.
export async function collectActivity(galleryId, maxPages, onProgress, untilDate) {
  const until = untilDate ? Number(untilDate.replace(/-/g, "")) : 0;
  const lastPost = new Map();          // uid → "2026-09-07 17:05:43"
  const delay = maxPages > 1000 ? 500 : 300;

  let prevKeys = new Set();
  let pages = 0, scanned = 0, missed = 0, oldest = "";
  let more = false, repeated = false, reachedDate = false;

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(boardUrl(galleryId, page), { credentials: "include" });
    if (!res.ok) {
      if (page === 1) throw new Error(`글 목록 조회 실패 (HTTP ${res.status})`);
      break;
    }
    const html = await res.text();
    const rows = parseBoardList(html);
    if (!rows.tableFound) {
      if (page === 1) throw new Error("글 목록을 읽지 못했습니다. 갤러리 ID를 확인하세요.");
      break;
    }
    missed += rows.missedRows;
    if (!rows.length) break;

    const keys = rows.map((r) => `${r.stamp}|${r.uid || r.ip}`);
    if (page > 1 && keys.every((k) => prevKeys.has(k))) { repeated = true; break; }
    prevKeys = new Set(keys);

    for (const r of rows) {
      if (!r.uid) continue;                       // 유동은 대조할 수 없다
      if (!lastPost.has(r.uid)) lastPost.set(r.uid, r.stamp);   // 최신순이라 처음 본 게 최신
    }
    scanned += rows.length;
    oldest = rows[rows.length - 1].stamp;
    pages++;
    if (onProgress) await onProgress(pages, lastPost.size, oldest);

    if (until && rows[rows.length - 1].day < until) { reachedDate = true; break; }
    if (page === maxPages) { more = true; break; }
    // 간격을 흔든다. 갤로그만큼 요청이 많진 않지만 수천 페이지를 훑을 수 있어
    // 총량은 더 클 수도 있다. 일정한 간격 자체가 신호다(5-5절).
    await new Promise((r) => setTimeout(r, jitter(delay)));
  }
  return { lastPost, pages, scanned, missed, oldest, more, repeated, reachedDate };
}

// ── 갤로그 상태 ─────────────────────────────────────────────
// 2026-09-07 실제 확인:
//   살아있는 계정   → https://gallog.dcinside.com/<코드>  (공개든 비공개든 정상 응답)
//   탈퇴한 계정     → https://gallog.dcinside.com/_error/deleted 로 이동
//   없는 코드       → 404
// 디시가 차단한 갤로그 화면은 아직 못 봤다. 그건 'other'로 남고 건드리지 않는다.
// 명단에서 빼는 건 되돌리기 번거로우니, 확실한 것만 후보로 올린다.
const GALLOG_URL = "https://gallog.dcinside.com";

// 갤로그 홈의 글·댓글 수. 2026-09-08 실제 HTML 확인:
//   <h2 class="tit" onclick="...">게시글<span class="num">(29)</span></h2>
//   <h2 class="tit" onclick="...">댓글<span class="num">(332)</span></h2>
//
// 중요한 두 가지를 실물로 확인했다.
//   1. 비로그인 상태에서도 숫자가 나온다.
//   2. 비공개 갤로그도 숫자는 나온다. 목록만 '게시글이 없습니다'로 가려지고
//      개수는 그대로다. 그래서 공개 여부와 무관하게 쓸 수 있다.
//
// 이 숫자가 왜 필요한가: 지금 활동 점검은 '이 갤에 쓴 글'만 본다. 댓글로만
// 노는 사람과 다른 갤로 옮긴 사람을 못 잡는다. 갤로그 숫자는 디시 전체의
// 글+댓글이라 그 구멍을 막는다. 요청도 안 늘어난다. 갤로그 점검이 이미
// 이 페이지를 열고 있었고, 지금까지 주소만 보고 본문을 버리고 있었다.
//
// 클래스 하나에 매달리지 않도록 tit/num 둘 다 느슨하게 잡는다.
// ⚠ 숫자에 천 단위 쉼표가 붙는다. 2026-09-08 실제 확인:
//     게시글(4,972)   댓글(9,288)     ← 활동 많은 계정
//     게시글(37)      댓글(91)        ← 적은 계정
// v1.6.4까지 \((\d+)\) 였어서 1,000을 넘는 순간 못 읽었다. 그런데 같은 화면의
// 스크랩(0)·방명록(14)은 잡혀서, 겉으로는 "화면 구조가 바뀐 것 같다"로만 보였다.
// 파딱 갤(t1win)처럼 큰 갤은 활동량 많은 사람이 대부분이라 이쪽이 다수다.
// 2026-09-08 갤로그 점검에서 300명 중 258명이 실패한 원인의 상당 부분이 이것이다.
// (그날은 IP 차단도 같이 났다. 두 가지가 겹쳐 있었다. 5-5절)
const RE_GALLOG_COUNT =
  /class="[^"]*\btit\b[^"]*"[^>]*>\s*([^<]+?)\s*<span[^>]*class="[^"]*\bnum\b[^"]*"[^>]*>\s*\(([\d,]+)\)/gi;

// 못 읽으면 null을 준다. 0으로 읽어서 '활동 없음'이라 하면 조용한 실패가 된다.
export function parseGallogCounts(html) {
  const found = {};
  for (const m of (html || "").matchAll(RE_GALLOG_COUNT)) {
    const label = m[1];
    const n = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    if (label.includes("게시글")) found.posts = n;
    else if (label.includes("댓글")) found.comments = n;
    else if (label.includes("스크랩")) found.scraps = n;
  }
  if (found.posts === undefined || found.comments === undefined) return null;
  return {
    posts: found.posts,
    comments: found.comments,
    scraps: found.scraps ?? 0,
    total: found.posts + found.comments,
  };
}

// 2026-09-08 세 갈래 모두 실물 확인. 탈퇴와 '없는 코드'는 둘 다 404라서
// 상태 코드로는 못 가른다. 본문으로만 갈린다.
//
//   탈퇴한 계정 → 404 + 본문이 이 한 줄(103바이트)뿐이다:
//       <script>location.replace("https://gallog.dcinside.com/_error/deleted");</script>
//   없는 코드   → 404 + "404 Page Not Found"
//
// 브라우저에서는 저 스크립트가 돌아서 "삭제된 갤로그입니다" 화면이 뜬다.
// 하지만 fetch 는 스크립트를 안 돌리므로 그 문구를 절대 못 본다.
// 화면에서 본 문구를 찾으려다 한 번 틀렸다. 찾아야 할 것은 문구가 아니라
// 스크립트 안의 이동 주소다. 문구보다 경로가 덜 바뀌기도 한다.
//
// 이 두 갈래를 합치지 말 것. 코드를 잘못 읽었을 때 멀쩡한 사람이 탈퇴로 찍혀
// 명단에서 지워지는 걸 막는 마지막 안전장치다.
const RE_GALLOG_DELETED = /_error\/deleted|삭제된\s*갤로그/;

// { state, counts, bytes } 를 돌려준다. counts 는 alive 일 때만, 그것도 읽혔을 때만.
//
// bytes(본문 길이)를 같이 주는 이유: 숫자를 못 읽었을 때 원인이 두 가지인데
// 겉보기가 같다. 화면 구조가 바뀐 것과, 디시가 우리를 막아 빈 응답을 주는 것.
// 앞의 것은 본문이 멀쩡히 길고, 뒤의 것은 대개 짧거나 비어 있다.
// 2026-09-08 사고 때 확장이 뒤의 것을 앞의 것으로 잘못 보고했다.
export async function checkGallog(code) {
  try {
    const res = await fetch(`${GALLOG_URL}/${encodeURIComponent(code)}`, {
      credentials: "omit", redirect: "follow",
    });

    let body = "";
    try { body = await res.text(); } catch { /* 본문을 못 읽어도 아래에서 판단은 한다 */ }
    const bytes = body.length;

    // 주소가 실제로 바뀌어 오는 경우와, 스크립트로 바꾸라는 본문이 오는 경우 둘 다.
    if (/\/_error\/deleted/.test(res.url || "") || RE_GALLOG_DELETED.test(body)) {
      return { state: "deleted", counts: null, bytes };
    }
    if (res.status === 404) return { state: "notfound", counts: null, bytes };
    if (!res.ok) return { state: "other", counts: null, bytes };
    return { state: "alive", counts: parseGallogCounts(body), bytes };
  } catch {
    return { state: "error", counts: null, bytes: 0 };
  }
}

