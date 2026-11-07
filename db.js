/* Port of db.py. Same SQLite schema and the same SQL statements, but SQLite now
   runs inside the browser (sql.js / WebAssembly). The database file is saved in
   the browser's IndexedDB after every change, so data survives page reloads. */
const DB = (() => {
  const LOW_STOCK_SQFT = 100;
  const SQM_TO_SQFT = 10.7639;
  const _EPS = 1e-6;
  const _SQFT_EXPR = `SUM(CASE WHEN unit='Sq.Meter' THEN total_area * ${SQM_TO_SQFT} ELSE total_area END)`;

  let SQL = null, db = null, dirtyTimer = null;
  const IDB_NAME = 'diamond_marble_granite', IDB_STORE = 'files';

  /* ---------- persistence (IndexedDB) ---------- */
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(key) {
    try {
      const d = await idb();
      return await new Promise((res, rej) => {
        const q = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
    } catch (e) { return undefined; }
  }
  async function idbPut(key, val) {
    const d = await idb();
    return new Promise((res, rej) => {
      const tx = d.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  }
  function exportBytes() {
    const bytes = db.export();               // export() resets pragmas
    db.run('PRAGMA foreign_keys = ON');
    return bytes;
  }
  function markDirty() {
    if (dirtyTimer) return;
    dirtyTimer = setTimeout(flush, 150);
  }
  async function flush() {
    clearTimeout(dirtyTimer); dirtyTimer = null;
    try { await idbPut('marble_granite.db', exportBytes()); } catch (e) { console.error('save failed', e); }
  }
  window.addEventListener('pagehide', () => { if (dirtyTimer) flush(); });

  /* ---------- low level helpers ---------- */
  const clean = p => p.map(v => (v === undefined ? null : v));
  function all(sql, params = []) {
    const st = db.prepare(sql);
    try {
      st.bind(clean(params));
      const rows = [];
      while (st.step()) rows.push(st.getAsObject());
      return rows;
    } finally { st.free(); }
  }
  const one = (sql, params = []) => all(sql, params)[0] || null;
  const run = (sql, params = []) => db.run(sql, clean(params));
  const lastId = () => one('SELECT last_insert_rowid() AS id').id;

  /* BEGIN IMMEDIATE ... COMMIT; any exception or tx.rollback() undoes everything
     (same as closing the sqlite connection without commit in the original). */
  function writeTx(fn) {
    db.run('BEGIN IMMEDIATE');
    const tx = { rolledBack: false, rollback() { if (!this.rolledBack) { db.run('ROLLBACK'); this.rolledBack = true; } } };
    try {
      const r = fn(tx);
      if (!tx.rolledBack) { db.run('COMMIT'); markDirty(); }
      return r;
    } catch (e) { tx.rollback(); throw e; }
  }

  /* ---------- schema ---------- */
  function init_db() {
    run(`
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            material_type TEXT,
            color TEXT,
            unit TEXT DEFAULT 'Sq.Ft',
            purchase_price_per_unit REAL DEFAULT 0,
            selling_price_per_unit REAL DEFAULT 0,
            supplier TEXT,
            notes TEXT,
            date_added TEXT
        )
    `);
    run(`
        CREATE TABLE IF NOT EXISTS inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER,
            item_name TEXT NOT NULL,
            material_type TEXT,
            color TEXT,
            width REAL,
            length REAL,
            thickness REAL,
            pieces INTEGER,
            unit TEXT DEFAULT 'Sq.Ft',
            area_per_piece REAL,
            total_area REAL,
            purchase_price_per_unit REAL DEFAULT 0,
            selling_price_per_unit REAL DEFAULT 0,
            total_cost_value REAL DEFAULT 0,
            total_value REAL DEFAULT 0,
            supplier TEXT,
            notes TEXT,
            date_added TEXT,
            FOREIGN KEY(product_id) REFERENCES products(id)
        )
    `);
    const invCols = new Set(all('PRAGMA table_info(inventory)').map(r => r.name));
    if (!invCols.has('product_id')) run('ALTER TABLE inventory ADD COLUMN product_id INTEGER');
    run(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no TEXT,
            customer_name TEXT,
            phone TEXT,
            address TEXT,
            status TEXT DEFAULT 'Pending',
            order_date TEXT,
            notes TEXT,
            total_amount REAL DEFAULT 0,
            drawing_filename TEXT,
            drawing_notes TEXT
        )
    `);
    const ordCols = new Set(all('PRAGMA table_info(orders)').map(r => r.name));
    if (!ordCols.has('drawing_filename')) run('ALTER TABLE orders ADD COLUMN drawing_filename TEXT');
    if (!ordCols.has('drawing_notes')) run('ALTER TABLE orders ADD COLUMN drawing_notes TEXT');
    run(`
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            inventory_id INTEGER,
            item_name TEXT,
            pieces INTEGER,
            width REAL,
            length REAL,
            unit TEXT,
            area REAL,
            price_per_unit REAL,
            amount REAL,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
        )
    `);
    run(`
        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_no TEXT,
            source TEXT,
            order_id INTEGER,
            customer_name TEXT,
            phone TEXT,
            payment_method TEXT,
            invoice_date TEXT,
            total_amount REAL,
            total_profit REAL DEFAULT 0
        )
    `);
    run(`
        CREATE TABLE IF NOT EXISTS invoice_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER,
            inventory_id INTEGER,
            item_name TEXT,
            pieces INTEGER,
            width REAL,
            length REAL,
            unit TEXT,
            area REAL,
            price_per_unit REAL,
            cost_price_per_unit REAL DEFAULT 0,
            amount REAL,
            profit REAL DEFAULT 0,
            FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
        )
    `);
    run(`
        CREATE TABLE IF NOT EXISTS deliveries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            delivery_no TEXT,
            order_id INTEGER,
            invoice_id INTEGER,
            customer_name TEXT,
            phone TEXT,
            address TEXT,
            status TEXT DEFAULT 'Ready for Delivery',
            delivery_date TEXT
        )
    `);
    /* Browser-only addition: the original saved order drawings as files in
       static/uploads/drawings/. Here they live inside the same database file,
       so a backup contains them too. */
    run(`
        CREATE TABLE IF NOT EXISTS drawings (
            filename TEXT PRIMARY KEY,
            data BLOB
        )
    `);
    markDirty();
  }

  async function open() {
    SQL = await initSqlJs({ locateFile: f => f });
    const saved = await idbGet('marble_granite.db');
    db = saved ? new SQL.Database(saved) : new SQL.Database();
    db.run('PRAGMA foreign_keys = ON');
    init_db();
  }

  const now_str = () => Py.strftime(new Date(), '%Y-%m-%d %H:%M');

  function next_number(prefix, table, column) {
    const today = Py.strftime(new Date(), '%Y%m%d');
    const c = one(`SELECT COUNT(*) c FROM ${table} WHERE ${column} LIKE ?`, [`${prefix}-${today}-%`]).c + 1;
    return `${prefix}-${today}-${String(c).padStart(3, '0')}`;
  }

  /* ---------- cart verification / stock ---------- */
  function _verify_cart_items(items) {
    const verified = [];
    for (const it of items) {
      const inventory_id = Py.int(Py.need(it, 'inventory_id'));
      const pieces = Py.int(Py.need(it, 'pieces'));
      const price_per_unit = Py.float(Py.need(it, 'price_per_unit'));
      if (pieces <= 0) throw new ValueError("Every item's quantity must be greater than zero.");
      if (price_per_unit < 0) throw new ValueError('Item price cannot be negative.');
      const inv = one('SELECT item_name, width, length, unit, area_per_piece FROM inventory WHERE id=?', [inventory_id]);
      if (!inv) throw new ValueError('One of the items no longer exists in inventory. Please refresh and try again.');
      let width, length, waste;
      try {
        width = Py.float('width' in it ? it.width : inv.width);
        length = Py.float('length' in it ? it.length : inv.length);
        waste = Py.float(('waste' in it ? it.waste : 0) || 0);
      } catch (e) {
        if (e instanceof ValueError || e instanceof TypeErr) throw new ValueError('Width, Length and Waste must be numbers.');
        throw e;
      }
      if (width <= 0 || length <= 0) throw new ValueError('Width and Length must be greater than zero.');
      if (waste < 0) throw new ValueError('Waste cannot be negative.');
      const unit = inv.unit;
      const area_per_piece_custom = unit === 'Sq.Ft'
        ? (width * length) / 144.0
        : (width * 0.0254) * (length * 0.0254);
      const ordered_area = area_per_piece_custom * pieces;
      const area = ordered_area + waste;
      const amount = Py.round(area * price_per_unit, 2);
      verified.push({ inventory_id, item_name: inv.item_name, pieces, width, length, unit, waste, area, price_per_unit, amount });
    }
    return verified;
  }

  function _sibling_batches(inventory_id) {
    const ref = one('SELECT id, product_id, item_name, unit FROM inventory WHERE id=?', [inventory_id]);
    if (!ref) return [null, []];
    let rows;
    if (ref.product_id) {
      rows = all('SELECT * FROM inventory WHERE product_id=? AND unit=? ORDER BY (id=?) DESC, date_added, id',
        [ref.product_id, ref.unit, inventory_id]);
    } else {
      rows = all('SELECT * FROM inventory WHERE item_name=? COLLATE NOCASE AND unit=? ORDER BY (id=?) DESC, date_added, id',
        [ref.item_name, ref.unit, inventory_id]);
    }
    return [ref, rows];
  }

  /* returns an error string, or null when stock was deducted */
  function _take_stock_area(inventory_id, area, item_name) {
    const [ref, batches] = _sibling_batches(inventory_id);
    if (!ref) return 'One of the items no longer exists in inventory. Please refresh and try again.';
    const available = batches.reduce((s, b) => s + b.total_area, 0);
    if (area > available + _EPS) {
      return `Insufficient Stock: "${item_name}" needs ${Py.fixed(area, 2)} ${ref.unit}, only ${Py.fixed(available, 2)} ${ref.unit} available.`;
    }
    let remaining = area;
    for (const b of batches) {
      if (remaining <= _EPS) return null;
      const take = Math.min(remaining, b.total_area);
      if (take <= 0) continue;
      let new_area = b.total_area - take;
      if (new_area < _EPS) new_area = 0.0;
      const per_piece = b.area_per_piece || 0;
      const new_pieces = (per_piece > 0 && new_area > 0) ? Math.ceil(Py.round(new_area / per_piece, 6)) : 0;
      run('UPDATE inventory SET pieces=?, total_area=?, total_cost_value=?, total_value=? WHERE id=?',
        [new_pieces, new_area, new_area * b.purchase_price_per_unit, new_area * b.selling_price_per_unit, b.id]);
      remaining -= take;
    }
    return null;
  }

  /* ---------- products ---------- */
  function get_products(search = '') {
    let sql = `
        SELECT p.*,
               COALESCE(SUM(i.pieces), 0) AS total_pieces,
               COALESCE(SUM(i.total_area), 0) AS total_area,
               COALESCE(SUM(i.total_cost_value), 0) AS total_cost_value,
               COALESCE(SUM(i.total_value), 0) AS total_value,
               COUNT(i.id) AS batch_count
        FROM products p
        LEFT JOIN inventory i ON i.product_id = p.id
    `;
    if (search) {
      const like = `%${search}%`;
      sql += ' WHERE p.name LIKE ? OR p.material_type LIKE ? OR p.color LIKE ? ';
      sql += ' GROUP BY p.id ORDER BY p.name COLLATE NOCASE';
      return all(sql, [like, like, like]);
    }
    sql += ' GROUP BY p.id ORDER BY p.name COLLATE NOCASE';
    return all(sql);
  }
  const get_product = id => one('SELECT * FROM products WHERE id=?', [id]);
  const find_product_by_name = name => one('SELECT * FROM products WHERE name = ? COLLATE NOCASE', [name]);

  function create_product(d) {
    run(`
        INSERT INTO products (name, material_type, color, unit, purchase_price_per_unit,
        selling_price_per_unit, supplier, notes, date_added) VALUES (?,?,?,?,?,?,?,?,?)
    `, [d.name, d.material_type, d.color, d.unit, d.purchase_price_per_unit,
        d.selling_price_per_unit, d.supplier, d.notes, now_str()]);
    const id = lastId(); markDirty(); return id;
  }
  function get_or_create_product(d) {
    const existing = find_product_by_name(d.name);
    if (existing) return [existing.id, false];
    return [create_product(d), true];
  }
  const get_batches_for_product = id => all('SELECT * FROM inventory WHERE product_id=? ORDER BY date_added', [id]);

  /* ---------- inventory ---------- */
  function add_inventory_item(d) {
    run(`
        INSERT INTO inventory (product_id, item_name, material_type, color, width, length, thickness,
        pieces, unit, area_per_piece, total_area, purchase_price_per_unit, selling_price_per_unit,
        total_cost_value, total_value, supplier, notes, date_added)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [d.product_id, d.item_name, d.material_type, d.color, d.width, d.length, d.thickness,
        d.pieces, d.unit, d.area_per_piece, d.total_area, d.purchase_price_per_unit, d.selling_price_per_unit,
        d.total_cost_value, d.total_value, d.supplier, d.notes, now_str()]);
    markDirty();
  }
  function update_inventory_item(item_id, d) {
    run(`
        UPDATE inventory SET item_name=?, material_type=?, color=?, width=?, length=?, thickness=?,
        pieces=?, unit=?, area_per_piece=?, total_area=?, purchase_price_per_unit=?, selling_price_per_unit=?,
        total_cost_value=?, total_value=?, supplier=?, notes=?
        WHERE id=?
    `, [d.item_name, d.material_type, d.color, d.width, d.length, d.thickness,
        d.pieces, d.unit, d.area_per_piece, d.total_area, d.purchase_price_per_unit, d.selling_price_per_unit,
        d.total_cost_value, d.total_value, d.supplier, d.notes, item_id]);
    markDirty();
  }
  function delete_inventory_item(item_id) { run('DELETE FROM inventory WHERE id=?', [item_id]); markDirty(); }
  function get_inventory(search = '') {
    if (search) {
      const like = `%${search}%`;
      return all(`SELECT * FROM inventory WHERE item_name LIKE ? OR material_type LIKE ? OR color LIKE ?
                        ORDER BY item_name COLLATE NOCASE, date_added, id`, [like, like, like]);
    }
    return all('SELECT * FROM inventory ORDER BY item_name COLLATE NOCASE, date_added, id');
  }
  const get_inventory_item = id => one('SELECT * FROM inventory WHERE id=?', [id]);

  function get_low_stock() {
    return all(`
        SELECT item_name, MAX(material_type) AS material_type, MAX(color) AS color,
               SUM(pieces) AS pieces, ${_SQFT_EXPR} AS sqft_left
        FROM inventory
        GROUP BY item_name COLLATE NOCASE
        HAVING ${_SQFT_EXPR} < ?
        ORDER BY sqft_left ASC
    `, [LOW_STOCK_SQFT]);
  }

  function get_dashboard_stats() {
    const total_items = one('SELECT COUNT(DISTINCT LOWER(item_name)) c FROM inventory').c;
    const total_pieces = one('SELECT COALESCE(SUM(pieces),0) s FROM inventory').s;
    const total_area = one(`SELECT COALESCE(${_SQFT_EXPR},0) s FROM inventory`).s;
    const total_value = one('SELECT COALESCE(SUM(total_value),0) s FROM inventory').s;
    const total_investment = one('SELECT COALESCE(SUM(total_cost_value),0) s FROM inventory').s;
    const low_stock = get_low_stock().length;
    const pending_orders = one("SELECT COUNT(*) c FROM orders WHERE status='Pending'").c;
    const today = Py.strftime(new Date(), '%Y-%m-%d');
    const row = one('SELECT COALESCE(SUM(total_amount),0) s, COALESCE(SUM(total_profit),0) p, COUNT(*) c FROM invoices WHERE invoice_date LIKE ?', [`${today}%`]);
    const row2 = one('SELECT COALESCE(SUM(total_profit),0) p, COALESCE(SUM(total_amount),0) s FROM invoices');
    const pending_deliveries = one("SELECT COUNT(*) c FROM deliveries WHERE status != 'Delivered'").c;
    return {
      total_items, total_pieces, total_area, total_value, total_investment,
      potential_profit: total_value - total_investment,
      low_stock, pending_orders,
      today_sales: row.s, today_profit: row.p, today_count: row.c,
      total_profit_alltime: row2.p, total_sales_alltime: row2.s,
      pending_deliveries,
    };
  }
  const get_recent_sales_profit = (limit = 10) => all(`
        SELECT id, invoice_no, invoice_date, customer_name, total_amount, total_profit
        FROM invoices ORDER BY id DESC LIMIT ?
    `, [limit]);

  /* ---------- orders ---------- */
  function create_order(customer_name, phone, address, notes, items, drawing_filename = null, drawing_notes = '') {
    return writeTx(() => {
      items = _verify_cart_items(items);
      const order_no = next_number('ORD', 'orders', 'order_no');
      const total = items.reduce((s, it) => s + it.amount, 0);
      run(`INSERT INTO orders (order_no, customer_name, phone, address, status, order_date, notes,
                   total_amount, drawing_filename, drawing_notes)
                   VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [order_no, customer_name, phone, address, 'Pending', now_str(), notes, total, drawing_filename, drawing_notes]);
      const order_id = lastId();
      for (const it of items) {
        run(`INSERT INTO order_items (order_id, inventory_id, item_name, pieces, width, length,
                        unit, area, price_per_unit, amount) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [order_id, it.inventory_id, it.item_name, it.pieces, it.width, it.length, it.unit, it.area, it.price_per_unit, it.amount]);
      }
      return [order_id, order_no];
    });
  }
  function get_orders(search = '') {
    if (search) {
      const like = `%${search}%`;
      return all(`SELECT * FROM orders WHERE order_no LIKE ? OR customer_name LIKE ?
                       ORDER BY id DESC`, [like, like]);
    }
    return all('SELECT * FROM orders ORDER BY id DESC');
  }
  function get_order(order_id) {
    return [one('SELECT * FROM orders WHERE id=?', [order_id]), all('SELECT * FROM order_items WHERE order_id=?', [order_id])];
  }

  /* returns [delivery_id, delivery_no, error] */
  function process_order(order_id) {
    return writeTx(tx => {
      const order = one('SELECT * FROM orders WHERE id=?', [order_id]);
      if (!order || order.status !== 'Pending') {
        tx.rollback();
        return [null, null, 'Order not found or already processed.'];
      }
      const items = all('SELECT * FROM order_items WHERE order_id=?', [order_id]);
      for (const it of items) {
        const error = _take_stock_area(it.inventory_id, it.area, it.item_name);
        if (error) { tx.rollback(); return [null, null, error]; }
      }
      const delivery_no = next_number('DEL', 'deliveries', 'delivery_no');
      run(`INSERT INTO deliveries (delivery_no, order_id, invoice_id, customer_name, phone,
                   address, status, delivery_date) VALUES (?,?,?,?,?,?,?,?)`,
        [delivery_no, order_id, null, order.customer_name, order.phone, order.address, 'Ready for Delivery', now_str()]);
      const delivery_id = lastId();
      run("UPDATE orders SET status='Processed' WHERE id=?", [order_id]);
      return [delivery_id, delivery_no, null];
    });
  }

  function generate_invoice_for_delivery(delivery_id) {
    return writeTx(tx => {
      const delivery = one('SELECT * FROM deliveries WHERE id=?', [delivery_id]);
      if (!delivery || delivery.invoice_id || !delivery.order_id) { tx.rollback(); return null; }
      const order = one('SELECT * FROM orders WHERE id=?', [delivery.order_id]);
      const items = all('SELECT * FROM order_items WHERE order_id=?', [delivery.order_id]);
      if (!order || !items.length) { tx.rollback(); return null; }
      const invoice_no = next_number('INV', 'invoices', 'invoice_no');
      const total = items.reduce((s, it) => s + it.amount, 0);
      let total_profit = 0.0;
      const line_data = [];
      for (const it of items) {
        const inv = one('SELECT purchase_price_per_unit FROM inventory WHERE id=?', [it.inventory_id]);
        const cost_price = inv ? inv.purchase_price_per_unit : 0;
        const profit = (it.price_per_unit - cost_price) * it.area;
        total_profit += profit;
        line_data.push([it, cost_price, profit]);
      }
      run(`INSERT INTO invoices (invoice_no, source, order_id, customer_name, phone,
                   payment_method, invoice_date, total_amount, total_profit) VALUES (?,?,?,?,?,?,?,?,?)`,
        [invoice_no, 'Order', order.id, order.customer_name, order.phone, 'Unpaid', now_str(), total, total_profit]);
      const invoice_id = lastId();
      for (const [it, cost_price, profit] of line_data) {
        run(`INSERT INTO invoice_items (invoice_id, inventory_id, item_name, pieces, width,
                       length, unit, area, price_per_unit, cost_price_per_unit, amount, profit)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [invoice_id, it.inventory_id, it.item_name, it.pieces, it.width, it.length, it.unit, it.area,
           it.price_per_unit, cost_price, it.amount, profit]);
      }
      run('UPDATE deliveries SET invoice_id=? WHERE id=?', [invoice_id, delivery_id]);
      return invoice_id;
    });
  }

  function cancel_order(order_id) { run("UPDATE orders SET status='Cancelled' WHERE id=?", [order_id]); markDirty(); }

  /* returns [invoice_id, error] */
  function create_pos_sale(customer_name, phone, payment_method, items) {
    return writeTx(tx => {
      items = _verify_cart_items(items);
      for (const it of items) {
        const error = _take_stock_area(it.inventory_id, it.area, it.item_name);
        if (error) { tx.rollback(); return [null, error]; }
      }
      const invoice_no = next_number('INV', 'invoices', 'invoice_no');
      const total = items.reduce((s, it) => s + it.amount, 0);
      let total_profit = 0.0;
      const line_data = [];
      for (const it of items) {
        const inv = one('SELECT purchase_price_per_unit, pieces, total_area FROM inventory WHERE id=?', [it.inventory_id]);
        const cost_price = inv ? inv.purchase_price_per_unit : 0;
        const profit = (it.price_per_unit - cost_price) * it.area;
        total_profit += profit;
        line_data.push([it, cost_price, profit, inv]);
      }
      run(`INSERT INTO invoices (invoice_no, source, order_id, customer_name, phone,
                   payment_method, invoice_date, total_amount, total_profit) VALUES (?,?,?,?,?,?,?,?,?)`,
        [invoice_no, 'POS', null, customer_name, phone, payment_method, now_str(), total, total_profit]);
      const invoice_id = lastId();
      for (const [it, cost_price, profit] of line_data) {
        run(`INSERT INTO invoice_items (invoice_id, inventory_id, item_name, pieces, width,
                       length, unit, area, price_per_unit, cost_price_per_unit, amount, profit)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [invoice_id, it.inventory_id, it.item_name, it.pieces, it.width, it.length, it.unit, it.area,
           it.price_per_unit, cost_price, it.amount, profit]);
      }
      return [invoice_id, null];
    });
  }

  /* ---------- invoices ---------- */
  function get_invoices(search = '') {
    if (search) {
      const like = `%${search}%`;
      return all(`SELECT * FROM invoices WHERE invoice_no LIKE ? OR customer_name LIKE ?
                       ORDER BY id DESC`, [like, like]);
    }
    return all('SELECT * FROM invoices ORDER BY id DESC');
  }
  const get_invoice = id => [one('SELECT * FROM invoices WHERE id=?', [id]), all('SELECT * FROM invoice_items WHERE invoice_id=?', [id])];
  function mark_invoice_paid(id, method) { run('UPDATE invoices SET payment_method=? WHERE id=?', [method, id]); markDirty(); }
  const get_delivery_for_invoice = id => one('SELECT * FROM deliveries WHERE invoice_id=?', [id]);

  /* ---------- deliveries ---------- */
  function get_deliveries(search = '') {
    if (search) {
      const like = `%${search}%`;
      return all(`SELECT * FROM deliveries WHERE delivery_no LIKE ? OR customer_name LIKE ?
                       ORDER BY id DESC`, [like, like]);
    }
    return all('SELECT * FROM deliveries ORDER BY id DESC');
  }
  /* returns [delivery, items, invoice, order] */
  function get_delivery(delivery_id) {
    const delivery = one('SELECT * FROM deliveries WHERE id=?', [delivery_id]);
    let items = [], invoice = null, order = null;
    if (delivery && delivery.invoice_id) {
      items = all('SELECT * FROM invoice_items WHERE invoice_id=?', [delivery.invoice_id]);
      invoice = one('SELECT * FROM invoices WHERE id=?', [delivery.invoice_id]);
    }
    if (delivery && delivery.order_id) {
      order = one('SELECT * FROM orders WHERE id=?', [delivery.order_id]);
      if (!items.length) items = all('SELECT * FROM order_items WHERE order_id=?', [delivery.order_id]);
    }
    return [delivery, items, invoice, order];
  }
  function update_delivery_status(delivery_id, status) {
    run('UPDATE deliveries SET status=? WHERE id=?', [status, delivery_id]);
    markDirty();
    if (status === 'Delivered') return generate_invoice_for_delivery(delivery_id);
    return null;
  }

  /* ---------- drawings (browser-only) ---------- */
  function save_drawing(filename, bytes) { run('INSERT OR REPLACE INTO drawings (filename, data) VALUES (?,?)', [filename, bytes]); markDirty(); }
  const get_drawing = filename => one('SELECT data FROM drawings WHERE filename=?', [filename]);

  /* ---------- backup / restore ---------- */
  const db_size_kb = () => Py.round(exportBytes().length / 1024, 1);
  const backup_bytes = () => exportBytes();
  async function restore_from_bytes(bytes) {
    /* validate first (throws on a corrupt / non-sqlite file) */
    const test = new SQL.Database(bytes);
    let tables;
    try { tables = new Set(test.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.map(r => r[0]) || []); }
    finally { test.close(); }
    const required = ['inventory', 'invoices', 'orders', 'deliveries'];
    if (!required.every(t => tables.has(t))) return false;
    await idbPut('_before_restore_' + Py.strftime(new Date(), '%Y%m%d_%H%M%S') + '.db', exportBytes()); // safety copy
    db.close();
    db = new SQL.Database(bytes);
    db.run('PRAGMA foreign_keys = ON');
    init_db();
    await flush();
    return true;
  }

  return {
    open, flush, LOW_STOCK_SQFT, all, one,
    get_products, get_product, find_product_by_name, create_product, get_or_create_product, get_batches_for_product,
    add_inventory_item, update_inventory_item, delete_inventory_item, get_inventory, get_inventory_item,
    get_low_stock, get_dashboard_stats, get_recent_sales_profit,
    create_order, get_orders, get_order, process_order, generate_invoice_for_delivery, cancel_order, create_pos_sale,
    get_invoices, get_invoice, mark_invoice_paid, get_delivery_for_invoice,
    get_deliveries, get_delivery, update_delivery_status,
    save_drawing, get_drawing, db_size_kb, backup_bytes, restore_from_bytes,
  };
})();
