"use strict";

(function () {
  var CFG = window.CONFIG || {};
  var BASE = (CFG.HUXLEY_BASE_URL || "").replace(/\/+$/, "");
  var NUM_ROWS = CFG.NUM_ROWS || 6;
  var REFRESH_MS = CFG.REFRESH_MS || 45000;
  var DEMO = /[?&]demo=1\b/.test(location.search);

  var KEY_FROM = "cmtboard.from";
  var KEY_TO = "cmtboard.to";

  // ---- DOM ----
  var fromInput = document.getElementById("from-input");
  var toInput = document.getElementById("to-input");
  var fromList = document.getElementById("from-list");
  var toList = document.getElementById("to-list");
  var swapBtn = document.getElementById("swap-btn");
  var refreshBtn = document.getElementById("refresh-btn");
  var boardEl = document.getElementById("board");
  var bannerEl = document.getElementById("banner");
  var routeLabel = document.getElementById("route-label");
  var updatedEl = document.getElementById("updated");

  // ---- state ----
  var stations = [];               // [{name, crs}]
  var nameByCrs = {};              // crs -> name
  var state = { from: null, to: null };
  var fetchToken = 0;              // guards overlapping board fetches
  var timer = null;

  function stationName(crs) {
    return nameByCrs[crs] || crs || "";
  }

  function savePair() {
    try {
      localStorage.setItem(KEY_FROM, state.from);
      localStorage.setItem(KEY_TO, state.to);
    } catch (e) { /* private mode etc. */ }
  }

  function initialPair() {
    var f, t;
    try {
      f = localStorage.getItem(KEY_FROM);
      t = localStorage.getItem(KEY_TO);
    } catch (e) { /* ignore */ }
    if (!f || !t) {
      f = CFG.DEFAULT_FROM || "ECR";
      t = CFG.DEFAULT_TO || "VIC";
      if (CFG.AUTO_DIRECTION_BY_TIME && new Date().getHours() >= 12) {
        var tmp = f; f = t; t = tmp;
      }
    }
    return { from: f, to: t };
  }

  // ---------------------------------------------------------------- pickers
  function localMatches(query) {
    var q = query.trim().toLowerCase();
    if (!q) return stations.slice(0, 8);
    var starts = [], contains = [];
    for (var i = 0; i < stations.length; i++) {
      var s = stations[i];
      var name = s.name.toLowerCase();
      var crs = s.crs.toLowerCase();
      if (crs === q) { starts.unshift(s); continue; }
      if (name.indexOf(q) === 0 || crs.indexOf(q) === 0) starts.push(s);
      else if (name.indexOf(q) !== -1) contains.push(s);
    }
    return starts.concat(contains).slice(0, 8);
  }

  var liveAbort = null;
  function liveSearch(query) {
    // Best-effort augmentation via Huxley2 /crs/{query}. Failures are ignored.
    if (DEMO || !BASE || query.trim().length < 3) return Promise.resolve([]);
    if (liveAbort) liveAbort.abort();
    liveAbort = new AbortController();
    var url = BASE + "/crs/" + encodeURIComponent(query.trim());
    return fetch(url, { signal: liveAbort.signal })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (data) {
        var arr = Array.isArray(data) ? data : (data && data.crsRecords) || [];
        return arr.map(function (it) {
          return {
            name: it.name || it.stationName || it.locationName || "",
            crs: (it.crs || it.crsCode || it.code || "").toUpperCase()
          };
        }).filter(function (x) { return x.crs && x.name; });
      })
      .catch(function () { return []; });
  }

  function mergeStations(a, b) {
    var seen = {}, out = [];
    a.concat(b).forEach(function (s) {
      if (s.crs && !seen[s.crs]) { seen[s.crs] = 1; out.push(s); }
    });
    return out.slice(0, 8);
  }

  function setupPicker(input, listEl, which) {
    var activeIdx = -1;
    var current = [];

    function close() { listEl.hidden = true; listEl.innerHTML = ""; activeIdx = -1; current = []; }

    function choose(s) {
      if (!s) return;
      if (!nameByCrs[s.crs]) nameByCrs[s.crs] = s.name;
      input.value = s.name;
      state[which] = s.crs;
      savePair();
      close();
      syncLabels();
      loadBoard();
    }

    function render(items) {
      current = items;
      activeIdx = -1;
      if (!items.length) { close(); return; }
      listEl.innerHTML = "";
      items.forEach(function (s, idx) {
        var li = document.createElement("li");
        var nm = document.createElement("span");
        nm.textContent = s.name;
        var code = document.createElement("span");
        code.className = "crs";
        code.textContent = s.crs;
        li.appendChild(nm); li.appendChild(code);
        li.addEventListener("mousedown", function (e) { e.preventDefault(); choose(s); });
        li.addEventListener("touchstart", function (e) { e.preventDefault(); choose(s); }, { passive: false });
        if (idx === activeIdx) li.className = "active";
        listEl.appendChild(li);
      });
      listEl.hidden = false;
    }

    function refreshSuggestions() {
      var q = input.value;
      var base = localMatches(q);
      render(base);
      liveSearch(q).then(function (extra) {
        if (extra.length) render(mergeStations(base, extra));
      });
    }

    input.addEventListener("focus", function () { input.select(); refreshSuggestions(); });
    input.addEventListener("input", refreshSuggestions);

    input.addEventListener("keydown", function (e) {
      if (listEl.hidden) return;
      if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, current.length - 1); paintActive(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); paintActive(); }
      else if (e.key === "Enter") { e.preventDefault(); choose(activeIdx >= 0 ? current[activeIdx] : current[0]); }
      else if (e.key === "Escape") { close(); input.blur(); }
    });

    function paintActive() {
      var lis = listEl.querySelectorAll("li");
      for (var i = 0; i < lis.length; i++) lis[i].className = (i === activeIdx ? "active" : "");
      if (lis[activeIdx]) lis[activeIdx].scrollIntoView({ block: "nearest" });
    }

    input.addEventListener("blur", function () {
      // Resolve typed text against known stations; otherwise revert.
      setTimeout(function () {
        var typed = input.value.trim().toLowerCase();
        if (typed) {
          var hit = null;
          for (var i = 0; i < stations.length; i++) {
            var s = stations[i];
            if (s.name.toLowerCase() === typed || s.crs.toLowerCase() === typed) { hit = s; break; }
          }
          if (hit && hit.crs !== state[which]) { choose(hit); return; }
        }
        input.value = stationName(state[which]);
        close();
      }, 120);
    });
  }

  function syncLabels() {
    fromInput.value = stationName(state.from);
    toInput.value = stationName(state.to);
    routeLabel.textContent = stationName(state.from) + "  →  " + stationName(state.to);
  }

  // ---------------------------------------------------------------- board
  function statusInfo(svc) {
    var etd = (svc.etd || "").trim();
    if (svc.isCancelled || /cancel/i.test(etd)) {
      return { text: "Cancelled", cls: "cancelled", cancelled: true };
    }
    if (!etd || /^on time$/i.test(etd)) return { text: "On time", cls: "ontime" };
    if (/^\d{1,2}:\d{2}$/.test(etd)) return { text: "Exp " + etd, cls: "delayed" };
    if (/delay/i.test(etd)) return { text: "Delayed", cls: "delayed" };
    return { text: etd, cls: "delayed" };
  }

  function carsText(svc) {
    var n = parseInt(svc.length, 10);
    if (!n || n <= 0) return "—";
    return n + (n === 1 ? " car" : " cars");
  }

  function platText(svc) {
    return svc.platform ? String(svc.platform) : "—";
  }

  function destName(svc) {
    if (svc.destination && svc.destination[0] && svc.destination[0].locationName) {
      return svc.destination[0].locationName;
    }
    return "";
  }

  function stripTags(s) {
    var d = document.createElement("div");
    d.innerHTML = String(s || "");
    return (d.textContent || "").trim();
  }

  function showBanner(msg, isError) {
    if (!msg) { bannerEl.hidden = true; bannerEl.textContent = ""; return; }
    bannerEl.textContent = msg;
    bannerEl.className = "banner" + (isError ? " error" : "");
    bannerEl.hidden = false;
  }

  function renderBoard(data) {
    var services = (data && data.trainServices) || [];
    boardEl.innerHTML = "";

    if (!services.length) {
      var p = document.createElement("p");
      p.className = "placeholder";
      p.textContent = "No direct departures found in the next while.";
      boardEl.appendChild(p);
    } else {
      services.forEach(function (svc) {
        var st = statusInfo(svc);
        var row = document.createElement("div");
        row.className = "row" + (st.cancelled ? " is-cancelled" : "");

        var time = document.createElement("div");
        time.className = "time";
        time.textContent = svc.std || svc.sta || "--:--";

        var dest = document.createElement("div");
        dest.className = "dest";
        dest.textContent = destName(svc) || (svc.operator || "");

        var status = document.createElement("div");
        status.className = "status " + st.cls;
        status.textContent = st.text;

        var plat = document.createElement("div");
        plat.className = "plat";
        plat.innerHTML = "Plat<b>" + platText(svc) + "</b>";

        var cars = document.createElement("div");
        cars.className = "cars";
        cars.textContent = carsText(svc);

        row.appendChild(time);
        row.appendChild(dest);
        row.appendChild(status);
        row.appendChild(plat);
        row.appendChild(cars);
        boardEl.appendChild(row);
      });
    }

    var msgs = (data && data.nrccMessages) || [];
    if (msgs.length) {
      showBanner(stripTags(msgs[0].value || msgs[0].xhtmlMessage || msgs[0]), DEMO);
    } else {
      showBanner(null);
    }

    var now = new Date();
    updatedEl.textContent = "Updated " + pad(now.getHours()) + ":" + pad(now.getMinutes());
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function boardUrl() {
    return BASE + "/departures/" + encodeURIComponent(state.from) +
      "/to/" + encodeURIComponent(state.to) + "/" + NUM_ROWS;
  }

  function loadBoard() {
    var myToken = ++fetchToken;
    var url = DEMO ? "sample_board.json" : boardUrl();

    fetch(url, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (myToken !== fetchToken) return; // a newer request superseded this
        renderBoard(data);
      })
      .catch(function (err) {
        if (myToken !== fetchToken) return;
        var hadRows = boardEl.querySelector(".row");
        if (!hadRows) {
          boardEl.innerHTML = '<p class="placeholder">Could not load departures.</p>';
        }
        showBanner("Couldn't reach the train data service — showing last known times. (" +
          (err && err.message ? err.message : "network error") + ")", true);
      });
  }

  // ---------------------------------------------------------------- wiring
  swapBtn.addEventListener("click", function () {
    var f = state.from; state.from = state.to; state.to = f;
    savePair();
    syncLabels();
    loadBoard();
  });

  refreshBtn.addEventListener("click", loadBoard);

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") loadBoard();
  });

  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(loadBoard, REFRESH_MS);
  }

  // ---------------------------------------------------------------- boot
  fetch("stations.json", { cache: "force-cache" })
    .then(function (r) { return r.json(); })
    .then(function (list) { stations = list || []; })
    .catch(function () { stations = []; })
    .then(function () {
      stations.forEach(function (s) { nameByCrs[s.crs] = s.name; });
      var pair = initialPair();
      state.from = pair.from;
      state.to = pair.to;
      setupPicker(fromInput, fromList, "from");
      setupPicker(toInput, toList, "to");
      syncLabels();
      loadBoard();
      startTimer();
    });
})();
