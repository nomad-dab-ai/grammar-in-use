"""
수업 모드 서버함수 (grammar-in-use).
서비스 롤 키·수업 비밀번호는 Vercel 환경변수로만 보관 (클라이언트 노출 없음).
POST body { action, passcode, ... }:
  - students : 활성 수강생 + 활성 course_id 목록
  - sheet    : {course_id, date} 시트 get-or-create → sheet_id + 이미 기록된 문장들
  - log      : {sheet_id, sentence_id, grammar_name, korean, english, error_tags[]} upsert (문장별 1개)
  - remove   : {sheet_id, sentence_id} 기록 삭제

필요한 Vercel 환경변수:
  SUPABASE_SERVICE_ROLE_KEY  (필수, 비밀)
  TEACHER_PASSCODE           (필수, 비밀)
  SUPABASE_URL               (선택, 기본값 아래)
"""
from http.server import BaseHTTPRequestHandler
import json, os, hmac, time, urllib.request, urllib.error, urllib.parse

# 비밀번호 무차별 대입 완화.
# 서버리스라 인스턴스가 자주 죽고 여러 개가 동시에 뜨므로 이 카운터는 완전하지 않다
# (best-effort). 지연은 항상 걸리므로 인스턴스가 유지되는 동안에는 확실히 느려진다.
FAIL_DELAY_SEC = 1.5
FAIL_MAX       = 5          # 같은 IP 연속 실패 허용치
FAIL_WINDOW    = 300        # 초 — 이 시간 지나면 카운터 초기화
_fails = {}                 # ip -> [연속실패수, 마지막실패시각]


def _client_ip(headers):
    fwd = headers.get('x-forwarded-for') or ''
    return fwd.split(',')[0].strip() or headers.get('x-real-ip') or 'unknown'


def _too_many_fails(ip):
    rec = _fails.get(ip)
    if not rec:
        return False
    count, last = rec
    if time.time() - last > FAIL_WINDOW:
        _fails.pop(ip, None)
        return False
    return count >= FAIL_MAX


def _note_fail(ip):
    count, last = _fails.get(ip, (0, 0))
    if time.time() - last > FAIL_WINDOW:
        count = 0
    _fails[ip] = (count + 1, time.time())


def _clear_fail(ip):
    _fails.pop(ip, None)

SUPABASE_URL = os.environ.get('SUPABASE_URL', 'https://sunkpfagbwwnctqdttwi.supabase.co')
SERVICE_KEY  = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
PASSCODE     = os.environ.get('TEACHER_PASSCODE', '')


def _sb(method, path, body=None, extra_headers=None):
    headers = {
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
    }
    if extra_headers:
        headers.update(extra_headers)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(SUPABASE_URL + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors='replace')


def _q(**kw):
    return urllib.parse.urlencode(kw)

# ── 액션 처리 (순수 함수: (status, dict) 반환) ────────────────
# server.py(단일 Vercel 함수)와 아래 handler 클래스가 이 함수들을 공유한다.
# 로직을 한 곳에만 두어 두 진입점이 어긋나지 않게 한다.

def _students():
    st, students = _sb('GET', '/rest/v1/students?' + _q(select='id,name', status='eq.active', order='name'))
    if st >= 300:
        return 502, {'error': 'students ' + str(students)}
    st, courses = _sb('GET', '/rest/v1/courses?' + _q(select='id,student_id,teacher_id', status='eq.active'))
    if st >= 300:
        return 502, {'error': 'courses ' + str(courses)}
    cmap = {c['student_id']: c for c in courses}
    out = []
    for s in students:
        c = cmap.get(s['id'])
        if c:
            out.append({'student_id': s['id'], 'name': s['name'],
                        'course_id': c['id'], 'teacher_id': c['teacher_id']})
    return 200, {'students': out}


def _sheet(p):
    course_id = p['course_id']; date = p['date']
    # teacher_id는 클라이언트 값을 믿지 않고 course로 서버가 결정한다
    st, courses = _sb('GET', '/rest/v1/courses?' + _q(select='teacher_id', id='eq.' + course_id))
    if st >= 300 or not courses:
        return 400, {'error': '수업을 찾을 수 없습니다.'}
    teacher_id = courses[0]['teacher_id']
    st, rows = _sb('POST', '/rest/v1/lesson_sheets?' + _q(on_conflict='course_id,session_date'),
                   {'course_id': course_id, 'teacher_id': teacher_id, 'session_date': date},
                   {'Prefer': 'resolution=merge-duplicates,return=representation'})
    if st >= 300 or not rows:
        return 502, {'error': 'sheet ' + str(rows)}
    sheet_id = rows[0]['id']
    st, items = _sb('GET', '/rest/v1/lesson_practice_items?' +
                    _q(select='sentence_id,error_tags,note', sheet_id='eq.' + sheet_id))
    logged = {it['sentence_id']: {'tags': it.get('error_tags') or [], 'note': it.get('note') or ''}
              for it in (items or []) if it.get('sentence_id')}
    return 200, {'sheet_id': sheet_id, 'logged': logged}


def _log(p):
    """문장 기록 upsert.

    함수가 미국 리전(iad1)에서 도는데 사용자는 한국이라 왕복 한 번이 비싸다.
    존재 확인과 sort_order 조회를 한 번의 조회로 합쳐 왕복을 3회 → 2회로 줄인다.
    """
    sheet_id = p['sheet_id']; sentence_id = p.get('sentence_id')
    tags = p.get('error_tags') or []
    note = p.get('note')

    st, rows = _sb('GET', '/rest/v1/lesson_practice_items?' +
                   _q(select='id,sentence_id,sort_order', sheet_id='eq.' + sheet_id))
    rows = rows or []
    mine = next((r for r in rows if r.get('sentence_id') == sentence_id), None)

    patch = {'error_tags': tags}
    if note is not None:
        patch['note'] = note or None

    if mine:
        _sb('PATCH', '/rest/v1/lesson_practice_items?' + _q(id='eq.' + mine['id']), patch)
    else:
        # 편집기(lesson-manager)와 같은 규칙으로 순서를 이어붙인다.
        # 넣지 않으면 전부 기본값 0이 되어 슬라이드 '연습 문장 불러오기' 순서가 뒤엉킨다.
        next_order = max([r.get('sort_order') or 0 for r in rows], default=-1) + 1
        body = {
            'sheet_id': sheet_id, 'sentence_id': sentence_id,
            'grammar_name': p.get('grammar_name'), 'korean': p.get('korean'),
            'english': p.get('english'), 'error_tags': tags, 'sort_order': next_order,
        }
        if note is not None:
            body['note'] = note or None
        _sb('POST', '/rest/v1/lesson_practice_items', body)
    return 200, {'ok': True}


def _remove(p):
    sheet_id = p['sheet_id']; sentence_id = p.get('sentence_id')
    _sb('DELETE', '/rest/v1/lesson_practice_items?' +
        _q(sheet_id='eq.' + sheet_id, sentence_id='eq.' + str(sentence_id)))
    return 200, {'ok': True}


# ── 세션 자동 기록 (lesson_sessions_log — 세션당 1행, events JSONB) ──
# 이벤트 5종 고정: enter / leave(dwell 포함) / play / repeat / reveal

MAX_EVENTS = 5000   # 한 세션 이벤트 상한 (폭주 방지)


def _session_start(p):
    st, rows = _sb('POST', '/rest/v1/lesson_sessions_log',
                   {'sheet_id': p['sheet_id'], 'events': []},
                   {'Prefer': 'return=representation'})
    if st >= 300 or not rows:
        return 502, {'error': 'session_start ' + str(rows)}
    return 200, {'log_id': rows[0]['id']}


def _session_append(p, end=False):
    log_id = p['log_id']
    new = p.get('events') or []
    if not isinstance(new, list):
        return 400, {'error': 'events must be a list'}
    # 읽고-합쳐-쓰기 (쓰는 쪽은 강사 브라우저 하나뿐이라 경합 없음)
    st, rows = _sb('GET', '/rest/v1/lesson_sessions_log?' + _q(select='events', id='eq.' + log_id))
    if st >= 300 or not rows:
        return 400, {'error': '세션을 찾을 수 없습니다.'}
    events = (rows[0].get('events') or []) + new
    patch = {'events': events[:MAX_EVENTS]}
    if end:
        patch['ended_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    st, _body = _sb('PATCH', '/rest/v1/lesson_sessions_log?' + _q(id='eq.' + log_id), patch)
    if st >= 300:
        return 502, {'error': 'session_append ' + str(_body)}
    return 200, {'ok': True, 'count': len(events)}


# ── 발표 핸드오프 토큰 (수동 토글 폐지 — 수업모드는 발표에서 들어온 경우에만) ──
# lesson-manager가 발표 Review 링크에 심는 서명:
#   token = HMAC_SHA256(TEACHER_PASSCODE, f"{course_id}|{date}|{sheet_id}|{exp}") hexdigest
# exp = 유닉스 초. 검증 실패·만료·불일치는 전부 거부 → 클라이언트는 일반 모드 폴백.

import hashlib


def _token_ok(auth):
    try:
        course = str(auth['course']); date = str(auth['date'])
        sheet = str(auth['sheet']); exp = int(auth['exp']); token = str(auth['token'])
    except Exception:
        return False
    if time.time() > exp:
        return False
    msg = f'{course}|{date}|{sheet}|{exp}'.encode()
    want = hmac.new(PASSCODE.encode(), msg, hashlib.sha256).hexdigest()
    return hmac.compare_digest(token, want)


def _handoff(auth):
    """토큰 검증 후 수업 컨텍스트 반환. 시트는 반드시 그 course+date의 것이어야 한다."""
    course_id = auth['course']; date = auth['date']; sheet_id = auth['sheet']
    st, sheets = _sb('GET', '/rest/v1/lesson_sheets?' +
                     _q(select='id,course_id,session_date', id='eq.' + sheet_id))
    if st >= 300 or not sheets:
        return 400, {'error': '시트를 찾을 수 없습니다.'}
    sh = sheets[0]
    if sh['course_id'] != course_id or sh['session_date'] != date:
        return 400, {'error': '수업 컨텍스트가 일치하지 않습니다.'}
    st, courses = _sb('GET', '/rest/v1/courses?' + _q(select='student_id', id='eq.' + course_id))
    if st >= 300 or not courses:
        return 400, {'error': '수업을 찾을 수 없습니다.'}
    st, students = _sb('GET', '/rest/v1/students?' + _q(select='name', id='eq.' + courses[0]['student_id']))
    name = (students[0]['name'] if st < 300 and students else '수강생')
    st, items = _sb('GET', '/rest/v1/lesson_practice_items?' +
                    _q(select='sentence_id,error_tags,note', sheet_id='eq.' + sheet_id))
    logged = {it['sentence_id']: {'tags': it.get('error_tags') or [], 'note': it.get('note') or ''}
              for it in (items or []) if it.get('sentence_id')}
    return 200, {'sheet_id': sheet_id, 'student_name': name, 'logged': logged}


def handle(payload, ip):
    """수업 모드 요청 처리. (status, body) 반환."""
    if not SERVICE_KEY or not PASSCODE:
        return 500, {'error': '서버 환경변수(SUPABASE_SERVICE_ROLE_KEY, TEACHER_PASSCODE) 미설정'}

    if _too_many_fails(ip):
        time.sleep(FAIL_DELAY_SEC)
        return 429, {'error': '시도가 너무 많습니다. 잠시 후 다시 시도해주세요.'}

    action = payload.get('action')
    auth = payload.get('auth')

    if auth is not None:
        # 핸드오프 토큰 경로 (발표에서 들어온 수업모드)
        if not _token_ok(auth):
            _note_fail(ip)
            time.sleep(FAIL_DELAY_SEC)
            return 401, {'error': '수업 연결이 유효하지 않습니다.'}
        _clear_fail(ip)
        # 쓰기 대상 시트를 토큰의 시트로 강제 — 토큰으로는 다른 시트에 쓸 수 없다
        if payload.get('sheet_id') and str(payload['sheet_id']) != str(auth['sheet']):
            return 403, {'error': '토큰의 시트가 아닙니다.'}
    else:
        # 비밀번호 경로 (API 존치 — 수동 토글 UI는 제거됨, 복원 시 이 경로 그대로 사용)
        if not hmac.compare_digest(str(payload.get('passcode', '')), PASSCODE):
            _note_fail(ip)
            time.sleep(FAIL_DELAY_SEC)   # 실패는 항상 느리게 — 대입 속도를 떨어뜨린다
            return 401, {'error': '비밀번호가 올바르지 않습니다.'}
        _clear_fail(ip)

    try:
        if action == 'handoff':
            if auth is None:
                return 400, {'error': 'handoff에는 토큰이 필요합니다.'}
            return _handoff(auth)
        if action == 'students': return _students()
        if action == 'sheet':    return _sheet(payload)
        if action == 'log':      return _log(payload)
        if action == 'remove':   return _remove(payload)
        if action == 'session_start':  return _session_start(payload)
        if action == 'session_events': return _session_append(payload)
        if action == 'session_end':    return _session_append(payload, end=True)
        return 400, {'error': 'unknown action'}
    except Exception as e:
        return 500, {'error': str(e)}


# ── Vercel이 api/*.py를 개별 함수로 잡는 구성일 때의 진입점 ──
# 현재 배포는 루트 server.py 하나만 함수로 만들므로 이 클래스는 쓰이지 않지만,
# 구성이 바뀌어도 같은 handle()을 타도록 남겨둔다.

class handler(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b'{}')
        except Exception:
            return self._send(400, {'error': '잘못된 요청'})
        status, obj = handle(payload, _client_ip(self.headers))
        self._send(status, obj)
