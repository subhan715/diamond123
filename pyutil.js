/* Small helpers that reproduce the Python behaviour the original app relied on
   (float()/int() parsing, round(), "%.2f" formatting, format(x,'g')). */
class ValueError extends Error {}
class KeyError extends Error {}
class TypeErr extends Error {}

const Py = {
  float(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined) throw new TypeErr('float() argument must be a string or a number');
    const t = String(v).trim().replace(/_/g, '');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) throw new ValueError('could not convert string to float');
    return Number(t);
  },
  int(v) {
    if (typeof v === 'number') return Math.trunc(v);
    if (v === null || v === undefined) throw new TypeErr('int() argument must be a string or a number');
    const t = String(v).trim();
    if (!/^[+-]?\d+$/.test(t)) throw new ValueError('invalid literal for int()');
    return parseInt(t, 10);
  },
  need(obj, key) {                      // obj['key'] -> KeyError when missing
    if (obj === null || typeof obj !== 'object' || !(key in obj)) throw new KeyError(key);
    return obj[key];
  },
  /* correctly rounded fixed-point string, ties-to-even like Python */
  fixed(x, n) {
    if (!isFinite(x)) return String(x);
    const ext = x.toFixed(Math.min(100, n + 40));
    const dot = ext.indexOf('.');
    const tail = ext.slice(dot + 1 + n);
    if (/^50*$/.test(tail)) {            // exact tie
      const neg = ext[0] === '-';
      const base = ext.slice(0, dot + 1 + n).replace(/^-/, '');
      const digits = base.replace('.', '');
      const lastDigit = parseInt(digits[digits.length - 1], 10);
      let s = base;
      if (lastDigit % 2 === 1) {         // round up to even
        s = (BigInt(digits) + 1n).toString().padStart(digits.length, '0');
        s = n > 0 ? s.slice(0, s.length - n) + '.' + s.slice(s.length - n) : s;
      }
      if (n === 0 && s.endsWith('.')) s = s.slice(0, -1);
      return (neg ? '-' : '') + s;
    }
    return x.toFixed(n);
  },
  round(x, n = 0) { return Number(Py.fixed(x, n)); },
  g(x) {                                  // format(x, 'g')
    if (x === 0) return '0';
    if (!isFinite(x)) return String(x);
    const strip = s => s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
    const s = x.toExponential(5);
    const e = parseInt(s.split('e')[1], 10);
    if (e < -4 || e >= 6) {
      let [m, ex] = s.split('e');
      let digits = ex.slice(1); if (digits.length < 2) digits = '0' + digits;
      return strip(m) + 'e' + ex[0] + digits;
    }
    return strip(x.toFixed(Math.max(0, 5 - e)));
  },
  sprintf(fmt, ...args) {                 // "%.2f" % x   (%s %d %f %%)
    let i = 0;
    return String(fmt).replace(/%(%|(?:\.(\d+))?([sdif]))/g, (m, all, prec, t) => {
      if (all === '%') return '%';
      const a = args[i++];
      if (t === 'f') return Py.fixed(Number(a), prec === undefined ? 6 : parseInt(prec, 10));
      if (t === 'd' || t === 'i') return String(Math.trunc(Number(a)));
      return String(a);
    });
  },
  now() { return new Date(); },
  strftime(d, f) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return f.replace(/%([YmdHMS])/g, (_, c) => ({
      Y: p(d.getFullYear(), 4), m: p(d.getMonth() + 1), d: p(d.getDate()),
      H: p(d.getHours()), M: p(d.getMinutes()), S: p(d.getSeconds()),
    }[c]));
  },
  secureFilename(name) {
    name = String(name).normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
    name = name.replace(/[\\/]/g, ' ').trim().split(/\s+/).join('_');
    name = name.replace(/[^A-Za-z0-9_.-]/g, '').replace(/^[._]+|[._]+$/g, '');
    return name;
  },
};
