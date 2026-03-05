/**
 * app.js – Apparel AI Generator
 * ============================================================
 * Architecture:
 *   - processImageAPI(...)  → Swap this for a real API call
 *   - Scene patterns loaded from /api/scenes (scene/*.txt files)
 *   - Custom user patterns stored in localStorage
 * ============================================================
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// 1. CONSTANTS
// ─────────────────────────────────────────────────────────────

const STORAGE_KEY = 'apparelAI_customPatterns';
const API_BASE = '';   // same origin – change if server is on a different port


// ─────────────────────────────────────────────────────────────
// 2. APPLICATION STATE
// ─────────────────────────────────────────────────────────────

const state = {
  /** Blob URL of the uploaded source image */
  uploadedImageURL: null,
  /** Original File object */
  uploadedFile: null,
  /** Currently selected pattern ID (single selection) */
  selectedPatternId: null,
  /** All patterns (default + user-added) */
  patterns: [],
  /** URL of the generated result image */
  resultImageURL: null,
  /** Whether generation is in progress */
  isGenerating: false,
};


// ─────────────────────────────────────────────────────────────
// 3. DOM REFERENCES
// ─────────────────────────────────────────────────────────────

const el = {
  uploadZone: document.getElementById('uploadZone'),
  fileInput: document.getElementById('fileInput'),
  uploadIdle: document.getElementById('uploadIdle'),
  uploadPreview: document.getElementById('uploadPreview'),
  previewThumb: document.getElementById('previewThumb'),
  previewFileName: document.getElementById('previewFileName'),
  btnChangeImage: document.getElementById('btnChangeImage'),

  tagContainer: document.getElementById('tagContainer'),

  patternInput: document.getElementById('patternInput'),
  btnAddPattern: document.getElementById('btnAddPattern'),
  addHint: document.getElementById('addHint'),

  btnGenerate: document.getElementById('btnGenerate'),
  btnGenerateText: document.getElementById('btnGenerateText'),

  previewEmpty: document.getElementById('previewEmpty'),
  previewLoading: document.getElementById('previewLoading'),
  previewResult: document.getElementById('previewResult'),
  resultImage: document.getElementById('resultImage'),
  resultMetadata: document.getElementById('resultMetadata'),
  loadingSubText: document.getElementById('loadingSubText'),
  loadingBarFill: document.getElementById('loadingBarFill'),

  btnDownload: document.getElementById('btnDownload'),
  toastContainer: document.getElementById('toastContainer'),
};


// ─────────────────────────────────────────────────────────────
// 4. AI INTEGRATION LAYER
//    ✅ Replace the body of this function with your real API call.
//    The function receives the raw File and the merged prompt string.
//    It must return a URL (string) pointing to the result image.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 4. AI INTEGRATION LAYER
//    server.py が Gemini API へのプロキシ役を担う。
//    実APIを別サービスに切り替える場合は processImageAPI 内の
//    fetch 先エンドポイントと payload 形式を変更するだけでよい。
// ─────────────────────────────────────────────────────────────

/** File → base64 文字列（data URL prefix なし） */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** base64 + mimeType → Blob URL */
function base64ToObjectURL(b64, mimeType) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

/**
 * アップロード画像とプロンプトを Gemini API（サーバー経由）で処理し、
 * 生成画像の Blob URL を返す。
 *
 * @param {File}   imageFile   - アップロードされたアパレル画像
 * @param {string} promptText  - シーンファイルから読み込んだプロンプト
 * @returns {Promise<string>}  - 生成画像の Blob URL
 */
async function processImageAPI(imageFile, promptText) {
  // ── ステップ1: 画像を base64 に変換 ────────────────────
  updateLoadingProgress(15, '画像を変換中…');
  const imageBase64 = await fileToBase64(imageFile);
  const mimeType = imageFile.type || 'image/jpeg';

  // ── ステップ2: サーバー経由で Gemini API へ送信 ────────
  updateLoadingProgress(30, 'Gemini API にリクエスト送信中…');

  const response = await fetch(`${API_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64, mimeType, prompt: promptText }),
  });

  updateLoadingProgress(80, 'AIが画像を生成中…');

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(err.error ?? `サーバーエラー: HTTP ${response.status}`);
  }

  // ── ステップ3: 結果を Blob URL に変換 ──────────────────
  updateLoadingProgress(95, '結果を取得中…');
  const data = await response.json();
  const resultURL = base64ToObjectURL(data.imageBase64, data.mimeType ?? 'image/png');

  updateLoadingProgress(100, '完了！');
  return resultURL;
}


// ─────────────────────────────────────────────────────────────
// 5. SCENE FILE FETCHING
// ─────────────────────────────────────────────────────────────

/**
 * Fetch the list of scene names from the server API.
 * @returns {Promise<string[]>} e.g. ['cafe', 'studio']
 */
async function fetchSceneNames() {
  const res = await fetch(`${API_BASE}/api/scenes`);
  if (!res.ok) throw new Error(`Failed to load scenes: ${res.status}`);
  return res.json();
}

/**
 * Fetch the prompt text for a given scene name.
 * @param {string} name - scene filename without .txt
 * @returns {Promise<string>}
 */
async function fetchScenePrompt(name) {
  const res = await fetch(`${API_BASE}/api/scene/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`Failed to load scene "${name}": ${res.status}`);
  return res.text();
}

// ─────────────────────────────────────────────────────────────
// 6. PATTERN MANAGEMENT
// ─────────────────────────────────────────────────────────────

/**
 * Load scene patterns from the API, then merge with user-added patterns.
 * Scene files take precedence; user custom patterns are appended.
 */
async function loadPatterns() {
  // User-added custom patterns from localStorage
  let customPatterns = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) customPatterns = JSON.parse(raw);
  } catch (_) { /* ignore */ }

  // Fetch scene file names from server
  let sceneNames = [];
  try {
    sceneNames = await fetchSceneNames();
  } catch (err) {
    console.warn('Could not load scene list from server:', err);
    showToast('シーンファイルの読み込みに失敗しました。サーバーを確認してください。', 'error');
  }

  // Build scene patterns (prompt content is lazy-loaded at generation time)
  const scenePatterns = sceneNames.map((name) => ({
    id: `scene_${name}`,
    label: name,           // filename without extension = display label
    prompt: null,          // loaded on demand when generating
    isScene: true,
    sceneName: name,
    isDefault: false,
  }));

  // Merge: scene files first, then custom user-added patterns
  //   (skip custom if a scene with the same label already exists)
  const sceneLabels = new Set(scenePatterns.map((p) => p.label));
  const filteredCustom = customPatterns.filter((p) => !sceneLabels.has(p.label));

  state.patterns = [...scenePatterns, ...filteredCustom];
}

function saveUserPatterns() {
  const userPatterns = state.patterns.filter((p) => !p.isScene);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(userPatterns));
}

function addPattern(label) {
  label = label.trim();
  if (!label) {
    showHint('パターン名を入力してください。', true);
    return false;
  }
  if (label.length > 80) {
    showHint('80文字以内で入力してください。', true);
    return false;
  }
  if (state.patterns.find((p) => p.label === label)) {
    showHint('同じ名前のパターンが既に存在します。', true);
    return false;
  }

  const newPattern = {
    id: `user_${Date.now()}`,
    label,
    prompt: label,   // For custom patterns, label is used as prompt text
    isScene: false,
    isDefault: false,
  };
  state.patterns.push(newPattern);
  saveUserPatterns();
  renderTags();
  showHint('');
  showToast(`「${label}」を追加しました`, 'success');
  return true;
}

function deletePattern(id) {
  const p = state.patterns.find((q) => q.id === id);
  if (p?.isScene) {
    showToast('シーンファイルはアプリから削除できません（scene/ フォルダで管理してください）', 'info');
    return;
  }
  state.patterns = state.patterns.filter((q) => q.id !== id);
  if (state.selectedPatternId === id) state.selectedPatternId = null;
  saveUserPatterns();
  renderTags();
  updateGenerateButton();
}


// ─────────────────────────────────────────────────────────────
// 6. RENDER HELPERS
// ─────────────────────────────────────────────────────────────

function renderTags() {
  el.tagContainer.innerHTML = '';

  if (state.patterns.length === 0) {
    el.tagContainer.innerHTML =
      '<p style="font-size:0.82rem;color:var(--text-muted)">scene/ フォルダにテキストファイルがありません</p>';
    return;
  }

  state.patterns.forEach((pattern) => {
    const isSelected = state.selectedPatternId === pattern.id;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tag-btn${isSelected ? ' selected' : ''}`;
    btn.dataset.id = pattern.id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(isSelected));
    btn.setAttribute(
      'title',
      pattern.isScene
        ? `📄 scene/${pattern.sceneName}.txt`
        : (pattern.prompt ?? pattern.label)
    );

    // Scene file icon
    if (pattern.isScene) {
      const icon = document.createElement('span');
      icon.textContent = '📄';
      icon.style.fontSize = '0.75rem';
      btn.appendChild(icon);
    }

    const labelSpan = document.createElement('span');
    labelSpan.textContent = pattern.label;
    btn.appendChild(labelSpan);

    // User-added (non-scene) tags get a delete button
    if (!pattern.isScene) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'tag-delete';
      del.innerHTML = '&times;';
      del.setAttribute('aria-label', `「${pattern.label}」を削除`);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deletePattern(pattern.id);
      });
      btn.appendChild(del);
    }

    btn.addEventListener('click', () => selectPattern(pattern.id));
    el.tagContainer.appendChild(btn);
  });
}

function selectPattern(id) {
  // Single-select: deselect previous, select new
  state.selectedPatternId = state.selectedPatternId === id ? null : id;
  // Re-render all tags to reflect the change
  renderTags();
  updateGenerateButton();
}

function updateGenerateButton() {
  const canGenerate =
    state.uploadedFile !== null &&
    state.selectedPatternId !== null &&
    !state.isGenerating;

  el.btnGenerate.disabled = !canGenerate;

  if (state.isGenerating) {
    el.btnGenerateText.textContent = '生成中…';
  } else if (!state.uploadedFile) {
    el.btnGenerateText.textContent = '画像をアップロードしてください';
  } else if (!state.selectedPatternId) {
    el.btnGenerateText.textContent = 'シーンを選択してください';
  } else {
    el.btnGenerateText.textContent = 'AIで画像生成';
  }
}

function showPreviewState(stateName) {
  el.previewEmpty.hidden = stateName !== 'empty';
  el.previewLoading.hidden = stateName !== 'loading';
  el.previewResult.hidden = stateName !== 'result';
}

function updateLoadingProgress(pct, text) {
  el.loadingBarFill.style.width = `${pct}%`;
  if (text) el.loadingSubText.textContent = text;
}

function showHint(msg, isError = false) {
  el.addHint.textContent = msg;
  el.addHint.hidden = !msg;
  el.addHint.style.color = isError ? 'var(--error)' : 'var(--success)';
}

/** Build the result metadata bar */
function buildMetadata(patternLabels) {
  el.resultMetadata.innerHTML = `
    <span>📅 ${new Date().toLocaleString('ja-JP')}</span>
    <span>🎨 ${patternLabels.join(' + ')}</span>
    <span>📁 ${state.uploadedFile?.name ?? '—'}</span>
  `;
}


// ─────────────────────────────────────────────────────────────
// 7. UPLOAD HANDLING
// ─────────────────────────────────────────────────────────────

function handleFileSelect(file) {
  if (!file) return;

  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) {
    showToast('JPG / PNG / WEBP 形式の画像を選択してください', 'error');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showToast('ファイルサイズは20MB以下にしてください', 'error');
    return;
  }

  // Revoke previous object URL to avoid memory leaks
  if (state.uploadedImageURL) URL.revokeObjectURL(state.uploadedImageURL);

  state.uploadedFile = file;
  state.uploadedImageURL = URL.createObjectURL(file);

  el.previewThumb.src = state.uploadedImageURL;
  el.previewFileName.textContent = file.name;
  el.uploadIdle.hidden = true;
  el.uploadPreview.hidden = false;

  updateGenerateButton();
  showToast(`「${file.name}」をアップロードしました`, 'success');
}

function resetUpload() {
  if (state.uploadedImageURL) URL.revokeObjectURL(state.uploadedImageURL);
  state.uploadedFile = null;
  state.uploadedImageURL = null;
  el.previewThumb.src = '';
  el.previewFileName.textContent = '';
  el.fileInput.value = '';
  el.uploadIdle.hidden = false;
  el.uploadPreview.hidden = true;
  updateGenerateButton();
}


// ─────────────────────────────────────────────────────────────
// 8. GENERATION FLOW
// ─────────────────────────────────────────────────────────────

async function handleGenerate() {
  if (state.isGenerating) return;

  // Single selected pattern
  const pattern = state.patterns.find((p) => p.id === state.selectedPatternId);
  if (!pattern) return;

  state.isGenerating = true;
  updateGenerateButton();
  showPreviewState('loading');
  updateLoadingProgress(5, 'プロンプトを読み込み中…');
  el.btnDownload.disabled = true;

  // Fetch scene prompt content if not yet loaded
  if (pattern.isScene && pattern.prompt === null) {
    try {
      pattern.prompt = await fetchScenePrompt(pattern.sceneName);
    } catch (err) {
      console.error(err);
      showToast(`「${pattern.label}」のプロンプト読み込みに失敗しました`, 'error');
      showPreviewState('empty');
      state.isGenerating = false;
      updateGenerateButton();
      return;
    }
  }

  const combinedPrompt = pattern.prompt ?? pattern.label;
  const patternLabels = [pattern.label];

  try {
    const resultURL = await processImageAPI(state.uploadedFile, combinedPrompt);

    state.resultImageURL = resultURL;
    el.resultImage.src = resultURL;
    buildMetadata(patternLabels);

    showPreviewState('result');
    el.btnDownload.disabled = false;
    showToast('画像の生成が完了しました 🎉', 'success');
  } catch (err) {
    console.error('Generation error:', err);
    showPreviewState('empty');
    showToast('生成中にエラーが発生しました。再試行してください。', 'error');
  } finally {
    state.isGenerating = false;
    updateGenerateButton();
  }
}


// ─────────────────────────────────────────────────────────────
// 9. DOWNLOAD
// ─────────────────────────────────────────────────────────────

async function handleDownload() {
  if (!state.resultImageURL) return;

  // Build filename: <original_name_without_ext>_YYYY-MM-DDTHH-MM-SS.jpg
  const originalBase = state.uploadedFile
    ? state.uploadedFile.name.replace(/\.[^.]+$/, '')   // strip extension
    : 'apparel';
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')   // safe for filenames
    .slice(0, 19);            // YYYY-MM-DDTHH-MM-SS
  const filename = `${originalBase}_${ts}.jpg`;

  try {
    // ── Load the result image into a canvas and export as JPEG ──
    const img = new Image();
    img.crossOrigin = 'anonymous';

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = state.resultImageURL;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');

    // Fill white background so transparent PNGs become white in JPEG
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    // Convert to JPEG blob (quality 0.92)
    const jpgBlob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92)
    );

    const blobURL = URL.createObjectURL(jpgBlob);
    const a = document.createElement('a');
    a.href = blobURL;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobURL);

    showToast(`「${filename}」をダウンロードしました`, 'success');
  } catch (err) {
    console.error('Download error:', err);
    // Fallback: open in new tab
    window.open(state.resultImageURL, '_blank');
    showToast('新しいタブで画像を開きました（JPG変換失敗）', 'info');
  }
}


// ─────────────────────────────────────────────────────────────
// 10. TOAST NOTIFICATIONS
// ─────────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${icons[type] ?? ''}</span><span>${message}</span>`;
  el.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('leaving');
    toast.addEventListener('animationend', () => toast.remove());
  }, 3200);
}


// ─────────────────────────────────────────────────────────────
// 11. UTILITY
// ─────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// ─────────────────────────────────────────────────────────────
// 12. EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function initEventListeners() {

  // ── Upload Zone ──
  el.uploadZone.addEventListener('click', (e) => {
    if (e.target === el.btnChangeImage) return; // handled separately
    el.fileInput.click();
  });
  el.uploadZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.fileInput.click();
    }
  });

  el.fileInput.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleFileSelect(e.target.files[0]);
  });

  el.btnChangeImage.addEventListener('click', (e) => {
    e.stopPropagation();
    resetUpload();
  });

  // Drag & Drop
  el.uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.uploadZone.classList.add('dragover');
  });
  el.uploadZone.addEventListener('dragleave', () => {
    el.uploadZone.classList.remove('dragover');
  });
  el.uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    el.uploadZone.classList.remove('dragover');
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  });

  // ── Add Pattern ──
  el.btnAddPattern.addEventListener('click', () => {
    const added = addPattern(el.patternInput.value);
    if (added) el.patternInput.value = '';
  });
  el.patternInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const added = addPattern(el.patternInput.value);
      if (added) el.patternInput.value = '';
    }
  });
  el.patternInput.addEventListener('input', () => showHint(''));

  // ── Generate ──
  el.btnGenerate.addEventListener('click', handleGenerate);

  // ── Download ──
  el.btnDownload.addEventListener('click', handleDownload);
}


// ─────────────────────────────────────────────────────────────
// 13. INITIALISE
// ─────────────────────────────────────────────────────────────

async function init() {
  showPreviewState('empty');
  initEventListeners();
  updateGenerateButton();

  // Load scene patterns asynchronously
  await loadPatterns();
  renderTags();
  updateGenerateButton();
}

document.addEventListener('DOMContentLoaded', init);
