(function () {
  'use strict';

  let allServers = [];
  let currentSort = { column: 'players', direction: 'desc' };
  let currentFilter = 'all';
  let searchQuery = '';
  let searchHiddenMatches = 0;
  let currentModalServer = null;
  let ws = null;
  let wsReconnectTimer = null;
  let captchaSiteKey = null;
  let lastDataTimestamp = null;
  let demandTimeLeftSeconds = null;
  let lastServerDemandTime = null;
  const FAVORITES_STORAGE_KEY = 'rebwr-favorite-servers';
  let favorites = loadFavorites();
  let showFavoritesOnly = false;

  function loadFavorites() {
    try {
      const saved = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || '[]');
      return new Set(Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : []);
    } catch (e) {
      return new Set();
    }
  }

  function saveFavorites() {
    try {
      localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(favorites)));
    } catch (e) {
      console.warn('Could not save favorites:', e);
    }
  }

  const dom = {
    captchaGate: document.getElementById('captchaGate'),
    captchaError: document.getElementById('captchaError'),
    captchaLoadError: document.getElementById('captchaLoadError'),
    app: document.getElementById('app'),
    loading: document.getElementById('loading'),
    errorMessage: document.getElementById('errorMessage'),
    errorText: document.getElementById('errorText'),
    serverTableContainer: document.getElementById('serverTableContainer'),
    serverTableBody: document.getElementById('serverTableBody'),
    searchInput: document.getElementById('searchInput'),
    searchBtn: document.getElementById('searchBtn'),
    clearSearchBtn: document.getElementById('clearSearchBtn'),
    showPrivate: document.getElementById('showPrivate'),
    favoriteFilterBtn: document.getElementById('favoriteFilterBtn'),
    retryBtn: document.getElementById('retryBtn'),
    statTotalServers: document.getElementById('statTotalServers'),
    statTotalPlayers: document.getElementById('statTotalPlayers'),
    statUnit1MW: document.getElementById('statUnit1MW'),
    statUnit2MW: document.getElementById('statUnit2MW'),
    statUnit1PPS: document.getElementById('statUnit1PPS'),
    statUnit2PPS: document.getElementById('statUnit2PPS'),
    statLastUpdated: document.getElementById('statLastUpdated'),
    modalOverlay: document.getElementById('modalOverlay'),
    serverModal: document.getElementById('serverModal'),
    modalTitle: document.getElementById('modalTitle'),
    modalContent: document.getElementById('modalContent'),
    modalCloseBtn: document.getElementById('modalCloseBtn'),
    modalJoinBtn: document.getElementById('modalJoinBtn'),
    playerListModal: document.getElementById('playerListModal'),
    playerListContent: document.getElementById('playerListContent')
  };

  /* ===== HELPERS ===== */

  function timeAgo(timestamp) {
    if (!timestamp) return 'N/A';
    const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
    if (seconds <= 0) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  setInterval(function () {
    if (lastDataTimestamp) {
      dom.statLastUpdated.textContent = timeAgo(lastDataTimestamp);
    }
    if (demandTimeLeftSeconds !== null && demandTimeLeftSeconds > 0) {
      demandTimeLeftSeconds = Math.max(0, demandTimeLeftSeconds - 1);
      var el = document.getElementById('demandTimeLeftValue');
      if (el) el.textContent = formatDemandTime(demandTimeLeftSeconds);
    }
  }, 1000);

  function formatNumber(num, decimals) {
    if (num === null || num === undefined) return 'N/A';
    if (typeof num !== 'number') return String(num);
    return num.toFixed(decimals !== undefined ? decimals : 2);
  }

  function shortId(id) {
    if (!id) return 'N/A';
    return id.length > 12 ? id.substring(0, 8) + '...' : id;
  }

  /* ===== SERVER ID / JOB ID HELPERS ===== */

  // Both ids are UUIDs. Normalising strips dashes and spaces so that a partial
  // id typed with or without dashes still matches.
  function normalizeId(value) {
    return String(value === null || value === undefined ? '' : value)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  // The server's own id from the monitoring API (empty when the server has
  // never sent a heartbeat).
  function getServerId(server) {
    if (!server) return '';
    return (server.rbwr && server.rbwr.id) || '';
  }

  // The Roblox Job ID the server is running on.
  function getJobId(server) {
    if (!server) return '';
    return server.id || (server.rbwr && server.rbwr.jobId) || '';
  }

  function matchesIdSearch(server, normalizedQuery) {
    if (!normalizedQuery) return true;
    return normalizeId(getServerId(server)).includes(normalizedQuery)
      || normalizeId(getJobId(server)).includes(normalizedQuery);
  }

  // Mirrors the "Show Private Servers" filter: private/locked servers report no
  // players, so they stay hidden (along with empty servers) while it is off.
  function isHiddenWhenPrivateOff(server) {
    return !server || (server.playing || 0) === 0;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Small clipboard button: shows a clipboard icon, swaps to a tick once copied.
  const COPY_BUTTON_HTML =
    '<svg class="icon-clipboard" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<rect x="4" y="2.9" width="8" height="11.1" rx="1.7"/><rect x="6.3" y="1.3" width="3.4" height="3.1" rx="1"/></svg>' +
    '<svg class="icon-check" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M3.2 8.6l3.1 3.1 6.5-7"/></svg>';

  function copyButtonHtml(value, label) {
    if (!value) return '';
    return '<button class="copy-btn" type="button" data-copy-value="' + escapeHtml(value) +
      '" title="Copy ' + label + '" aria-label="Copy ' + label + '">' + COPY_BUTTON_HTML + '</button>';
  }

  function readableLabel(key) {
    const labels = {
      'Demand Time Left': 'Demand Time Left', 'ReactorLevel': 'Reactor Level',
      'Reactor Scram State': 'Reactor SCRAM State', 'Startup XFMR': 'Startup Transformer',
      'DoAutoScramU1': 'Auto SCRAM U1', 'DoAutoScramU2': 'Auto SCRAM U2',
      'DieselRPM': 'Diesel RPM', 'Turbine RPM': 'Turbine RPM',
      'FWP1': 'Feedwater Pump 1', 'FWP2': 'Feedwater Pump 2',
      'FWP1 Temp': 'FWP 1 Temperature', 'FWP2 Temp': 'FWP 2 Temperature',
      'Hotwell Level': 'Hotwell Level', 'Recirc1': 'Recirculation Pump 1',
      'Recirc2': 'Recirculation Pump 2', 'APRM Setpoint': 'APRM Setpoint',
      'Xenon': 'Xenon', 'AutoPressure': 'Auto Pressure', 'APRM': 'APRM',
      'NextDemandU1': 'Next Demand U1', 'NextDemandU2': 'Next Demand U2',
      'DemandU1': 'Demand U1', 'DemandU2': 'Demand U2',
      'BypassTurbineAutoTrip': 'Bypass Turbine Auto Trip',
      'Output (MW)': 'Output (MW)', 'Vibrations': 'Vibrations',
      'Fuel Burn (default 0.54)': 'Fuel Burn', 'SCRAMreason': 'SCRAM Reason',
      'PointsPerSecond': 'Points Per Second', 'Avg. Rod': 'Avg. Rod Position',
      'TRIPreason': 'TRIP Reason', 'Iodine': 'Iodine',
      'Deareator Level': 'Deaerator Level', 'TurbineTrip': 'Turbine Trip',
      'Offsite Power': 'Offsite Power', 'Pressure': 'Pressure',
      'TotalPowerGenerated': 'Total Power Generated',
      'StartupUnit1': 'Startup Unit 1', 'StartupUnit2': 'Startup Unit 2',
      'BusA': 'Bus A', 'BusB': 'Bus B', 'DCBus': 'DC Bus',
      'Reactor Temp': 'Reactor Temperature',
      'RPS Trip State A': 'RPS Trip State A', 'RPS Trip State B': 'RPS Trip State B',
      'RTP': 'Rated Thermal Power', 'PradDoSieci': 'Grid Output',
      'TurbineHealth': 'Turbine Health', 'GeneratorTemperature': 'Generator Temperature',
      'CasingTemperature': 'Casing Temperature', 'Disk Ruptured': 'Disk Ruptured',
      'DiffPressure': 'Differential Pressure', 'Evacuation Cooldown': 'Evacuation Cooldown',
      'FSS Smoke Detected': 'FSS Smoke Detected', 'U2 FSS Force Repair': 'U2 FSS Force Repair',
      'Total points/second': 'Total Points/Second', 'Outside Temperature': 'Outside Temperature',
      'EDG Diesel Storage': 'EDG Diesel Storage'
    };
    return labels[key] || key;
  }

  /* ===== COLOR CODING ===== */

  function getColorClass(type, value) {
    if (value === null || value === undefined) return 'val-gray';
    switch (type) {
      case 'reactorLevel':
        if (value >= 0 && value <= 4) return 'val-green';
        if ((value >= -1 && value < 0) || (value > 4 && value <= 5)) return 'val-yellow';
        return 'val-red';
      case 'pressure':
        if (value >= 6000 && value <= 7300) return 'val-green';
        if ((value >= 4000 && value < 6000) || (value > 7200 && value <= 8000)) return 'val-yellow';
        return 'val-red';
      case 'aprm':
        if (value <= 100) return 'val-green';
        if (value <= 110) return 'val-yellow';
        return 'val-red';
      case 'reactorTemp':
        if (value >= 270 && value <= 290) return 'val-green';
        if ((value >= 200 && value < 270) || (value > 290 && value <= 300)) return 'val-yellow';
        return 'val-red';
      case 'turbineRpm':
        if (value >= 3500 && value <= 3600) return 'val-green';
        if (value >= 3000 && value < 3500) return 'val-yellow';
        return 'val-red';
      case 'output':
        if (value > 100) return 'val-green';
        if (value >= 0 && value <= 100) return 'val-yellow';
        return 'val-red';
      case 'vibrations':
        if (value < 0.1) return 'val-green';
        if (value <= 1) return 'val-yellow';
        return 'val-red';
      case 'hotwell':
        if (value >= -1 && value <= 2) return 'val-green';
        if ((value >= -2 && value < -1) || (value > 2 && value <= 3)) return 'val-yellow';
        return 'val-red';
    }
    return 'val-cyan';
  }

  function getParamColor(key, value) {
    if (value === null || value === undefined) return 'val-gray';
    if (typeof value === 'boolean') return value ? 'val-green' : 'val-red';
    if (typeof value !== 'number') return 'val-cyan';
    const lower = key.toLowerCase();
    if (lower.includes('level') || lower === 'reactorlevel') return getColorClass('reactorLevel', value);
    if (lower === 'pressure') return getColorClass('pressure', value);
    if (lower.includes('aprm') && !lower.includes('setpoint')) return getColorClass('aprm', value);
    if (lower.includes('temp') || lower.includes('temperature')) return getColorClass('reactorTemp', value);
    if (lower.includes('rpm')) return getColorClass('turbineRpm', value);
    if (lower.includes('output') || lower.includes('mw')) return getColorClass('output', value);
    if (lower.includes('vibration')) return getColorClass('vibrations', value);
    if (lower.includes('hotwell')) return getColorClass('hotwell', value);
    if (lower.includes('xenon') || lower.includes('iodine')) return value * 100 > 80 ? 'val-red' : value * 100 > 50 ? 'val-yellow' : 'val-green';
    if (lower.includes('fuel burn')) return value < 0.5 ? 'val-red' : value > 0.9 ? 'val-yellow' : 'val-green';
    if (lower.includes('health')) return value > 80 ? 'val-green' : value > 50 ? 'val-yellow' : 'val-red';
    return 'val-cyan';
  }

  function getParamStatus(key, value) {
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value !== 'number') return 'status-gray';
    const lower = key.toLowerCase();
    if (lower.includes('level') || lower === 'reactorlevel') return getColorClass('reactorLevel', value).replace('val-', 'status-');
    if (lower === 'pressure') return getColorClass('pressure', value).replace('val-', 'status-');
    if (lower.includes('aprm') && !lower.includes('setpoint')) return getColorClass('aprm', value).replace('val-', 'status-');
    if (lower.includes('temp') || lower.includes('temperature')) return getColorClass('reactorTemp', value).replace('val-', 'status-');
    if (lower.includes('rpm')) return getColorClass('turbineRpm', value).replace('val-', 'status-');
    if (lower.includes('output') || lower.includes('mw')) return getColorClass('output', value).replace('val-', 'status-');
    if (lower.includes('vibration')) return getColorClass('vibrations', value).replace('val-', 'status-');
    if (lower.includes('hotwell')) return getColorClass('hotwell', value).replace('val-', 'status-');
    return 'status-gray';
  }

  function formatValue(key, value, unitData) {
    if (value === null || value === undefined) return 'N/A';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'number') {
      const lower = key.toLowerCase();
      if (lower.includes('demand') && !lower.includes('time left')) {
        if (value === -1) return 'Maint.';
        if (!unitData || !unitData['Offsite Power']) return 'Offsite';
        return formatNumber(value, 0) + ' MW';
      }
      if (lower.includes('temp') || lower.includes('temperature')) return formatNumber(value, 2) + '°C';
      if (lower === 'pressure') return formatNumber(value, 1) + ' PSI';
      if (lower.includes('rpm')) return formatNumber(value, 0) + ' RPM';
      if (lower.includes('output') || lower.includes('mw')) return formatNumber(value, 1) + ' MW';
      if (lower.includes('level') || lower === 'hotwell level' || lower === 'deareator level') return formatNumber(value, 2) + ' m';
      if (lower.includes('fuel burn')) return formatNumber(value, 2);
      if (lower.includes('vibration')) return formatNumber(value, 3);
      if (lower.includes('xenon') || lower.includes('iodine')) return formatNumber(value * 100, 1) + '%';
      if (lower.includes('rod') || lower === 'avg. rod') return formatNumber(value, 3);
      if (lower.includes('aprm') && !lower.includes('setpoint')) return formatNumber(value, 2) + '%';
      if (lower.includes('setpoint')) return formatNumber(value, 1);
      if (lower.includes('points') || lower.includes('persecond')) return formatNumber(value, 1);
      if (lower.includes('megawatt') || lower.includes('totalpower')) return formatNumber(value, 0);
      if (lower.includes('health')) return formatNumber(value, 0) + '%';
      if (lower.includes('storage')) return formatNumber(value, 0);
      return formatNumber(value, 2);
    }
    return String(value);
  }

  /* ===== PARAM MAX VALUES ===== */

  const unitParamMaxValues = {
    'ReactorLevel': 6,
    'Pressure': 8500,
    'APRM': 120,
    'Reactor Temp': 300,
    'Turbine RPM': 3600,
    'Output (MW)': 1200,
    'FWP1': 100,
    'FWP2': 100,
    'Hotwell Level': 3,
    'Recirc1': 100,
    'Recirc2': 100,
    'Deareator Level': 6,
    'PointsPerSecond': [1.2, 1.7],
    'DieselRPM': 1800,
    'Vibrations': 50,
    'TurbineHealth': 100,
    'GeneratorTemperature': 300,
    'CasingTemperature': 300,
    'PradDoSieci': 120,
    'RTP': 120
  };

  function getMaxValue(key, unitName) {
    const raw = unitParamMaxValues[key];
    if (raw === undefined) return undefined;
    if (Array.isArray(raw)) {
      return unitName === 'Unit 1' ? raw[0] : raw[1];
    }
    return raw;
  }

  /* ===== RECAPTCHA v2 ===== */

  function initCaptcha() {
    function tryInit() {
      captchaSiteKey = window.__RBWR_SITE_KEY;

      if (captchaSiteKey === null) {
        setTimeout(tryInit, 100);
        return;
      }

      if (!captchaSiteKey) {
        dom.captchaGate.classList.add('hidden');
        initWebSocket();
        return;
      }

      var checkReady = setInterval(function () {
        if (typeof grecaptcha !== 'undefined' && typeof grecaptcha.render === 'function') {
          clearInterval(checkReady);
          setTimeout(function () { renderCaptchaWidget(); }, 500);
        }
      }, 300);

      setTimeout(function () {
        if (typeof grecaptcha === 'undefined') {
          clearInterval(checkReady);
          document.getElementById('captchaLoadError').classList.remove('hidden');
        }
      }, 15000);
    }

    tryInit();
  }

  function renderCaptchaWidget() {
    var container = document.getElementById('recaptchaContainer');
    if (!container) return;

    grecaptcha.render(container, {
      sitekey: captchaSiteKey,
      callback: function (token) {
        window.onCaptchaSuccess(token);
      },
      'expired-callback': function () {
        dom.captchaError.textContent = 'Captcha expired. Please verify again.';
        dom.captchaError.classList.remove('hidden');
      },
      'error-callback': function () {
        dom.captchaError.textContent = 'Captcha error. Please try again.';
        dom.captchaError.classList.remove('hidden');
      }
    });
  }

  window.onCaptchaSuccess = function (token) {
    dom.captchaError.classList.add('hidden');
    fetch('/api/verify-captcha', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.success) {
          dom.captchaGate.classList.add('hidden');
          initWebSocket();
        } else {
          dom.captchaError.textContent = 'Verification failed. Please try again.';
          dom.captchaError.classList.remove('hidden');
          if (typeof grecaptcha !== 'undefined') grecaptcha.reset();
        }
      })
      .catch(function () {
        dom.captchaError.textContent = 'Verification service unavailable. Try again later.';
        dom.captchaError.classList.remove('hidden');
      });
  };

  /* ===== WEBSOCKET ===== */

  let wsReconnectAttempts = 0;
  const WS_MAX_RECONNECT = 30000;

  function initWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host);

    ws.onopen = function () {
      console.log('WebSocket connected');
      wsReconnectAttempts = 0;
      dom.loading.classList.add('hidden');
      dom.errorMessage.classList.add('hidden');
    };

    ws.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'update' && msg.data) {
          allServers = msg.data.servers || [];
          lastDataTimestamp = new Date().toISOString();
          dropFavoritesThatStopped(msg.data);
          updateStats(msg.data);
          renderTable();
          if (currentModalServer) {
            const updated = allServers.find(s => s.id === currentModalServer.id);
            if (updated) {
              currentModalServer = updated;
              const activeTab = document.querySelector('.tab-btn.active');
              if (activeTab) {
                const tab = activeTab.getAttribute('data-tab');
                if (tab === 'overview') renderOverviewTab(updated);
                else renderUnitTab(updated.rbwr && updated.rbwr.state ? updated.rbwr.state[tab === 'unit1' ? 'Unit1' : 'Unit2'] : null, tab === 'unit1' ? 'Unit 1' : 'Unit 2');
              }
            }
          }
          dom.loading.classList.add('hidden');
          dom.serverTableContainer.classList.remove('hidden');
        }
      } catch (e) {
        console.error('WS message parse error:', e);
      }
    };

    ws.onclose = function (event) {
      if (event.code === 1013) return;
      const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), WS_MAX_RECONNECT);
      wsReconnectAttempts++;
      wsReconnectTimer = setTimeout(initWebSocket, delay);
    };

    ws.onerror = function () {
      console.error('WebSocket error');
    };
  }

  /* ===== STATS ===== */

  function updateStats(data) {
    const servers = data.servers || [];
    const totalPlayers = servers.reduce((sum, s) => sum + (s.playing || 0), 0);
    let unit1MW = 0, unit2MW = 0;

    servers.forEach(server => {
      if (server.rbwr && server.rbwr.state) {
        const u1 = server.rbwr.state.Unit1;
        const u2 = server.rbwr.state.Unit2;
        if (u1) unit1MW += u1['Output (MW)'] || 0;
        if (u2) unit2MW += u2['Output (MW)'] || 0;
      }
    });

    if (data.stats) {
      if (data.stats.unit1) unit1MW = data.stats.unit1.megawatts || unit1MW;
      if (data.stats.unit2) unit2MW = data.stats.unit2.megawatts || unit2MW;
    }

    dom.statTotalServers.textContent = servers.length;
    dom.statTotalPlayers.textContent = totalPlayers;
    dom.statUnit1MW.textContent = formatNumber(unit1MW, 0);
    dom.statUnit2MW.textContent = formatNumber(unit2MW, 0);
    dom.statUnit1PPS.textContent = data.stats && data.stats.unit1 ? formatNumber(data.stats.unit1.pointsPerSecond, 1) : '0';
    dom.statUnit2PPS.textContent = data.stats && data.stats.unit2 ? formatNumber(data.stats.unit2.pointsPerSecond, 1) : '0';
    dom.statLastUpdated.textContent = data.meta ? timeAgo(data.meta.lastUpdated) : '--';
  }

  /* ===== FILTER & SORT ===== */

  function updateFavoriteFilterButton() {
    if (!dom.favoriteFilterBtn) return;
    dom.favoriteFilterBtn.textContent = (showFavoritesOnly ? '★' : '☆') + ' Favorites (' + favorites.size + ')';
    dom.favoriteFilterBtn.classList.toggle('active', showFavoritesOnly);
    dom.favoriteFilterBtn.setAttribute('aria-pressed', String(showFavoritesOnly));
  }

  function toggleFavorite(serverId) {
    if (favorites.has(serverId)) favorites.delete(serverId);
    else favorites.add(serverId);
    saveFavorites();
    updateFavoriteFilterButton();
    renderTable();
  }

  // A favorite is dropped once its server stops running and disappears from the
  // polled list. Skipped on a degraded poll, otherwise an API outage would look
  // like every server having stopped.
  function dropFavoritesThatStopped(data) {
    if (favorites.size === 0) return;
    if (!data.meta || !data.meta.rbwrApiAvailable) return;

    const running = new Set((data.servers || []).map(s => s.id));
    let dropped = false;

    favorites.forEach(id => {
      if (!running.has(id)) {
        favorites.delete(id);
        dropped = true;
      }
    });

    if (dropped) {
      saveFavorites();
      updateFavoriteFilterButton();
    }
  }

  function getFilteredServers() {
    let filtered = [...allServers];
    searchHiddenMatches = 0;

    if (showFavoritesOnly) {
      filtered = filtered.filter(s => favorites.has(s.id));
    }

    if (searchQuery) {
      const q = normalizeId(searchQuery);
      filtered = filtered.filter(s => matchesIdSearch(s, q));
    }

    if (!dom.showPrivate.checked) {
      const visible = filtered.filter(s => !isHiddenWhenPrivateOff(s));
      searchHiddenMatches = filtered.length - visible.length;
      filtered = visible;
    }

    switch (currentFilter) {
      case 'has-players': filtered = filtered.filter(s => s.playing > 0); break;
      case 'has-rbwr': filtered = filtered.filter(s => s.rbwr !== null); break;
      case 'scrammed':
        filtered = filtered.filter(s => s.rbwr && s.rbwr.state && s.rbwr.state.Unit1 && s.rbwr.state.Unit1['Reactor Scram State'] === true);
        break;
      case 'scrammed2':
        filtered = filtered.filter(s => s.rbwr && s.rbwr.state && s.rbwr.state.Unit2 && s.rbwr.state.Unit2['Reactor Scram State'] === true);
        break;
      case 'online':
        filtered = filtered.filter(s => {
          if (!s.rbwr || !s.rbwr.state) return false;
          const u1 = s.rbwr.state.Unit1, u2 = s.rbwr.state.Unit2;
          return u1 && u2 && !u1['Reactor Scram State'] && !u2['Reactor Scram State'];
        });
        break;
    }

    filtered.sort((a, b) => {
      let aVal, bVal;
      switch (currentSort.column) {
        case 'id':
          aVal = getServerId(a) || getJobId(a); bVal = getServerId(b) || getJobId(b);
          return currentSort.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        case 'players': aVal = a.playing || 0; bVal = b.playing || 0; break;
        case 'fps': aVal = a.fps || 0; bVal = b.fps || 0; break;
        case 'ping': aVal = a.ping || 0; bVal = b.ping || 0; break;
        case 'totalpps':
          aVal = a.rbwr && a.rbwr.state ? ((a.rbwr.state.Unit1 && a.rbwr.state.Unit1['PointsPerSecond'] || 0) + (a.rbwr.state.Unit2 && a.rbwr.state.Unit2['PointsPerSecond'] || 0)) : 0;
          bVal = b.rbwr && b.rbwr.state ? ((b.rbwr.state.Unit1 && b.rbwr.state.Unit1['PointsPerSecond'] || 0) + (b.rbwr.state.Unit2 && b.rbwr.state.Unit2['PointsPerSecond'] || 0)) : 0;
          break;
        case 'totalpp':
          aVal = a.rbwr && a.rbwr.state ? ((a.rbwr.state.Unit1 && a.rbwr.state.Unit1['TotalPowerGenerated'] || 0) + (a.rbwr.state.Unit2 && a.rbwr.state.Unit2['TotalPowerGenerated'] || 0)) : 0;
          bVal = b.rbwr && b.rbwr.state ? ((b.rbwr.state.Unit1 && b.rbwr.state.Unit1['TotalPowerGenerated'] || 0) + (b.rbwr.state.Unit2 && b.rbwr.state.Unit2['TotalPowerGenerated'] || 0)) : 0;
          break;
        default: aVal = a.playing || 0; bVal = b.playing || 0;
      }
      if (typeof aVal === 'number') return currentSort.direction === 'asc' ? aVal - bVal : bVal - aVal;
      return 0;
    });

    return filtered;
  }

  /* ===== TABLE ===== */

  function renderTable() {
    const filtered = getFilteredServers();
    dom.serverTableBody.innerHTML = '';

    if (filtered.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 9;
      cell.className = 'no-data';
      cell.style.textAlign = 'center';
      cell.style.padding = '2rem';

      if (showFavoritesOnly && !searchQuery) {
        cell.textContent = 'No matching favorites — click a star beside a server to save one.';
      } else if (searchQuery && searchHiddenMatches > 0) {
        cell.textContent = 'No visible server for "' + searchQuery + '" — ' + searchHiddenMatches +
          ' matching server' + (searchHiddenMatches === 1 ? ' is' : 's are') +
          ' hidden. Tick "Show Private Servers" to include private and empty servers.';
      } else if (searchQuery) {
        cell.textContent = 'No server found with Server ID or Job ID "' + searchQuery + '".';
      } else {
        cell.textContent = 'No servers found';
      }

      row.appendChild(cell);
      dom.serverTableBody.appendChild(row);
      return;
    }

    filtered.forEach(server => {
      const row = document.createElement('tr');
      const isSearchMatch = searchQuery && matchesIdSearch(server, normalizeId(searchQuery));
      if (isSearchMatch) row.classList.add('highlight-row');

      let unit1Html = '<div class="no-data">No reactor data</div>';
      let unit2Html = '<div class="no-data">No reactor data</div>';

      if (server.rbwr && server.rbwr.state) {
        const u1 = server.rbwr.state.Unit1;
        const u2 = server.rbwr.state.Unit2;

        if (u1) {
          const scrammed = u1['Reactor Scram State'];
          const statusClass = scrammed ? 'status-scram' : (u1['Output (MW)'] > 0 ? 'status-online' : 'status-offline');
          unit1Html = `<div class="unit-overview">
            <span class="unit-name">Unit 1 <span class="status-dot ${statusClass}"></span></span>
            <div class="unit-data">
              <div class="data-item"><span class="data-label">MW:</span> <span class="data-value ${getColorClass('output', u1['Output (MW)'])}">${formatNumber(u1['Output (MW)'], 1)}</span></div>
              <div class="data-item"><span class="data-label">Level:</span> <span class="data-value ${getColorClass('reactorLevel', u1['ReactorLevel'])}">${formatNumber(u1['ReactorLevel'], 2)}m</span></div>
              <div class="data-item"><span class="data-label">SCRAM:</span> <span class="data-value ${scrammed ? 'val-red' : 'val-green'}">${scrammed ? 'YES' : 'No'}</span></div>
            </div>
          </div>`;
        }

        if (u2) {
          const scrammed = u2['Reactor Scram State'];
          const u2Output = u2['Output (MW)'] || u2['PradDoSieci'] || 0;
          const statusClass = scrammed ? 'status-scram' : (u2Output > 0 ? 'status-online' : 'status-offline');
          unit2Html = `<div class="unit-overview">
            <span class="unit-name">Unit 2 <span class="status-dot ${statusClass}"></span></span>
            <div class="unit-data">
              <div class="data-item"><span class="data-label">MW:</span> <span class="data-value ${getColorClass('output', u2Output)}">${formatNumber(u2Output, 1)}</span></div>
              <div class="data-item"><span class="data-label">Level:</span> <span class="data-value ${getColorClass('reactorLevel', u2['ReactorLevel'])}">${formatNumber(u2['ReactorLevel'], 2)}m</span></div>
              <div class="data-item"><span class="data-label">SCRAM:</span> <span class="data-value ${scrammed ? 'val-red' : 'val-green'}">${scrammed ? 'YES' : 'No'}</span></div>
            </div>
          </div>`;
        }
      }

      const totalPPS = (server.rbwr && server.rbwr.state)
        ? ((server.rbwr.state.Unit1 && server.rbwr.state.Unit1['PointsPerSecond'] || 0) +
           (server.rbwr.state.Unit2 && server.rbwr.state.Unit2['PointsPerSecond'] || 0))
        : 0;

      const totalProducedPower = (server.rbwr && server.rbwr.state)
        ? ((server.rbwr.state.Unit1 && server.rbwr.state.Unit1['TotalPowerGenerated'] || 0) +
           (server.rbwr.state.Unit2 && server.rbwr.state.Unit2['TotalPowerGenerated'] || 0))
        : 0;

      const serverId = getServerId(server);
      const jobId = getJobId(server);
      const serverIdTitle = 'Server ID: ' + (serverId || 'N/A') + '\nJob ID: ' + (jobId || 'N/A');
      const serverIdDisplay = serverId ? shortId(serverId) : '<span class="no-data">N/A</span>';

      row.innerHTML = `
        <td class="favorite-cell"><button class="favorite-star ${favorites.has(server.id) ? 'is-favorite' : ''}" type="button" aria-label="${favorites.has(server.id) ? 'Remove from' : 'Add to'} favorites" aria-pressed="${favorites.has(server.id)}" title="${favorites.has(server.id) ? 'Remove from' : 'Add to'} favorites">${favorites.has(server.id) ? '★' : '☆'}</button></td>
        <td><div class="server-id-cell" title="${serverIdTitle}">${serverIdDisplay}</div></td>
        <td class="players-cell ${server.playing === 0 && server.maxPlayers === 0 ? 'players-private' : server.playing <= 8 ? 'players-low' : server.playing <= 11 ? 'players-mid' : 'players-full'}">${server.playing === 0 && server.maxPlayers === 0 ? "Priv" : `${server.playing}/${server.maxPlayers}`}</td>
        <td>${server.fps ? formatNumber(server.fps, 1) : 'N/A'}</td>
        <td>${server.ping ? formatNumber(server.ping, 0) : 'N/A'}</td>
        <td>${unit1Html}</td>
        <td>${unit2Html}</td>
        <td class="total-pps-cell">${formatNumber(totalPPS, 1)}</td>
        <td class="total-pp-cell">${formatNumber(totalProducedPower, 0)} MW</td>
      `;

      const favoriteButton = row.querySelector('.favorite-star');
      favoriteButton.addEventListener('click', function (event) {
        event.stopPropagation();
        toggleFavorite(server.id);
      });
      row.addEventListener('click', () => openServerModal(server.id));
      dom.serverTableBody.appendChild(row);
    });

    document.querySelectorAll('.server-table th.sortable').forEach(th => {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.dataset.sort === currentSort.column) {
        th.classList.add(currentSort.direction === 'asc' ? 'sorted-asc' : 'sorted-desc');
      }
    });
  }

  /* ===== PLAYER LIST ===== */

  function showPlayerList(server) {
    const players = server.players || [];
    dom.playerListContent.innerHTML = '';
    if (players.length === 0) {
      dom.playerListContent.innerHTML = '<div class="no-players">No players in this server</div>';
    } else {
      players.forEach(player => {
        const item = document.createElement('div');
        item.className = 'player-item';
        item.innerHTML = `<span class="player-name">${player.displayName || player.name}</span><span class="player-id">@${player.name} (ID: ${player.id})</span>`;
        dom.playerListContent.appendChild(item);
      });
    }
    dom.playerListModal.classList.remove('hidden');
  }

  /* ===== SERVER MODAL ===== */

  function openServerModal(serverId) {
    const server = allServers.find(s => s.id === serverId);
    if (!server) return;

    currentModalServer = server;
    dom.modalOverlay.classList.remove('hidden');
    dom.modalTitle.textContent = 'Server: ' + shortId(getServerId(server) || serverId);

    const isFull = server.maxPlayers > 0 && server.playing >= server.maxPlayers;
    dom.modalJoinBtn.textContent = isFull ? 'Join Queue' : 'Join';

    document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
    document.querySelector('.tab-btn[data-tab="overview"]').classList.add('active');
    renderOverviewTab(server);
  }

  function formatDemandTime(seconds) {
    if (seconds === null || seconds === undefined) return 'N/A';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + 'm ' + s + 's';
  }

  function renderOverviewTab(server) {
    let html = '<div class="overview-grid">';

    const serverIdValue = getServerId(server);
    const jobIdValue = getJobId(server);

    const totalProducedPower = (server.rbwr && server.rbwr.state)
      ? ((server.rbwr.state.Unit1 && server.rbwr.state.Unit1['TotalPowerGenerated'] || 0) +
         (server.rbwr.state.Unit2 && server.rbwr.state.Unit2['TotalPowerGenerated'] || 0))
      : 0;

    let demandTimeLeft = null;
    if (server.rbwr && server.rbwr.state) {
      const t1 = server.rbwr.state.Unit1 && server.rbwr.state.Unit1['Demand Time Left'];
      const t2 = server.rbwr.state.Unit2 && server.rbwr.state.Unit2['Demand Time Left'];
      if (t1 !== undefined && t2 !== undefined) demandTimeLeft = Math.min(t1, t2);
      else if (t1 !== undefined) demandTimeLeft = t1;
      else if (t2 !== undefined) demandTimeLeft = t2;
    }
    if (demandTimeLeft !== lastServerDemandTime) {
      demandTimeLeftSeconds = demandTimeLeft;
      lastServerDemandTime = demandTimeLeft;
    }

    html += `<div class="info-stack">
      <div class="info-card">
        <h3>Server Information</h3>
        <div class="info-row"><span class="label">Server ID</span><span class="value job-id-value"><code class="job-id">${serverIdValue ? escapeHtml(serverIdValue) : 'N/A'}</code>${copyButtonHtml(serverIdValue, 'Server ID')}</span></div>
        <div class="info-row"><span class="label">Job ID</span><span class="value job-id-value"><code class="job-id">${jobIdValue ? escapeHtml(jobIdValue) : 'N/A'}</code>${copyButtonHtml(jobIdValue, 'Job ID')}</span></div>
        <div class="info-row"><span class="label">Players</span><span class="value">${server.playing === 0 && server.maxPlayers === 0 ? "Priv" : `${server.playing}/${server.maxPlayers}`}</span></div>
        <div class="info-row"><span class="label">FPS</span><span class="value">${formatNumber(server.fps, 1)}</span></div>
        <div class="info-row"><span class="label">Ping</span><span class="value">${formatNumber(server.ping, 0)} ms</span></div>
        <div class="info-row"><span class="label">Time to Next Demand</span><span class="value" id="demandTimeLeftValue">${formatDemandTime(demandTimeLeft)}</span></div>
        <div class="info-row"><span class="label">Total Produced Power</span><span class="value">${formatNumber(totalProducedPower, 0)} MW</span></div>
      </div>
      ${server.rbwr && server.rbwr.state && server.rbwr.state.Misc ? (() => {
        const misc = server.rbwr.state.Misc;
        return `<div class="info-card">
          <h3>Miscellaneous</h3>
          <div class="info-row"><span class="label">Outside Temperature</span><span class="value">${formatNumber(misc['Outside Temperature'], 1)}°C</span></div>
          <div class="info-row"><span class="label">EDG Diesel Storage</span><span class="value">${formatNumber(misc['EDG Diesel Storage'], 0)}</span></div>
          <div class="info-row"><span class="label">Evacuation Cooldown</span><span class="value">${formatNumber(misc['Evacuation Cooldown'], 0)}</span></div>
          <div class="info-row"><span class="label">FSS Smoke Detected</span><span class="value ${misc['FSS Smoke Detected'] ? 'val-red' : 'val-green'}">${misc['FSS Smoke Detected'] ? 'YES' : 'No'}</span></div>
          <div class="info-row"><span class="label">U2 FSS Force Repair</span><span class="value">${misc['U2 FSS Force Repair'] ? 'Yes' : 'No'}</span></div>
          <div class="info-row"><span class="label">Total Points/Second</span><span class="value">${formatNumber(misc['Total points/second'], 1)}</span></div>
        </div>`;
      })() : ''}
    </div>`;

    if (server.rbwr && server.rbwr.state) {
      const u1 = server.rbwr.state.Unit1;
      const u2 = server.rbwr.state.Unit2;

      if (u1) {
        html += `<div class="info-card">
          <h3>Unit 1 Status</h3>
          <div class="big-metric"><div class="metric-value ${getColorClass('output', u1['Output (MW)'])}">${formatNumber(u1['Output (MW)'], 1)}</div><div class="metric-label">Output (MW)</div></div>
          <div class="info-row"><span class="label">Demand</span><span class="value val-cyan">${u1['DemandU1'] === -1 ? 'Maint.' : (!u1['Offsite Power'] ? 'Offsite' : formatNumber(u1['DemandU1'], 0) + ' MW')}</span></div>
          ${u1['Offsite Power'] ? `<div class="info-row"><span class="label">Next Demand</span><span class="value val-cyan">${u1['NextDemandU1'] === -1 ? 'Maint.' : formatNumber(u1['NextDemandU1'], 0) + ' MW'}</span></div>` : ''}
          <div class="info-row"><span class="label">Reactor Level</span><span class="value ${getColorClass('reactorLevel', u1['ReactorLevel'])}">${formatNumber(u1['ReactorLevel'], 2)} m</span></div>
          <div class="info-row"><span class="label">Pressure</span><span class="value ${getColorClass('pressure', u1['Pressure'])}">${formatNumber(u1['Pressure'], 1)} PSI</span></div>
          <div class="info-row"><span class="label">APRM</span><span class="value ${getColorClass('aprm', u1['APRM'])}">${formatNumber(u1['APRM'], 2)}%</span></div>
          <div class="info-row"><span class="label">Turbine RPM</span><span class="value ${getColorClass('turbineRpm', u1['Turbine RPM'])}">${formatNumber(u1['Turbine RPM'], 0)}</span></div>
          <div class="info-row"><span class="label">Reactor SCRAM</span><span class="value ${u1['Reactor Scram State'] ? 'val-red' : 'val-green'}">${u1['Reactor Scram State'] ? 'YES' : 'No'}</span></div>
          ${u1['SCRAMreason'] ? `<div class="info-row"><span class="label">SCRAM Reason</span><span class="value val-red">${u1['SCRAMreason']}</span></div>` : ''}
          <div class="info-row"><span class="label">Turbine Trip</span><span class="value ${u1['TurbineTrip'] ? 'val-red' : 'val-green'}">${u1['TurbineTrip'] ? 'YES' : 'No'}</span></div>
          ${u1['TRIPreason'] ? `<div class="info-row"><span class="label">TRIP Reason</span><span class="value val-red">${u1['TRIPreason']}</span></div>` : ''}
          <div class="info-row"><span class="label">Total Power Generated</span><span class="value">${formatNumber(u1['TotalPowerGenerated'], 0)} MW</span></div>
          <div class="info-row"><span class="label">Points/Second</span><span class="value">${formatNumber(u1['PointsPerSecond'], 1)}</span></div>
        </div>`;
      }

      if (u2) {
        html += `<div class="info-card">
          <h3>Unit 2 Status</h3>
          <div class="big-metric"><div class="metric-value ${getColorClass('output', u2['Output (MW)'] || u2['PradDoSieci'])}">${formatNumber(u2['Output (MW)'] || u2['PradDoSieci'], 1)}</div><div class="metric-label">Output (MW)</div></div>
          <div class="info-row"><span class="label">Demand</span><span class="value val-cyan">${u2['DemandU2'] === -1 ? 'Maint.' : (!u2['Offsite Power'] ? 'Offsite' : formatNumber(u2['DemandU2'], 0) + ' MW')}</span></div>
          ${u2['Offsite Power'] ? `<div class="info-row"><span class="label">Next Demand</span><span class="value val-cyan">${u2['NextDemandU2'] === -1 ? 'Maint.' : formatNumber(u2['NextDemandU2'], 0) + ' MW'}</span></div>` : ''}
          <div class="info-row"><span class="label">Reactor Level</span><span class="value ${getColorClass('reactorLevel', u2['ReactorLevel'])}">${formatNumber(u2['ReactorLevel'], 2)} m</span></div>
          <div class="info-row"><span class="label">Pressure</span><span class="value ${getColorClass('pressure', u2['Pressure'])}">${formatNumber(u2['Pressure'], 1)} PSI</span></div>
          <div class="info-row"><span class="label">APRM</span><span class="value ${getColorClass('aprm', u2['APRM'])}">${formatNumber(u2['APRM'], 2)}%</span></div>
          <div class="info-row"><span class="label">Turbine RPM</span><span class="value ${getColorClass('turbineRpm', u2['Turbine RPM'])}">${formatNumber(u2['Turbine RPM'], 0)}</span></div>
          <div class="info-row"><span class="label">Reactor SCRAM</span><span class="value ${u2['Reactor Scram State'] ? 'val-red' : 'val-green'}">${u2['Reactor Scram State'] ? 'YES' : 'No'}</span></div>
          ${u2['SCRAMreason'] ? `<div class="info-row"><span class="label">SCRAM Reason</span><span class="value val-red">${u2['SCRAMreason']}</span></div>` : ''}
          <div class="info-row"><span class="label">Turbine Trip</span><span class="value ${u2['TurbineTrip'] ? 'val-red' : 'val-green'}">${u2['TurbineTrip'] ? 'YES' : 'No'}</span></div>
          ${u2['TRIPreason'] ? `<div class="info-row"><span class="label">TRIP Reason</span><span class="value val-red">${u2['TRIPreason']}</span></div>` : ''}
          <div class="info-row"><span class="label">Turbine Health</span><span class="value ${getColorClass('health', u2['TurbineHealth'])}">${formatNumber(u2['TurbineHealth'], 0)}%</span></div>
          <div class="info-row"><span class="label">Generator Temp</span><span class="value ${getColorClass('reactorTemp', u2['GeneratorTemperature'])}">${formatNumber(u2['GeneratorTemperature'], 1)}°C</span></div>
          <div class="info-row"><span class="label">Total Power Generated</span><span class="value">${formatNumber(u2['TotalPowerGenerated'], 0)} MW</span></div>
          <div class="info-row"><span class="label">Points/Second</span><span class="value">${formatNumber(u2['PointsPerSecond'], 1)}</span></div>
        </div>`;
      }

    } else {
      html += `<div class="info-card" style="grid-column: 1/-1;"><h3>No reactor data available for this server</h3></div>`;
    }

    html += '</div>';

    if (server.players && server.players.length > 0) {
      html += `<div class="info-card" style="margin-top:1.25rem;">
        <h3>Players (${server.players.length})</h3>
        <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">
          ${server.players.map(p => `<span style="font-size:0.8rem;color:var(--accent-cyan);">@${p.name}</span>`).join(', ')}
        </div>
      </div>`;
    }

    dom.modalContent.innerHTML = html;
  }

  function renderUnitTab(unitData, unitName) {
    if (!unitData) {
      dom.modalContent.innerHTML = '<div class="no-data" style="padding:2rem;text-align:center;">No data available for ' + unitName + '</div>';
      return;
    }

    const reactorParams = ['ReactorLevel', 'Reactor Temp', 'Pressure', 'APRM', 'APRM Setpoint', 'Avg. Rod', 'Xenon', 'Iodine', 'Fuel Burn (default 0.54)'];
    const turbineParams = unitName === 'Unit 1'
      ? ['Turbine RPM', 'Output (MW)', 'TotalPowerGenerated', 'TurbineTrip', 'Vibrations', 'BypassTurbineAutoTrip']
      : ['Turbine RPM', 'RTP', 'PradDoSieci', 'TurbineHealth', 'GeneratorTemperature', 'CasingTemperature', 'TurbineTrip', 'Vibrations', 'BypassTurbineAutoTrip', 'Disk Ruptured'];
    const pumpParams = unitName === 'Unit 1'
      ? ['FWP1', 'FWP2', 'Hotwell Level', 'Recirc1', 'Recirc2', 'Deareator Level']
      : ['FWP1', 'FWP2', 'FWP1 Temp', 'FWP2 Temp', 'Hotwell Level', 'Recirc1', 'Recirc2', 'Deareator Level'];
    const electricalParams = unitName === 'Unit 1'
      ? ['BusA', 'BusB', 'Offsite Power', 'Startup XFMR']
      : ['BusA', 'BusB', 'DCBus', 'Offsite Power'];
    const safetyParams = unitName === 'Unit 1'
      ? ['Reactor Scram State', 'SCRAMreason', 'DoAutoScramU1', 'DieselRPM', 'TRIPreason']
      : ['Reactor Scram State', 'SCRAMreason', 'RPS Trip State A', 'RPS Trip State B', 'DoAutoScramU2', 'DieselRPM', 'TRIPreason'];
    const demandParams = (unitName === 'Unit 1'
      ? ['DemandU1', 'NextDemandU1', 'Demand Time Left', 'AutoPressure', 'PointsPerSecond', 'StartupUnit1']
      : ['DemandU2', 'NextDemandU2', 'Demand Time Left', 'AutoPressure', 'PointsPerSecond', 'StartupUnit2'])
      .filter(k => k.startsWith('NextDemand') ? unitData['Offsite Power'] : true);
    const extraParams = unitName === 'Unit 1' ? [] : ['DiffPressure'];

    function renderParamGroup(title, icon, keys) {
      const validKeys = keys.filter(k => unitData[k] !== undefined);
      if (validKeys.length === 0) return '';
      return `<div class="param-group">
        <div class="param-group-title">${icon} ${title}</div>
        <div class="parameter-grid">
          ${validKeys.map(key => {
            const maxVal = getMaxValue(key, unitName);
            const exceeded = maxVal !== undefined && typeof unitData[key] === 'number' && unitData[key] > maxVal;
            const colorClass = exceeded ? 'val-red' : getParamColor(key, unitData[key]);
            const displayVal = maxVal !== undefined ? `${formatValue(key, unitData[key], unitData)} / ${maxVal}` : formatValue(key, unitData[key], unitData);
            return `<div class="param-item ${exceeded ? 'status-red' : getParamStatus(key, unitData[key])}">
              <div class="param-label">${readableLabel(key)}</div>
              <div class="param-value ${colorClass}">${displayVal}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }

    dom.modalContent.innerHTML = `
      <div class="big-metric" style="margin-bottom:1.5rem;">
        <div class="metric-value ${getColorClass('output', unitData['Output (MW)'] || unitData['PradDoSieci'])}">${formatNumber(unitData['Output (MW)'] || unitData['PradDoSieci'], 1)} MW</div>
        <div class="metric-label">${unitName} Output</div>
      </div>
      ${renderParamGroup('Reactor Parameters', '', reactorParams)}
      ${renderParamGroup('Turbine / Generator', '', turbineParams)}
      ${renderParamGroup('Pumps & Levels', '', pumpParams)}
      ${renderParamGroup('Electrical Systems', '', electricalParams)}
      ${renderParamGroup('Safety Systems', '', safetyParams)}
      ${renderParamGroup('Demand / Control', '', demandParams)}
      ${extraParams.length ? renderParamGroup('Additional Parameters', '', extraParams) : ''}
    `;
  }

  function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`.tab-btn[data-tab="${tabName}"]`).classList.add('active');
    if (!currentModalServer) return;
    switch (tabName) {
      case 'overview': renderOverviewTab(currentModalServer); break;
      case 'unit1': renderUnitTab(currentModalServer.rbwr && currentModalServer.rbwr.state ? currentModalServer.rbwr.state.Unit1 : null, 'Unit 1'); break;
      case 'unit2': renderUnitTab(currentModalServer.rbwr && currentModalServer.rbwr.state ? currentModalServer.rbwr.state.Unit2 : null, 'Unit 2'); break;
    }
    dom.modalContent.style.animation = 'none';
    dom.modalContent.offsetHeight;
    dom.modalContent.style.animation = '';
  }

  /* ===== EVENT LISTENERS ===== */

  let searchTimeout;
  dom.searchInput.addEventListener('input', function () {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchQuery = dom.searchInput.value.trim();
      dom.clearSearchBtn.classList.toggle('hidden', !searchQuery);
      renderTable();
    }, 300);
  });

  dom.searchBtn.addEventListener('click', function () {
    searchQuery = dom.searchInput.value.trim();
    dom.clearSearchBtn.classList.toggle('hidden', !searchQuery);
    renderTable();
  });

  dom.searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      searchQuery = dom.searchInput.value.trim();
      dom.clearSearchBtn.classList.toggle('hidden', !searchQuery);
      renderTable();
    }
  });

  dom.clearSearchBtn.addEventListener('click', function () {
    dom.searchInput.value = '';
    searchQuery = '';
    dom.clearSearchBtn.classList.add('hidden');
    renderTable();
  });

  dom.showPrivate.addEventListener('change', function () {
    renderTable();
  });

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    return new Promise(function (resolve) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        resolve(ok);
      } catch (e) {
        resolve(false);
      }
    });
  }

  // Delegated: the overview markup is rebuilt on every WebSocket update.
  dom.modalContent.addEventListener('click', function (e) {
    const btn = e.target && e.target.closest ? e.target.closest('.copy-btn') : null;
    if (!btn) return;
    const value = btn.getAttribute('data-copy-value');
    if (!value) return;
    copyToClipboard(value).then(function (ok) {
      btn.classList.toggle('copied', ok);
      btn.classList.toggle('failed', !ok);
      btn.setAttribute('title', ok ? 'Copied!' : 'Copy failed');
      setTimeout(function () {
        btn.classList.remove('copied', 'failed');
        btn.setAttribute('title', btn.getAttribute('aria-label') || 'Copy');
      }, 1500);
    });
  });

  dom.favoriteFilterBtn.addEventListener('click', function () {
    showFavoritesOnly = !showFavoritesOnly;
    updateFavoriteFilterButton();
    renderTable();
  });
  updateFavoriteFilterButton();

  dom.retryBtn.addEventListener('click', function () {
    dom.errorMessage.classList.add('hidden');
    dom.loading.classList.remove('hidden');
    initWebSocket();
  });

  document.querySelectorAll('.server-table th.sortable').forEach(th => {
    th.addEventListener('click', function () {
      const column = this.dataset.sort;
      if (currentSort.column === column) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort.column = column;
        currentSort.direction = 'desc';
      }
      renderTable();
    });
  });

  function closeServerModal() {
    dom.serverModal.classList.add('modal-closing');
    setTimeout(function () {
      dom.modalOverlay.classList.add('hidden');
      dom.serverModal.classList.remove('modal-closing');
      currentModalServer = null;
    }, 200);
  }

  dom.modalCloseBtn.addEventListener('click', closeServerModal);

  dom.modalOverlay.addEventListener('click', function (e) {
    if (e.target === dom.modalOverlay) {
      closeServerModal();
    }
  });

  dom.modalJoinBtn.addEventListener('click', function () {
    if (currentModalServer && currentModalServer.id) {
      window.location.href = `roblox://placeId=11765852158&gameInstanceId=${currentModalServer.id}`;
    }
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', function () { switchTab(this.dataset.tab); });
  });

  document.querySelector('.close-player-list').addEventListener('click', function () {
    dom.playerListModal.classList.add('hidden');
  });

  dom.playerListModal.addEventListener('click', function (e) {
    if (e.target === dom.playerListModal) dom.playerListModal.classList.add('hidden');
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!dom.playerListModal.classList.contains('hidden')) {
        dom.playerListModal.classList.add('hidden');
      } else if (!dom.modalOverlay.classList.contains('hidden')) {
        closeServerModal();
      }
    }
  });

  // --- Init ---
  initCaptcha();
})();
