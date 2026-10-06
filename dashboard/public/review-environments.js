/**
 * <review-environments src="/api/environments" refresh="30">
 *
 * Dependency-free web component listing all deployed review environments.
 * Polls the API (ETag revalidation, so unchanged data costs a 304), pauses while
 * the tab is hidden and keeps the last data visible if a request fails.
 * Colors come from the page via CSS custom properties (--fg, --muted, --line, …).
 */

const STYLE = `
  :host { display:block; }
  p.meta { color:var(--muted); margin:0 0 20px; }
  .wrap { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:10px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); white-space:nowrap; vertical-align:top; }
  td.title { white-space:normal; min-width:240px; }
  tr:last-child td { border-bottom:0; }
  th { font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  a { color:var(--link); text-decoration:none; }
  code { font-size:.85em; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; white-space:normal; min-width:200px; }
  .chip { display:inline-flex; align-items:center; gap:6px; padding:2px 10px; border-radius:999px; background:var(--chip); font-size:.85rem; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); flex:none; }
  .running .dot { background:var(--ok); }
  .exited .dot, .dead .dot, .restarting .dot { background:var(--bad); }
  .empty, .error { padding:24px; color:var(--muted); }
  .error { color:var(--bad); }
  p.meta .error { padding:0; }
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
  static observedAttributes = ['src', 'refresh'];

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
      const res = await fetch(this.src, {
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
    const envs = this.#data?.environments ?? [];

    if (!this.#data && !this.#error) {
      content.replaceChildren(h('p', { class: 'meta' }, 'Lade …'));
      return;
    }

    const meta = h('p', { class: 'meta' },
      `${envs.length} Umgebung(en) · Stand ${time(this.#data?.fetched_at)} · `,
      h('a', { href: this.src }, 'JSON'),
    );
    if (this.#error && envs.length) meta.append(' · ', h('span', { class: 'error' }, this.#error));

    let body;
    if (!envs.length) {
      body = this.#error ? h('div', { class: 'error' }, this.#error) : h('div', { class: 'empty' }, 'Keine Review-Umgebungen deployt.');
    } else {
      body = h('table', {},
        h('thead', {}, h('tr', {}, ...['MR', 'Titel', 'Branch', 'Commit', 'Autor', 'Deployt', 'Dienste'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...envs.map((env) => this.#row(env))),
      );
    }

    content.replaceChildren(meta, h('div', { class: 'wrap' }, body));
  }

  #row({ mr, app, services }) {
    const a = app ?? {};
    const mrUrl = safeUrl(a.mr_url ?? '');

    return h('tr', {},
      h('td', {}, mrUrl ? h('a', { href: mrUrl }, `!${mr}`) : `!${mr}`),
      h('td', { class: 'title' }, app ? a.title : h('i', {}, 'App-Container fehlt')),
      h('td', {}, h('code', {}, a.branch ?? '')),
      h('td', {}, h('code', {}, a.commit ?? '')),
      h('td', {}, a.author ?? ''),
      h('td', { title: a.deployed_at }, ago(a.deployed_at ?? '')),
      h('td', {}, h('div', { class: 'chips' },
        app ? this.#chip('App', a) : null,
        ...services.map((s) => this.#chip(s.name, s)),
      )),
    );
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
