"use strict";

(function () {
  var CFG = window.CONFIG || {};
  var BASE = (CFG.HUXLEY_BASE_URL || "").replace(/\/+$/, "");
  var NUM_ROWS = CFG.NUM_ROWS || 8;
  var REFRESH_MS = CFG.REFRESH_MS || 45000;
  var MORNING_BEFORE = CFG.MORNING_BEFORE_HOUR == null ? 12 : CFG.MORNING_BEFORE_HOUR;
  var DEMO = /[?&]demo=1\b/.test(location.search);

  var KEYS = { home: "cmt.home", workA: "cmt.workA", workB: "cmt.workB", ret: "cmt.ret" };

  // ---- DOM ----
  var modeWorkBtn = document.getElementById("mode-work");
  var modeHomeBtn = document.getElementById("mode-home");
  var settingsBtn = document.getElementById("settings-btn");
  var settingsPanel = document.getElementById("settings");
  var settingsDone = document.getElementById("settings-done");
  var returnPick = document.getElementById("return-pick");
  var retABtn = document.getElementById("ret-a");
  var retBBtn = document.getElementById("ret-b");
  var routeLabel = document.getElementById("route-label");
  var updatedEl = document.getElementById("updated");
  var boardEl = document.getElementById("board");
  var bannerEl = document.getElementById("banner");
  var refreshBtn = document.getElementById("refresh-btn");
  var homeInput = document.getElementById("home-input");
  var aInput = document.getElementById("a-input");
  var bInput = document.getElementById("b-input");

  // ---- state ----
  var stations = [];
  var nameByCrs = {};
  var state = { home: "ECR", workA: "VIC", workB: "LBG", ret: "A", mode: "work" };
  var fetchToken = 0;
  var timer = null;

  function stationName(crs) { return nameByCrs[crs] || crs || ""; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // ---------------------------------------------------------------- settings
  function loadSettings() {
    try {
      state.home = localStorage.getItem(KEYS.home) || CFG.DEFAULT_HOME || "ECR";
      state.workA = localStorage.getItem(KEYS.workA) || CFG.DEFAULT_WORK_A || "VIC";
      // null = never set (use default); "" = explicitly cleared (one station).
      var wb = localStorage.getItem(KEYS.workB);
      state.workB = wb === null ? (CFG.DEFAULT_WORK_B || "LBG") : wb;
      state.ret = localStorage.getItem(KEYS.ret) === "B" ? "B" : "A";
    } catch (e) {
      state.home = CFG.DEFAULT_HOME || "ECR";
      state.workA = CFG.DEFAULT_WORK_A || "VIC";
      state.workB = CFG.DEFAULT_WORK_B || "LBG";
      state.ret = "A";
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(KEYS.home, state.home);
      localStorage.setItem(KEYS.workA, state.workA);
      localStorage.setItem(KEYS.workB, state.workB);
      localStorage.setItem(KEYS.ret, state.ret);
    } catch (e) { /* private mode */ }
  }

  function deriveMode() {
    return new Date().getHours() < MORNING_BEFORE ? "work" : "home";
  }

  // ---------------------------------------------------------------- pickers
  function localMatches(query) {
    var q = query.trim().toLowerCase();
    if (!q) return stations.slice(0, 8);
    var starts = [], contains = [];
    for (var i = 0; i < stations.length; i++) {
      var s = stations[i];
      var name = s.name.toLowerCase(), crs = s.crs.toLowerCase();
      if (crs === q) { starts.unshift(s); continue; }
      if (name.indexOf(q) === 0 || crs.indexOf(q) === 0) starts.push(s);
      else if (name.indexOf(q) !== -1) contains.push(s);
    }
    return starts.concat(contains).slice(0, 8);
  }

  var liveAbort = null;
  function liveSearch(query) {
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
    a.concat(b).forEach(function (s) { if (s.crs && !seen[s.crs]) { seen[s.crs] = 1; out.push(s); } });
    return out.slice(0, 8);
  }

  function setupPicker(input, listEl, key, allowEmpty) {
    var activeIdx = -1, current = [];

    function close() { listEl.hidden = true; listEl.innerHTML = ""; activeIdx = -1; current = []; }

    function choose(s) {
      if (!s) return;
      if (!nameByCrs[s.crs]) nameByCrs[s.crs] = s.name;
      input.value = s.name;
      state[key] = s.crs;
      saveSettings();
      close();
      applyModeUI();
      loadBoard();
    }

    function clearValue() {
      state[key] = "";
      input.value = "";
      saveSettings();
      close();
      applyModeUI();
      loadBoard();
    }

    function paintActive() {
      var lis = listEl.querySelectorAll("li");
      for (var i = 0; i < lis.length; i++) lis[i].className = (i === activeIdx ? "active" : "");
      if (lis[activeIdx]) lis[activeIdx].scrollIntoView({ block: "nearest" });
    }

    function render(items) {
      current = items; activeIdx = -1;
      if (!items.length) { close(); return; }
      listEl.innerHTML = "";
      items.forEach(function (s) {
        var li = document.createElement("li");
        var nm = document.createElement("span"); nm.textContent = s.name;
        var code = document.createElement("span"); code.className = "crs"; code.textContent = s.crs;
        li.appendChild(nm); li.appendChild(code);
        li.addEventListener("mousedown", function (e) { e.preventDefault(); choose(s); });
        li.addEventListener("touchstart", function (e) { e.preventDefault(); choose(s); }, { passive: false });
        listEl.appendChild(li);
      });
      listEl.hidden = false;
    }

    function refreshSuggestions() {
      var q = input.value;
      var base = localMatches(q);
      render(base);
      liveSearch(q).then(function (extra) { if (extra.length) render(mergeStations(base, extra)); });
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
    input.addEventListener("blur", function () {
      setTimeout(function () {
        var typed = input.value.trim().toLowerCase();
        if (!typed) {
          if (allowEmpty && state[key]) { clearValue(); return; }
          input.value = stationName(state[key]);
          close();
          return;
        }
        for (var i = 0; i < stations.length; i++) {
          var s = stations[i];
          if (s.name.toLowerCase() === typed || s.crs.toLowerCase() === typed) {
            if (s.crs !== state[key]) { choose(s); return; }
            break;
          }
        }
        input.value = stationName(state[key]);
        close();
      }, 120);
    });
  }

  // ---------------------------------------------------------------- labels / mode UI
  // True when a distinct second work station is configured.
  function hasWorkB() { return !!state.workB && state.workB !== state.workA; }

  function refreshLabels() {
    homeInput.value = stationName(state.home);
    aInput.value = stationName(state.workA);
    bInput.value = stationName(state.workB);
    retABtn.textContent = stationName(state.workA);
    retBBtn.textContent = stationName(state.workB);
    retABtn.classList.toggle("active", state.ret === "A");
    retBBtn.classList.toggle("active", state.ret === "B");

    if (state.mode === "work") {
      routeLabel.textContent = stationName(state.home) + "  →  " + stationName(state.workA) +
        (hasWorkB() ? " · " + stationName(state.workB) : "");
    } else {
      var origin = (hasWorkB() && state.ret === "B") ? state.workB : state.workA;
      routeLabel.textContent = stationName(origin) + "  →  " + stationName(state.home);
    }
  }

  function applyModeUI() {
    // With only one work station there is no A/B choice to make.
    if (!hasWorkB() && state.ret !== "A") { state.ret = "A"; saveSettings(); }
    modeWorkBtn.classList.toggle("active", state.mode === "work");
    modeHomeBtn.classList.toggle("active", state.mode === "home");
    returnPick.hidden = !(state.mode === "home" && hasWorkB());
    refreshLabels();
  }

  function setMode(m) {
    if (state.mode === m) return;
    state.mode = m;
    applyModeUI();
    loadBoard();
  }

  // ---------------------------------------------------------------- board data
  function statusInfo(svc) {
    var etd = (svc.etd || "").trim();
    if (svc.isCancelled || /cancel/i.test(etd)) return { text: "Cancelled", cls: "cancelled", cancelled: true };
    if (!etd || /^on time$/i.test(etd)) return { text: "On time", cls: "ontime" };
    if (/^\d{1,2}:\d{2}$/.test(etd)) return { text: "Exp " + etd, cls: "delayed" };
    if (/delay/i.test(etd)) return { text: "Delayed", cls: "delayed" };
    return { text: etd, cls: "delayed" };
  }

  function carsCount(svc) {
    var n = parseInt(svc.length, 10);
    return (!n || n <= 0) ? null : n;
  }

  function platText(svc) { return svc.platform ? String(svc.platform) : "—"; }

  function destName(svc) {
    if (svc.destination && svc.destination[0] && svc.destination[0].locationName) {
      return svc.destination[0].locationName;
    }
    return "";
  }

  function stripTags(s) { return String(s || "").replace(/<[^>]*>/g, "").trim(); }

  // ---- journey time (from this train's calling points to the destination) ----
  function toMinutes(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || "").trim());
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }

  function callingPointAt(svc, toCrs) {
    var scp = svc.subsequentCallingPoints;
    if (!scp || !scp[0]) return null;
    var cps = scp[0].callingPoint || scp[0]; // tolerate either shape
    if (!cps || !cps.length) return null;
    var target = (toCrs || "").toUpperCase();
    for (var i = 0; i < cps.length; i++) {
      if ((cps[i].crs || "").toUpperCase() === target) return cps[i];
    }
    return null;
  }

  // Expected arrival time string ("HH:MM") at toCrs, preferring estimated.
  function arrivalTime(svc, toCrs) {
    var cp = callingPointAt(svc, toCrs);
    if (!cp) return null;
    if (/^\d{1,2}:\d{2}$/.test(cp.et || "")) return cp.et;
    if (/^\d{1,2}:\d{2}$/.test(cp.st || "")) return cp.st;
    return null;
  }

  // Minutes from this service's departure to its arrival at toCrs, or null.
  function journeyMins(svc, toCrs) {
    var dep = toMinutes(/^\d{1,2}:\d{2}$/.test(svc.etd || "") ? svc.etd : svc.std);
    var arr = toMinutes(arrivalTime(svc, toCrs));
    if (dep == null || arr == null) return null;
    var d = arr - dep;
    if (d < 0) d += 24 * 60;        // crossed midnight
    if (d < 0 || d > 12 * 60) return null; // ignore implausible values
    return d;
  }

  function fmtJourney(mins) {
    if (mins == null) return "";
    if (mins < 60) return mins + " min";
    var h = Math.floor(mins / 60), m = mins % 60;
    return h + "h" + (m ? " " + (m < 10 ? "0" : "") + m : "");
  }

  // Attach expected arrival (_arr) and journey time (_jtext) for the trip to toCrs.
  function annotateJourney(data, toCrs) {
    ((data && data.trainServices) || []).forEach(function (svc) {
      svc._arr = arrivalTime(svc, toCrs) || "";
      svc._jtext = fmtJourney(journeyMins(svc, toCrs));
    });
    return data;
  }

  var TRAIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="14" rx="3"/><line x1="4" y1="11" x2="20" y2="11"/><line x1="8" y1="17" x2="6" y2="21"/><line x1="16" y1="17" x2="18" y2="21"/></svg>';

  function showBanner(msg, isError) {
    if (!msg) { bannerEl.hidden = true; bannerEl.textContent = ""; return; }
    bannerEl.textContent = msg;
    bannerEl.className = "banner" + (isError ? " error" : "");
    bannerEl.hidden = false;
  }

  function carsBadge(svc) {
    var n = carsCount(svc);
    var wrap = document.createElement("div");
    wrap.className = "cars col-cars";
    var lab = document.createElement("span"); lab.className = "badge-label";
    lab.textContent = n === 1 ? "Carriage" : "Carriages";
    var val = document.createElement("b");
    var ico = document.createElement("span"); ico.className = "ico"; ico.innerHTML = TRAIN_ICON;
    var num = document.createElement("span"); num.className = "num"; num.textContent = n ? String(n) : "—";
    val.appendChild(ico); val.appendChild(num);
    wrap.appendChild(lab); wrap.appendChild(val);
    return wrap;
  }

  function platformLine(svc) {
    var line = document.createElement("div");
    line.className = "platform-line";
    line.appendChild(document.createTextNode("Platform "));
    var b = document.createElement("b");
    b.textContent = platText(svc);
    line.appendChild(b);
    return line;
  }

  // "→ 08:31 · 16 min" — expected arrival and journey, in the time column.
  function arriveLine(svc, cancelled) {
    var line = document.createElement("div");
    line.className = "arrive-line";
    if (cancelled || !svc._arr) { line.textContent = "—"; return line; }
    var arrow = document.createElement("span"); arrow.className = "arr-arrow"; arrow.textContent = "→";
    var t = document.createElement("span"); t.className = "arr-time"; t.textContent = svc._arr;
    line.appendChild(arrow);
    line.appendChild(t);
    if (svc._jtext) {
      var j = document.createElement("span"); j.className = "arr-j"; j.textContent = "· " + svc._jtext;
      line.appendChild(j);
    }
    return line;
  }

  function buildRow(svc, isWork) {
    var st = statusInfo(svc);
    var row = document.createElement("div");
    row.className = "row" + (st.cancelled ? " is-cancelled" : "");

    // Left column groups all the time info: departure, status, arrival + journey.
    var colTime = document.createElement("div");
    colTime.className = "col-time";
    var time = document.createElement("div"); time.className = "time";
    time.textContent = svc.std || svc.sta || "--:--";
    var exp = document.createElement("div"); exp.className = "expected " + st.cls;
    exp.textContent = st.text;
    colTime.appendChild(time);
    colTime.appendChild(exp);
    colTime.appendChild(arriveLine(svc, st.cancelled));

    var colMid = document.createElement("div");
    colMid.className = "col-mid";
    if (isWork) {
      var tags = document.createElement("div");
      tags.className = "tags";
      (svc._tags || []).forEach(function (crs) {
        var tag = document.createElement("span");
        tag.className = "tag " + (crs === state.workA ? "tag-a" : "tag-b");
        tag.textContent = stationName(crs);
        tags.appendChild(tag);
      });
      colMid.appendChild(tags);
    } else {
      var dest = document.createElement("div"); dest.className = "dest";
      dest.textContent = destName(svc) || (svc.operator || "");
      colMid.appendChild(dest);
    }
    colMid.appendChild(platformLine(svc));

    row.appendChild(colTime);
    row.appendChild(colMid);
    row.appendChild(carsBadge(svc));
    return row;
  }

  function renderServices(services, isWork) {
    boardEl.innerHTML = "";
    if (!services.length) {
      var p = document.createElement("p");
      p.className = "placeholder";
      p.textContent = "No direct departures found in the next while.";
      boardEl.appendChild(p);
      return;
    }
    services.forEach(function (svc) { boardEl.appendChild(buildRow(svc, isWork)); });
  }

  function applyMeta(data) {
    var msgs = (data && data.nrccMessages) || [];
    if (msgs.length) showBanner(stripTags(msgs[0].value || msgs[0].xhtmlMessage || msgs[0]), DEMO);
    else showBanner(null);
    var now = new Date();
    updatedEl.textContent = "Updated " + pad(now.getHours()) + ":" + pad(now.getMinutes());
    updatedEl.classList.remove("flash");
    void updatedEl.offsetWidth;
    updatedEl.classList.add("flash");
  }

  function serviceKey(svc) {
    return svc.serviceID || svc.serviceIdGuid ||
      (svc.std + "|" + (svc.platform || "") + "|" + (destName(svc) || svc.operator || ""));
  }

  // Merge two destination-filtered boards into one, tagging each train with
  // the work station(s) it serves and sorting by departure time.
  function mergeWork(dataA, dataB) {
    var map = {}, order = [];
    function add(data, tagCrs) {
      ((data && data.trainServices) || []).forEach(function (svc) {
        var key = serviceKey(svc);
        var item = map[key];
        if (!item) { item = map[key] = svc; svc._tags = []; order.push(key); }
        if (item._tags.indexOf(tagCrs) < 0) item._tags.push(tagCrs);
      });
    }
    add(dataA, state.workA);
    add(dataB, state.workB);
    var list = order.map(function (k) { return map[k]; });
    list.sort(function (x, y) { return (x.std || "").localeCompare(y.std || ""); });
    var nrcc = (dataA && dataA.nrccMessages) || (dataB && dataB.nrccMessages) || [];
    return { trainServices: list, nrccMessages: nrcc };
  }

  function getJson(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function depUrl(from, to) {
    // expand=true asks Huxley2 for calling points, which we use for journey time.
    return BASE + "/departures/" + encodeURIComponent(from) + "/to/" + encodeURIComponent(to) +
      "/" + NUM_ROWS + "?expand=true";
  }

  function onError(err) {
    var hadRows = boardEl.querySelector(".row");
    if (!hadRows) boardEl.innerHTML = '<p class="placeholder">Could not load departures.</p>';
    showBanner("Couldn't reach the train data service — showing last known times. (" +
      (err && err.message ? err.message : "network error") + ")", true);
  }

  function loadSingle(from, to, myToken) {
    var url = DEMO ? "sample_board.json" : depUrl(from, to);
    return getJson(url).then(function (data) {
      if (myToken !== fetchToken) return;
      annotateJourney(data, to);
      renderServices((data && data.trainServices) || [], false);
      applyMeta(data);
    }, function (err) {
      if (myToken !== fetchToken) return;
      onError(err);
    });
  }

  function loadBoard() {
    var myToken = ++fetchToken;

    if (state.mode === "work") {
      // One work station → a plain board; two → a merged, tagged board.
      if (!hasWorkB()) return loadSingle(state.home, state.workA, myToken);
      var ua = DEMO ? "sample_board.json" : depUrl(state.home, state.workA);
      var ub = DEMO ? "sample_board.json" : depUrl(state.home, state.workB);
      return Promise.all([
        getJson(ua).then(function (d) { return d; }, function (e) { return { _err: e }; }),
        getJson(ub).then(function (d) { return d; }, function (e) { return { _err: e }; })
      ]).then(function (res) {
        if (myToken !== fetchToken) return;
        var a = res[0], b = res[1];
        if (a._err && b._err) { onError(a._err); return; }
        var da = a._err ? null : annotateJourney(a, state.workA);
        var db = b._err ? null : annotateJourney(b, state.workB);
        var merged = mergeWork(da, db);
        renderServices(merged.trainServices, true);
        applyMeta(merged);
      });
    }

    var origin = (hasWorkB() && state.ret === "B") ? state.workB : state.workA;
    return loadSingle(origin, state.home, myToken);
  }

  // ---------------------------------------------------------------- wiring
  modeWorkBtn.addEventListener("click", function () { setMode("work"); });
  modeHomeBtn.addEventListener("click", function () { setMode("home"); });

  retABtn.addEventListener("click", function () {
    if (state.ret === "A") return;
    state.ret = "A"; saveSettings(); refreshLabels(); loadBoard();
  });
  retBBtn.addEventListener("click", function () {
    if (state.ret === "B") return;
    state.ret = "B"; saveSettings(); refreshLabels(); loadBoard();
  });

  settingsBtn.addEventListener("click", function () {
    var open = settingsPanel.hidden;
    settingsPanel.hidden = !open;
    settingsBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  settingsDone.addEventListener("click", function () {
    settingsPanel.hidden = true;
    settingsBtn.setAttribute("aria-expanded", "false");
    loadBoard();
  });

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function manualRefresh() {
    if (refreshBtn.dataset.busy === "1") return;
    refreshBtn.dataset.busy = "1";
    refreshBtn.classList.add("loading");
    refreshBtn.setAttribute("aria-busy", "true");
    Promise.all([loadBoard(), delay(450)]).then(function () {
      refreshBtn.classList.remove("loading");
      refreshBtn.removeAttribute("aria-busy");
      refreshBtn.dataset.busy = "0";
    });
  }
  refreshBtn.addEventListener("click", manualRefresh);

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
      loadSettings();
      state.mode = deriveMode();
      setupPicker(homeInput, document.getElementById("home-list"), "home");
      setupPicker(aInput, document.getElementById("a-list"), "workA");
      setupPicker(bInput, document.getElementById("b-list"), "workB", true);
      applyModeUI();
      loadBoard();
      startTimer();
    });
})();
