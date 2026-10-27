const state = {
  view: "feed", // 'feed' | 'notebook' | 'discover'
  feedId: null,
  filter: null, // 'unread' | 'saved' | null
  query: "",
  cursor: null,
  maxId: null, // newest article id when the current list was loaded; bounds "mark all read"
  articles: [],
  feeds: [],
  selectedId: null,
  loading: false,
};

let currentArticle = null; // the article currently open in the reader, as returned by the API
let readerScrollHandler = null;
let progressSaveTimer = null;
let pendingProgress = null; // { id, value }
let listRequestToken = 0;
let selectRequestToken = 0;

function flushProgress() {
  clearTimeout(progressSaveTimer);
  if (!pendingProgress) return;
  const { id, value } = pendingProgress;
  pendingProgress = null;
  api(`/api/articles/${id}/progress`, { method: "PATCH", body: JSON.stringify({ progress: value }) })
    .then(loadContinueReading)
    .catch(() => {});
}

function scheduleProgressSave(id, value) {
  pendingProgress = { id, value };
  clearTimeout(progressSaveTimer);
  progressSaveTimer = setTimeout(flushProgress, 1000);
}

const els = {
  feedList: document.getElementById("feedList"),
  unreadTotal: document.getElementById("unreadTotal"),
  continueReadingSection: document.getElementById("continueReadingSection"),
  streakCard: document.getElementById("streakCard"),
  streakCount: document.getElementById("streakCount"),
  streakToday: document.getElementById("streakToday"),
  streakDots: document.getElementById("streakDots"),
  continueReadingList: document.getElementById("continueReadingList"),
  addFeedForm: document.getElementById("addFeedForm"),
  feedUrlInput: document.getElementById("feedUrlInput"),
  addFeedError: document.getElementById("addFeedError"),
  articleListPane: document.getElementById("articleListPane"),
  listTitle: document.getElementById("listTitle"),
  listMeta: document.getElementById("listMeta"),
  listActions: document.getElementById("listActions"),
  searchInput: document.getElementById("searchInput"),
  markAllReadBtn: document.getElementById("markAllReadBtn"),
  articleList: document.getElementById("articleList"),
  newArticlesBtn: document.getElementById("newArticlesBtn"),
  loadMoreBtn: document.getElementById("loadMoreBtn"),
  emptyState: document.getElementById("emptyState"),
  filteredEmptyState: document.getElementById("filteredEmptyState"),
  filteredEmptyTitle: document.getElementById("filteredEmptyTitle"),
  filteredEmptyBody: document.getElementById("filteredEmptyBody"),
  refreshAllBtn: document.getElementById("refreshAllBtn"),
  readerPane: document.getElementById("readerPane"),
  readerEmpty: document.getElementById("readerEmpty"),
  reader: document.getElementById("reader"),
  readerTitle: document.getElementById("readerTitle"),
  readerMeta: document.getElementById("readerMeta"),
  readerProgressFill: document.getElementById("readerProgressFill"),
  readerSourceLink: document.getElementById("readerSourceLink"),
  readerBody: document.getElementById("readerBody"),
  saveBtn: document.getElementById("saveBtn"),
  readToggleBtn: document.getElementById("readToggleBtn"),
  myListNavBtn: document.getElementById("myListNavBtn"),
  discoverNavBtn: document.getElementById("discoverNavBtn"),
  topicsBar: document.getElementById("topicsBar"),
  topicAddForm: document.getElementById("topicAddForm"),
  topicAddInput: document.getElementById("topicAddInput"),
  topicChips: document.getElementById("topicChips"),
  discoverEmptyState: document.getElementById("discoverEmptyState"),
  sourceSuggestions: document.getElementById("sourceSuggestions"),
  notebookPane: document.getElementById("notebookPane"),
  notebookAddForm: document.getElementById("notebookAddForm"),
  notebookAddInput: document.getElementById("notebookAddInput"),
  notebookList: document.getElementById("notebookList"),
  notebookEmpty: document.getElementById("notebookEmpty"),
  copyAllBtn: document.getElementById("copyAllBtn"),
  downloadMdBtn: document.getElementById("downloadMdBtn"),
  clearListBtn: document.getElementById("clearListBtn"),
  prompterOpenBtn: document.getElementById("prompterOpenBtn"),
  prompter: document.getElementById("prompter"),
  prompterScroll: document.getElementById("prompterScroll"),
  prompterText: document.getElementById("prompterText"),
  prompterCountdown: document.getElementById("prompterCountdown"),
  prompterPlayBtn: document.getElementById("prompterPlayBtn"),
  prompterSlowerBtn: document.getElementById("prompterSlowerBtn"),
  prompterFasterBtn: document.getElementById("prompterFasterBtn"),
  prompterSpeed: document.getElementById("prompterSpeed"),
  prompterSmallerBtn: document.getElementById("prompterSmallerBtn"),
  prompterLargerBtn: document.getElementById("prompterLargerBtn"),
  prompterMirrorBtn: document.getElementById("prompterMirrorBtn"),
  prompterRestartBtn: document.getElementById("prompterRestartBtn"),
  prompterCloseBtn: document.getElementById("prompterCloseBtn"),
  notebookStats: document.getElementById("notebookStats"),
  scriptSelect: document.getElementById("scriptSelect"),
  newScriptBtn: document.getElementById("newScriptBtn"),
  scriptMenuBtn: document.getElementById("scriptMenuBtn"),
  scriptMenu: document.getElementById("scriptMenu"),
  mobileMenuBtn: document.getElementById("mobileMenuBtn"),
  mobileBackBtn: document.getElementById("mobileBackBtn"),
  mobileBackdrop: document.getElementById("mobileBackdrop"),
  mobileTitle: document.getElementById("mobileTitle"),
  sidebar: document.querySelector(".sidebar"),
  toast: document.getElementById("toast"),
  offlineBanner: document.getElementById("offlineBanner"),
  schemaBanner: document.getElementById("schemaBanner"),
  schemaBannerCommands: document.getElementById("schemaBannerCommands"),
  schemaBannerCopyBtn: document.getElementById("schemaBannerCopyBtn"),
  schemaBannerCloseBtn: document.getElementById("schemaBannerCloseBtn"),
  shortcutsDialog: document.getElementById("shortcutsDialog"),
  shortcutsHintBtn: document.getElementById("shortcutsHintBtn"),
  shortcutsCloseBtn: document.getElementById("shortcutsCloseBtn"),
  readerPrefsBtn: document.getElementById("readerPrefsBtn"),
  importOpmlBtn: document.getElementById("importOpmlBtn"),
  opmlFileInput: document.getElementById("opmlFileInput"),
  readerPrefs: document.getElementById("readerPrefs"),
  textSmallerBtn: document.getElementById("textSmallerBtn"),
  textLargerBtn: document.getElementById("textLargerBtn"),
  textSizeValue: document.getElementById("textSizeValue"),
};

const AVATAR_COLORS = ["#a8542e", "#4a6d5c", "#7a5ca8", "#2e6b8a", "#a8792e", "#8a3f5c", "#3f7a4a"];

function avatarColor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function avatarInitial(title) {
  return (title || "?").trim().charAt(0).toUpperCase();
}

async function api(path, options) {
  let res;
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch {
    setOffline(true);
    throw new Error("You're offline. This needs a connection.");
  }
  // The service worker marks responses it answered from the offline cache.
  setOffline(res.headers.get("x-offline-cache") === "1");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatRelative(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffHrs = diffMs / 3_600_000;
  if (diffHrs < 1) return "just now";
  if (diffHrs < 24) return `${Math.floor(diffHrs)}h ago`;
  const diffDays = diffHrs / 24;
  if (diffDays < 7) return `${Math.floor(diffDays)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function estimateReadingTime(html) {
  const text = (html || "").replace(/<[^>]+>/g, " ");
  const words = text.split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 200));
  return `${minutes} min read`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// --- Toasts (non-blocking feedback in place of alert()) ---

let toastTimer = null;

// durationMs of 0 keeps the toast up until the next one replaces it (for progress messages).
// action: optional { label, run } rendered as a button, e.g. Undo.
function toast(message, kind = "info", durationMs = kind === "error" ? 5000 : 2600, action = null) {
  els.toast.textContent = message;
  els.toast.classList.toggle("error", kind === "error");
  if (action) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      clearTimeout(toastTimer);
      els.toast.hidden = true;
      action.run();
    });
    els.toast.append(btn);
  }
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  if (durationMs > 0) {
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, durationMs);
  }
}

const UNDO_TOAST_MS = 7000;

// --- Sidebar (built-in filters + feeds) ---

function renderStaticFilters() {
  const items = document.querySelectorAll(".sidebar > .feed-list:first-of-type .feed-item");
  items[0].onclick = () => setFilter(null, null);
  items[1].onclick = () => setFilter(null, "unread");
  items[2].onclick = () => setFilter(null, "saved");
  els.myListNavBtn.onclick = openNotebook;
  els.discoverNavBtn.onclick = openDiscover;
  updateStaticFilterActive();
}

function openNotebook() {
  flushProgress();
  setView("notebook");
  enterMobileScreen("notebook", "My List");
}

function openDiscover() {
  flushProgress();
  setView("discover");
  loadArticles(true);
  enterMobileScreen("list", "Discover");
}

function updateStaticFilterActive() {
  const items = document.querySelectorAll(".sidebar > .feed-list:first-of-type .feed-item");
  const inFeed = state.view === "feed";
  const setActive = (el, active) => {
    el.classList.toggle("active", active);
    if (active) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  };
  setActive(items[0], inFeed && state.feedId === null && state.filter === null);
  setActive(items[1], inFeed && state.feedId === null && state.filter === "unread");
  setActive(items[2], inFeed && state.feedId === null && state.filter === "saved");
  setActive(els.myListNavBtn, state.view === "notebook");
  setActive(els.discoverNavBtn, state.view === "discover");
  els.feedList.querySelectorAll(".feed-row").forEach((row) => {
    setActive(row.querySelector(".feed-item"), inFeed && Number(row.dataset.feedId) === state.feedId);
  });
}

// --- View switching (feed vs. notebook) + mobile single-pane navigation ---

function setView(view) {
  state.view = view;
  const inFeedLike = view === "feed" || view === "discover";
  els.articleListPane.hidden = !inFeedLike;
  els.readerPane.hidden = !inFeedLike;
  els.notebookPane.hidden = view !== "notebook";
  els.topicsBar.hidden = view !== "discover";
  if (view === "notebook") loadHighlights().catch((err) => toast(err.message, "error"));
  if (view === "discover") loadTopics().catch((err) => toast(err.message, "error"));
  updateStaticFilterActive();
  updateListHeader();
}

function enterMobileScreen(screen, title) {
  document.body.classList.remove("mobile-list", "mobile-reader", "mobile-notebook");
  document.body.classList.add(`mobile-${screen}`);
  els.mobileBackBtn.hidden = screen === "list";
  els.mobileTitle.textContent = title;
  closeMobileSidebar();
}

function openMobileSidebar() {
  els.sidebar.classList.add("mobile-open");
  els.mobileBackdrop.hidden = false;
  els.mobileBackdrop.classList.add("show");
}

function closeMobileSidebar() {
  els.sidebar.classList.remove("mobile-open");
  els.mobileBackdrop.classList.remove("show");
  setTimeout(() => {
    els.mobileBackdrop.hidden = true;
  }, 220);
}

els.mobileMenuBtn.addEventListener("click", openMobileSidebar);
els.mobileBackdrop.addEventListener("click", closeMobileSidebar);
els.mobileBackBtn.addEventListener("click", () => {
  if (state.view === "notebook") {
    setFilter(null, null);
  } else {
    enterMobileScreen("list", listTitleText());
  }
});

async function loadFeeds() {
  state.feeds = await api("/api/feeds");
  renderFeeds();
}

let renamingFeedId = null;

function renderFeeds() {
  // Re-rendering would wipe out a rename in progress; the rename re-renders when it finishes.
  if (renamingFeedId !== null) return;
  els.feedList.innerHTML = "";
  for (const feed of state.feeds) {
    const row = document.createElement("div");
    row.className = "feed-row";
    row.dataset.feedId = feed.id;
    const failing = feed.last_status && feed.last_status !== "ok";
    const errorDetail = failing ? feed.last_status.replace(/^error:\s*/, "") : "";
    row.innerHTML = `
      <button class="feed-item">
        <span class="feed-avatar" style="background:${avatarColor(feed.title)}">${escapeHtml(avatarInitial(feed.title))}</span>
        <span class="feed-label">${escapeHtml(feed.title)}</span>
        ${failing ? `<span class="feed-error" title="Last refresh failed: ${escapeHtml(errorDetail)}">!</span>` : ""}
        ${feed.unread_count > 0 ? `<span class="nav-count">${feed.unread_count}</span>` : ""}
      </button>
      <button class="rename-feed" title="Rename" aria-label="Rename ${escapeHtml(feed.title)}">✎</button>
      <button class="remove-feed" title="Unsubscribe" aria-label="Unsubscribe from ${escapeHtml(feed.title)}">✕</button>
    `;
    row.querySelector(".feed-item").onclick = () => setFilter(feed.id, null);
    row.querySelector(".rename-feed").onclick = () => startRenameFeed(row, feed);
    row.querySelector(".remove-feed").onclick = async () => {
      if (!confirm(`Remove "${feed.title}" and its articles?`)) return;
      try {
        await api(`/api/feeds/${feed.id}`, { method: "DELETE" });
      } catch (err) {
        toast(err.message, "error");
        return;
      }
      toast(`Unsubscribed from ${feed.title}`);
      await loadFeeds();
      if (state.feedId === feed.id) setFilter(null, null);
      else if (state.view !== "notebook") loadArticles(true);
    };
    els.feedList.appendChild(row);
  }
  const unread = totalUnread();
  els.unreadTotal.textContent = unread;
  els.unreadTotal.hidden = unread === 0;
  updateStaticFilterActive();
  updateListHeader();
}

// Inline rename in the sidebar: Enter or leaving the field saves, Escape cancels.
function startRenameFeed(row, feed) {
  renamingFeedId = feed.id;
  const input = document.createElement("input");
  input.className = "feed-rename-input";
  input.value = feed.title;
  input.maxLength = 100;
  input.setAttribute("aria-label", `New name for ${feed.title}`);
  row.classList.add("renaming");
  row.prepend(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const title = input.value.replace(/\s+/g, " ").trim();
    if (save && title && title !== feed.title) {
      try {
        const renamed = await api(`/api/feeds/${feed.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
        feed.title = renamed.title;
        showFeedTitle(feed.id, renamed.title);
        toast(`Renamed to ${renamed.title}`);
      } catch (err) {
        toast(err.message, "error");
      }
    }
    renamingFeedId = null;
    renderFeeds();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

// Updates a renamed feed's title wherever it's already on screen, without reloading the list.
function showFeedTitle(feedId, title) {
  for (const a of state.articles) if (a.feed_id === feedId) a.feed_title = title;
  els.articleList.querySelectorAll(`.article-item[data-feed-id="${feedId}"] .article-feed`).forEach((el) => {
    el.textContent = title;
  });
  if (currentArticle?.feed_id === feedId) {
    currentArticle.feed_title = title;
    const metaFeed = els.readerMeta.querySelector(".reader-meta-feed");
    if (metaFeed) metaFeed.textContent = title;
  }
  updateListHeader();
}

// Keeps sidebar badges in step with read/unread changes without refetching every feed.
function adjustUnread(feedId, delta) {
  const feed = state.feeds.find((f) => f.id === feedId);
  if (!feed) return;
  feed.unread_count = Math.max(0, (feed.unread_count || 0) + delta);
  renderFeeds();
}

async function loadContinueReading() {
  const data = await api("/api/articles?in_progress=true&limit=5");
  renderContinueReading(data.articles);
}

function renderContinueReading(articles) {
  els.continueReadingSection.hidden = articles.length === 0;
  els.continueReadingList.innerHTML = "";
  for (const a of articles) {
    const btn = document.createElement("button");
    btn.className = "feed-item continue-reading-item";
    btn.title = `${a.feed_title} — ${Math.round(a.progress * 100)}% read`;
    btn.innerHTML = `
      <span class="feed-icon">◐</span>
      <span class="feed-label">${escapeHtml(a.title)}</span>
      <span class="continue-progress">${Math.round(a.progress * 100)}%</span>
    `;
    btn.onclick = () => openArticleOutsideList(a.id);
    els.continueReadingList.appendChild(btn);
  }
}

// Opens an article from somewhere other than the article list (Continue Reading, My List).
function openArticleOutsideList(id) {
  flushProgress();
  if (state.view !== "feed") {
    // The list pane may still hold Discover results; show the feed list its header now claims.
    setView("feed");
    loadArticles(true);
  }
  return selectArticle(id);
}

function setFilter(feedId, filter) {
  flushProgress();
  state.feedId = feedId;
  state.filter = filter;
  state.query = "";
  els.searchInput.value = "";
  setView("feed");
  loadArticles(true);
  enterMobileScreen("list", listTitleText());
}

// --- Add feed ---

els.addFeedForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = els.feedUrlInput.value.trim();
  if (!url) return;
  els.addFeedError.hidden = true;
  const submitBtn = els.addFeedForm.querySelector("button");
  submitBtn.disabled = true;
  submitBtn.textContent = "Adding…";
  try {
    const result = await api("/api/feeds", { method: "POST", body: JSON.stringify({ url }) });
    els.feedUrlInput.value = "";
    toast(`Subscribed to ${result.title} · ${plural(result.newArticles, "article")}`);
    await loadFeeds();
    setFilter(result.feedId, null);
  } catch (err) {
    els.addFeedError.textContent = err.message;
    els.addFeedError.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Add";
  }
});

// --- OPML import (export is a plain download of /api/opml) ---

function normalizeFeedUrl(url) {
  return url.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

function feedsFromOpml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("That file isn't a valid OPML file");
  const feeds = [];
  for (const outline of doc.getElementsByTagName("outline")) {
    // Readers disagree on the attribute's case (xmlUrl vs xmlurl), and XML attribute lookup is case-sensitive.
    const url = [...outline.attributes].find((a) => a.name.toLowerCase() === "xmlurl")?.value.trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    feeds.push({ url, title: outline.getAttribute("title") || outline.getAttribute("text") || url });
  }
  return feeds;
}

const OPML_IMPORT_CONCURRENCY = 2;

async function importOpml(file) {
  let entries;
  try {
    entries = feedsFromOpml(await file.text());
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  const seen = new Set(state.feeds.map((f) => normalizeFeedUrl(f.url)));
  const todo = entries.filter((entry) => {
    const key = normalizeFeedUrl(entry.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (todo.length === 0) {
    toast(entries.length ? "You already follow every feed in that file" : "No feeds found in that file");
    return;
  }

  els.importOpmlBtn.disabled = true;
  els.addFeedError.hidden = true;
  let finished = 0;
  let added = 0;
  const failures = [];
  toast(`Importing ${plural(todo.length, "feed")}…`, "info", 0);
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const entry = todo[next++];
      try {
        await api("/api/feeds", { method: "POST", body: JSON.stringify({ url: entry.url }) });
        added++;
      } catch (err) {
        // 409: same feed under a different URL spelling (e.g. after a redirect) — already followed.
        if (err.status !== 409) failures.push(`${entry.title} (${err.message})`);
      }
      finished++;
      toast(`Importing feeds… ${finished} of ${todo.length}`, "info", 0);
    }
  }
  await Promise.all(Array.from({ length: Math.min(OPML_IMPORT_CONCURRENCY, todo.length) }, worker));
  els.importOpmlBtn.disabled = false;

  toast(failures.length ? `Imported ${plural(added, "feed")} · ${failures.length} failed` : `Imported ${plural(added, "feed")}`);
  if (failures.length) {
    els.addFeedError.textContent = `Couldn't import: ${failures.join("; ")}`;
    els.addFeedError.hidden = false;
  }
  await loadFeeds();
  if (state.view !== "notebook") loadArticles(true);
}

els.importOpmlBtn.addEventListener("click", () => els.opmlFileInput.click());
els.opmlFileInput.addEventListener("change", () => {
  const file = els.opmlFileInput.files?.[0];
  els.opmlFileInput.value = "";
  if (file) importOpml(file);
});

// --- Article list ---

function listTitleText() {
  if (state.view === "discover") return "Discover";
  if (state.feedId !== null) return state.feeds.find((f) => f.id === state.feedId)?.title ?? "Subscription";
  if (state.filter === "unread") return "Unread";
  if (state.filter === "saved") return "Saved";
  return "All articles";
}

function totalUnread() {
  return state.feeds.reduce((sum, f) => sum + (f.unread_count || 0), 0);
}

function unreadInScope() {
  if (state.feedId !== null) return state.feeds.find((f) => f.id === state.feedId)?.unread_count ?? 0;
  return totalUnread();
}

function updateListHeader() {
  els.listTitle.textContent = listTitleText();
  const inFeed = state.view === "feed";
  els.listActions.hidden = !inFeed;
  const canMarkAll = inFeed && state.filter !== "saved" && !state.query;
  els.markAllReadBtn.hidden = !canMarkAll;
  els.markAllReadBtn.disabled = unreadInScope() === 0;
  if (!inFeed) {
    els.listMeta.textContent = "";
  } else if (state.query) {
    els.listMeta.textContent = `Results for “${state.query}”`;
  } else if (state.filter === "saved") {
    els.listMeta.textContent = "";
  } else {
    const unread = unreadInScope();
    els.listMeta.textContent = unread ? `${unread} unread` : "All caught up";
  }
}

async function loadArticles(reset) {
  const token = reset ? ++listRequestToken : listRequestToken;
  if (!reset && state.loading) return;
  state.loading = true;
  try {
    await fetchArticlePage(reset, token);
  } catch (err) {
    if (token === listRequestToken) toast(err.message, "error");
  } finally {
    if (token === listRequestToken) state.loading = false;
  }
}

async function fetchArticlePage(reset, token) {
  if (state.view === "discover") {
    const data = await api("/api/discover");
    if (token !== listRequestToken) return;
    state.cursor = null;
    state.maxId = null;
    state.articles = data.articles;
    renderArticleList(data.articles, false);
    els.loadMoreBtn.hidden = true;
    els.emptyState.hidden = true;
    els.filteredEmptyState.hidden = true;
    els.discoverEmptyState.hidden = data.articles.length > 0;
    return;
  }

  const data = await api(articleListPath(reset ? null : state.cursor));
  // A newer list request (filter change, new search keystroke) superseded this one.
  if (token !== listRequestToken) return;
  if (reset) {
    state.articles = [];
    state.maxId = data.maxId ?? null;
    els.articleListPane.scrollTop = 0;
    els.newArticlesBtn.hidden = true;
  }
  state.articles.push(...data.articles);
  state.cursor = data.nextCursor;
  renderArticleList(data.articles, !reset);
  els.loadMoreBtn.hidden = data.nextCursor === null;
  els.discoverEmptyState.hidden = true;
  const empty = state.articles.length === 0;
  els.emptyState.hidden = !(empty && state.feeds.length === 0);
  els.filteredEmptyState.hidden = !(empty && state.feeds.length > 0);
  if (empty) renderFilteredEmptyState();
  updateListHeader();
}

// The first page (cursor null) or a later one of the list currently shown.
function articleListPath(cursor) {
  const params = new URLSearchParams();
  if (state.feedId) params.set("feed_id", state.feedId);
  if (state.filter === "unread") params.set("unread", "true");
  if (state.filter === "saved") params.set("saved", "true");
  if (state.query) params.set("q", state.query);
  if (cursor) params.set("cursor", cursor);
  return `/api/articles?${params.toString()}`;
}

function renderFilteredEmptyState() {
  let title = "No articles yet";
  let body = "New posts from this subscription will show up here after the next refresh.";
  if (state.query) {
    title = "No matches";
    body = `Nothing in ${listTitleText().toLowerCase() === "all articles" ? "your feed" : listTitleText()} mentions “${state.query}”.`;
  } else if (state.filter === "unread") {
    title = "All caught up";
    body = "You've read everything. Go do the work.";
  } else if (state.filter === "saved") {
    title = "Nothing saved yet";
    body = "Hit Save (or press s) on an article to keep it here.";
  }
  els.filteredEmptyTitle.textContent = title;
  els.filteredEmptyBody.textContent = body;
}

// Escapes text for HTML and wraps each case-insensitive occurrence of term in <mark>.
function markTerm(text, term) {
  if (!term) return escapeHtml(text);
  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let html = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    html += `${escapeHtml(text.slice(last, match.index))}<mark>${escapeHtml(match[0])}</mark>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(last));
}

// While searching, show where the article body matched if the summary doesn't already.
function summaryHtml(article) {
  const summary = article.summary || "";
  const term = state.view === "feed" ? state.query : "";
  if (term && article.match_excerpt && !summary.toLowerCase().includes(term.toLowerCase())) {
    return markTerm(article.match_excerpt, term);
  }
  return markTerm(summary, term);
}

function renderArticleList(articles, append) {
  if (!append) els.articleList.innerHTML = "";
  for (const a of articles) {
    const item = document.createElement("div");
    item.className = `article-item ${a.is_read ? "read" : ""}`;
    item.dataset.id = a.id;
    item.dataset.feedId = a.feed_id;
    item.classList.toggle("selected", state.selectedId === a.id);
    const scoreBadge = state.view === "discover" ? `<span class="discover-score">🔥 ${a.score}</span>` : "";
    item.innerHTML = `
      <div class="article-source">
        ${a.is_read ? "" : '<span class="unread-dot"></span>'}
        <span><span class="article-feed">${escapeHtml(a.feed_title)}</span> · ${formatRelative(a.published_at || a.sort_at)}</span>
        ${a.is_saved ? '<span class="saved-mark" title="Saved">★</span>' : ""}
        ${scoreBadge}
      </div>
      <p class="article-title">${markTerm(a.title, state.view === "feed" ? state.query : "")}</p>
      <p class="article-summary">${summaryHtml(a)}</p>
      ${a.progress > 0.02 && a.progress < 0.95 ? `<div class="article-progress"><div class="article-progress-fill" style="width:${Math.round(a.progress * 100)}%"></div></div>` : ""}
    `;
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.addEventListener("click", () => selectArticle(a.id));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectArticle(a.id);
      }
    });
    els.articleList.appendChild(item);
  }
}

function setListItemRead(id, read) {
  const article = state.articles.find((a) => a.id === id);
  if (article) article.is_read = read ? 1 : 0;
  const item = els.articleList.querySelector(`.article-item[data-id="${id}"]`);
  if (!item) return;
  item.classList.toggle("read", read);
  const dot = item.querySelector(".unread-dot");
  if (read) dot?.remove();
  else if (!dot) item.querySelector(".article-source").insertAdjacentHTML("afterbegin", '<span class="unread-dot"></span>');
}

els.loadMoreBtn.addEventListener("click", () => loadArticles(false));

// Infinite scroll: fetch the next page as the "Load more" button nears the viewport.
new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting) && !els.loadMoreBtn.hidden) loadArticles(false);
  },
  { root: els.articleListPane, rootMargin: "300px" },
).observe(els.loadMoreBtn);

async function refreshAll() {
  if (els.refreshAllBtn.disabled) return;
  els.refreshAllBtn.disabled = true;
  els.refreshAllBtn.classList.add("spinning");
  try {
    const result = await api("/api/refresh", { method: "POST" });
    const failed = result.details.filter((d) => d.error).length;
    const summary = result.totalNew ? `${plural(result.totalNew, "new article")}` : "You're up to date";
    toast(failed ? `${summary} · ${plural(failed, "feed")} failed to refresh` : summary);
    await loadFeeds();
    if (state.view !== "notebook") await loadArticles(true);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    els.refreshAllBtn.disabled = false;
    els.refreshAllBtn.classList.remove("spinning");
  }
}

els.refreshAllBtn.addEventListener("click", refreshAll);

async function markAllRead() {
  if (els.markAllReadBtn.hidden || els.markAllReadBtn.disabled || state.maxId == null) return;
  let result;
  try {
    result = await api("/api/articles/mark-all-read", {
      method: "POST",
      body: JSON.stringify({ feedId: state.feedId, maxId: state.maxId }),
    });
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  if (result.marked) {
    toast(`Marked ${plural(result.marked, "article")} as read`, "info", UNDO_TOAST_MS, {
      label: "Undo",
      run: () => restoreUnread(result.ids),
    });
  } else {
    toast("Nothing left to mark");
  }
  await reflectReadState(result.ids, true);
}

// The server takes up to 10,000 ids per request; a huge "mark all read" is undone in slices.
const UNDO_IDS_PER_REQUEST = 5000;

async function restoreUnread(ids) {
  try {
    for (let i = 0; i < ids.length; i += UNDO_IDS_PER_REQUEST) {
      const slice = ids.slice(i, i + UNDO_IDS_PER_REQUEST);
      await api("/api/articles/mark-unread", { method: "POST", body: JSON.stringify({ ids: slice }) });
    }
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  toast(`Restored ${plural(ids.length, "unread article")}`);
  await reflectReadState(ids, false);
}

// Brings counts and the visible list in line after a bulk read/unread change.
async function reflectReadState(ids, read) {
  await loadFeeds();
  if (state.view === "feed" && state.filter === "unread") {
    loadArticles(true);
    return;
  }
  const changed = new Set(ids);
  for (const a of state.articles) if (changed.has(a.id)) setListItemRead(a.id, read);
}

els.markAllReadBtn.addEventListener("click", markAllRead);

let searchTimer = null;
els.searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const query = els.searchInput.value.trim();
    if (query === state.query) return;
    state.query = query;
    loadArticles(true);
  }, 250);
});

// --- Discover (topic-ranked "badass articles" across all subscriptions) ---

async function loadTopics() {
  els.sourceSuggestions.hidden = true;
  els.sourceSuggestions.innerHTML = "";
  const topics = await api("/api/topics");
  renderTopicChips(topics);
}

function renderTopicChips(topics) {
  els.topicChips.innerHTML = "";
  for (const t of topics) {
    const chip = document.createElement("span");
    chip.className = "topic-chip";
    chip.innerHTML = `
      <span>${escapeHtml(t.keyword)}</span>
      <button class="chip-find" title="Find new Substacks for “${escapeHtml(t.keyword)}”">🔍</button>
      <button class="chip-remove" title="Stop tracking">✕</button>
    `;
    chip.querySelector(".chip-find").onclick = () => findSources(t.keyword);
    chip.querySelector(".chip-remove").onclick = async () => {
      await api(`/api/topics/${t.id}`, { method: "DELETE" });
      chip.remove();
      loadArticles(true);
    };
    els.topicChips.appendChild(chip);
  }
}

async function findSources(topic) {
  els.sourceSuggestions.hidden = false;
  els.sourceSuggestions.innerHTML = `<p class="source-status">Searching Substack for "${escapeHtml(topic)}"…</p>`;
  try {
    const data = await api(`/api/discover/sources?topic=${encodeURIComponent(topic)}`);
    renderSourceSuggestions(topic, data.sources);
  } catch (err) {
    els.sourceSuggestions.innerHTML = `<p class="source-status error">${escapeHtml(err.message)}</p>`;
  }
}

function renderSourceSuggestions(topic, sources) {
  if (!sources.length) {
    els.sourceSuggestions.innerHTML = `<p class="source-status">No new Substacks found for "${escapeHtml(topic)}". Try a broader topic.</p>`;
    return;
  }
  els.sourceSuggestions.innerHTML = `<p class="source-status">Substacks for "${escapeHtml(topic)}":</p>`;
  const list = document.createElement("div");
  list.className = "source-list";
  for (const s of sources) {
    const card = document.createElement("div");
    card.className = "source-card";
    card.innerHTML = `
      <div class="source-info">
        <p class="source-title">${escapeHtml(s.title)}</p>
        <p class="source-desc">${escapeHtml(s.description || s.siteUrl)}</p>
      </div>
      <button class="source-subscribe">+ Subscribe</button>
    `;
    const btn = card.querySelector(".source-subscribe");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Adding…";
      try {
        await api("/api/feeds", { method: "POST", body: JSON.stringify({ url: s.feedUrl }) });
        btn.textContent = "Added ✓";
        await loadFeeds();
        if (state.view === "discover") await loadArticles(true);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "+ Subscribe";
        toast(err.message, "error");
      }
    });
    list.appendChild(card);
  }
  els.sourceSuggestions.appendChild(list);
}

els.topicAddForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const keyword = els.topicAddInput.value.trim();
  if (!keyword) return;
  try {
    await api("/api/topics", { method: "POST", body: JSON.stringify({ keyword }) });
    els.topicAddInput.value = "";
    await loadTopics();
    await loadArticles(true);
  } catch (err) {
    toast(err.message, "error");
  }
});

// --- Reader ---

async function selectArticle(id) {
  flushProgress();
  const token = ++selectRequestToken;
  state.selectedId = id;
  document.querySelectorAll(".article-item").forEach((el) => {
    el.classList.toggle("selected", Number(el.dataset.id) === id);
  });
  els.articleList.querySelector(`.article-item[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });

  let article;
  try {
    article = await api(`/api/articles/${id}?day=${localDay()}`);
  } catch (err) {
    if (token === selectRequestToken) toast(err.message, "error");
    return;
  }
  // Fetching the article marked it read (and logged it for the streak) server-side, even if the user
  // has already moved on, so keep the counts in step before deciding whether to render it.
  // is_read here is its state from before that fetch.
  if (!article.is_read) adjustUnread(article.feed_id, -1);
  if (article.first_read_today) countReadToday();
  setListItemRead(id, true);

  // The user already moved on to another article while this one was loading.
  if (token !== selectRequestToken) return;
  currentArticle = { ...article, is_read: 1 };

  els.readerEmpty.hidden = true;
  els.reader.hidden = false;
  els.readerTitle.textContent = article.title;
  renderReaderMeta(article);
  els.readerSourceLink.href = isSafeHttpUrl(article.url) ? article.url : "#";
  els.readerBody.innerHTML = article.content_html || `<p>${escapeHtml(article.summary || "No preview available.")}</p>`;
  updateSaveBtn(!!article.is_saved);
  updateReadToggleBtn(true);
  highlightSavedSnippets(article.id, token);

  const shortTitle = article.title.length > 26 ? `${article.title.slice(0, 26)}…` : article.title;
  enterMobileScreen("reader", shortTitle);

  if (readerScrollHandler) {
    els.readerPane.removeEventListener("scroll", readerScrollHandler);
  }
  const savedProgress = typeof article.progress === "number" ? article.progress : 0;
  requestAnimationFrame(() => {
    const max = els.readerPane.scrollHeight - els.readerPane.clientHeight;
    els.readerPane.scrollTop = max > 0 ? savedProgress * max : 0;
    els.readerProgressFill.style.width = `${savedProgress * 100}%`;
  });
  readerScrollHandler = () => {
    const max = els.readerPane.scrollHeight - els.readerPane.clientHeight;
    const fraction = max > 0 ? Math.min(1, Math.max(0, els.readerPane.scrollTop / max)) : 1;
    els.readerProgressFill.style.width = `${fraction * 100}%`;
    scheduleProgressSave(id, fraction);
  };
  els.readerPane.addEventListener("scroll", readerScrollHandler);
}

// --- Saved snippets, highlighted in the article they came from ---
// Uses the CSS Custom Highlight API, which paints ranges without touching the article's DOM.

const savedSnippetHighlight = window.CSS?.highlights && window.Highlight ? new Highlight() : null;
if (savedSnippetHighlight) CSS.highlights.set("saved-snippet", savedSnippetHighlight);

const BLOCK_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, th, figcaption, div";

// Flattens the article's text into one whitespace-collapsed string, with a map from each character
// back to its text node and offset. Block boundaries count as a space, matching how a copied
// selection reads, so snippets that span paragraphs or inline formatting still line up.
function indexText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let flat = "";
  const map = [];
  let previousBlock = null;
  let lastWasSpace = true;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const block = node.parentElement?.closest(BLOCK_SELECTOR) ?? null;
    if (previousBlock && block !== previousBlock && !lastWasSpace) {
      flat += " ";
      map.push(null);
      lastWasSpace = true;
    }
    previousBlock = block;
    const text = node.nodeValue;
    for (let i = 0; i < text.length; i++) {
      const isSpace = /\s/.test(text[i]);
      if (isSpace && lastWasSpace) continue;
      flat += isSpace ? " " : text[i];
      map.push([node, i]);
      lastWasSpace = isSpace;
    }
  }
  return { flat, map };
}

function rangeForSnippet(index, snippet) {
  const needle = snippet.replace(/\s+/g, " ").trim();
  if (needle.length < 3) return null;
  const at = index.flat.indexOf(needle);
  if (at === -1) return null;
  const first = index.map[at];
  const last = index.map[at + needle.length - 1];
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first[0], first[1]);
  range.setEnd(last[0], last[1] + 1);
  return range;
}

async function highlightSavedSnippets(articleId, token) {
  if (!savedSnippetHighlight) return;
  savedSnippetHighlight.clear();
  let snippets;
  try {
    snippets = await api(`/api/highlights?article_id=${articleId}`);
  } catch {
    return; // Purely decorative; the article is already readable.
  }
  if (token !== selectRequestToken || snippets.length === 0) return;
  const index = indexText(els.readerBody);
  for (const snippet of snippets) {
    const range = rangeForSnippet(index, snippet.text);
    if (range) savedSnippetHighlight.add(range);
  }
}

function renderReaderMeta(article) {
  els.readerMeta.innerHTML = "";
  const parts = [
    { text: article.feed_title, className: "reader-meta-feed" },
    { text: article.author },
    { text: formatDate(article.published_at) },
    { text: estimateReadingTime(article.content_html || article.summary) },
  ].filter((p) => p.text);
  parts.forEach((part, i) => {
    if (i > 0) {
      const dot = document.createElement("span");
      dot.className = "reader-meta-dot";
      dot.textContent = "·";
      els.readerMeta.append(dot);
    }
    const span = document.createElement("span");
    if (part.className) span.className = part.className;
    span.textContent = part.text;
    els.readerMeta.append(span);
  });
}

function updateSaveBtn(saved) {
  els.saveBtn.querySelector(".save-icon").textContent = saved ? "★" : "☆";
  els.saveBtn.lastChild.textContent = saved ? " Saved" : " Save";
  els.saveBtn.classList.toggle("active", saved);
}

function updateReadToggleBtn(read) {
  els.readToggleBtn.textContent = read ? "Mark unread" : "Mark read";
  els.readToggleBtn.title = `${read ? "Mark unread" : "Mark read"} (m)`;
}

async function toggleSave() {
  if (!currentArticle) return;
  const article = currentArticle;
  try {
    const res = await api(`/api/articles/${article.id}/save`, { method: "POST" });
    article.is_saved = res.is_saved ? 1 : 0;
    if (currentArticle === article) updateSaveBtn(res.is_saved);
    const listed = state.articles.find((a) => a.id === article.id);
    if (listed) listed.is_saved = article.is_saved;
    const source = els.articleList.querySelector(`.article-item[data-id="${article.id}"] .article-source`);
    source?.querySelector(".saved-mark")?.remove();
    if (source && res.is_saved) {
      source.querySelector("span:not(.unread-dot)").insertAdjacentHTML("afterend", '<span class="saved-mark" title="Saved">★</span>');
    }
    if (res.is_saved) precacheArticle(article.id);
    toast(res.is_saved ? "Saved" : "Removed from Saved");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function toggleRead() {
  if (!currentArticle) return;
  const article = currentArticle;
  const nextRead = !article.is_read;
  try {
    await api(`/api/articles/${article.id}/read`, { method: "POST", body: JSON.stringify({ read: nextRead }) });
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  article.is_read = nextRead ? 1 : 0;
  if (currentArticle === article) updateReadToggleBtn(nextRead);
  setListItemRead(article.id, nextRead);
  adjustUnread(article.feed_id, nextRead ? -1 : 1);
}

// An image that fails to load (deleted from an old post, CDN refusing it) would otherwise keep its
// reserved width × height as a blank gap. "error" doesn't bubble, so listen in the capture phase.
els.readerBody.addEventListener(
  "error",
  (e) => {
    if (e.target instanceof HTMLImageElement) e.target.classList.add("img-failed");
  },
  true,
);

els.saveBtn.addEventListener("click", toggleSave);
els.readToggleBtn.addEventListener("click", toggleRead);

function openOriginal() {
  if (currentArticle && isSafeHttpUrl(currentArticle.url)) {
    window.open(currentArticle.url, "_blank", "noopener,noreferrer");
  }
}

async function moveSelection(delta) {
  if (state.view === "notebook" || state.articles.length === 0) return;
  let index = state.articles.findIndex((a) => a.id === state.selectedId);
  let next = index === -1 ? 0 : index + delta;
  if (next >= state.articles.length && state.cursor) {
    await loadArticles(false);
    index = state.articles.findIndex((a) => a.id === state.selectedId);
    next = index + delta;
  }
  next = Math.max(0, Math.min(state.articles.length - 1, next));
  if (next !== index) selectArticle(state.articles[next].id);
}

function escapeHtml(str) {
  const replacements = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(str ?? "").replace(/[&<>"']/g, (ch) => replacements[ch]);
}

function isSafeHttpUrl(url) {
  try {
    return ["http:", "https:"].includes(new URL(url, location.href).protocol);
  } catch {
    return false;
  }
}

// --- My List (highlights + freeform notes) ---

function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

// --- Saved scripts: each is an ordered list of snippets; new snippets go to the current one ---

const scripts = { list: [], currentId: null };
let notebookRequestToken = 0;

function currentScript() {
  return scripts.list.find((s) => s.id === scripts.currentId) ?? null;
}

async function loadScripts() {
  const data = await api("/api/scripts");
  scripts.list = data.scripts;
  scripts.currentId = data.currentId;
  renderScriptPicker();
}

function renderScriptPicker() {
  els.scriptSelect.innerHTML = "";
  for (const script of scripts.list) {
    const option = new Option(`${script.title} (${script.snippet_count})`, script.id);
    option.selected = script.id === scripts.currentId;
    els.scriptSelect.append(option);
  }
}

function adjustScriptCount(scriptId, delta) {
  const script = scripts.list.find((s) => s.id === scriptId);
  if (!script) return;
  script.snippet_count = Math.max(0, script.snippet_count + delta);
  renderScriptPicker();
}

async function loadHighlights() {
  const token = ++notebookRequestToken;
  await loadScripts();
  const highlights = await api(`/api/highlights?script_id=${scripts.currentId}`);
  // A quicker script switch already replaced this one.
  if (token !== notebookRequestToken) return;
  els.notebookList.innerHTML = "";
  for (const h of highlights) renderHighlightItem(h);
  updateNotebookChrome();
}

async function selectScript(id) {
  try {
    await api(`/api/scripts/${id}/select`, { method: "POST" });
  } catch (err) {
    toast(err.message, "error");
    renderScriptPicker();
    return;
  }
  await loadHighlights();
}

async function newScript() {
  const suggested = `Script — ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const title = prompt("Name your new script", suggested);
  if (title === null) return;
  try {
    await api("/api/scripts", { method: "POST", body: JSON.stringify({ title }) });
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  await loadHighlights();
  toast(`Started “${currentScript()?.title}”`);
}

async function renameScript() {
  const script = currentScript();
  if (!script) return;
  const title = prompt("Rename script", script.title);
  if (title === null || title.trim() === script.title) return;
  try {
    const renamed = await api(`/api/scripts/${script.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
    script.title = renamed.title;
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  renderScriptPicker();
}

async function duplicateScript() {
  const script = currentScript();
  if (!script) return;
  // The copy is made server-side, so save any edit still waiting on its debounce first.
  await flushNotebookEdits();
  try {
    await api(`/api/scripts/${script.id}/duplicate`, { method: "POST" });
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  await loadHighlights();
  toast(`Made a copy: “${currentScript()?.title}”`);
}

async function deleteScript() {
  const script = currentScript();
  if (!script) return;
  const snapshot = snapshotNotebook();
  const what = snapshot.length ? ` and its ${plural(snapshot.length, "snippet")}` : "";
  if (!confirm(`Delete “${script.title}”${what}?`)) return;
  try {
    await api(`/api/scripts/${script.id}`, { method: "DELETE" });
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  await loadHighlights();
  toast(`Deleted “${script.title}”`, "info", UNDO_TOAST_MS, {
    label: "Undo",
    run: async () => {
      try {
        const restored = await api("/api/scripts", { method: "POST", body: JSON.stringify({ title: script.title }) });
        await restoreSnippets(snapshot, restored.id);
      } catch (err) {
        toast(err.message, "error");
        return;
      }
      if (state.view === "notebook") await loadHighlights();
      toast(`Restored “${script.title}”`);
    },
  });
}

function setScriptMenuOpen(open) {
  els.scriptMenu.hidden = !open;
  els.scriptMenuBtn.setAttribute("aria-expanded", String(open));
}

function initScripts() {
  els.scriptSelect.addEventListener("change", () => selectScript(Number(els.scriptSelect.value)));
  els.newScriptBtn.addEventListener("click", newScript);
  els.scriptMenuBtn.addEventListener("click", () => setScriptMenuOpen(els.scriptMenu.hidden));
  const actions = { rename: renameScript, duplicate: duplicateScript, delete: deleteScript };
  els.scriptMenu.addEventListener("click", (e) => {
    const action = actions[e.target.closest("button")?.dataset.action];
    if (!action) return;
    setScriptMenuOpen(false);
    action();
  });
  document.addEventListener("click", (e) => {
    if (!els.scriptMenu.hidden && !e.target.closest(".script-menu-wrap")) setScriptMenuOpen(false);
  });
}

// Roughly how fast people talk on camera; used to estimate how long the script runs.
const SPEAKING_WORDS_PER_MINUTE = 150;

function updateNotebookChrome() {
  const texts = [...els.notebookList.querySelectorAll(".highlight-text")];
  const script = currentScript();
  if (script && script.snippet_count !== texts.length) {
    script.snippet_count = texts.length;
    renderScriptPicker();
  }
  els.notebookEmpty.hidden = texts.length > 0;
  for (const btn of [els.copyAllBtn, els.downloadMdBtn, els.clearListBtn, els.prompterOpenBtn]) {
    btn.disabled = texts.length === 0;
  }
  if (texts.length === 0) {
    els.notebookStats.textContent = "";
    return;
  }
  const words = texts.reduce((sum, t) => sum + (t.value.match(/\S+/g)?.length ?? 0), 0);
  const seconds = Math.round((words / SPEAKING_WORDS_PER_MINUTE) * 60);
  const spoken = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  els.notebookStats.textContent = `${plural(texts.length, "snippet")} · ${plural(words, "word")} · about ${spoken} spoken`;
}

const GRIP_SVG =
  '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" fill="currentColor">' +
  '<circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/><circle cx="2" cy="8" r="1.5"/>' +
  '<circle cx="8" cy="8" r="1.5"/><circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></svg>';

function renderHighlightItem(h) {
  const item = document.createElement("div");
  item.className = "highlight-item";
  item.dataset.id = h.id;

  const textarea = document.createElement("textarea");
  textarea.className = "highlight-text";
  textarea.value = h.text;
  textarea.rows = 1;

  const meta = document.createElement("div");
  meta.className = "highlight-meta";
  const sourceText = h.article_title ? `${h.feed_title ? `${h.feed_title} — ` : ""}${h.article_title}` : "Note";
  let source;
  if (h.article_id) {
    source = document.createElement("button");
    source.className = "highlight-source";
    source.title = `Open “${h.article_title}” in the reader`;
    source.addEventListener("click", () => openArticleOutsideList(h.article_id));
  } else {
    source = document.createElement("span");
    source.title = sourceText;
  }
  source.textContent = sourceText;
  meta.append(source);
  if (h.article_url && isSafeHttpUrl(h.article_url)) {
    const link = document.createElement("a");
    link.className = "highlight-original";
    link.href = h.article_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = "Open original";
    link.textContent = "↗";
    meta.append(link);
  }
  const others = scripts.list.filter((s) => s.id !== scripts.currentId);
  if (others.length) {
    const move = document.createElement("select");
    move.className = "move-snippet";
    move.title = "Move to another script";
    move.setAttribute("aria-label", "Move to another script");
    move.append(new Option("Move to…", "", true, true));
    move.options[0].disabled = true;
    for (const script of others) move.append(new Option(script.title, script.id));
    move.addEventListener("change", async () => {
      const targetId = Number(move.value);
      try {
        const moved = await api(`/api/highlights/${h.id}`, { method: "PATCH", body: JSON.stringify({ scriptId: targetId }) });
        item.remove();
        updateNotebookChrome();
        adjustScriptCount(targetId, 1);
        toast(`Moved to “${moved.scriptTitle}”`);
      } catch (err) {
        move.value = "";
        toast(err.message, "error");
      }
    });
    meta.append(move);
  }
  const removeBtn = document.createElement("button");
  removeBtn.className = "remove-highlight";
  removeBtn.title = "Remove";
  removeBtn.textContent = "✕";
  meta.append(removeBtn);

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "drag-handle";
  handle.title = "Drag to reorder (or focus and press ↑/↓)";
  handle.setAttribute("aria-label", "Reorder snippet");
  handle.innerHTML = GRIP_SVG;

  const body = document.createElement("div");
  body.className = "highlight-body";
  body.append(textarea, meta);

  item.append(handle, body);
  item.highlight = h;
  els.notebookList.appendChild(item);
  requestAnimationFrame(() => autoGrow(textarea));

  let saveTimer;
  const saveText = async () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    const text = textarea.value.trim();
    if (!text) return;
    try {
      await api(`/api/highlights/${h.id}`, { method: "PATCH", body: JSON.stringify({ text }) });
    } catch (err) {
      toast(`Couldn't save your edit: ${err.message}`, "error");
    }
  };
  // Lets a script copy (made server-side) include an edit that's still waiting on its debounce.
  item.flushEdit = () => (saveTimer ? saveText() : Promise.resolve());
  textarea.addEventListener("input", () => {
    autoGrow(textarea);
    updateNotebookChrome();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveText, 600);
  });

  removeBtn.addEventListener("click", async () => {
    const position = [...els.notebookList.children].indexOf(item);
    const text = textarea.value.trim() || h.text;
    try {
      await api(`/api/highlights/${h.id}`, { method: "DELETE" });
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    item.remove();
    updateNotebookChrome();
    toast("Snippet removed", "info", UNDO_TOAST_MS, { label: "Undo", run: () => restoreHighlight({ ...h, text }, position) });
  });

  return item;
}

// Re-creates a deleted snippet and puts it back where it was.
async function restoreHighlight(h, position) {
  let created;
  try {
    created = await api("/api/highlights", {
      method: "POST",
      body: JSON.stringify({
        text: h.text,
        articleId: h.article_id,
        articleTitle: h.article_title,
        articleUrl: h.article_url,
        feedTitle: h.feed_title,
        scriptId: h.script_id,
      }),
    });
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  if (state.view !== "notebook" || created.script_id !== scripts.currentId) return;
  const item = renderHighlightItem(created);
  els.notebookList.insertBefore(item, els.notebookList.children[position] ?? null);
  updateNotebookChrome();
  saveNotebookOrder();
}

els.notebookAddForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.notebookAddInput.value.trim();
  if (!text) return;
  try {
    const created = await api("/api/highlights", {
      method: "POST",
      body: JSON.stringify({ text, scriptId: scripts.currentId }),
    });
    els.notebookAddInput.value = "";
    renderHighlightItem(created);
    updateNotebookChrome();
  } catch (err) {
    toast(err.message, "error");
  }
});

// --- My List reordering: drag the grip (mouse or touch), or focus it and press ↑/↓ ---

function notebookOrder() {
  return [...els.notebookList.children].map((item) => Number(item.dataset.id));
}

let orderSaveTimer = null;

function saveNotebookOrder(delayMs = 0) {
  clearTimeout(orderSaveTimer);
  orderSaveTimer = setTimeout(async () => {
    const ids = notebookOrder();
    if (ids.length === 0) return;
    try {
      await api("/api/highlights/order", { method: "PUT", body: JSON.stringify({ ids }) });
    } catch (err) {
      toast(`Couldn't save the new order: ${err.message}`, "error");
      loadHighlights();
    }
  }, delayMs);
}

function initNotebookReorder() {
  let drag = null; // { item, pointerId, y, grabOffset, startOrder, raf }

  // Moves the dragged card to sit before the first other card whose midpoint is below the pointer.
  function placeAt(y) {
    const others = [...els.notebookList.children].filter((el) => el !== drag.item);
    const before =
      others.find((el) => {
        const r = el.getBoundingClientRect();
        return y < r.top + r.height / 2;
      }) ?? null;
    if (before !== drag.item.nextElementSibling) els.notebookList.insertBefore(drag.item, before);
  }

  // Keeps the card under the finger/cursor while the list reflows around it.
  function followPointer(y) {
    drag.item.style.transform = "";
    const naturalTop = drag.item.getBoundingClientRect().top;
    drag.item.style.transform = `translateY(${y - drag.grabOffset - naturalTop}px)`;
  }

  function autoScroll() {
    if (!drag) return;
    const pane = els.notebookPane.getBoundingClientRect();
    const edge = 60;
    let dy = 0;
    if (drag.y < pane.top + edge) dy = -Math.ceil((pane.top + edge - drag.y) / 4);
    else if (drag.y > pane.bottom - edge) dy = Math.ceil((drag.y - (pane.bottom - edge)) / 4);
    if (dy) {
      els.notebookPane.scrollTop += dy;
      placeAt(drag.y);
      followPointer(drag.y);
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  els.notebookList.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".drag-handle");
    if (!handle || e.button !== 0 || drag) return;
    e.preventDefault();
    const item = handle.closest(".highlight-item");
    // Capture on the list, not the handle: re-inserting the card would drop capture held by its child.
    els.notebookList.setPointerCapture(e.pointerId);
    drag = {
      item,
      pointerId: e.pointerId,
      y: e.clientY,
      grabOffset: e.clientY - item.getBoundingClientRect().top,
      startOrder: notebookOrder().join(),
      raf: 0,
    };
    item.classList.add("dragging");
    document.body.classList.add("reordering");
    drag.raf = requestAnimationFrame(autoScroll);
  });

  els.notebookList.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.y = e.clientY;
    placeAt(drag.y);
    followPointer(drag.y);
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    cancelAnimationFrame(drag.raf);
    drag.item.classList.remove("dragging");
    drag.item.style.transform = "";
    document.body.classList.remove("reordering");
    const changed = notebookOrder().join() !== drag.startOrder;
    drag = null;
    if (changed) saveNotebookOrder();
  }

  els.notebookList.addEventListener("pointerup", endDrag);
  els.notebookList.addEventListener("pointercancel", endDrag);

  els.notebookList.addEventListener("keydown", (e) => {
    const handle = e.target.closest?.(".drag-handle");
    if (!handle || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const item = handle.closest(".highlight-item");
    if (e.key === "ArrowUp") {
      if (!item.previousElementSibling) return;
      els.notebookList.insertBefore(item, item.previousElementSibling);
    } else {
      if (!item.nextElementSibling) return;
      els.notebookList.insertBefore(item, item.nextElementSibling.nextElementSibling);
    }
    // Re-inserting a node blurs it; keep focus on the grip so repeated presses keep moving it.
    handle.focus();
    item.scrollIntoView({ block: "nearest" });
    saveNotebookOrder(500);
  });
}

// My List as currently shown: snippet text as edited, in display order, plus the articles they came from.
function collectNotebook() {
  const items = [...els.notebookList.querySelectorAll(".highlight-item")];
  const snippets = items.map((item) => item.querySelector(".highlight-text").value.trim()).filter(Boolean);
  const sources = new Map();
  for (const item of items) {
    const h = item.highlight;
    if (!h?.article_title) continue;
    // One entry per article, preferring a snippet that recorded the link.
    const key = h.article_id ?? h.article_url ?? h.article_title;
    if (!sources.has(key) || (!sources.get(key).url && h.article_url)) {
      sources.set(key, { title: h.article_title, url: h.article_url, feed: h.feed_title });
    }
  }
  return { snippets, sources: [...sources.values()] };
}

// Plain-text script draft for pasting anywhere.
function notebookAsText() {
  const { snippets, sources } = collectNotebook();
  let text = snippets.join("\n\n");
  if (sources.length) {
    const lines = sources.map((s) => `- ${s.title}${s.feed ? ` — ${s.feed}` : ""}${s.url ? ` (${s.url})` : ""}`);
    text += `\n\n---\nSources:\n${lines.join("\n")}`;
  }
  return { text, count: snippets.length };
}

function notebookAsMarkdown() {
  const { snippets, sources } = collectNotebook();
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const title = currentScript()?.title ?? "Script";
  let md = `# ${title}\n\n_${date}_\n\n${snippets.join("\n\n")}\n`;
  if (sources.length) {
    const escapeMd = (text) => text.replace(/([\[\]])/g, "\\$1");
    const lines = sources.map((s) => {
      const title = s.url && isSafeHttpUrl(s.url) ? `[${escapeMd(s.title)}](${s.url})` : escapeMd(s.title);
      return `- ${title}${s.feed ? ` — ${s.feed}` : ""}`;
    });
    md += `\n---\n\n## Sources\n\n${lines.join("\n")}\n`;
  }
  return md;
}

function downloadNotebook() {
  const blob = new Blob([notebookAsMarkdown()], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const slug = (currentScript()?.title ?? "script")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  link.download = `${slug || "script"}-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

const RESTORE_SNIPPETS_PER_REQUEST = 500;

// What the current script shows (unsaved edits and order included), so an Undo restores exactly this.
function snapshotNotebook() {
  return [...els.notebookList.querySelectorAll(".highlight-item")].map((item) => ({
    text: item.querySelector(".highlight-text").value.trim() || item.highlight.text,
    articleId: item.highlight.article_id,
    articleTitle: item.highlight.article_title,
    articleUrl: item.highlight.article_url,
    feedTitle: item.highlight.feed_title,
  }));
}

// Re-adds a snapshot to a script: in order, in slices under the server's per-request cap.
async function restoreSnippets(snapshot, scriptId) {
  for (let i = 0; i < snapshot.length; i += RESTORE_SNIPPETS_PER_REQUEST) {
    const items = snapshot.slice(i, i + RESTORE_SNIPPETS_PER_REQUEST);
    await api("/api/highlights/bulk", { method: "POST", body: JSON.stringify({ items, scriptId }) });
  }
}

function flushNotebookEdits() {
  return Promise.all([...els.notebookList.querySelectorAll(".highlight-item")].map((item) => item.flushEdit?.()));
}

async function clearNotebook() {
  const items = [...els.notebookList.querySelectorAll(".highlight-item")];
  const scriptTitle = currentScript()?.title ?? "this script";
  if (items.length === 0 || !confirm(`Clear all ${plural(items.length, "snippet")} from “${scriptTitle}”?`)) return;
  const snapshot = snapshotNotebook();
  const scriptId = scripts.currentId;
  try {
    await api("/api/highlights", {
      method: "DELETE",
      body: JSON.stringify({ ids: items.map((item) => Number(item.dataset.id)) }),
    });
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  els.notebookList.innerHTML = "";
  updateNotebookChrome();
  toast(`Cleared ${plural(snapshot.length, "snippet")}`, "info", UNDO_TOAST_MS, {
    label: "Undo",
    run: async () => {
      try {
        await restoreSnippets(snapshot, scriptId);
      } catch (err) {
        toast(err.message, "error");
        return;
      }
      if (state.view === "notebook") loadHighlights();
      toast(`Restored ${plural(snapshot.length, "snippet")}`);
    },
  });
}

els.downloadMdBtn.addEventListener("click", downloadNotebook);
els.clearListBtn.addEventListener("click", clearNotebook);

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API is unavailable on insecure origins and some embedded browsers.
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand("copy");
    scratch.remove();
    if (!ok) throw new Error("Copy failed — your browser blocked clipboard access");
  }
}

els.copyAllBtn.addEventListener("click", async () => {
  const { text, count } = notebookAsText();
  if (!count) return;
  try {
    await copyToClipboard(text);
    toast(`Copied ${plural(count, "snippet")} to the clipboard`);
  } catch (err) {
    toast(err.message, "error");
  }
});

// --- Text selection → "Add to my list" ---

function captureLabel() {
  const title = currentScript()?.title;
  if (!title) return "+ Add to my list";
  return `+ Add to “${title.length > 24 ? `${title.slice(0, 23)}…` : title}”`;
}

function initSelectionCapture() {
  const btn = document.createElement("button");
  btn.className = "selection-add-btn";
  btn.textContent = "+ Add to my list";
  btn.hidden = true;
  document.body.appendChild(btn);

  const coarsePointer = window.matchMedia("(pointer: coarse)");
  let mouseSelecting = false;

  function readerSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().trim();
    if (!text || !els.readerBody.contains(sel.anchorNode)) return null;
    const range = sel.getRangeAt(0);
    return { text, rect: range.getBoundingClientRect(), range: range.cloneRange() };
  }

  function update() {
    const found = readerSelection();
    if (!found) {
      btn.hidden = true;
      return;
    }
    btn.dataset.text = found.text;
    btn.range = found.range;
    btn.textContent = captureLabel();
    btn.hidden = false;
    const { rect } = found;
    const width = btn.offsetWidth;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    // Touch browsers put their own copy/share menu above the selection, so sit below it there.
    const top = coarsePointer.matches
      ? Math.min(rect.bottom + 14, window.innerHeight - btn.offsetHeight - 12)
      : Math.max(8, rect.top - btn.offsetHeight - 8);
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
  }

  // selectionchange is the only signal touch selection (long-press + drag handles) gives us;
  // with a mouse, wait for the drag to finish so the button doesn't chase the cursor.
  let selectionTimer;
  document.addEventListener("selectionchange", () => {
    if (mouseSelecting) return;
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(update, 150);
  });
  document.addEventListener("mousedown", (e) => {
    if (e.target === btn) return;
    mouseSelecting = true;
    btn.hidden = true;
  });
  document.addEventListener("mouseup", () => {
    if (!mouseSelecting) return;
    mouseSelecting = false;
    setTimeout(update, 0);
  });
  els.readerPane.addEventListener("scroll", () => {
    if (!btn.hidden) requestAnimationFrame(update);
  });

  // Keep the selection alive while pressing the button.
  btn.addEventListener("mousedown", (e) => e.preventDefault());

  btn.addEventListener("click", async () => {
    const text = btn.dataset.text;
    if (!text) return;
    const range = btn.range;
    btn.hidden = true;
    window.getSelection()?.removeAllRanges();
    try {
      const created = await api("/api/highlights", {
        method: "POST",
        body: JSON.stringify({
          text,
          articleId: currentArticle?.id ?? null,
          articleTitle: currentArticle?.title ?? null,
          articleUrl: currentArticle?.url ?? null,
          feedTitle: currentArticle?.feed_title ?? null,
          scriptId: scripts.currentId,
        }),
      });
      if (range && savedSnippetHighlight) savedSnippetHighlight.add(range);
      adjustScriptCount(created.script_id, 1);
      toast(`Added to “${created.script_title ?? "My List"}”`);
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// --- Reading preferences (per device; prefs.js re-applies them before first paint) ---

const PREFS_KEY = "df:prefs";
const TEXT_SIZES = [15, 17, 19, 21, 23, 26];
const DEFAULT_PREFS = {
  theme: "auto",
  font: "serif",
  textSize: 19,
  prompterWpm: SPEAKING_WORDS_PER_MINUTE,
  prompterSize: window.innerWidth < 600 ? 34 : 44,
  prompterMirror: false,
};

function readPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

const THEME_COLORS = { light: "#f7f4ee", dark: "#16140f" };

function applyPrefs(prefs) {
  const root = document.documentElement;
  if (prefs.theme === "light" || prefs.theme === "dark") root.dataset.theme = prefs.theme;
  else delete root.dataset.theme;
  // Browser/OS chrome (status bar, installed app title bar) follows the chosen theme too.
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    const osScheme = meta.media.includes("dark") ? "dark" : "light";
    meta.content = THEME_COLORS[prefs.theme === "light" || prefs.theme === "dark" ? prefs.theme : osScheme];
  });
  if (prefs.font === "sans") root.dataset.readerFont = "sans";
  else delete root.dataset.readerFont;
  root.style.setProperty("--reader-font-size", `${prefs.textSize}px`);

  els.textSizeValue.textContent = `${prefs.textSize}px`;
  els.textSmallerBtn.disabled = prefs.textSize <= TEXT_SIZES[0];
  els.textLargerBtn.disabled = prefs.textSize >= TEXT_SIZES[TEXT_SIZES.length - 1];
  els.readerPrefs.querySelectorAll(".segmented[data-pref] button").forEach((btn) => {
    const pref = btn.parentElement.dataset.pref;
    btn.setAttribute("aria-pressed", String(prefs[pref] === btn.dataset.value));
  });
}

function updatePrefs(change) {
  const prefs = { ...readPrefs(), ...change };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not persisted (storage blocked), but still applied for this visit.
  }
  applyPrefs(prefs);
}

function stepTextSize(direction) {
  const current = readPrefs().textSize;
  const next =
    direction > 0 ? TEXT_SIZES.find((size) => size > current) : [...TEXT_SIZES].reverse().find((size) => size < current);
  if (next) updatePrefs({ textSize: next });
}

function setPrefsOpen(open) {
  els.readerPrefs.hidden = !open;
  els.readerPrefsBtn.setAttribute("aria-expanded", String(open));
}

function initReaderPrefs() {
  applyPrefs(readPrefs());
  els.readerPrefsBtn.addEventListener("click", () => setPrefsOpen(els.readerPrefs.hidden));
  els.textSmallerBtn.addEventListener("click", () => stepTextSize(-1));
  els.textLargerBtn.addEventListener("click", () => stepTextSize(1));
  els.readerPrefs.querySelectorAll(".segmented[data-pref] button").forEach((btn) => {
    btn.addEventListener("click", () => updatePrefs({ [btn.parentElement.dataset.pref]: btn.dataset.value }));
  });
  document.addEventListener("click", (e) => {
    if (!els.readerPrefs.hidden && !e.target.closest(".reader-prefs-wrap")) setPrefsOpen(false);
  });
}

// --- Teleprompter: read the My List script on camera ---

const PROMPTER_WPM_RANGE = { min: 80, max: 260, step: 10 };
const PROMPTER_SIZES = [28, 34, 40, 44, 52, 60, 72];
const PROMPTER_COUNTDOWN_FROM = 3;

const prompter = { playing: false, raf: 0, lastTs: 0, carry: 0, words: 1, wakeLock: null, countdownToken: 0 };

function applyPrompterPrefs() {
  const prefs = readPrefs();
  els.prompter.style.setProperty("--prompter-size", `${prefs.prompterSize}px`);
  els.prompterSpeed.textContent = `${prefs.prompterWpm} wpm`;
  els.prompterText.classList.toggle("mirrored", prefs.prompterMirror);
  els.prompterMirrorBtn.setAttribute("aria-pressed", String(prefs.prompterMirror));
  els.prompterSlowerBtn.disabled = prefs.prompterWpm <= PROMPTER_WPM_RANGE.min;
  els.prompterFasterBtn.disabled = prefs.prompterWpm >= PROMPTER_WPM_RANGE.max;
  els.prompterSmallerBtn.disabled = prefs.prompterSize <= PROMPTER_SIZES[0];
  els.prompterLargerBtn.disabled = prefs.prompterSize >= PROMPTER_SIZES[PROMPTER_SIZES.length - 1];
}

function changePrompterPref(change) {
  updatePrefs(change);
  applyPrompterPrefs();
}

function stepPrompterSpeed(direction) {
  const { min, max, step } = PROMPTER_WPM_RANGE;
  changePrompterPref({ prompterWpm: Math.min(max, Math.max(min, readPrefs().prompterWpm + direction * step)) });
}

function stepPrompterSize(direction) {
  const current = readPrefs().prompterSize;
  const next =
    direction > 0 ? PROMPTER_SIZES.find((s) => s > current) : [...PROMPTER_SIZES].reverse().find((s) => s < current);
  if (next) changePrompterPref({ prompterSize: next });
}

function openPrompter() {
  const snippets = [...els.notebookList.querySelectorAll(".highlight-text")].map((t) => t.value.trim()).filter(Boolean);
  if (snippets.length === 0) return;
  els.prompterText.innerHTML = "";
  for (const snippet of snippets) {
    const p = document.createElement("p");
    p.textContent = snippet;
    els.prompterText.append(p);
  }
  prompter.words = snippets.join(" ").match(/\S+/g)?.length ?? 1;
  applyPrompterPrefs();
  els.prompter.hidden = false;
  document.body.classList.add("prompter-open");
  els.prompterScroll.scrollTop = 0;
  setPrompterButton("start");
  els.prompterPlayBtn.focus();
}

function closePrompter() {
  pausePrompter();
  els.prompter.hidden = true;
  document.body.classList.remove("prompter-open");
  els.prompterOpenBtn.focus();
}

function setPrompterButton(mode) {
  els.prompterPlayBtn.textContent = { start: "▶ Start", pause: "❚❚ Pause", resume: "▶ Resume", again: "↺ Again" }[mode];
}

function prompterAtEnd() {
  const el = els.prompterScroll;
  return el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
}

// Scroll speed comes from words per minute: the text block's height covers all the script's words.
function prompterPixelsPerSecond() {
  return (els.prompterText.offsetHeight / prompter.words) * (readPrefs().prompterWpm / 60);
}

function prompterTick(ts) {
  if (!prompter.playing) return;
  const dt = prompter.lastTs ? Math.min(0.1, (ts - prompter.lastTs) / 1000) : 0;
  prompter.lastTs = ts;
  // Accumulate sub-pixel movement; scrollTop may round fractional writes away.
  prompter.carry += prompterPixelsPerSecond() * dt;
  const whole = Math.floor(prompter.carry);
  if (whole > 0) {
    els.prompterScroll.scrollTop += whole;
    prompter.carry -= whole;
  }
  if (prompterAtEnd()) {
    pausePrompter();
    setPrompterButton("again");
    return;
  }
  prompter.raf = requestAnimationFrame(prompterTick);
}

async function runCountdown() {
  const token = ++prompter.countdownToken;
  els.prompterCountdown.hidden = false;
  for (let n = PROMPTER_COUNTDOWN_FROM; n > 0; n--) {
    els.prompterCountdown.textContent = n;
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (token !== prompter.countdownToken) return false;
  }
  els.prompterCountdown.hidden = true;
  return true;
}

function cancelCountdown() {
  prompter.countdownToken++;
  els.prompterCountdown.hidden = true;
}

async function playPrompter() {
  if (prompter.playing) return;
  const fromTop = prompterAtEnd() || els.prompterScroll.scrollTop === 0;
  if (prompterAtEnd()) els.prompterScroll.scrollTop = 0;
  setPrompterButton("pause");
  if (fromTop && !(await runCountdown())) return;
  prompter.playing = true;
  prompter.lastTs = 0;
  prompter.carry = 0;
  prompter.raf = requestAnimationFrame(prompterTick);
  // Keep a phone's screen from dimming mid-take; unsupported or refused is fine.
  try {
    prompter.wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    prompter.wakeLock = null;
  }
}

function pausePrompter() {
  const wasActive = prompter.playing || !els.prompterCountdown.hidden;
  cancelCountdown();
  prompter.playing = false;
  cancelAnimationFrame(prompter.raf);
  prompter.wakeLock?.release().catch(() => {});
  prompter.wakeLock = null;
  if (wasActive) setPrompterButton("resume");
}

function togglePrompter() {
  if (prompter.playing || !els.prompterCountdown.hidden) pausePrompter();
  else playPrompter();
}

function restartPrompter() {
  pausePrompter();
  els.prompterScroll.scrollTop = 0;
  setPrompterButton("start");
}

function handlePrompterKey(e) {
  const onButton = e.target instanceof HTMLButtonElement;
  const actions = {
    " ": () => !onButton && togglePrompter(),
    Escape: closePrompter,
    ArrowUp: () => stepPrompterSpeed(1),
    ArrowDown: () => stepPrompterSpeed(-1),
    m: () => changePrompterPref({ prompterMirror: !readPrefs().prompterMirror }),
    r: restartPrompter,
  };
  const action = actions[e.key];
  if (!action || (e.key === " " && onButton)) return;
  e.preventDefault();
  action();
}

function initPrompter() {
  els.prompterOpenBtn.addEventListener("click", openPrompter);
  els.prompterCloseBtn.addEventListener("click", closePrompter);
  els.prompterPlayBtn.addEventListener("click", togglePrompter);
  els.prompterRestartBtn.addEventListener("click", restartPrompter);
  els.prompterSlowerBtn.addEventListener("click", () => stepPrompterSpeed(-1));
  els.prompterFasterBtn.addEventListener("click", () => stepPrompterSpeed(1));
  els.prompterSmallerBtn.addEventListener("click", () => stepPrompterSize(-1));
  els.prompterLargerBtn.addEventListener("click", () => stepPrompterSize(1));
  els.prompterMirrorBtn.addEventListener("click", () => changePrompterPref({ prompterMirror: !readPrefs().prompterMirror }));
  // Tapping the script itself pauses/resumes: the natural gesture on a phone propped up to record.
  els.prompterScroll.addEventListener("click", togglePrompter);
  // The OS drops a wake lock when the page is hidden; take it again on return if still playing.
  document.addEventListener("visibilitychange", async () => {
    if (!document.hidden && prompter.playing && !prompter.wakeLock) {
      try {
        prompter.wakeLock = await navigator.wakeLock?.request("screen");
      } catch {
        prompter.wakeLock = null;
      }
    }
  });
}

// --- Keyboard shortcuts ---

function openShortcuts() {
  els.shortcutsDialog.hidden = false;
  els.shortcutsCloseBtn.focus();
}

function closeShortcuts() {
  els.shortcutsDialog.hidden = true;
}

els.shortcutsHintBtn.addEventListener("click", openShortcuts);
els.shortcutsCloseBtn.addEventListener("click", closeShortcuts);
els.shortcutsDialog.addEventListener("click", (e) => {
  if (e.target === els.shortcutsDialog) closeShortcuts();
});

const GO_TO = {
  a: () => setFilter(null, null),
  u: () => setFilter(null, "unread"),
  s: () => setFilter(null, "saved"),
  l: openNotebook,
  d: openDiscover,
};

let awaitingGoTo = false;
let goToTimer = null;

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;

  if (!els.prompter.hidden) {
    handlePrompterKey(e);
    return;
  }

  if (e.key === "Escape" && !els.scriptMenu.hidden) {
    setScriptMenuOpen(false);
    els.scriptMenuBtn.focus();
    return;
  }

  if (e.key === "Escape" && !els.readerPrefs.hidden) {
    setPrefsOpen(false);
    els.readerPrefsBtn.focus();
    return;
  }

  if (!els.shortcutsDialog.hidden) {
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      closeShortcuts();
    }
    return;
  }

  const target = e.target;
  const typing =
    target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
  if (typing) {
    if (e.key === "Escape" && target === els.searchInput) {
      if (els.searchInput.value) {
        els.searchInput.value = "";
        els.searchInput.dispatchEvent(new Event("input"));
      }
      els.searchInput.blur();
    }
    return;
  }

  if (awaitingGoTo) {
    awaitingGoTo = false;
    clearTimeout(goToTimer);
    const go = GO_TO[e.key];
    if (go) {
      e.preventDefault();
      go();
    }
    return;
  }

  // The reader keeps its last article while My List is open; don't act on it from there.
  const inReader = (fn) => () => {
    if (state.view !== "notebook") fn();
  };
  const actions = {
    j: () => moveSelection(1),
    k: () => moveSelection(-1),
    o: inReader(openOriginal),
    s: inReader(toggleSave),
    m: inReader(toggleRead),
    r: refreshAll,
    A: markAllRead,
    "?": openShortcuts,
    "/": () => {
      if (state.view !== "feed") setFilter(state.feedId, state.filter);
      els.searchInput.focus();
    },
    g: () => {
      awaitingGoTo = true;
      clearTimeout(goToTimer);
      goToTimer = setTimeout(() => {
        awaitingGoTo = false;
      }, 1200);
    },
  };
  const action = actions[e.key];
  if (!action) return;
  e.preventDefault();
  action();
});

window.addEventListener("beforeunload", flushProgress);

// --- Reading streak: consecutive local days with at least one article opened ---

const STREAK_DOTS = 7;
const reading = { days: new Map() }; // local "YYYY-MM-DD" -> articles opened that day

function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysAgo(n) {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return date;
}

// A streak stays alive through today even before today's first article.
function currentStreak() {
  let offset = reading.days.has(localDay()) ? 0 : 1;
  let streak = 0;
  while (reading.days.has(localDay(daysAgo(offset)))) {
    streak++;
    offset++;
  }
  return streak;
}

async function loadReadingStats() {
  const { days } = await api("/api/stats/reading");
  reading.days = new Map(days.map((d) => [d.day, d.count]));
  renderStreak();
}

function countReadToday() {
  const today = localDay();
  reading.days.set(today, (reading.days.get(today) ?? 0) + 1);
  renderStreak();
}

function renderStreak() {
  const today = reading.days.get(localDay()) ?? 0;
  const streak = currentStreak();
  els.streakCount.textContent = streak ? `🔥 ${streak}-day streak` : "Start a streak";
  els.streakToday.textContent = today
    ? `${plural(today, "article")} today`
    : streak
      ? "Read one today to keep it"
      : "Read one article today";
  els.streakDots.innerHTML = "";
  for (let i = STREAK_DOTS - 1; i >= 0; i--) {
    const date = daysAgo(i);
    const count = reading.days.get(localDay(date)) ?? 0;
    const dot = document.createElement("span");
    dot.className = `streak-dot${count ? " filled" : ""}${i === 0 ? " today" : ""}`;
    dot.title = `${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${plural(count, "article")}`;
    els.streakDots.append(dot);
  }
  els.streakCard.hidden = false;
}

// --- Staying fresh: the scheduled job adds articles while the app sits open or in the background ---

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const SYNC_ON_RETURN_AFTER_MS = 2 * 60 * 1000;
let lastSyncAt = Date.now();

// Updates counts quietly; new articles are announced rather than shuffled into the list.
async function syncInBackground() {
  lastSyncAt = Date.now();
  const before = totalUnread();
  try {
    await loadFeeds();
    loadContinueReading();
    loadReadingStats().catch(() => {});
    if (state.view !== "notebook") loadScripts().catch(() => {});
  } catch {
    return; // Offline or a blip; the next sync will catch up.
  }
  const arrived = totalUnread() - before;
  if (arrived > 0 && state.view === "feed" && !state.query) {
    els.newArticlesBtn.textContent = `↑ ${plural(arrived, "new article")}`;
    els.newArticlesBtn.hidden = false;
  }
}

els.newArticlesBtn.addEventListener("click", () => loadArticles(true));

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - lastSyncAt > SYNC_ON_RETURN_AFTER_MS) syncInBackground();
});
setInterval(() => {
  if (!document.hidden) syncInBackground();
}, SYNC_INTERVAL_MS);

// --- Database health: migrations are applied by hand, so say exactly which are missing ---

async function checkSchema() {
  let health;
  try {
    health = await api("/api/health");
  } catch {
    return;
  }
  if (health.ok) return;
  els.schemaBannerCommands.textContent = health.missingMigrations
    .map((file) => `npx wrangler d1 execute disciplinefeed-db --remote --file=./migrations/${file}`)
    .join("\n");
  els.schemaBanner.hidden = false;
}

els.schemaBannerCopyBtn.addEventListener("click", async () => {
  try {
    await copyToClipboard(els.schemaBannerCommands.textContent);
    toast("Commands copied");
  } catch (err) {
    toast(err.message, "error");
  }
});
els.schemaBannerCloseBtn.addEventListener("click", () => {
  els.schemaBanner.hidden = true;
});

// --- Offline reading (see sw.js): network-first, with cached copies when the network is gone ---

const PRECACHE_CONCURRENCY = 3;

function setOffline(offline) {
  if (els.offlineBanner.hidden === !offline) return;
  els.offlineBanner.hidden = !offline;
  document.body.classList.toggle("is-offline", offline);
}

window.addEventListener("offline", () => setOffline(true));
window.addEventListener("online", () => {
  setOffline(false);
  syncInBackground();
});

// Resolves to whether the page ended up controlled by the worker, and whether it was already.
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  const wasControlled = Boolean(navigator.serviceWorker.controller);
  try {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
  // The worker claims open pages on activation; wait for that on the very first visit.
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
      setTimeout(resolve, 5000);
    });
  }
  return navigator.serviceWorker.controller ? { wasControlled } : null;
}

// Fetches an article without opening it (no read mark, no streak) so the worker keeps a copy.
async function precacheArticle(id) {
  if (!navigator.serviceWorker?.controller || !navigator.onLine) return;
  const path = `/api/articles/${id}`;
  if (await caches.match(path)) return;
  await fetch(`${path}?peek=1`).catch(() => {});
}

// On a first visit the page loads its data before the worker controls it, so nothing was cached.
// Fetch it again once the worker is in charge (it keeps copies on the way through).
async function warmOfflineCache() {
  const paths = ["/api/feeds", articleListPath(null), "/api/articles?in_progress=true&limit=5", "/api/stats/reading", "/api/scripts"];
  if (scripts.currentId) paths.push(`/api/highlights?script_id=${scripts.currentId}`);
  await Promise.all(paths.map((path) => fetch(path).catch(() => {})));
}

// Saved and in-progress articles are the ones most worth having on a plane; keep copies of them.
async function precacheForOffline() {
  if (!navigator.serviceWorker?.controller || !navigator.onLine) return;
  try {
    const [saved, inProgress] = await Promise.all([
      api("/api/articles?saved=true&limit=50"),
      api("/api/articles?in_progress=true&limit=20"),
    ]);
    const ids = [...new Set([...saved.articles, ...inProgress.articles].map((a) => a.id))];
    let next = 0;
    const worker = async () => {
      while (next < ids.length) await precacheArticle(ids[next++]);
    };
    await Promise.all(Array.from({ length: PRECACHE_CONCURRENCY }, worker));
  } catch {
    // Best effort; the next visit tries again.
  }
}

// --- Init ---

async function init() {
  renderStaticFilters();
  initSelectionCapture();
  initNotebookReorder();
  initScripts();
  initReaderPrefs();
  initPrompter();
  enterMobileScreen("list", "DisciplineFeed");
  checkSchema();
  try {
    await loadFeeds();
    await loadArticles(true);
    await loadContinueReading();
    loadReadingStats().catch(() => {});
    // So the capture button can name the script snippets will go to.
    loadScripts().catch(() => {});
  } catch (err) {
    toast(err.message, "error");
  }
  const worker = await registerServiceWorker();
  if (worker) {
    if (!worker.wasControlled) await warmOfflineCache();
    precacheForOffline();
  }
}

init();
