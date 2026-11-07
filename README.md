# Diamond Marble & Granite – Inventory, POS, Orders, Invoices & Deliveries

Static (HTML + JavaScript + CSS) version of the original Windows app, ready for **GitHub Pages**.
The templates (the `.html` files other than index.html), stylesheet and logo, SQL schema/queries and all business
rules (stock deduction, profit, invoice/delivery numbering, backup/restore) are the original ones.

## Put it on GitHub
1. Create a new repository and upload everything in this folder (there are no subfolders; `.nojekyll` must be included).
2. Repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**.
3. Open `https://<your-username>.github.io/<repo-name>/`.

Test locally with `python3 -m http.server` in this folder, then open http://localhost:8000
(do not double-click `index.html`: browsers block the database file when opened from disk).

## Login (same as the original `config.py`; edit in `js/config.js`)
- Username `dilawar`, password `diamond123`, backup password `marble123`.

## How it differs from the .exe (unavoidable on a static site)
- **Data is stored in each visitor's own browser** (SQLite running in the browser via sql.js, saved in IndexedDB). There is no shared server database: another phone/computer starts empty. Use **Backup & Restore** to move data between devices.
- Clearing the browser's site data deletes the data – download backups regularly.
- Order drawings are stored inside the database (so they are included in backups).
- **The login is only a screen lock.** The username/password are visible in `js/config.js` to anyone who can open the site, so do not rely on it to protect private business data on a public site.
- Pages use `#/` addresses (e.g. `index.html#/inventory`) because GitHub Pages has no server.

## Files
`index.html` shell · `app.js` routes (from app.py) · `db.js` database (from db.py) · `config.js` (from config.py) ·
`jinja-compat.js` renders the original Jinja templates (the other .html files) with Nunjucks · `nunjucks.min.js` and `sql-wasm.js/.wasm` are the libraries (MIT).
