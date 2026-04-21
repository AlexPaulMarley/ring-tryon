// Verification page
// -----------------
// Load an image, paint over regions to change, describe the change in text,
// click "Regenerate selected area". Posts {image, mask, prompt} to
// /api/inpaint which proxies to an image-gen provider server-side.
//
// History is kept in-memory this session. Each regeneration becomes a new
// history entry you can revert to with a tap.
//
// No build step. Works as a static page when deployed on Vercel — the
// serverless function at /api/inpaint.js handles the real API call.

const $ = (id) => document.getElementById(id);

const fileInput    = $('fileInput');
const loadSampleBtn= $('loadSampleBtn');
const baseImage    = $('baseImage');
const maskCanvas   = $('maskCanvas');
const stage        = $('stage');
const brushSize    = $('brushSize');
const undoBtn      = $('undoBtn');
const clearBtn     = $('clearBtn');
const promptEl     = $('prompt');
const regenBtn     = $('regenBtn');
const approveBtn   = $('approveBtn');
const statusEl     = $('status');
const histEl       = $('history');

const ctx = maskCanvas.getContext('2d');

// --- State ---
let history = [];      // [{ dataURL, label }]
let activeIdx = -1;
let strokes = [];      // stack of ImageData snapshots for undo
let painting = false;

// --- Mask canvas sizing ---
// Keep the canvas bitmap matched to the displayed image so strokes land where
// the user painted. Redo this whenever the image loads or the window resizes.
function fitCanvas() {
  const rect = stage.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  maskCanvas.width  = Math.round(rect.width  * ratio);
  maskCanvas.height = Math.round(rect.height * ratio);
  maskCanvas.style.width  = rect.width  + 'px';
  maskCanvas.style.height = rect.height + 'px';
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255, 100, 100, 0.55)';
  ctx.fillStyle = 'rgba(255, 100, 100, 0.55)';
}
window.addEventListener('resize', fitCanvas);

// --- Image loading ---
function loadImage(src, label = 'Loaded') {
  return new Promise((resolve, reject) => {
    baseImage.onload = () => {
      fitCanvas();
      clearMask();
      pushHistory(src, label);
      resolve();
    };
    baseImage.onerror = () => reject(new Error('Could not load image'));
    baseImage.src = src;
  });
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await loadImage(reader.result, file.name);
      setStatus('Ready. Paint regions to change, then describe.');
    } catch (e) {
      setStatus('Failed to load: ' + e.message, true);
    }
  };
  reader.readAsDataURL(file);
});

loadSampleBtn.addEventListener('click', async () => {
  // Simple on-the-fly sample so the UI is testable without an upload.
  const c = document.createElement('canvas');
  c.width = c.height = 768;
  const cx = c.getContext('2d');
  const g = cx.createLinearGradient(0, 0, 768, 768);
  g.addColorStop(0, '#2a2438'); g.addColorStop(1, '#0b0b12');
  cx.fillStyle = g; cx.fillRect(0, 0, 768, 768);
  cx.fillStyle = '#d4b46a';
  cx.beginPath(); cx.arc(384, 384, 120, 0, Math.PI * 2); cx.fill();
  cx.fillStyle = '#1a1a1a';
  cx.beginPath(); cx.arc(384, 384, 80, 0, Math.PI * 2); cx.fill();
  cx.fillStyle = '#e8f4ff';
  cx.beginPath(); cx.arc(384, 384, 40, 0, Math.PI * 2); cx.fill();
  await loadImage(c.toDataURL('image/png'), 'Sample');
  setStatus('Sample loaded. Paint the centre stone to replace it.');
});

// --- Mask painting (mouse + touch, single unified pointer events) ---
function pointerPos(e) {
  const rect = maskCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

maskCanvas.addEventListener('pointerdown', (e) => {
  painting = true;
  maskCanvas.setPointerCapture(e.pointerId);
  strokes.push(ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height));
  const { x, y } = pointerPos(e);
  const r = parseInt(brushSize.value, 10) / 2;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x, y);
});

maskCanvas.addEventListener('pointermove', (e) => {
  if (!painting) return;
  const { x, y } = pointerPos(e);
  ctx.lineWidth = parseInt(brushSize.value, 10);
  ctx.lineTo(x, y); ctx.stroke();
});

['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
  maskCanvas.addEventListener(ev, () => { painting = false; }));

undoBtn.addEventListener('click', () => {
  const last = strokes.pop();
  if (last) ctx.putImageData(last, 0, 0);
});

clearBtn.addEventListener('click', clearMask);
function clearMask() {
  strokes = [];
  ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
}

// --- Regenerate ---
regenBtn.addEventListener('click', async () => {
  if (!baseImage.src) return setStatus('Load an image first', true);
  if (!hasMask())     return setStatus('Paint a region to change first', true);
  const prompt = promptEl.value.trim();
  if (!prompt)        return setStatus('Describe the change first', true);

  regenBtn.disabled = true;
  setStatus('Regenerating…');

  try {
    const { imageDataURL, maskDataURL } = await composeForExport();
    const res = await fetch('/api/inpaint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: imageDataURL, mask: maskDataURL, prompt }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Server error: ${res.status} — ${text}`);
    }
    const { image: newImage, note } = await res.json();
    await loadImage(newImage, promptEl.value.slice(0, 40) || 'Edit');
    setStatus(note || 'Done. Keep iterating or approve.');
  } catch (e) {
    console.error(e);
    setStatus(e.message, true);
  } finally {
    regenBtn.disabled = false;
  }
});

approveBtn.addEventListener('click', () => {
  if (activeIdx < 0) return setStatus('Nothing to approve yet', true);
  const item = history[activeIdx];
  // In production this would POST to /api/approve or hand off to the 3D step.
  // For now we just download the approved image locally.
  const a = document.createElement('a');
  a.href = item.dataURL;
  a.download = `approved-${Date.now()}.png`;
  a.click();
  setStatus('Approved — image downloaded. Next step: 3D generation.');
});

// --- Helpers ---
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (isError ? ' err' : '');
}

function hasMask() {
  // Quick check: any non-transparent pixel in the mask canvas.
  const data = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 8) return true;
  }
  return false;
}

// Compose the current base image + the user's painted mask into two PNG
// dataURLs at the base image's native resolution, which is what image-gen
// APIs expect.
async function composeForExport() {
  const w = baseImage.naturalWidth || baseImage.width;
  const h = baseImage.naturalHeight || baseImage.height;

  const imageCanvas = document.createElement('canvas');
  imageCanvas.width = w; imageCanvas.height = h;
  imageCanvas.getContext('2d').drawImage(baseImage, 0, 0, w, h);

  // Render the mask into a clean binary white-on-black PNG at native resolution.
  const maskOut = document.createElement('canvas');
  maskOut.width = w; maskOut.height = h;
  const mctx = maskOut.getContext('2d');
  mctx.fillStyle = '#000'; mctx.fillRect(0, 0, w, h);
  // Thresholded copy of the painted canvas, stretched to native size.
  const src = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  const tmp = document.createElement('canvas');
  tmp.width = src.width; tmp.height = src.height;
  const tctx = tmp.getContext('2d');
  const out = tctx.createImageData(src.width, src.height);
  for (let i = 0; i < src.data.length; i += 4) {
    const a = src.data[i + 3];
    const v = a > 8 ? 255 : 0;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  tctx.putImageData(out, 0, 0);
  mctx.drawImage(tmp, 0, 0, w, h);

  return {
    imageDataURL: imageCanvas.toDataURL('image/png'),
    maskDataURL:  maskOut.toDataURL('image/png'),
  };
}

// --- History ---
function pushHistory(dataURL, label) {
  history.push({ dataURL, label });
  activeIdx = history.length - 1;
  renderHistory();
}

function renderHistory() {
  histEl.innerHTML = '';
  history.forEach((h, i) => {
    const div = document.createElement('div');
    div.className = 'thumb' + (i === activeIdx ? ' active' : '');
    div.innerHTML = `<img src="${h.dataURL}" alt=""><span class="lbl">${i + 1}</span>`;
    div.title = h.label;
    div.addEventListener('click', async () => {
      activeIdx = i;
      await loadImageSilently(h.dataURL);
      renderHistory();
      setStatus(`Reverted to step ${i + 1}: ${h.label}`);
    });
    histEl.appendChild(div);
  });
}

function loadImageSilently(src) {
  return new Promise((res) => {
    baseImage.onload = () => { fitCanvas(); clearMask(); res(); };
    baseImage.src = src;
  });
}

fitCanvas();
setStatus('Upload a design image or click "Use sample" to begin.');
