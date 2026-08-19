const state = {
  view: "feed", // 'feed' | 'notebook' | 'discover'
  feedId: null,
  filter: null, // 'unread' | 'saved' | null
  cursor: null,
  articles: [],
  selectedId: null,
};

let currentArticleContext = null; // {id, title, url, feedTitle} of the article currently open in the reader
let readerScrollHandler = null;
let progressSaveTimer = null;
let pendingProgress = null; // { id, value }

function flushProgress() {
  clearTimeout(progressSaveTimer);
  if (!pendingProgress) return;
  const { id, value } = pendingProgress;
  pendingProgress = null;
  api(`/api/articles/${id}/progress`, { method: "PATCH", body: JSON.stringify({ progress: value }) }).catch(() => {});
}

function scheduleProgressSave(id, value) {
  pendingProgress = { id, value };
  clearTimeout(progressSaveTimer);
  progressSaveTimer = setTimeout(flushProgress, 1000);
}

const els = {
  feedList: document.getElementById("feedList"),
  addFeedForm: document.getElementById("addFeedForm"),
  feedUrlInput: document.getElementById("feedUrlInput"),
  addFeedError: document.getElementById("addFeedError"),
  articleListPane: document.getElementById("articleListPane"),
  articleList: document.getElementById("articleList"),
  loadMoreBtn: document.getElementById("loadMoreBtn"),
  emptyState: document.getElementById("emptyState"),
  refreshAllBtn: document.getElementById("refreshAllBtn"),
  readerPane: document.getElementById("readerPane"),
  readerEmpty: document.getElementById("readerEmpty"),
  reader: document.getElementById("reader"),
  readerTitle: document.getElementById("readerTitle"),
  readerFeed: document.getElementById("readerFeed"),
  readerAuthor: document.getElementById("readerAuthor"),
  readerDate: document.getElementById("readerDate"),
  readerReadingTime: document.getElementById("readerReadingTime"),
  readerProgressFill: document.getElementById("readerProgressFill"),
  readerSourceLink: document.getElementById("readerSourceLink"),
  readerBody: document.getElementById("readerBody"),
  saveBtn: document.getElementById("saveBtn"),
  myListNavBtn: document.getElementById("myListNavBtn"),
  discoverNavBtn: document.getElementById("discoverNavBtn"),
  topicsBar: document.getElementById("topicsBar"),
  topicAddForm: document.getElementById("topicAddForm"),
  topicAddInput: document.getElementById("topicAddInput"),
  topicChips: document.getElementById("topicChips"),
  discoverEmptyState: document.getElementById("discoverEmptyState"),
  notebookPane: document.getElementById("notebookPane"),
  notebookAddForm: document.getElementById("notebookAddForm"),
  notebookAddInput: document.getElementById("notebookAddInput"),
  notebookList: document.getElementById("notebookList"),
  notebookEmpty: document.getElementById("notebookEmpty"),
  mobileMenuBtn: document.getElementById("mobileMenuBtn"),
  mobileBackBtn: document.getElementById("mobileBackBtn"),
  mobileBackdrop: document.getElementById("mobileBackdrop"),
  mobileTitle: document.getElementById("mobileTitle"),
  sidebar: document.querySelector(".sidebar"),
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
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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

// --- Sidebar (built-in filters + feeds) ---

function renderStaticFilters() {
  const items = document.querySelectorAll(".sidebar > .feed-list:first-of-type .feed-item");
  items[0].onclick = () => setFilter(null, null);
  items[1].onclick = () => setFilter(null, "unread");
  items[2].onclick = () => setFilter(null, "saved");
  els.myListNavBtn.onclick = () => {
    flushProgress();
    setView("notebook");
    enterMobileScreen("notebook", "My List");
  };
  els.discoverNavBtn.onclick = () => {
    flushProgress();
    setView("discover");
    loadArticles(true);
    enterMobileScreen("list", "Discover");
  };
  updateStaticFilterActive();
}

function updateStaticFilterActive() {
  const items = document.querySelectorAll(".sidebar > .feed-list:first-of-type .feed-item");
  const inFeed = state.view === "feed";
  items[0].classList.toggle("active", inFeed && state.feedId === null && state.filter === null);
  items[1].classList.toggle("active", inFeed && state.feedId === null && state.filter === "unread");
  items[2].classList.toggle("active", inFeed && state.feedId === null && state.filter === "saved");
  els.myListNavBtn.classList.toggle("active", state.view === "notebook");
  els.discoverNavBtn.classList.toggle("active", state.view === "discover");
}

// --- View switching (feed vs. notebook) + mobile single-pane navigation ---

function setView(view) {
  state.view = view;
  const inFeedLike = view === "feed" || view === "discover";
  els.articleListPane.hidden = !inFeedLike;
  els.readerPane.hidden = !inFeedLike;
  els.notebookPane.hidden = view !== "notebook";
  els.topicsBar.hidden = view !== "discover";
  if (view === "notebook") loadHighlights();
  if (view === "discover") loadTopics();
  updateStaticFilterActive();
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
    enterMobileScreen("list", "DisciplineFeed");
  }
});

async function loadFeeds() {
  const feeds = await api("/api/feeds");
  els.feedList.innerHTML = "";
  for (const feed of feeds) {
    const btn = document.createElement("button");
    btn.className = "feed-item";
    btn.classList.toggle("active", state.feedId === feed.id);
    btn.innerHTML = `
      <span class="feed-avatar" style="background:${avatarColor(feed.title)}">${avatarInitial(feed.title)}</span>
      <span>${escapeHtml(feed.title)}</span>
      <button class="remove-feed" title="Unsubscribe">✕</button>
    `;
    btn.querySelector("span:not(.feed-avatar)").onclick = () => setFilter(feed.id, null);
    btn.querySelector(".remove-feed").onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove "${feed.title}" and its articles?`)) return;
      await api(`/api/feeds/${feed.id}`, { method: "DELETE" });
      if (state.feedId === feed.id) setFilter(null, null);
      else loadFeeds();
    };
    els.feedList.appendChild(btn);
  }
}

function setFilter(feedId, filter) {
  flushProgress();
  setView("feed");
  state.feedId = feedId;
  state.filter = filter;
  updateStaticFilterActive();
  document
    .querySelectorAll("#feedList .feed-item")
    .forEach((el) => el.classList.toggle("active", feedId !== null));
  loadArticles(true);
  enterMobileScreen("list", "DisciplineFeed");
}

// --- Add feed ---

els.addFeedForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = els.feedUrlInput.value.trim();
  if (!url) return;
  els.addFeedError.hidden = true;
  const submitBtn = els.addFeedForm.querySelector("button");
  submitBtn.disabled = true;
  try {
    await api("/api/feeds", { method: "POST", body: JSON.stringify({ url }) });
    els.feedUrlInput.value = "";
    await loadFeeds();
    await loadArticles(true);
  } catch (err) {
    els.addFeedError.textContent = err.message;
    els.addFeedError.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

// --- Article list ---

async function loadArticles(reset) {
  if (reset) {
    state.cursor = null;
    state.articles = [];
    els.articleList.innerHTML = "";
  }

  if (state.view === "discover") {
    const data = await api("/api/discover");
    state.articles = data.articles;
    renderArticleList(data.articles, false);
    els.loadMoreBtn.hidden = true;
    els.emptyState.hidden = true;
    els.discoverEmptyState.hidden = data.articles.length > 0;
    return;
  }

  const params = new URLSearchParams();
  if (state.feedId) params.set("feed_id", state.feedId);
  if (state.filter === "unread") params.set("unread", "true");
  if (state.filter === "saved") params.set("saved", "true");
  if (state.cursor) params.set("cursor", state.cursor);

  const data = await api(`/api/articles?${params.toString()}`);
  state.articles.push(...data.articles);
  state.cursor = data.nextCursor;
  renderArticleList(data.articles, !reset);
  els.loadMoreBtn.hidden = data.nextCursor === null;
  els.discoverEmptyState.hidden = true;
  els.emptyState.hidden = state.articles.length > 0;
}

function renderArticleList(articles, append) {
  if (!append) els.articleList.innerHTML = "";
  for (const a of articles) {
    const item = document.createElement("div");
    item.className = `article-item ${a.is_read ? "read" : ""}`;
    item.dataset.id = a.id;
    item.classList.toggle("selected", state.selectedId === a.id);
    const scoreBadge = state.view === "discover" ? `<span class="discover-score">🔥 ${a.score}</span>` : "";
    item.innerHTML = `
      <div class="article-source">
        ${a.is_read ? "" : '<span class="unread-dot"></span>'}
        <span>${escapeHtml(a.feed_title)} · ${formatRelative(a.published_at)}</span>
        ${scoreBadge}
      </div>
      <p class="article-title">${escapeHtml(a.title)}</p>
      <p class="article-summary">${escapeHtml(a.summary || "")}</p>
      ${a.progress > 0.02 && a.progress < 0.95 ? `<div class="article-progress"><div class="article-progress-fill" style="width:${Math.round(a.progress * 100)}%"></div></div>` : ""}
    `;
    item.addEventListener("click", () => selectArticle(a.id));
    els.articleList.appendChild(item);
  }
}

els.loadMoreBtn.addEventListener("click", () => loadArticles(false));
els.refreshAllBtn.addEventListener("click", async () => {
  els.refreshAllBtn.classList.add("active");
  try {
    await api("/api/refresh", { method: "POST" });
    await loadArticles(true);
  } finally {
    els.refreshAllBtn.classList.remove("active");
  }
});

// --- Discover (topic-ranked "badass articles" across all subscriptions) ---

async function loadTopics() {
  const topics = await api("/api/topics");
  renderTopicChips(topics);
}

function renderTopicChips(topics) {
  els.topicChips.innerHTML = "";
  for (const t of topics) {
    const chip = document.createElement("span");
    chip.className = "topic-chip";
    chip.innerHTML = `<span>${escapeHtml(t.keyword)}</span><button title="Stop tracking">✕</button>`;
    chip.querySelector("button").onclick = async () => {
      await api(`/api/topics/${t.id}`, { method: "DELETE" });
      chip.remove();
      loadArticles(true);
    };
    els.topicChips.appendChild(chip);
  }
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
    alert(err.message);
  }
});

// --- Reader ---

async function selectArticle(id) {
  flushProgress();
  state.selectedId = id;
  document.querySelectorAll(".article-item").forEach((el) => {
    el.classList.toggle("selected", Number(el.dataset.id) === id);
  });

  const article = await api(`/api/articles/${id}`);
  const listItem = document.querySelector(`.article-item[data-id="${id}"]`);
  if (listItem) {
    listItem.classList.add("read");
    listItem.querySelector(".unread-dot")?.remove();
  }

  els.readerEmpty.hidden = true;
  els.reader.hidden = false;
  els.readerTitle.textContent = article.title;
  els.readerFeed.textContent = article.feed_title;
  els.readerAuthor.textContent = article.author || "";
  els.readerDate.textContent = formatDate(article.published_at);
  els.readerSourceLink.href = isSafeHttpUrl(article.url) ? article.url : "#";
  els.readerBody.innerHTML = article.content_html || `<p>${escapeHtml(article.summary || "No preview available.")}</p>`;
  els.readerReadingTime.textContent = estimateReadingTime(article.content_html || article.summary);
  updateSaveBtn(!!article.is_saved);
  els.saveBtn.onclick = async () => {
    const res = await api(`/api/articles/${id}/save`, { method: "POST" });
    updateSaveBtn(res.is_saved);
  };

  currentArticleContext = { id: article.id, title: article.title, url: article.url, feedTitle: article.feed_title };
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

function updateSaveBtn(saved) {
  els.saveBtn.querySelector(".save-icon").textContent = saved ? "★" : "☆";
  els.saveBtn.lastChild.textContent = saved ? " Saved" : " Save";
  els.saveBtn.classList.toggle("active", saved);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
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

async function loadHighlights() {
  const highlights = await api("/api/highlights");
  els.notebookList.innerHTML = "";
  els.notebookEmpty.hidden = highlights.length > 0;
  for (const h of highlights) renderHighlightItem(h);
}

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
  const source = document.createElement("span");
  source.textContent = h.article_title ? `${h.feed_title ? `${h.feed_title} — ` : ""}${h.article_title}` : "Note";
  source.title = source.textContent;
  const removeBtn = document.createElement("button");
  removeBtn.className = "remove-highlight";
  removeBtn.title = "Remove";
  removeBtn.textContent = "✕";
  meta.append(source, removeBtn);

  item.append(textarea, meta);
  els.notebookList.appendChild(item);
  requestAnimationFrame(() => autoGrow(textarea));

  let saveTimer;
  textarea.addEventListener("input", () => {
    autoGrow(textarea);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const text = textarea.value.trim();
      if (!text) return;
      await api(`/api/highlights/${h.id}`, { method: "PATCH", body: JSON.stringify({ text }) });
    }, 600);
  });

  removeBtn.addEventListener("click", async () => {
    await api(`/api/highlights/${h.id}`, { method: "DELETE" });
    item.remove();
    els.notebookEmpty.hidden = els.notebookList.children.length > 0;
  });
}

els.notebookAddForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.notebookAddInput.value.trim();
  if (!text) return;
  const created = await api("/api/highlights", { method: "POST", body: JSON.stringify({ text }) });
  els.notebookAddInput.value = "";
  els.notebookEmpty.hidden = true;
  renderHighlightItem(created);
});

// --- Text selection → "Add to my list" ---

function initSelectionCapture() {
  const btn = document.createElement("button");
  btn.className = "selection-add-btn";
  btn.textContent = "+ Add to my list";
  btn.hidden = true;
  document.body.appendChild(btn);

  document.addEventListener("mouseup", (e) => {
    if (e.target === btn) return;
    const sel = window.getSelection();
    const text = sel && sel.toString().trim();
    if (!text || !sel.rangeCount || !els.readerBody.contains(sel.anchorNode)) {
      btn.hidden = true;
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - 75), window.innerWidth - 158);
    btn.style.left = `${left}px`;
    btn.style.top = `${Math.max(8, rect.top - 40)}px`;
    btn.hidden = false;
    btn.dataset.text = text;
  });

  document.addEventListener("mousedown", (e) => {
    if (e.target !== btn) btn.hidden = true;
  });

  btn.addEventListener("click", async () => {
    const text = btn.dataset.text;
    if (!text) return;
    btn.hidden = true;
    try {
      await api("/api/highlights", {
        method: "POST",
        body: JSON.stringify({
          text,
          articleId: currentArticleContext?.id ?? null,
          articleTitle: currentArticleContext?.title ?? null,
          articleUrl: currentArticleContext?.url ?? null,
          feedTitle: currentArticleContext?.feedTitle ?? null,
        }),
      });
    } catch (err) {
      alert(err.message);
    }
  });
}

window.addEventListener("beforeunload", flushProgress);

// --- Init ---

renderStaticFilters();
initSelectionCapture();
enterMobileScreen("list", "DisciplineFeed");
loadFeeds();
loadArticles(true);
