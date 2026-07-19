/**
 * artgraph — interactive graph frontend.
 *
 * Reads the JSON payload embedded in <script id="artgraph-data"> (populated by
 * the CLI's --serve / --output flow), transforms it into cytoscape elements,
 * and wires up search, node click, and detail-card interactions.
 */
(function () {
  "use strict";

  // ---- Constants -----------------------------------------------------------

  /** Layer -> fill color. Matches the swatches in index.html. */
  const LAYER_COLORS = {
    req: "#58a6ff",
    doc: "#a371f7",
    code: "#3fb950",
    test: "#f0b849",
  };

  /** Layer -> cytoscape node shape. */
  const LAYER_SHAPES = {
    req: "round-rectangle",
    doc: "rectangle",
    code: "ellipse",
    test: "diamond",
  };

  const STATE_STYLES = {
    drift: { borderColor: "#f85149", borderWidth: 3, borderStyle: "solid" },
    orphan: { borderColor: "#d29922", borderWidth: 2, borderStyle: "solid" },
    uncovered: { borderColor: "#7d8590", borderWidth: 2, borderStyle: "dashed" },
    ok: { borderColor: "#1f6feb", borderWidth: 1, borderStyle: "solid" },
  };

  const EMPTY_STATE_MESSAGE_HTML =
    "No graph nodes found. Run <code>pnpm exec artgraph scan</code> first.";

  function styleFor(state) {
    return STATE_STYLES[state] || STATE_STYLES.ok;
  }

  /**
   * Cytoscape stylesheet. Hoisted to module scope so tests can build a
   * headless instance with the exact production styles; the arrow-fn
   * callbacks close over LAYER_COLORS / LAYER_SHAPES / styleFor, so this
   * must be defined after them.
   */
  const STYLE = [
    {
      selector: "node",
      style: {
        "background-color": (ele) => LAYER_COLORS[ele.data("layer")] || "#8b949e",
        shape: (ele) => LAYER_SHAPES[ele.data("layer")] || "ellipse",
        label: "data(label)",
        color: "#e6edf3",
        "font-family": "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
        "font-size": 11,
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 6,
        "text-wrap": "ellipsis",
        "text-max-width": 140,
        "text-outline-color": "#0d1117",
        "text-outline-width": 2,
        width: 36,
        height: 36,
        "border-color": (ele) => styleFor(ele.data("state")).borderColor,
        "border-width": (ele) => styleFor(ele.data("state")).borderWidth,
        "border-style": (ele) => styleFor(ele.data("state")).borderStyle,
      },
    },
    {
      selector: "edge",
      style: {
        width: 1,
        "line-color": "#4a5560",
        "target-arrow-color": "#4a5560",
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        opacity: 0.6,
        "arrow-scale": 0.8,
      },
    },
    {
      // spec 020 FR-021: `exercises` edges are execution EVIDENCE (a tagged
      // green test ran this code), not a declared `implements`/`verifies`
      // intent — dashed line-style keeps that distinction legible at a
      // glance, matching the `state-uncovered` node's dashed border
      // convention above. Declared before the dim/highlight rules so those
      // "hard overlay" selectors still win layering (they don't touch
      // line-style, but keeping the cascade order consistent with the rest
      // of this sheet avoids surprises if they ever do).
      selector: 'edge[kind = "exercises"]',
      style: {
        "line-style": "dashed",
      },
    },
    {
      // Dim rule. Declared BEFORE `.highlighted` and `node.selected` so those
      // "hard overlay" rules win the opacity cascade: a search-dimmed node
      // that is also highlighted or selected (the user tapped it, or it's a
      // focus neighbor) still renders fully visible. `.search-dim` is owned by
      // search + stat-filter (both full recomputes); `.focus-dim` is owned by
      // node-focus (partial add/remove). A node is dimmed if it has either.
      selector: ".search-dim, .focus-dim",
      style: {
        opacity: 0.15,
      },
    },
    {
      // Neighborhood highlight after a node click. `border-style` isn't
      // set here on purpose... except that leaving it unset means a
      // dashed `uncovered` node keeps its dashed style while its color
      // flips to gold — reading as a color the legend never shows.
      // Forcing `solid` keeps "highlighted" visually unambiguous
      // regardless of the underlying node's state.
      selector: ".highlighted",
      style: {
        "border-color": "#f1e05a",
        "border-width": 3,
        "border-style": "solid",
        opacity: 1,
        "line-color": "#f1e05a",
        "target-arrow-color": "#f1e05a",
        "z-index": 10,
      },
    },
    {
      selector: "node.selected",
      style: {
        "border-color": "#f1e05a",
        "border-width": 4,
        "border-style": "solid",
        opacity: 1,
        "shadow-blur": 20,
        "shadow-color": "#f1e05a",
        "shadow-opacity": 0.8,
        "shadow-offset-x": 0,
        "shadow-offset-y": 0,
        "z-index": 20,
      },
    },
  ];

  // ---- Bootstrap -----------------------------------------------------------

  if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", init);

  function init() {
    const data = readEmbeddedData();
    renderMeta(data.meta);

    const cyContainer = document.getElementById("cy");

    if (!data.nodes || data.nodes.length === 0) {
      renderEmptyState(cyContainer);
      return;
    }

    const cy = initCytoscape(cyContainer, data);
    wireSearch(cy);
    wireInteractions(cy);
    wireStatFilters(cy);
  }

  // ---- Data ----------------------------------------------------------------

  function readEmbeddedData() {
    const el = document.getElementById("artgraph-data");
    const fallback = {
      nodes: [],
      edges: [],
      meta: {
        rootDir: "",
        generatedAt: "",
        stats: { total: 0, drift: 0, orphan: 0, uncovered: 0 },
      },
    };
    if (!el) return fallback;
    const raw = (el.textContent || "").trim();
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw);
      // Defensive normalization — accept partial payloads without exploding.
      return {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
        meta: {
          rootDir: (parsed.meta && parsed.meta.rootDir) || "",
          generatedAt: (parsed.meta && parsed.meta.generatedAt) || "",
          stats: {
            total: getStat(parsed, "total"),
            drift: getStat(parsed, "drift"),
            orphan: getStat(parsed, "orphan"),
            uncovered: getStat(parsed, "uncovered"),
          },
        },
      };
    } catch (err) {
      // Leave the console breadcrumb but keep the UI usable.
      // eslint-disable-next-line no-console
      console.error("[artgraph] failed to parse embedded data", err);
      return fallback;
    }
  }

  function getStat(parsed, key) {
    const stats = parsed && parsed.meta && parsed.meta.stats;
    const value = stats && stats[key];
    return typeof value === "number" ? value : 0;
  }

  // ---- Meta / stats panel --------------------------------------------------

  function renderMeta(meta) {
    const rootEl = document.getElementById("meta-root");
    if (rootEl) {
      const root = meta.rootDir || "—";
      rootEl.textContent = root;
      rootEl.title = root;
    }

    const genEl = document.getElementById("meta-generated");
    if (genEl) {
      genEl.textContent = formatTimestamp(meta.generatedAt);
    }

    const stats = meta.stats || { total: 0, drift: 0, orphan: 0, uncovered: 0 };
    setText("stat-total", stats.total);
    setText("stat-drift", stats.drift);
    setText("stat-orphan", stats.orphan);
    setText("stat-uncovered", stats.uncovered);

    const driftTile = document.getElementById("stat-drift-tile");
    if (driftTile) {
      driftTile.classList.toggle("has-drift", (stats.drift || 0) > 0);
    }
  }

  function formatTimestamp(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    try {
      return d.toLocaleString();
    } catch {
      return d.toISOString();
    }
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value == null ? 0 : value);
  }

  // ---- Empty state ---------------------------------------------------------

  function renderEmptyState(container) {
    if (!container) return;
    container.innerHTML = "";
    const div = document.createElement("div");
    div.className = "empty-state";
    div.innerHTML = EMPTY_STATE_MESSAGE_HTML;
    container.appendChild(div);
  }

  // ---- Cytoscape -----------------------------------------------------------

  function initCytoscape(container, data) {
    const elements = buildElements(data);

    // eslint-disable-next-line no-undef
    const cy = cytoscape({
      container: container,
      elements: elements,
      wheelSensitivity: 2, // larger = more zoom per scroll notch (cytoscape default is 1)
      style: STYLE,
      layout: {
        name: "cose",
        animate: false,
        nodeRepulsion: 8000,
        idealEdgeLength: 100,
        nodeOverlap: 20,
        fit: true,
        padding: 40,
      },
    });

    // Belt-and-suspenders fit after the initial layout — cose's fit:true is
    // usually enough, but explicit fit keeps us robust to layout timing quirks.
    cy.ready(() => cy.fit(cy.elements(), 40));

    return cy;
  }

  function buildElements(data) {
    const nodes = data.nodes.map((n) => ({
      group: "nodes",
      data: {
        id: n.id,
        label: n.label != null ? String(n.label) : n.id,
        layer: n.layer,
        kind: n.kind,
        state: n.state,
        filePath: n.filePath,
      },
    }));

    const edges = data.edges.map((e) => ({
      group: "edges",
      data: {
        id: e.source + "->" + e.target + "->" + e.kind,
        source: e.source,
        target: e.target,
        kind: e.kind,
      },
    }));

    return nodes.concat(edges);
  }

  // ---- Search --------------------------------------------------------------

  /** Deactivates any stat-tile filter — called whenever search or node-click
   * interaction takes over the dim state, so the tile's visual "active" state
   * never lingers after something else has changed what's shown. */
  function clearStatTileActive() {
    document.querySelectorAll(".stat-tile.active").forEach((t) => t.classList.remove("active"));
  }

  /**
   * Recomputes the search dim from scratch: with an empty query nothing is
   * search-dimmed; otherwise every node whose id/label doesn't match the query
   * is search-dimmed, and every edge that doesn't connect two matching nodes.
   * Owns `.search-dim` only — the focus overlay's `.focus-dim` is untouched.
   */
  function applySearch(cy, query) {
    if (!query) {
      cy.elements().removeClass("search-dim");
      return;
    }

    cy.batch(() => {
      cy.nodes().forEach((node) => {
        const id = String(node.data("id") || "").toLowerCase();
        const label = String(node.data("label") || "").toLowerCase();
        const match = id.includes(query) || label.includes(query);
        node.toggleClass("search-dim", !match);
      });
      // Dim edges that don't connect two matching nodes.
      cy.edges().forEach((edge) => {
        const s = edge.source();
        const t = edge.target();
        const bothMatch = !s.hasClass("search-dim") && !t.hasClass("search-dim");
        edge.toggleClass("search-dim", !bothMatch);
      });
    });
  }

  function wireSearch(cy) {
    const input = document.getElementById("search-input");
    if (!input) return;

    input.addEventListener("input", () => {
      const query = input.value.trim().toLowerCase();
      clearStatTileActive();
      applySearch(cy, query);
    });
  }

  // ---- Stat tile filters -----------------------------------------------

  /**
   * Recomputes the stat-tile dim from scratch: every node whose state !==
   * the selected state is dimmed, plus every edge that isn't between two
   * visible nodes. Shares the same `.search-dim` class as search — both do a
   * full recompute, so they can safely own it together.
   */
  function applyStatFilter(cy, state) {
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        node.toggleClass("search-dim", node.data("state") !== state);
      });
      cy.edges().forEach((edge) => {
        const bothVisible =
          !edge.source().hasClass("search-dim") && !edge.target().hasClass("search-dim");
        edge.toggleClass("search-dim", !bothVisible);
      });
    });
  }

  /**
   * Clicking a stat tile (Drift / Orphan / Uncovered) isolates nodes in
   * that state by dimming everything else. Clicking the active tile again —
   * or the Total tile — clears back to showing everything.
   *
   * Dim ownership (issue #171): search and node-focus now use *separate*
   * classes — `.search-dim` (full recompute) vs `.focus-dim` (partial
   * add/remove) — so they no longer clobber each other. The stat filter
   * shares `.search-dim` with search (both are full recomputes) and still
   * resets everything first (`.search-dim .focus-dim highlighted selected`),
   * so it never fights the focus overlay.
   */
  function wireStatFilters(cy) {
    const tiles = Array.from(document.querySelectorAll(".stat-tile[data-state]"));
    if (tiles.length === 0) return;

    tiles.forEach((tile) => {
      tile.addEventListener("click", () => {
        const state = tile.dataset.state || "";
        const wasActive = tile.classList.contains("active");

        tiles.forEach((t) => t.classList.remove("active"));
        cy.elements().removeClass("search-dim focus-dim highlighted selected");
        const searchInput = document.getElementById("search-input");
        if (searchInput) searchInput.value = "";

        // Toggling off the already-active tile, or clicking Total, both
        // mean "show everything" — nothing left to do once cleared above.
        if (wasActive || !state) return;

        tile.classList.add("active");
        applyStatFilter(cy, state);
      });
    });
  }

  // ---- Node focus ----------------------------------------------------------

  function focusNeighborhood(cy, node) {
    const neighborhood = node.closedNeighborhood();
    cy.batch(() => {
      cy.elements().addClass("focus-dim").removeClass("highlighted selected");
      neighborhood.removeClass("focus-dim").addClass("highlighted");
      node.addClass("selected");
    });
  }

  function clearFocus(cy) {
    // Only tear down the focus overlay. Any `.search-dim` from an active
    // search or stat filter persists independently, so removing `.focus-dim`
    // naturally falls back to whatever search/stat filter was in effect.
    cy.elements().removeClass("focus-dim highlighted selected");
  }

  // ---- Node click / details ------------------------------------------------

  function wireInteractions(cy) {
    const detailsCard = document.getElementById("details-card");
    const closeBtn = document.getElementById("details-close");

    cy.on("tap", "node", (evt) => {
      const node = evt.target;
      clearStatTileActive();
      focusNeighborhood(cy, node);
      showDetails(node.data());
    });

    cy.on("tap", (evt) => {
      // Background click (target === cy)
      if (evt.target === cy) {
        clearFocus(cy);
        hideDetails();
      }
    });

    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        clearFocus(cy);
        hideDetails();
      });
    }

    function showDetails(d) {
      if (!detailsCard) return;
      setText("details-title", d.label || d.id || "—");
      setText("details-id", d.id || "—");
      setText("details-label", d.label || "—");
      setText("details-layer", d.layer || "—");
      setText("details-kind", d.kind || "—");
      setText("details-state", d.state || "—");
      setText("details-path", d.filePath || "—");
      detailsCard.classList.add("visible");
    }

    function hideDetails() {
      if (detailsCard) detailsCard.classList.remove("visible");
    }
  }

  if (typeof process !== "undefined" && process.env && process.env.VITEST) {
    globalThis.__artgraphGraphApp = {
      STYLE,
      buildElements,
      applySearch,
      applyStatFilter,
      focusNeighborhood,
      clearFocus,
    };
  }
})();
