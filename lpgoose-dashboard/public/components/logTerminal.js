let logAutoScroll = true;
let logFilterTag = null;
let logSearchQuery = "";
let logLimit = 500;
let logOffset = 0;
let logTotal = 0;
let logDate = new Date().toISOString().split("T")[0];

function renderLogTerminal(container) {
  container.innerHTML = `
    <div class="log-controls">
      <select id="log-date-select"></select>
      <input type="text" id="log-search" placeholder="Search logs..." />
      <button id="log-autoscroll" class="active">Auto-scroll</button>
      <button id="log-refresh">Refresh</button>
      <button id="log-load-more">Load +500</button>
      <span style="color:var(--text-2);font-size:12px;margin-left:auto;">Showing <span id="log-showing">0</span> / <span id="log-total">0</span></span>
    </div>
    <div class="log-controls" id="tag-filters">
      ${['ALL','DEPLOY','CLOSE','STATE','SCREENING','AGENT','CRON','WARN','ERROR','DEBUG'].map(t =>
        `<button class="tag-filter" data-tag="${t}">${t}</button>`
      ).join('')}
    </div>
    <div class="log-terminal" id="log-container"></div>
  `;

  document.getElementById("log-autoscroll").addEventListener("click", (e) => {
    logAutoScroll = !logAutoScroll;
    e.target.classList.toggle("active", logAutoScroll);
  });
  document.getElementById("log-refresh").addEventListener("click", loadLogs);
  document.getElementById("log-load-more").addEventListener("click", () => { logOffset += logLimit; loadLogs(); });
  document.getElementById("log-search").addEventListener("input", (e) => { logSearchQuery = e.target.value.toLowerCase(); filterLogs(); });
  document.getElementById("log-date-select").addEventListener("change", (e) => { logDate = e.target.value; logOffset = 0; loadLogs(); });

  document.querySelectorAll(".tag-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tag = btn.dataset.tag;
      logFilterTag = tag === "ALL" ? null : tag;
      document.querySelectorAll(".tag-filter").forEach((b) => b.classList.remove("active"));
      if (logFilterTag) btn.classList.add("active");
      filterLogs();
    });
  });

  loadLogDates();
  loadLogs();
}

async function loadLogDates() {
  try {
    const dates = await api("/api/log-dates");
    const sel = document.getElementById("log-date-select");
    sel.innerHTML = dates.map((d) => `<option value="${d}" ${d === logDate ? 'selected' : ''}>${d}</option>`).join("");
  } catch {}
}

async function loadLogs() {
  try {
    const data = await api(`/api/logs?date=${logDate}&limit=${logLimit}&offset=${logOffset}`);
    logTotal = data.total;
    cache.logs = data.lines || [];
    document.getElementById("log-showing").textContent = Math.min(logOffset + logLimit, logTotal);
    document.getElementById("log-total").textContent = logTotal;
    filterLogs();
  } catch (err) {
    console.error("[Logs] load failed", err);
  }
}

function filterLogs() {
  const container = document.getElementById("log-container");
  let lines = cache.logs;
  if (logFilterTag) {
    lines = lines.filter((l) => l.tag === logFilterTag);
  }
  if (logSearchQuery) {
    lines = lines.filter((l) => l.message.toLowerCase().includes(logSearchQuery));
  }
  container.innerHTML = lines.map(renderLogLineHTML).join("");
  if (logAutoScroll) container.scrollTop = container.scrollHeight;
}

function renderLogLineHTML(line) {
  const tagClass = `tag-${(line.level || 'debug')}`;
  return `
    <div class="log-line">
      <span class="log-ts">${line.timestamp}</span>
      <span class="log-tag ${tagClass}">${line.tag}</span>
      <span class="log-msg">${escapeHtml(line.message)}</span>
    </div>
  `;
}

function appendLogLine(line) {
  if (line.timestamp?.split("T")[0] !== logDate) return;
  cache.logs.push(line);
  const container = document.getElementById("log-container");
  if (!container) return;

  // Apply filters
  if (logFilterTag && line.tag !== logFilterTag) return;
  if (logSearchQuery && !line.message.toLowerCase().includes(logSearchQuery)) return;

  const div = document.createElement("div");
  div.className = "log-line";
  div.innerHTML = renderLogLineHTML(line);
  container.appendChild(div);
  if (logAutoScroll) container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
