#!/usr/bin/env python3
"""Generate static SEO pages for every city and district.

Usage (from repo root):
  python3 scripts/generate-namaz-pages.py

Outputs:
  namaz-vakitleri/{city}/index.html
  namaz-vakitleri/{city}/{district}/index.html
  sitemap.xml
"""

from __future__ import annotations

import json
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from html import escape
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

ROOT = Path(__file__).resolve().parents[1]
NAMAZ = ROOT / "namaz-vakitleri"
LOCATIONS = NAMAZ / "data" / "locations.json"
API_BASE = "https://ezan-prayer-times.vercel.app/api/timesForLocation"
SITE = "https://muminai.info"
BASE = "/namaz-vakitleri"
ASSET = BASE  # absolute asset paths for all depths
DEFAULT_START = "2026-07-17"
DEFAULT_END = "2026-12-31"
API_WORKERS = 8

PRAYERS = [
    ("imsak", "İmsak"),
    ("gunes", "Güneş"),
    ("ogle", "Öğle"),
    ("ikindi", "İkindi"),
    ("aksam", "Akşam"),
    ("yatsi", "Yatsı"),
]

MONTHS_TR = [
    "Ocak",
    "Şubat",
    "Mart",
    "Nisan",
    "Mayıs",
    "Haziran",
    "Temmuz",
    "Ağustos",
    "Eylül",
    "Ekim",
    "Kasım",
    "Aralık",
]
WEEKDAYS_TR = [
    "Pazar",
    "Pazartesi",
    "Salı",
    "Çarşamba",
    "Perşembe",
    "Cuma",
    "Cumartesi",
]

def turkey_today() -> date:
    return datetime.now(timezone(timedelta(hours=3))).date()


def format_long_tr_fixed(d: date) -> str:
    # Python weekday: Mon=0 … Sun=6; WEEKDAYS_TR is Sun-first
    idx = (d.weekday() + 1) % 7
    return f"{d.day} {MONTHS_TR[d.month - 1]} {d.year} {WEEKDAYS_TR[idx]}"


def city_url(city: str) -> str:
    return f"{BASE}/{city}/"


def district_url(city: str, district: str) -> str:
    if district == city:
        return city_url(city)
    return f"{BASE}/{city}/{district}/"


def fetch_schedule(city: str, district: str, start: str, end: str) -> dict[str, dict]:
    params = urllib.parse.urlencode(
        {
            "city": city,
            "district": district,
            "start-date": start,
            "end-date": end,
        }
    )
    url = f"{API_BASE}?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "muminai-generate/1.0"})
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.load(resp)
            if not isinstance(data, dict):
                return {}
            return data
        except Exception as err:  # noqa: BLE001 — retries for flaky CI network
            last_err = err
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"API failed for {city}/{district}: {last_err}")


def fetch_all_schedules(
    locations: dict, start: str, end: str
) -> dict[tuple[str, str], dict[str, dict]]:
    jobs: list[tuple[str, str]] = []
    for city in locations["cities"]:
        jobs.append((city["slug"], city["slug"]))
        for d in city["districts"]:
            if d["slug"] != city["slug"]:
                jobs.append((city["slug"], d["slug"]))

    schedules: dict[tuple[str, str], dict[str, dict]] = {}
    print(f"Fetching {len(jobs)} schedules from API ({start} → {end})…")

    def work(pair: tuple[str, str]) -> tuple[tuple[str, str], dict[str, dict]]:
        city, district = pair
        try:
            return pair, fetch_schedule(city, district, start, end)
        except Exception:
            if district != city:
                try:
                    return pair, fetch_schedule(city, city, start, end)
                except Exception:
                    return pair, {}
            return pair, {}

    done = 0
    with ThreadPoolExecutor(max_workers=API_WORKERS) as pool:
        futures = [pool.submit(work, job) for job in jobs]
        for fut in as_completed(futures):
            pair, data = fut.result()
            schedules[pair] = data
            done += 1
            if done % 50 == 0 or done == len(jobs):
                print(f"  {done}/{len(jobs)}")

    nonempty = sum(1 for v in schedules.values() if v)
    print(f"Got times for {nonempty}/{len(jobs)} locations")
    return schedules


def resolve_schedule(
    schedules: dict[tuple[str, str], dict[str, dict]], city: str, district: str
) -> dict[str, dict]:
    return schedules.get((city, district)) or schedules.get((city, city)) or {}


def times_cards_html(times: dict | None) -> str:
    if not times:
        return '<div id="today-times" class="times-grid hidden"></div>'
    cards = []
    for key, label in PRAYERS:
        cards.append(
            f'<article class="time-card" data-prayer="{key}">'
            f'<div class="label">{escape(label)}</div>'
            f'<div class="value">{escape(times[key])}</div>'
            f'<div class="hint"></div></article>'
        )
    return f'<div id="today-times" class="times-grid">{"".join(cards)}</div>'


def district_list_html(city: dict, active_slug: str) -> str:
    links = []
    for d in city["districts"]:
        href = district_url(city["slug"], d["slug"])
        label = f'{d["name"]} (Merkez)' if d.get("merkez") else d["name"]
        active = " active" if d["slug"] == active_slug else ""
        aria = ' aria-current="page"' if d["slug"] == active_slug else ""
        links.append(
            f'<a class="district-link{active}" href="{escape(href)}"{aria}>{escape(label)}</a>'
        )
    return "\n          ".join(links)


def page_html(
    *,
    mode: str,
    city: dict,
    district: dict,
    day: date,
    schedule: dict[str, dict],
) -> str:
    city_slug = city["slug"]
    city_name = city["name"]
    district_slug = district["slug"]
    district_name = district["name"]
    is_city = mode == "city"
    day_str = day.isoformat()
    times = schedule.get(day_str) or (schedule[sorted(schedule.keys())[0]] if schedule else None)

    place_title = city_name if is_city else district_name
    h1 = f"{place_title} Namaz Vakitleri"
    if is_city:
        title = f"{city_name} Namaz Vakti – Ezan Saatleri | Mümin AI"
        description = (
            f"{city_name} namaz vakitleri ve ezan saatleri: imsak, güneş, öğle, "
            f"ikindi, akşam ve yatsı. Bugün, haftalık, aylık ve yıllık vakitler."
        )
        sub = (
            f"{city_name} için bugünün namaz vakitleri. "
            f"Haftalık, aylık ve yıllık vakitleri görebilirsiniz."
        )
        canonical = f"{SITE}{city_url(city_slug)}"
        cta_title = "Mümin AI ile yanınızda"
        cta_body = "Kıble yönü, namaz vakitleri ve kaynaklı İslami cevaplar tek uygulamada."
        active_slug = city_slug
        crumb_city = (
            f'<span class="crumb-current" id="crumb-city" aria-current="page">'
            f"{escape(city_name)}</span>"
        )
        crumb_district = ""
    else:
        title = f"{district_name} Namaz Vakti – {city_name} | Mümin AI"
        description = (
            f"{district_name} {city_name} namaz vakti ve ezan saatleri. "
            f"Bugün, haftalık, aylık ve yıllık namaz vakitleri."
        )
        sub = f"{district_name} ({city_name}) için namaz vakitleri."
        canonical = f"{SITE}{district_url(city_slug, district_slug)}"
        cta_title = f"{district_name}, {city_name} için daha fazlası"
        cta_body = (
            "Mümin AI uygulamasında namaz vakitlerini bildirimlerle takip edin, "
            "kıbleyi bulun ve sorunlarınıza kaynaklı cevaplar alın."
        )
        active_slug = district_slug
        crumb_city = (
            f'<a href="{escape(city_url(city_slug))}" class="crumb-link" id="crumb-city">'
            f"{escape(city_name)}</a>"
        )
        crumb_district = (
            f'\n          <span class="sep">/</span>\n'
            f'          <span class="crumb-current" id="crumb-district" aria-current="page">'
            f"{escape(district_name)}</span>"
        )

    date_line = format_long_tr_fixed(day)
    times_html = times_cards_html(times)
    districts_html = district_list_html(city, active_slug)
    prayer_json = json.dumps(schedule, ensure_ascii=False, separators=(",", ":"))

    ld = {
        "@context": "https://schema.org",
        "@type": "WebPage",
        "name": h1,
        "description": description,
        "url": canonical,
        "inLanguage": "tr-TR",
        "about": {
            "@type": "Place",
            "name": f"{district_name}, {city_name}" if not is_city else city_name,
            "addressCountry": "TR",
        },
    }
    ld_tag = f'<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>\n'

    times_meta = ""
    if times:
        times_meta = (
            f" İmsak {times['imsak']}, Güneş {times['gunes']}, Öğle {times['ogle']}, "
            f"İkindi {times['ikindi']}, Akşam {times['aksam']}, Yatsı {times['yatsi']}."
        )

    footer_links = (
        f'<a href="{BASE}/">Tüm iller</a>\n'
        f'          <a href="/index.html">Ana sayfa</a>\n'
        f'          <a href="/{"privacy-policy.html" if is_city else "download.html"}">'
        f'{"Gizlilik" if is_city else "Uygulamayı indir"}</a>'
    )

    return f"""<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{escape(title)}</title>
  <meta name="description" content="{escape(description + times_meta)}" />
  <meta property="og:title" content="{escape(title)}" />
  <meta property="og:description" content="{escape(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="{escape(canonical)}" />
  <link rel="canonical" href="{escape(canonical)}" />
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="stylesheet" href="{ASSET}/css/styles.css" />
  {ld_tag}</head>
<body data-mode="{mode}" data-city="{escape(city_slug)}" data-district="{escape(district_slug)}">
  <main class="page">
    <section class="shell">
      <header class="top-bar">
        <a class="brand" href="/index.html">
          <div class="brand-mark">
            <img src="/icon_transparent.png" alt="Mümin AI" />
          </div>
          <div class="brand-text">
            <span class="brand-name">Mümin AI</span>
            <span class="brand-tag">Namaz Vakitleri</span>
          </div>
        </a>
        <a class="pill pill-strong" href="{BASE}/">Tüm şehirler</a>
      </header>

      <nav class="breadcrumb location-bar" aria-label="Konum">
        <div class="location-bar-row">
          <a href="{BASE}/" class="crumb-home">Namaz vakitleri</a>
          <span class="sep">/</span>
          {crumb_city}{crumb_district}
        </div>
      </nav>

      <div class="hero-block">
        <h1 class="headline" id="page-title">{escape(h1)}</h1>
        <p class="sub" id="page-sub">{escape(sub)}</p>
        <p class="meta-line" id="date-line">{escape(date_line)}</p>
      </div>

      <div class="search-wrap">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
          <path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <input
          id="search-input"
          class="search-input"
          type="search"
          placeholder="Başka bir il veya ilçe ara…"
          autocomplete="off"
          aria-label="İl veya ilçe ara"
        />
        <div id="search-results" class="search-results" role="listbox"></div>
      </div>

      <div id="range-tabs" class="range-tabs" role="tablist">
        <button type="button" class="range-tab active" data-range="day">Bugün</button>
        <button type="button" class="range-tab" data-range="week">Haftalık</button>
        <button type="button" class="range-tab" data-range="month">Aylık</button>
        <button type="button" class="range-tab" data-range="year">Yıllık</button>
      </div>

      <div id="state" class="state hidden" aria-live="polite"></div>
      {times_html}

      <div id="range-panel" class="panel hidden">
        <div class="panel-head">
          <h2 id="range-title">Namaz vakitleri</h2>
        </div>
        <div id="range-body"></div>
      </div>

      <p class="section-label">İlçeler</p>
      <div id="district-list" class="city-grid">
          {districts_html}
      </div>

      <div class="app-cta" style="margin-top: 28px">
        <div>
          <h3 id="seo-place">{escape(cta_title)}</h3>
          <p>{escape(cta_body)}</p>
        </div>
        <div class="cta-buttons">
          <a class="cta-btn" href="https://apps.apple.com/tr/app/m%25C3%25BCmin-ai/id6748532925">App Store</a>
          <a class="cta-btn" href="https://play.google.com/store/apps/details?id=com.anonymous.MuminAI">Google Play</a>
        </div>
      </div>

      <footer class="footer">
        <span>Saat dilimi: Türkiye (GMT+3)</span>
        <div class="footer-links">
          {footer_links}
        </div>
      </footer>
    </section>
  </main>
  <script type="application/json" id="prayer-data">{prayer_json}</script>
  <script src="{ASSET}/js/app.js"></script>
  <script>
    MuminPrayer.injectChrome();
    MuminPrayer.initLocationPage();
  </script>
</body>
</html>
"""


def clean_generated_dirs(locations: dict) -> None:
    """Remove previously generated city folders, keep shared assets."""
    keep = {"css", "js", "data", "index.html", "sehir.html", "ilce.html"}
    for child in NAMAZ.iterdir():
        if child.name in keep:
            continue
        if child.is_dir():
            shutil.rmtree(child)


def write_sitemap(urls: list[str]) -> None:
    static = [
        f"{SITE}/",
        f"{SITE}/index.html",
        f"{SITE}/download.html",
        f"{SITE}/privacy-policy.html",
        f"{SITE}/user-agreement.html",
        f"{SITE}/support.html",
        f"{SITE}{BASE}/",
    ]
    all_urls = static + urls
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for u in all_urls:
        lines.append("  <url>")
        lines.append(f"    <loc>{xml_escape(u)}</loc>")
        lines.append("  </url>")
    lines.append("</urlset>")
    (ROOT / "sitemap.xml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"sitemap.xml → {len(all_urls)} URLs")


def write_redirect_templates() -> None:
    """Keep old query-param URLs working via JS redirect."""
    sehir = """<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <title>Yönlendiriliyor…</title>
  <script>
    const city = new URLSearchParams(location.search).get("city");
    location.replace(city ? `/namaz-vakitleri/${encodeURIComponent(city)}/` : "/namaz-vakitleri/");
  </script>
</head>
<body><p><a href="/namaz-vakitleri/">Namaz vakitleri</a></p></body>
</html>
"""
    ilce = """<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <title>Yönlendiriliyor…</title>
  <script>
    const q = new URLSearchParams(location.search);
    const city = q.get("city");
    const district = q.get("district");
    if (city && district && city !== district) {
      location.replace(`/namaz-vakitleri/${encodeURIComponent(city)}/${encodeURIComponent(district)}/`);
    } else if (city) {
      location.replace(`/namaz-vakitleri/${encodeURIComponent(city)}/`);
    } else {
      location.replace("/namaz-vakitleri/");
    }
  </script>
</head>
<body><p><a href="/namaz-vakitleri/">Namaz vakitleri</a></p></body>
</html>
"""
    (NAMAZ / "sehir.html").write_text(sehir, encoding="utf-8")
    (NAMAZ / "ilce.html").write_text(ilce, encoding="utf-8")


def main() -> None:
    locations = json.loads(LOCATIONS.read_text(encoding="utf-8"))
    start = locations.get("dataStart") or DEFAULT_START
    end = locations.get("dataEnd") or DEFAULT_END

    day = turkey_today()
    day_str = day.isoformat()
    if day_str < start:
        day = date.fromisoformat(start)
    elif day_str > end:
        day = date.fromisoformat(end)

    schedules = fetch_all_schedules(locations, start, end)

    clean_generated_dirs(locations)

    urls: list[str] = []
    city_count = 0
    district_count = 0

    for city in locations["cities"]:
        city_dir = NAMAZ / city["slug"]
        city_dir.mkdir(parents=True, exist_ok=True)

        merkez = next(
            (d for d in city["districts"] if d.get("merkez") or d["slug"] == city["slug"]),
            None,
        )
        if not merkez:
            merkez = {"slug": city["slug"], "name": city["name"], "merkez": True}

        schedule = resolve_schedule(schedules, city["slug"], city["slug"])
        html = page_html(
            mode="city", city=city, district=merkez, day=day, schedule=schedule
        )
        (city_dir / "index.html").write_text(html, encoding="utf-8")
        urls.append(f"{SITE}{city_url(city['slug'])}")
        city_count += 1

        for d in city["districts"]:
            if d["slug"] == city["slug"]:
                continue
            dist_dir = city_dir / d["slug"]
            dist_dir.mkdir(parents=True, exist_ok=True)
            schedule = resolve_schedule(schedules, city["slug"], d["slug"])
            html = page_html(
                mode="district", city=city, district=d, day=day, schedule=schedule
            )
            (dist_dir / "index.html").write_text(html, encoding="utf-8")
            urls.append(f"{SITE}{district_url(city['slug'], d['slug'])}")
            district_count += 1

    write_sitemap(urls)
    write_redirect_templates()
    print(f"Generated {city_count} city pages + {district_count} district pages")
    print(f"Open hub at {SITE}{BASE}/")


if __name__ == "__main__":
    main()
