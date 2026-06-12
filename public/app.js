'use strict';

(function() {

let wsClient  = null;
let diagram   = null;
let timeline  = null;
let playing   = false;

// ── Upload ─────────────────────────────────────────────────────────────

const dropzone     = document.getElementById('dropzone');
const dropTarget   = document.getElementById('drop-target');
const fileInput    = document.getElementById('file-input');
const progressBar  = document.getElementById('progress-bar');
const progressFill = document.getElementById('progress-fill');
const statusEl     = document.getElementById('upload-status');

dropTarget.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) upload(fileInput.files[0]); });

dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
});

function upload(file) {
  statusEl.textContent = 'Uploading and parsing FTDC…';
  statusEl.className = '';
  progressBar.classList.add('visible');
  progressFill.style.width = '5%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.upload.onprogress = e => {
    if (e.lengthComputable) progressFill.style.width = (5 + (e.loaded / e.total) * 55) + '%';
  };
  xhr.onload = () => {
    if (xhr.status !== 200) {
      let msg = xhr.statusText;
      try { msg = JSON.parse(xhr.responseText).error; } catch {}
      statusEl.textContent = 'Error: ' + msg;
      statusEl.className = 'error';
      return;
    }
    progressFill.style.width = '75%';
    statusEl.textContent = 'Building session…';
    try {
      startSession(JSON.parse(xhr.responseText));
    } catch (e) {
      statusEl.textContent = 'Parse error: ' + e.message;
      statusEl.className = 'error';
    }
  };
  xhr.onerror = () => { statusEl.textContent = 'Upload failed'; statusEl.className = 'error'; };
  xhr.send(file);
}

// ── Session ─────────────────────────────────────────────────────────────

function startSession(data) {
  dropzone.classList.add('hidden');
  const app = document.getElementById('app');
  app.style.display = 'flex';

  document.getElementById('session-info').textContent =
    `${data.nFrames.toLocaleString()} frames  •  ${(data.anomalies || []).length} anomalies`;

  diagram  = new Diagram();
  timeline = new Timeline();

  diagram.init(document.getElementById('diagram'));
  timeline.init(document.getElementById('timeline'), data.timeRange, data.anomalies || []);
  timeline.onSeek(t => wsClient?.seek(t));

  wsClient = new WsClient(data.sessionId);

  wsClient.onReady = () => {
    progressFill.style.width = '100%';
    statusEl.textContent = '';
  };

  wsClient.onFrame = msg => {
    diagram.update(msg.m, msg.h);
    timeline.update(msg.t, msg.m);
    document.getElementById('current-time').textContent =
      new Date(msg.t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  };

  wsClient.onDone = () => {
    playing = false;
    syncPlayButton();
  };

  wsClient.onError = err => console.error('WS:', err);
  wsClient.connect();
  wireControls();
}

// ── Controls ──────────────────────────────────────────────────────────────

function wireControls() {
  document.getElementById('btn-play').addEventListener('click', () => {
    playing = !playing;
    if (playing) {
      wsClient.play(Number(document.getElementById('speed-select').value));
    } else {
      wsClient.pause();
    }
    syncPlayButton();
  });

  document.getElementById('btn-step-back').addEventListener('click', () => wsClient.step(-1));
  document.getElementById('btn-step-fwd').addEventListener('click',  () => wsClient.step(1));

  document.getElementById('speed-select').addEventListener('change', () => {
    if (playing) wsClient.play(Number(document.getElementById('speed-select').value));
  });
}

function syncPlayButton() {
  const btn = document.getElementById('btn-play');
  btn.textContent = playing ? '⏸ Pause' : '▶ Play';
  btn.classList.toggle('active', playing);
}

})();
