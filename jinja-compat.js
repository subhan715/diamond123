/* Renders the ORIGINAL Flask/Jinja2 templates in the browser with Nunjucks
   (a Jinja2 port). The template files are used exactly as they were; the few
   Python-only constructs are translated when a template is loaded. */
const Templates = (() => {
  const NAMES = ['base', 'login', 'dashboard', 'inventory_list', 'inventory_form', 'pos', 'orders_list',
                 'order_form', 'order_detail', 'invoices_list', 'invoice', 'deliveries_list', 'delivery', 'backup'];
  const sources = {};
  let env;

  function adapt(src) {
    return src.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g, tag =>
      tag
        // Python "x.rsplit('.', 1)[-1].lower()"  ->  file extension filter
        .replace(/([\w.]+)\.rsplit\('\.', 1\)\[-1\]\.lower\(\)/g, '($1|pyext)')
        // Jinja string concatenation operator  ~  ->  +
        .replace(/~/g, '+')
        // {% with x = ... %}  ->  {% set x = ... %}   ({% endwith %} is dropped)
        .replace(/^\{%-?\s*with\s+/, '{% set ')
        .replace(/^\{%-?\s*endwith\s*-?%\}$/, ''));
  }

  class Loader extends nunjucks.Loader {
    getSource(name) {
      if (!(name in sources)) return null;
      return { src: sources[name], path: name, noCache: false };
    }
  }

  async function load(globals) {
    await Promise.all(NAMES.map(async n => {
      const r = await fetch(`${n}.html`);
      if (!r.ok) throw new Error('Cannot load template ' + n);
      sources[n + '.html'] = adapt(await r.text());
    }));
    env = new nunjucks.Environment(new Loader(), { autoescape: true });
    for (const [k, v] of Object.entries(globals)) env.addGlobal(k, v);

    const lastArg = a => a[a.length - 1];
    const kw = a => { const l = lastArg(a); return (l && typeof l === 'object' && l.__keywords) ? l : null; };

    // "%.2f"|format(x)
    env.addFilter('format', (fmt, ...args) => Py.sprintf(fmt, ...args));
    // items|groupby('item_name')  -> [[name, [rows]], ...] sorted case-insensitively, like Jinja
    env.addFilter('groupby', (arr, attr) => {
      const key = o => { const v = o[attr]; return typeof v === 'string' ? v.toLowerCase() : v; };
      const sorted = [...arr].map((o, i) => [o, i]).sort((a, b) => {
        const ka = key(a[0]), kb = key(b[0]);
        return ka < kb ? -1 : ka > kb ? 1 : a[1] - b[1];
      }).map(x => x[0]);
      const out = [];
      for (const o of sorted) {
        const last = out[out.length - 1];
        if (last && key(last[1][0]) === key(o)) last[1].push(o);
        else out.push([o[attr], [o]]);
      }
      return out;
    });
    // batch_list|sum(attribute='total_area')
    env.addFilter('sum', (arr, ...rest) => {
      const k = kw(rest); const attr = k ? k.attribute : rest[0];
      return arr.reduce((s, o) => s + (attr ? o[attr] : o), 0);
    });
    // products|tojson  (same escaping as Jinja so it is safe inside <script>)
    env.addFilter('tojson', v => nunjucks.runtime.markSafe(
      JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/'/g, '\\u0027')));
    env.addFilter('pyext', s => String(s).split('.').pop().toLowerCase());
  }

  const render = (name, ctx) => env.render(name, ctx);
  return { load, render };
})();
