import {
  parseBlockList, chunkCodes, analyzeCode, expiresAt, isManualRelease, labelForHours,
} from "./dc.js";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

function row({ trAttr = "", num = 1, nik, state = "차단중", reason = "음란성",
               duration = "31일", date = "2026.08.01", time = "10:00:00" }) {
  return `
  <tr${trAttr}>
    <td class="blocknum" data-num="${num}">${num}</td>
    <td class="blocknik">${nik}</td>
    <td class="blockreason">${reason}</td>
    <td class="blocktime">${duration}</td>
    <td class="blockdate">
      <span class="block_date">${date}</span>
      <div class="blockinfo">
        <span class="block_time">처리 시간 : ${time}</span>
        <span class="block_conduct">처리자 : 매니저</span>
      </div>
    </td>
    <td class="blockstate">${state}</td>
  </tr>`;
}

function table(rows) {
  return `<html><body><table class="minor_block_list">
    <thead><tr><th>번호</th></tr></thead>
    <tbody>${rows.join("")}</tbody></table></body></html>`;
}

console.log("\n[1] tr 속성 내성 (v1.5.1에서 깨지던 부분)");
{
  const plain = parseBlockList(table([row({ nik: "홍길동 (abcd1234)" })]));
  ok("속성 없는 <tr>", plain.length === 1);

  const attr = parseBlockList(table([
    row({ trAttr: ' class="on" data-idx="3"', nik: "홍길동 (abcd1234)" }),
    row({ trAttr: " ", num: 2, nik: "김철수 (efgh5678)" }),
  ]));
  ok("<tr class=...> 도 읽음", attr.length === 2, JSON.stringify(attr.length));
  ok("식별코드 정상", attr[0].identity.value === "abcd1234");
  ok("기간 정상", attr[0].duration === "31일");
  ok("사유 정상", attr[0].reason === "음란성");
  ok("처리시각 정상", attr[0].time === "10:00:00");
}

console.log("\n[2] class 값이 늘어나도 읽음");
{
  const html = table([row({ nik: "홍 (aaaa1111)" })])
    .replace('class="blocknik"', 'class="blocknik ellipsis"')
    .replace('class="blocktime"', 'class="blocktime txt"')
    .replace('class="blocknum"', 'class="blocknum first"');
  const r = parseBlockList(html);
  ok("행 인식", r.length === 1);
  ok("닉셀 인식", r.length === 1 && r[0].identity.value === "aaaa1111");
  ok("기간 인식", r.length === 1 && r[0].duration === "31일");
}

console.log("\n[3] 조용한 실패 감지 (핵심)");
{
  // 못 읽는 구조를 흉내: tr 자체가 없어 행을 못 잡는 상황
  const broken = table([row({ nik: "홍 (bbbb2222)" }), row({ num: 2, nik: "김 (cccc3333)" })])
    .replace(/<tr\b/g, "<div").replace(/<\/tr>/g, "</div>");
  const r = parseBlockList(broken);
  ok("파싱 0행", r.length === 0);
  ok("표에 2행 있었음을 앎", r.expectedRows === 2, `expected=${r.expectedRows}`);
  ok("missedRows 경고", r.missedRows === 2);

  const empty = parseBlockList(table([]));
  ok("진짜 이력 없음은 경고 안 함", empty.length === 0 && empty.missedRows === 0);
}

console.log("\n[4] 기존 기능 회귀");
{
  // 검색 강조 태그가 코드 중간에 끼는 경우
  const hl = parseBlockList(table([row({ nik: '<b>홍</b> (lea<span class="hl">f451</span>7)' })]));
  ok("강조 태그 복원", hl[0].identity.value === "leaf4517", hl[0]?.identity?.value);

  // code + IP
  const ip = parseBlockList(table([
    row({ nik: '홍 (abcd1234)<span class="txtip">1.2.*.*</span>' }),
  ]));
  ok("code+IP 구분", ip[0].identity.kind === "code_ip" && ip[0].identity.matchKey === "abcd1234");

  // 순수 IP
  const pure = parseBlockList(table([row({ nik: "유동 (1.2.*.*)" })]));
  ok("IP는 matchKey 없음", pure[0].identity.kind === "ip" && pure[0].identity.matchKey === null);

  // script 템플릿 제거
  const sc = parseBlockList(table([
    row({ nik: '홍 (dddd4444)<script>var t="(nope)";</script>' }),
  ]));
  ok("script 무시", sc[0].identity.value === "dddd4444", sc[0]?.identity?.value);

  const batches = chunkCodes(Array.from({ length: 80 }, (_, i) => `code${String(i).padStart(4, "0")}`));
  const maxlen = Math.max(...batches.map((b) => b.join("\n").length));
  ok("500자 분할", maxlen <= 500, `max=${maxlen}`);
  ok("전원 포함", batches.flat().length === 80);
}

console.log("\n[5] 판정");
{
  const now = new Date("2026.09.06 12:00:00");
  const mk = (o) => parseBlockList(table([row(o)]));

  // 자연 만료 → candidate
  const expired = mk({ nik: "홍 (aaaa1111)", state: "해제됨", date: "2026.07.01" });
  const a = analyzeCode(expired, "aaaa1111", {}, now);
  ok("자연만료 → candidate", a.status === "candidate", a.status);

  // 기간 남았는데 해제 → manual
  const early = mk({ nik: "홍 (aaaa1111)", state: "해제됨", date: "2026.09.01" });
  const b = analyzeCode(early, "aaaa1111", {}, now);
  ok("조기해제 → manual", b.status === "manual", b.status);
  ok("wouldExpire는 숫자", typeof b.wouldExpire === "number");

  // 차단 중
  const act = mk({ nik: "홍 (aaaa1111)", date: "2026.09.01" });
  ok("차단중 → active", analyzeCode(act, "aaaa1111", {}, now).status === "active");

  // 이력 없음
  ok("없음 → none", analyzeCode([], "aaaa1111", {}, now).status === "none");

  // 10분 경계
  const exp = expiresAt(act[0]);
  ok("만료 5분 전 해제는 자연만료로 봄", isManualRelease({ ...act[0], released: true }, new Date(exp.getTime() - 5 * 60000)) === false);
  ok("만료 1시간 전 해제는 manual", isManualRelease({ ...act[0], released: true }, new Date(exp.getTime() - 3600000)) === true);
}

console.log("\n[6] 검증 페이지 수 계산");
{
  const pages = (n) => Math.min(20, Math.max(4, Math.ceil(n / 15) + 2));
  ok("10명 → 4페이지", pages(10) === 4, String(pages(10)));
  ok("100명 → 9페이지", pages(100) === 9, String(pages(100)));
  ok("500명 → 20페이지 상한", pages(500) === 20);
  ok("31일 라벨", labelForHours(744) === "31일");
}

console.log("\n[7] busy 잠금 / 날짜 키");
{
  const BUSY_TIMEOUT_MS = 30 * 60 * 1000;
  const isBusy = (s, now = Date.now()) =>
    !!s && !!s.busy && now - (s.busySince || 0) < BUSY_TIMEOUT_MS;

  const now = Date.now();
  ok("방금 시작한 작업은 busy", isBusy({ busy: true, busySince: now - 60000 }, now));
  ok("31분 지난 잠금은 무시", !isBusy({ busy: true, busySince: now - 31 * 60000 }, now));
  ok("busySince 없는 옛 기록도 무시", !isBusy({ busy: true }, now));
  ok("대기 중은 안 busy", !isBusy({ busy: false, busySince: 0 }, now));

  const p = (n) => String(n).padStart(2, "0");
  const localDateKey = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const kst = new Date("2026-09-06T07:30:00+09:00");   // KST 07:30 = UTC 전날 22:30
  ok("로컬 날짜 키", localDateKey(kst) === "2026-09-06", localDateKey(kst));
  ok("UTC 키였다면 어긋남", kst.toISOString().slice(0, 10) === "2026-09-05");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
