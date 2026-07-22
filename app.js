'use strict';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

// 데이터·음원은 Supabase에서 직접 로드한다 (수업관리시스템과 동일한 DB).
// 문법/문장 편집은 수업관리시스템의 "문법 예문 관리" 화면에서 하며, 저장 즉시 반영된다.
// 아래 anon(publishable) 키는 공개 읽기 전용이라 클라이언트에 노출해도 안전하다.
const SUPABASE_URL  = 'https://sunkpfagbwwnctqdttwi.supabase.co';
const SUPABASE_ANON = 'sb_publishable_LsGMap_ueJGBXPWimrmJXQ_CN1QU3P_';
const CLIPS_BASE    = `${SUPABASE_URL}/storage/v1/object/public/grammar-clips/`;

const SPEEDS = [0.75, 1, 1.25];
let   repeatOn = false;          // 반복 재생

const STOP = new Set([
    'a', 'an', 'the',
    'i', 'you', 'he', 'she', 'it', 'we', 'they',
    'me', 'him', 'her', 'us', 'them',
    'my', 'your', 'its', 'our', 'their',
    'and', 'but', 'or', 'so',
    'in', 'on', 'at', 'to', 'for', 'of', 'by', 'with', 'from',
    'this', 'that', 'these', 'those',
]);

// ─────────────────────────────────────────────────────────────
// App state
// ─────────────────────────────────────────────────────────────
let sentences    = [];
let clipsMapping = {};   // { "문법||번호": "폴더/파일.mp3" }
let cats         = [];   // ordered list of grammar categories
let speedIdx     = 1;   // 기본 1× (SPEEDS 배열의 가운데)

const audioTab = { list: [], index: 0, grammars: new Set() };
const recall   = { list: [], index: 0, grammars: new Set() };

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────
const shuffle = arr => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

const $ = id => document.getElementById(id);

// 아포스트로피는 유지해서 were/we're 를 구분한다 (스마트 따옴표는 통일)
const normalize = s => s.trim().toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[^a-z']/g, '');

function filterSentences(grammars) {
    if (!grammars || grammars.size === 0) return [...sentences];
    return sentences.filter(s => grammars.has(s.grammar));
}

function grammarLabel(cat) {
    const idx = cats.indexOf(cat);
    return idx >= 0 ? `${idx + 1}. ${cat}` : cat;
}

function getClip(s) {
    return clipsMapping[`${s.grammar}||${s.number}`] || null;
}

function clipUrl(clipPath) {
    return CLIPS_BASE + clipPath.split('/').map(encodeURIComponent).join('/');
}

// ─────────────────────────────────────────────────────────────
// Local storage (학습 위치 저장)
// ─────────────────────────────────────────────────────────────
// 빈칸 채우기 모드를 없애며 남은 고아 항목 정리 (한 번만 실행되면 그만)
try { localStorage.removeItem('giu:blank'); } catch {}

function loadState(key) {
    try { return JSON.parse(localStorage.getItem(`giu:${key}`)) || {}; }
    catch { return {}; }
}

function saveState(key, obj) {
    try { localStorage.setItem(`giu:${key}`, JSON.stringify(obj)); } catch {}
}

function saveTab(prefix, tab) {
    saveState(prefix, {
        grammars: [...tab.grammars],
        shuffle: $(`${prefix}-shuffle`) ? $(`${prefix}-shuffle`).checked : undefined,
        index: tab.index,
    });
}

// ─────────────────────────────────────────────────────────────
// Data loading (Supabase)
// ─────────────────────────────────────────────────────────────
async function loadData() {
    const headers = { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` };
    const rest = (q) => fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers }).then(r => {
        if (!r.ok) throw new Error(`Supabase ${r.status}`);
        return r.json();
    });

    const [points, rows] = await Promise.all([
        rest('grammar_points?select=id,name,sort_order&order=sort_order'),
        rest('grammar_sentences?select=id,grammar_point_id,number,korean,english,clip_path&order=grammar_point_id,number'),
    ]);

    const nameById = Object.fromEntries(points.map(p => [p.id, p.name]));
    const orderById = Object.fromEntries(points.map(p => [p.id, p.sort_order]));

    // 문법 sort_order → 번호 순으로 정렬해 기존 카테고리 순서를 유지
    const sorted = [...rows].sort((a, b) =>
        (orderById[a.grammar_point_id] - orderById[b.grammar_point_id]) || (a.number - b.number));

    sentences = sorted.map(r => ({
        id:      r.id,
        grammar: nameById[r.grammar_point_id],
        number:  String(r.number),
        korean:  r.korean,
        english: r.english,
    }));

    clipsMapping = {};
    for (const r of sorted) {
        if (r.clip_path) clipsMapping[`${nameById[r.grammar_point_id]}||${r.number}`] = r.clip_path;
    }
}

// ─────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────
async function init() {
    try {
        await loadData();
        cats = [...new Set(sentences.map(s => s.grammar))];
        // initX() 과정에서 reset이 index를 0으로 저장하므로, 복원용 값을 먼저 확보
        const savedIndexes = {
            audio:  loadState('audio').index,
            recall: loadState('recall').index,
        };
        initSpeed();
        initGrammarSelectors();
        initTabNav();
        initAudio();
        initRecall();
        restoreIndexes(savedIndexes);
        initKeyboard();
    } catch (err) {
        document.querySelector('.app-main').innerHTML =
            `<div class="card"><p style="color:var(--error)">데이터 로딩 실패: ${err.message}</p></div>`;
    }
}

// 저장된 학습 위치 복원 (필터·셔플은 initGrammarSelectors/initX에서 복원)
function restoreIndexes(saved) {
    [['audio', audioTab, renderAudio],
     ['recall', recall, renderRecall]].forEach(([prefix, tab, render]) => {
        const idx = saved[prefix];
        if (Number.isInteger(idx) && idx > 0 && idx < tab.list.length) {
            tab.index = idx;
            render();
        }
    });
}

// ─────────────────────────────────────────────────────────────
// Grammar selectors
// ─────────────────────────────────────────────────────────────
function initGrammarSelectors() {
    const configs = [
        { prefix: 'audio', tab: audioTab, reset: resetAudio },
        { prefix: 'recall', tab: recall,  reset: resetRecall },
    ];

    configs.forEach(({ prefix, tab, reset }) => {
        const btn    = $(`${prefix}-grammar-btn`);
        const panel  = $(`${prefix}-grammar-panel`);
        const list   = $(`${prefix}-grammar-list`);
        const allChk = $(`${prefix}-chk-all`);

        const saved = loadState(prefix);
        const savedGrammars = new Set((saved.grammars || []).filter(g => cats.includes(g)));
        const useAll = savedGrammars.size === 0 || savedGrammars.size === cats.length;

        allChk.checked = useAll;

        cats.forEach((cat, i) => {
            const label = document.createElement('label');
            label.className = 'grammar-item';
            const chk = document.createElement('input');
            chk.type    = 'checkbox';
            chk.value   = cat;
            chk.checked = useAll || savedGrammars.has(cat);
            const span = document.createElement('span');
            span.textContent = `${i + 1}. ${cat}`;
            label.append(chk, span);
            list.appendChild(label);
            chk.addEventListener('change', () => syncGrammarState(prefix, tab, allChk, list, btn, reset));
        });

        if (!useAll) {
            tab.grammars = savedGrammars;
            allChk.indeterminate = true;
            btn.textContent = `${savedGrammars.size}개 선택 ▾`;
        }

        if ($(`${prefix}-shuffle`) && saved.shuffle) $(`${prefix}-shuffle`).checked = true;

        allChk.addEventListener('change', () => {
            list.querySelectorAll('input').forEach(c => c.checked = allChk.checked);
            syncGrammarState(prefix, tab, allChk, list, btn, reset);
        });

        btn.addEventListener('click', e => {
            e.stopPropagation();
            const isOpen = panel.classList.toggle('open');
            btn.classList.toggle('active', isOpen);
        });

        panel.addEventListener('click', e => e.stopPropagation());
    });

    document.addEventListener('click', () => {
        document.querySelectorAll('.grammar-panel.open').forEach(p => p.classList.remove('open'));
        document.querySelectorAll('.grammar-sel-btn.active').forEach(b => b.classList.remove('active'));
    });
}

function syncGrammarState(prefix, tab, allChk, list, btn, reset) {
    const boxes   = Array.from(list.querySelectorAll('input'));
    const checked = boxes.filter(c => c.checked).map(c => c.value);
    const allOn   = checked.length === cats.length;
    const noneOn  = checked.length === 0;

    tab.grammars = (allOn || noneOn) ? new Set() : new Set(checked);

    allChk.indeterminate = !allOn && !noneOn;
    allChk.checked = allOn;

    btn.textContent = tab.grammars.size === 0
        ? '전체 문법 ▾'
        : `${tab.grammars.size}개 선택 ▾`;

    reset();
}

// ─────────────────────────────────────────────────────────────
// Tab navigation
// ─────────────────────────────────────────────────────────────
function initTabNav() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            stopAudio();
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
            btn.classList.add('active');
            $(`tab-${btn.dataset.tab}`).classList.add('active');
            btn.blur();   // 포커스가 남으면 스페이스가 이 버튼으로 먹힌다
        });
    });
}

function activeTabName() {
    const btn = document.querySelector('.tab-btn.active');
    return btn ? btn.dataset.tab : null;
}

// ─────────────────────────────────────────────────────────────
// Keyboard shortcuts (←/→ 이동, 스페이스 재생/정답)
// ─────────────────────────────────────────────────────────────
function initKeyboard() {
    document.addEventListener('keydown', e => {
        const t = e.target;
        const editing = (t.tagName === 'INPUT' && t.type === 'text' && !t.readOnly)
                     || t.tagName === 'TEXTAREA';
        const tabName = activeTabName();
        if (!tabName) return;

        if (e.key === 'ArrowLeft' && !editing) {
            e.preventDefault();
            stepFor(tabName, -1);
        } else if (e.key === 'ArrowRight' && !editing) {
            e.preventDefault();
            stepFor(tabName, 1);
        } else if (e.key === ' ' && !editing && t.tagName !== 'BUTTON') {
            // 쉐도잉은 손에 익은 '재생'을 유지하고, 한→영에서만 정답 공개/숨김 토글
            e.preventDefault();
            if (tabName === 'audio') $('btn-listen').click();
            else if (tabName === 'recall') toggleReveal('recall');
        } else if ((e.key === 'r' || e.key === 'R') && !editing) {
            // 다시 듣기 — 두 탭 공통. 한→영에서도 문장 음원을 바로 들을 수 있다.
            e.preventDefault();
            replayCurrent(tabName);
        }
    });
}

/** R — 현재 문장을 처음부터 다시 재생 */
/** 정답 공개/숨김 토글 — 버튼 클릭과 스페이스가 같은 동작을 쓴다 */
function toggleReveal(prefix) {
    const el  = $(`${prefix}-reveal`);
    const btn = $(prefix === 'audio' ? 'btn-audio-reveal' : 'btn-reveal');
    if (!el || !btn) return;
    const shown = el.classList.toggle('visible');
    btn.style.display = shown ? 'none' : '';
}

/** R — 현재 문장을 처음부터 다시 재생 */
function replayCurrent(tabName) {
    const tab = tabName === 'audio' ? audioTab : recall;
    const s = tab.list[tab.index];
    if (!s) return;
    stopAudio();
    playSentence(s, tabName === 'audio');
}

function stepFor(tabName, dir) {
    if (tabName === 'audio')  { stopAudio(); stepAudio(dir); }
    if (tabName === 'recall') { stopAudio(); stepRecall(dir); }
}

// ─────────────────────────────────────────────────────────────
// Completion banner (마지막 문제 완료)
// ─────────────────────────────────────────────────────────────
function showComplete(prefix) {
    const el = $(`${prefix}-complete`);
    if (el) el.classList.add('visible');
}

function hideComplete(prefix) {
    const el = $(`${prefix}-complete`);
    if (el) el.classList.remove('visible');
}

// ─────────────────────────────────────────────────────────────
// Playback (음원 + TTS 폴백)
// ─────────────────────────────────────────────────────────────
let ttsToken = 0;   // 진행 중인 TTS를 무효화하기 위한 토큰

function isSpeaking() {
    return 'speechSynthesis' in window && speechSynthesis.speaking;
}

let cachedVoice = null;
function pickVoice() {
    if (cachedVoice) return cachedVoice;
    const voices = speechSynthesis.getVoices();
    cachedVoice =
        voices.find(v => v.lang === 'en-US' && /samantha|google us/i.test(v.name)) ||
        voices.find(v => v.lang === 'en-US') ||
        voices.find(v => v.lang.startsWith('en')) ||
        null;
    return cachedVoice;
}
if ('speechSynthesis' in window) {
    speechSynthesis.addEventListener('voiceschanged', () => { cachedVoice = null; });
}

function resetListenBtn() {
    const btn = $('btn-listen');
    if (btn) { btn.textContent = '▶ 문장 듣기'; btn.classList.remove('playing'); }
}

function stopAudio() {
    const p = $('audio-player');
    if (!p.paused) p.pause();
    if ('speechSynthesis' in window) {
        ttsToken++;
        speechSynthesis.cancel();
    }
    resetListenBtn();
}

// A:/B: 대화 레이블을 떼고 줄 단위로 읽는다
function speakSentence(text, markButton) {
    const lines = text.split('\n')
        .map(l => l.replace(/^[A-Z]\s*:\s*/, '').trim())
        .filter(Boolean);
    if (!lines.length) return;

    const token = ++ttsToken;
    speechSynthesis.cancel();
    const voice = pickVoice();

    lines.forEach((line, i) => {
        const u = new SpeechSynthesisUtterance(line);
        u.lang = 'en-US';
        if (voice) u.voice = voice;
        u.rate = SPEEDS[speedIdx];
        if (i === lines.length - 1) {
            u.onend   = () => { if (token === ttsToken && markButton) resetListenBtn(); };
            u.onerror = () => { if (token === ttsToken && markButton) resetListenBtn(); };
        }
        speechSynthesis.speak(u);
    });
}

// 현재 문장 재생: 음원이 있으면 음원, 없으면 브라우저 TTS
function playSentence(s, markButton) {
    stopAudio();

    if (markButton) {
        const btn = $('btn-listen');
        btn.textContent = '⏸ 정지';
        btn.classList.add('playing');
    }

    const clip = getClip(s);
    if (clip) {
        const p = $('audio-player');
        p.src = clipUrl(clip);
        p.load();
        p.playbackRate = SPEEDS[speedIdx];
        p.play().catch(() => {
            stopAudio();
            $('audio-status').textContent = '⚠️ 재생 실패';
        });
        p.addEventListener('ended', () => {
            if (repeatOn) { p.currentTime = 0; p.play().catch(() => resetListenBtn()); }
            else resetListenBtn();
        }, { once: true });
    } else if ('speechSynthesis' in window) {
        speakSentence(s.english, markButton);
    }
}

// ─────────────────────────────────────────────────────────────
// Speed control
// ─────────────────────────────────────────────────────────────
function initSpeed() {
    const saved = loadState('speed');
    if (Number.isInteger(saved.idx) && saved.idx >= 0 && saved.idx < SPEEDS.length) {
        speedIdx = saved.idx;
    }
    const btn = $('btn-speed');
    btn.textContent = `${SPEEDS[speedIdx]}×`;
    btn.addEventListener('click', () => {
        speedIdx = (speedIdx + 1) % SPEEDS.length;
        btn.textContent = `${SPEEDS[speedIdx]}×`;
        $('audio-player').playbackRate = SPEEDS[speedIdx];
        saveState('speed', { idx: speedIdx });
    });

    // 반복 재생 — 켜두면 문장이 끝날 때마다 다시 재생된다
    const rep = $('btn-repeat');
    repeatOn = !!loadState('repeat').on;
    const paintRepeat = () => {
        rep.classList.toggle('active', repeatOn);
        rep.setAttribute('aria-pressed', String(repeatOn));
        rep.title = repeatOn ? '반복 재생 켜짐' : '반복 재생 꺼짐';
    };
    paintRepeat();
    rep.addEventListener('click', () => {
        repeatOn = !repeatOn;
        paintRepeat();
        saveState('repeat', { on: repeatOn });
    });
}

// ─────────────────────────────────────────────────────────────
// TAB 1 – Audio (쉐도잉 연습)
// ─────────────────────────────────────────────────────────────
function initAudio() {
    $('audio-shuffle').addEventListener('change', resetAudio);

    $('btn-audio-reveal').addEventListener('click', () => {
        toggleReveal('audio');
    });

    $('btn-listen').addEventListener('click', () => {
        const p = $('audio-player');
        if (!p.paused || isSpeaking()) { stopAudio(); return; }
        const s = audioTab.list[audioTab.index];
        if (s) playSentence(s, true);
    });

    $('btn-audio-prev').addEventListener('click', () => { stopAudio(); stepAudio(-1); });
    $('btn-audio-next').addEventListener('click', () => { stopAudio(); stepAudio(1); });
    $('btn-audio-restart').addEventListener('click', resetAudio);

    resetAudio();
}

function resetAudio() {
    stopAudio();
    const rand = $('audio-shuffle').checked;
    let list   = filterSentences(audioTab.grammars);
    if (rand) list = shuffle(list);
    audioTab.list  = list;
    audioTab.index = 0;
    renderAudio();
}

function stepAudio(dir) {
    const next = audioTab.index + dir;
    if (next < 0) return;
    if (next >= audioTab.list.length) { showComplete('audio'); return; }
    audioTab.index = next;
    renderAudio();
}

function renderAudio() {
    const s = audioTab.list[audioTab.index];
    if (!s) return;

    hideComplete('audio');
    $('audio-reveal').classList.remove('visible');
    $('btn-audio-reveal').style.display = '';

    $('audio-badge').textContent   = grammarLabel(s.grammar);
    $('audio-korean').textContent  = s.korean;
    $('audio-english').textContent = s.english;

    const clip   = getClip(s);
    const hasTTS = 'speechSynthesis' in window;
    const btn    = $('btn-listen');
    if (clip || hasTTS) {
        btn.disabled = false;
        $('audio-status').textContent = clip ? '' : 'AI 음성';
    } else {
        btn.disabled = true;
        $('audio-status').textContent = '음원 없음';
    }
    resetListenBtn();

    const curr = audioTab.index + 1, total = audioTab.list.length;
    $('audio-curr').textContent  = curr;
    $('audio-total').textContent = total;
    $('audio-fill').style.width  = `${(curr / total) * 100}%`;

    saveTab('audio', audioTab);
}

// ─────────────────────────────────────────────────────────────
// TAB 2 – Recall (영어 떠올리기)
// ─────────────────────────────────────────────────────────────
function initRecall() {
    $('recall-shuffle').addEventListener('change', resetRecall);
    $('btn-reveal').addEventListener('click', () => {
        toggleReveal('recall');
        const s = recall.list[recall.index];
        if (s) playSentence(s, false);
    });
    $('btn-recall-prev').addEventListener('click', () => { stopAudio(); stepRecall(-1); });
    $('btn-recall-next').addEventListener('click', () => { stopAudio(); stepRecall(1); });
    $('btn-recall-restart').addEventListener('click', resetRecall);

    resetRecall();
}

function resetRecall() {
    stopAudio();
    const rand = $('recall-shuffle').checked;
    let list   = filterSentences(recall.grammars);
    if (rand) list = shuffle(list);
    recall.list  = list;
    recall.index = 0;
    renderRecall();
}

function stepRecall(dir) {
    const next = recall.index + dir;
    if (next < 0) return;
    if (next >= recall.list.length) { showComplete('recall'); return; }
    recall.index = next;
    renderRecall();
}

function renderRecall() {
    const s = recall.list[recall.index];
    if (!s) return;

    hideComplete('recall');
    $('recall-reveal').classList.remove('visible');
    $('btn-reveal').style.display = '';

    $('recall-badge').textContent   = grammarLabel(s.grammar);
    $('recall-korean').textContent  = s.korean;
    $('recall-english').textContent = s.english;

    const curr = recall.index + 1, total = recall.list.length;
    $('recall-curr').textContent  = curr;
    $('recall-total').textContent = total;
    $('recall-fill').style.width  = `${(curr / total) * 100}%`;

    saveTab('recall', recall);
}


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function escHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', init);
