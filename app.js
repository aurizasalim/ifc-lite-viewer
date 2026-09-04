import { IfcParser } from 'https://cdn.jsdelivr.net/npm/@ifc-lite/parser/+esm';
import { GeometryProcessor } from 'https://cdn.jsdelivr.net/npm/@ifc-lite/geometry/+esm';
import { Renderer } from 'https://cdn.jsdelivr.net/npm/@ifc-lite/renderer/+esm';
import initWasm from 'https://cdn.jsdelivr.net/npm/@ifc-lite/wasm/+esm';

// IFClite's docs serve these unpinned ("latest") for quick starts. For a
// production deployment, pin exact versions instead, e.g.
// '.../@ifc-lite/parser@3.3.0/+esm' - check npmjs.com/org/ifc-lite for
// current numbers and keep parser/geometry/renderer/wasm in step.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@ifc-lite/wasm/pkg/ifc-lite_bg.wasm';

let canvas = document.getElementById('viewer-canvas');
const overlay = document.getElementById('overlay');
const fileNameEl = document.getElementById('file-name');
const statsEl = document.getElementById('stats');
const btnFitView = document.getElementById('btn-fit-view');

let renderer = null;
let wasmInitPromise = null;
let lastGeometryResult = null;
let currentAttachmentId = null;
let hasModelLoaded = false;
let currentLoadId = 0;

let isDragging = false;
let isPanning = false;
let lastX = 0;
let lastY = 0;

// ---------- Small UI helpers ----------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setOverlay(kind, { title = '', message = '' } = {}) {
  if (kind === null) {
    overlay.hidden = true;
    overlay.className = 'overlay';
    overlay.innerHTML = '';
    return;
  }
  overlay.hidden = false;
  overlay.className = `overlay overlay--${kind}`;
  overlay.innerHTML = `
    <div class="overlay-card">
      ${kind === 'loading' ? '<div class="spinner" aria-hidden="true"></div>' : ''}
      ${kind === 'error' ? '<div class="overlay-icon" aria-hidden="true">&#9888;</div>' : ''}
      ${title ? `<div class="overlay-title">${escapeHtml(title)}</div>` : ''}
      ${message ? `<div class="overlay-message">${escapeHtml(message)}</div>` : ''}
    </div>
  `;
}

function setStats({ fileName = '', schemaVersion = null, entityCount = null, loadMs = null } = {}) {
  fileNameEl.textContent = fileName;
  const parts = [];
  if (schemaVersion != null) parts.push(String(schemaVersion));
  if (entityCount != null) parts.push(`${entityCount.toLocaleString()} entities`);
  if (loadMs != null) parts.push(`${(loadMs / 1000).toFixed(1)}s`);
  statsEl.textContent = parts.join(' \u00b7 ');
  btnFitView.disabled = !fileName;
}

// ---------- Canvas & Renderer Lifecycle Management ----------

function resetCanvas() {
  if (renderer) {
    try {
      if (typeof renderer.destroy === 'function') {
        renderer.destroy();
      }
    } catch (err) {
      console.warn('Error destroying renderer:', err);
    }
    renderer = null;
  }

  // Replacing the canvas DOM element guarantees all WebGPU buffers,
  // lingering GPU textures, and previous models are completely wiped.
  const oldCanvas = canvas;
  const newCanvas = oldCanvas.cloneNode(false);
  oldCanvas.replaceWith(newCanvas);
  canvas = newCanvas;
  bindCanvasControls();
}

function unloadModel() {
  currentLoadId++; // Invalidate any asynchronous downloads or parsing in-flight
  hasModelLoaded = false;
  lastGeometryResult = null;
  setStats();
  resetCanvas();
}

function showEmptyState(message) {
  unloadModel();
  currentAttachmentId = null;
  setOverlay('empty', { title: 'No model loaded', message });
}

function showErrorState(title, err) {
  unloadModel();
  currentAttachmentId = null;
  console.error(title, err);
  setOverlay('error', {
    title,
    message: (err && err.message) ? err.message : String(err || ''),
  });
}

// ---------- Canvas sizing ----------

function sizeCanvasToContainer() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function handleResize() {
  if (!renderer || !hasModelLoaded) return;
  sizeCanvasToContainer();
  if (typeof renderer.resize === 'function') {
    renderer.resize(canvas.width, canvas.height);
    renderer.render();
  } else if (lastGeometryResult) {
    await renderer.init();
    renderer.loadGeometry(lastGeometryResult);
    renderer.fitToView();
    renderer.render();
  }
}

// ---------- Camera & Input Controls ----------

function bindCanvasControls() {
  canvas.addEventListener('mousedown', (e) => {
    if (!renderer || !hasModelLoaded) return;
    isDragging = true;
    isPanning = e.button === 1 || e.button === 2 || e.shiftKey;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.style.cursor = isPanning ? 'move' : 'grabbing';
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!renderer || !hasModelLoaded) return;
    const camera = renderer.getCamera();
    if (!camera) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    camera.zoom(e.deltaY, false, mouseX, mouseY, canvas.width, canvas.height);
    renderer.render();
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.style.cursor = 'grab';
}

window.addEventListener('mousemove', (e) => {
  if (!isDragging || !renderer || !hasModelLoaded) return;
  const camera = renderer.getCamera();
  if (!camera) return;
  const deltaX = e.clientX - lastX;
  const deltaY = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  if (isPanning) {
    camera.pan(deltaX, deltaY);
  } else {
    camera.orbit(deltaX, deltaY);
  }
  renderer.render();
});

window.addEventListener('mouseup', () => {
  isDragging = false;
  isPanning = false;
  if (canvas) canvas.style.cursor = 'grab';
});

window.addEventListener('resize', debounce(handleResize, 200));

// ---------- WASM Engine Initialization ----------

function ensureWasm() {
  if (!wasmInitPromise) {
    wasmInitPromise = initWasm({ module_or_path: WASM_URL });
  }
  return wasmInitPromise;
}

// ---------- Loading pipeline ----------

async function loadIfcBuffer(buffer, label, loadId) {
  const startedAt = performance.now();
  try {
    if (!navigator.gpu) {
      throw new Error(
        'This browser does not support WebGPU, which IFClite needs to render 3D models. ' +
        'Try a recent Chrome, Edge, or Firefox (see ifclite.dev for the full list).'
      );
    }

    setOverlay('loading', { title: 'Loading model', message: 'Starting up 3D engine\u2026' });
    await ensureWasm();
    if (loadId !== currentLoadId) return;

    setOverlay('loading', { title: 'Loading model', message: 'Parsing IFC data\u2026' });
    const parser = new IfcParser();
    const store = await parser.parseColumnar(buffer);
    if (loadId !== currentLoadId) return;

    setOverlay('loading', { title: 'Loading model', message: 'Processing geometry\u2026' });
    const geometryProcessor = new GeometryProcessor();
    await geometryProcessor.init();
    if (loadId !== currentLoadId) return;

    const geometryResult = await geometryProcessor.process(new Uint8Array(buffer));
    if (loadId !== currentLoadId) return;

    // Reset canvas and instantiate a fresh Renderer to guarantee no old model aggregation
    resetCanvas();
    sizeCanvasToContainer();
    const newRenderer = new Renderer(canvas);
    await newRenderer.init();
    if (loadId !== currentLoadId) {
      try { newRenderer.destroy(); } catch (e) {}
      return;
    }

    newRenderer.loadGeometry(geometryResult);
    newRenderer.fitToView();
    newRenderer.render();

    renderer = newRenderer;
    lastGeometryResult = geometryResult;
    hasModelLoaded = true;

    setOverlay(null);
    setStats({
      fileName: label,
      schemaVersion: store && store.schemaVersion,
      entityCount: store && store.entityCount,
      loadMs: performance.now() - startedAt,
    });
  } catch (err) {
    if (loadId === currentLoadId) {
      unloadModel();
      showErrorState('Could not load this model', err);
    }
  }
}

async function loadFromGristAttachment(attachmentId) {
  const loadId = ++currentLoadId;
  try {
    setOverlay('loading', { title: 'Loading model', message: 'Fetching attachment from Grist\u2026' });
    const tokenInfo = await grist.docApi.getAccessToken({ readOnly: true });
    if (loadId !== currentLoadId) return;

    let displayName = `Attachment #${attachmentId}`;
    try {
      const metaRes = await fetch(`${tokenInfo.baseUrl}/attachments/${attachmentId}?auth=${tokenInfo.token}`);
      if (loadId !== currentLoadId) return;
      if (metaRes.ok) {
        const meta = await metaRes.json();
        if (loadId !== currentLoadId) return;
        if (meta && meta.fileName) displayName = meta.fileName;
      }
    } catch (metaErr) {
      console.warn('Could not read attachment metadata, continuing anyway:', metaErr);
    }

    const fileRes = await fetch(`${tokenInfo.baseUrl}/attachments/${attachmentId}/download?auth=${tokenInfo.token}`);
    if (loadId !== currentLoadId) return;
    if (!fileRes.ok) {
      throw new Error(`Grist returned ${fileRes.status} while downloading the attachment.`);
    }
    const buffer = await fileRes.arrayBuffer();
    if (loadId !== currentLoadId) return;

    await loadIfcBuffer(buffer, displayName, loadId);
  } catch (err) {
    if (loadId === currentLoadId) {
      showErrorState('Could not fetch the attachment', err);
    }
  }
}

// ---------- Toolbar wiring ----------

btnFitView.addEventListener('click', () => {
  if (renderer && hasModelLoaded) {
    renderer.fitToView();
    renderer.render();
  }
});

// ---------- Grist wiring ----------

function initGrist() {
  bindCanvasControls();

  if (!window.grist) {
    showEmptyState('Not running inside Grist. This widget displays IFC models from a Grist table Attachments column.');
    return;
  }

  grist.ready({
    requiredAccess: 'read table',
    columns: [
      {
        name: 'IfcFile',
        title: 'IFC model file',
        description: 'Attachments column holding the .ifc file to display for this row',
        type: 'Attachments',
        optional: false,
      },
    ],
  });

  grist.onRecord((record) => {
    if (!record) {
      showEmptyState('Select a row to view its IFC model.');
      return;
    }
    const mapped = grist.mapColumnNames(record);
    const attachments = mapped ? mapped.IfcFile : undefined;
    if (!mapped || attachments == null) {
      showEmptyState('Map an Attachments column to \u201cIFC model file\u201d in the widget options (\u2699) to get started.');
      return;
    }
    const attachmentId = Array.isArray(attachments) ? attachments[0] : attachments;
    if (!attachmentId) {
      showEmptyState('This row has no IFC file attached yet.');
      return;
    }
    if (attachmentId === currentAttachmentId) return;

    // Immediately unload the previous model and clear the canvas
    unloadModel();
    currentAttachmentId = attachmentId;
    loadFromGristAttachment(attachmentId);
  });
}

showEmptyState('Waiting for data\u2026');
initGrist();
