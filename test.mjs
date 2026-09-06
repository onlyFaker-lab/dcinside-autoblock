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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
