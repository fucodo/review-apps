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
  code { font-size:.85em; }

  section + section { margin-top:32px; }
  h2 { font-size:1rem; margin:0 0 10px; }

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
  .label { display:none; }

  .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .chip { display:inline-flex; align-items:center; gap:6px; padding:2px 10px; border-radius:999px; background:var(--chip); font-size:.85rem; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); flex:none; }
  .running .dot { background:var(--ok); }
  .exited .dot, .dead .dot, .restarting .dot { background:var(--bad); }

  .empty, .error { padding:24px; color:var(--muted); background:var(--card); border:1px solid var(--line); border-radius:10px; }
  .error { color:var(--bad); }
  p.meta .error { padding:0; background:none; border:0; }

  /* Mobile: stacked cards, title and service links first, details below with labels */
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
  }
`;

/** Builds an element; children may be nodes, strings or null. Text is never parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined && v !== '') el.setAttribute(k, v);
  }
  el.append(...children.filter((c) => c !== null && c !== undefined));
  return el;
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
  return Number.isNaN(t) ? '–' : new Date(t).toLocaleTimeString('de-DE');
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
      this.#error = this.#data.ok ? null : this.#data.error || 'Docker-API nicht erreichbar';
    } catch (e) {
      if (abort.signal.aborted && this.#abort !== abort) return; // superseded by a newer load
      this.#error = `Dashboard-API nicht erreichbar (${e.message})`;
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
      content.replaceChildren(h('p', { class: 'meta' }, 'Lade …'));
      return;
    }

    const meta = h('p', { class: 'meta' },
      branches.length ? `${branches.length} Branch-Deployment(s) · ` : '',
      `${envs.length} MR-Umgebung(en) · Stand ${time(this.#data?.fetched_at)} · `,
      h('a', { href: this.url }, 'JSON'),
    );
    if (this.#error && (branches.length || envs.length)) meta.append(' · ', h('span', { class: 'error' }, this.#error));

    let mrBody;
    if (!envs.length) {
      mrBody = this.#error && !branches.length
        ? h('div', { class: 'error' }, this.#error)
        : h('div', { class: 'empty' }, branches.length ? 'Keine MR-Umgebungen deployt.' : 'Keine Review-Umgebungen deployt.');
    } else {
      mrBody = this.#list(envs, 'MR', (env) => {
        const mrUrl = safeUrl(env.app?.mr_url);
        return mrUrl ? h('a', { href: mrUrl }, `!${env.mr}`) : `!${env.mr}`;
      }, true);
    }

    content.replaceChildren(
      meta,
      // Branch deployments are long-lived, so they come first, but only if there are any
      branches.length
        ? h('section', {}, h('h2', {}, 'Protected Branches'), this.#list(branches, 'Branch', (env) => this.#branch(env.branch, env.app?.branch_url), false))
        : '',
      h('section', {}, branches.length ? h('h2', {}, 'Merge Requests') : '', mrBody),
    );
  }

  /**
   * Renders a list of cards. The first column identifies the environment (MR or branch),
   * withBranch adds a separate branch column (MRs only, for branches it is the identifier).
   */
  #list(items, idLabel, id, withBranch) {
    // The project column is redundant when filtered to a single project
    const columns = [
      this.project ? null : ['Projekt', 'auto'],
      [idLabel, 'auto'],
      ['Titel & Dienste', 'minmax(240px, 1fr)'],
      withBranch ? ['Branch', 'auto'] : null,
      ['Commit', 'auto'],
      ['Autor', 'auto'],
      ['Deployt', 'auto'],
    ].filter(Boolean);

    return h('div', { class: 'list', role: 'list', style: `--columns:${columns.map(([, track]) => track).join(' ')}` },
      h('div', { class: 'head', 'aria-hidden': 'true' }, ...columns.map(([label]) => h('div', { class: 'cell' }, label))),
      ...items.map((env) => this.#card(env, id(env), withBranch)),
    );
  }

  #card({ project, app, services }, id, withBranch) {
    const a = app ?? {};
    // Empty details keep their grid cell on desktop, but are hidden on mobile
    const detail = (label, value, attrs = {}) =>
      h('div', { class: value.textContent ?? value ? 'cell detail' : 'cell detail blank', ...attrs }, h('span', { class: 'label' }, `${label}:`), value);

    return h('article', { class: 'card', role: 'listitem' },
      this.project ? null : h('div', { class: 'cell', title: project }, project || '–'),
      h('div', { class: 'cell' }, id),
      h('div', { class: 'cell main' },
        h('div', { class: 'title' }, app ? a.title : h('i', {}, 'App-Container fehlt')),
        h('div', { class: 'chips' },
          app ? this.#chip('App', a) : null,
          ...services.map((s) => this.#chip(s.name, s)),
        ),
      ),
      withBranch ? detail('Branch', this.#branch(a.branch ?? '', a.branch_url), { title: a.branch }) : null,
      detail('Commit', h('code', {}, a.commit ?? '')),
      detail('Autor', a.author ?? ''),
      detail('Deployt', a.deployed_at ? ago(a.deployed_at) : '', { title: a.deployed_at }),
    );
  }

  #branch(name, url) {
    const href = safeUrl(url);
    const code = h('code', { title: name }, name);
    return href ? h('a', { href }, code) : code;
  }

  #chip(label, { url, state, status }) {
    const href = safeUrl(url ?? '');
    const attrs = { class: `chip ${state ?? 'unknown'}`, title: status };
    return href
      ? h('a', { ...attrs, href }, h('span', { class: 'dot' }), label)
      : h('span', attrs, h('span', { class: 'dot' }), label);
  }
}

customElements.define('review-environments', ReviewEnvironments);
