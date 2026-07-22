'use strict';
// 수업 모드 — 수강생별로 재생한 문장 + 오류를 lesson-manager에 기록.
// 모든 쓰기는 /api/lesson (서버함수)를 거치며, 서비스키·비밀번호는 서버에만 있음.

const LESSON_TAGS = ['발음', '어순', '시제', '어휘', '관사/전치사', '유창성'];
const lesson = {
  active: false, passcode: '', sheetId: null,
  studentName: '', courseId: '', teacherId: '', date: '',
  logged: {},        // sentence_id -> [tags]
  current: null,     // 현재 문장
};

async function lessonApi(action, extra) {
  const res = await fetch('/api/lesson', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action, passcode: lesson.passcode }, extra || {})),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('오류 ' + res.status));
  return data;
}

/** 편집기(lesson-manager)에서 ?course=…&date=… 로 넘어온 컨텍스트 */
function lessonUrlContext() {
  const q = new URLSearchParams(location.search);
  const course = q.get('course');
  const date = q.get('date');
  const okDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date);
  return { course: course || null, date: okDate ? date : null };
}

// ── 런처 버튼 + 패널 주입 ──
function lessonInit() {
  const btn = document.createElement('button');
  btn.textContent = '수업 모드';
  btn.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:900;padding:10px 16px;border:none;border-radius:999px;background:#1E3A8A;color:#fff;font-size:14px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,.2);cursor:pointer';
  btn.onclick = lessonOpenSetup;
  document.body.appendChild(btn);
  lesson.launcher = btn;

  // 편집기에서 넘어왔으면 바로 수업 모드 설정을 띄운다 (비밀번호는 매번 입력)
  const ctx = lessonUrlContext();
  if (ctx.course) {
    btn.textContent = '수업 모드 시작 →';
    lessonOpenSetup();
  }
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
        if (lesson.current) lessonOnSentence(lesson.current);
      } catch (e) { err.textContent = e.message; }
    }
  };
}

// ── 하단 기록 바 ──
function lessonShowBar() {
  if (lesson.bar) lesson.bar.remove();
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:900;background:#0F172A;color:#fff;padding:10px 16px;box-shadow:0 -4px 12px rgba(0,0,0,.2);font-family:inherit';
  bar.innerHTML = `
    <div style="max-width:900px;margin:0 auto">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div style="font-size:13px"><b>${lesson.studentName}</b> · ${lesson.date} <span style="color:#94A3B8">· 수업 모드</span></div>
        <div style="display:flex;align-items:center;gap:10px">
          <span id="lm-count" style="font-size:12px;color:#94A3B8"></span>
          <button id="lm-end" style="padding:5px 12px;border:1px solid #334155;border-radius:8px;background:transparent;color:#CBD5E1;font-size:12px;cursor:pointer">종료</button>
        </div>
      </div>
      <div id="lm-cur" style="margin-top:8px;font-size:13px;color:#CBD5E1"></div>
      <div id="lm-tags" style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap"></div>
    </div>`;
  document.body.appendChild(bar);
  document.body.style.paddingBottom = '130px';
  lesson.bar = bar;
  if (lesson.launcher) lesson.launcher.style.display = 'none';
  bar.querySelector('#lm-end').onclick = lessonEnd;
  lessonUpdateCount();
}

function lessonEnd() {
  lesson.active = false;
  if (lesson.bar) { lesson.bar.remove(); lesson.bar = null; }
  document.body.style.paddingBottom = '';
  if (lesson.launcher) lesson.launcher.style.display = '';
}

function lessonUpdateCount() {
  const el = lesson.bar && lesson.bar.querySelector('#lm-count');
  if (el) el.textContent = `기록 ${Object.keys(lesson.logged).length}문장`;
}

// ── 현재 문장 변경 시 (app.js 렌더 훅에서 호출) ──
function lessonOnSentence(s) {
  lesson.current = s;
  if (!lesson.active || !lesson.bar) return;
  const cur = lesson.bar.querySelector('#lm-cur');
  const tagsWrap = lesson.bar.querySelector('#lm-tags');
  const logged = Object.prototype.hasOwnProperty.call(lesson.logged, s.id);
  const tags = lesson.logged[s.id] || [];

  cur.innerHTML = `<span style="color:#fff;font-weight:600">${s.english}</span> <span style="color:#64748B">— ${s.korean}</span>`;

  const doneBtn = `<button data-act="done" style="padding:4px 10px;border-radius:999px;border:1px solid ${logged ? '#22C55E' : '#334155'};background:${logged ? '#16A34A' : 'transparent'};color:${logged ? '#fff' : '#CBD5E1'};font-size:12px;cursor:pointer">${logged ? '✓ 완료' : '완료 표시'}</button>`;
  const tagBtns = LESSON_TAGS.map(t => {
    const on = tags.includes(t);
    return `<button data-tag="${t}" style="padding:4px 10px;border-radius:999px;border:1px solid ${on ? '#F87171' : '#334155'};background:${on ? '#DC2626' : 'transparent'};color:${on ? '#fff' : '#94A3B8'};font-size:12px;cursor:pointer">${t}</button>`;
  }).join('');
  tagsWrap.innerHTML = doneBtn + tagBtns;

  tagsWrap.querySelector('[data-act="done"]').onclick = () => lessonToggleDone(s);
  tagsWrap.querySelectorAll('[data-tag]').forEach(b => {
    b.onclick = () => lessonToggleTag(s, b.getAttribute('data-tag'));
  });
}

async function lessonToggleDone(s) {
  if (Object.prototype.hasOwnProperty.call(lesson.logged, s.id)) {
    // 완료 해제 → 기록 삭제
    try {
      await lessonApi('remove', { sheet_id: lesson.sheetId, sentence_id: s.id });
      delete lesson.logged[s.id];
    } catch (e) { alert(e.message); }
  } else {
    await lessonLog(s, []);
  }
  lessonUpdateCount();
  lessonOnSentence(s);
}

async function lessonToggleTag(s, tag) {
  const cur = lesson.logged[s.id] || [];
  const next = cur.includes(tag) ? cur.filter(t => t !== tag) : cur.concat(tag);
  await lessonLog(s, next);
  lessonUpdateCount();
  lessonOnSentence(s);
}

async function lessonLog(s, tags) {
  try {
    await lessonApi('log', {
      sheet_id: lesson.sheetId, sentence_id: s.id,
      grammar_name: s.grammar, korean: s.korean, english: s.english,
      error_tags: tags,
    });
    lesson.logged[s.id] = tags;   // 태그가 있든 없든 '완료'로 기록됨
  } catch (e) { alert(e.message); }
}

window.lessonOnSentence = lessonOnSentence;
document.addEventListener('DOMContentLoaded', lessonInit);
