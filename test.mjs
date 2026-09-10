// 실행:  node test.mjs
//
// 브라우저 없이 확인할 수 있는 것들을 전부 여기서 돌린다.
// 픽스처는 지어낸 게 아니라 2026-09-06 실제 관리 화면에서 복사한 마크업이다.
// 지어낸 마크업으로 테스트하면 통과해도 아무것도 보장하지 못한다.
// 실제로 그것 때문에 v1.5.1~1.5.3의 버그를 못 잡았다.
//
// 그리고 여기서는 dc.js가 내보내는 함수를 그대로 부른다.
// 테스트 파일에 같은 식을 옮겨 적으면 그 복사본만 검사하게 되어,
// 정작 실제 코드가 바뀌어도 통과해버린다.

import {
  parseBlockList, analyzeCode, chunkCodes, collectByDuration,
  expiresAt, isManualRelease, labelForHours,
  listPagesFor, isBusy, localDateKey, REASON_VALUES, HOURS_BY_LABEL,
  jitter, CHECK_DELAY_MS, GALLOG_DELAY_MS, GALLOG_FAIL_STREAK, rowHealth, carryOver,
  reasonFields, CUSTOM_REASON, REASON_TXT_MAX, pickGallogTargets, FETCH_SECS, mergeGallog, fetchRowsForCode,
} from "./dc.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${extra}`); }
}
function eq(name, got, want) {
  ok(name, got === want, `기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`);
}

// ── 실제 마크업 ──────────────────────────────────────────────
// 닉과 코드가 빈 <p></p> 껍데기에 싸여 있고, 셀 안에 jQuery 템플릿 <script>가
// 들어 있으며, 처리 시각은 display:none 안에 숨어 있다. 상태 칸 클래스는
// "blockstate txtbtn"이다. 전부 실제 화면 그대로다.
function row({ num = 1, dataNum = 13799443, nik, code, state = "해제됨",
               reason = "음란성", duration = "31일",
               date = "2026.09.06", time = "15:06:30" } = {}) {
  const stateCell = state === "차단 중"
    ? `차단 중 <button type="button" class="btn_blue_round small" onclick="set_avoid(this, 'R', '${dataNum}', 0)">해제</button>`
    : "해제됨";
  return `
			<tr>
				<td class="gall_chk"><span class="checkbox">
					<input type="checkbox" id="list_chk" name="chk_avoid_user[]">
					<label for="list_chk" class="blind">글 선택</label></span></td>
			  <td class="blocknum" data-num="${dataNum}">${num}</td>
			  <td class="blocknik">
				<p></p><p>${nik}</p><p></p>
				<p></p><p>(${code})</p><p></p>
				<script id="dup_grey-tmpl" type="text/x-jquery-tmpl">
					<div class="pop_tipbox tip_bg_grey dup_grey_pop">
						<div class="inner tip_blocknik">
							<p class="block_txt">중복 차단으로 기존 차단은 해제되었습니다.</p>
						</div>
					</div>
				</script>
			  </td>
			  <td class="blockcontent"><span><em>직접 차단</em></span></td>
			  <td class="blockreason">${reason}</td>
			  <td class="blocktime">${duration}</td>
			  <td class="blockday">
				<span class="block_date">${date}</span>
				<div class="pop_tipbox tip_bg_grey" style="display:none">
				  <div class="inner tip_blockday">
					<p class="block_time">처리 시간 : ${time}</p>
					<p class="block_conduct">처리자 : 매니저(manager1234)</p>
				  </div>
				</div>
			  </td>
			  <td class="blockstate txtbtn">

								${stateCell}

			  </td>
			</tr>`;
}

const table = (rows) => `<table class="minor_block_list">
		  <caption>차단 리스트</caption>
		  <thead><tr><th scope="col">번호</th></tr></thead>
		  <tbody>${rows.join("")}</tbody>
		</table>`;

// ── 1. 실제 마크업 파싱 ──────────────────────────────────────
// 2026-09-08 실제 갤로그 홈에서 복사한 마크업. 비로그인 + 비공개 상태다.
// 목록은 '게시글이 없습니다'로 가려져 있는데 개수는 그대로 나온다.
const GALLOG_HOME = `
<div class="wrap_right">
<section>
  <div class="gallog_cont">
	<header>
	  <div class="cont_head clear">
		<h2 class="tit" onclick="location.href='/hear9577/posting';" style="cursor:pointer">게시글<span class="num">(29)</span></h2>
		<span class="greybox">비공개</span>
	  </div>
	</header>
	<div class="cont_box">
<div class="gallog_empty small">
  게시글이 없습니다.
</div>
	</div>
  </div>
</section>
<section>
  <div class="gallog_cont comments">
	<header>
	  <div class="cont_head clear">
		<h2 class="tit" onclick="location.href='/hear9577/comment';" style="cursor:pointer">댓글<span class="num">(332)</span></h2>
		<span class="greybox">비공개</span>
	  </div>
	</header>
	<div class="cont_box">
<div class="gallog_empty small">
  댓글이 없습니다.
</div>
	</div>
  </div>
</section>
<section>
  <div class="gallog_cont scraps">
	<header>
	  <div class="cont_head clear">
		<h2 class="tit" onclick="location.href='/hear9577/scrap';" style="cursor:pointer">스크랩<span class="num">(2)</span></h2>
		<span class="greybox">공개</span>
	  </div>
	</header>
  </div>
</section>
<section>
  <div class="gallog_cont gstbook">
	<header>
	  <div class="cont_head clear">
		<h2 class="tit" onclick="location.href='/hear9577/guestbook';" style="cursor:pointer">방명록<span class="num">(1)</span></h2>
	  </div>
	</header>
  </div>
</section>
</div>`;

console.log("\n[1] 실제 관리 화면 마크업 파싱");
{
  const rows = parseBlockList(table([
    row({ num: 49, dataNum: 13799753, nik: "ㅇㅇ", code: "chip3298", state: "차단 중", time: "15:56:20" }),
    row({ num: 48, dataNum: 13799443, nik: "송재원(새우젓눈깔)", code: "119.65.*.*" }),
    row({ num: 46, dataNum: 13799441, nik: "성소피아대성당", code: "capture6180" }),
  ]));

  eq("행 수", rows.length, 3);
  eq("표에서 센 행", rows.expectedRows, 3);
  eq("못 읽은 행", rows.missedRows, 0);

  eq("고닉 식별코드", rows[2].identity.value, "capture6180");
  eq("유동닉 이름", rows[0].identity.nick, "ㅇㅇ");

  // 닉네임 자체에 괄호가 들어간다. 마지막 괄호를 식별자로 봐야 한다.
  eq("닉에 괄호 + IP → kind", rows[1].identity.kind, "ip");
  eq("닉에 괄호 + IP → 닉", rows[1].identity.nick, "송재원(새우젓눈깔)");
  eq("IP는 갱신 대상 제외", rows[1].identity.matchKey, null);

  // 셀 안 <script> 템플릿에 "해제되었습니다"가 들어 있다. 걷어내지 않으면 오염된다.
  ok("템플릿 문구가 코드로 새어들지 않음", !rows.some((r) => /해제/.test(r.identity.value)));

  // class="blockstate txtbtn" — 완전일치로 잡으면 여기서 전부 깨진다.
  eq("차단 중 행", rows[0].released, false);
  eq("해제됨 행", rows[2].released, true);
  ok("상태를 읽지 못한 행 없음", rows.every((r) => !r.stateUnknown));

  // 처리 시각은 display:none 안에 숨어 있다.
  eq("숨은 처리 시각", rows[0].time, "15:56:20");
  eq("처리일", rows[0].date, "2026.09.06");
}

// ── 2. 검색 결과의 강조 태그 ─────────────────────────────────
console.log("\n[2] 검색 강조 태그");
{
  const hi = parseBlockList(table([
    row({ nik: "분탕", code: 'lea<span class="hl">f451</span>7' }),
  ]));
  // 태그를 공백으로 치환하면 "lea f451 7"로 깨진다. 공백 없이 지워야 한다.
  eq("쪼개진 코드 복원", hi[0].identity.value, "leaf4517");
}

// ── 3. 파싱 실패를 조용히 넘기지 않는가 ──────────────────────
console.log("\n[3] 파싱 실패 감지");
{
  const broken = `<table class="minor_block_list"><tbody>
    <div class="blocknum">1</div><div class="blocknum">2</div></tbody></table>`;
  const r = parseBlockList(broken);
  eq("표는 찾음", r.tableFound, true);
  eq("행이 있다고 셈", r.expectedRows, 2);
  eq("하나도 못 읽음", r.length, 0);
  eq("누락으로 보고", r.missedRows, 2);

  // 이력 없는 코드를 검색하면 정상적으로 0행이다. 이건 경고 대상이 아니다.
  const empty = parseBlockList(table([]));
  eq("빈 표는 누락 아님", empty.missedRows, 0);
  eq("표 없으면 tableFound false", parseBlockList("<div>없음</div>").tableFound, false);

  eq("못 읽은 행은 broken", rowHealth(r).broken, true);
  ok("정상 표는 broken 아님", !rowHealth(parseBlockList(table([
    row({ nik: "ㅇㅇ", code: "chip3298" }),
  ]))).broken);

  // v1.5.2에서 실제로 났던 사고. 행 수는 딱 맞는데 상태 칸만 안 읽힌다.
  // missedRows가 0이라 행 수 대조로는 절대 안 잡힌다. 놓치면 해제된 사람이
  // 전원 '차단 중'으로 보이고 후보가 0건이 되는데 화면은 조용하다.
  const stateBroken = parseBlockList(
    table([row({ nik: "ㅇㅇ", code: "chip3298", state: "해제됨" })])
      .replace('class="blockstate txtbtn"', 'class="blk_state txtbtn"')
  );
  eq("행 자체는 읽힘", stateBroken.length, 1);
  eq("행 수 대조로는 못 잡음", stateBroken.missedRows, 0);
  eq("상태 못 읽음 표시", stateBroken[0].stateUnknown, true);
  eq("해제됨인데 차단 중으로 보임", stateBroken[0].released, false);
  eq("rowHealth가 상태 실패를 잡음", rowHealth(stateBroken).badState, 1);
  eq("상태 실패도 broken", rowHealth(stateBroken).broken, true);

  // 식별자만 못 읽는 경우. analyzeCode가 그 행을 남의 것으로 보고 버린다.
  const idBroken = parseBlockList(
    table([row({ nik: "ㅇㅇ", code: "chip3298" })])
      .replace('class="blocknik"', 'class="block_nik"')
  );
  eq("식별자 못 읽음", idBroken[0].identity, null);
  eq("rowHealth가 식별자 실패를 잡음", rowHealth(idBroken).badIdentity, 1);
  eq("식별자 실패도 broken", rowHealth(idBroken).broken, true);
}

// ── 4. 판정 ──────────────────────────────────────────────────
console.log("\n[4] 판정");
{
  const one = (o) => parseBlockList(table([row(o)]));
  const at = (s) => new Date(s);

  // 31일 차단, 2026.08.01 10:00 처리 → 만료 2026.09.01 10:00
  const natural = one({ nik: "ㅇㅇ", code: "aaa1111", date: "2026.08.01", time: "10:00:00" });
  eq("자연 만료 → candidate", analyzeCode(natural, "aaa1111", {}, at("2026-09-06T12:00:00")).status, "candidate");

  const early = one({ nik: "ㅇㅇ", code: "aaa1111", date: "2026.09.05", time: "10:00:00" });
  eq("완장이 직접 품 → manual", analyzeCode(early, "aaa1111", {}, at("2026-09-06T12:00:00")).status, "manual");

  const alive = one({ nik: "ㅇㅇ", code: "aaa1111", date: "2026.09.05", time: "10:00:00", state: "차단 중" });
  eq("차단 중 → active", analyzeCode(alive, "aaa1111", {}, at("2026-09-06T12:00:00")).status, "active");

  eq("이력 없음 → none", analyzeCode([], "aaa1111", {}, at("2026-09-06T12:00:00")).status, "none");

  // 재차단하면 옛 해제됨 행이 30일 남는다. 최신 행만 보고 판단해야 한다.
  const mixed = parseBlockList(table([
    row({ num: 2, dataNum: 2, nik: "ㅇㅇ", code: "bbb2222", date: "2026.09.06", time: "10:00:00", state: "차단 중" }),
    row({ num: 1, dataNum: 1, nik: "ㅇㅇ", code: "bbb2222", date: "2026.08.01", time: "10:00:00" }),
  ]));
  eq("옛 해제됨 행이 남아도 재차단 안 함", analyzeCode(mixed, "bbb2222", {}, at("2026-09-06T12:00:00")).status, "active");

  // 만료 직전에 푼 건 구분이 안 된다. 10분을 경계로 삼는다.
  const r5 = one({ nik: "ㅇㅇ", code: "ccc3333", duration: "1시간", date: "2026.09.06", time: "10:00:00" });
  eq("만료 5분 전 해제는 자연만료로 봄", analyzeCode(r5, "ccc3333", {}, at("2026-09-06T10:56:00")).status, "candidate");
  eq("만료 30분 전 해제는 manual", analyzeCode(r5, "ccc3333", {}, at("2026-09-06T10:31:00")).status, "manual");

  // storage 는 Date 객체를 담지 못한다. 반드시 숫자여야 한다.
  const res = analyzeCode(natural, "aaa1111", {}, at("2026-09-06T12:00:00"));
  ok("nextCheckAt 은 숫자", typeof res.nextCheckAt === "number");
  ok("wouldExpire 는 숫자", res.wouldExpire === undefined || typeof res.wouldExpire === "number");
}

// ── 5. 사유·기간 매핑 ────────────────────────────────────────
console.log("\n[5] 사유와 기간");
{
  // 목록에는 '혐오콘텐츠', 차단 팝업 라벨은 '혐오 콘텐츠'. 공백이 다르다.
  // 그대로 두면 나중에 '알 수 없는 사유'로 그룹 전체가 실패한다.
  const r = parseBlockList(table([row({ nik: "ㅇㅇ", code: "ddd4444", reason: "혐오콘텐츠" })]));
  eq("사유 공백 흡수", r[0].reason, "혐오 콘텐츠");
  eq("코드값 조회됨", String(REASON_VALUES[r[0].reason]), "5");
  eq("31일 라벨", labelForHours(744), "31일");
  eq("31일 → 시간", HOURS_BY_LABEL["31일"], 744);
}

// ── 6. 500자 분할 ────────────────────────────────────────────
console.log("\n[6] 500자 분할");
{
  const codes = Array.from({ length: 200 }, (_, i) => `code${String(i).padStart(4, "0")}`);
  const groups = chunkCodes(codes);
  ok("모든 묶음이 500자 이하", groups.every((g) => g.join("\n").length <= 500));
  eq("전원 포함", groups.flat().length, 200);
  ok("순서 유지", groups.flat().every((c, i) => c === codes[i]));
}

// ── 7. 여러 페이지 순회 ──────────────────────────────────────
// v1.5.3까지 1페이지만 읽던 부분이다. 페이지 파라미터는 'page'가 아니라 'p'.
console.log("\n[7] 페이지 순회");
{
  const PAGE = 30;
  const make = (total, mode) => {
    const seen = [];
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      seen.push(u.search);
      let page = Number(u.searchParams.get("p") || 1);
      if (mode === "ignore") page = 1;                       // p를 무시하는 서버
      if (mode === "clamp") page = Math.min(page, Math.ceil(total / PAGE)); // 범위 밖이면 마지막
      const s = (page - 1) * PAGE;
      const body = s >= total ? "" : Array.from(
        { length: Math.min(PAGE, total - s) },
        (_, k) => row({ num: total - s - k, dataNum: 90000 + s + k, nik: "ㅇㅇ", code: `c${s + k}`, state: "차단 중" })
      ).join("");
      return { ok: true, text: async () => table([body]) };
    };
    return seen;
  };

  let seen = make(78, "normal");
  let r = await collectByDuration("gid", "31일", 10);
  eq("78명 3페이지 전원 수집", r.items.length, 78);
  eq("읽은 페이지", r.pages, 3);
  ok("'p' 파라미터로 요청", seen[1].includes("p=2"), seen[1]);
  ok("'page' 파라미터는 쓰지 않음", !seen.some((s) => s.includes("page=")));
  eq("중복 감지 안 걸림", r.repeated, false);

  make(78, "clamp");
  r = await collectByDuration("gid", "31일", 20);
  eq("범위 밖 페이지를 되돌려줘도 멈춤", r.repeated, true);
  eq("그래도 전원 수집", r.items.length, 78);

  make(78, "ignore");
  r = await collectByDuration("gid", "31일", 20);
  eq("파라미터가 안 먹으면 1페이지에서 멈춤", r.pages, 1);
  eq("그 사실을 알림", r.repeated, true);

  make(200, "normal");
  r = await collectByDuration("gid", "31일", 3);
  eq("상한에 걸리면 more", r.more, true);
  eq("상한만큼만 읽음", r.pages, 3);

  make(10, "normal");
  r = await collectByDuration("gid", "31일", 10);
  eq("1페이지뿐이면 오탐 없음", r.repeated, false);
  delete globalThis.fetch;
}

// ── 7-2. 날짜까지만 훑기 ─────────────────────────────────────
// 페이지 수를 감으로 찍는 대신 "언제까지"로 멈춘다.
console.log("\n[7-2] 날짜 기준 중단");
{
  const PAGE = 30;
  // 하루에 30명씩 차단된 갤러리. page 1 = 오늘, page 2 = 어제 ...
  const dayOf = (p) => {
    const d = new Date("2026-09-07T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - (p - 1));
    return d.toISOString().slice(0, 10).replace(/-/g, ".");
  };
  let asked = 0;
  globalThis.fetch = async (url) => {
    const p = Number(new URL(url).searchParams.get("p") || 1);
    asked++;
    const body = Array.from({ length: PAGE }, (_, k) =>
      row({ num: k, dataNum: p * 1000 + k, nik: "ㅇㅇ", code: `p${p}c${k}`, date: dayOf(p), state: "차단 중" })
    ).join("");
    return { ok: true, text: async () => table([body]) };
  };

  asked = 0;
  let r = await collectByDuration("gid", "31일", 3000, null, "2026-09-01");
  // 경계를 지났는지 알려면 기준일보다 오래된 행이 나오는 페이지까지 읽어야 한다.
  // 9월 1일이 7페이지, 8월 31일이 8페이지라 8페이지에서 멈춘다.
  eq("경계를 확인하고 멈춤", r.pages, 8);
  eq("날짜 때문에 멈췄다고 보고", r.reachedDate, true);
  eq("상한에는 안 걸림", r.more, false);
  eq("어디까지 봤는지", r.oldest, "2026.08.31");
  ok("3000페이지가 아니라 8번만 요청", asked === 8, `${asked}회`);
  // 마지막 페이지의 8월 31일자는 담기지 않아야 한다
  eq("기준일 밖은 안 담음", r.items.filter((i) => i.date < "2026.09.01").length, 0);
  eq("9월 1일 ~ 7일 7일치", r.items.length, 7 * 30);

  asked = 0;
  r = await collectByDuration("gid", "31일", 3, null, "2026-01-01");
  eq("날짜에 못 닿으면 상한에서 멈춤", r.more, true);
  eq("reachedDate 는 false", r.reachedDate, false);
  eq("어디까지 갔는지 알려줌", r.oldest, "2026.09.05");

  // 날짜를 안 주면 예전처럼 페이지 수로만 돈다
  asked = 0;
  r = await collectByDuration("gid", "31일", 5);
  eq("날짜 없으면 상한까지", r.pages, 5);
  eq("reachedDate 없음", r.reachedDate, false);

  delete globalThis.fetch;
}

// ── 8. 공용 헬퍼 ─────────────────────────────────────────────
console.log("\n[8] 공용 헬퍼");
{
  // 한 페이지 30행 기준
  eq("10명", listPagesFor(10), 4);
  eq("100명", listPagesFor(100), 6);
  eq("500명", listPagesFor(500), 19);
  eq("상한 20", listPagesFor(5000), 20);

  const now = Date.now();
  ok("방금 시작한 작업은 busy", isBusy({ busy: true, busySince: now - 60000 }, now));
  ok("31분 지난 잠금은 무시", !isBusy({ busy: true, busySince: now - 31 * 60000 }, now));
  ok("busySince 없는 옛 기록도 무시", !isBusy({ busy: true }, now));
  ok("대기 중은 안 busy", !isBusy({ busy: false, busySince: 0 }, now));
  ok("status 없어도 안전", !isBusy(undefined, now));

  // toLocaleDateString('sv-SE') 가 로컬 기준 YYYY-MM-DD 를 준다.
  // 별개 구현과 대조하는 것이라 어느 시간대에서 돌려도 유효하다.
  const samples = ["2026-09-06T07:30:00+09:00", "2026-01-01T00:10:00+09:00", "2026-12-31T23:50:00Z"];
  for (const s of samples) {
    const d = new Date(s);
    eq(`로컬 날짜 키 ${s}`, localDateKey(d), d.toLocaleDateString("sv-SE"));
  }

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz === "Asia/Seoul") {
    const kst = new Date("2026-09-06T07:30:00+09:00");
    eq("KST 오전 7시 30분", localDateKey(kst), "2026-09-06");
    ok("UTC 키였다면 어긋남", kst.toISOString().slice(0, 10) === "2026-09-05");
  } else {
    console.log(`  건너뜀 KST 전용 검사 (현재 시간대 ${tz}, TZ=Asia/Seoul 로 실행하면 돕니다)`);
  }
}

// ── 9. 만료 시각 계산 ────────────────────────────────────────
console.log("\n[9] 만료 시각");
{
  const r = parseBlockList(table([
    row({ nik: "ㅇㅇ", code: "eee5555", duration: "31일", date: "2026.08.09", time: "21:07:33" }),
  ]))[0];
  const exp = expiresAt(r);
  eq("2026.08.09 21:07:33 + 31일", exp.toLocaleString("sv-SE"), "2026-09-09 21:07:33");
  ok("만료 전에는 아직 안 풀림", exp.getTime() > new Date("2026-09-09T21:00:00").getTime());
  ok("만료 뒤 해제는 수동 아님", !isManualRelease(r, new Date("2026-09-09T21:10:00")));
}

// ── 10. 하루 차단 한도 ────────────────────────────────────────
// 한도에 걸리면 남은 묶음을 보내지 않고, 보내지도 않은 사람을
// '실패'로 기록하지 않아야 한다.
console.log("\n[10] 하루 차단 한도");
{
  const { blockCodes } = await import("./dc.js");
  globalThis.chrome = { cookies: { get: async () => ({ value: "T" }) } };

  const codes = Array.from({ length: 120 }, (_, i) => `code${String(i).padStart(4, "0")}`);
  let posts = 0;
  const blockedNow = new Set();

  globalThis.fetch = async (url, opt = {}) => {
    if (opt.method === "POST") {
      posts++;
      if (posts >= 2) {
        // 두 번째 묶음부터 한도에 걸린 상황
        // 2026-09-08 실제 확인한 문구
        return { ok: true, text: async () =>
          JSON.stringify({ result: false,
            msg: "일일 차단 횟수가 초과되어 장시간 차단이 불가능합니다." }) };
      }
      for (const c of new URLSearchParams(opt.body).get("user_codes").split("\n")) {
        blockedNow.add(c);
      }
      return { ok: true, text: async () => JSON.stringify({ result: true }) };
    }
    const all = [...blockedNow];
    const kw = new URL(url).searchParams.get("s_keyword");
    const pick = kw ? all.filter((c) => c === kw) : all.slice(0, 30);
    return { ok: true, text: async () => table(
      pick.map((c, i) => row({ num: i, dataNum: 700000 + i, nik: "ㅇㅇ", code: c, state: "차단 중" }))
    ) };
  };

  const r = await blockCodes("gid", codes, "음란성", 744, () => {});
  ok("한도를 알아챔", r.limitHit === true);
  eq("디시 문구를 그대로 남김", r.limitMessage,
     "일일 차단 횟수가 초과되어 장시간 차단이 불가능합니다.");
  ok("한도 뒤로는 안 보냄", posts === 2, `POST ${posts}회`);
  ok("보낸 사람은 확인됨", r.verified.length > 0);
  ok("못 보낸 사람이 남음", r.notSent.length > 0);
  eq("보낸 것 + 못 보낸 것 = 전체", r.verified.length + r.failed.length + r.notSent.length, 120);
  ok("못 보낸 사람은 실패로 세지 않음", r.failed.every((c) => !r.notSent.includes(c)));
  ok("ok 는 false", r.ok === false);
  ok("안내 문구에 남은 인원", /보내지 못했습니다/.test(r.message), r.message);

  // ── 첫 묶음부터 걸리는 경우 ──────────────────────────────
  // 2026-09-08 주딱 계정에서 실제로 이렇게 났다. 한 명도 못 보낸 상황인데
  // "0건 모두 31일 차단 확인됨" / "완료: 0/0건 확인" 이라고 나왔다.
  // 아무 일도 안 일어났는데 성공처럼 읽힌다. 원칙 2번이 경계하는 형태다.
  posts = 0;
  blockedNow.clear();
  globalThis.fetch = async (url, opt = {}) => {
    if (opt.method === "POST") {
      posts++;
      return { ok: true, text: async () =>
        JSON.stringify({ result: false,
          msg: "일일 차단 횟수가 초과되어 장시간 차단이 불가능합니다." }) };
    }
    return { ok: true, text: async () => table([]) };
  };

  const first = await blockCodes("gid", ["aaa1111", "bbb2222"], "음란성", 744, () => {});
  eq("첫 묶음만 보내고 멈춤", posts, 1);
  eq("확인된 사람 없음", first.verified.length, 0);
  eq("실패로 세지 않음", first.failed.length, 0);
  eq("전원 미전송으로 남김", first.notSent.length, 2);
  ok("성공처럼 말하지 않는다", !/모두 .*차단 확인됨/.test(first.message), first.message);
  ok("한 명도 못 보냈다고 말함", /한 명도 보내지 못했습니다/.test(first.message), first.message);
  ok("ok 는 false", first.ok === false);

  delete globalThis.fetch;
  delete globalThis.chrome;
}

console.log("\n[10-2] 한도 문구 알아보기");
{
  const { blockCodes } = await import("./dc.js");
  globalThis.chrome = { cookies: { get: async () => ({ value: "T" }) } };

  // 문구 하나로 한 번씩 돌려서, 한도로 보는지 아닌지만 확인한다.
  const hit = async (msg) => {
    globalThis.fetch = async (url, opt = {}) => {
      if (opt.method === "POST") {
        return { ok: true, text: async () => JSON.stringify({ result: false, msg }) };
      }
      return { ok: true, text: async () => table([]) };
    };
    const r = await blockCodes("gid", ["aaaa1111"], "음란성", 744, () => {});
    return r.limitHit;
  };

  ok("실제 문구", await hit("일일 차단 횟수가 초과되어 장시간 차단이 불가능합니다."));
  ok("띄어쓰기가 달라도", await hit("일일차단횟수가 초과되어 장시간차단이 불가능합니다."));
  ok("표현이 바뀌어도", await hit("오늘 차단 횟수를 전부 사용했습니다."));
  ok("소진 표현", await hit("금일 차단 가능 횟수가 소진되었습니다."));
  ok("장시간 표현만 있어도", await hit("장시간 차단이 불가능합니다."));

  // 한도가 아닌 응답을 한도로 착각하면, 멀쩡한 사람을 안 보내고 넘어간다.
  ok("성공 응답은 한도 아님", !(await hit("차단되었습니다.")));
  ok("권한 오류는 한도 아님", !(await hit("권한이 없습니다.")));
  ok("코드 오류는 한도 아님", !(await hit("존재하지 않는 식별코드입니다.")));
  ok("중복 안내는 한도 아님", !(await hit("중복 차단으로 기존 차단은 해제되었습니다.")));

  delete globalThis.fetch;
  delete globalThis.chrome;
}

// ── 11. 활동 점검 / 갤로그 ────────────────────────────────
console.log("\n[11] 명단 정리");
{
  const { parseBoardList, collectActivity, checkGallog } = await import("./dc.js");

  const notice = `<tr class="ub-content us-post" data-no="1" data-type="icon_notice">
    <td class="gall_writer ub-writer" data-nick="ㅇㅇ" data-uid="manager001" data-ip=""></td>
    <td class="gall_date" title="2025-09-07 10:00:00">25.09.07</td></tr>`;
  const ad = `<tr class="ub-content "><td class="gall_writer ub-writer" user_name="운영자"></td>
    <td class="gall_date">26/08/27</td></tr>`;
  const post = (no, uid, ip, stamp) => `<tr class="ub-content us-post" data-no="${no}" data-type="icon_txt">
    <td class="gall_writer ub-writer" data-nick="ㅇㅇ" data-uid="${uid}" data-ip="${ip}"></td>
    <td class="gall_date" title="${stamp}">시각</td></tr>`;
  const page = (rows) => `<table class="gall_list"><tbody>${rows.join("")}</tbody></table>`;

  const rows = parseBoardList(page([
    notice, ad,
    post(3, "aaa1111", "", "2026-09-07 17:00:00"),
    post(2, "", "220.85", "2026-09-07 16:00:00"),
  ]));
  eq("공지와 광고는 제외", rows.length, 2);
  // 공지는 매 페이지 붙박이다. 넣으면 완장이 늘 '활동 중'이고 날짜 판정도 망가진다.
  ok("공지 작성자는 안 들어감", !rows.some((r) => r.uid === "manager001"));
  eq("고닉 식별코드", rows[0].uid, "aaa1111");
  eq("유동은 uid 없음", rows[1].uid, "");
  eq("유동도 IP는 읽음", rows[1].ip, "220.85");
  eq("가장 오래된 글이 공지가 아님", rows[rows.length - 1].stamp, "2026-09-07 16:00:00");

  // 하루 100글 갤러리
  const PER = 100;
  let asked = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    asked.push(u.search);
    const pg = Number(u.searchParams.get("page") || 1);
    const d = new Date("2026-09-07T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - (pg - 1));
    const day = d.toISOString().slice(0, 10);
    const body = Array.from({ length: PER }, (_, k) =>
      pg <= 3 && k === 0
        ? post(9999, "veteran01", "", `${day} 12:00:00`)
        : post(90000 - pg * PER - k, `u${pg}_${k}`, "", `${day} 11:00:00`));
    return { ok: true, text: async () => page([notice, ...body]) };
  };

  const r = await collectActivity("gid", 2000, null, "2026-06-07");
  eq("3개월이면 94페이지", r.pages, 94);
  eq("날짜로 멈춤", r.reachedDate, true);
  eq("상한에 안 걸림", r.more, false);
  ok("한 페이지 100개로 요청", asked[0].includes("list_num=100"), asked[0]);
  // 게시판 목록은 'page'다. 차단 목록('p')과 다르다.
  ok("게시판은 page 파라미터", asked[1].includes("page=2"), asked[1]);
  eq("최근 글 날짜 기록", r.lastPost.get("veteran01"), "2026-09-07 12:00:00");
  ok("기준일 밖 사람은 없음", !r.lastPost.has("u200_0"));

  // page가 안 먹으면 판정을 남기면 안 된다
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => real(u.replace(/page=\d+/, "page=1"));
  const r2 = await collectActivity("gid", 100, null, "2026-06-07");
  eq("파라미터가 안 먹으면 감지", r2.repeated, true);
  eq("1페이지에서 멈춤", r2.pages, 1);

  // 갤로그. 2026-09-08 확인: 탈퇴한 계정은 404 + '삭제된 갤로그입니다' 본문이 온다.
  // 브라우저 주소창은 /_error/deleted 로 바뀌지만 그건 페이지가 스크립트로
  // 바꾸는 것이라 fetch 에는 안 잡힌다. 주소만 믿으면 탈퇴를 놓친다.
  // 2026-09-08 서비스워커 콘솔에서 실제로 받은 응답. 103바이트, 이게 전부다.
  // 브라우저에서 보이는 "삭제된 갤로그입니다" 문구는 여기 없다.
  // 그건 스크립트가 이동한 뒤의 페이지에 있고, fetch 는 스크립트를 안 돌린다.
  const DELETED_PAGE =
    `<script type="text/javascript">location.replace("https://gallog.dcinside.com/_error/deleted");</script>`;
  globalThis.fetch = async (u) => {
    if (u.includes("deadman")) {
      // 실제로 오는 형태: 404 + 삭제 안내 본문, 주소는 그대로
      return { ok: false, status: 404, url: u, text: async () => DELETED_PAGE };
    }
    // 주소가 바뀌어 오는 경우도 계속 잡아야 한다
    if (u.includes("redirected")) {
      return { ok: true, status: 200, url: "https://gallog.dcinside.com/_error/deleted", text: async () => "" };
    }
    // 없는 코드도 404지만 본문이 다르다 (2026-09-08 확인)
    if (u.includes("zzzz9999")) {
      return { ok: false, status: 404, url: u,
        text: async () => "404 Page Not Found\nThe page you requested was not found." };
    }
    if (u.includes("nocount")) {
      return { ok: true, status: 200, url: u, text: async () => "<html>갤로그입니다</html>" };
    }
    return { ok: true, status: 200, url: u, text: async () => GALLOG_HOME };
  };
  eq("살아있는 계정", (await checkGallog("apple8748")).state, "alive");
  eq("탈퇴한 계정 (404 + 안내 문구)", (await checkGallog("deadman1234")).state, "deleted");
  eq("주소가 바뀌는 경우도 탈퇴", (await checkGallog("redirected1")).state, "deleted");
  eq("없는 코드는 404", (await checkGallog("zzzz9999")).state, "notfound");
  // 비공개는 정상 응답이라 alive로 나온다. 그래야 멀쩡한 사람이 안 지워진다.
  eq("비공개도 alive", (await checkGallog("secret0001")).state, "alive");

  const live = await checkGallog("apple8748");
  eq("살아있으면 숫자도 같이 온다", live.counts.total, 361);
  eq("탈퇴는 숫자 없음", (await checkGallog("deadman1234")).counts, null);
  // 본문 없이 404만 오면 그건 탈퇴가 아니라 '모르겠다'다
  // 탈퇴와 없는 코드는 둘 다 404다. 본문으로만 갈린다.
  eq("없는 코드는 notfound", (await checkGallog("zzzz9999")).state, "notfound");
  ok("탈퇴와 없는 코드가 갈림",
     (await checkGallog("deadman1234")).state !== (await checkGallog("zzzz9999")).state);
  // 실제 응답은 103바이트다. 문구가 아니라 스크립트 안의 이동 주소로 잡는다.
  ok("실제 응답 크기 그대로", DELETED_PAGE.length < 130, String(DELETED_PAGE.length));
  ok("안내 문구는 본문에 없다", !/삭제된/.test(DELETED_PAGE));
  eq("숫자 못 읽어도 alive", (await checkGallog("nocount")).state, "alive");
  eq("못 읽으면 null (0이 아니다)", (await checkGallog("nocount")).counts, null);

  delete globalThis.fetch;
}

console.log("\n[12] 갤로그 글·댓글 수 (2026-09-08 실제 마크업)");
{
  const { parseGallogCounts } = await import("./dc.js");

  const c = parseGallogCounts(GALLOG_HOME);
  eq("게시글 수", c.posts, 29);
  eq("댓글 수", c.comments, 332);
  eq("스크랩 수", c.scraps, 2);
  eq("합계", c.total, 361);
  ok("방명록은 합계에 안 넣음", c.total === 29 + 332);

  // 비공개여도 숫자는 읽힌다. 이게 이 기능이 성립하는 근거다.
  ok("비공개 표시가 있는 화면", GALLOG_HOME.includes("비공개"));
  ok("목록은 비어 있는데도 읽힘", GALLOG_HOME.includes("게시글이 없습니다"));

  // 클래스가 늘어나도 읽혀야 한다
  const extra = GALLOG_HOME
    .replace(/class="tit"/g, 'class="tit on"')
    .replace(/class="num"/g, 'class="num big"');
  eq("클래스가 늘어도 읽음", parseGallogCounts(extra).total, 361);

  // 못 읽으면 0이 아니라 null이어야 한다. 0으로 읽으면 조용한 실패가 된다.
  eq("빈 화면은 null", parseGallogCounts("<html></html>"), null);
  eq("댓글만 있으면 null", parseGallogCounts(
    '<h2 class="tit">댓글<span class="num">(5)</span></h2>'), null);
  eq("빈 입력도 null", parseGallogCounts(""), null);

  // ⚠ 천 단위 쉼표. 2026-09-08 capture6180 갤로그에서 실제로 본 값이다.
  //   게시글(4,972)  댓글(9,288)  스크랩(0)  방명록(14)
  // v1.6.4는 스크랩·방명록만 잡고 게시글·댓글을 놓쳐서 null을 냈다.
  // 활동 많은 계정이 전부 여기 걸린다. 큰 갤에서는 그쪽이 다수다.
  const withComma = GALLOG_HOME
    .replace("(29)", "(4,972)")
    .replace("(332)", "(9,288)")
    .replace("(14)", "(14)");
  // null이 와도 뒤 검사가 예외로 죽지 않게 받아둔다. 죽으면 남은 검사가
  // 아예 안 돌아서 무엇이 깨졌는지 덜 보인다.
  const cc = parseGallogCounts(withComma) || {};
  ok("쉼표가 있어도 읽는다", parseGallogCounts(withComma) !== null, "null이 나왔다");
  eq("천 단위 게시글", cc.posts, 4972);
  eq("천 단위 댓글", cc.comments, 9288);
  eq("천 단위 합계", cc.total, 4972 + 9288);

  // 한쪽만 쉼표인 경우도 있다
  const mixed = parseGallogCounts(GALLOG_HOME.replace("(332)", "(1,004)")) || {};
  eq("한쪽만 쉼표", mixed.total, 29 + 1004);

  // 쉼표를 허용하면서 엉뚱한 걸 줍지 않는지
  eq("여전히 빈 화면은 null", parseGallogCounts("<html></html>"), null);


  // 왼쪽 메뉴의 '댓글' 링크를 숫자로 착각하면 안 된다
  const menu = `<li class="comment"><a href="/x/comment">댓글</a></li>` + GALLOG_HOME;
  eq("메뉴에 속지 않음", parseGallogCounts(menu).comments, 332);
}

// 변동 없음 판정. 숫자가 같으면 처음 본 시각을 유지하고, 바뀌면 다시 센다.
console.log("\n[13] 갤로그 변동 추적");
{
  const DAY = 24 * 3600 * 1000;
  const now = Date.now();
  const t = {};
  const record = (counts, at) => {
    if (t.gallogTotal !== counts.total) { t.gallogTotal = counts.total; t.gallogSince = at; }
  };

  record({ total: 361 }, now - 100 * DAY);
  eq("처음 기록", t.gallogSince, now - 100 * DAY);

  record({ total: 361 }, now - 50 * DAY);
  eq("같은 숫자면 시작 시각 유지", t.gallogSince, now - 100 * DAY);

  record({ total: 362 }, now - 10 * DAY);
  eq("숫자가 늘면 다시 셈", t.gallogSince, now - 10 * DAY);

  record({ total: 300 }, now);
  eq("숫자가 줄어도 변동으로 봄", t.gallogSince, now);
  ok("줄어든 것도 활동이라 명단에 남는다", t.gallogTotal === 300);
}


// ── 14. 명단 채우기: 해제된 사람 거르기 ─────────────────────
// 파딱 피드백(2026-09-08): 이미 차단이 해제된 사람이 섞여 나온다.
console.log("\n[14] 해제된 사람 거르기");
{
  // 같은 코드가 두 번 나오는 경우가 핵심이다. 목록은 최신순이라
  // 위쪽(해제됨)이 그 사람의 현재 상태다. 담기 전에 released를 거르면
  // 아래쪽의 옛 '차단 중' 행을 주워서 지금 차단 중인 것처럼 보이게 된다.
  const body = [
    row({ num: 4, dataNum: 401, nik: "ㅇㅇ", code: "aaa1111", state: "차단 중" }),
    row({ num: 3, dataNum: 402, nik: "ㅇㅇ", code: "bbb2222", state: "해제됨" }),
    row({ num: 2, dataNum: 403, nik: "ㅇㅇ", code: "ccc3333", state: "해제됨",
          date: "2026.09.05" }),
    row({ num: 1, dataNum: 404, nik: "ㅇㅇ", code: "ccc3333", state: "차단 중",
          date: "2026.08.20" }),
  ].join("");
  globalThis.fetch = async (url) => {
    const p = Number(new URL(url).searchParams.get("p") || 1);
    return { ok: true, text: async () => table([p === 1 ? body : ""]) };
  };

  let r = await collectByDuration("gid", "31일", 5);
  eq("기본은 차단 중인 사람만", r.items.length, 1);
  eq("남은 사람", r.items[0].code, "aaa1111");
  eq("걸러낸 인원을 알려줌", r.releasedSkipped, 2);
  ok("옛 차단 중 행을 줍지 않는다",
     !r.items.some((i) => i.code === "ccc3333"),
     JSON.stringify(r.items.map((i) => i.code)));

  r = await collectByDuration("gid", "31일", 5, null, "", true);
  eq("켜면 해제된 사람도 나옴", r.items.length, 3);
  eq("켰을 때는 걸러낸 게 없음", r.releasedSkipped, 0);
  eq("그때도 최신 행 기준", r.items.find((i) => i.code === "ccc3333").released, true);
  delete globalThis.fetch;
}

// ── 15. 요청 간격 흔들기 ────────────────────────────────────
// 2026-09-08 갤로그 300명을 400ms 고정 간격으로 돌린 뒤 IP가 막혔다.
// 일정한 간격 자체가 사람이 만들 수 없는 신호다.
console.log("\n[15] 요청 간격");
{
  const vals = Array.from({ length: 400 }, () => jitter(1000));
  ok("아래로 안 벗어남", Math.min(...vals) >= 600, `${Math.min(...vals)}`);
  ok("위로 안 벗어남", Math.max(...vals) <= 1400, `${Math.max(...vals)}`);
  ok("값이 실제로 흔들린다", new Set(vals).size > 50, `${new Set(vals).size}가지`);

  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  ok("평균은 기준값 근처", Math.abs(avg - 1000) < 60, `${Math.round(avg)}`);

  // spread=0 이면 흔들지 않는다. 간격을 고정하고 싶을 때 쓸 수 있어야 한다.
  eq("흔들림 0이면 그대로", jitter(800, 0), 800);

  // 갤로그 간격이 사고 당시(400ms)보다 확실히 느려야 한다.
  ok("갤로그 간격이 400ms보다 느림", GALLOG_DELAY_MS > 400, `${GALLOG_DELAY_MS}`);

  // 정기 확인도 한 명당 한 요청이라 같은 기준을 받는다.
  ok("정기 확인 간격이 400ms보다 느림", CHECK_DELAY_MS > 400, `${CHECK_DELAY_MS}`);

  // 상수만 검사하면 background.js가 다시 리터럴로 돌아가도 통과한다.
  // v1.6.5까지 실제로 그 상태였다 — 상수는 1200인데 루프는 400을 쓰고 있었다.
  // 그래서 원본을 읽어 '난수를 안 거친 대기'가 남아 있는지 직접 본다.
  const bgSrc = readFileSync(new URL("./background.js", import.meta.url), "utf8");
  const waits = bgSrc.match(/setTimeout\(\s*r\s*,[^)]*\)/g) || [];
  ok("대기가 실제로 있다", waits.length >= 2, `${waits.length}개`);
  ok(
    "background.js에 고정 간격 대기가 없다",
    waits.every((w) => /jitter\(/.test(w)),
    waits.filter((w) => !/jitter\(/.test(w)).join(" / ") || "전부 난수"
  );

  // 설정 화면이 '조회 한 명당 0.4초'라고 설명한 채로 간격만 1.2초로 올린 적이
  // 있다. 완장은 그 문구를 보고 기다릴 시간을 가늠하므로 어긋나면 안 된다.
  const popupHtml = readFileSync(new URL("./popup.html", import.meta.url), "utf8");
  const shown = popupHtml.match(/조회 한 명당 ([\d.]+)초/);
  ok("설정 화면에 조회 속도 설명이 있다", !!shown, shown ? shown[1] : "없음");
  if (shown) {
    ok(
      "설명한 조회 속도가 실제 간격과 같다",
      Number(shown[1]) === CHECK_DELAY_MS / 1000,
      `화면 ${shown[1]}초 / 실제 ${CHECK_DELAY_MS / 1000}초`
    );
  }

  // 같은 것을 식별자·식별 코드·식별코드 세 가지로 부르던 것을 하나로 모았다.
  const strayTerms = (popupHtml.match(/식별자|식별 코드/g) || []);
  ok("식별코드 표기가 하나로 통일돼 있다", strayTerms.length === 0,
     strayTerms.join(", ") || "통일됨");

  // 탭과 화면이 짝이 맞아야 한다. 이름만 바꾸고 화면을 안 만들면 빈 탭이 된다.
  const tabKeys = [...popupHtml.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  const segKeys = [...popupHtml.matchAll(/data-seg="([^"]+)"/g)].map((m) => m[1]);
  ok("탭이 4개다", tabKeys.length === 4, tabKeys.join(", "));
  ok("갈래가 3개다", segKeys.length === 3, segKeys.join(", "));
  ok(
    "모든 탭·갈래에 짝이 되는 화면이 있다",
    [...tabKeys, ...segKeys].every((k) => popupHtml.includes(`id="tab-${k}"`)),
    [...tabKeys, ...segKeys].filter((k) => !popupHtml.includes(`id="tab-${k}"`)).join(", ") || "전부 있음"
  );
  ok("연속 실패 상한이 있다", GALLOG_FAIL_STREAK > 0 && GALLOG_FAIL_STREAK <= 10,
     `${GALLOG_FAIL_STREAK}`);
}


// ── 16. 안 본 사람의 판정을 남기는가 ────────────────────────
// runCheck가 후보·수동해제 목록을 통째로 덮어써서, 이번에 조회하지 않은
// 사람의 판정이 조용히 사라지던 문제.
console.log("\n[16] 판정 이어가기");
{
  const watched = new Set(["aaa1111", "bbb2222", "ccc3333"]);

  // manual 판정은 7일 뒤에 다시 본다. 그래서 다음 조회 대상에서 빠지는데,
  // 그때 목록이 비면 '명단에서 빼기' 버튼까지 같이 사라진다.
  const prevManual = [{ code: "bbb2222" }, { code: "ccc3333" }];
  const kept = carryOver(prevManual, new Set(["aaa1111"]), watched);
  eq("안 본 사람은 남는다", kept.length, 2);

  // 이번에 다시 본 사람은 새 판정으로 갈아끼워야 하므로 남기지 않는다
  eq("이번에 본 사람은 뺀다",
     carryOver(prevManual, new Set(["bbb2222"]), watched).length, 1);

  // 명단에서 빠졌거나 중지된 사람은 되살리지 않는다. 사용자가 뺀 것이다.
  eq("명단에 없으면 안 남긴다",
     carryOver(prevManual, new Set(), new Set(["aaa1111"])).length, 0);

  // 하루 한도에 걸려 못 보낸 후보도 같은 장치로 살아남는다
  const leftover = [{ code: "ccc3333", reason: "음란성" }];
  const c = carryOver(leftover, new Set(["aaa1111", "bbb2222"]), watched);
  eq("한도로 남은 후보 유지", c.length, 1);
  eq("내용이 그대로", c[0].reason, "음란성");

  // 방어: 빈 값이나 code 없는 항목에 죽지 않아야 한다
  eq("빈 목록", carryOver(undefined, new Set(), watched).length, 0);
  eq("code 없는 항목은 버림",
     carryOver([{ nick: "ㅇㅇ" }, null], new Set(), watched).length, 0);
}

// ── [18] 직접 입력 사유 ────────────────────────────────────
// 디시 차단 창은 라디오 7개 + '직접 입력'이다. 완장들은 직접 입력을 주로 쓴다.
// 예전 코드는 모르는 사유면 던져서, 파딱 갤 명단 4533명(전원 직접 입력 사유)이
// 한 명도 재차단되지 않았을 것이다. 실제 요청으로 avoid_reason=0 을 확인했다.
{
  console.log("\n[18] 직접 입력 사유");
  const known = reasonFields("광고");
  eq("아는 사유는 번호로", known.value, REASON_VALUES["광고"]);
  eq("아는 사유는 txt 비움", known.txt, "");
  ok("아는 사유는 직접 입력 아님", known.custom === false);

  const custom = reasonFields("벌레");
  eq("모르는 사유는 0", custom.value, CUSTOM_REASON);
  eq("모르는 사유는 원문을 txt로", custom.txt, "벌레");
  ok("모르는 사유는 직접 입력", custom.custom === true);
  ok("안 잘림", custom.cut === false);

  // 파딱 갤에서 가장 긴 사유가 정확히 20자였다. 경계에서 안 잘려야 한다.
  const edge = "한생갤에 글 쓰려다 착오한 구맘인 듯";
  eq("20자 사유 길이 확인", [...edge].length, REASON_TXT_MAX);
  eq("20자는 그대로", reasonFields(edge).txt, edge);
  ok("20자는 안 잘림", reasonFields(edge).cut === false);

  const long = "가".repeat(25);
  eq("20자 넘으면 자름", [...reasonFields(long).txt].length, REASON_TXT_MAX);
  ok("잘렸다고 알려줌", reasonFields(long).cut === true);

  eq("앞뒤 공백은 버림", reasonFields("  벌레  ").txt, "벌레");
  ok("빈 사유는 거절", (() => {
    try { reasonFields("   "); return false; } catch { return true; }
  })());

  // 화면과 코드가 같은 한도를 봐야 한다. popup.js 는 dc.js 를 가져오지 않는다.
  const pjs = readFileSync(new URL("./popup.js", import.meta.url), "utf8");
  const m = pjs.match(/REASON_TXT_MAX\s*=\s*(\d+)/);
  ok("popup.js 한도가 dc.js와 같다", m && Number(m[1]) === REASON_TXT_MAX,
     m ? `popup ${m[1]} / dc ${REASON_TXT_MAX}` : "popup.js에 없음");
}

// ── [19] 갤로그 점검 대상 고르기 ──────────────────────────
// 명단 4533명을 매번 다 도는 건 두 시간짜리다. 기준점을 잰 지 기간이
// 안 지난 사람은 지금 다시 재도 판정이 안 나오므로 볼 필요가 없다.
// background.js가 쓰는 그 함수를 그대로 부른다.
{
  console.log("\n[19] 갤로그 점검 대상 고르기");
  const HOUR = 3600 * 1000, DAY = 24 * HOUR;
  const now = Date.now();
  const C = (value, extra = {}) => ({ kind: "code", value, ...extra });

  const list = [
    C("never"),                                                     // 한 번도 안 잼
    C("old",    { gallogCountedAt: now - 100 * DAY, gallogCheckedAt: now - 100 * DAY }),
    C("recent", { gallogCountedAt: now - 30 * DAY,  gallogCheckedAt: now - 30 * DAY }),
    C("justnow",{ gallogCountedAt: now - HOUR,      gallogCheckedAt: now - HOUR }),
    C("gone",   { gallogState: "deleted" }),
    { kind: "ip", value: "1.2.3.4" },
  ];
  const names = (r) => r.targets.map((t) => t.value);

  const r3 = pickGallogTargets(list, { now, months: 3, limit: 50 });
  ok("한 번도 안 잰 사람이 먼저", names(r3)[0] === "never", names(r3).join(","));
  ok("기준점이 낡은 사람은 본다", names(r3).includes("old"), names(r3).join(","));
  ok("기간 안에 잰 사람은 건너뛴다", !names(r3).includes("recent"), names(r3).join(","));
  ok("12시간 안에 본 사람은 건너뛴다", !names(r3).includes("justnow"), names(r3).join(","));
  ok("탈퇴 확인된 사람은 안 본다", !names(r3).includes("gone"), names(r3).join(","));
  ok("IP는 갤로그가 없다", !names(r3).includes("1.2.3.4"), names(r3).join(","));
  eq("건너뛴 이유를 센다 — 방금 본 사람", r3.fresh.length, 1);
  eq("건너뛴 이유를 센다 — 아직 이른 사람", r3.tooSoon.length, 1);

  // 기간을 넓히면 볼 사람이 줄어야 한다. 이게 파딱이 말한 부담 줄이기다.
  eq("3개월 기준 대상 수", r3.targets.length, 2);
  eq("12개월 기준 대상 수", pickGallogTargets(list, { now, months: 12, limit: 50 }).targets.length, 1);

  // 기간을 0으로 주면(담으면서 미리 기록) 기간 규칙은 안 쓴다.
  const r0 = pickGallogTargets(list, { now, months: 0, limit: 50 });
  ok("기간 0이면 기간 규칙 없음", names(r0).includes("recent"), names(r0).join(","));

  const cut = pickGallogTargets(list, { now, months: 3, limit: 1 });
  eq("상한을 넘지 않는다", cut.targets.length, 1);
  eq("남은 사람을 센다", cut.waiting, 1);

  // 채우기에서 방금 담은 사람만 미리 기록할 때 쓴다.
  const only = pickGallogTargets(list, { now, months: 0, limit: 50, onlyCodes: ["old"] });
  eq("지정한 사람만", names(only).join(","), "old");
}

// ── [20] 로그인이 풀렸을 때도 셀 수 있는 것 ────────────────
// 차단 목록을 못 읽어도 만료 예정 시각은 명단에 저장돼 있다.
{
  console.log("\n[20] 로그인 없이 아는 것");
  const now = Date.now();
  const wl = [
    { value: "a", nextCheckAt: now - 1000 },      // 지났다
    { value: "b", nextCheckAt: now + 86400000 },  // 아직
    { value: "c", nextCheckAt: 0 },               // 예약 없음
    { value: "d", nextCheckAt: now - 99999 },     // 지났다
  ];
  const waiting = wl.filter((t) => t.nextCheckAt && now >= t.nextCheckAt).length;
  eq("만료 예정 시각이 지난 사람 수", waiting, 2);
}

// ── [21] 예상 시간과 봐야 할 사람 세기 ─────────────────────
// 2026-09-10 파딱 실측에서 드러난 두 가지.
{
  console.log("\n[21] 예상 시간과 봐야 할 사람 세기");

  // ① 로그인이 풀렸을 때 '봐야 할 사람'을 세는 기준이, 위에서 대상을 고르는
  //    기준과 같아야 한다. 명단 채우기로 담은 사람은 nextCheckAt이 0인데
  //    예전 코드는 0을 falsy로 걸러내서 4575명이 한 명도 안 세어졌다.
  const now = Date.now();
  const wl = [
    { value: "a", nextCheckAt: now - 1000 },      // 만료 시각 지남
    { value: "b", nextCheckAt: now + 86400000 },  // 아직
    { value: "c", nextCheckAt: 0 },               // 담기만 하고 못 봄
    { value: "d" },                               // 칸 자체가 없음
  ];
  const due = wl.filter((t) => !t.nextCheckAt || now >= t.nextCheckAt);
  eq("봐야 할 사람 수", due.length, 3);
  eq("그중 만료 시각이 지난 사람", due.filter((t) => t.nextCheckAt).length, 1);
  eq("그중 한 번도 못 본 사람", due.filter((t) => !t.nextCheckAt).length, 2);

  // ② 예상 시간은 간격만이 아니라 조회 시간까지 더해야 한다.
  //    '6분쯤'이라 해놓고 8~9분이 걸리면 완장은 멈춘 줄 안다.
  const perOne = CHECK_DELAY_MS / 1000 + FETCH_SECS;
  ok("한 명당 시간이 간격보다 크다", perOne > CHECK_DELAY_MS / 1000, `${perOne}초`);
  const mins = Math.ceil((300 * perOne) / 60);
  ok("300명이면 6분보다 넉넉하다", mins > 6, `${mins}분`);

  // 화면 문구와 팝업 계산이 같은 값을 봐야 한다.
  const pjs = readFileSync(new URL("./popup.js", import.meta.url), "utf8");
  const m = pjs.match(/n \* \(([\d.]+) \+ ([\d.]+)\)/);
  ok("팝업 계산이 dc.js와 같다",
     m && Number(m[1]) === CHECK_DELAY_MS / 1000 && Number(m[2]) === FETCH_SECS,
     m ? `팝업 ${m[1]}+${m[2]} / dc ${CHECK_DELAY_MS / 1000}+${FETCH_SECS}` : "팝업에 없음");
}

// ── [22] 갤로그 기록 합치기 ────────────────────────────────
// 완장이 여럿이면 같은 사람을 각자 조회하게 된다. 한 명이 한 바퀴 돌고 파일로
// 넘기면 나머지는 조회 0번으로 기준점을 얻는다 (파딱 제안 2026-09-10).
// 규칙을 잘못 짜서 최신으로 덮으면, 공유할수록 기준점이 뒤로 밀려서
// 아무도 판정을 못 받게 된다. 그 반대인지를 여기서 본다.
{
  console.log("\n[22] 갤로그 기록 합치기");
  const DAY = 86400000, now = Date.now();
  const at = (d) => now - d * DAY;

  // 나한테 기록이 없으면 남의 것을 그대로 받는다.
  const got = mergeGallog(null, { gallogTotal: 100, gallogSince: at(90), gallogCountedAt: at(1) });
  eq("없으면 그대로 받는다", got && got.gallogTotal, 100);
  eq("받은 이유", got.why, "new");

  // 숫자가 같으면 창이 넓어져야 한다 — 처음 본 시각은 이른 쪽.
  const mine = { gallogTotal: 100, gallogSince: at(10), gallogCountedAt: at(1) };
  const theirs = { gallogTotal: 100, gallogSince: at(90), gallogCountedAt: at(30) };
  const w = mergeGallog(mine, theirs);
  eq("처음 본 시각은 이른 쪽", w.gallogSince, at(90));
  eq("마지막으로 잰 시각은 늦은 쪽", w.gallogCountedAt, at(1));
  eq("넓힌 이유", w.why, "widen");

  // 이게 핵심이다. 넓히기 전에는 3개월 판정이 안 나오고, 넓히면 나온다.
  const qualifies = (x) => now - x.gallogSince >= 90 * DAY;
  ok("합치기 전에는 판정 안 됨", !qualifies(mine));
  ok("합치고 나면 판정 됨", qualifies(w));

  // 숫자가 다르면 그 사이에 글을 쓴 것이다. 오래된 관측은 무효다.
  const changed = mergeGallog(
    { gallogTotal: 100, gallogSince: at(90), gallogCountedAt: at(30) },
    { gallogTotal: 137, gallogSince: at(5), gallogCountedAt: at(1) }
  );
  eq("숫자가 다르면 늦은 쪽으로", changed.gallogTotal, 137);
  eq("바꾼 이유", changed.why, "replace");

  // 남의 것이 더 낡았고 숫자도 다르면 무시한다.
  ok("낡고 어긋난 기록은 무시", mergeGallog(
    { gallogTotal: 137, gallogSince: at(5), gallogCountedAt: at(1) },
    { gallogTotal: 100, gallogSince: at(90), gallogCountedAt: at(30) }
  ) === null);

  // 더 나아지지 않으면 굳이 건드리지 않는다.
  ok("나아질 게 없으면 그대로", mergeGallog(mine, mine) === null);

  // 기록이 없는 항목(옛 형식 파일)은 아무것도 주지 않는다.
  ok("갤로그 칸 없는 파일은 무시", mergeGallog(mine, { code: "x", reason: "벌레" }) === null);
  ok("잰 적 없는 기록은 무시", mergeGallog(mine, { gallogTotal: 5, gallogCountedAt: 0 }) === null);
}

// ── [17] 설정 화면에 적힌 기본값 ──────────────────────────
// 화면에 '기본값: 300'이라고 적어놓고 코드가 다른 값을 쓰면, 완장은 건드리지
// 않은 값이 뭔지 알 수 없게 된다. 문구와 코드가 어긋나면 실패한다.
{
  console.log("\n[17] 설정 화면의 기본값 표시");
  const html = readFileSync(new URL("./popup.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("./popup.js", import.meta.url), "utf8");
  const shownFor = (id) => {
    const at = html.indexOf(`id="${id}"`);
    const end = html.indexOf("</label>", at);
    const m = html.slice(at, end).match(/기본값:\s*(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const codeFor = (key) => {
    const m = js.match(new RegExp(`${key}:\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  for (const [id, key] of [
    ["cfgMax", "maxPerRun"],
    ["cfgChecks", "maxChecksPerRun"],
    ["cfgSweep", "sweepPerRun"],
  ]) {
    const shown = shownFor(id), real = codeFor(key);
    ok(`${key} 기본값 표시가 코드와 같다`, shown !== null && shown === real,
       `화면 ${shown} / 코드 ${real}`);
  }
}


// ── 로그인이 풀렸을 때 ──────────────────────────────────────
// 2026-09-09 실측. 로그아웃 상태로 관리 화면을 부르면 디시는 안내 문구가 아니라
// 87바이트짜리 스크립트 한 줄을 준다. 한글이 한 글자도 없다.
// 예전 코드는 /로그인/ 을 찾았는데 본문에 그 글자가 없어서 절대 안 걸렸고,
// 그래서 "매니저 권한이 있는 갤러리인지 확인하세요"가 떴다.
// 완장은 자기 권한이 날아간 줄 알고 엉뚱한 곳을 본다.
console.log("\n[로그인 풀림 감지]");
{
  // 실물과 같은 모양 (경로는 바뀔 수 있으므로 구조만 흉내낸다)
  const STUB = '<script>location.replace("/");</script>';
  ok("실물 크기대로 짧다", STUB.length < 500);
  ok("한글이 없다", !/[가-힣]/.test(STUB));

  const call = async (html) => {
    globalThis.fetch = async () => ({ ok: true, text: async () => html });
    try { await fetchRowsForCode("gid", "capture6180"); return "성공"; }
    catch (e) { return e.message; }
    finally { delete globalThis.fetch; }
  };

  ok("로그인 풀림이라고 말한다",
     /로그인이 풀린/.test(await call(STUB)), await call(STUB));
  ok("권한 탓으로 돌리지 않는다",
     !/매니저 권한/.test(await call(STUB)), await call(STUB));

  // 로그인 화면을 통째로 주는 경우도 여전히 잡아야 한다
  ok("로그인 화면도 잡는다",
     /로그인이 풀린/.test(await call("<html><body>로그인 해주세요</body></html>")));

  // 진짜 권한 문제는 권한 문제라고 해야 한다. 여기까지 로그인 탓으로
  // 돌리면 반대 방향으로 잘못 짚게 된다.
  const noPerm = "<html><body>" + "권한이 없습니다. ".repeat(60) + "로그아웃</body></html>";
  ok("권한 문제는 권한 문제로", /매니저 권한/.test(await call(noPerm)), await call(noPerm));

  // 정상 응답은 그대로 파싱돼야 한다
  const good = await (async () => {
    globalThis.fetch = async () => ({ ok: true, text: async () =>
      table([row({ nik: "ㅇㅇ", code: "chip3298" })]) });
    try { return (await fetchRowsForCode("gid", "chip3298")).length; }
    finally { delete globalThis.fetch; }
  })();
  eq("정상 목록은 그대로 읽는다", good, 1);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
