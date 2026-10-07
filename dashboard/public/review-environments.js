/**
 * <review-environments src="/api/environments" refresh="30" project="group/app">
 *
 * Dependency-free web component listing all deployed review environments.
 * Polls the API (ETag revalidation, so unchanged data costs a 304), pauses while
 * the tab is hidden and keeps the last data visible if a request fails.
 * Colors come from the page via CSS custom properties (--fg, --muted, --line, …).
 */

const STYLE = `
  :host { display:block; }
  p.meta { color:var(--muted); margin:0 0 20px; }
  a { color:var(--link); text-decoration:none; }
  a:hover { text-decoration:underline; }
  code { font-size:.85em; }
  svg { flex:none; }

  h2 { grid-column:1 / -1; font-size:1rem; margin:0 0 2px; }
  h2:not(:first-child) { margin-top:24px; }

  /* Desktop: cards share one column grid (subgrid), so they line up like table rows.
     The tracks are set per list in --columns, the title column takes the remaining space. */
  .list { display:grid; grid-template-columns:var(--columns); row-gap:8px; }
  .head, .card { grid-column:1 / -1; display:grid; grid-template-columns:subgrid; align-items:start; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; }
  .cell { padding:10px 12px; white-space:nowrap; min-width:0; }
  .head .cell { padding-block:0 2px; font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .card .cell:not(.main) { overflow:hidden; text-overflow:ellipsis; max-width:220px; }
  .main { white-space:normal; }
  .title { font-weight:500; overflow-wrap:anywhere; }
  .count { font-weight:400; color:var(--muted); font-size:.85rem; white-space:nowrap; }
  .label { display:none; }
  .id { display:flex; flex-direction:column; gap:4px; }
  .ref { font-size:.9em; max-width:200px; overflow:hidden; text-overflow:ellipsis; }

  /* Variants: one framed row per deployment, the variant itself is the primary button */
  /* All rows of a card share one grid (status | button | services & notes), so the buttons
     have the same width and everything after them starts at the same position */
  .variants { margin-top:10px; display:grid; grid-template-columns:auto auto 1fr; }
  .variants { border:1px solid var(--line); border-radius:8px; }
  .variant { grid-column:1 / -1; display:grid; grid-template-columns:subgrid; align-items:center; column-gap:12px; }
  .variant { padding:7px 10px; }
  .variant + .variant { border-top:1px solid var(--line); }
  .extras { display:flex; flex-wrap:wrap; align-items:center; gap:4px 14px; min-width:0; }
  .open { display:flex; align-items:center; gap:7px; min-width:8.5rem; box-sizing:border-box; padding:3px 12px 3px 10px; border-radius:6px;
          background:var(--link); color:var(--card); font-weight:500; font-size:.9rem; white-space:nowrap; }
  a.open:hover { text-decoration:none; filter:brightness(1.1); }
  .open.disabled { background:var(--chip); color:var(--muted); }
  .services { display:flex; flex-wrap:wrap; align-items:center; gap:4px 14px; font-size:.88rem; }
  .service { display:inline-flex; align-items:center; gap:5px; }
  span.service { color:var(--muted); }
  .note { font-size:.85rem; color:var(--muted); }
  .problem { color:var(--bad); font-weight:500; }

  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); flex:none; }
  .dot.running { background:var(--ok); }
  .dot.exited, .dot.dead, .dot.restarting, .dot.missing { background:var(--bad); }

  .list > .empty { grid-column:1 / -1; }
  .empty, .error { padding:24px; color:var(--muted); background:var(--card); border:1px solid var(--line); border-radius:10px; }
  .error { color:var(--bad); }
  p.meta .error { padding:0; background:none; border:0; }

  /* Mobile: stacked cards, title and variants first, details below with labels */
  @media (max-width: 900px) {
    .list { display:flex; flex-direction:column; gap:10px; }
    .head { display:none; }
    .card { display:flex; flex-wrap:wrap; column-gap:16px; padding:10px 14px; min-width:0; }
    .cell { padding:2px 0; }
    .card .cell:not(.main) { max-width:100%; white-space:normal; overflow-wrap:anywhere; }
    .detail.blank { display:none; }
    .main { flex-basis:100%; padding:4px 0 8px; }
    .detail { color:var(--muted); font-size:.9rem; }
    .label { display:inline; margin-right:4px; }
    .id { display:inline-flex; flex-direction:row; flex-wrap:wrap; align-items:baseline; gap:4px 10px; }
    .ref { max-width:100%; }
  }
`;

/** Human readable Docker container states, null for "running" (no note needed). */
const STATES = {
  running: null,
  created: 'not started',
  restarting: 'restarting',
  paused: 'paused',
  exited: 'stopped',
  dead: 'crashed',
  removing: 'being removed',
};

/** Builds an element; children may be nodes, strings or null. Text is never parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined && v !== '') el.setAttribute(k, v);
  }
  el.append(...children.filter((c) => c !== null && c !== undefined));
  return el;
}

/** Small inline SVG icons (currentColor), built via DOM APIs like everything else. */
function icon(name) {
  const paths = {
    play: 'M4 2.5v11l9-5.5z',
    external: 'M6 3H3v10h10v-3M9 2h5v5M14 2 7 9',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', name === 'play' ? '11' : '12');
  svg.setAttribute('height', name === 'play' ? '11' : '12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]);
  if (name === 'play') {
    path.setAttribute('fill', 'currentColor');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(path);
  return svg;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Only allow http(s) links from container labels. */
function safeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function ago(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '–';
  const d = Math.max(0, (Date.now() - t) / 1000);
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

function time(iso) {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? '–' : new Date(t).toLocaleTimeString('en-GB');
}

class ReviewEnvironments extends HTMLElement {
  static observedAttributes = ['src', 'refresh', 'project'];

  #data = null;
  #error = null;
  #timer = null;
  #abort = null;
  #onVisibility = () => (document.hidden ? this.#stop() : this.#load());

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).append(h('style', {}, STYLE), h('div', { part: 'content' }));
  }

  get src() {
    return this.getAttribute('src') ?? '/api/environments';
  }

  /** Optional GitLab project path (CI_PROJECT_PATH), limits the list to this project. */
  get project() {
    return this.getAttribute('project') ?? '';
  }

  /** API URL including the project filter. */
  get url() {
    const url = new URL(this.src, location.href);
    if (this.project) url.searchParams.set('project', this.project);
    return url.href;
  }

  /** Refresh interval in seconds, 0 disables polling. */
  get refresh() {
    const n = Number(this.getAttribute('refresh') ?? 30);
    return Number.isFinite(n) && n > 0 ? Math.max(5, n) : 0;
  }

  connectedCallback() {
    document.addEventListener('visibilitychange', this.#onVisibility);
    this.#render();
    this.#load();
  }

  disconnectedCallback() {
    document.removeEventListener('visibilitychange', this.#onVisibility);
    this.#stop();
  }

  attributeChangedCallback(_name, oldValue, newValue) {
    if (this.isConnected && oldValue !== newValue) this.#load();
  }

  /** Reloads immediately. */
  reload() {
    return this.#load();
  }

  #stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#abort?.abort();
    this.#abort = null;
  }

  async #load() {
    this.#stop();
    const abort = (this.#abort = new AbortController());
    const timeout = setTimeout(() => abort.abort(), 10_000);

    try {
      // "no-cache" revalidates with If-None-Match, unchanged data comes back as 304 from the browser cache
      const res = await fetch(this.url, {
        headers: { Accept: 'application/json' },
        cache: 'no-cache',
        credentials: 'same-origin',
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.#data = await res.json();
      this.#error = this.#data.ok ? null : this.#data.error || 'Docker API unreachable';
    } catch (e) {
      if (abort.signal.aborted && this.#abort !== abort) return; // superseded by a newer load
      this.#error = `Dashboard API unreachable (${e.message})`;
    } finally {
      clearTimeout(timeout);
    }

    if (this.#abort === abort) this.#abort = null;
    this.#render();
    this.dispatchEvent(new CustomEvent('review-environments:loaded', { detail: { data: this.#data, error: this.#error } }));

    if (this.refresh && !document.hidden && this.isConnected) {
      this.#timer = setTimeout(() => this.#load(), this.refresh * 1000);
    }
  }

  #render() {
    const content = this.shadowRoot.querySelector('[part=content]');
    const branches = this.#data?.branches ?? [];
    const envs = this.#data?.environments ?? [];

    if (!this.#data && !this.#error) {
      content.replaceChildren(h('p', { class: 'meta' }, 'Loading …'));
      return;
    }

    const meta = h('p', { class: 'meta' },
      branches.length ? `${plural(branches.length, 'branch deployment', 'branch deployments')} · ` : '',
      `${plural(envs.length, 'merge request environment', 'merge request environments')} · updated ${time(this.#data?.fetched_at)} · `,
      h('a', { href: this.url }, 'JSON'),
    );
    if (this.#error && (branches.length || envs.length)) meta.append(' · ', h('span', { class: 'error' }, this.#error));

    if (!branches.length && !envs.length) {
      content.replaceChildren(meta, this.#error
        ? h('div', { class: 'error' }, this.#error)
        : h('div', { class: 'empty' }, 'No review environments deployed.'));
      return;
    }

    // Both sections share one grid, so their columns line up
    const columns = [
      this.project ? null : ['Project', 'auto'],
      ['ID', 'auto'],
      ['Title & deployments', 'minmax(280px, 1fr)'],
      ['Commit', 'auto'],
      ['Author', 'auto'],
      ['Deployed', 'auto'],
    ].filter(Boolean);
    const head = (idLabel) => h('div', { class: 'head', 'aria-hidden': 'true' },
      ...columns.map(([label]) => h('div', { class: 'cell' }, label === 'ID' ? idLabel : label)));

    const rows = [];
    // Branch deployments are long-lived, so they come first, but only if there are any
    if (branches.length) {
      rows.push(h('h2', {}, 'Protected branches'), head('Branch'),
        ...branches.map((env) => this.#card(env, 'Branch', this.#branch(env.branch, env.app?.branch_url))));
      rows.push(h('h2', {}, 'Merge requests'));
    }
    if (envs.length) {
      rows.push(head('MR'), ...envs.map((env) => {
        const mrUrl = safeUrl(env.app?.mr_url);
        // The source branch is shown below the MR number
        return this.#card(env, 'MR', h('span', { class: 'id' },
          mrUrl ? h('a', { href: mrUrl }, `!${env.mr}`) : `!${env.mr}`,
          env.app?.branch ? h('span', { class: 'ref' }, this.#branch(env.app.branch, env.app.branch_url)) : null,
        ));
      }));
    } else {
      rows.push(h('div', { class: 'empty' }, 'No merge request environments deployed.'));
    }

    content.replaceChildren(meta,
      h('div', { class: 'list', role: 'list', style: `--columns:${columns.map(([, track]) => track).join(' ')}` }, ...rows));
  }

  #card({ project, app, variants = [] }, idLabel, id) {
    const a = app ?? {};
    // Empty details keep their grid cell on desktop, but are hidden on mobile
    const detail = (label, value, attrs = {}) =>
      h('div', { class: value.textContent ?? value ? 'cell detail' : 'cell detail blank', ...attrs }, h('span', { class: 'label' }, `${label}:`), value);

    return h('article', { class: 'card', role: 'listitem' },
      this.project ? null : h('div', { class: 'cell', title: project }, project || '–'),
      h('div', { class: 'cell' }, h('span', { class: 'label' }, idLabel), id),
      h('div', { class: 'cell main' },
        h('div', { class: 'title' },
          app ? a.title : h('i', {}, 'App container missing'),
          variants.length > 1 ? h('span', { class: 'count' }, ` · ${plural(variants.length, 'variant', 'variants')}`) : null,
        ),
        this.#variants(variants, a),
      ),
      detail('Commit', h('code', {}, a.commit ?? '')),
      detail('Author', a.author ?? ''),
      detail('Deployed', a.deployed_at ? ago(a.deployed_at) : '', { title: a.deployed_at }),
    );
  }

  /**
   * One row per variant: status, the variant as primary "open" button, its sub-services as
   * secondary links and notes (not running, older deployment). A single default variant gets
   * an "Open" button instead of its name.
   */
  #variants(variants, current) {
    const single = variants.length === 1 && variants[0].name === '';

    return h('div', { class: 'variants' }, ...variants.map((v) => {
      const label = single ? 'Open' : v.name || 'Default';
      const hint = v.name ? `Variant "${v.name}"` : 'Default deployment (no variant)';
      const state = v.app?.state ?? 'missing';
      const href = safeUrl(v.app?.url);

      const notes = [];
      if (!v.app) notes.push(h('span', { class: 'note problem' }, 'app container missing'));
      else if (STATES[state] !== null) notes.push(h('span', { class: 'note problem', title: v.app.status }, STATES[state] ?? state));
      // The card shows the newest deployment, point out variants still running another commit
      if (v.app && current.commit && v.app.commit !== current.commit) {
        notes.push(h('span', { class: 'note', title: v.app.deployed_at },
          'older deployment: ', h('code', {}, v.app.commit), v.app.deployed_at ? `, ${ago(v.app.deployed_at)}` : ''));
      }

      return h('div', { class: 'variant' },
        h('span', { class: `dot ${state}`, title: v.app?.status || 'app container missing' }),
        href
          ? h('a', { class: 'open', href, title: `${hint} – open ${v.app.url}` }, icon('play'), label)
          : h('span', { class: 'open disabled', title: hint }, icon('play'), label),
        h('div', { class: 'extras' },
          v.services.length ? h('span', { class: 'services' }, ...v.services.map((s) => this.#service(s))) : null,
          ...notes,
        ),
      );
    }));
  }

  /** Sub-service: a secondary link if it has a URL, otherwise only its status. */
  #service({ name, url, state, status }) {
    const href = safeUrl(url);
    const problem = STATES[state] ?? (state === 'running' ? null : state);
    const content = [
      h('span', { class: `dot ${state}` }),
      name,
      problem ? h('span', { class: 'problem' }, ` (${problem})`) : null,
    ];
    return href
      ? h('a', { class: 'service', href, title: status }, ...content, icon('external'))
      : h('span', { class: 'service', title: status }, ...content);
  }

  #branch(name, url) {
    const href = safeUrl(url);
    const code = h('code', { title: name }, name);
    return href ? h('a', { href }, code) : code;
  }
}

customElements.define('review-environments', ReviewEnvironments);
