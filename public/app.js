const state = {
  feedId: null,
  filter: null, // 'unread' | 'saved' | null
  cursor: null,
  articles: [],
  selectedId: null,
};

const els = {
  feedList: document.getElementById("feedList"),
  addFeedForm: document.getElementById("addFeedForm"),
  feedUrlInput: document.getElementById("feedUrlInput"),
  addFeedError: document.getElementById("addFeedError"),
  articleList: document.getElementById("articleList"),
  loadMoreBtn: document.getElementById("loadMoreBtn"),
  emptyState: document.getElementById("emptyState"),
  refreshAllBtn: document.getElementById("refreshAllBtn"),
  readerEmpty: document.getElementById("readerEmpty"),
  reader: document.getElementById("reader"),
  readerTitle: document.getElementById("readerTitle"),
  readerFeed: document.getElementById("readerFeed"),
  readerAuthor: document.getElementById("readerAuthor"),
  readerDate: document.getElementById("readerDate"),
  readerSourceLink: document.getElementById("readerSourceLink"),
  readerBody: document.getElementById("readerBody"),
  saveBtn: document.getElementById("saveBtn"),
};

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

// --- Sidebar (built-in filters + feeds) ---

function renderStaticFilters() {
  const items = document.querySelectorAll(".sidebar > .feed-list:first-of-type .feed-item");
  items[0].onclick = () => setFilter(null, null);
  items[1].onclick = () => setFilter(null, "unread");
  items[2].onclick = () => setFilter(null, "saved");
  updateStaticFilterActive();
}

function updateStaticFilterActive() {
  const items = document.querySelectorAll(".sidebar > .feed-list:first-of-type .feed-item");
  items[0].classList.toggle("active", state.feedId === null && state.filter === null);
  items[1].classList.toggle("active", state.feedId === null && state.filter === "unread");
  items[2].classList.toggle("active", state.feedId === null && state.filter === "saved");
}

async function loadFeeds() {
  const feeds = await api("/api/feeds");
  els.feedList.innerHTML = "";
  for (const feed of feeds) {
    const btn = document.createElement("button");
    btn.className = "feed-item";
    btn.classList.toggle("active", state.feedId === feed.id);
    btn.innerHTML = `<span>${escapeHtml(feed.title)}</span><button class="remove-feed" title="Unsubscribe">✕</button>`;
    btn.querySelector("span").onclick = () => setFilter(feed.id, null);
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
  state.feedId = feedId;
  state.filter = filter;
  updateStaticFilterActive();
  document
    .querySelectorAll("#feedList .feed-item")
    .forEach((el, i) => el.classList.toggle("active", feedId !== null));
  loadArticles(true);
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
  els.emptyState.hidden = state.articles.length > 0;
}

function renderArticleList(articles, append) {
  if (!append) els.articleList.innerHTML = "";
  for (const a of articles) {
    const item = document.createElement("div");
    item.className = `article-item ${a.is_read ? "read" : ""}`;
    item.dataset.id = a.id;
    item.classList.toggle("selected", state.selectedId === a.id);
    item.innerHTML = `
      <div class="article-source">
        ${a.is_read ? "" : '<span class="unread-dot"></span>'}
        <span>${escapeHtml(a.feed_title)} · ${formatDate(a.published_at)}</span>
      </div>
      <p class="article-title">${escapeHtml(a.title)}</p>
      <p class="article-summary">${escapeHtml(a.summary || "")}</p>
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

// --- Reader ---

async function selectArticle(id) {
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
  els.readerSourceLink.href = article.url;
  els.readerBody.innerHTML = article.content_html || `<p>${escapeHtml(article.summary || "No preview available.")}</p>`;
  els.saveBtn.textContent = article.is_saved ? "★" : "☆";
  els.saveBtn.classList.toggle("active", !!article.is_saved);
  els.saveBtn.onclick = async () => {
    const res = await api(`/api/articles/${id}/save`, { method: "POST" });
    els.saveBtn.textContent = res.is_saved ? "★" : "☆";
    els.saveBtn.classList.toggle("active", res.is_saved);
  };
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// --- Init ---

renderStaticFilters();
loadFeeds();
loadArticles(true);
