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
} from "./dc.js";

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
        (_, k) => row({ num: total - s - k, dataNum: 90000 + s + k, nik: "ㅇㅇ", code: `c${s + k}` })
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
      row({ num: k, dataNum: p * 1000 + k, nik: "ㅇㅇ", code: `p${p}c${k}`, date: dayOf(p) })
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
