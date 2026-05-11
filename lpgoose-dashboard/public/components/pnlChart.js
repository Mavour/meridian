function renderPnlChart(container, series, title, type = "line") {
  container.innerHTML = `<div id="chart-${title.replace(/\s+/g, '-')}" style="min-height:300px;"></div>`;
  const el = container.querySelector("div");
  if (!el) return;

  const options = {
    chart: { type, height: 300, background: "transparent", toolbar: { show: false }, animations: { enabled: false } },
    theme: { mode: "dark" },
    colors: ["#6366f1"],
    series: series,
    xaxis: { labels: { style: { colors: "#94a3b8" } } },
    yaxis: { labels: { style: { colors: "#94a3b8" } } },
    grid: { borderColor: "#222222" },
    dataLabels: { enabled: false },
    stroke: { curve: "smooth", width: 2 },
    fill: type === "area" ? { type: "gradient", gradient: { shadeIntensity: 1, opacityFrom: 0.4, opacityTo: 0.05 } } : undefined,
    tooltip: { theme: "dark" },
    legend: { labels: { colors: "#f1f5f9" } },
  };

  new ApexCharts(el, options).render();
}
