const API_BASE = "https://ezan-prayer-times.vercel.app/api/timesForLocation";
const DATA_START = "2026-07-17";
const DATA_END = "2026-12-31";
const BASE = "/namaz-vakitleri";

const PRAYER_KEYS = [
  { key: "imsak", label: "İmsak" },
  { key: "gunes", label: "Güneş" },
  { key: "ogle", label: "Öğle" },
  { key: "ikindi", label: "İkindi" },
  { key: "aksam", label: "Akşam" },
  { key: "yatsi", label: "Yatsı" },
];

const MONTHS_TR = [
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
];

const WEEKDAYS_TR = [
  "Pazar",
  "Pazartesi",
  "Salı",
  "Çarşamba",
  "Perşembe",
  "Cuma",
  "Cumartesi",
];

const STORE = {
  ios: "https://apps.apple.com/tr/app/m%25C3%25BCmin-ai/id6748532925",
  android: "https://play.google.com/store/apps/details?id=com.anonymous.MuminAI",
};

/** @type {{ cities: Array<{slug:string,name:string,districts:Array<{slug:string,name:string,merkez:boolean}>}> } | null} */
let locationsCache = null;

function pad(n) {
  return String(n).padStart(2, "0");
}

function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Turkey local calendar date (GMT+3) */
function turkeyToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function turkeyNowMinutes() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get("hour") * 60 + get("minute");
}

function parseISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

function clampDate(iso) {
  if (iso < DATA_START) return DATA_START;
  if (iso > DATA_END) return DATA_END;
  return iso;
}

function formatLongTR(iso) {
  const d = parseISO(iso);
  return `${d.getDate()} ${MONTHS_TR[d.getMonth()]} ${d.getFullYear()} ${WEEKDAYS_TR[d.getDay()]}`;
}

function formatShortTR(iso) {
  const d = parseISO(iso);
  return `${d.getDate()} ${MONTHS_TR[d.getMonth()]}`;
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function normalizeQuery(s) {
  return s
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .trim();
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

async function loadLocations() {
  if (locationsCache) return locationsCache;
  const res = await fetch(`${BASE}/data/locations.json`);
  if (!res.ok) throw new Error("Konum listesi yüklenemedi");
  locationsCache = await res.json();
  return locationsCache;
}

function findCity(slug) {
  if (!locationsCache) return null;
  return locationsCache.cities.find((c) => c.slug === slug) || null;
}

function findDistrict(citySlug, districtSlug) {
  const city = findCity(citySlug);
  if (!city) return null;
  return city.districts.find((d) => d.slug === districtSlug) || null;
}

async function fetchTimes(city, district, startDate, endDate) {
  const url = new URL(API_BASE);
  url.searchParams.set("city", city);
  url.searchParams.set("district", district);
  url.searchParams.set("start-date", startDate);
  url.searchParams.set("end-date", endDate);

  const res = await fetch(url.toString());
  if (res.status === 404) {
    throw new Error("Bu tarih aralığı için namaz vakti bulunamadı.");
  }
  if (res.status === 400) {
    throw new Error("Geçersiz tarih aralığı.");
  }
  if (!res.ok) {
    throw new Error("Namaz vakitleri alınamadı. Lütfen tekrar deneyin.");
  }
  return res.json();
}

function loadEmbeddedTimes() {
  const el = document.getElementById("prayer-data");
  if (!el) return null;
  try {
    const data = JSON.parse(el.textContent || "");
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function sliceSchedule(schedule, startDate, endDate) {
  const out = {};
  for (const [day, times] of Object.entries(schedule)) {
    if (day >= startDate && day <= endDate) out[day] = times;
  }
  return out;
}

async function resolveTimes(city, district, startDate, endDate, embedded) {
  if (embedded) {
    const sliced = sliceSchedule(embedded, startDate, endDate);
    const days = Object.keys(sliced);
    if (days.length) return sliced;
  }
  return fetchTimes(city, district, startDate, endDate);
}

function rangeForView(view, anchorISO) {
  const today = clampDate(anchorISO);
  if (view === "day") {
    return { start: today, end: today };
  }
  if (view === "week") {
    return { start: today, end: clampDate(addDays(today, 6)) };
  }
  if (view === "month") {
    return { start: today, end: clampDate(addDays(today, 29)) };
  }
  // year / remaining year in DB
  return { start: today, end: DATA_END };
}

function nextPrayerKey(dayTimes) {
  if (!dayTimes) return null;
  const now = turkeyNowMinutes();
  for (const { key } of PRAYER_KEYS) {
    if (timeToMinutes(dayTimes[key]) > now) return key;
  }
  return null;
}

function renderTodayCards(container, dayTimes, dateISO) {
  const nextKey = dateISO === turkeyToday() ? nextPrayerKey(dayTimes) : null;
  container.innerHTML = PRAYER_KEYS.map(({ key, label }) => {
    const isNext = key === nextKey;
    return `
      <article class="time-card${isNext ? " next" : ""}" data-prayer="${key}">
        <div class="label">${label}</div>
        <div class="value">${dayTimes[key]}</div>
        <div class="hint">${isNext ? "Sıradaki vakit" : ""}</div>
      </article>
    `;
  }).join("");
}

function renderTable(container, data, highlightISO) {
  const dates = Object.keys(data).sort();
  const head = `
    <tr>
      <th>Tarih</th>
      ${PRAYER_KEYS.map((p) => `<th>${p.label}</th>`).join("")}
    </tr>
  `;
  const body = dates
    .map((date) => {
      const row = data[date];
      const isToday = date === highlightISO;
      return `
        <tr class="${isToday ? "today" : ""}">
          <td>${formatShortTR(date)}${isToday ? " · Bugün" : ""}</td>
          ${PRAYER_KEYS.map((p) => `<td>${row[p.key]}</td>`).join("")}
        </tr>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="table-wrap">
      <table class="times-table">
        <thead>${head}</thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function setMeta({ title, description }) {
  document.title = title;
  let desc = document.querySelector('meta[name="description"]');
  if (!desc) {
    desc = document.createElement("meta");
    desc.setAttribute("name", "description");
    document.head.appendChild(desc);
  }
  desc.setAttribute("content", description);

  let ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) ogTitle.setAttribute("content", title);
  let ogDesc = document.querySelector('meta[property="og:description"]');
  if (ogDesc) ogDesc.setAttribute("content", description);
}

function showState(el, { loading, error, message }) {
  if (!el) return;
  if (loading) {
    el.className = "state";
    el.innerHTML = `<div class="spinner"></div>${message || "Yükleniyor…"}`;
    el.classList.remove("hidden");
    return;
  }
  if (error) {
    el.className = "state error";
    el.textContent = message || "Bir hata oluştu.";
    el.classList.remove("hidden");
    return;
  }
  el.classList.add("hidden");
  el.innerHTML = "";
}

function setupSearch(input, resultsEl) {
  if (!input || !resultsEl) return;

  let items = [];

  loadLocations()
    .then((data) => {
      items = [];
      for (const city of data.cities) {
        items.push({
          type: "city",
          city: city.slug,
          district: city.slug,
          label: city.name,
          sub: "İl namaz vakitleri",
          href: cityHref(city.slug),
          search: normalizeQuery(city.name + " " + city.slug),
        });
        for (const d of city.districts) {
          if (d.slug === city.slug) continue;
          items.push({
            type: "district",
            city: city.slug,
            district: d.slug,
            label: d.name,
            sub: city.name,
            href: districtHref(city.slug, d.slug),
            search: normalizeQuery(`${d.name} ${city.name} ${d.slug} ${city.slug}`),
          });
        }
      }
    })
    .catch(() => {});

  const render = (q) => {
    const nq = normalizeQuery(q);
    if (!nq || nq.length < 2) {
      resultsEl.classList.remove("open");
      resultsEl.innerHTML = "";
      return;
    }
    const matches = items
      .filter((it) => it.search.includes(nq))
      .slice(0, 12);
    if (!matches.length) {
      resultsEl.innerHTML = `<div class="search-item"><strong>Sonuç bulunamadı</strong></div>`;
      resultsEl.classList.add("open");
      return;
    }
    resultsEl.innerHTML = matches
      .map(
        (it) => `
      <a class="search-item" href="${it.href}">
        <strong>${it.label}</strong>
        <div class="muted">${it.sub}</div>
      </a>`
      )
      .join("");
    resultsEl.classList.add("open");
  };

  input.addEventListener("input", () => render(input.value));
  input.addEventListener("focus", () => render(input.value));
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) {
      resultsEl.classList.remove("open");
    }
  });
}

function bindRangeTabs(tabsEl, onChange) {
  if (!tabsEl) return;
  tabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-range]");
    if (!btn) return;
    tabsEl.querySelectorAll(".range-tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    onChange(btn.dataset.range);
  });
}

const CHEVRON_SVG = `<svg class="place-pick-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function cityHref(citySlug) {
  return `${BASE}/${encodeURIComponent(citySlug)}/`;
}

function districtHref(citySlug, districtSlug) {
  if (districtSlug === citySlug) return cityHref(citySlug);
  return `${BASE}/${encodeURIComponent(citySlug)}/${encodeURIComponent(districtSlug)}/`;
}

function setupPlacePicker({ mode, citySlug, districtSlug, cityMeta }) {
  const picker = document.getElementById("place-picker");
  const listEl = document.getElementById("place-picker-list");
  const searchEl = document.getElementById("place-picker-search");
  const closeBtn = document.getElementById("place-picker-close");
  if (!picker || !listEl || !locationsCache) return;

  let activeType = null;
  let openTriggers = [];

  function closePicker() {
    picker.classList.remove("open");
    openTriggers.forEach((el) => el?.setAttribute("aria-expanded", "false"));
    openTriggers = [];
    activeType = null;
    if (searchEl) searchEl.value = "";
  }

  function renderList(filter = "") {
    const q = normalizeQuery(filter);
    let items = [];

    if (activeType === "city") {
      items = locationsCache.cities.map((c) => ({
        label: c.name,
        href: cityHref(c.slug),
        active: c.slug === citySlug,
        search: normalizeQuery(`${c.name} ${c.slug}`),
      }));
    } else if (activeType === "district" && cityMeta) {
      items = cityMeta.districts.map((d) => ({
        label: d.merkez ? `${d.name} (Merkez)` : d.name,
        href: districtHref(citySlug, d.slug),
        active: d.slug === (mode === "city" ? citySlug : districtSlug),
        search: normalizeQuery(`${d.name} ${d.slug}`),
      }));
    }

    if (q) items = items.filter((it) => it.search.includes(q));

    if (!items.length) {
      listEl.innerHTML = `<div class="place-picker-empty">Sonuç bulunamadı</div>`;
      return;
    }

    listEl.innerHTML = items
      .map(
        (it) => `
      <button type="button" class="place-picker-item${it.active ? " active" : ""}" data-href="${it.href}">
        ${it.label}
      </button>`
      )
      .join("");
  }

  function openPicker(type, trigger) {
    if (activeType === type && picker.classList.contains("open")) {
      closePicker();
      return;
    }
    activeType = type;
    openTriggers.forEach((el) => el?.setAttribute("aria-expanded", "false"));
    openTriggers = [trigger];
    trigger?.setAttribute("aria-expanded", "true");
    picker.classList.add("open");
    renderList("");
    if (searchEl) {
      searchEl.placeholder = type === "city" ? "Şehir ara…" : "İlçe ara…";
      searchEl.focus();
    }
  }

  document.querySelectorAll("[data-pick]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPicker(el.dataset.pick, el);
    });
  });

  searchEl?.addEventListener("input", () => renderList(searchEl.value));
  closeBtn?.addEventListener("click", closePicker);

  listEl.addEventListener("click", (e) => {
    const item = e.target.closest("[data-href]");
    if (!item) return;
    window.location.href = item.dataset.href;
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".location-bar") && !e.target.closest("[data-pick]")) {
      closePicker();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePicker();
  });
}

async function initLocationPage(options = {}) {
  const stateEl = document.getElementById("state");
  const todayEl = document.getElementById("today-times");
  const tablePanel = document.getElementById("range-panel");
  const tableBody = document.getElementById("range-body");
  const tabsEl = document.getElementById("range-tabs");
  const dateLine = document.getElementById("date-line");
  const titleEl = document.getElementById("page-title");
  const subEl = document.getElementById("page-sub");
  const districtList = document.getElementById("district-list");

  const body = document.body;
  const mode = options.mode || body.dataset.mode || "city";
  const citySlug = (
    options.city ||
    body.dataset.city ||
    qs("city") ||
    ""
  )
    .toLowerCase()
    .trim();
  let districtSlug = (
    options.district ||
    body.dataset.district ||
    qs("district") ||
    ""
  )
    .toLowerCase()
    .trim();

  if (!citySlug) {
    showState(stateEl, { error: true, message: "Şehir belirtilmedi. Ana sayfadan bir konum seçin." });
    return;
  }

  if (mode === "city") {
    districtSlug = citySlug;
  } else if (!districtSlug) {
    showState(stateEl, { error: true, message: "İlçe belirtilmedi." });
    return;
  }

  showState(stateEl, { loading: true, message: "Namaz vakitleri yükleniyor…" });

  let cityMeta = null;
  let districtMeta = null;
  try {
    await loadLocations();
    cityMeta = findCity(citySlug);
    districtMeta =
      mode === "city"
        ? { slug: citySlug, name: cityMeta?.name || citySlug }
        : findDistrict(citySlug, districtSlug) || {
            slug: districtSlug,
            name: districtSlug.charAt(0).toUpperCase() + districtSlug.slice(1),
          };
  } catch (_) {
    cityMeta = { slug: citySlug, name: citySlug };
    districtMeta = { slug: districtSlug, name: districtSlug };
  }

  const displayCity = cityMeta?.name || citySlug;
  const displayDistrict = districtMeta?.name || districtSlug;
  const placeLabel = mode === "city" ? displayCity : `${displayDistrict}, ${displayCity}`;

  if (titleEl) {
    titleEl.textContent =
      mode === "city"
        ? `${displayCity} Namaz Vakitleri`
        : `${displayDistrict} Namaz Vakitleri`;
  }
  if (subEl) {
    subEl.textContent =
      mode === "city"
        ? `${displayCity} için bugünün namaz vakitleri. Haftalık, aylık ve yıllık vakitleri görebilirsiniz.`
        : `${displayDistrict} (${displayCity}) için namaz vakitleri.`;
  }

  const crumbCity = document.getElementById("crumb-city");
  const crumbDistrict = document.getElementById("crumb-district");
  if (crumbCity) {
    crumbCity.innerHTML = `<span>${displayCity}</span>${CHEVRON_SVG}`;
  }
  if (crumbDistrict) {
    const districtLabel =
      mode === "district" ? displayDistrict : "İlçe seç";
    crumbDistrict.innerHTML = `<span>${districtLabel}</span>${CHEVRON_SVG}`;
  }

  setupPlacePicker({ mode, citySlug, districtSlug, cityMeta });

  const dateParam = (qs("date") || "").trim();
  const anchorDay = clampDate(
    /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : turkeyToday()
  );
  const calendarToday = turkeyToday();
  const dateInTitle =
    dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? `${formatShortTR(anchorDay)} `
      : "";

  setMeta({
    title:
      mode === "city"
        ? `${dateInTitle}${displayCity} Namaz Vakti – Ezan Saatleri | Mümin AI`
        : `${dateInTitle}${displayDistrict} Namaz Vakti – ${displayCity} | Mümin AI`,
    description:
      mode === "city"
        ? `${displayCity} namaz vakitleri, ezan saatleri: imsak, güneş, öğle, ikindi, akşam ve yatsı.`
        : `${displayDistrict} ${displayCity} namaz vakti ve ezan saatleri. Günlük, haftalık, aylık ve yıllık vakitler.`,
  });

  if (districtList && cityMeta) {
    const activeSlug = mode === "city" ? citySlug : districtSlug;
    districtList.innerHTML = cityMeta.districts
      .map((d) => {
        const href = districtHref(citySlug, d.slug);
        const label = d.merkez ? `${d.name} (Merkez)` : d.name;
        const isActive = d.slug === activeSlug;
        return `<a class="district-link${isActive ? " active" : ""}" href="${href}"${isActive ? ' aria-current="page"' : ""}>${label}</a>`;
      })
      .join("");
  }

  let currentView = "day";
  let cache = {};
  const embedded = loadEmbeddedTimes();

  async function loadView(view) {
    currentView = view;
    const { start, end } = rangeForView(view, anchorDay);
    const cacheKey = `${start}_${end}`;

    showState(stateEl, { loading: true, message: "Vakitler yükleniyor…" });
    todayEl?.classList.add("hidden");
    tablePanel?.classList.add("hidden");

    try {
      if (!cache[cacheKey]) {
        cache[cacheKey] = await resolveTimes(
          citySlug,
          districtSlug,
          start,
          end,
          embedded
        );
      }
      const data = cache[cacheKey];
      const day = data[anchorDay] || data[start];

      showState(stateEl, {});

      if (dateLine) {
        dateLine.textContent =
          view === "day"
            ? formatLongTR(anchorDay)
            : view === "week"
              ? `${formatShortTR(start)} – ${formatShortTR(end)} (7 gün)`
              : view === "month"
                ? `${formatShortTR(start)} – ${formatShortTR(end)} (30 gün)`
                : `${formatShortTR(start)} – ${formatShortTR(end)}`;
      }

      if (view === "day" && day && todayEl) {
        renderTodayCards(todayEl, day, calendarToday);
        todayEl.classList.remove("hidden");
        tablePanel?.classList.add("hidden");
      } else if (tableBody && tablePanel) {
        renderTable(tableBody, data, calendarToday);
        todayEl?.classList.add("hidden");
        tablePanel.classList.remove("hidden");
        const panelTitle = document.getElementById("range-title");
        if (panelTitle) {
          panelTitle.textContent =
            view === "week"
              ? "Haftalık namaz vakitleri"
              : view === "month"
                ? "Aylık namaz vakitleri"
                : "Yıl sonuna kadar namaz vakitleri";
        }
      }
    } catch (err) {
      showState(stateEl, {
        error: true,
        message: err.message || "Vakitler yüklenemedi.",
      });
    }
  }

  bindRangeTabs(tabsEl, loadView);
  await loadView("day");

  const seoPlace = document.getElementById("seo-place");
  if (seoPlace) seoPlace.textContent = placeLabel;
}

async function initHub() {
  const grid = document.getElementById("city-grid");
  const stateEl = document.getElementById("state");
  showState(stateEl, { loading: true, message: "Şehirler yükleniyor…" });

  try {
    const data = await loadLocations();
    showState(stateEl, {});
    if (grid) {
      grid.innerHTML = data.cities
        .map(
          (c) =>
            `<a class="city-link" href="${cityHref(c.slug)}">${c.name}</a>`
        )
        .join("");
    }
  } catch (err) {
    showState(stateEl, { error: true, message: err.message });
  }

  setupSearch(
    document.getElementById("search-input"),
    document.getElementById("search-results")
  );

  setMeta({
    title: "Namaz Vakitleri – Türkiye Ezan Saatleri | Mümin AI",
    description:
      "Türkiye'nin tüm illeri ve ilçeleri için namaz vakitleri. Şehrinizi veya ilçenizi arayın, bugünün ezan saatlerini görün.",
  });
}

function injectChrome() {
  setupSearch(
    document.getElementById("search-input"),
    document.getElementById("search-results")
  );
}

window.MuminPrayer = {
  initHub,
  initLocationPage,
  injectChrome,
  STORE,
  turkeyToday,
  formatLongTR,
};
