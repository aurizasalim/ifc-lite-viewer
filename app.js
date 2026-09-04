import { IfcParser } from 'https://cdn.jsdelivr.net/npm/@ifc-lite/parser/+esm';
import { GeometryProcessor } from 'https://cdn.jsdelivr.net/npm/@ifc-lite/geometry/+esm';
import { Renderer } from 'https://cdn.jsdelivr.net/npm/@ifc-lite/renderer/+esm';
import initWasm from 'https://cdn.jsdelivr.net/npm/@ifc-lite/wasm/+esm';

// IFClite's docs serve these unpinned ("latest") for quick starts. For a
// production deployment, pin exact versions instead, e.g.
// '.../@ifc-lite/parser@3.3.0/+esm' - check npmjs.com/org/ifc-lite for
// current numbers and keep parser/geometry/renderer/wasm in step.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@ifc-lite/wasm/pkg/ifc-lite_bg.wasm';

const canvas = document.getElementById('viewer-canvas');
const overlay = document.getElementById('overlay');
const fileNameEl = document.getElementById('file-name');
const statsEl = document.getElementById('stats');
const fileInput = document.getElementById('file-input');
const btnOpenFile = document.getElementById('btn-open-file');
const btnFitView = document.getElementById('btn-fit-view');

let renderer = null;
let geometryProcessor = null;
let engineReadyPromise = null;
let lastGeometryResult = null;
let currentAttachmentId = null;
let hasModelLoaded = false;

// ---------- Small UI helpers ----------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setOverlay(kind, { title = '', message = '', showDropHint = false } = {}) {
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
      ${showDropHint ? '<div class="overlay-hint">Drop an .ifc file anywhere on this window to preview it</div>' : ''}
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

function showEmptyState(message) {
  hasModelLoaded = false;
  currentAttachmentId = null;
  setStats();
  setOverlay('empty', { title: 'No model loaded', message, showDropHint: true });
}

function showErrorState(title, err) {
  hasModelLoaded = false;
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
  if (!renderer) return;
  sizeCanvasToContainer();
  if (typeof renderer.resize === 'function') {
    // Not documented as of this writing, but feature-detected in case a
    // future IFClite release adds a cheap resize path.
    renderer.resize(canvas.width, canvas.height);
    renderer.render();
  } else if (lastGeometryResult) {
    // Fallback: re-init against the new canvas size and reload the last
    // geometry. Debounced below so a window drag doesn't thrash this.
    await renderer.init();
    renderer.loadGeometry(lastGeometryResult);
    renderer.fitToView();
    renderer.render();
  }
}

// ---------- IFClite engine (created once, reused across loads) ----------

async function ensureEngine() {
  if (!engineReadyPromise) {
    engineReadyPromise = (async () => {
      if (!navigator.gpu) {
        throw new Error(
          'This browser does not support WebGPU, which IFClite needs to render 3D models. ' +
          'Try a recent Chrome, Edge, or Firefox (see ifclite.dev for the full list).'
        );
      }
      await initWasm({ module_or_path: WASM_URL });
      geometryProcessor = new GeometryProcessor();
      await geometryProcessor.init();

      sizeCanvasToContainer();
      renderer = new Renderer(canvas);
      await renderer.init();

      setupCameraControls(canvas, renderer);
      window.addEventListener('resize', debounce(handleResize, 200));
    })();
  }
  return engineReadyPromise;
}

// Manual orbit / pan / zoom controls, following IFClite's documented
// Renderer.getCamera() pattern (camera.orbit / .pan / .zoom).
function setupCameraControls(canvas, renderer) {
  const camera = renderer.getCamera();
  let isDragging = false;
  let isPanning = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    isPanning = e.button === 1 || e.button === 2 || e.shiftKey;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.style.cursor = isPanning ? 'move' : 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
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
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    camera.zoom(e.deltaY, false, mouseX, mouseY, canvas.width, canvas.height);
    renderer.render();
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.style.cursor = 'grab';
}

// ---------- Loading pipeline ----------

async function loadIfcBuffer(buffer, label) {
  const startedAt = performance.now();
  try {
    setOverlay('loading', { title: 'Loading model', message: 'Starting up the viewer\u2026' });
    await ensureEngine();

    setOverlay('loading', { title: 'Loading model', message: 'Parsing IFC data\u2026' });
    const parser = new IfcParser();
    const store = await parser.parseColumnar(buffer);

    setOverlay('loading', { title: 'Loading model', message: 'Processing geometry\u2026' });
    const geometryResult = await geometryProcessor.process(new Uint8Array(buffer));
    lastGeometryResult = geometryResult;

    sizeCanvasToContainer();
    renderer.loadGeometry(geometryResult);
    renderer.fitToView();
    renderer.render();

    hasModelLoaded = true;
    setOverlay(null);
    setStats({
      fileName: label,
      schemaVersion: store && store.schemaVersion,
      entityCount: store && store.entityCount,
      loadMs: performance.now() - startedAt,
    });
  } catch (err) {
    hasModelLoaded = false;
    setStats();
    showErrorState('Could not load this model', err);
  }
}

async function loadFromGristAttachment(attachmentId) {
  try {
    setOverlay('loading', { title: 'Loading model', message: 'Fetching attachment from Grist\u2026' });
    const tokenInfo = await grist.docApi.getAccessToken({ readOnly: true });

    let displayName = `Attachment #${attachmentId}`;
    try {
      const metaRes = await fetch(`${tokenInfo.baseUrl}/attachments/${attachmentId}?auth=${tokenInfo.token}`);
      if (metaRes.ok) {
        const meta = await metaRes.json();
        if (meta && meta.fileName) displayName = meta.fileName;
      }
    } catch (metaErr) {
      console.warn('Could not read attachment metadata, continuing anyway:', metaErr);
    }

    const fileRes = await fetch(`${tokenInfo.baseUrl}/attachments/${attachmentId}/download?auth=${tokenInfo.token}`);
    if (!fileRes.ok) {
      throw new Error(`Grist returned ${fileRes.status} while downloading the attachment.`);
    }
    const buffer = await fileRes.arrayBuffer();
    await loadIfcBuffer(buffer, displayName);
  } catch (err) {
    showErrorState('Could not fetch the attachment', err);
  }
}

function openLocalFile(file) {
  if (!file) return;
  currentAttachmentId = null; // a manually opened file overrides the mapped attachment
  const reader = new FileReader();
  reader.onload = () => loadIfcBuffer(reader.result, file.name);
  reader.onerror = () => showErrorState('Could not read file', reader.error);
  reader.readAsArrayBuffer(file);
}

// ---------- Toolbar + drag/drop wiring ----------

btnOpenFile.addEventListener('click', () => fileInput.click());
btnFitView.addEventListener('click', () => {
  if (renderer && hasModelLoaded) {
    renderer.fitToView();
    renderer.render();
  }
});
fileInput.addEventListener('change', () => {
  openLocalFile(fileInput.files && fileInput.files[0]);
  fileInput.value = '';
});

['dragenter', 'dragover'].forEach((evt) =>
  document.body.addEventListener(evt, (e) => {
    e.preventDefault();
    document.body.classList.add('drag-active');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  document.body.addEventListener(evt, (e) => {
    e.preventDefault();
    document.body.classList.remove('drag-active');
  })
);
document.body.addEventListener('drop', (e) => {
  openLocalFile(e.dataTransfer.files && e.dataTransfer.files[0]);
});

// ---------- Grist wiring ----------

function initGrist() {
  if (!window.grist) {
    // Not embedded in Grist (e.g. previewing this file directly) - the
    // local "Open file" / drag-and-drop path still works on its own.
    showEmptyState('Not running inside Grist \u2014 use \u201cOpen file\u201d or drop an .ifc file here to preview it.');
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
    currentAttachmentId = attachmentId;
    loadFromGristAttachment(attachmentId);
  });
}

showEmptyState('Waiting for data\u2026');
initGrist();
