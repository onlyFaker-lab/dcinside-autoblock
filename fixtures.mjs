// fixtures.mjs — 검사에서 같이 쓰는 실제 마크업 픽스처.
//
// 지어낸 마크업이 아니라 2026-09-06 실제 관리 화면에서 복사한 것이다.
// 닉과 코드가 빈 <p></p> 껍데기에 싸여 있고, 셀 안에 jQuery 템플릿 <script>가
// 들어 있으며, 처리 시각은 display:none 안에 숨어 있다. 상태 칸 클래스는
// "blockstate txtbtn"이다. 전부 실제 화면 그대로다.
//
// test.mjs 와 test-bg.mjs 가 같이 쓴다. 양쪽에 따로 적어두면 한쪽만 고쳤을 때
// 어긋나는데 검사는 둘 다 통과한다. 이 프로젝트에서 두 번 난 실수다.

export function row({ num = 1, dataNum = 13799443, nik, code, state = "해제됨",
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

export const table = (rows) => `<table class="minor_block_list">
		  <caption>차단 리스트</caption>
		  <thead><tr><th scope="col">번호</th></tr></thead>
		  <tbody>${rows.join("")}</tbody>
		</table>`;


// ── 갤로그 화면 ──────────────────────────────────────────────
// 2026-09-15 파딱이 보낸 실제 갤로그 소스(방문자·방명록)와,
// 2026-09-16 게시글이 공개인 계정의 실제 소스에서 그대로 떼어왔다.
// class="total_num " 의 뒤쪽 공백, "2/" 의 슬래시, onclick 이 낀 h2 까지 실물 그대로다.
// 지어낸 마크업으로 바꾸지 말 것.

export function gallogPage({
  posts = 590, comments = "1,096", scraps = 1,
  today = 2, total = 200,
  guestbook = ["2026.09.15", "2026.09.01"],
  // 게시글·댓글 목록에 뜨는 날짜(최신순). 비면 "게시글이 없습니다" 가 나온다.
  // 게시글이 공개면 여기에도 class="date" 가 나온다. 구역을 안 나누면
  // 이걸 방명록 날짜로 착각한다. 그 함정을 재현하는 자리다.
  postDates = [], commentDates = [],
  // 공개/비공개 배지. 비공개면 목록이 아예 안 나온다.
  // ⚠ "못 본 것"과 "활동이 없는 것"은 다르다. 배지로만 갈린다.
  postsVisible = true, commentsVisible = true,
  // 홈 화면에도 잠김 문구가 나오는 경우. 나오면 방명록 페이지를 따로 안 봐도 된다.
  guestClosedOnHome = false,
} = {}) {
  const badge = (v) =>
    v ? `<span class="bluebox">공개</span>` : `<span class="greybox">비공개</span>`;
  const head = (label, n, href, v) =>
    `<header><div class="cont_head clear">
    <h2 class="tit" onclick="location.href='/because8084/${href}';" style="cursor:pointer">${label}<span class="num">(${n})</span></h2>
    ${v === null ? "" : badge(v)}
  </div></header>`;
  const empty = (what) => `<div class="gallog_empty small">${what}에 글이 없습니다. </div>`;
  const postLi = (d, i) =>
    `<li class="" data-no="${1234 - i}">
    <div class="cont"><div class="gall_linkbox">
      <a class="link " href="https://gall.dcinside.com/mgallery/board/view?id=t1win&no=1263625" target="_blank">
        <div class="galltit"><strong>탑은 몰라도 정폿든 데리고 갈 것 같다</strong><span class="comment_num">[12]</span></div>
        <div class="nameday "><span class="gall_name">티원 응원<em class="icon_minor">ⓜ</em></span>
          <span class="date">${d}</span>
        </div>
      </a>
    </div></div>
  </li>`;
  const cmtLi = (d, i) =>
    `<li class="replys" data-no="${1235 - i}">
    <div class="cont"><div class="gall_linkbox">
      <a class="link " href="https://gall.dcinside.com/mgallery/board/view?id=t1win&no=1263625" target="_blank">
        <p class="txt">그건 신규계약만 그런거고 이전계약은 그대로 유지됨</p>
        <div class="nameday "><span class="gall_name">티원 응원<em class="icon_minor">ⓜ</em></span>
          <span class="date">${d}</span>
        </div>
        <div class="galltit"><strong>셀캡 개정으로</strong></div>
      </a>
    </div></div>
  </li>`;
  const gstLi = (d) =>
    `<li><div class="cont"><div class="gall_linkbox"><div  class="link">
      <div class="galltit"><strong>9월 중순 잘 보내라</strong></div>
      <div class="nameday"><span class="writer_info">
        <em class='nickname in' title='김해송' >김해송</em>
        <span class="date">${d}</span>
      </span></div>
    </div></div></div></li>`;
  const list = (items, li, what, visible) => {
    if (!visible) return "";
    return items.length
      ? `<ul class="cont_listbox">${items.map(li).join("")}</ul>`
      : empty(what);
  };

  return `<div class="tright_box clear">
  <div class="visitors_num rbox">
    <span class="today_num">오늘의 방문자<em class="today_num">${today}/</em><em class="total_num ">${total}</em></span>
  </div>
</div>
<section><div class="gallog_cont">
  ${head("게시글", posts, "posting", postsVisible)}
  <div class="cont_box">${list(postDates, postLi, "게시글", postsVisible)}</div>
</div></section>
<section><div class="gallog_cont comments">
  ${head("댓글", comments, "comment", commentsVisible)}
  <div class="cont_box">${list(commentDates, cmtLi, "댓글", commentsVisible)}</div>
</div></section>
<section><div class="gallog_cont scraps">
  ${head("스크랩", scraps, "scrap", false)}
  <div class="cont_box">${empty("스크랩")}</div>
</div></section>
<section><div class="gallog_cont gstbook">
  ${head("방명록", guestbook.length, "guestbook", null)}
  <div class="cont_box">
  ${guestClosedOnHome ? `<p>허용된 사용자만 방명록을 작성할 수 있습니다.</p>` : ""}
  ${guestbook.length ? `<ul class="cont_listbox">${guestbook.map(gstLi).join("")}</ul>` : empty("방명록")}
  </div>
</div></section>`;
}
