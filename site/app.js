/* Voorpagina — jouw eigen nieuwsapp.
   Alles wat je instelt en leert blijft op dit apparaat (localStorage). */
(function () {
  "use strict";

  // ---------- opslag ----------
  const KEY = "voorpagina.v1";
  const DEFAULT_STATE = {
    v: 1, src: {}, srcTopicsOff: {}, topicsOff: [], muted: [],
    w: {}, wl: {}, votes: {}, read: {}, saved: {}, nVotes: 0,
    tipDone: false, theme: "auto", view: "foryou"
  };
  function loadState() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return Object.assign({}, DEFAULT_STATE, JSON.parse(raw));
    } catch (e) { /* privé-venster of geen opslag */ }
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  let S = loadState();
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* vol of geblokkeerd */ }
    }, 150);
  }

  // ---------- hulpfuncties ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fold = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const icon = (id) => `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const DAYS = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
  const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
  const hhmm = (d) => d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });

  function ago(ts) {
    const now = Date.now() / 1000, s = Math.max(0, now - ts);
    if (s < 90) return "zojuist";
    if (s < 3600) return Math.round(s / 60) + " min";
    const d = new Date(ts * 1000), today = new Date();
    if (s < 6 * 3600) return Math.floor(s / 3600) + " uur";
    if (d.toDateString() === today.toDateString()) return hhmm(d);
    const y = new Date(today); y.setDate(today.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "gisteren " + hhmm(d);
    return DAYS[d.getDay()].slice(0, 2) + " " + hhmm(d);
  }

  const STOP = new Set(("de het een en of van in op te met voor door naar bij uit aan over als is zijn was waren wordt worden werd dat die dit deze er om maar ook nog niet geen dan wel meer veel zo tot na onder tegen zich hun haar heeft hebben kan kunnen moet moeten zal zullen gaat komt nieuwe jaar twee drie wat wie hoe waarom " +
    "the and for with from that this are was were been will would into over after about their they have has more than just says said what when where which while").split(" "));

  const MARK_COLORS = ["#0a6b65", "#2f5aa8", "#8a3b8f", "#b5532a", "#3f7a2c", "#946812", "#23606e", "#8a3c3c", "#4b4fa3", "#5c6b2e", "#6b4f2a", "#2d6a4f"];
  function markColor(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return MARK_COLORS[h % MARK_COLORS.length]; }
  function markText(name) {
    if (/^[A-Z]{1,3}$/.test(name)) return name;
    const caps = name.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]);
    return (caps.length >= 2 ? caps.slice(0, 2).join("") : (caps[0] || name[0])).toUpperCase();
  }
  function srcMark(src) {
    const t = markText(src.name);
    return `<span class="src-mark" style="background:${markColor(src.id)};${t.length > 2 ? "width:auto;padding-inline:3px" : ""}" aria-hidden="true">${esc(t)}</span>`;
  }

  // ---------- data ----------
  let DATA = null, SRC = {}, TOPIC = {};
  let loading = false;
  async function loadData(manual) {
    if (loading) return;
    loading = true;
    $("#refresh").classList.add("spin");
    try {
      const r = await fetch("data/articles.json?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      const isNew = !DATA || d.generated !== DATA.generated;
      DATA = d;
      SRC = Object.fromEntries(d.sources.map((s) => [s.id, s]));
      TOPIC = Object.fromEntries(d.topics.map((t) => [t.id, t]));
      pruneState();
      renderHeader();
      render();
      if (manual) toast(isNew ? "Nieuwste versie geladen" : "Je bent helemaal bij");
    } catch (e) {
      if (!DATA) {
        $("#view").innerHTML = `<div class="empty"><h3>Nieuws kon niet worden geladen</h3><p>Controleer je internetverbinding en tik op verversen rechtsboven.</p></div>`;
      } else if (manual) toast("Verversen lukte niet, je ziet de vorige versie");
    } finally {
      loading = false;
      $("#refresh").classList.remove("spin");
    }
  }

  function pruneState() {
    const cutoff = Date.now() / 1000 - 6 * 86400;
    for (const k in S.read) if (S.read[k] < cutoff) delete S.read[k];
    const vk = Object.keys(S.votes);
    if (vk.length > 3000) vk.slice(0, vk.length - 3000).forEach((k) => delete S.votes[k]);
    const wk = Object.keys(S.w);
    if (wk.length > 5000) wk.filter((k) => Math.abs(S.w[k]) < 0.05).forEach((k) => { delete S.w[k]; delete S.wl[k.slice(2)]; });
  }

  // ---------- filters ----------
  const srcOn = (id) => (id in S.src ? S.src[id] : !!(SRC[id] && SRC[id].on));
  function mutedHit(a) {
    if (!S.muted.length) return false;
    const t = " " + fold(a.title + " " + a.summary).replace(/[^a-z0-9]+/g, " ");
    return S.muted.some((m) => t.includes(" " + fold(m)));
  }
  function topicAllowed(a) {
    if (a.topics.some((t) => S.topicsOff.includes(t))) return false;
    const off = S.srcTopicsOff[a.src];
    if (off && off.length && a.topics.length && a.topics.every((t) => off.includes(t))) return false;
    return true;
  }
  // bronnen die je volgt (followed=true) of juist niet (false)
  function articlesFor(followed) {
    return DATA.articles.filter((a) => SRC[a.src] && srcOn(a.src) === followed && topicAllowed(a) && !mutedHit(a));
  }

  // ---------- verhalen: dezelfde gebeurtenis van meerdere bronnen = één kaart ----------
  function buildStories(list) {
    const byCluster = new Map();
    for (const a of list) {
      const k = a.cluster || a.id;
      if (!byCluster.has(k)) byCluster.set(k, []);
      byCluster.get(k).push(a);
    }
    // ook bronnen die je niet volgt tonen als "ook bij"
    const allByCluster = new Map();
    for (const a of DATA.articles) {
      const k = a.cluster || a.id;
      if (byCluster.has(k)) {
        if (!allByCluster.has(k)) allByCluster.set(k, []);
        allByCluster.get(k).push(a);
      }
    }
    const out = [];
    for (const [key, items] of byCluster) {
      const rep = items.slice().sort((x, y) => repScore(y) - repScore(x))[0];
      const all = allByCluster.get(key) || items;
      const others = all.filter((a) => a !== rep);
      const srcCount = new Set(all.map((a) => a.via || a.src)).size;
      out.push({
        key, rep, others, all, srcCount,
        ts: Math.max(...all.map((a) => a.ts)),
        first: Math.min(...all.map((a) => a.ts)),
      });
    }
    return out;
  }
  function repScore(a) {
    return (S.w["s:" + a.src] || 0) * 1.5 + (a.img ? 0.6 : 0) + Math.min(a.summary.length, 240) / 400 + (SRC[a.src].paywall ? -0.25 : 0) + (a.via ? -0.3 : 0);
  }
  const vote = (st) => { for (const a of st.all) if (S.votes[a.id]) return S.votes[a.id]; return 0; };
  const isRead = (st) => st.all.some((a) => S.read[a.id]);

  // ---------- het leermodel ----------
  // Logistische regressie die per duimpje bijleert. Kenmerken: bron, onderwerp,
  // onderwerp-per-bron en woorden uit de kop.
  function words(title) {
    const out = [];
    for (const raw of fold(title).split(/[^a-z0-9]+/)) {
      if (raw.length < 4 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
      out.push(raw.slice(0, 6));
    }
    return [...new Set(out)].slice(0, 10);
  }
  function features(a) {
    const f = [["b", 1], ["s:" + a.src, 1]];
    const tn = 1 / Math.sqrt(Math.max(1, a.topics.length));
    for (const t of a.topics) { f.push(["t:" + t, tn]); f.push(["st:" + a.src + "|" + t, tn]); }
    const ws = words(a.title), wn = ws.length ? 1 / Math.sqrt(ws.length) : 0;
    for (const w of ws) f.push(["w:" + w, wn]);
    return f;
  }
  const RATE = { b: 0.1, s: 0.45, t: 0.45, st: 0.55, w: 0.3 };
  function predict(a) {
    let z = 0;
    for (const [k, v] of features(a)) z += (S.w[k] || 0) * v;
    return sigmoid(z);
  }
  function learn(a, y, strength = 1, only = null) {
    const feats = features(a).filter(([k]) => !only || k.startsWith(only));
    const err = y - predict(a);
    for (const [k, v] of feats) {
      const type = k.split(":")[0];
      const nw = (S.w[k] || 0) + RATE[type] * strength * err * v;
      S.w[k] = Math.max(-4, Math.min(4, nw));
      if (type === "w") {
        const stem = k.slice(2);
        const word = a.title.split(/[^\p{L}\p{N}]+/u).find((x) => fold(x).startsWith(stem));
        if (word) S.wl[stem] = word.toLowerCase();
      }
    }
  }
  function reasonFor(a) {
    if (S.nVotes < 3) return "";
    let best = null, bestC = 0.45;
    for (const [k, v] of features(a)) {
      if (k === "b") continue;
      const c = (S.w[k] || 0) * v;
      const type = k.split(":")[0];
      const adj = type === "w" ? c * 0.9 : c;
      if (adj > bestC) { bestC = adj; best = k; }
    }
    if (!best) return "";
    const [type, rest] = [best.split(":")[0], best.slice(best.indexOf(":") + 1)];
    if (type === "s") return `Je leest graag ${SRC[rest].name}`;
    if (type === "t") return `Omdat je ${TOPIC[rest].label.toLowerCase()} interessant vindt`;
    if (type === "st") { const [s, t] = rest.split("|"); return `${TOPIC[t].label} van ${SRC[s].name} spreekt je aan`; }
    if (type === "w") return `Past bij je interesse in ‘${S.wl[rest] || rest}’`;
    return "";
  }

  function scoreStory(st) {
    const now = Date.now() / 1000;
    const ageH = Math.max(0, (now - st.ts) / 3600);
    const rec = Math.exp(-ageH / 12);
    const pop = Math.min(1, (st.srcCount - 1) / 3);
    const p = predict(st.rep);
    const learnedW = Math.min(1, S.nVotes / 12); // hoe meer duimpjes, hoe zwaarder jouw smaak telt
    let s = (0.3 + 0.35 * learnedW) * p + (0.5 - 0.25 * learnedW) * rec + 0.2 * pop;
    if (isRead(st)) s *= 0.6;
    return s;
  }
  function diversify(stories) {
    const pool = stories.map((st) => ({ st, s: scoreStory(st) })).sort((x, y) => y.s - x.s);
    const out = [], recent = [];
    while (pool.length) {
      let bi = 0, bs = -Infinity;
      for (let i = 0; i < Math.min(pool.length, 25); i++) {
        const same = recent.filter((r) => r === pool[i].st.rep.src).length;
        const v = pool[i].s - 0.07 * same;
        if (v > bs) { bs = v; bi = i; }
      }
      const pick = pool.splice(bi, 1)[0].st;
      out.push(pick);
      recent.push(pick.rep.src); if (recent.length > 4) recent.shift();
    }
    return out;
  }

  // ---------- weergave ----------
  let view = ["foryou", "latest", "discover", "saved", "sources"].includes(location.hash.slice(1)) ? location.hash.slice(1) : S.view || "foryou";
  let topicFilter = "all";
  let limit = 40;
  const expanded = new Set();
  const hiddenNow = new Map(); // key -> {story, undo, reason}

  function renderHeader() {
    const d = new Date();
    $("#today").textContent = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
    if (DATA) {
      const g = new Date(DATA.generated * 1000);
      $("#updated").innerHTML = `Bijgewerkt<br>${g.toDateString() === d.toDateString() ? hhmm(g) : ago(DATA.generated)}`;
    }
  }

  function metaHTML(a, extra = "") {
    const s = SRC[a.src];
    const name = a.via ? esc(a.via) : esc(s.name);
    return `<div class="meta"><span class="src">${srcMark(s)}${name}</span>` +
      (a.via ? `<span class="sep"></span><span>via ${esc(s.name)}</span>` : "") +
      `<span class="sep"></span><time datetime="${new Date(a.ts * 1000).toISOString()}">${ago(a.ts)}</time>` +
      (s.paywall ? `<span class="sep"></span><span class="lock" title="Betaalmuur">${icon("lock")}Abonnement</span>` : "") + extra + `</div>`;
  }

  function storyHTML(st, opt = {}) {
    const hid = hiddenNow.get(st.key);
    if (hid) return hiddenHTML(st, hid);
    const a = st.rep, v = vote(st), open = expanded.has(st.key);
    const saved = !!S.saved[st.key];
    const link = `<a href="${esc(a.url)}" target="_blank" rel="noopener" data-open="${esc(st.key)}" data-id="${esc(a.id)}">${esc(a.title)}</a>`;
    const img = a.img ? (opt.lead
      ? `<img class="lead-img" src="${esc(a.img)}" alt="" loading="eager" referrerpolicy="no-referrer" data-img>`
      : `<img class="thumb" src="${esc(a.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-img>`) : "";
    const reason = opt.reason ? reasonFor(a) : "";
    const others = st.others.length
      ? `<button class="act more-src" type="button" data-act="expand" data-key="${esc(st.key)}" aria-expanded="${open}">${icon("layers")}${st.others.length === 1 ? "+1 bron" : "+" + st.others.length + " bronnen"}</button>`
      : "";
    const also = open && st.others.length ? `<ul class="also">${st.others.sort((x, y) => x.ts - y.ts).map((o) =>
      `<li><a href="${esc(o.url)}" target="_blank" rel="noopener" data-open="${esc(st.key)}" data-id="${esc(o.id)}">${esc(o.title)}</a>${metaHTML(o)}</li>`).join("")}</ul>` : "";
    const body = `<h3>${link}</h3>` + (opt.summary !== false && a.summary ? `<p class="sum">${esc(a.summary)}</p>` : "") + metaHTML(a) +
      (reason ? `<div class="reason">${icon("spark")}${esc(reason)}</div>` : "");
    const actions = `<div class="actions">
      <button class="act up" type="button" data-act="up" data-key="${esc(st.key)}" aria-pressed="${v === 1}" aria-label="Interessant" title="Interessant">${icon("up")}</button>
      <button class="act down" type="button" data-act="down" data-key="${esc(st.key)}" aria-label="Niet interessant" title="Niet interessant">${icon("down")}</button>
      <button class="act save" type="button" data-act="save" data-key="${esc(st.key)}" aria-pressed="${saved}" aria-label="${saved ? "Uit bewaard halen" : "Bewaren"}" title="${saved ? "Bewaard" : "Bewaren"}">${icon("saved")}</button>
      ${others}</div>`;
    const cls = `story${opt.lead ? " lead" : ""}${isRead(st) ? " read" : ""}`;
    if (opt.lead) return `<article class="${cls}" data-key="${esc(st.key)}">${img}${body}${actions}${also}</article>`;
    return `<article class="${cls}" data-key="${esc(st.key)}"><div class="story-grid"><div>${body}</div>${img}</div>${actions}${also}</article>`;
  }

  function hiddenHTML(st, hid) {
    const a = st.rep, s = SRC[a.src], t = a.topics[0] && TOPIC[a.topics[0]];
    const opts = [["src", `Minder van ${s.name}`]];
    if (t) opts.push(["topic", `Minder ${t.label.toLowerCase()}`]);
    if (t) opts.push(["srctopic", `Minder ${t.label.toLowerCase()} van ${s.name}`]);
    return `<div class="hidden-bar" data-key="${esc(st.key)}">
      <div class="line"><span>Verborgen. Wat klopt er niet aan?</span><button class="undo" type="button" data-act="undo" data-key="${esc(st.key)}">Ongedaan maken</button></div>
      <div class="why">${opts.map(([k, l]) => `<button type="button" data-act="why" data-why="${k}" data-key="${esc(st.key)}" aria-pressed="${hid.reason === k}">${esc(l)}</button>`).join("")}</div>
    </div>`;
  }

  function chipsHTML(stories) {
    const counts = {};
    for (const st of stories) for (const t of new Set(st.all.flatMap((a) => a.topics))) counts[t] = (counts[t] || 0) + 1;
    const ids = DATA.topics.map((t) => t.id).filter((id) => counts[id]);
    if (topicFilter !== "all" && !counts[topicFilter]) topicFilter = "all";
    return `<div class="chips" role="toolbar" aria-label="Onderwerp">` +
      `<button class="chip" type="button" data-act="topic" data-topic="all" aria-pressed="${topicFilter === "all"}">Alles</button>` +
      ids.map((id) => `<button class="chip" type="button" data-act="topic" data-topic="${id}" aria-pressed="${topicFilter === id}">${esc(TOPIC[id].label)}<span class="n">${counts[id]}</span></button>`).join("") +
      `</div>`;
  }
  const byTopic = (st) => topicFilter === "all" || st.all.some((a) => a.topics.includes(topicFilter));

  function previewNote() {
    return DATA.preview ? `<div class="preview-note">${esc(DATA.preview)}</div>` : "";
  }

  function renderForYou() {
    const stories = buildStories(articlesFor(true)).filter((st) => vote(st) !== -1 || hiddenNow.has(st.key));
    if (!stories.length) return emptyFollow();
    let list = diversify(stories.filter(byTopic));
    // de openingskaart: de best passende met foto uit de top 3
    const li = list.slice(0, 3).findIndex((st) => st.rep.img && !isRead(st) && !hiddenNow.has(st.key));
    if (li > 0) list.unshift(list.splice(li, 1)[0]);
    const shown = list.slice(0, limit);
    let html = previewNote();
    if (!S.tipDone) html += `<div class="tip"><span class="ic">${icon("spark")}</span><p><strong>Maak dit jouw krant</strong>Geef een duim omhoog bij wat je boeit en omlaag bij wat je niet wilt zien. Na een handvol duimpjes zet Voor jou jouw onderwerpen en bronnen bovenaan.</p><button class="icon-btn" type="button" data-act="tip" aria-label="Tip sluiten">${icon("x")}</button></div>`;
    html += chipsHTML(stories) + `<div class="feed">` +
      shown.map((st, i) => storyHTML(st, { lead: i === 0 && !!st.rep.img, reason: true })).join("") + `</div>`;
    if (list.length > limit) html += `<div class="load-more"><button class="btn ghost" type="button" data-act="more">Meer laden</button></div>`;
    return html;
  }

  function renderLatest() {
    const stories = buildStories(articlesFor(true)).filter((st) => vote(st) !== -1 || hiddenNow.has(st.key));
    if (!stories.length) return emptyFollow();
    const list = stories.filter(byTopic).sort((x, y) => y.ts - x.ts).slice(0, limit + 40);
    const now = new Date(), todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const label = (ts) => (Date.now() / 1000 - ts < 3600 ? "Afgelopen uur" : ts >= todayStart ? "Eerder vandaag" : ts >= todayStart - 86400 ? "Gisteren" : "Eerder");
    let html = previewNote() + chipsHTML(stories) + `<div class="feed">`, cur = "";
    for (const st of list) {
      const l = label(st.ts);
      if (l !== cur) { html += `<div class="section-label">${l}</div>`; cur = l; }
      html += storyHTML(st, { summary: false });
    }
    return html + `</div>`;
  }

  function renderDiscover() {
    const pool = buildStories(articlesFor(false)).filter((st) => vote(st) !== -1 || hiddenNow.has(st.key));
    const followedCount = DATA.sources.filter((s) => srcOn(s.id)).length;
    let html = `<div class="view-head"><h2>Ontdek</h2><p>${S.nVotes >= 3
      ? "Uit bronnen die je nog niet volgt, gekozen op basis van wat je interessant vindt."
      : "Uit bronnen die je nog niet volgt. Geef in Voor jou een paar duimpjes, dan wordt deze lijst persoonlijker."}</p></div>`;
    if (!pool.length) return html + `<div class="empty"><h3>Nog niets te ontdekken</h3><p>Hier komen artikelen uit bronnen die je niet volgt. Er staan nu geen artikelen van zulke bronnen klaar.</p></div>`;
    // bronsuggesties
    const bySrc = {};
    for (const a of articlesFor(false)) (bySrc[a.src] = bySrc[a.src] || []).push(a);
    const sugg = Object.entries(bySrc).map(([id, arts]) => {
      const p = arts.reduce((s, a) => s + predict(a), 0) / arts.length;
      const tc = {}; arts.forEach((a) => a.topics.forEach((t) => (tc[t] = (tc[t] || 0) + 1)));
      const top = Object.entries(tc).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([t]) => TOPIC[t].label.toLowerCase());
      return { id, n: arts.length, score: p * Math.log(arts.length + 1), top };
    }).sort((x, y) => y.score - x.score).slice(0, 5);
    if (sugg.length) {
      html += `<div class="section-label">Bronnen om te proberen</div><div class="suggest">` + sugg.map((g) => {
        const s = SRC[g.id];
        return `<div class="sug-card"><div class="top">${srcMark(s)}${esc(s.name)}</div><p>${g.n} artikelen, vooral ${esc(g.top.join(" en "))}${s.paywall ? ". Met betaalmuur" : ""}.</p><button class="btn small accent" type="button" data-act="follow" data-src="${esc(s.id)}">${icon("plus")}Volgen</button></div>`;
      }).join("") + `</div>`;
    }
    const list = pool.map((st) => ({ st, s: predict(st.rep) * 0.7 + 0.3 * Math.exp(-(Date.now() / 1000 - st.ts) / 43200) }))
      .sort((x, y) => y.s - x.s).slice(0, 30).map((x) => x.st);
    html += `<div class="section-label">Misschien interessant</div><div class="feed">` + list.map((st) => storyHTML(st, { reason: true })).join("") + `</div>`;
    return html + (followedCount ? "" : "");
  }

  function renderSaved() {
    const items = Object.entries(S.saved).sort((x, y) => y[1].t - x[1].t);
    let html = `<div class="view-head"><h2>Bewaard</h2><p>Artikelen die je voor later hebt bewaard. Ze blijven staan, ook als ze uit de feed verdwijnen.</p></div>`;
    if (!items.length) return html + `<div class="empty"><h3>Nog niets bewaard</h3><p>Tik op het bladwijzer-icoon onder een artikel om het hier te bewaren.</p></div>`;
    html += `<div class="feed">` + items.map(([key, it]) => {
      const a = it.a, s = SRC[a.src] || { id: a.src, name: it.srcName || a.src };
      return `<article class="story" data-key="${esc(key)}"><div class="story-grid"><div>
        <h3><a href="${esc(a.url)}" target="_blank" rel="noopener" data-open="${esc(key)}" data-id="${esc(a.id)}">${esc(a.title)}</a></h3>
        ${a.summary ? `<p class="sum">${esc(a.summary)}</p>` : ""}
        <div class="meta"><span class="src">${srcMark(s)}${esc(a.via || s.name)}</span><span class="sep"></span><span>${ago(a.ts)}</span></div>
      </div>${a.img ? `<img class="thumb" src="${esc(a.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-img>` : ""}</div>
      <div class="actions"><button class="act save" type="button" data-act="unsave" data-key="${esc(key)}" aria-pressed="true" aria-label="Uit bewaard halen">${icon("saved")}Verwijderen</button></div></article>`;
    }).join("") + `</div>`;
    return html;
  }

  let confirmReset = false, showImport = false;
  function renderSources() {
    const on = DATA.sources.filter((s) => srcOn(s.id));
    const total = articlesFor(true).length;
    let html = `<div class="view-head"><h2>Bronnen</h2><p>${on.length} van ${DATA.sources.length} bronnen aan, samen ${total} artikelen van de afgelopen drie dagen. Tik op het pijltje om per bron onderwerpen aan of uit te zetten.</p></div>`;

    // bronnen per groep
    html += `<div class="panel-title"><h3>Jouw bronnen</h3><span>Onderwerpen per bron</span></div><div class="panel">`;
    for (const g of DATA.groups) {
      const srcs = DATA.sources.filter((s) => s.group === g.id);
      if (!srcs.length) continue;
      html += `<div class="group-label">${esc(g.label)}</div>`;
      for (const s of srcs) {
        const isOn = srcOn(s.id), open = expanded.has("src:" + s.id);
        const off = S.srcTopicsOff[s.id] || [];
        const tc = {};
        DATA.articles.forEach((a) => { if (a.src === s.id) a.topics.forEach((t) => (tc[t] = (tc[t] || 0) + 1)); });
        const stateTxt = s.state === "fout" ? `<span class="bad">Niet bereikbaar bij laatste update</span>`
          : s.state === "deels" ? `<span class="part">${s.count} artikelen, niet alle feeds bereikbaar</span>` : `<span>${s.count} artikelen</span>`;
        const sub = [stateTxt, s.paywall ? "<span>betaalmuur</span>" : "", s.lang === "en" ? "<span>Engels</span>" : "", off.length ? `<span>${off.length} onderwerp${off.length > 1 ? "en" : ""} uit</span>` : ""].filter(Boolean).join("");
        html += `<div class="src-row"><div class="src-main">${srcMark(s)}
          <div><div class="src-name">${esc(s.name)}</div><div class="src-sub">${sub}</div></div>
          <button class="expand" type="button" data-act="expand" data-key="src:${esc(s.id)}" aria-expanded="${open}" aria-label="Onderwerpen van ${esc(s.name)}">${icon("chev")}</button>
          <label class="switch"><input type="checkbox" id="src-${esc(s.id)}" data-act="src" data-src="${esc(s.id)}" ${isOn ? "checked" : ""} aria-label="${esc(s.name)} volgen"><span></span></label>
        </div>`;
        if (open) {
          const ids = DATA.topics.map((t) => t.id).sort((x, y) => (tc[y] || 0) - (tc[x] || 0));
          html += `<div class="src-topics"><p>${s.note ? esc(s.note) + ". " : ""}Welke onderwerpen wil je van ${esc(s.name)} zien?</p><div class="topic-toggles">` +
            ids.map((t) => `<button class="tt" type="button" data-act="srctopic" data-src="${esc(s.id)}" data-topic="${t}" aria-pressed="${!off.includes(t)}">${esc(TOPIC[t].label)}${tc[t] ? `<span class="n">${tc[t]}</span>` : ""}</button>`).join("") +
            `</div></div>`;
        }
        html += `</div>`;
      }
    }
    html += `</div>`;

    // onderwerpen
    html += `<div class="panel-title"><h3>Onderwerpen</h3><span>Geldt voor alle bronnen</span></div><div class="panel pad"><div class="topic-toggles">` +
      DATA.topics.map((t) => `<button class="tt" type="button" data-act="globaltopic" data-topic="${t.id}" aria-pressed="${!S.topicsOff.includes(t.id)}">${esc(t.label)}</button>`).join("") +
      `</div><p class="small-print">Doorgestreept betekent: nooit tonen.</p></div>`;

    // gedempte woorden
    html += `<div class="panel-title"><h3>Nooit tonen</h3><span>Woorden in kop of intro</span></div><div class="panel pad">
      <form class="mute-form" data-form="mute"><input class="field" id="mute-input" type="text" placeholder="Bijvoorbeeld: voetbal, Eurovisie" autocomplete="off" aria-label="Woord om te dempen"><button class="btn" type="submit">Toevoegen</button></form>
      ${S.muted.length ? `<div class="muted-list">${S.muted.map((m) => `<button type="button" data-act="unmute" data-word="${esc(m)}" aria-label="${esc(m)} weer tonen">${esc(m)}${icon("x")}</button>`).join("")}</div>` : ""}
    </div>`;

    // wat heeft de app geleerd
    const nice = (k) => {
      const type = k.split(":")[0], rest = k.slice(k.indexOf(":") + 1);
      if (type === "s") return SRC[rest] ? SRC[rest].name : null;
      if (type === "t") return TOPIC[rest] ? TOPIC[rest].label : null;
      if (type === "st") { const [s, t] = rest.split("|"); return SRC[s] && TOPIC[t] ? `${TOPIC[t].label} · ${SRC[s].name}` : null; }
      if (type === "w") return "‘" + (S.wl[rest] || rest) + "’";
      return null;
    };
    const ranked = Object.entries(S.w).filter(([k]) => k !== "b").map(([k, v]) => [nice(k), v]).filter(([n]) => n);
    const pos = ranked.filter(([, v]) => v > 0.05).sort((x, y) => y[1] - x[1]).slice(0, 6);
    const neg = ranked.filter(([, v]) => v < -0.05).sort((x, y) => x[1] - y[1]).slice(0, 6);
    const max = Math.max(0.5, ...ranked.map(([, v]) => Math.abs(v)));
    const bars = (arr, cls) => arr.length ? arr.map(([n, v]) => `<div class="bar-row"><span class="lbl">${esc(n)}</span><span class="bar ${cls}"><i style="width:${Math.round((Math.abs(v) / max) * 100)}%"></i></span></div>`).join("") : `<p class="small-print" style="margin:0">Nog niets</p>`;
    const ups = Object.values(S.votes).filter((v) => v === 1).length, downs = Object.values(S.votes).filter((v) => v === -1).length;
    html += `<div class="panel-title"><h3>Wat Voorpagina over je leerde</h3></div><div class="panel pad">
      <div class="stats"><span><b>${ups}</b>duim omhoog</span><span><b>${downs}</b>duim omlaag</span><span><b>${Object.keys(S.read).length}</b>gelezen</span></div>
      <div class="learned"><div><h4>Meer van</h4>${bars(pos, "pos")}</div><div><h4>Minder van</h4>${bars(neg, "neg")}</div></div>
      <div class="row-actions">${confirmReset
        ? `<span class="confirm">Alles wat de app leerde wissen?</span><button class="btn small danger" type="button" data-act="reset-yes">Ja, wissen</button><button class="btn small ghost" type="button" data-act="reset-no">Annuleren</button>`
        : `<button class="btn small ghost" type="button" data-act="reset">Opnieuw beginnen</button>`}</div>
    </div>`;

    // lezen in de app
    html += `<div class="panel-title"><h3>Lezen in de app</h3>${S.rk ? `<span class="key-state on">${icon("key")}Aan</span>` : `<span class="key-state off">${icon("key")}Nog niet ingesteld</span>`}</div><div class="panel pad">
      <p class="panel-note" style="margin:0 0 12px">Volledige artikelen lees je hier in de app. De teksten staan versleuteld op je site; met je leescode opent dit apparaat ze. Bij bronnen met een betaalmuur zie je kop en intro.</p>
      ${S.rk ? `<div class="set-line"><span>Leescode staat op dit apparaat</span><button class="btn small ghost" type="button" data-act="key-clear">Verwijderen</button></div>`
        : `<form class="mute-form" data-form="key"><input class="field" id="key-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Je leescode" aria-label="Leescode"><button class="btn" type="submit">Opslaan</button></form>`}
    </div>`;

    // weergave + overzetten
    html += `<div class="panel-title"><h3>App</h3></div><div class="panel pad">
      <div class="set-line"><span>Weergave</span><div class="seg" role="group" aria-label="Weergave">
        ${[["auto", "Automatisch"], ["light", "Licht"], ["dark", "Donker"]].map(([k, l]) => `<button type="button" data-act="theme" data-theme-val="${k}" aria-pressed="${S.theme === k}">${l}</button>`).join("")}
      </div></div>
      <div class="set-line" style="margin-top:16px"><span>Instellingen naar een ander apparaat</span>
        <button class="btn small ghost" type="button" data-act="export">Kopieer code</button></div>
      <div class="row-actions">${showImport
        ? `<textarea class="field" id="import-code" placeholder="Plak hier de code van je andere apparaat"></textarea><button class="btn small" type="button" data-act="import-do">Code toepassen</button><button class="btn small ghost" type="button" data-act="import-toggle">Annuleren</button>`
        : `<button class="btn small ghost" type="button" data-act="import-toggle">Code plakken</button>`}</div>
      ${ghLinks()}
    </div>`;
    return html;
  }

  function ghLinks() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);
    const repo = location.pathname.split("/").filter(Boolean)[0];
    if (!m || !repo) return `<p class="small-print">Een bron toevoegen die hier niet staat? Vraag het Claude, of voeg hem toe in <code>sources.json</code>.</p>`;
    const base = `https://github.com/${m[1]}/${repo}`;
    return `<p class="small-print">Een bron toevoegen die hier niet staat? Voeg hem toe in <a href="${base}/edit/main/sources.json" target="_blank" rel="noopener">sources.json</a> of vraag het Claude. Het nieuws ververst elk halfuur; <a href="${base}/actions" target="_blank" rel="noopener">nu verversen</a> kan via GitHub.</p>`;
  }

  function emptyFollow() {
    return `<div class="empty"><h3>Geen artikelen</h3><p>Je volgt nog geen bronnen, of alle onderwerpen staan uit. Kies je bronnen in het tabblad Bronnen.</p><p style="margin-top:14px"><button class="btn" type="button" data-act="go" data-view="sources">Naar Bronnen</button></p></div>`;
  }

  function render(keepScroll) {
    if (!DATA) return;
    const y = window.scrollY;
    const html = { foryou: renderForYou, latest: renderLatest, discover: renderDiscover, saved: renderSaved, sources: renderSources }[view]();
    $("#view").innerHTML = html;
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-current", t.dataset.view === view ? "page" : "false"));
    const n = Object.keys(S.saved).length;
    const savedTab = $('.tab[data-view="saved"]');
    savedTab.querySelector(".badge")?.remove();
    if (n) savedTab.insertAdjacentHTML("beforeend", `<span class="badge">${n}</span>`);
    if (keepScroll) window.scrollTo(0, y);
  }

  function setView(v) {
    if (v === view) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    view = v; S.view = v; save();
    limit = 40; hiddenNow.clear(); confirmReset = false; showImport = false;
    try { history.replaceState(null, "", "#" + v); } catch (e) { /* niet toegestaan */ }
    render();
    window.scrollTo(0, 0);
  }

  // ---------- acties ----------
  function findStory(key) {
    const list = view === "discover" ? articlesFor(false) : articlesFor(true);
    return buildStories(list).find((st) => st.key === key) || buildStories(DATA.articles).find((st) => st.key === key);
  }
  function setVote(st, v) { for (const a of st.all) { if (v) S.votes[a.id] = v; else delete S.votes[a.id]; } }

  // ---------- lezer ----------
  const RSALT = new TextEncoder().encode("voorpagina-lezer-v1");
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function deriveKey(pass) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass.trim()), "PBKDF2", false, ["deriveBits"]);
    return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: RSALT, iterations: 150000 }, base, 256);
  }
  async function decryptWith(raw, text) {
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const bytes = unb64(text.trim());
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  async function setKey(pass, form) {
    if (!pass || pass.trim().length < 4) { toast("Vul je leescode in"); return; }
    const btn = form.querySelector("button"); btn.disabled = true; btn.textContent = "Controleren…";
    try {
      if (!(window.crypto && crypto.subtle)) throw new Error("nocrypto");
      const raw = await deriveKey(pass);
      const r = await fetch("data/r/_check.txt?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("nocheck");
      await decryptWith(raw, await r.text());
      S.rk = b64(raw); save();
      toast("Leescode klopt. Artikelen openen nu hier.");
      if (readerOpen) openReader(readerOpen.id, readerOpen.key, true); else render(true);
    } catch (e) {
      btn.disabled = false; btn.textContent = "Opslaan";
      toast(e.message === "nocheck" ? "Lezen in de app is op de site nog niet aangezet" : e.message === "nocrypto" ? "Deze browser kan de artikelen niet ontsleutelen" : "Deze leescode klopt niet");
    }
  }

  let readerOpen = null, readTimer = null;
  function findArticle(id) {
    return DATA.articles.find((a) => a.id === id) || (Object.values(S.saved).find((x) => x.a.id === id) || {}).a;
  }
  function openReader(id, key, refresh) {
    const a = findArticle(id); if (!a) return;
    const src = SRC[a.src] || { id: a.src, name: a.src };
    const st = key ? findStory(key) : null;
    if (!refresh) {
      const all = st ? st.all : [a];
      if (!all.some((x) => S.read[x.id])) learn(a, 1, 0.2);
      for (const x of all) S.read[x.id] = Math.floor(Date.now() / 1000);
      save();
      clearTimeout(readTimer);
      readTimer = setTimeout(() => { if (readerOpen && readerOpen.id === id) { learn(a, 1, 0.3); save(); } }, 45000);
      if (!readerOpen) try { history.pushState({ reader: 1 }, ""); } catch (e) { /* niet toegestaan */ }
    }
    readerOpen = { id, key, a };
    const el = $("#reader");
    const others = st ? st.all.filter((x) => x.id !== id) : [];
    const name = a.via || src.name;
    const v = st ? vote(st) : (S.votes[a.id] || 0);
    const canRead = a.r && !src.paywall;
    let status;
    if (canRead && S.rk) status = `<div class="loading-lines" id="r-body">${[92, 97, 88, 95, 60].map((w) => `<div class="sk" style="width:${w}%"></div>`).join("")}</div>`;
    else if (canRead) status = `<div class="notice"><strong>${icon("key")}Lees het hele artikel hier</strong><p>Vul één keer je leescode in. Daarna openen alle artikelen van ${esc(src.name)} en andere open bronnen direct in de app.</p><form class="mute-form" data-form="key"><input class="field" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Je leescode" aria-label="Leescode"><button class="btn" type="submit">Openen</button></form></div>`;
    else if (src.paywall) status = `<div class="notice"><strong>${icon("lock")}Achter de betaalmuur van ${esc(src.name)}</strong><p>Met een abonnement lees je het volledige artikel op de site van ${esc(src.name)}.</p><p><a class="btn small ghost" href="${esc(a.url)}" target="_blank" rel="noopener">${icon("ext")}Verder lezen bij ${esc(src.name)}</a></p></div>`;
    else status = `<div class="notice"><strong>Volledige tekst niet beschikbaar</strong><p>${a.via ? `Dit bericht komt uit een zoekfeed.` : `De tekst van dit artikel kon niet worden opgehaald.`} Je kunt het lezen op de site van ${esc(name)}.</p><p><a class="btn small ghost" href="${esc(a.url)}" target="_blank" rel="noopener">${icon("ext")}Openen bij ${esc(name)}</a></p></div>`;

    el.innerHTML = `<div class="reader-bar"><div class="inner">
        <button class="back" type="button" data-act="reader-close">${icon("back")}Terug</button>
        <span class="title">${srcMark(src)}${esc(name)}</span>
        <button class="icon-btn" type="button" data-act="reader-size" aria-label="Tekstgrootte" title="Tekstgrootte">${icon("text")}</button>
        <a class="icon-btn" href="${esc(a.url)}" target="_blank" rel="noopener" aria-label="Origineel openen" title="Origineel">${icon("ext")}</a>
      </div><div class="progress" id="r-progress"></div></div>
      <article class="article size-${S.rs ?? 1}">
        <div class="kicker"><span class="src">${srcMark(src)}${esc(name)}</span><span>${ago(a.ts)}</span>${a.topics.map((t) => TOPIC[t] ? `<span>${esc(TOPIC[t].label)}</span>` : "").join("")}</div>
        <h1>${esc(a.title)}</h1>
        ${a.img ? `<img class="hero" src="${esc(a.img)}" alt="" referrerpolicy="no-referrer" data-img>` : ""}
        ${a.summary && !(canRead && S.rk) ? `<p class="intro">${esc(a.summary)}</p>` : ""}
        ${status}
        <div class="end">
          <h2>Was dit interessant?</h2>
          <div class="row">
            <button class="btn ghost" type="button" data-act="reader-vote" data-v="1" aria-pressed="${v === 1}">${icon("up")}Ja, meer zoals dit</button>
            <button class="btn ghost no" type="button" data-act="reader-vote" data-v="-1" aria-pressed="${v === -1}">${icon("down")}Niet voor mij</button>
          </div>
          ${others.length ? `<h2 style="margin-top:10px">Ook over dit verhaal</h2><ul class="also">${others.map((o) => `<li><a href="${esc(o.url)}" target="_blank" rel="noopener" data-open="${esc(key)}" data-id="${esc(o.id)}">${esc(o.title)}</a>${metaHTML(o)}</li>`).join("")}</ul>` : ""}
          <p class="orig">Bron: <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(name)}</a></p>
        </div>
      </article>`;
    el.hidden = false; el.scrollTop = 0;
    document.body.classList.add("reading");
    if (canRead && S.rk) loadBody(a);
  }
  async function loadBody(a) {
    const box = $("#r-body");
    try {
      const r = await fetch("data/r/" + a.id + ".txt");
      if (!r.ok) throw new Error("weg");
      const doc = await decryptWith(unb64(S.rk).buffer, await r.text());
      if (!readerOpen || readerOpen.id !== a.id || !box.isConnected) return;
      box.outerHTML = `<div class="body">${doc.p.map((p) => `<p>${esc(p)}</p>`).join("")}</div>`;
    } catch (e) {
      if (!box.isConnected) return;
      box.outerHTML = `<div class="notice"><strong>Tekst kon niet worden geopend</strong><p>${e.name === "OperationError" ? "Je leescode past niet bij deze artikelen. Stel hem opnieuw in bij Bronnen." : "Het artikel is niet meer beschikbaar."}</p><p><a class="btn small ghost" href="${esc(a.url)}" target="_blank" rel="noopener">${icon("ext")}Openen bij de bron</a></p></div>`;
    }
  }
  function readerVote(v) {
    if (!readerOpen) return;
    const st = readerOpen.key ? findStory(readerOpen.key) : null;
    const a = readerOpen.a;
    if (st) setVote(st, v); else S.votes[a.id] = v;
    learn(a, v === 1 ? 1 : 0, 1); S.nVotes++; save();
    $("#reader").querySelectorAll('[data-act="reader-vote"]').forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.v === v)));
    toast(v === 1 ? "Genoteerd: meer zoals dit" : "Begrepen, minder van dit soort artikelen");
  }
  function closeReader(fromHistory) {
    if (!readerOpen) return;
    readerOpen = null; clearTimeout(readTimer);
    $("#reader").hidden = true; $("#reader").innerHTML = "";
    document.body.classList.remove("reading");
    render(true);
    if (!fromHistory) try { if (history.state && history.state.reader) history.back(); } catch (e) { /* ok */ }
  }
  window.addEventListener("popstate", () => { if (readerOpen) closeReader(true); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && readerOpen) closeReader(); });
  $("#reader").addEventListener("scroll", (e) => {
    const el = e.currentTarget, p = $("#r-progress");
    if (p) p.style.width = Math.min(100, (el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)) * 100) + "%";
  }, { passive: true });

  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  let themeSetByApp = false;
  function applyTheme() {
    const r = document.documentElement;
    if (S.theme === "auto") { if (themeSetByApp) r.removeAttribute("data-theme"); themeSetByApp = false; }
    else { r.setAttribute("data-theme", S.theme); themeSetByApp = true; }
  }

  document.addEventListener("click", (e) => {
    const openLink = e.target.closest("a[data-open]");
    if (openLink) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return; // bewust in nieuw tabblad
      e.preventDefault();
      openReader(openLink.dataset.id, openLink.dataset.open);
      return;
    }
    const tab = e.target.closest(".tab");
    if (tab) return setView(tab.dataset.view);
    const b = e.target.closest("[data-act]");
    if (!b || b.tagName === "INPUT") return;
    const act = b.dataset.act, key = b.dataset.key;
    switch (act) {
      case "up": {
        const st = findStory(key); if (!st) return;
        if (vote(st) === 1) { setVote(st, 0); learn(st.rep, 0, 0.5); S.nVotes = Math.max(0, S.nVotes - 1); }
        else { setVote(st, 1); learn(st.rep, 1, 1); S.nVotes++; toast(S.nVotes === 3 ? "Voor jou wordt nu persoonlijk" : "Genoteerd: meer zoals dit"); }
        save(); render(true); break;
      }
      case "down": {
        const st = findStory(key); if (!st) return;
        hiddenNow.set(key, { w: JSON.stringify(S.w), prev: vote(st), reason: null });
        setVote(st, -1); learn(st.rep, 0, 1); S.nVotes++;
        save(); render(true); break;
      }
      case "why": {
        const h = hiddenNow.get(key), st = findStory(key); if (!h || !st) return;
        S.w = JSON.parse(h.w); learn(st.rep, 0, 1);
        const only = { src: "s:", topic: "t:", srctopic: "st:" }[b.dataset.why];
        learn(st.rep, 0, 2.2, only);
        h.reason = b.dataset.why;
        save(); render(true); toast("Begrepen, daar krijg je minder van"); break;
      }
      case "undo": {
        const h = hiddenNow.get(key), st = findStory(key); if (!h || !st) return;
        S.w = JSON.parse(h.w); setVote(st, h.prev); S.nVotes = Math.max(0, S.nVotes - 1);
        hiddenNow.delete(key); save(); render(true); break;
      }
      case "save": {
        const st = findStory(key); if (!st) return;
        if (S.saved[key]) { delete S.saved[key]; toast("Uit bewaard gehaald"); }
        else { S.saved[key] = { t: Date.now() / 1000, a: st.rep, srcName: SRC[st.rep.src].name }; learn(st.rep, 1, 0.5); toast("Bewaard voor later"); }
        save(); render(true); break;
      }
      case "unsave": delete S.saved[key]; save(); render(true); break;
      case "expand": expanded.has(key) ? expanded.delete(key) : expanded.add(key); render(true); break;
      case "topic": topicFilter = b.dataset.topic; limit = 40; render(true); break;
      case "more": limit += 30; render(true); break;
      case "tip": S.tipDone = true; save(); render(true); break;
      case "go": setView(b.dataset.view); break;
      case "follow": S.src[b.dataset.src] = true; save(); render(true); toast(`Je volgt nu ${SRC[b.dataset.src].name}`); break;
      case "srctopic": {
        const s = b.dataset.src, t = b.dataset.topic;
        const off = new Set(S.srcTopicsOff[s] || []);
        off.has(t) ? off.delete(t) : off.add(t);
        S.srcTopicsOff[s] = [...off]; save(); render(true); break;
      }
      case "globaltopic": {
        const t = b.dataset.topic, off = new Set(S.topicsOff);
        off.has(t) ? off.delete(t) : off.add(t);
        S.topicsOff = [...off]; save(); render(true); break;
      }
      case "unmute": S.muted = S.muted.filter((m) => m !== b.dataset.word); save(); render(true); break;
      case "reset": confirmReset = true; render(true); break;
      case "reset-no": confirmReset = false; render(true); break;
      case "reset-yes": S.w = {}; S.wl = {}; S.votes = {}; S.nVotes = 0; confirmReset = false; save(); render(true); toast("Opnieuw begonnen"); break;
      case "theme": S.theme = b.dataset.themeVal; applyTheme(); save(); render(true); break;
      case "export": exportCode(); break;
      case "import-toggle": showImport = !showImport; render(true); break;
      case "import-do": importCode(); break;
      case "reader-close": closeReader(); break;
      case "reader-size": S.rs = ((S.rs ?? 1) + 1) % 3; save(); { const art = $(".article"); if (art) art.className = "article size-" + S.rs; } break;
      case "reader-vote": readerVote(+b.dataset.v); break;
      case "key-clear": S.rk = null; save(); render(true); toast("Leescode verwijderd van dit apparaat"); break;
    }
  });

  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.act === "src") {
      S.src[el.dataset.src] = el.checked; save();
      toast(el.checked ? `${SRC[el.dataset.src].name} staat aan` : `${SRC[el.dataset.src].name} staat uit`);
      render(true);
    }
  });

  document.addEventListener("submit", (e) => {
    const kf = e.target.closest("[data-form=key]");
    if (kf) { e.preventDefault(); setKey(kf.querySelector("input").value, kf); return; }
    const f = e.target.closest("[data-form=mute]"); if (!f) return;
    e.preventDefault();
    const inp = $("#mute-input");
    const words = inp.value.split(",").map((w) => w.trim()).filter((w) => w.length > 1);
    if (!words.length) return;
    S.muted = [...new Set([...S.muted, ...words])];
    save(); render(true); toast(words.length > 1 ? "Woorden gedempt" : `‘${words[0]}’ wordt niet meer getoond`);
  });

  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img.tagName === "IMG" && img.hasAttribute("data-img")) img.remove();
  }, true);

  function exportCode() {
    const keep = { rk: S.rk, rs: S.rs, src: S.src, srcTopicsOff: S.srcTopicsOff, topicsOff: S.topicsOff, muted: S.muted, w: S.w, wl: S.wl, nVotes: S.nVotes, saved: S.saved };
    const code = "VP1:" + btoa(unescape(encodeURIComponent(JSON.stringify(keep))));
    const done = () => toast("Code gekopieerd. Plak hem op je andere apparaat onder Bronnen.");
    const fallback = () => { showImport = true; render(true); const t = $("#import-code"); if (t) { t.value = code; t.select(); } toast("Selecteer en kopieer de code"); };
    try { navigator.clipboard.writeText(code).then(done, fallback); } catch (e) { fallback(); }
  }
  function importCode() {
    const v = ($("#import-code") || {}).value || "";
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(v.trim().replace(/^VP1:/, "")))));
      Object.assign(S, data); save(); showImport = false; render(true); toast("Instellingen overgenomen");
    } catch (e) { toast("Deze code klopt niet. Kopieer hem opnieuw op je andere apparaat."); }
  }

  $("#refresh").addEventListener("click", () => loadData(true));
  window.addEventListener("scroll", () => $("#masthead").classList.toggle("scrolled", window.scrollY > 4), { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && DATA && Date.now() / 1000 - DATA.generated > 20 * 60) loadData(false);
    if (document.visibilityState === "visible") renderHeader();
  });

  applyTheme();
  renderHeader();
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-current", t.dataset.view === view ? "page" : "false"));
  loadData(false);

  if ("serviceWorker" in navigator && /github\.io$/.test(location.hostname)) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
