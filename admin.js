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
    return clipsMapping[`${s.grammar}||${s.number}`] || null;
}

function renderTable(grammar) {
    const sentences = allSentences.filter(s => s.grammar === grammar);
    const tbody = document.getElementById('sentences-body');
    tbody.innerHTML = '';

    sentences.forEach(s => {
        tbody.appendChild(makeRow(s));
    });

    // 문장 추가 버튼 행
    const trAdd = document.createElement('tr');
    trAdd.id = 'row-add-btn';
    const tdAdd = document.createElement('td');
    tdAdd.colSpan = 4;
    tdAdd.style.textAlign = 'center';
    tdAdd.style.padding = '10px';
    const btnAdd = document.createElement('button');
    btnAdd.className = 'btn-add-row';
    btnAdd.textContent = '＋ 문장 추가';
    btnAdd.addEventListener('click', () => addRow(grammar));
    tdAdd.appendChild(btnAdd);
    trAdd.appendChild(tdAdd);
    tbody.appendChild(trAdd);
}

function makeRow(s) {
    const clip = getClip(s);
    const tr = document.createElement('tr');
    tr.dataset.grammar = s.grammar;
    tr.dataset.number  = s.number;

    // # cell with delete button
    const tdNum = document.createElement('td');
    tdNum.className = 'col-num';
    const numWrap = document.createElement('div');
    numWrap.style.display = 'flex';
    numWrap.style.flexDirection = 'column';
    numWrap.style.alignItems = 'center';
    numWrap.style.gap = '4px';
    const numSpan = document.createElement('span');
    numSpan.textContent = s.number;
    const btnDel = document.createElement('button');
    btnDel.className = 'btn-delete-row';
    btnDel.textContent = '✕';
    btnDel.title = '이 문장 삭제';
    btnDel.addEventListener('click', () => deleteRow(s));
    numWrap.appendChild(numSpan);
    numWrap.appendChild(btnDel);
    tdNum.appendChild(numWrap);
    tr.appendChild(tdNum);

    // Korean cell
    tr.appendChild(makeTextCell(s.korean, 'edit-ta edit-korean'));

    // English cell
    tr.appendChild(makeTextCell(s.english, 'edit-ta edit-english'));

    // Clip cell
    tr.appendChild(makeClipCell(s, clip));

    return tr;
}

function addRow(grammar) {
    flushCurrentEdits();
    const existing = allSentences.filter(s => s.grammar === grammar);
    const maxNum = existing.reduce((m, s) => Math.max(m, parseInt(s.number) || 0), 0);
    const newS = { grammar, number: String(maxNum + 1), korean: '', english: '' };
    const insertIdx = allSentences.findIndex(s => s.grammar === grammar);
    if (insertIdx === -1) {
        allSentences.push(newS);
    } else {
        const lastIdx = allSentences.reduce((m, s, i) => s.grammar === grammar ? i : m, insertIdx);
        allSentences.splice(lastIdx + 1, 0, newS);
    }
    renderTable(grammar);
}

function deleteRow(s) {
    if (!confirm(`문장 ${s.number}번을 삭제할까요?\n"${s.korean || s.english || '(빈 문장)'}"`)) return;
    const idx = allSentences.findIndex(x => x.grammar === s.grammar && x.number === s.number);
    if (idx !== -1) allSentences.splice(idx, 1);
    // 번호는 재정렬하지 않는다 — 음원 매핑이 "문법||번호" 키에 묶여 있어서
    // 재정렬하면 뒤 문장들의 음원이 전부 어긋난다. 번호에 빈 자리가 생겨도 무방.
    renderTable(s.grammar);
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
            clipsMapping[`${s.grammar}||${s.number}`] = data.path;

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
            clipsMapping[`${s.grammar}||${s.number}`] = data.path;

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
