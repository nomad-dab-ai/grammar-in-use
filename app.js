'use strict';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

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
let clipsMapping = {};
let cats         = [];   // ordered list of grammar categories

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

const normalize = s => s.trim().toLowerCase().replace(/[^a-z]/g, '');

function filterSentences(grammars) {
    if (!grammars || grammars.size === 0) return [...sentences];
    return sentences.filter(s => grammars.has(s.grammar));
}

function grammarLabel(cat) {
    const idx = cats.indexOf(cat);
    return idx >= 0 ? `${idx + 1}. ${cat}` : cat;
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
        initGrammarSelectors();
        initTabNav();
        initAudio();
        initRecall();
        initBlank();
    } catch (err) {
        document.querySelector('.app-main').innerHTML =
            `<div class="card"><p style="color:var(--error)">데이터 로딩 실패: ${err.message}</p></div>`;
    }
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

        allChk.checked = true;

        cats.forEach((cat, i) => {
            const label = document.createElement('label');
            label.className = 'grammar-item';
            const chk = document.createElement('input');
            chk.type    = 'checkbox';
            chk.value   = cat;
            chk.checked = true;
            const span = document.createElement('span');
            span.textContent = `${i + 1}. ${cat}`;
            label.append(chk, span);
            list.appendChild(label);
            chk.addEventListener('change', () => syncGrammarState(prefix, tab, allChk, list, btn, reset));
        });

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

// ─────────────────────────────────────────────────────────────
// TAB 1 – Audio (쉐도잉 연습)
// ─────────────────────────────────────────────────────────────

function stopAudio() {
    const p = $('audio-player');
    if (!p.paused) p.pause();
    const btn = $('btn-listen');
    if (btn) { btn.textContent = '▶ 문장 듣기'; btn.classList.remove('playing'); }
}

function playClip(clipPath) {
    stopAudio();
    const p   = $('audio-player');
    const btn = $('btn-listen');
    btn.textContent = '⏸ 정지';
    btn.classList.add('playing');

    const url = '/clips/' + clipPath.split('/').map(encodeURIComponent).join('/');
    p.src = url;
    p.load();
    p.play().catch(() => {
        stopAudio();
        $('audio-status').textContent = '⚠️ 재생 실패';
    });
    p.addEventListener('ended', () => stopAudio(), { once: true });
}

function initAudio() {
    $('audio-shuffle').addEventListener('change', resetAudio);

    $('btn-audio-reveal').addEventListener('click', () => {
        $('audio-reveal').classList.add('visible');
        $('btn-audio-reveal').style.display = 'none';
    });

    $('btn-listen').addEventListener('click', () => {
        const p = $('audio-player');
        if (!p.paused) { stopAudio(); return; }
        const clipPath = $('btn-listen').dataset.clip;
        if (clipPath) playClip(clipPath);
    });

    $('btn-audio-prev').addEventListener('click', () => { stopAudio(); stepAudio(-1); });
    $('btn-audio-next').addEventListener('click', () => { stopAudio(); stepAudio(1); });

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
    if (next < 0 || next >= audioTab.list.length) return;
    audioTab.index = next;
    renderAudio();
}

function getClip(s) {
    const clips = clipsMapping[s.grammar] || [];
    const groupSentences = sentences.filter(x => x.grammar === s.grammar);
    const idx = groupSentences.findIndex(x => x.number === s.number);
    return idx >= 0 && idx < clips.length ? clips[idx] : null;
}

function renderAudio() {
    const s = audioTab.list[audioTab.index];
    if (!s) return;

    $('audio-reveal').classList.remove('visible');
    $('btn-audio-reveal').style.display = '';

    $('audio-badge').textContent   = grammarLabel(s.grammar);
    $('audio-korean').textContent  = s.korean;
    $('audio-english').textContent = s.english;

    const clip = getClip(s);
    const btn  = $('btn-listen');
    if (clip) {
        btn.disabled      = false;
        btn.dataset.clip  = clip;
        $('audio-status').textContent = '';
    } else {
        btn.disabled = true;
        delete btn.dataset.clip;
        $('audio-status').textContent = '음원 없음';
    }
    btn.textContent = '▶ 문장 듣기';
    btn.classList.remove('playing');

    const curr = audioTab.index + 1, total = audioTab.list.length;
    $('audio-curr').textContent  = curr;
    $('audio-total').textContent = total;
    $('audio-fill').style.width  = `${(curr / total) * 100}%`;
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
        if (s) {
            const clip = getClip(s);
            if (clip) {
                const p   = $('audio-player');
                const url = '/clips/' + clip.split('/').map(encodeURIComponent).join('/');
                p.src = url;
                p.load();
                p.play().catch(() => {});
            }
        }
    });
    $('btn-recall-prev').addEventListener('click', () => stepRecall(-1));
    $('btn-recall-next').addEventListener('click', () => stepRecall(1));

    resetRecall();
}

function resetRecall() {
    const rand = $('recall-shuffle').checked;
    let list   = filterSentences(recall.grammars);
    if (rand) list = shuffle(list);
    recall.list  = list;
    recall.index = 0;
    renderRecall();
}

function stepRecall(dir) {
    const next = recall.index + dir;
    if (next < 0 || next >= recall.list.length) return;
    recall.index = next;
    renderRecall();
}

function renderRecall() {
    const s = recall.list[recall.index];
    if (!s) return;

    $('recall-reveal').classList.remove('visible');
    $('btn-reveal').style.display = '';

    $('recall-badge').textContent   = grammarLabel(s.grammar);
    $('recall-korean').textContent  = s.korean;
    $('recall-english').textContent = s.english;

    const curr = recall.index + 1, total = recall.list.length;
    $('recall-curr').textContent  = curr;
    $('recall-total').textContent = total;
    $('recall-fill').style.width  = `${(curr / total) * 100}%`;
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

    resetBlank();
}

function resetBlank() {
    blank.list  = shuffle(filterSentences(blank.grammars));
    blank.index = 0;
    renderBlank();
}

function stepBlank(dir) {
    const next = blank.index + dir;
    if (next < 0 || next >= blank.list.length) return;
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
            ? `<div class="result-correct">✅ <strong>${inp.dataset.answer}</strong> — 정답!</div>`
            : `<div class="result-wrong">❌ 내 답: <strong>${inp.value || '(빈칸)'}</strong> → 정답: <strong>${inp.dataset.answer}</strong></div>`
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
