'use strict';

(function() {

let wsClient    = null;
let diagram     = null;
let timeline    = null;
let particles   = null;
let clusterView = null;
let playing     = false;
let controlsWired = false;

// ── Upload ─────────────────────────────────────────────────────────────

const dropzone     = document.getElementById('dropzone');
const dropTarget   = document.getElementById('drop-target');
const fileInput    = document.getElementById('file-input');
const progressBar  = document.getElementById('progress-bar');
const progressFill = document.getElementById('progress-fill');
const statusEl     = document.getElementById('upload-status');
const stagingEl    = document.getElementById('staging');

dropTarget.addEventListener('click', e => {
  if (e.target.id === 'demo-btn' || e.target.id === 'cluster-demo-btn') return;
  if (e.target.closest('#staging')) return; // don't reopen picker while staging
  fileInput.click();
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFiles([...fileInput.files]); });

dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  if (e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]);
});

document.getElementById('demo-btn').addEventListener('click', e => {
  e.stopPropagation();
  loadDemo('/api/demo', startSession);
});
document.getElementById('cluster-demo-btn').addEventListener('click', e => {
  e.stopPropagation();
  loadDemo('/api/cluster-demo', startClusterSession);
});

async function loadDemo(url, starter) {
  statusEl.textContent = 'Loading demo…';
  statusEl.className = '';
  progressBar.classList.add('visible');
  progressFill.style.width = '40%';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    progressFill.style.width = '80%';
    starter(await res.json());
  } catch (e) {
    statusEl.textContent = 'Demo error: ' + e.message;
    statusEl.className = 'error';
  }
}

function uploadOne(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status !== 200) {
        let msg = xhr.statusText;
        try { msg = JSON.parse(xhr.responseText).error; } catch {}
        return reject(new Error(msg));
      }
      try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(e); }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
}

async function handleFiles(files) {
  if (files.length === 1) {
    statusEl.textContent = 'Uploading and parsing FTDC…';
    statusEl.className = '';
    progressBar.classList.add('visible');
    try {
      const data = await uploadOne(files[0], f => { progressFill.style.width = (5 + f * 70) + '%'; });
      startSession(data);
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
      statusEl.className = 'error';
    }
    return;
  }

  // Multi-file: upload each sequentially, stage with detected host labels
  statusEl.className = '';
  progressBar.classList.add('visible');
  const staged = [];
  for (let i = 0; i < files.length; i++) {
    statusEl.textContent = `Parsing ${files[i].name} (${i + 1}/${files.length})…`;
    try {
      const data = await uploadOne(files[i], f => {
        progressFill.style.width = ((i + f) / files.length * 70) + '%';
      });
      staged.push({ file: files[i].name, ...data });
    } catch (e) {
      statusEl.textContent = `Error in ${files[i].name}: ${e.message}`;
      statusEl.className = 'error';
      return;
    }
  }
  progressFill.style.width = '75%';
  statusEl.textContent = '';
  showStaging(staged);
}

function showStaging(staged) {
  stagingEl.style.display = 'block';
  stagingEl.innerHTML = staged.map((s, i) => `
    <div class="stage-row">
      <input type="text" data-i="${i}" value="${(s.hostInfo?.uniqueLabel || s.file).replace(/"/g, '&quot;')}">
      <span class="stage-status">${s.hostInfo?.role || '?'} · ${s.nFrames.toLocaleString()} frames</span>
    </div>`).join('') +
    `<button id="launch-cluster">⚡ Launch Cluster Replay (${staged.length} hosts)</button>`;

  document.getElementById('launch-cluster').addEventListener('click', async e => {
    e.stopPropagation();
    statusEl.textContent = 'Aligning hosts…';
    const sessions = staged.map((s, i) => ({
      sessionId: s.sessionId,
      label: stagingEl.querySelector(`input[data-i="${i}"]`).value.trim() || s.file,
    }));
    try {
      const res = await fetch('/api/cluster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessions }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      startClusterSession(await res.json());
    } catch (err) {
      statusEl.textContent = 'Cluster error: ' + err.message;
      statusEl.className = 'error';
    }
  });
}

// ── Single-host session ───────────────────────────────────────────────

function startSession(data) {
  showApp(`${data.nFrames.toLocaleString()} frames  •  ${(data.anomalies || []).length} anomalies`);
  document.getElementById('diagram-container').style.display = 'block';
  document.getElementById('cluster-view').style.display = 'none';

  diagram   = new Diagram();
  timeline  = new Timeline();
  particles = new Particles();

  diagram.init(document.getElementById('diagram'));
  timeline.init(document.getElementById('timeline'), data.timeRange, data.anomalies || []);
  particles.init(document.getElementById('particles'));
  timeline.onSeek(t => wsClient?.seek(t));

  connectWs(data.sessionId, msg => {
    diagram.update(msg.m, msg.h);
    timeline.update(msg.t, msg.m);
    particles.update(msg.m);
    setClock(msg.t);
  }, null);
}

// ── Cluster session ───────────────────────────────────────────────────

function startClusterSession(data) {
  showApp(`${data.hosts.length} hosts  •  ${data.nFrames.toLocaleString()} frames  •  ${(data.anomalies || []).length} anomalies`);
  document.getElementById('diagram-container').style.display = 'none';
  const cv = document.getElementById('cluster-view');
  cv.style.display = 'block';

  clusterView = new ClusterView();
  timeline    = new Timeline();

  clusterView.init(cv, data.hosts);
  timeline.init(document.getElementById('timeline'), data.timeRange, data.anomalies || []);
  timeline.onSeek(t => wsClient?.seek(t));

  connectWs(data.sessionId, null, msg => {
    clusterView.update(msg.hosts);
    // Timeline sparkline: cluster aggregate — sum of ops, max cache fill
    let ops = 0, cache = 0;
    for (const hd of Object.values(msg.hosts)) {
      ops += hd.m.total_ops_rate || 0;
      cache = Math.max(cache, hd.m.cache_fill_pct || 0);
    }
    timeline.update(msg.t, { total_ops_rate: ops, cache_fill_pct: cache });
    setClock(msg.t);
  });
}

// ── Shared wiring ─────────────────────────────────────────────────────

function showApp(info) {
  dropzone.classList.add('hidden');
  document.getElementById('app').style.display = 'flex';
  document.getElementById('session-info').textContent = info;
}

function setClock(t) {
  document.getElementById('current-time').textContent =
    new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function connectWs(sessionId, onFrame, onClusterFrame) {
  wsClient = new WsClient(sessionId);
  wsClient.onReady = () => { progressFill.style.width = '100%'; statusEl.textContent = ''; };
  wsClient.onFrame = onFrame;
  wsClient.onClusterFrame = onClusterFrame;
  wsClient.onDone = () => { playing = false; syncPlayButton(); };
  wsClient.onError = err => console.error('WS:', err);
  wsClient.connect();
  wireControls();
}

function wireControls() {
  if (controlsWired) return;
  controlsWired = true;

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
