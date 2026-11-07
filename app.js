/* Port of app.py (the Flask routes). Same URLs, same form fields, same flash
   messages and same logic - but everything runs in the browser.
   Pages are addressed with "#/path" (e.g. index.html#/inventory) so it works on
   GitHub Pages without any server. Each page is the original template rendered
   into the <iframe>, exactly like a normal page load would have been. */
(() => {
  const frame = document.getElementById('page');
  const ALLOWED_DRAWING_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'pdf', 'webp']);
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' };

  /* ---------- Flask-like session & flash ---------- */
  const store = {
    get(k) { try { return sessionStorage.getItem('dmg_' + k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem('dmg_' + k, v); } catch (e) {} },
    clear() { try { ['logged_in', 'username'].forEach(k => sessionStorage.removeItem('dmg_' + k)); } catch (e) {} },
  };
  const session = {
    get: k => { const v = store.get(k); return v === 'true' ? true : (v === null ? undefined : v); },
    set: (k, v) => store.set(k, v),
    clear: () => store.clear(),
  };
  let flashes = [];
  const flash = (msg, category = 'message') => flashes.push([category, msg]);
  const get_flashed_messages = () => { const m = flashes; flashes = []; return m; };

  /* ---------- url_for ---------- */
  const ROUTES = {
    dashboard: () => '/', login: () => '/login', logout: () => '/logout',
    inventory_list: () => '/inventory', inventory_add: () => '/inventory/add',
    inventory_edit: a => `/inventory/edit/${a.item_id}`, inventory_delete: a => `/inventory/delete/${a.item_id}`,
    api_inventory: () => '/api/inventory',
    pos: () => '/pos', pos_checkout: () => '/pos/checkout',
    orders_list: () => '/orders', orders_new: () => '/orders/new',
    order_detail: a => `/orders/${a.order_id}`, order_process: a => `/orders/${a.order_id}/process`,
    order_cancel: a => `/orders/${a.order_id}/cancel`,
    invoices_list: () => '/invoices', invoice_view: a => `/invoices/${a.invoice_id}`,
    invoice_mark_paid: a => `/invoices/${a.invoice_id}/mark-paid`,
    deliveries_list: () => '/deliveries', delivery_view: a => `/deliveries/${a.delivery_id}`,
    delivery_status: a => `/deliveries/${a.delivery_id}/status`,
    backup_page: () => '/backup', backup_download: () => '/backup/download', backup_restore: () => '/backup/restore',
  };
  const blobUrls = new Map();
  function drawingUrl(filename) {
    if (blobUrls.has(filename)) return blobUrls.get(filename);
    const row = DB.get_drawing(filename);
    if (!row) return '#';
    const ext = filename.split('.').pop().toLowerCase();
    const url = URL.createObjectURL(new Blob([row.data], { type: MIME[ext] || 'application/octet-stream' }));
    blobUrls.set(filename, url);
    return url;
  }
  function url_for(endpoint, ...rest) {
    const last = rest[rest.length - 1];
    const kwargs = {};
    if (last && typeof last === 'object') for (const [k, v] of Object.entries(last)) if (k !== '__keywords') kwargs[k] = v;
    if (endpoint === 'static') {
      const fn = kwargs.filename;
      return fn.startsWith('uploads/drawings/') ? drawingUrl(fn.slice('uploads/drawings/'.length)) : fn;
    }
    const build = ROUTES[endpoint];
    if (!build) throw new Error('Unknown endpoint ' + endpoint);
    const path = build(kwargs);
    const used = new Set(build.toString().match(/a\.(\w+)/g)?.map(s => s.slice(2)) || []);
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(kwargs)) if (!used.has(k) && v !== undefined && v !== null) q.set(k, v);
    const qs = q.toString();
    return '#' + path + (qs ? '?' + qs : '');
  }

  /* ---------- responses ---------- */
  const redirect = (path) => ({ redirect: path });
  const render_template = (name, ctx = {}) => ({ html: Templates.render(name, ctx) });
  const rows = list => list.map(r => ({ ...r }));                 // dict(row)
  const trim = s => String(s).trim();

  /* ---------- route handlers ---------- */
  const routes = [];
  const route = (method, pattern, fn) => routes.push([method, new RegExp('^' + pattern + '$'), fn]);

  // ----- auth -----
  route('GET', '/login', async r => render_template('login.html', { next: r.args.get('next') || '' }));
  route('POST', '/login', async r => {
    const username = r.form.get('username', ''), password = r.form.get('password', '');
    if (username === CONFIG.LOGIN_USERNAME && password === CONFIG.LOGIN_PASSWORD) {
      session.set('logged_in', 'true');
      session.set('username', username);
      const next = r.form.get('next');
      return redirect(next && next.startsWith('/') ? next : '/');
    }
    flash('Incorrect username or password.', 'error');
    return redirect('/login' + (r.form.get('next', '') ? '?next=' + encodeURIComponent(r.form.get('next', '')) : ''));
  });
  route('GET', '/logout', async () => {
    session.clear();
    flash('You have been logged out.', 'success');
    return redirect('/login');
  });

  // ----- dashboard -----
  route('GET', '/', async () => {
    if (CONFIG.LOGIN_PASSWORD === 'changeme123' || CONFIG.BACKUP_PASSWORD === 'admin123') {
      flash("Security reminder: you're still using the default password(s) from setup. Open config.py and change LOGIN_PASSWORD / BACKUP_PASSWORD before putting this on a shared network.", 'error');
    }
    return render_template('dashboard.html', {
      stats: DB.get_dashboard_stats(), low_stock: DB.get_low_stock(), recent_profit: DB.get_recent_sales_profit(10),
    });
  });

  // ----- inventory -----
  route('GET', '/inventory', async r => {
    const search = r.args.get('q') || '';
    const items = DB.get_inventory(search), products = DB.get_products(search);
    const low_names = DB.get_low_stock().map(x => x.item_name.toLowerCase());
    return render_template('inventory_list.html', { items, products, search, low_names, low_sqft: DB.LOW_STOCK_SQFT });
  });

  function _calc_area(width, length, pieces, unit, purchase_price, selling_price) {
    const area_piece = unit === 'Sq.Ft' ? (width * length) / 144.0 : (width * 0.0254) * (length * 0.0254);
    const total_area = area_piece * pieces;
    return [area_piece, total_area, total_area * purchase_price, total_area * selling_price];
  }

  route('GET', '/inventory/add', async r => {
    const products = rows(DB.get_products());
    let pre = null;
    const pid = r.args.get('product_id');
    if (pid !== null && /^\s*[+-]?\d+\s*$/.test(pid)) pre = parseInt(pid, 10);
    return render_template('inventory_form.html', { item: null, products, preselect_product_id: pre });
  });
  route('POST', '/inventory/add', async r => {
    const f = r.form;
    let width, length, thickness, pieces, purchase_price, selling_price;
    try {
      width = Py.float(f.get('width')); length = Py.float(f.get('length'));
      thickness = Py.float(f.get('thickness') || 0); pieces = Py.int(f.get('pieces'));
      purchase_price = Py.float(f.get('purchase_price_per_unit') || 0);
      selling_price = Py.float(f.get('selling_price_per_unit') || 0);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      flash('Please enter valid numbers for width, length, thickness, pieces and prices.', 'error');
      return redirect('/inventory/add');
    }
    if (width <= 0 || length <= 0 || pieces <= 0) {
      flash('Width, Length and Pieces must be greater than zero.', 'error');
      return redirect('/inventory/add');
    }
    const unit = f.get('unit', 'Sq.Ft');
    const supplier = trim(f.get('supplier', ''));
    const product_choice = f.get('product_id', '');
    let product_id, item_name, material_type, color;
    if (product_choice && product_choice !== '__new__') {
      let product;
      try { product = DB.get_product(Py.int(product_choice)); } catch (e) { if (!(e instanceof ValueError)) throw e; product = null; }
      if (!product) {
        flash('Selected product was not found. Please choose again.', 'error');
        return redirect('/inventory/add');
      }
      product_id = product.id; item_name = product.name; material_type = product.material_type; color = product.color;
    } else {
      const new_name = trim(f.get('new_product_name', ''));
      if (!new_name) {
        flash('Enter a Product Name for the new product, or choose an existing one.', 'error');
        return redirect('/inventory/add');
      }
      material_type = f.get('material_type', 'Marble');
      color = trim(f.get('color', ''));
      let created;
      [product_id, created] = DB.get_or_create_product({
        name: new_name, material_type, color, unit,
        purchase_price_per_unit: purchase_price, selling_price_per_unit: selling_price, supplier, notes: '',
      });
      item_name = new_name;
      if (!created) {
        const existing = DB.get_product(product_id);
        material_type = existing.material_type; color = existing.color; item_name = existing.name;
      }
    }
    const [area_piece, total_area, total_cost_value, total_value] =
      _calc_area(width, length, pieces, unit, purchase_price, selling_price);
    DB.add_inventory_item({
      product_id, item_name, material_type, color, width, length, thickness, pieces, unit,
      area_per_piece: area_piece, total_area, purchase_price_per_unit: purchase_price,
      selling_price_per_unit: selling_price, total_cost_value, total_value, supplier,
      notes: trim(f.get('notes', '')),
    });
    flash(`Stock added to "${item_name}" (${Py.g(width)} x ${Py.g(length)}, ${pieces} pcs).`, 'success');
    return redirect('/inventory/add');
  });

  route('GET', '/inventory/edit/(\\d+)', async (r, id) => {
    const item = DB.get_inventory_item(+id);
    if (!item) { flash('Item not found.', 'error'); return redirect('/inventory'); }
    return render_template('inventory_form.html', { item });
  });
  route('POST', '/inventory/edit/(\\d+)', async (r, id) => {
    const item_id = +id, f = r.form;
    const item = DB.get_inventory_item(item_id);
    if (!item) { flash('Item not found.', 'error'); return redirect('/inventory'); }
    let width, length, thickness, pieces, purchase_price, selling_price;
    try {
      width = Py.float(f.get('width')); length = Py.float(f.get('length'));
      thickness = Py.float(f.get('thickness') || 0); pieces = Py.int(f.get('pieces'));
      purchase_price = Py.float(f.get('purchase_price_per_unit') || 0);
      selling_price = Py.float(f.get('selling_price_per_unit') || 0);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      flash('Please enter valid numbers.', 'error');
      return redirect(`/inventory/edit/${item_id}`);
    }
    if (width <= 0 || length <= 0 || pieces <= 0) {
      flash('Width, Length and Pieces must be greater than zero.', 'error');
      return redirect(`/inventory/edit/${item_id}`);
    }
    const unit = f.get('unit', 'Sq.Ft');
    let [area_piece, total_area, total_cost_value, total_value] = _calc_area(width, length, pieces, unit, purchase_price, selling_price);
    // Size/qty/unit unchanged -> keep the remaining stock, only re-price it.
    if (width === item.width && length === item.length && pieces === item.pieces && unit === item.unit) {
      total_area = item.total_area;
      total_cost_value = total_area * purchase_price;
      total_value = total_area * selling_price;
    }
    DB.update_inventory_item(item_id, {
      item_name: trim(f.get('item_name')), material_type: f.get('material_type', 'Marble'),
      color: trim(f.get('color', '')), width, length, thickness, pieces, unit,
      area_per_piece: area_piece, total_area, purchase_price_per_unit: purchase_price,
      selling_price_per_unit: selling_price, total_cost_value, total_value,
      supplier: trim(f.get('supplier', '')), notes: trim(f.get('notes', '')),
    });
    flash('Item updated.', 'success');
    return redirect('/inventory');
  });
  route('POST', '/inventory/delete/(\\d+)', async (r, id) => {
    DB.delete_inventory_item(+id);
    flash('Item deleted.', 'success');
    return redirect('/inventory');
  });
  route('GET', '/api/inventory', async r => ({ html: '<pre>' + JSON.stringify(rows(DB.get_inventory(r.args.get('q') || '')), null, 2).replace(/</g, '&lt;') + '</pre>' }));

  // ----- POS -----
  route('GET', '/pos', async () => render_template('pos.html', { items: DB.get_inventory(), products: rows(DB.get_products()) }));
  route('POST', '/pos/checkout', async r => {
    let cart;
    try { cart = JSON.parse(r.form.get('cart_data', '[]')); } catch (e) { cart = []; }
    if (!cart || (Array.isArray(cart) && !cart.length)) { flash('Cart is empty.', 'error'); return redirect('/pos'); }
    const customer_name = trim(r.form.get('customer_name', '')) || 'Walk-in Customer';
    const phone = trim(r.form.get('phone', ''));
    const payment_method = r.form.get('payment_method', 'Cash');
    let invoice_id, error;
    try {
      [invoice_id, error] = DB.create_pos_sale(customer_name, phone, payment_method, cart);
    } catch (e) {
      if (!(e instanceof KeyError || e instanceof TypeErr || e instanceof ValueError || e instanceof TypeError)) throw e;
      flash('The cart data looked invalid. Please clear the cart and try again.', 'error');
      return redirect('/pos');
    }
    if (error) { flash(error, 'error'); return redirect('/pos'); }
    flash('Sale completed! Stock updated automatically.', 'success');
    return redirect(`/invoices/${invoice_id}`);
  });

  // ----- orders -----
  route('GET', '/orders', async r => {
    const search = r.args.get('q') || '';
    return render_template('orders_list.html', { orders: DB.get_orders(search), search });
  });
  route('GET', '/orders/new', async () => render_template('order_form.html', { items: DB.get_inventory(), products: rows(DB.get_products()) }));
  route('POST', '/orders/new', async r => {
    let cart;
    try { cart = JSON.parse(r.form.get('cart_data', '[]')); } catch (e) { cart = []; }
    if (!cart || (Array.isArray(cart) && !cart.length)) { flash('Please add at least one item to the order.', 'error'); return redirect('/orders/new'); }
    const customer_name = trim(r.form.get('customer_name', ''));
    if (!customer_name) { flash('Customer name is required.', 'error'); return redirect('/orders/new'); }
    const phone = trim(r.form.get('phone', '')), address = trim(r.form.get('address', ''));
    const notes = trim(r.form.get('notes', '')), drawing_notes = trim(r.form.get('drawing_notes', ''));

    let drawing_filename = null;
    const drawing_file = r.files.get('drawing_file');
    const canvas_data = trim(r.form.get('drawing_canvas_data', ''));
    const stamp = () => Py.strftime(new Date(), '%Y%m%d%H%M%S');
    if (drawing_file && drawing_file.name) {
      const ext = drawing_file.name.includes('.') ? drawing_file.name.split('.').pop().toLowerCase() : '';
      if (!ALLOWED_DRAWING_EXTENSIONS.has(ext)) {
        flash('Drawing must be an image (PNG/JPG/WEBP) or a PDF.', 'error');
        return redirect('/orders/new');
      }
      const stamped_name = `${stamp()}_${Py.secureFilename(drawing_file.name)}`;
      DB.save_drawing(stamped_name, new Uint8Array(await drawing_file.arrayBuffer()));
      drawing_filename = stamped_name;
    } else if (canvas_data.startsWith('data:image/png;base64,')) {
      try {
        const b64 = canvas_data.split(',')[1];
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        const stamped_name = `${stamp()}_sketch.png`;
        DB.save_drawing(stamped_name, bytes);
        drawing_filename = stamped_name;
      } catch (e) {
        flash('Could not save the drawing sketch — please try again.', 'error');
        return redirect('/orders/new');
      }
    }
    let order_id, order_no;
    try {
      [order_id, order_no] = DB.create_order(customer_name, phone, address, notes, cart, drawing_filename, drawing_notes);
    } catch (e) {
      if (!(e instanceof KeyError || e instanceof TypeErr || e instanceof ValueError || e instanceof TypeError)) throw e;
      flash('The order items looked invalid. Please re-add them and try again.', 'error');
      return redirect('/orders/new');
    }
    flash(`Order ${order_no} placed successfully.`, 'success');
    return redirect(`/orders/${order_id}`);
  });
  route('GET', '/orders/(\\d+)', async (r, id) => {
    const [order, items] = DB.get_order(+id);
    if (!order) { flash('Order not found.', 'error'); return redirect('/orders'); }
    return render_template('order_detail.html', { order, items });
  });
  route('POST', '/orders/(\\d+)/process', async (r, id) => {
    const [delivery_id, delivery_no, error] = DB.process_order(+id);
    if (error) { flash(error, 'error'); return redirect(`/orders/${id}`); }
    flash(`Order processed! Delivery Note / Challan (${delivery_no}) created and stock was deducted. The Invoice will be generated automatically once this delivery is marked 'Delivered'.`, 'success');
    return redirect(`/deliveries/${delivery_id}`);
  });
  route('POST', '/orders/(\\d+)/cancel', async (r, id) => {
    DB.cancel_order(+id);
    flash('Order cancelled.', 'success');
    return redirect('/orders');
  });

  // ----- invoices -----
  route('GET', '/invoices', async r => {
    const search = r.args.get('q') || '';
    return render_template('invoices_list.html', { invoices: DB.get_invoices(search), search });
  });
  route('GET', '/invoices/(\\d+)', async (r, id) => {
    const [invoice, items] = DB.get_invoice(+id);
    if (!invoice) { flash('Invoice not found.', 'error'); return redirect('/invoices'); }
    let delivery = null;
    if (invoice.source === 'Order') delivery = DB.get_delivery_for_invoice(+id);
    return render_template('invoice.html', { invoice, items, delivery });
  });
  route('POST', '/invoices/(\\d+)/mark-paid', async (r, id) => {
    DB.mark_invoice_paid(+id, r.form.get('payment_method', 'Cash'));
    flash('Invoice marked as paid.', 'success');
    return redirect(`/invoices/${id}`);
  });

  // ----- deliveries -----
  route('GET', '/deliveries', async r => {
    const search = r.args.get('q') || '';
    return render_template('deliveries_list.html', { deliveries: DB.get_deliveries(search), search });
  });
  route('GET', '/deliveries/(\\d+)', async (r, id) => {
    const [delivery, items, invoice, order] = DB.get_delivery(+id);
    if (!delivery) { flash('Delivery not found.', 'error'); return redirect('/deliveries'); }
    return render_template('delivery.html', { delivery, items, invoice, order });
  });
  route('POST', '/deliveries/(\\d+)/status', async (r, id) => {
    const new_invoice_id = DB.update_delivery_status(+id, r.form.get('status', 'Ready for Delivery'));
    flash(new_invoice_id ? 'Delivery marked as Delivered! Invoice generated automatically.' : 'Delivery status updated.', 'success');
    return redirect(`/deliveries/${id}`);
  });

  // ----- backup & restore -----
  route('GET', '/backup', async () => {
    if (CONFIG.TRIAL_MODE) return render_template('backup.html', { trial_mode: true, db_size_kb: 0 });
    return render_template('backup.html', { trial_mode: false, db_size_kb: DB.db_size_kb() });
  });
  route('POST', '/backup/download', async r => {
    if (CONFIG.TRIAL_MODE) { flash('Backup & Restore is available in the licensed version.', 'error'); return redirect('/backup'); }
    if (r.form.get('password', '') !== CONFIG.BACKUP_PASSWORD) { flash('Incorrect backup password.', 'error'); return redirect('/backup'); }
    const filename = `marble_granite_backup_${Py.strftime(new Date(), '%Y-%m-%d_%H%M')}.db`;
    await DB.flush();
    const url = URL.createObjectURL(new Blob([DB.backup_bytes()], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { stay: true };
  });
  route('POST', '/backup/restore', async r => {
    if (CONFIG.TRIAL_MODE) { flash('Backup & Restore is available in the licensed version.', 'error'); return redirect('/backup'); }
    if (r.form.get('password', '') !== CONFIG.BACKUP_PASSWORD) {
      flash('Incorrect backup password. Restore cancelled - your current data is untouched.', 'error');
      return redirect('/backup');
    }
    const file = r.files.get('backup_file');
    if (!file || file.name === '') { flash('Please choose a backup file (.db) to restore.', 'error'); return redirect('/backup'); }
    if (!Py.secureFilename(file.name).toLowerCase().endsWith('.db')) {
      flash("That doesn't look like a backup file. Please choose the .db backup file.", 'error');
      return redirect('/backup');
    }
    let ok;
    try { ok = await DB.restore_from_bytes(new Uint8Array(await file.arrayBuffer())); }
    catch (e) {
      console.error(e);
      flash('Could not read that file - it may be corrupted or not a valid backup.', 'error');
      return redirect('/backup');
    }
    if (!ok) { flash("This file doesn't look like a valid backup of this system.", 'error'); return redirect('/backup'); }
    flash('Backup restored successfully! Your data from the other computer is now loaded here.', 'success');
    return redirect('/');
  });

  /* ---------- request dispatch ---------- */
  const formWrap = fd => ({
    get: (k, d = null) => { const v = fd.get(k); return typeof v === 'string' ? v : d; },
  });
  const filesWrap = fd => ({ get: k => { const v = fd.get(k); return (v instanceof File) ? v : null; } });

  async function dispatch(method, fullPath, fd) {
    const [path, qs] = fullPath.split('?');
    const req = { method, path, args: new URLSearchParams(qs || ''), form: formWrap(fd || new FormData()), files: filesWrap(fd || new FormData()) };
    if (!path.startsWith('/login') && !path.startsWith('/static') && !session.get('logged_in')) {
      return redirect('/login?next=' + encodeURIComponent(path));
    }
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const mt = re.exec(path);
      if (mt) return fn(req, ...mt.slice(1));
    }
    return { html: '<!doctype html><title>404 Not Found</title><h1>Not Found</h1><p>The requested URL was not found.</p><a href="#/">Home</a>' };
  }

  let current = '/';
  async function handle(method, fullPath, fd, viaGet) {
    let res;
    try { res = await dispatch(method, fullPath, fd); }
    catch (e) {
      console.error(e);
      res = { html: '<!doctype html><title>Error</title><h1>Something went wrong</h1><pre>' + String(e && e.stack || e).replace(/</g, '&lt;') + '</pre><a href="#/">Home</a>' };
    }
    if (res.redirect !== undefined) return go(res.redirect, viaGet);
    if (res.stay) return;
    if (method === 'GET') current = fullPath;
    show(res.html);
  }

  function show(html) {
    frame.onload = () => {
      const d = frame.contentDocument;
      if (d.title) document.title = d.title;
      d.addEventListener('click', e => {                 // links
        const a = e.target.closest && e.target.closest('a[href^="#/"]');
        if (!a || e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || a.target === '_blank') return;
        e.preventDefault();
        go(a.getAttribute('href').slice(1), false);
      });
      d.addEventListener('submit', e => {                // forms (runs after the page's own handlers)
        if (e.defaultPrevented) return;
        e.preventDefault();
        const form = e.target;
        const method = (form.getAttribute('method') || 'get').toUpperCase();
        const action = form.getAttribute('action');
        let target = action && action.startsWith('#/') ? action.slice(1) : current.split('?')[0];
        const fd = new FormData(form);
        if (method === 'GET') {
          const q = new URLSearchParams();
          for (const [k, v] of fd.entries()) if (typeof v === 'string') q.append(k, v);
          go(target + (q.toString() ? '?' + q.toString() : ''), false);
        } else {
          handle('POST', target, fd, false);
        }
      });
    };
    frame.hidden = false;
    document.getElementById('boot').hidden = true;
    frame.srcdoc = html;
  }

  function go(target, replace) {
    if (!target.startsWith('/')) target = '/' + target;
    const hash = '#' + target;
    if (location.hash === hash || (target === '/' && (location.hash === '' || location.hash === '#'))) {
      return handle('GET', target, null, true);          // same address: just re-render
    }
    if (replace) location.replace(hash); else location.hash = hash;   // -> hashchange
  }
  window.addEventListener('hashchange', () => handle('GET', location.hash.slice(1) || '/', null, true));

  /* ---------- start ---------- */
  (async () => {
    try {
      await DB.open();
      await Templates.load({ url_for, get_flashed_messages, session, TRIAL_MODE: CONFIG.TRIAL_MODE });
    } catch (e) {
      document.getElementById('boot').textContent = 'Could not start: ' + e.message +
        ' (open this site through a web server such as GitHub Pages, not by double-clicking index.html)';
      console.error(e);
      return;
    }
    handle('GET', location.hash.slice(1) || '/', null, true);
  })();
})();
