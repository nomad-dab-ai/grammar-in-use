'use strict';

let allSentences = [];
let clipsMapping = {};
let currentGrammar = null;

const player = document.getElementById('preview-player');

async function init() {
    try {
        [allSentences, clipsMapping] = await Promise.all([
            fetch('/api/sentences').then(r => r.json()),
            fetch('/api/clips').then(r => r.json()),
        ]);
        renderGrammarList();
        await loadVoices();
    } catch (e) {
        alert('데이터 로딩 실패: ' + e.message);
    }
}

// ── API Key & Voices ─────────────────────────────────────

async function saveApiKey() {
    const key = document.getElementById('api-key-input').value.trim();
    if (!key) return;
    const statusEl = document.getElementById('key-status');
    statusEl.textContent = '저장 중…';
    statusEl.className = '';
    try {
        const res = await fetch('/api/admin/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ elevenlabs_api_key: key }),
        });
        const data = await res.json();
        if (data.ok) {
            statusEl.textContent = '✅ 저장됨';
            statusEl.className = 'ok';
            document.getElementById('api-key-input').value = '';
            await loadVoices();
        } else {
            statusEl.textContent = '❌ ' + data.error;
            statusEl.className = 'err';
        }
    } catch (e) {
        statusEl.textContent = '❌ ' + e.message;
        statusEl.className = 'err';
    }
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 3000);
}

async function loadVoices() {
    const sel = document.getElementById('voice-select');
    const btn = document.getElementById('btn-load-voices');
    btn.disabled = true;
    btn.textContent = '⏳';

    try {
        const res  = await fetch('/api/admin/elevenlabs-voices');
        const data = await res.json();
        if (data.ok && data.voices.length > 0) {
            const prev = sel.value;
            sel.innerHTML = '<option value="">목소리 선택</option>';
            data.voices.forEach(v => {
                const opt  = document.createElement('option');
                opt.value  = v.id;
                const acc  = v.labels?.accent || v.labels?.description || '';
                opt.textContent = acc ? `${v.name} (${acc})` : v.name;
                sel.appendChild(opt);
            });
            if (prev) sel.value = prev;
        }
    } catch (_) {}

    btn.disabled = false;
    btn.textContent = '🔄 불러오기';
}

// ── Grammar sidebar ──────────────────────────────────────

function renderGrammarList() {
    const grammars = [...new Set(allSentences.map(s => s.grammar))];
    const container = document.getElementById('grammar-list');
    container.innerHTML = '';
    grammars.forEach(g => {
        const btn = document.createElement('button');
        btn.className = 'grammar-btn';
        btn.textContent = g;
        btn.addEventListener('click', () => selectGrammar(g));
        container.appendChild(btn);
    });
}

function selectGrammar(grammar) {
    flushCurrentEdits();
    currentGrammar = grammar;

    document.querySelectorAll('.grammar-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent === grammar);
    });
    document.getElementById('grammar-title').textContent = grammar;
    document.getElementById('btn-save').disabled = false;

    renderTable(grammar);
}

// ── Table rendering ──────────────────────────────────────

function getClip(s) {
    const clips = clipsMapping[s.grammar] || [];
    const group = allSentences.filter(x => x.grammar === s.grammar);
    const idx = group.findIndex(x => x.number === s.number);
    return (idx >= 0 && idx < clips.length) ? clips[idx] : null;
}

function renderTable(grammar) {
    const sentences = allSentences.filter(s => s.grammar === grammar);
    const tbody = document.getElementById('sentences-body');
    tbody.innerHTML = '';

    sentences.forEach(s => {
        const clip = getClip(s);
        const tr = document.createElement('tr');
        tr.dataset.grammar = s.grammar;
        tr.dataset.number  = s.number;

        // # cell
        const tdNum = document.createElement('td');
        tdNum.className = 'col-num';
        tdNum.textContent = s.number;
        tr.appendChild(tdNum);

        // Korean cell
        tr.appendChild(makeTextCell(s.korean, 'edit-ta edit-korean'));

        // English cell
        tr.appendChild(makeTextCell(s.english, 'edit-ta edit-english'));

        // Clip cell
        tr.appendChild(makeClipCell(s, clip));

        tbody.appendChild(tr);
    });
}

function makeTextCell(value, className) {
    const td = document.createElement('td');
    const ta = document.createElement('textarea');
    ta.className = className;
    ta.value = value;
    ta.rows = 3;
    ta.addEventListener('input', autoResize);
    td.appendChild(ta);
    return td;
}

function autoResize() {
    this.style.height = 'auto';
    this.style.height = this.scrollHeight + 'px';
}

function makeClipCell(s, clip) {
    const td = document.createElement('td');
    td.className = 'col-clip';

    const div = document.createElement('div');
    div.className = 'clip-cell';

    // Clip name
    const nameEl = document.createElement('div');
    if (clip) {
        nameEl.className = 'clip-name';
        nameEl.textContent = clip.split('/').pop();
    } else {
        nameEl.className = 'clip-none';
        nameEl.textContent = '음원 없음';
    }
    div.appendChild(nameEl);

    // Actions row
    const actions = document.createElement('div');
    actions.className = 'clip-actions';

    if (clip) {
        const btnPlay = document.createElement('button');
        btnPlay.className = 'btn-play';
        btnPlay.textContent = '▶';
        btnPlay.title = '미리 듣기';
        btnPlay.addEventListener('click', () => {
            player.src = '/clips/' + clip;
            player.play();
        });
        actions.appendChild(btnPlay);
    }

    // Generate button
    const btnGen = document.createElement('button');
    btnGen.className = 'btn-generate';
    btnGen.textContent = '🎤 생성';
    btnGen.title = '영어 텍스트로 음원 자동 생성';
    btnGen.addEventListener('click', () => handleGenerate(s, div, nameEl, actions, btnGen));
    actions.appendChild(btnGen);

    // Upload label
    const label = document.createElement('label');
    label.className = 'btn-upload-label';
    label.textContent = '📁 업로드';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.mp3,audio/*';
    fileInput.addEventListener('change', () => handleUpload(fileInput, s, div, nameEl, actions));

    label.appendChild(fileInput);
    actions.appendChild(label);

    // Status
    const status = document.createElement('div');
    status.className = 'upload-status';
    div.appendChild(actions);
    div.appendChild(status);

    td.appendChild(div);
    return td;
}

// ── Generate ─────────────────────────────────────────────

async function handleGenerate(s, clipDiv, nameEl, actions, btnGen) {
    // 현재 편집 중인 영어 텍스트 사용
    const tr = document.querySelector(`tr[data-grammar="${CSS.escape(s.grammar)}"][data-number="${s.number}"]`);
    const text = tr ? tr.querySelector('.edit-english').value : s.english;

    const voice = document.getElementById('voice-select').value;
    const useEL = !!voice;  // 목소리가 선택돼 있으면 ElevenLabs, 아니면 macOS TTS

    const statusEl = clipDiv.querySelector('.upload-status');
    statusEl.className = 'upload-status';
    statusEl.textContent = useEL ? 'ElevenLabs 생성 중…' : 'macOS TTS 생성 중…';
    btnGen.disabled = true;

    try {
        const res = await fetch('/api/admin/generate-clip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grammar: s.grammar, number: s.number, text, voice, elevenlabs: useEL }),
        });
        const data = await res.json();

        if (data.ok) {
            if (!clipsMapping[s.grammar]) clipsMapping[s.grammar] = [];
            const group = allSentences.filter(x => x.grammar === s.grammar);
            const idx = group.findIndex(x => x.number === s.number);
            while (clipsMapping[s.grammar].length <= idx) clipsMapping[s.grammar].push(null);
            clipsMapping[s.grammar][idx] = data.path;

            nameEl.className = 'clip-name';
            nameEl.textContent = data.path.split('/').pop();

            const existingPlay = actions.querySelector('.btn-play');
            const playFn = () => { player.src = '/clips/' + data.path; player.play(); };
            if (!existingPlay) {
                const btnPlay = document.createElement('button');
                btnPlay.className = 'btn-play';
                btnPlay.textContent = '▶';
                btnPlay.addEventListener('click', playFn);
                actions.insertBefore(btnPlay, actions.firstChild);
            } else {
                existingPlay.onclick = playFn;
            }

            statusEl.className = 'upload-status ok';
            statusEl.textContent = '✅ 생성 완료';
        } else {
            statusEl.className = 'upload-status err';
            statusEl.textContent = '❌ ' + data.error;
        }
    } catch (e) {
        statusEl.className = 'upload-status err';
        statusEl.textContent = '❌ ' + e.message;
    }

    btnGen.disabled = false;
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'upload-status'; }, 3000);
}

// ── Upload ───────────────────────────────────────────────

async function handleUpload(input, s, clipDiv, nameEl, actions) {
    const file = input.files[0];
    if (!file) return;

    const statusEl = clipDiv.querySelector('.upload-status');
    statusEl.className = 'upload-status';
    statusEl.textContent = '업로드 중…';

    try {
        const base64 = await readAsBase64(file);

        const res = await fetch('/api/admin/upload-clip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grammar: s.grammar, number: s.number, data: base64 }),
        });
        const data = await res.json();

        if (data.ok) {
            // Update local mapping
            if (!clipsMapping[s.grammar]) clipsMapping[s.grammar] = [];
            const group = allSentences.filter(x => x.grammar === s.grammar);
            const idx = group.findIndex(x => x.number === s.number);
            while (clipsMapping[s.grammar].length <= idx) clipsMapping[s.grammar].push(null);
            clipsMapping[s.grammar][idx] = data.path;

            // Refresh clip cell
            nameEl.className = 'clip-name';
            nameEl.textContent = data.path.split('/').pop();

            // Add play button if it didn't exist
            if (!actions.querySelector('.btn-play')) {
                const btnPlay = document.createElement('button');
                btnPlay.className = 'btn-play';
                btnPlay.textContent = '▶';
                btnPlay.addEventListener('click', () => {
                    player.src = '/clips/' + data.path;
                    player.play();
                });
                actions.insertBefore(btnPlay, actions.firstChild);
            } else {
                actions.querySelector('.btn-play').onclick = () => {
                    player.src = '/clips/' + data.path;
                    player.play();
                };
            }

            statusEl.className = 'upload-status ok';
            statusEl.textContent = '✅ 완료';
        } else {
            statusEl.className = 'upload-status err';
            statusEl.textContent = '❌ ' + data.error;
        }
    } catch (e) {
        statusEl.className = 'upload-status err';
        statusEl.textContent = '❌ ' + e.message;
    }

    setTimeout(() => statusEl.textContent = '', 3000);
}

function readAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = e => resolve(e.target.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ── Save sentences ───────────────────────────────────────

function flushCurrentEdits() {
    document.querySelectorAll('#sentences-body tr').forEach(tr => {
        const g = tr.dataset.grammar;
        const n = tr.dataset.number;
        const s = allSentences.find(x => x.grammar === g && x.number === n);
        if (!s) return;
        const taK = tr.querySelector('.edit-korean');
        const taE = tr.querySelector('.edit-english');
        if (taK) s.korean  = taK.value;
        if (taE) s.english = taE.value;
    });
}

async function saveAll() {
    flushCurrentEdits();

    const msgEl = document.getElementById('save-msg');
    msgEl.className = '';
    msgEl.textContent = '저장 중…';

    try {
        const res = await fetch('/api/admin/sentences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(allSentences),
        });
        const data = await res.json();

        if (data.ok) {
            msgEl.className = 'ok';
            msgEl.textContent = '✅ 저장 완료';
        } else {
            msgEl.className = 'err';
            msgEl.textContent = '❌ ' + data.error;
        }
    } catch (e) {
        msgEl.className = 'err';
        msgEl.textContent = '❌ ' + e.message;
    }

    setTimeout(() => { msgEl.textContent = ''; msgEl.className = ''; }, 3000);
}

// ── Boot ─────────────────────────────────────────────────

document.getElementById('btn-save').addEventListener('click', saveAll);
document.getElementById('btn-save-key').addEventListener('click', saveApiKey);
document.getElementById('btn-load-voices').addEventListener('click', loadVoices);
document.addEventListener('DOMContentLoaded', init);
