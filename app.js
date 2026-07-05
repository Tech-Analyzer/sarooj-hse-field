// ============================================================
// Sarooj HSE Field PWA — app (Phase O3)
// Login (online) → cached identity + reference data → offline
// observation capture into IndexedDB → basic "Sync now".
// O4 adds auto-sync/retries; O5 hardens offline identity.
// ============================================================
(function () {
  'use strict';
  var cfg = window.SAROOJ_PWA || {};
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function uuid() { return 'obs-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10); }

  // ── Service worker + connectivity ─────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('./service-worker.js').catch(function () {}); });
  }
  function updateNet() {
    var online = navigator.onLine;
    var dot = $('net-dot'); if (dot) dot.className = 'net-dot' + (online ? '' : ' off');
    var b = $('net-banner');
    if (b) { b.className = 'net-banner ' + (online ? 'online' : 'offline'); b.textContent = online ? '' : 'Offline — captures are saved on this device and sync when you reconnect.'; }
  }
  window.addEventListener('online', function () { updateNet(); autoSync(); });
  window.addEventListener('offline', updateNet);

  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredPrompt = e; });

  function toast(msg) {
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2600);
  }

  // ── Auth / reference cache (localStorage) ─────────────────
  function getToken() { return localStorage.getItem('hse_token') || ''; }
  function getUser() { try { return JSON.parse(localStorage.getItem('hse_user')); } catch (e) { return null; } }
  function getRef() { try { return JSON.parse(localStorage.getItem('hse_ref')) || {}; } catch (e) { return {}; } }
  function getDeviceToken() { return localStorage.getItem('hse_device') || ''; }
  function saveAuth(token, user, ref, deviceToken) {
    if (token != null) localStorage.setItem('hse_token', token || '');
    if (user) localStorage.setItem('hse_user', JSON.stringify(user));
    if (ref) localStorage.setItem('hse_ref', JSON.stringify(ref));
    if (deviceToken) localStorage.setItem('hse_device', deviceToken); // long-lived + revocable — no PIN stored
  }
  function clearAuth() { ['hse_token', 'hse_user', 'hse_ref', 'hse_device', 'hse_creds'].forEach(function (k) { localStorage.removeItem(k); }); }

  // ── API (text/plain avoids CORS preflight) ────────────────
  function apiPost(action, payload) {
    var body = JSON.stringify(assign({ action: action }, payload || {}));
    return fetch(cfg.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, redirect: 'follow' })
      .then(function (r) { return r.json(); });
  }
  function assign(a, b) { for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k]; return a; }

  // ── IndexedDB queue ───────────────────────────────────────
  var DB = null;
  function idbOpen() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('sarooj-hse', 1);
      r.onupgradeneeded = function () { var db = r.result; if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'localId' }); };
      r.onsuccess = function () { DB = r.result; res(DB); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbPut(rec) { return new Promise(function (res, rej) { var tx = DB.transaction('queue', 'readwrite'); tx.objectStore('queue').put(rec); tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); }; }); }
  function idbAll() { return new Promise(function (res, rej) { var tx = DB.transaction('queue', 'readonly'); var q = tx.objectStore('queue').getAll(); q.onsuccess = function () { res(q.result || []); }; q.onerror = function () { rej(q.error); }; }); }
  function idbDel(id) { return new Promise(function (res, rej) { var tx = DB.transaction('queue', 'readwrite'); tx.objectStore('queue').delete(id); tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); }; }); }

  // ── Risk (mirrors server _calcRisk thresholds) ────────────
  function riskCat(f, s) {
    var F = parseInt(String(f).replace(/\D/g, ''), 10), S = parseInt(String(s).replace(/\D/g, ''), 10);
    if (!F || !S) return null;
    var score = F * S;
    var cat = score <= 3 ? 'Low' : score <= 6 ? 'Moderate' : score <= 12 ? 'High' : 'Extreme';
    return { score: score, cat: cat };
  }

  // ── Photo capture + compression ───────────────────────────
  function compressImage(file, maxDim, quality) {
    return new Promise(function (res) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var cw = Math.round(img.width * scale), ch = Math.round(img.height * scale);
        var c = document.createElement('canvas'); c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        try { res(c.toDataURL('image/jpeg', quality || 0.6)); } catch (e) { res(null); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); res(null); };
      img.src = url;
    });
  }

  // ══════════════════════════════════════════════════════════
  //  VIEWS
  // ══════════════════════════════════════════════════════════
  function render() {
    updateNet();
    if (!getToken() || !getUser()) return renderLogin();
    renderHome();
  }

  // ── Login ─────────────────────────────────────────────────
  function renderLogin() {
    $('app').innerHTML =
      '<div class="card login">' +
        '<h2>Sign in</h2>' +
        '<p class="muted">Sign in once while online to enable offline capture on this phone.</p>' +
        '<label>Username / email</label><input id="lg-user" class="fld" autocomplete="username">' +
        '<label>6-digit PIN</label><input id="lg-pin" class="fld" type="password" inputmode="numeric" maxlength="6" autocomplete="current-password">' +
        '<button class="btn-primary" id="lg-btn">Sign in</button>' +
        '<div id="lg-msg" class="err"></div>' +
      '</div>';
    $('lg-btn').addEventListener('click', doLogin);
  }
  function doLogin() {
    if (!navigator.onLine) { $('lg-msg').textContent = 'You must be online to sign in the first time.'; return; }
    var user = $('lg-user').value.trim(), pin = $('lg-pin').value.trim();
    if (!user || !pin) { $('lg-msg').textContent = 'Enter your username and PIN.'; return; }
    var btn = $('lg-btn'); btn.disabled = true; btn.textContent = 'Signing in…';
    apiPost('login', { username: user, pin: pin }).then(function (r) {
      btn.disabled = false; btn.textContent = 'Sign in';
      if (!r || !r.ok) { $('lg-msg').textContent = (r && r.message) || 'Sign in failed.'; return; }
      saveAuth(r.token, r.user, r.refData, r.deviceToken);
      render();
    }).catch(function () { btn.disabled = false; btn.textContent = 'Sign in'; $('lg-msg').textContent = 'Could not reach the server. Check your connection.'; });
  }

  // ── Home ──────────────────────────────────────────────────
  function renderHome() {
    var u = getUser();
    $('app').innerHTML =
      '<div class="greet">Hi, <b>' + esc(u.fullName) + '</b></div>' +
      '<div class="home">' +
        '<button class="tile tile-primary" id="tile-obs" type="button"><span class="tile-ic">+</span>' +
          '<span><b>New Observation</b><br><small>Record a safe / unsafe condition</small></span></button>' +
        '<div class="pending" id="pending"><div class="pending-title">Pending sync <span id="pcount" class="pill">0</span></div><div id="plist"></div>' +
          '<button class="btn-primary" id="sync-btn" style="margin-top:10px">Sync now</button></div>' +
        '<button class="btn-ghost" id="signout">Sign out</button>' +
      '</div>';
    $('tile-obs').addEventListener('click', renderForm);
    $('sync-btn').addEventListener('click', function () { syncNow(true); });
    $('signout').addEventListener('click', function () { if (confirm('Sign out? Unsynced captures stay on this device.')) { clearAuth(); render(); } });
    refreshPending();
  }
  function refreshPending() {
    idbAll().then(function (recs) {
      var pend = recs.filter(function (r) { return r.status !== 'synced'; });
      var pc = $('pcount'); if (pc) pc.textContent = pend.length;
      var host = $('plist'); if (!host) return;
      host.innerHTML = pend.length ? pend.map(function (r) {
        var rk = r.fields && r.fields._riskCat ? r.fields._riskCat : '';
        var st = r.status || 'pending';
        var stTxt = (st === 'error') ? ('error' + (r.attempts ? ' ·' + r.attempts : '')) : st;
        return '<div class="prow"><span class="material">' + esc((r.fields && r.fields.observationType) || 'Observation') + '</span>' +
          '<span class="pmeta">' + esc((r.fields && r.fields.site) || '') + (rk ? ' · ' + esc(rk) : '') + '</span>' +
          '<span class="pstatus ' + (st === 'error' ? 'err' : '') + '" title="' + esc(r.lastError || '') + '">' + esc(stTxt) + '</span></div>';
      }).join('') : '<div class="pending-empty">Nothing waiting to sync.</div>';
    });
  }

  // ── Observation form ──────────────────────────────────────
  var photos = [];
  function renderForm() {
    photos = [];
    var ref = getRef();
    var opts = function (arr, ph) { return '<option value="">' + esc(ph) + '</option>' + (arr || []).map(function (x) { return '<option>' + esc(x) + '</option>'; }).join(''); };
    var engOpts = '<option value="">Select engineer…</option>' + (ref.engineers || []).map(function (e) { return '<option value="' + esc(e.userID) + '">' + esc(e.fullName) + (e.org ? ' — ' + esc(e.org) : '') + '</option>'; }).join('');
    var fBtns = [1, 2, 3, 4, 5].map(function (n) { return '<button type="button" class="rb" data-f="' + n + '">F' + n + '</button>'; }).join('');
    var sBtns = [1, 2, 3, 4, 5].map(function (n) { return '<button type="button" class="rb" data-s="' + n + '">S' + n + '</button>'; }).join('');

    $('app').innerHTML =
      '<div class="form">' +
        '<div class="form-head"><button class="back" id="f-back">&larr;</button><b>New Observation</b></div>' +
        '<label>Observation type *</label><select id="f-type" class="fld">' + opts(ref.observationTypes, 'Select type…') + '</select>' +
        '<label>Site *</label><select id="f-site" class="fld">' + opts(ref.sites, 'Select site…') + '</select>' +
        '<label>Specific location</label><input id="f-loc" class="fld" placeholder="e.g. Zone 4 haul road">' +
        '<label>GPS</label><div class="row"><input id="f-gps" class="fld" placeholder="lat, long" readonly><button type="button" class="btn-ghost" id="f-gpsbtn">📍</button></div>' +
        '<label>Activity</label><select id="f-act" class="fld">' + opts(ref.activities, 'Select activity…') + '</select>' +
        '<label>Description * <small class="muted">(min 10 chars)</small></label><textarea id="f-desc" class="fld" rows="3"></textarea>' +
        '<label>Corrective action required * <small class="muted">(min 5 chars)</small></label><textarea id="f-corr" class="fld" rows="2"></textarea>' +
        '<label>Risk assessment *</label><div class="rgrid"><div class="rrow" id="f-frow">' + fBtns + '</div><div class="rrow" id="f-srow">' + sBtns + '</div></div>' +
        '<div id="f-risk" class="risk-out"></div>' +
        '<label>Assign to engineer *</label><select id="f-eng" class="fld">' + engOpts + '</select>' +
        '<label>Target date *</label><input id="f-due" class="fld" type="date">' +
        '<label>Contractor</label><select id="f-con" class="fld">' + opts(ref.contractors, 'Select…') + '</select>' +
        '<label>Persons involved</label><input id="f-persons" class="fld">' +
        '<label>Photos</label><div class="photo-actions">' +
          '<label class="btn-ghost">📷 Camera<input type="file" accept="image/*" capture="environment" id="f-cam" hidden></label>' +
          '<label class="btn-ghost">🖼 Gallery<input type="file" accept="image/*" multiple id="f-gal" hidden></label></div>' +
        '<div class="photo-grid" id="f-photos"></div>' +
        '<button class="btn-primary" id="f-save" style="margin-top:16px">Save observation</button>' +
        '<div id="f-msg" class="err"></div>' +
      '</div>';

    var fSel = null, sSel = null;
    $('f-back').addEventListener('click', renderHome);
    $('f-frow').addEventListener('click', function (e) { if (e.target.dataset.f) { fSel = e.target.dataset.f; sel('f-frow', e.target); showRisk(); } });
    $('f-srow').addEventListener('click', function (e) { if (e.target.dataset.s) { sSel = e.target.dataset.s; sel('f-srow', e.target); showRisk(); } });
    function sel(row, el) { $(row).querySelectorAll('.rb').forEach(function (b) { b.classList.remove('on'); }); el.classList.add('on'); }
    function showRisk() { var r = riskCat(fSel, sSel); $('f-risk').innerHTML = r ? '<span class="rbadge r-' + r.cat.toLowerCase() + '">' + r.cat + ' · score ' + r.score + '</span>' : ''; }

    $('f-gpsbtn').addEventListener('click', function () {
      if (!navigator.geolocation) { toast('GPS not available'); return; }
      $('f-gpsbtn').textContent = '…';
      navigator.geolocation.getCurrentPosition(function (p) { $('f-gps').value = p.coords.latitude.toFixed(6) + ', ' + p.coords.longitude.toFixed(6); $('f-gpsbtn').textContent = '📍'; },
        function () { $('f-gpsbtn').textContent = '📍'; toast('Could not get location'); }, { enableHighAccuracy: true, timeout: 8000 });
    });

    $('f-cam').addEventListener('change', onPhotos);
    $('f-gal').addEventListener('change', onPhotos);
    $('f-save').addEventListener('click', function () { saveObs(fSel, sSel); });
  }

  function onPhotos(e) {
    var files = e.target.files; if (!files) return;
    var arr = Array.prototype.slice.call(files);
    arr.forEach(function (file) {
      if (photos.length >= 5) { toast('Max 5 photos'); return; }
      compressImage(file, 1280, 0.6).then(function (dataUrl) {
        if (!dataUrl) return;
        photos.push({ name: file.name || ('photo-' + (photos.length + 1) + '.jpg'), dataUrl: dataUrl });
        renderPhotoGrid();
      });
    });
    e.target.value = '';
  }
  function renderPhotoGrid() {
    $('f-photos').innerHTML = photos.map(function (p, i) {
      return '<div class="ph"><img src="' + p.dataUrl + '"><button type="button" data-rm="' + i + '">×</button></div>';
    }).join('');
    $('f-photos').querySelectorAll('[data-rm]').forEach(function (b) { b.addEventListener('click', function () { photos.splice(+b.getAttribute('data-rm'), 1); renderPhotoGrid(); }); });
  }

  function saveObs(fSel, sSel) {
    var v = function (id) { var e = $(id); return e ? e.value.trim() : ''; };
    var msg = $('f-msg'); msg.textContent = '';
    var type = v('f-type'), site = v('f-site'), desc = v('f-desc'), corr = v('f-corr'), eng = $('f-eng').value, due = v('f-due');
    if (!type) return msg.textContent = 'Select an observation type.';
    if (!site) return msg.textContent = 'Select a site.';
    if (desc.length < 10) return msg.textContent = 'Description must be at least 10 characters.';
    if (corr.length < 5) return msg.textContent = 'Describe the corrective action (min 5 chars).';
    if (!fSel || !sSel) return msg.textContent = 'Complete the risk assessment (F and S).';
    if (!eng) return msg.textContent = 'Assign a responsible engineer.';
    if (!due) return msg.textContent = 'Set a target date.';

    var r = riskCat(fSel, sSel);
    var rec = {
      localId: uuid(), type: 'observation', status: 'pending', capturedAt: new Date().toISOString(),
      fields: {
        observationType: type, site: site, specificLocation: v('f-loc'), gpsCoordinates: v('f-gps'),
        activity: $('f-act').value, description: desc, correctiveAction: corr,
        likelihood: 'F' + fSel, severity: 'S' + sSel, _riskCat: r ? r.cat : '',
        assignedEngineerID: eng, deadline: due, contractorName: $('f-con').value, personsInvolved: v('f-persons')
      },
      photos: photos.map(function (p) { return { name: p.name, data: p.dataUrl.split(',')[1], mimeType: 'image/jpeg' }; })
    };
    idbPut(rec).then(function () {
      toast('Saved on device' + (navigator.onLine ? ' — syncing…' : ' — will sync when online'));
      renderHome();
      if (navigator.onLine) autoSync();
    }).catch(function () { msg.textContent = 'Could not save on device.'; });
  }

  // ── Sync (O4: retries + backoff + per-record status + CORS fallback) ──
  var syncing = false;
  function pack(r) { return { localId: r.localId, type: r.type, capturedAt: r.capturedAt, fields: r.fields, photos: r.photos }; }
  function retryDue(r) {
    var a = r.attempts || 0;
    if (a === 0) return true;
    var backoff = Math.min(30 * 60 * 1000, Math.pow(2, a) * 5000); // 10s, 20s, 40s… capped at 30 min
    return (Date.now() - (r.lastAttemptAt || 0)) >= backoff;
  }
  function bumpAttempt(r, errMsg, status) {
    r.attempts = (r.attempts || 0) + 1; r.lastAttemptAt = Date.now();
    r.lastError = errMsg || ''; r.status = status || 'error'; return idbPut(r);
  }

  function syncNow(manual) {
    if (syncing) return;
    if (!navigator.onLine) { if (manual) toast('You are offline'); return; }
    syncing = true;
    idbAll().then(function (recs) {
      var due = recs.filter(function (r) { return r.status !== 'synced' && (manual || retryDue(r)); });
      if (!due.length) { syncing = false; if (manual) toast('Nothing to sync'); return; }
      var payload = { token: getToken(), deviceToken: getDeviceToken(), records: due.map(pack) };
      apiPost('sync', payload).then(function (res) {
        if (!res || !res.ok) {
          if (res && res.error === 'AUTH_FAILED') { syncing = false; return handleAuthFail(); }
          Promise.all(due.map(function (r) { return bumpAttempt(r, (res && res.message) || 'Sync failed'); }))
            .then(function () { syncing = false; refreshPending(); if (manual) toast((res && res.message) || 'Sync failed'); });
          return;
        }
        var byId = {}; (res.results || []).forEach(function (x) { byId[x.localId] = x; });
        Promise.all(due.map(function (r) {
          var x = byId[r.localId];
          if (x && x.ok) return idbDel(r.localId);
          return bumpAttempt(r, (x && x.error) || 'Not processed');
        })).then(function () {
          syncing = false; refreshPending();
          var okN = (res.results || []).filter(function (x) { return x.ok; }).length;
          if (manual || okN) toast(okN + ' synced');
        });
      }).catch(function () {
        // Response couldn't be read (possible CORS) — the POST may have landed.
        // Confirm via the readable syncStatus GET, then reconcile.
        confirmViaStatus(due).then(function (n) { syncing = false; if (manual) toast(n ? (n + ' synced') : 'Sync retrying…'); });
      });
    }).catch(function () { syncing = false; });
  }

  function confirmViaStatus(due) {
    var ids = due.map(function (r) { return r.localId; }).join(',');
    return fetch(cfg.API_URL + '?api=syncStatus&localIds=' + encodeURIComponent(ids)).then(function (r) { return r.json(); }).then(function (res) {
      var synced = (res && res.synced) || {}; var n = 0;
      return Promise.all(due.map(function (r) {
        if (synced[r.localId]) { n++; return idbDel(r.localId); }
        return bumpAttempt(r, 'Retrying…', 'pending');
      })).then(function () { refreshPending(); return n; });
    }).catch(function () {
      return Promise.all(due.map(function (r) { return bumpAttempt(r, 'Retrying…', 'pending'); })).then(function () { refreshPending(); return 0; });
    });
  }

  function handleAuthFail() {
    // The device token silently re-auths at sync; if it's rejected (revoked/
    // deleted), there's nothing to fall back to — ask the user to sign in again.
    toast('Please sign in again on this device.');
    clearAuth(); render();
  }

  function autoSync() { syncNow(false); }

  // ── Boot ──────────────────────────────────────────────────
  idbOpen().then(function () { render(); if (navigator.onLine) autoSync(); }).catch(function () { render(); });
  // Periodic auto-retry (respects per-record backoff) while the app is open.
  setInterval(function () { if (navigator.onLine) autoSync(); }, 45000);
  console.log('Sarooj HSE Field PWA', cfg.VERSION, '· API', cfg.API_URL);
})();
