'use strict';
// 수업 모드 — 수강생별로 재생한 문장 + 오류를 lesson-manager에 기록.
// 모든 쓰기는 /api/lesson (서버함수)를 거치며, 서비스키·비밀번호는 서버에만 있음.

const LESSON_TAGS = ['발음', '어순', '시제', '어휘', '관사/전치사', '유창성'];
const lesson = {
  active: false, passcode: '', auth: null, sheetId: null,
  studentName: '', courseId: '', teacherId: '', date: '',
  logged: {},        // sentence_id -> [tags]
  current: null,     // 현재 문장
  // 세션 자동 기록 (수업 모드에서만 수집)
  logId: null, t0: 0, queue: [], flushTimer: null, flushing: false,
  curSid: null, enterAt: 0,
};

// ── 세션 자동 기록 ──
// 이벤트 5종 고정(enter/leave/play/repeat/reveal). 메모리 적재 → 30초/50개마다
// 일괄 전송, 종료 시 잔여 일괄, 창 닫힘은 sendBeacon. UI를 절대 기다리게 하지 않는다.

const LOG_FLUSH_MS = 30000, LOG_FLUSH_N = 50;

function lessonTrack(type, sid, extra) {
  if (!lesson.active || !lesson.logId) return;
  lesson.lastActivity = Date.now();
  const ev = Object.assign({ t: Math.round((Date.now() - lesson.t0) / 100) / 10, type, sid }, extra || {});
  lesson.queue.push(ev);
  if (lesson.queue.length >= LOG_FLUSH_N) lessonFlush();
}

async function lessonFlush(endAction) {
  if (lesson.flushing || !lesson.logId) return;
  if (!endAction && lesson.queue.length === 0) return;
  const batch = lesson.queue.splice(0);
  lesson.flushing = true;
  try {
    await lessonApi(endAction || 'session_events', { log_id: lesson.logId, events: batch });
  } catch (e) {
    lesson.queue = batch.concat(lesson.queue);   // 실패 시 되돌려 다음 주기에 재시도
    console.error('session log flush failed', e);
  } finally {
    lesson.flushing = false;
  }
}

async function lessonLogStart() {
  try {
    const data = await lessonApi('session_start', { sheet_id: lesson.sheetId });
    lesson.logId = data.log_id;
    lesson.t0 = Date.now();
    lesson.queue = [];
    lesson.curSid = null;
    lesson.flushTimer = setInterval(() => lessonFlush(), LOG_FLUSH_MS);
  } catch (e) {
    console.error('session log start failed', e);   // 기록 실패가 수업을 막지 않는다
  }
}

function lessonLeaveCurrent() {
  if (lesson.curSid) {
    lessonTrack('leave', lesson.curSid, { dwell: Math.round((Date.now() - lesson.enterAt) / 100) / 10 });
    lesson.curSid = null;
  }
}

function lessonLogEnd(useBeacon) {
  if (!lesson.logId) return;
  lessonLeaveCurrent();
  if (lesson.flushTimer) { clearInterval(lesson.flushTimer); lesson.flushTimer = null; }
  const batch = lesson.queue.splice(0);
  if (useBeacon && navigator.sendBeacon) {
    // 창이 닫히는 중 — fetch는 취소될 수 있으니 beacon으로 보낸다
    const body = JSON.stringify(Object.assign(
      { action: 'session_end', log_id: lesson.logId, events: batch },
      lesson.auth ? { auth: lesson.auth } : { passcode: lesson.passcode }));
    navigator.sendBeacon('/api/lesson', new Blob([body], { type: 'application/json' }));
  } else {
    lessonApi('session_end', { log_id: lesson.logId, events: batch })
      .catch(e => console.error('session log end failed', e));
  }
  lesson.logId = null;
}

window.addEventListener('pagehide', () => { if (lesson.active) lessonLogEnd(true); });

// app.js가 부르는 훅들 (수업 모드가 아닐 땐 lessonTrack이 무시한다)
window.lessonOnPlay   = s => lessonTrack('play', s.id);
window.lessonOnRepeat = s => lessonTrack('repeat', s.id);
window.lessonOnReveal = s => lessonTrack('reveal', s.id);

async function lessonApi(action, extra) {
  const cred = lesson.auth ? { auth: lesson.auth } : { passcode: lesson.passcode };
  const res = await fetch('/api/lesson', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action }, cred, extra || {})),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('오류 ' + res.status));
  return data;
}

/** 발표(lesson-manager)에서 넘어온 핸드오프 컨텍스트 — 5종 전부 있어야 유효 */
function lessonHandoffParams() {
  const q = new URLSearchParams(location.search);
  const course = q.get('course'), date = q.get('date'), sheet = q.get('sheet');
  const exp = q.get('exp'), token = q.get('lmtoken');
  if (!course || !date || !sheet || !exp || !token) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { course, date, sheet, exp, token };
}

// ── 진입 (2026-07-27 개편: 수동 토글 폐지 — 수업모드는 발표 핸드오프로만) ──
// 복원 방법: 아래 lessonInit에서 lessonHandoffEnter() 대신 예전 런처 버튼 생성 +
// lessonOpenSetup 연결을 되살리면 비밀번호 경로(API 존치)로 그대로 동작한다.
function lessonInit() {
  const p = lessonHandoffParams();
  if (p) lessonHandoffEnter(p);
  // 파라미터 없음/불완전 → 일반 모드 (수업모드 진입 수단 없음, 기록 0건)
}

async function lessonHandoffEnter(p) {
  lesson.auth = p;
  try {
    const data = await lessonApi('handoff', {});
    lesson.sheetId = data.sheet_id;
    lesson.logged = data.logged || {};
    lesson.studentName = data.student_name;
    lesson.courseId = p.course; lesson.date = p.date;
    lesson.active = true;
    lessonShowBanner();
    lessonShowBar();
    lessonLogStart();
    lessonIdleWatchStart();
    if (lesson.current) lessonOnSentence(lesson.current);
  } catch (e) {
    // 토큰 위조·만료·컨텍스트 불일치 → 수업모드 거부, 일반 모드 폴백
    lesson.auth = null;
    lessonToast('수업 연결이 유효하지 않아 일반 모드로 열렸습니다.');
    console.warn('lesson handoff rejected:', e.message);
  }
}

function lessonToast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:990;background:#7F1D1D;color:#fff;padding:8px 16px;border-radius:999px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.25)';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

// ── 상단 상시 배너: 지금 기록되고 있음을 항상 보이게 ──
function lessonShowBanner() {
  if (lesson.banner) lesson.banner.remove();
  const [, m, d] = lesson.date.split('-').map(Number);
  const b = document.createElement('div');
  b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:920;background:#1E3A8A;color:#fff;padding:7px 16px;font-size:13px;display:flex;align-items:center;justify-content:center;gap:10px;box-shadow:0 2px 8px rgba(0,0,0,.2)';
  b.innerHTML = `<span>🔴 <b>${lesson.studentName}</b> · ${m}/${d} 수업 기록 중</span>
    <button id="lm-banner-end" style="padding:3px 12px;border:1px solid rgba(255,255,255,.4);border-radius:999px;background:transparent;color:#fff;font-size:12px;cursor:pointer">종료</button>`;
  document.body.appendChild(b);
  document.body.style.paddingTop = '38px';
  lesson.banner = b;
  b.querySelector('#lm-banner-end').onclick = lessonEnd;
}

// ── 유휴 자동 종료 (디렉터 승인: 120분 무활동 + 종료 1분 전 경고) ──
// 실수업 90분 + 간헐 사용 특성 반영 — 수업 도중 조용한 종료(기록 누락)를 막는다.
// 어떤 조작(클릭·터치·키)이든 활동으로 간주해 타이머를 되돌린다.
const IDLE_LIMIT_MS = 120 * 60 * 1000;
const IDLE_WARN_MS  = IDLE_LIMIT_MS - 60 * 1000;   // 종료 1분 전 경고

function lessonMarkActivity() {
  lesson.lastActivity = Date.now();
  if (lesson.idleWarn) { lesson.idleWarn.remove(); lesson.idleWarn = null; }
}

function lessonIdleWatchStart() {
  lesson.lastActivity = Date.now();
  const mark = () => { if (lesson.active) lessonMarkActivity(); };
  ['click', 'keydown', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, mark, { passive: true }));
  lesson.idleTimer = setInterval(() => {
    if (!lesson.active) return;
    const idle = Date.now() - lesson.lastActivity;
    if (idle > IDLE_LIMIT_MS) {
      lessonEnd();
      lessonToast('활동이 없어 수업 기록을 자동 종료했습니다. 다시 시작하려면 발표에서 재진입하세요.');
    } else if (idle > IDLE_WARN_MS && !lesson.idleWarn) {
      const w = document.createElement('div');
      w.textContent = '곧 수업 기록이 종료됩니다 — 계속하려면 화면을 터치';
      w.style.cssText = 'position:fixed;top:46px;left:50%;transform:translateX(-50%);z-index:990;background:#B45309;color:#fff;padding:9px 18px;border-radius:999px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.25)';
      document.body.appendChild(w);
      lesson.idleWarn = w;
    }
  }, 15000);
}

function lessonOverlay(html) {
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;z-index:950;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px';
  o.innerHTML = `<div style="background:#fff;border-radius:16px;max-width:420px;width:100%;padding:20px;font-family:inherit">${html}</div>`;
  o.addEventListener('click', e => { if (e.target === o) o.remove(); });
  document.body.appendChild(o);
  return o;
}

// ── 비밀번호 → 수강생/날짜 선택 ──
async function lessonOpenSetup() {
  const today = new Date();
  const kst = new Date(today.getTime() + (today.getTimezoneOffset() + 540) * 60000);
  const dstr = kst.toISOString().slice(0, 10);

  const o = lessonOverlay(`
    <h3 style="margin:0 0 12px;font-size:16px">수업 모드 시작</h3>
    <label style="font-size:12px;color:#6B7280">수업 비밀번호</label>
    <input id="lm-pass" type="password" style="width:100%;padding:9px;border:1px solid #E5E7EB;border-radius:8px;margin:4px 0 12px;font-size:14px" />
    <div id="lm-after" style="display:none">
      <label style="font-size:12px;color:#6B7280">수강생</label>
      <select id="lm-student" style="width:100%;padding:9px;border:1px solid #E5E7EB;border-radius:8px;margin:4px 0 12px;font-size:14px"></select>
      <label style="font-size:12px;color:#6B7280">수업 날짜</label>
      <input id="lm-date" type="date" value="${dstr}" style="width:100%;padding:9px;border:1px solid #E5E7EB;border-radius:8px;margin:4px 0 12px;font-size:14px" />
    </div>
    <p id="lm-err" style="color:#B91C1C;font-size:12px;min-height:16px;margin:0 0 8px"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="lm-cancel" style="padding:8px 14px;border:1px solid #E5E7EB;border-radius:8px;background:#fff;cursor:pointer">취소</button>
      <button id="lm-go" style="padding:8px 16px;border:none;border-radius:8px;background:#2563EB;color:#fff;cursor:pointer">확인</button>
    </div>`);

  const err = o.querySelector('#lm-err');
  o.querySelector('#lm-cancel').onclick = () => o.remove();

  const ctx = lessonUrlContext();
  if (ctx.date) o.querySelector('#lm-date').value = ctx.date;

  let students = [];
  o.querySelector('#lm-go').onclick = async () => {
    err.textContent = '';
    lesson.passcode = o.querySelector('#lm-pass').value;
    if (o.querySelector('#lm-after').style.display === 'none') {
      // 1단계: 비밀번호 확인 + 수강생 로드
      try {
        const data = await lessonApi('students');
        students = data.students || [];
        const sel = o.querySelector('#lm-student');
        sel.innerHTML = students.map((s, i) => `<option value="${i}">${s.name}</option>`).join('');
        o.querySelector('#lm-after').style.display = '';
        if (ctx.date) o.querySelector('#lm-date').value = ctx.date;

        // 편집기에서 넘어온 수강생이 목록에 있으면 골라두고 그대로 시작한다.
        // 없으면 아무 것도 하지 않고 수동 선택으로 둔다(폴백).
        const hit = students.findIndex(s => s.course_id === ctx.course);
        if (hit >= 0) {
          sel.value = String(hit);
          o.querySelector('#lm-go').click();   // 2단계로 바로 진행
        } else if (ctx.course) {
          err.textContent = '넘겨받은 수강생을 찾을 수 없어 직접 선택해주세요.';
        }
      } catch (e) { err.textContent = e.message; }
    } else {
      // 2단계: 시트 확보 + 수업 모드 활성화
      const s = students[+o.querySelector('#lm-student').value];
      lesson.date = o.querySelector('#lm-date').value;
      try {
        const data = await lessonApi('sheet', { course_id: s.course_id, teacher_id: s.teacher_id, date: lesson.date });
        lesson.sheetId = data.sheet_id;
        lesson.logged = data.logged || {};
        lesson.studentName = s.name; lesson.courseId = s.course_id; lesson.teacherId = s.teacher_id;
        lesson.active = true;
        o.remove();
        lessonShowBar();
        lessonLogStart();                       // 세션 자동 기록 시작 (비동기, 수업을 막지 않음)
        if (lesson.current) lessonOnSentence(lesson.current);
      } catch (e) { err.textContent = e.message; }
    }
  };
}

// ── 하단 칠판 (L, 2026-07-28 승인) ─────────────────────────
// 수업 중 판서용 오버레이. **저장하지 않는다** — DB·세션 귀속 없음, 내리거나
// 나가면 사라진다. 덱 데이터를 건드리지 않으므로 발표·PPT 렌더에 무영향.
// 기존 하단 "체크 + 오류 태그 + 메모" 바는 제거됐다(자동 기록 → 편집기에서 승격).
// 복원: 아래 lessonShowBar 안의 예전 마크업(git 이력)과 lessonOnSentence의
// 태그 렌더 블록을 되살리면 된다. 저장 함수(lessonLog 등)는 그대로 남아 있다.

const BOARD_H = { closed: 34, half: 0.45, full: 0.8 };   // half·full은 화면 높이 비율

function lessonBoardHeight(step) {
  if (step === 'closed') return BOARD_H.closed;
  return Math.round(window.innerHeight * BOARD_H[step]);
}

function lessonShowBar() {
  if (lesson.bar) lesson.bar.remove();
  const el = document.createElement('div');
  el.id = 'lm-board';
  el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:900;background:#fff;' +
    'border-top:1px solid #E5E7EB;border-radius:18px 18px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.12);' +
    'transition:height .18s ease;height:' + BOARD_H.closed + 'px;font-family:inherit;overflow:hidden';
  el.innerHTML = `
    <div id="lm-board-handle" style="height:34px;display:flex;align-items:center;justify-content:center;cursor:grab;position:relative;touch-action:none">
      <div style="width:54px;height:5px;border-radius:999px;background:#D1D5DB"></div>
      <span style="position:absolute;right:16px;top:9px;font-size:11px;color:#9CA3AF">위로 끌어올리면 칠판 · 저장되지 않습니다</span>
    </div>
    <textarea id="lm-board-text" placeholder="여기에 적으면 학생 화면에 크게 보입니다 (저장되지 않습니다)"
      style="display:none;width:100%;height:calc(100% - 34px);border:0;outline:none;resize:none;
             padding:4px 40px 24px;font-family:inherit;font-size:34px;font-weight:700;line-height:1.5;color:#111827"></textarea>`;
  document.body.appendChild(el);
  lesson.bar = el;
  lesson.boardStep = 'closed';
  document.body.style.paddingBottom = BOARD_H.closed + 'px';

  const ta = el.querySelector('#lm-board-text');
  const setStep = (step) => {
    lesson.boardStep = step;
    el.style.height = lessonBoardHeight(step) + 'px';
    ta.style.display = step === 'closed' ? 'none' : 'block';
    document.body.style.paddingBottom = (step === 'closed' ? BOARD_H.closed : 0) + 'px';
    if (step !== 'closed') setTimeout(() => ta.focus(), 180);
  };
  lesson.boardSet = setStep;

  // 탭 = 한 단계 올리기(닫힘→반→전체→닫힘), 드래그 = 방향으로 단계 이동
  const handle = el.querySelector('#lm-board-handle');
  let startY = null;
  handle.addEventListener('pointerdown', e => { startY = e.clientY; handle.setPointerCapture(e.pointerId); });
  handle.addEventListener('pointerup', e => {
    if (startY === null) return;
    const dy = startY - e.clientY;
    startY = null;
    const order = ['closed', 'half', 'full'];
    const i = order.indexOf(lesson.boardStep);
    if (Math.abs(dy) < 12) setStep(order[(i + 1) % 3]);            // 탭
    else setStep(order[Math.max(0, Math.min(2, i + (dy > 0 ? 1 : -1)))]);   // 드래그
  });
  // 타이핑도 활동으로 잡히도록 (유휴 감시는 document keydown을 듣는다)
  ta.addEventListener('input', () => { lesson.lastActivity = Date.now(); });
}

function lessonEnd() {
  lessonLogEnd(false);                          // 잔여 이벤트 일괄 저장 + ended_at
  lesson.active = false;
  lesson.auth = null;
  if (lesson.idleTimer) { clearInterval(lesson.idleTimer); lesson.idleTimer = null; }
  if (lesson.idleWarn) { lesson.idleWarn.remove(); lesson.idleWarn = null; }
  if (lesson.bar) { lesson.bar.remove(); lesson.bar = null; }
  if (lesson.banner) { lesson.banner.remove(); lesson.banner = null; }
  document.body.style.paddingBottom = '';
  document.body.style.paddingTop = '';
  // 종료 후 새로고침해도 다시 수업모드로 들어가지 않게 핸드오프 파라미터 제거
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* no-op */ }
}

// 아래 저장 함수들은 UI에서 내려갔지만 복원 가능하게 남긴다 (체크 UI 되살리면 그대로 동작).
void lessonToggleDone; void lessonToggleTag; void lessonLog; void lessonEntry; void LESSON_TAGS;

function lessonUpdateCount() {
  const el = lesson.bar && lesson.bar.querySelector('#lm-count');
  if (el) el.textContent = `기록 ${Object.keys(lesson.logged).length}문장`;
}

// ── 현재 문장 변경 시 (app.js 렌더 훅에서 호출) ──
// ★ 이 바는 수업 중 학생에게도 보인다. 문장(영어·한국어)을 절대 표시하지 않는다.
//   무엇을 기록 중인지는 화면 가운데 카드가 이미 보여준다.

function lessonEntry(id) {
  const e = lesson.logged[id];
  return e ? { tags: e.tags || [], note: e.note || '' } : null;
}

function lessonOnSentence(s) {
  lesson.current = s;
  if (!lesson.active || !lesson.bar) return;
  // 문장 진입/이탈 기록 (같은 문장 재렌더는 무시)
  if (s.id !== lesson.curSid) {
    lessonLeaveCurrent();
    lessonTrack('enter', s.id);
    lesson.curSid = s.id;
    lesson.enterAt = Date.now();
  }
  // L: 하단 체크·태그·메모 UI 제거 — 문장별 기록은 수업 후 편집기에서
  // "자동 기록 → 기록으로 승격"으로 남긴다(세션 로그는 계속 자동 수집된다).
}

// 아래 조작들은 화면을 먼저 바꾸고 저장은 뒤에서 한다.
// 함수가 미국 리전에서 돌아 왕복이 400ms 넘는데, 기다렸다 그리면 수업 중에 답답하다.

function lessonToggleDone(s) {
  const cur = lessonEntry(s.id);
  if (cur) {
    delete lesson.logged[s.id];
    lessonUpdateCount(); lessonOnSentence(s);
    lessonApi('remove', { sheet_id: lesson.sheetId, sentence_id: s.id })
      .catch(e => lessonWarn(e, s));
  } else {
    lesson.logged[s.id] = { tags: [], note: '' };
    lessonUpdateCount(); lessonOnSentence(s);
    lessonLog(s);
  }
}

function lessonToggleTag(s, tag) {
  const cur = lessonEntry(s.id) || { tags: [], note: '' };
  const next = cur.tags.includes(tag) ? cur.tags.filter(t => t !== tag) : cur.tags.concat(tag);
  lesson.logged[s.id] = { tags: next, note: cur.note };
  lessonUpdateCount(); lessonOnSentence(s);
  lessonLog(s);
}

/** 저장 실패는 조용히 넘기지 않고 바에 표시한다 */
function lessonWarn(e, s) {
  const el = lesson.bar && lesson.bar.querySelector('#lm-count');
  if (el) {
    el.textContent = '저장 실패 — 다시 눌러주세요';
    el.style.color = '#FCA5A5';
    setTimeout(() => { el.style.color = ''; lessonUpdateCount(); }, 3000);
  }
  console.error('lesson save failed', e);
  void s;
}

function lessonLog(s) {
  const entry = lessonEntry(s.id) || { tags: [], note: '' };
  return lessonApi('log', {
    sheet_id: lesson.sheetId, sentence_id: s.id,
    grammar_name: s.grammar, korean: s.korean, english: s.english,
    error_tags: entry.tags, note: entry.note,
  }).catch(e => lessonWarn(e, s));
}

window.lessonOnSentence = lessonOnSentence;
document.addEventListener('DOMContentLoaded', lessonInit);
