/* ============================================
   KINGAPLAY v3.0 — Bugfix Release
   Fixes:
   - AudioContext bloqueaba reproducción en Android Chrome
   - re-renders durante playback rompían controles
   - emojis en song-art causaban visualización rara
   - controles de reproducción no respondían en móvil
   - ícono ahora se define como constante al inicio del código
   ============================================ */
'use strict';

/* ══════════════════════════════════════════════
   🎨  ÍCONO PERSONALIZADO
   Edita solo esta línea con la ruta de tu imagen.
   Ejemplos:
     './mi-icono.png'     → archivo en la misma carpeta
     './assets/logo.png'  → subcarpeta assets
     ''                   → usa el ícono SVG por defecto
   ══════════════════════════════════════════════ */
const APP_ICON = './KingaPlay.png';   // ← CAMBIA ESTO

/* ══════════════════════════════════════════════
   ESTADO GLOBAL
   ══════════════════════════════════════════════ */
let library            = [];
let videoLibrary       = [];
let currentTrackIndex  = -1;
let currentVideoIndex  = -1;
let isPlaying          = false;
let isShuffle          = false;
let repeatMode         = 'none';
let favorites          = new Set();
let folders            = {};
let artists            = {};
let currentFilter      = 'all';
let currentVideoFilter = 'all';
let contextTrackIndex  = -1;
let contextType        = 'audio';
let videoControlsTimer = null;
let audioCtx           = null;
let gainNode           = null;
let eqFilters          = [];

const EQ_BANDS = [
  {freq:60,label:'60'},{freq:170,label:'170'},{freq:310,label:'310'},
  {freq:600,label:'600'},{freq:1000,label:'1K'},{freq:3000,label:'3K'},
  {freq:6000,label:'6K'},{freq:12000,label:'12K'},{freq:14000,label:'14K'},{freq:16000,label:'16K'},
];
const EQ_PRESETS = {
  flat:     [0,0,0,0,0,0,0,0,0,0],
  bass:     [8,6,4,2,0,-1,-2,-2,-2,-2],
  rock:     [5,4,3,1,-1,0,1,2,3,4],
  pop:      [-1,-1,0,2,4,4,2,0,-1,-1],
  jazz:     [3,2,1,2,-2,-2,0,1,2,3],
  classical:[4,3,2,0,-2,-2,0,2,3,4],
};

const AUDIO_EXTS = ['mp3','flac','aac','wav','ogg','m4a','wma','opus'];
const VIDEO_EXTS = ['mp4','mkv','webm','mov','avi','m4v','3gp','ogv','ts'];

/* ══════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  applyAppIcon();
  loadState();
  buildEQ();
  startSplash();
});

function startSplash() {
  setTimeout(() => {
    document.getElementById('splash').classList.add('out');
    setTimeout(() => {
      document.getElementById('splash').style.display = 'none';
      document.getElementById('app').classList.remove('hidden');
    }, 600);
  }, 1800);
}

function applyAppIcon() {
  if (!APP_ICON) return;
  const si = document.getElementById('splashIcon');
  if (si) si.innerHTML = `<img src="${APP_ICON}" alt="KingaPlay" style="width:80px;height:80px;object-fit:cover;border-radius:20px;">`;
  let link = document.querySelector("link[rel~='icon']");
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.href = APP_ICON;
}

/* ══════════════════════════════════════════════
   AUDIO CONTEXT
   Se inicializa SOLO tras gesto del usuario (fix Android)
   NO conectamos createMediaElementSource para evitar
   el bug que congela Chrome Android
   ══════════════════════════════════════════════ */
function initAudioContext() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }
  try {
    audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
    gainNode  = audioCtx.createGain();
    gainNode.gain.value = 1.0;
    eqFilters = EQ_BANDS.map((band, i) => {
      const f = audioCtx.createBiquadFilter();
      f.type  = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
      f.frequency.value = band.freq;
      f.Q.value         = 1.4;
      f.gain.value      = 0;
      return f;
    });
    let prev = gainNode;
    eqFilters.forEach(f => { prev.connect(f); prev = f; });
    prev.connect(audioCtx.destination);
  } catch (e) {
    console.warn('AudioContext no disponible:', e);
    audioCtx = null;
  }
}

/* ══════════════════════════════════════════════
   ELEMENTO AUDIO
   ══════════════════════════════════════════════ */
const audioEl = document.getElementById('audioEl');

audioEl.addEventListener('timeupdate',     updateProgress);
audioEl.addEventListener('ended',          handleEnded);
audioEl.addEventListener('loadedmetadata', () => updateTotalTime(audioEl.duration));
audioEl.addEventListener('play',           () => setPlayingUI(true));
audioEl.addEventListener('pause',          () => setPlayingUI(false));
audioEl.addEventListener('error',          () => showToast('Error al reproducir el archivo'));

/* ══════════════════════════════════════════════
   ESCANEO
   ══════════════════════════════════════════════ */
function scanFiles(type) {
  const isVideo   = type === 'video';
  const acceptStr = isVideo
    ? 'video/*,.mp4,.mkv,.webm,.mov,.avi,.m4v,.3gp,.ogv'
    : 'audio/*,.mp3,.flac,.aac,.wav,.ogg,.m4a,.wma,.opus';
  const input     = document.createElement('input');
  input.type      = 'file';
  input.accept    = acceptStr;
  input.multiple  = true;
  input.onchange  = e => processFiles(Array.from(e.target.files), type);
  input.click();
}

function processFiles(files, type) {
  if (!files.length) return;
  const isVideo   = type === 'video';
  const targetLib = isVideo ? videoLibrary : library;

  document.getElementById('scanTitle').textContent  = isVideo ? 'Escaneando Videos' : 'Escaneando Audio';
  document.getElementById('scanStatus').textContent = 'Preparando...';
  document.getElementById('scanFill').style.width   = '0%';
  document.getElementById('scanCount').textContent  = '0 archivos';
  document.getElementById('scan-modal').classList.remove('hidden');

  let processed = 0, added = 0;
  const total   = files.length;

  files.forEach((file, idx) => {
    setTimeout(() => {
      const ext       = file.name.split('.').pop().toLowerCase();
      const validExts = isVideo ? VIDEO_EXTS : AUDIO_EXTS;
      const validMime = isVideo ? file.type.startsWith('video/') : file.type.startsWith('audio/');
      if (validExts.includes(ext) || validMime) {
        if (!targetLib.find(t => t.name === file.name && t.size === file.size)) {
          targetLib.push(isVideo ? buildVideo(file) : buildTrack(file));
          added++;
        }
      }
      processed++;
      document.getElementById('scanFill').style.width   = Math.round(processed / total * 100) + '%';
      document.getElementById('scanCount').textContent  = `${added} nuevos / ${processed} procesados`;
      document.getElementById('scanStatus').textContent = file.name;

      if (processed === total) {
        setTimeout(() => {
          document.getElementById('scan-modal').classList.add('hidden');
          rebuildMeta();
          isVideo ? renderVideos() : renderLibrary();
          renderFolders(); renderArtists(); updateStats(); saveState();
          showToast(`✓ ${added} ${isVideo ? 'videos' : 'canciones'} añadidos`);
        }, 400);
      }
    }, idx * 10);
  });
}

function buildTrack(file) {
  const name   = file.name.replace(/\.[^.]+$/, '');
  const ext    = file.name.split('.').pop().toLowerCase();
  const parts  = name.split(' - ');
  const artist = parts.length > 1 ? parts[0].trim() : 'Artista Desconocido';
  const title  = parts.length > 1 ? parts.slice(1).join(' - ').trim() : name;
  return {
    id: Date.now() + Math.random(), name: file.name,
    title, artist, folder: 'Música', format: ext.toUpperCase(),
    size: file.size, sizeLabel: formatBytes(file.size),
    url: URL.createObjectURL(file), type: 'audio',
  };
}

function buildVideo(file) {
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext  = file.name.split('.').pop().toLowerCase();
  return {
    id: Date.now() + Math.random(), name: file.name,
    title: name, folder: 'Videos', format: ext.toUpperCase(),
    size: file.size, sizeLabel: formatBytes(file.size),
    url: URL.createObjectURL(file), type: 'video',
  };
}

function rebuildMeta() {
  folders = {}; artists = {};
  library.forEach(t => {
    if (!folders[t.folder]) folders[t.folder] = { audio: [], video: [] };
    folders[t.folder].audio.push(t);
    if (!artists[t.artist]) artists[t.artist] = [];
    artists[t.artist].push(t);
  });
  videoLibrary.forEach(v => {
    if (!folders[v.folder]) folders[v.folder] = { audio: [], video: [] };
    folders[v.folder].video.push(v);
  });
}

/* ══════════════════════════════════════════════
   RENDER — AUDIO LIBRARY
   Usa delegación de eventos para evitar bugs en Android
   ══════════════════════════════════════════════ */
function renderLibrary(tracks) {
  const list = tracks !== undefined ? tracks : getFilteredTracks();
  const el   = document.getElementById('song-list');

  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🎵</div>
      <p>Escanea tus archivos de audio<br>para comenzar a escuchar</p>
      <button class="btn-primary" onclick="scanFiles('audio')">Escanear Audio</button>
    </div>`;
    el.onclick = null; el.oncontextmenu = null;
    return;
  }

  el.innerHTML = list.map((t, i) => {
    const libIdx = library.indexOf(t);
    const isFav  = favorites.has('audio_' + libIdx);
    const isAct  = currentTrackIndex === libIdx;
    return `<div class="song-item${isAct ? ' playing' : ''}" data-idx="${libIdx}">
      <div class="song-num">${isAct
        ? '<div class="song-playing-bars"><div class="sp-bar"></div><div class="sp-bar"></div><div class="sp-bar"></div></div>'
        : (i + 1)}</div>
      <div class="song-meta">
        <div class="song-name">${esc(t.title)}</div>
        <div class="song-artist">${esc(t.artist)}</div>
      </div>
      <span class="song-format">${t.format}</span>
      <button class="song-fav-btn${isFav ? ' active' : ''}"
        data-fav-idx="${libIdx}" data-fav-type="audio" aria-label="Favorito">
        <svg viewBox="0 0 24 24">
          <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"
            fill="${isFav ? 'var(--accent)' : 'none'}" stroke="currentColor" stroke-width="2"/>
        </svg>
      </button>
    </div>`;
  }).join('');

  el.onclick = e => {
    const fav = e.target.closest('[data-fav-idx]');
    if (fav) { e.stopPropagation(); toggleFavorite(+fav.dataset.favIdx, fav.dataset.favType); return; }
    const item = e.target.closest('.song-item[data-idx]');
    if (item) playTrack(+item.dataset.idx);
  };
  el.oncontextmenu = e => {
    const item = e.target.closest('.song-item[data-idx]');
    if (item) showContext(e, +item.dataset.idx, 'audio');
  };
}

function getFilteredTracks() {
  return currentFilter === 'all' ? library : library.filter(t => t.format.toLowerCase() === currentFilter);
}
function filterLibrary(fmt, btn) {
  currentFilter = fmt;
  document.querySelectorAll('#view-library .filter-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active'); renderLibrary();
}
function searchLibrary(q) {
  if (!q.trim()) { renderLibrary(); return; }
  const lq = q.toLowerCase();
  renderLibrary(library.filter(t =>
    t.title.toLowerCase().includes(lq) ||
    t.artist.toLowerCase().includes(lq) ||
    t.format.toLowerCase().includes(lq)
  ));
}

/* ══════════════════════════════════════════════
   RENDER — VIDEO LIBRARY
   ══════════════════════════════════════════════ */
function renderVideos(vids) {
  const list = vids !== undefined ? vids : getFilteredVideos();
  const el   = document.getElementById('video-list');

  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🎬</div>
      <p>Escanea tus archivos de video<br>para comenzar a reproducir</p>
      <button class="btn-primary" onclick="scanFiles('video')">Escanear Videos</button>
    </div>`;
    el.onclick = null; el.oncontextmenu = null;
    return;
  }

  el.innerHTML = list.map(v => {
    const vidIdx = videoLibrary.indexOf(v);
    const isAct  = currentVideoIndex === vidIdx;
    return `<div class="video-card${isAct ? ' playing' : ''}" data-vid-idx="${vidIdx}">
      <div class="video-card-body">
        <div class="video-card-icon">▶</div>
        <div class="video-card-info">
          <div class="video-card-title">${esc(v.title)}</div>
          <div class="video-card-sub">
            <span class="video-card-format">${v.format}</span>
            <span class="video-card-size">${v.sizeLabel}</span>
          </div>
        </div>
        ${isAct ? '<span class="video-playing-badge">EN REPRODUCCIÓN</span>' : ''}
      </div>
    </div>`;
  }).join('');

  el.onclick = e => {
    const card = e.target.closest('.video-card[data-vid-idx]');
    if (card) playVideo(+card.dataset.vidIdx);
  };
  el.oncontextmenu = e => {
    const card = e.target.closest('.video-card[data-vid-idx]');
    if (card) showContext(e, +card.dataset.vidIdx, 'video');
  };
}

function getFilteredVideos() {
  return currentVideoFilter === 'all' ? videoLibrary : videoLibrary.filter(v => v.format.toLowerCase() === currentVideoFilter);
}
function filterVideos(fmt, btn) {
  currentVideoFilter = fmt;
  document.querySelectorAll('#view-videos .filter-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active'); renderVideos();
}
function searchVideos(q) {
  if (!q.trim()) { renderVideos(); return; }
  const lq = q.toLowerCase();
  renderVideos(videoLibrary.filter(v => v.title.toLowerCase().includes(lq) || v.format.toLowerCase().includes(lq)));
}

/* ══════════════════════════════════════════════
   RENDER — CARPETAS
   ══════════════════════════════════════════════ */
function renderFolders() {
  const el   = document.getElementById('folder-list');
  const keys = Object.keys(folders);
  if (!keys.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📁</div><p>No hay carpetas escaneadas</p></div>`;
    return;
  }
  el.innerHTML = keys.map(k => {
    const aC = folders[k].audio?.length || 0;
    const vC = folders[k].video?.length || 0;
    return `<div class="folder-item" data-folder="${esc(k)}">
      <div class="folder-icon">📁</div>
      <div class="folder-meta">
        <div class="folder-name">${esc(k)}</div>
        <div class="folder-count">
          ${aC ? `<span class="folder-type-badge badge-audio">Audio: ${aC}</span>` : ''}
          ${vC ? `<span class="folder-type-badge badge-video">Video: ${vC}</span>` : ''}
        </div>
      </div>
      <div class="folder-chevron"><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></div>
    </div>`;
  }).join('');
  el.onclick = e => {
    const item = e.target.closest('.folder-item');
    if (item) playFolder(item.dataset.folder);
  };
}
function playFolder(name) {
  const f = folders[name];
  if (!f) return;
  if (f.audio?.length) playTrack(library.indexOf(f.audio[0]));
  else if (f.video?.length) playVideo(videoLibrary.indexOf(f.video[0]));
}

/* ══════════════════════════════════════════════
   RENDER — ARTISTAS
   ══════════════════════════════════════════════ */
function renderArtists() {
  const el   = document.getElementById('artist-list');
  const keys = Object.keys(artists).sort();
  if (!keys.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🎤</div><p>No hay artistas encontrados</p></div>`;
    return;
  }
  el.innerHTML = keys.map(k =>
    `<div class="artist-card" data-artist="${esc(k)}">
      <div class="artist-avatar">🎤</div>
      <div class="artist-name">${esc(k)}</div>
      <div class="artist-count">${artists[k].length} canciones</div>
    </div>`
  ).join('');
  el.onclick = e => {
    const card = e.target.closest('.artist-card');
    if (card) playArtist(card.dataset.artist);
  };
}
function playArtist(name) {
  const tracks = artists[name];
  if (tracks?.length) playTrack(library.indexOf(tracks[0]));
}

/* ══════════════════════════════════════════════
   RENDER — FAVORITOS
   ══════════════════════════════════════════════ */
function renderFavorites() {
  const el    = document.getElementById('favorites-list');
  const items = [];
  favorites.forEach(key => {
    const [type, idx] = key.split('_');
    const item = type === 'audio' ? library[+idx] : videoLibrary[+idx];
    if (item) items.push({ item, type, idx: +idx });
  });
  if (!items.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">❤️</div><p>Agrega archivos a favoritos<br>tocando el corazón</p></div>`;
    el.onclick = null; return;
  }
  el.innerHTML = items.map(({ item, type, idx }, i) => {
    const isAct = type === 'audio' ? currentTrackIndex === idx : currentVideoIndex === idx;
    return `<div class="song-item${isAct ? ' playing' : ''}" data-fav-play-idx="${idx}" data-fav-play-type="${type}">
      <div class="song-num">${isAct
        ? '<div class="song-playing-bars"><div class="sp-bar"></div><div class="sp-bar"></div><div class="sp-bar"></div></div>'
        : (i + 1)}</div>
      <div class="song-meta">
        <div class="song-name">${esc(item.title)}</div>
        <div class="song-artist">${type === 'audio' ? esc(item.artist || '—') : item.format}</div>
      </div>
      <span class="song-format">${item.format}</span>
      <button class="song-fav-btn active" data-fav-idx="${idx}" data-fav-type="${type}" aria-label="Quitar de favoritos">
        <svg viewBox="0 0 24 24">
          <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"
            fill="var(--accent)" stroke="var(--accent)" stroke-width="2"/>
        </svg>
      </button>
    </div>`;
  }).join('');
  el.onclick = e => {
    const fav = e.target.closest('[data-fav-idx]');
    if (fav) { e.stopPropagation(); toggleFavorite(+fav.dataset.favIdx, fav.dataset.favType); return; }
    const item = e.target.closest('[data-fav-play-idx]');
    if (item) {
      const t = item.dataset.favPlayType, i = +item.dataset.favPlayIdx;
      t === 'audio' ? playTrack(i) : playVideo(i);
    }
  };
}

/* ══════════════════════════════════════════════
   REPRODUCCIÓN — AUDIO
   ══════════════════════════════════════════════ */
function playTrack(index) {
  if (index < 0 || index >= library.length) return;
  initAudioContext();

  currentTrackIndex = index;
  const track = library[index];

  // Detener limpiamente antes de cambiar src (fix Chrome Android)
  audioEl.pause();
  audioEl.removeAttribute('src');
  audioEl.load();

  setTimeout(() => {
    audioEl.src = track.url;
    audioEl.load();
    const p = audioEl.play();
    if (p !== undefined) {
      p.catch(err => {
        console.warn('Play bloqueado:', err);
        setPlayingUI(false);
        showToast('Toca ▶ para reproducir');
      });
    }
  }, 80);

  updatePlayerUI(track);
  updateMiniPlayer(track);
  document.getElementById('mini-player').classList.remove('hidden');
  // Solo actualizar indicadores visuales, sin re-renderizar la lista completa
  refreshPlayingClass('audio', index);
  saveState();
}

function togglePlay() {
  if (!library.length) { scanFiles('audio'); return; }
  if (currentTrackIndex < 0) { playTrack(0); return; }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  if (audioEl.paused) audioEl.play().catch(() => showToast('Error al reproducir'));
  else audioEl.pause();
}

function nextTrack() {
  if (!library.length) return;
  if (repeatMode === 'one') { audioEl.currentTime = 0; audioEl.play(); return; }
  const next = isShuffle ? Math.floor(Math.random() * library.length) : (currentTrackIndex + 1) % library.length;
  playTrack(next);
}
function prevTrack() {
  if (!library.length) return;
  if (audioEl.currentTime > 3) { audioEl.currentTime = 0; return; }
  const prev = isShuffle ? Math.floor(Math.random() * library.length) : (currentTrackIndex - 1 + library.length) % library.length;
  playTrack(prev);
}
function handleEnded() {
  if (repeatMode === 'one') { audioEl.currentTime = 0; audioEl.play(); }
  else if (repeatMode === 'all' || library.length > 1) nextTrack();
  else setPlayingUI(false);
}
function seekTrack(e) {
  if (!audioEl.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  audioEl.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * audioEl.duration;
}
function setVolume(val) {
  audioEl.volume = val / 100;
  updateVolumeSliderBg('volumeSlider', val);
}
function toggleShuffle() {
  isShuffle = !isShuffle;
  document.getElementById('shuffleBtn').classList.toggle('active', isShuffle);
  showToast(isShuffle ? '🔀 Aleatorio activado' : '🔀 Aleatorio desactivado');
}
function toggleRepeat() {
  const modes = ['none','all','one'];
  repeatMode  = modes[(modes.indexOf(repeatMode) + 1) % 3];
  document.getElementById('repeatBtn').classList.toggle('active', repeatMode !== 'none');
  showToast({ none:'↩ Sin repetición', all:'🔁 Repetir todo', one:'🔂 Repetir uno' }[repeatMode]);
}

/* Actualiza clases "playing" sin re-renderizar toda la lista */
function refreshPlayingClass(type, activeIdx) {
  if (type === 'audio') {
    document.querySelectorAll('#song-list .song-item[data-idx]').forEach(el => {
      el.classList.toggle('playing', +el.dataset.idx === activeIdx);
      const numEl = el.querySelector('.song-num');
      if (numEl) {
        if (+el.dataset.idx === activeIdx) {
          numEl.innerHTML = '<div class="song-playing-bars"><div class="sp-bar"></div><div class="sp-bar"></div><div class="sp-bar"></div></div>';
        } else {
          const pos = Array.from(document.querySelectorAll('#song-list .song-item')).indexOf(el) + 1;
          numEl.textContent = pos;
        }
      }
    });
  }
  if (type === 'video') {
    document.querySelectorAll('#video-list .video-card[data-vid-idx]').forEach(el => {
      el.classList.toggle('playing', +el.dataset.vidIdx === activeIdx);
    });
  }
}

/* ══════════════════════════════════════════════
   REPRODUCCIÓN — VIDEO
   ══════════════════════════════════════════════ */
const videoEl = document.getElementById('videoEl');

function playVideo(index) {
  if (index < 0 || index >= videoLibrary.length) return;
  currentVideoIndex = index;
  const v = videoLibrary[index];

  videoEl.pause();
  videoEl.removeAttribute('src');
  videoEl.load();

  setTimeout(() => {
    videoEl.src = v.url;
    videoEl.load();
    openVideoPlayer();
    document.getElementById('videoTitleLabel').textContent = v.title;
    const isFav = favorites.has('video_' + index);
    document.getElementById('videoFavBtn').classList.toggle('active', isFav);
    document.getElementById('videoFavLabel').textContent = isFav ? 'En favoritos' : 'Agregar a favoritos';
    videoEl.play().catch(() => showToast('Toca ▶ para reproducir'));
  }, 80);

  refreshPlayingClass('video', index);
  saveState();
}

function toggleVideoPlay() {
  if (videoEl.paused) videoEl.play().catch(() => {});
  else videoEl.pause();
  showVideoTapIcon(!videoEl.paused);
}
function updateVideoPlayIcon(playing) {
  const pause = `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`;
  const play  = `<polygon points="5,3 19,12 5,21"/>`;
  document.getElementById('videoPlayIcon').innerHTML = playing ? pause : play;
}
function videoNext() { if (videoLibrary.length) playVideo((currentVideoIndex + 1) % videoLibrary.length); }
function videoPrev() {
  if (!videoLibrary.length) return;
  if (videoEl.currentTime > 3) { videoEl.currentTime = 0; return; }
  playVideo((currentVideoIndex - 1 + videoLibrary.length) % videoLibrary.length);
}
function handleVideoEnded() {
  if (videoLibrary.length > 1) playVideo((currentVideoIndex + 1) % videoLibrary.length);
  else updateVideoPlayIcon(false);
}
function updateVideoProgress() {
  if (!videoEl.duration) return;
  const pct = (videoEl.currentTime / videoEl.duration) * 100;
  document.getElementById('videoProgressFill').style.width  = pct + '%';
  document.getElementById('videoProgressThumb').style.left  = pct + '%';
  document.getElementById('videoCurrentTime').textContent   = formatTime(videoEl.currentTime);
}
function onVideoMeta() {
  document.getElementById('videoTotalTime').textContent = formatTime(videoEl.duration);
  updateVideoPlayIcon(true);
}
function seekVideo(e) {
  if (!videoEl.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  videoEl.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * videoEl.duration;
}
function setVideoVolume(val) { videoEl.volume = val / 100; updateVolumeSliderBg('videoVolumeSlider', val); }
function openVideoPlayer() {
  const m = document.getElementById('video-modal');
  m.classList.remove('hidden');
  setTimeout(() => m.classList.add('open'), 10);
  showVideoControls();
}
function closeVideoPlayer() {
  videoEl.pause(); updateVideoPlayIcon(false);
  const m = document.getElementById('video-modal');
  m.classList.remove('open');
  setTimeout(() => m.classList.add('hidden'), 400);
  refreshPlayingClass('video', currentVideoIndex);
}
function toggleVideoControls() {
  const c = document.getElementById('videoControls'), h = document.getElementById('videoHeader');
  const hidden = c.classList.toggle('hide');
  h.classList.toggle('hide', hidden);
  if (!hidden) { clearTimeout(videoControlsTimer); videoControlsTimer = setTimeout(hideVideoControls, 3500); }
}
function showVideoControls() {
  document.getElementById('videoControls').classList.remove('hide');
  document.getElementById('videoHeader').classList.remove('hide');
  clearTimeout(videoControlsTimer);
  videoControlsTimer = setTimeout(hideVideoControls, 3500);
}
function hideVideoControls() {
  if (!videoEl.paused) {
    document.getElementById('videoControls').classList.add('hide');
    document.getElementById('videoHeader').classList.add('hide');
  }
}
function showVideoTapIcon(playing) {
  const icon = document.getElementById('videoTapIcon');
  icon.innerHTML = playing
    ? `<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" fill="#fff"/><rect x="14" y="4" width="4" height="16" fill="#fff"/></svg>`
    : `<svg viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21" fill="#fff"/></svg>`;
  icon.classList.add('show');
  setTimeout(() => icon.classList.remove('show'), 700);
}
function toggleVideoFullscreen() {
  const wrap = document.getElementById('videoWrap');
  const req  = wrap.requestFullscreen || wrap.webkitRequestFullscreen || wrap.mozRequestFullScreen;
  const exit = document.exitFullscreen  || document.webkitExitFullscreen;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    if (req) req.call(wrap);
  } else {
    if (exit) exit.call(document);
  }
}

videoEl.addEventListener('play',           () => updateVideoPlayIcon(true));
videoEl.addEventListener('pause',          () => { updateVideoPlayIcon(false); showVideoControls(); });
videoEl.addEventListener('timeupdate',     updateVideoProgress);
videoEl.addEventListener('ended',          handleVideoEnded);
videoEl.addEventListener('loadedmetadata', onVideoMeta);
videoEl.addEventListener('error',          () => showToast('Error al reproducir el video'));

/* ══════════════════════════════════════════════
   FAVORITOS
   ══════════════════════════════════════════════ */
function toggleFavorite(index, type) {
  if (index < 0) return;
  const key = `${type}_${index}`;
  if (favorites.has(key)) favorites.delete(key);
  else favorites.add(key);
  const isFav = favorites.has(key);

  // Actualizar botón en player modals
  if (type === 'audio' && index === currentTrackIndex) {
    document.getElementById('favBtn')?.classList.toggle('active', isFav);
    document.getElementById('miniFav').style.color = isFav ? 'var(--accent)' : '';
  }
  if (type === 'video' && index === currentVideoIndex) {
    document.getElementById('videoFavBtn')?.classList.toggle('active', isFav);
    const lbl = document.getElementById('videoFavLabel');
    if (lbl) lbl.textContent = isFav ? 'En favoritos' : 'Agregar a favoritos';
  }
  // Actualizar botón en lista sin re-renderizar
  document.querySelectorAll(`[data-fav-idx="${index}"][data-fav-type="${type}"]`).forEach(btn => {
    btn.classList.toggle('active', isFav);
    const path = btn.querySelector('path');
    if (path) path.setAttribute('fill', isFav ? 'var(--accent)' : 'none');
  });

  renderFavorites(); updateStats(); saveState();
}
function toggleFavoriteContext() { toggleFavorite(contextTrackIndex, contextType); hideContext(); }
function addToQueue() { showToast('Añadido a la cola'); hideContext(); }

/* ══════════════════════════════════════════════
   UI — AUDIO PLAYER
   ══════════════════════════════════════════════ */
function setPlayingUI(playing) {
  isPlaying = playing;
  const pause = `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`;
  const play  = `<polygon points="5,3 19,12 5,21"/>`;
  document.getElementById('playIcon').innerHTML     = playing ? pause : play;
  document.getElementById('miniPlayIcon').innerHTML = playing ? pause : play;
  document.getElementById('albumArt').classList.toggle('playing', playing);
}
function updatePlayerUI(track) {
  document.getElementById('playerTitle').textContent  = track.title;
  document.getElementById('playerArtist').textContent = track.artist;
  document.getElementById('playerFormat').textContent = `${track.format} · ${track.sizeLabel}`;
  document.getElementById('favBtn').classList.toggle('active', favorites.has('audio_' + currentTrackIndex));
  const h1 = Math.floor(Math.random() * 360), h2 = (h1 + 120) % 360;
  document.getElementById('playerBg').style.background =
    `linear-gradient(135deg, hsl(${h1},55%,18%), hsl(${h2},55%,10%))`;
}
function updateMiniPlayer(track) {
  document.getElementById('miniTitle').textContent  = track.title;
  document.getElementById('miniArtist').textContent = track.artist;
  document.getElementById('miniArt').textContent    = '♪';
  document.getElementById('miniFav').style.color    = favorites.has('audio_' + currentTrackIndex) ? 'var(--accent)' : '';
}
function updateProgress() {
  if (!audioEl.duration) return;
  const pct = (audioEl.currentTime / audioEl.duration) * 100;
  document.getElementById('progressFill').style.width    = pct + '%';
  document.getElementById('progressThumb').style.left    = pct + '%';
  document.getElementById('miniProgressBar').style.width = pct + '%';
  document.getElementById('currentTime').textContent     = formatTime(audioEl.currentTime);
}
function updateTotalTime(dur) { document.getElementById('totalTime').textContent = formatTime(dur); }

/* ══════════════════════════════════════════════
   ECUALIZADOR
   ══════════════════════════════════════════════ */
function buildEQ() {
  document.getElementById('eqBands').innerHTML = EQ_BANDS.map((b, i) =>
    `<div class="eq-band">
      <div class="eq-slider-wrap">
        <input type="range" class="eq-slider" min="-12" max="12" value="0"
          data-band="${i}" oninput="setEQBand(${i},this.value)"
          style="-webkit-appearance:slider-vertical;">
      </div>
      <span class="eq-freq">${b.label}</span>
    </div>`
  ).join('');
}
function setEQBand(i, val) { if (eqFilters[i]) eqFilters[i].gain.value = parseFloat(val); }
function setPreset(name, btn) {
  document.querySelectorAll('.eq-preset').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  EQ_PRESETS[name].forEach((v, i) => {
    if (eqFilters[i]) eqFilters[i].gain.value = v;
    const s = document.querySelector(`.eq-slider[data-band="${i}"]`);
    if (s) s.value = v;
  });
  showToast(`EQ: ${btn.textContent}`);
}
function toggleGain(cb) { /* reservado */ }

/* ══════════════════════════════════════════════
   NAVEGACIÓN
   ══════════════════════════════════════════════ */
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.querySelector(`[data-view="${name}"]`).classList.add('active');
  if (name === 'favorites') renderFavorites();
  if (name === 'videos')    renderVideos();
}

/* ══════════════════════════════════════════════
   MODALES — AUDIO PLAYER
   ══════════════════════════════════════════════ */
function openPlayer() {
  if (currentTrackIndex < 0) return;
  const m = document.getElementById('player-modal');
  m.classList.remove('hidden');
  setTimeout(() => m.classList.add('open'), 10);
}
function closePlayer() {
  const m = document.getElementById('player-modal');
  m.classList.remove('open');
  setTimeout(() => m.classList.add('hidden'), 400);
}
function togglePlayerMenu() { showToast('Menú del reproductor'); }

/* ══════════════════════════════════════════════
   MENÚ CONTEXTUAL
   ══════════════════════════════════════════════ */
function showContext(e, index, type) {
  e.preventDefault();
  contextTrackIndex = index; contextType = type;
  const isFav = favorites.has(`${type}_${index}`);
  document.getElementById('favContextLabel').textContent = isFav ? 'Quitar de favoritos' : 'Agregar a favoritos';
  const menu = document.getElementById('context-menu');
  menu.classList.remove('hidden');
  menu.style.left = Math.min(e.clientX, window.innerWidth  - 220) + 'px';
  menu.style.top  = Math.min(e.clientY, window.innerHeight - 180) + 'px';
}
function hideContext() { document.getElementById('context-menu').classList.add('hidden'); contextTrackIndex = -1; }
document.addEventListener('click', e => { if (!e.target.closest('.context-menu')) hideContext(); });

function shareTrack() {
  const item = contextType === 'audio' ? library[contextTrackIndex] : videoLibrary[contextTrackIndex];
  if (item && navigator.share) navigator.share({ title: item.title, text: item.title });
  else showToast('Compartir no disponible');
  hideContext();
}
function showTrackInfo() {
  const item = contextType === 'audio' ? library[contextTrackIndex] : videoLibrary[contextTrackIndex];
  if (!item) return;
  const rows = [['Tipo', contextType === 'audio' ? 'Audio' : 'Video'], ['Título', item.title], ['Formato', item.format], ['Carpeta', item.folder], ['Tamaño', item.sizeLabel], ['Archivo', item.name]];
  if (contextType === 'audio') rows.splice(2, 0, ['Artista', item.artist]);
  document.getElementById('info-content').innerHTML = rows.map(([k, v]) =>
    `<div class="info-row"><span class="info-label">${k}</span><span class="info-val">${esc(String(v))}</span></div>`
  ).join('');
  document.getElementById('info-modal').classList.remove('hidden');
  hideContext();
}
function closeInfoModal() { document.getElementById('info-modal').classList.add('hidden'); }

/* ══════════════════════════════════════════════
   CONFIGURACIÓN
   ══════════════════════════════════════════════ */
function clearLibrary() {
  if (!confirm('¿Limpiar toda la biblioteca (audio y video)?')) return;
  library = []; videoLibrary = []; favorites = new Set(); folders = {}; artists = {};
  currentTrackIndex = -1; currentVideoIndex = -1;
  audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load();
  document.getElementById('mini-player').classList.add('hidden');
  renderLibrary(); renderVideos(); renderFolders(); renderArtists(); renderFavorites();
  updateStats(); saveState(); showToast('Biblioteca limpiada');
}
function updateStats() {
  document.getElementById('totalSongs').textContent  = library.length;
  document.getElementById('totalVideos').textContent = videoLibrary.length;
  document.getElementById('totalFavs').textContent   = favorites.size;
}
function updateVolumeSliderBg(id, val) {
  const el = document.getElementById(id);
  if (el) el.style.background = `linear-gradient(to right, var(--primary) 0%, var(--secondary) ${val}%, var(--bg-3) ${val}%)`;
}

/* ══════════════════════════════════════════════
   PERSISTENCIA
   ══════════════════════════════════════════════ */
function saveState() {
  try {
    localStorage.setItem('kingaplay_state', JSON.stringify({
      library:      library.map(t => ({ ...t, url: null })),
      videoLibrary: videoLibrary.map(v => ({ ...v, url: null })),
      favorites:    [...favorites],
      currentTrackIndex, currentVideoIndex,
    }));
  } catch (e) {}
}
function loadState() {
  try {
    const raw = localStorage.getItem('kingaplay_state');
    if (!raw) return;
    const d = JSON.parse(raw);
    favorites = new Set(d.favorites || []);
    rebuildMeta();
    renderLibrary(); renderVideos(); renderFolders(); renderArtists(); renderFavorites();
    updateStats();
  } catch (e) {}
}

/* ══════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════ */
function formatTime(s) {
  if (!s || isNaN(s) || !isFinite(s)) return '0:00';
  return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
}
function formatBytes(b) {
  if (!b) return '—';
  return b < 1048576 ? (b/1024).toFixed(0)+' KB' : (b/1048576).toFixed(1)+' MB';
}
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ══════════════════════════════════════════════
   TOAST
   ══════════════════════════════════════════════ */
let toastTimer;
function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div'); el.id = 'toast';
    el.style.cssText = 'position:fixed;bottom:calc(var(--nav-h) + var(--player-h) + 16px);left:50%;transform:translateX(-50%) translateY(20px);background:var(--bg-2);border:1px solid var(--border);color:var(--text-1);padding:10px 20px;border-radius:20px;font-family:var(--font-display);font-size:0.82rem;z-index:9000;opacity:0;transition:all 0.3s;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,0.5);pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1'; el.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity='0'; el.style.transform='translateX(-50%) translateY(10px)'; }, 2500);
}

/* ══════════════════════════════════════════════
   GESTOS — SWIPE DOWN PARA CERRAR
   ══════════════════════════════════════════════ */
['player-modal','video-modal'].forEach(id => {
  let startY = 0;
  const el = document.getElementById(id);
  el.addEventListener('touchstart', e => { startY = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchmove',  e => {
    if (e.touches[0].clientY - startY > 90) {
      id === 'player-modal' ? closePlayer() : closeVideoPlayer();
    }
  }, { passive: true });
});

/* ══════════════════════════════════════════════
   SERVICE WORKER
   ══════════════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
