#!/usr/bin/env python3
"""Voorpagina: haalt alle feeds op, kent onderwerpen toe, groepeert dezelfde
verhalen van verschillende bronnen en schrijft site/data/articles.json.

Gebruik:  python scripts/fetch_news.py [--prev URL_OF_PAD] [--out PAD]
"""
import argparse
import calendar
import concurrent.futures as cf
import hashlib
import html
import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict

import feedparser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEEP_HOURS = 72
MAX_PER_FEED = 60
CLUSTER_WINDOW_H = 36
CLUSTER_THRESHOLD = 0.28
CLUSTER_SURE = 0.45
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36 Voorpagina/1.0")

STOP = set("""
de het een en of van in op te met voor door naar bij uit aan over als is zijn was
waren wordt worden werd dat die dit deze er om maar ook nog niet geen al dan wel
meer veel zo tot na onder tegen zich hij zij ze we wij jij je u ik hun haar hem
heeft hebben had kan kunnen moet moeten zal zullen wil willen gaat gaan komt
komen nieuwe nieuw jaar jaren eerste twee drie vandaag gisteren morgen zegt
volgens toch weer echter waar wat wie hoe waarom
the a an and or of to in on for with by from at as is are was were be been it its
this that these those he she they we you i his her their our not no but also
new says said after over into up out about more than just will would can could
has have had who what when where why how
""".split())

TRACKING = re.compile(r"^(utm_|fbclid|gclid|mc_|ocid|cmpid|at_|xtor|ref$|rss$|channel$)")


def norm_url(u):
    try:
        p = urllib.parse.urlsplit(u.strip())
        q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query) if not TRACKING.match(k)]
        return urllib.parse.urlunsplit((p.scheme or "https", p.netloc.lower(), p.path, urllib.parse.urlencode(q), ""))
    except Exception:
        return u


def strip_html(s):
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s or "", flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def shorten(s, n=300):
    if len(s) <= n:
        return s
    cut = s[:n].rsplit(" ", 1)[0]
    return cut.rstrip(",;:-") + "…"


def fold(s):
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if not unicodedata.combining(c))


def find_image(e):
    for key in ("media_content", "media_thumbnail"):
        for m in e.get(key) or []:
            url = m.get("url")
            if url and not url.endswith(".mp4"):
                return url
    for enc in e.get("enclosures") or []:
        if (enc.get("type") or "").startswith("image") and enc.get("href"):
            return enc["href"]
    for l in e.get("links") or []:
        if (l.get("type") or "").startswith("image") and l.get("href"):
            return l["href"]
    blob = (e.get("summary") or "") + " ".join(c.get("value", "") for c in e.get("content") or [])
    m = re.search(r"<img[^>]+src=[\"']([^\"']+)", blob)
    if m and not m.group(1).startswith("data:"):
        return html.unescape(m.group(1))
    return None


def entry_time(e, now):
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        t = e.get(key)
        if t:
            ts = calendar.timegm(t)
            return min(ts, now)
    return now


class TopicMatcher:
    def __init__(self, topics):
        self.rules = []
        for t in topics:
            pats = []
            for kw in t.get("kw", []):
                k = re.escape(fold(kw.strip()))
                # korte woorden exact, langere ook als begin van een samenstelling
                tail = "" if len(kw.strip()) >= 5 else r"(?![a-z0-9])"
                pats.append(r"(?<![a-z0-9])" + k + tail)
            self.rules.append((t["id"], re.compile("|".join(pats)) if pats else None))

    def match(self, text):
        f = fold(text)
        return [tid for tid, rx in self.rules if rx is not None and rx.search(f)]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read()


def process_feed(src, feed, matcher, now):
    raw = fetch(feed["url"])
    parsed = feedparser.parse(raw)
    if parsed.bozo and not parsed.entries:
        raise ValueError(f"geen geldige feed ({type(parsed.bozo_exception).__name__})")
    out = []
    for e in parsed.entries[:MAX_PER_FEED]:
        link = e.get("link") or e.get("id")
        title = strip_html(e.get("title") or "")
        if not link or not title:
            continue
        via = None
        summary = strip_html(e.get("summary") or e.get("description") or "")
        if src.get("aggregator"):
            # Google Nieuws: "Kop - Uitgever"; samenvatting is een linklijst
            st = (e.get("source") or {}).get("title")
            if st and title.endswith(" - " + st):
                title = title[: -len(st) - 3].strip()
            via = st
            summary = ""
        if summary.lower().startswith(title.lower()):
            summary = summary[len(title):].strip(" -–:")
        text = f"{title}. {summary}"
        topics = list(dict.fromkeys((feed.get("topics") or []) + matcher.match(text)))
        if not topics and src.get("fallback"):
            topics = [src["fallback"]]
        url = norm_url(link)
        out.append({
            "id": hashlib.sha1(url.encode()).hexdigest()[:12],
            "src": src["id"],
            "via": via,
            "title": title,
            "summary": shorten(summary),
            "url": url,
            "img": find_image(e),
            "ts": entry_time(e, now),
            "topics": topics,
        })
    return out


def load_prev(ref):
    if not ref:
        return []
    try:
        if re.match(r"https?://", ref):
            data = json.loads(fetch(ref).decode("utf-8"))
        else:
            with open(ref, encoding="utf-8") as fh:
                data = json.load(fh)
        return data.get("articles", [])
    except Exception as ex:  # eerste run of site nog niet online
        print(f"[info] geen vorige data ({ex})", file=sys.stderr)
        return []


# ---------- groeperen van dezelfde verhalen ----------

WORD = re.compile(r"[A-Za-zÀ-ÿ0-9][\wÀ-ÿ'-]*")


def terms(text):
    """Woordstammen (eerste 4 letters) + namen (woorden met hoofdletter)."""
    stems, names = [], set()
    for m in WORD.finditer(text or ""):
        raw = m.group(0).strip("'")
        for part in re.split(r"[-']", raw):
            w = fold(part)
            if len(w) < 3 or w in STOP:
                continue
            stems.append(w[:4])
            if part[:1].isupper() or part.isupper():
                names.add(w)
    return stems, names


def cluster(articles):
    n = len(articles)
    docs = []
    df = defaultdict(int)
    names_of = []
    for a in articles:
        # titel telt dubbel, begin van de samenvatting enkel
        c = defaultdict(float)
        st, nm1 = terms(a["title"])
        for g in st:
            c[g] += 2.0
        st2, nm2 = terms(a["summary"][:180])
        for g in st2:
            c[g] += 1.0
        names_of.append(nm1 | nm2)
        docs.append(c)
        for g in c:
            df[g] += 1
    max_df = max(8, int(n * 0.05))
    vecs = []
    for c in docs:
        v = {g: (1 + math.log(w)) * math.log((n + 1) / (df[g] + 0.5)) for g, w in c.items() if df[g] <= max_df}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        vecs.append({g: x / norm for g, x in v.items()})

    index = defaultdict(list)
    for i, v in enumerate(vecs):
        for g in v:
            index[g].append(i)

    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    win = CLUSTER_WINDOW_H * 3600
    for i, v in enumerate(vecs):
        scores = defaultdict(float)
        for g, x in v.items():
            for j in index[g]:
                if j > i:
                    scores[j] += x * vecs[j][g]
        for j, s in scores.items():
            if s < CLUSTER_THRESHOLD:
                continue
            # onder de 'zeker'-grens moet er ook een gedeelde naam zijn (Flink, Tata Steel)
            if s < CLUSTER_SURE and not (names_of[i] & names_of[j]):
                continue
            a, b = articles[i], articles[j]
            if a["src"] == b["src"] and not (a.get("via") or b.get("via")):
                continue  # zelfde bron: geen dubbel verhaal, maar vervolgartikel
            if abs(a["ts"] - b["ts"]) > win:
                continue
            parent[find(i)] = find(j)

    groups = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)
    for members in groups.values():
        members.sort(key=lambda k: articles[k]["ts"])
        cid = articles[members[0]]["id"]
        for k in members:
            articles[k]["cluster"] = cid
    return len([g for g in groups.values() if len(g) > 1])


# ---------- lezen in de app: volledige tekst, versleuteld ----------
# De site is openbaar. De volledige tekst wordt daarom versleuteld met READER_KEY
# (GitHub-secret); alleen wie die leescode heeft, kan de artikelen in de app lezen.
# Bronnen met een betaalmuur en zoekfeeds worden overgeslagen.
READER_SALT = b"voorpagina-lezer-v1"
READER_MAX_NEW = 160


def reader_key(passphrase):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=READER_SALT, iterations=150_000)
    return kdf.derive(passphrase.encode("utf-8"))


def encrypt(key, obj):
    import base64
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, json.dumps(obj, ensure_ascii=False).encode("utf-8"), None)
    return base64.b64encode(nonce + ct).decode("ascii")


def extract_article(url):
    import trafilatura
    raw = fetch(url)
    text = trafilatura.extract(raw.decode("utf-8", "replace"), url=url, favor_precision=True,
                               include_comments=False, include_tables=False, output_format="txt")
    if not text:
        return None
    paras = [p.strip() for p in text.split("\n") if p.strip()]
    words = sum(len(p.split()) for p in paras)
    if words < 80:
        return None
    return {"p": paras, "w": words}


def build_reader(articles, src_cfg, out_dir):
    passphrase = os.environ.get("READER_KEY", "").strip()
    rdir = os.path.join(out_dir, "r")
    if not passphrase:
        print("[info] geen READER_KEY: lezen in de app staat uit", file=sys.stderr)
        return
    os.makedirs(rdir, exist_ok=True)
    key = reader_key(passphrase)
    with open(os.path.join(rdir, "_check.txt"), "w") as fh:
        fh.write(encrypt(key, {"ok": True}))
    failed_path = os.path.join(rdir, "_failed.json")
    try:
        with open(failed_path) as fh:
            failed = set(json.load(fh))
    except Exception:
        failed = set()

    live = {a["id"] for a in articles}
    for fn in os.listdir(rdir):  # opruimen: artikelen die uit de feed zijn
        if fn.endswith(".txt") and fn[:-4] not in live and fn != "_check.txt":
            os.remove(os.path.join(rdir, fn))
    failed &= live

    todo = []
    for a in articles:
        s = src_cfg[a["src"]]
        if s.get("paywall") or s.get("aggregator"):
            continue
        if os.path.exists(os.path.join(rdir, a["id"] + ".txt")):
            a["r"] = 1
        elif a["id"] not in failed:
            todo.append(a)
    todo = todo[:READER_MAX_NEW]  # nieuwste eerst; rest volgt bij de volgende run

    def work(a):
        doc = extract_article(a["url"])
        if doc:  # kop niet dubbel tonen
            while doc["p"] and fold(doc["p"][0]).strip(" .") == fold(a["title"]).strip(" ."):
                doc["p"].pop(0)
        return a, doc

    got = 0
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for fut in cf.as_completed([ex.submit(work, a) for a in todo]):
            try:
                a, doc = fut.result()
            except Exception:
                continue  # tijdelijke fout: volgende run opnieuw
            if not doc:
                failed.add(a["id"])
                continue
            with open(os.path.join(rdir, a["id"] + ".txt"), "w") as fh:
                fh.write(encrypt(key, doc))
            a["r"] = 1
            got += 1
    with open(failed_path, "w") as fh:
        json.dump(sorted(failed), fh)
    total = sum(1 for a in articles if a.get("r"))
    print(f"lezen in de app: {got} nieuwe teksten, {total} totaal")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prev", default=os.environ.get("PREV_URL"))
    ap.add_argument("--out", default=os.path.join(ROOT, "site", "data", "articles.json"))
    ap.add_argument("--sources", default=os.path.join(ROOT, "sources.json"))
    ap.add_argument("--offline", help="map met <bron-id>.json bestanden (tests)")
    args = ap.parse_args()

    with open(args.sources, encoding="utf-8") as fh:
        cfg = json.load(fh)
    matcher = TopicMatcher(cfg["topics"])
    now = int(time.time())

    jobs = [(s, f) for s in cfg["sources"] for f in s["feeds"]]
    status = {s["id"]: {"ok": 0, "fail": 0, "errors": []} for s in cfg["sources"]}
    fresh = []
    if args.offline:
        for s in cfg["sources"]:
            p = os.path.join(args.offline, s["id"] + ".json")
            if os.path.exists(p):
                with open(p, encoding="utf-8") as fh:
                    items = json.load(fh)
                for it in items:
                    text = f"{it['title']}. {it.get('summary', '')}"
                    topics = list(dict.fromkeys(it.get("topics", []) + matcher.match(text))) or [s.get("fallback")]
                    url = norm_url(it["url"])
                    fresh.append({"id": hashlib.sha1(url.encode()).hexdigest()[:12], "src": s["id"], "via": it.get("via"),
                                  "title": it["title"], "summary": shorten(it.get("summary", "")), "url": url,
                                  "img": it.get("img"), "ts": it["ts"], "topics": topics})
                status[s["id"]]["ok"] += 1
    else:
        with cf.ThreadPoolExecutor(max_workers=12) as ex:
            futs = {ex.submit(process_feed, s, f, matcher, now): (s, f) for s, f in jobs}
            for fut in cf.as_completed(futs):
                s, f = futs[fut]
                try:
                    fresh.extend(fut.result())
                    status[s["id"]]["ok"] += 1
                except Exception as e:
                    status[s["id"]]["fail"] += 1
                    status[s["id"]]["errors"].append(f"{f['url']}: {e}"[:200])
                    print(f"[fout] {s['id']} {f['url']}: {e}", file=sys.stderr)

    # samenvoegen: zelfde link uit meerdere feeds van één bron -> onderwerpen samen
    by_id = {}
    for a in load_prev(args.prev):
        if a.get("ts", 0) >= now - KEEP_HOURS * 3600:
            a.pop("cluster", None)
            by_id[a["id"]] = a
    seen_now = set()
    for a in fresh:
        if a["ts"] < now - KEEP_HOURS * 3600:
            continue
        if a["id"] in by_id and a["id"] in seen_now:
            old = by_id[a["id"]]
            old["topics"] = list(dict.fromkeys(old["topics"] + a["topics"]))
            old["img"] = old.get("img") or a.get("img")
            continue
        if a["id"] in by_id:
            a["ts"] = min(a["ts"], by_id[a["id"]]["ts"])
        by_id[a["id"]] = a
        seen_now.add(a["id"])

    articles = sorted(by_id.values(), key=lambda a: -a["ts"])
    n_clusters = cluster(articles)
    for a in articles:
        a.pop("r", None)
    if not args.offline:
        build_reader(articles, {s["id"]: s for s in cfg["sources"]}, os.path.dirname(args.out))

    counts = defaultdict(int)
    for a in articles:
        counts[a["src"]] += 1
    src_out = []
    for s in cfg["sources"]:
        st = status[s["id"]]
        src_out.append({
            "id": s["id"], "name": s["name"], "group": s["group"], "lang": s.get("lang", "nl"),
            "on": s.get("on", False), "paywall": s.get("paywall", False), "note": s.get("note"),
            "aggregator": s.get("aggregator", False),
            "count": counts[s["id"]],
            "state": "ok" if st["fail"] == 0 else ("deels" if st["ok"] else "fout"),
            "errors": st["errors"][:3],
        })

    out = {
        "generated": now,
        "groups": cfg["groups"],
        "topics": [{"id": t["id"], "label": t["label"]} for t in cfg["topics"]],
        "sources": src_out,
        "articles": articles,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    ok = sum(1 for s in src_out if s["state"] == "ok")
    print(f"{len(articles)} artikelen, {n_clusters} verhalen met meerdere bronnen, {ok}/{len(src_out)} bronnen ok")


if __name__ == "__main__":
    main()
