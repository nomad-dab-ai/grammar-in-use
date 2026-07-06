'use strict';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

// 음원 CDN 주소. jsDelivr는 @main 같은 브랜치 주소를 최대 며칠씩 캐시하므로
// 커밋 해시로 고정한다. 음원 파일을 추가/교체한 커밋을 푸시한 뒤에는
// 아래 해시를 그 커밋 해시로 바꿔서 함께 배포할 것.
const CLIPS_BASE = 'https://cdn.jsdelivr.net/gh/nomad-dab-ai/grammar-in-use@3f88de0/clips/';

const SPEEDS = [1, 0.85, 0.7];

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
let speedIdx     = 0;

const audioTab = { list: [], index: 0, grammars: new Set() };
const recall   = { list: [], index: 0, grammars: new Set() };
const blank    = { list: [], index: 0, grammars: new Set(), checked: false };

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
// Bootstrap
// ─────────────────────────────────────────────────────────────
async function init() {
    try {
        [sentences, clipsMapping] = await Promise.all([
            fetch('/api/sentences').then(r => r.json()),
            fetch('/api/clips').then(r => r.json()),
        ]);
        cats = [...new Set(sentences.map(s => s.grammar))];
        // initX() 과정에서 reset이 index를 0으로 저장하므로, 복원용 값을 먼저 확보
        const savedIndexes = {
            audio:  loadState('audio').index,
            recall: loadState('recall').index,
            blank:  loadState('blank').index,
        };
        initSpeed();
        initGrammarSelectors();
        initTabNav();
        initAudio();
        initRecall();
        initBlank();
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
     ['recall', recall, renderRecall],
     ['blank', blank, renderBlank]].forEach(([prefix, tab, render]) => {
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
        { prefix: 'blank',  tab: blank,   reset: resetBlank },
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
            e.preventDefault();
            if (tabName === 'audio') $('btn-listen').click();
            else if (tabName === 'recall') $('btn-reveal').click();
        } else if (e.key === 'Enter' && tabName === 'blank' && blank.checked) {
            stepBlank(1);
        }
    });
}

function stepFor(tabName, dir) {
    if (tabName === 'audio')  { stopAudio(); stepAudio(dir); }
    if (tabName === 'recall') { stopAudio(); stepRecall(dir); }
    if (tabName === 'blank')  stepBlank(dir);
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
        p.addEventListener('ended', () => resetListenBtn(), { once: true });
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
}

// ─────────────────────────────────────────────────────────────
// TAB 1 – Audio (쉐도잉 연습)
// ─────────────────────────────────────────────────────────────
function initAudio() {
    $('audio-shuffle').addEventListener('change', resetAudio);

    $('btn-audio-reveal').addEventListener('click', () => {
        $('audio-reveal').classList.add('visible');
        $('btn-audio-reveal').style.display = 'none';
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
        $('recall-reveal').classList.add('visible');
        $('btn-reveal').style.display = 'none';
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
// TAB 3 – Fill in the blank (빈칸 채우기)
// ─────────────────────────────────────────────────────────────
function initBlank() {
    $('btn-reshuffle').addEventListener('click', resetBlank);
    $('btn-check').addEventListener('click', checkBlanks);
    $('btn-show-ans').addEventListener('click', showAnswer);
    $('btn-blank-prev').addEventListener('click', () => stepBlank(-1));
    $('btn-blank-next').addEventListener('click', () => stepBlank(1));
    $('btn-blank-restart').addEventListener('click', resetBlank);

    resetBlank();
}

function resetBlank() {
    blank.list  = shuffle(filterSentences(blank.grammars));
    blank.index = 0;
    renderBlank();
}

function stepBlank(dir) {
    const next = blank.index + dir;
    if (next < 0) return;
    if (next >= blank.list.length) { showComplete('blank'); return; }
    blank.index = next;
    renderBlank();
}

function tokenise(text) {
    const flat  = text.replace(/\n/g, ' ');
    const parts = [];
    let i = 0, wi = 0;
    while (i < flat.length) {
        if (/[a-zA-Z']/.test(flat[i])) {
            const start = i;
            while (i < flat.length && /[a-zA-Z']/.test(flat[i])) i++;
            parts.push({ kind: 'word', text: flat.slice(start, i), wi: wi++ });
        } else {
            const start = i;
            while (i < flat.length && !/[a-zA-Z']/.test(flat[i])) i++;
            parts.push({ kind: 'gap', text: flat.slice(start, i) });
        }
    }
    return parts;
}

function chooseBlanks(parts) {
    const candidates = parts.filter(
        p => p.kind === 'word' && p.text.length >= 2 && !STOP.has(p.text.toLowerCase())
    );
    const n = candidates.length <= 3 ? 1 : candidates.length <= 8 ? 2 : 3;
    return new Set(shuffle(candidates).slice(0, n).map(p => p.wi));
}

function renderBlank() {
    const s = blank.list[blank.index];
    if (!s) return;

    hideComplete('blank');
    blank.checked = false;
    $('blank-badge').textContent  = grammarLabel(s.grammar);
    $('blank-korean').textContent = s.korean;

    const parts    = tokenise(s.english);
    const blankWIs = chooseBlanks(parts);

    const wrap = $('blank-sentence');
    wrap.innerHTML = '';
    parts.forEach(p => {
        if (p.kind === 'gap') {
            wrap.appendChild(document.createTextNode(p.text));
        } else if (blankWIs.has(p.wi)) {
            const inp = document.createElement('input');
            inp.type           = 'text';
            inp.className      = 'blank-input';
            inp.dataset.answer = p.text;
            inp.style.width    = `${Math.max(52, p.text.length * 12)}px`;
            inp.autocomplete   = 'off';
            inp.autocorrect    = 'off';
            inp.autocapitalize = 'off';
            inp.spellcheck     = false;
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') checkBlanks(); });
            wrap.appendChild(inp);
        } else {
            wrap.appendChild(document.createTextNode(p.text));
        }
    });

    $('blank-result').innerHTML     = '';
    $('btn-check').style.display    = '';
    $('btn-show-ans').style.display = 'none';

    const curr = blank.index + 1, total = blank.list.length;
    $('blank-curr').textContent  = curr;
    $('blank-total').textContent = total;
    $('blank-fill').style.width  = `${(curr / total) * 100}%`;

    saveTab('blank', blank);

    const first = wrap.querySelector('.blank-input');
    if (first) requestAnimationFrame(() => first.focus());
}

function checkBlanks() {
    if (blank.checked) return;
    blank.checked = true;

    const inputs = Array.from(document.querySelectorAll('#blank-sentence .blank-input'));
    let allRight = true;
    const lines  = [];

    inputs.forEach(inp => {
        const user   = normalize(inp.value);
        const answer = normalize(inp.dataset.answer);
        const ok     = user !== '' && user === answer;
        if (!ok) allRight = false;
        inp.classList.add(ok ? 'correct' : 'wrong');
        inp.readOnly = true;
        lines.push(ok
            ? `<div class="result-correct">✅ <strong>${escHtml(inp.dataset.answer)}</strong> — 정답!</div>`
            : `<div class="result-wrong">❌ 내 답: <strong>${escHtml(inp.value) || '(빈칸)'}</strong> → 정답: <strong>${escHtml(inp.dataset.answer)}</strong></div>`
        );
    });

    $('blank-result').innerHTML = lines.join('');
    if (!allRight) $('btn-show-ans').style.display = '';
}

function showAnswer() {
    const s = blank.list[blank.index];
    if (!s) return;
    $('blank-result').innerHTML +=
        `<div class="result-full-answer"><strong>전체 문장:</strong><br>${escHtml(s.english)}</div>`;
    $('btn-show-ans').style.display = 'none';
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
