// utils.js — Pure utility functions with zero dependencies

function bind(id, event, handler) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener(event, handler);
  } else {
    console.warn(`Element #${id} not found — listener for "${event}" not attached.`);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTokenDisplay(whole) {
  const n = Number(whole);
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 10) return String(Math.floor(n));
  return Number(n.toPrecision(4)).toString();
}

function formatNumberInput(input) {
  if (!input) return;
  const oldValue = input.value;
  const oldCursor = input.selectionStart ?? oldValue.length;
  const oldCommasBeforeCursor = (oldValue.slice(0, oldCursor).match(/,/g) || []).length;
  const cleaned = oldValue
    .replace(/[^\d.\-]/g, '')
    .replace(/(?!^)-/g, '')
    .replace(/(\..*)\./g, '$1');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') {
    input.value = cleaned;
    return;
  }
  const negative = cleaned.startsWith('-');
  const body = negative ? cleaned.slice(1) : cleaned;
  const dotIdx = body.indexOf('.');
  const intPart = dotIdx === -1 ? body : body.slice(0, dotIdx);
  const decPart = dotIdx === -1 ? '' : body.slice(dotIdx);
  const intStripped = intPart.replace(/^0+(?=\d)/, '') || '0';
  const intWithCommas = intStripped.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const newValue = (negative ? '-' : '') + intWithCommas + decPart;
  input.value = newValue;
  const oldNonCommasBeforeCursor = oldCursor - oldCommasBeforeCursor;
  let walked = 0, cursor = 0;
  while (cursor < newValue.length && walked < oldNonCommasBeforeCursor) {
    if (newValue[cursor] !== ',') walked++;
    cursor++;
  }
  input.setSelectionRange(cursor, cursor);
}

function parseNumberInput(input) {
  if (!input) return NaN;
  const raw = String(input.value).replace(/,/g, '');
  if (raw === '' || raw === '-' || raw === '.') return NaN;
  return Number(raw);
}

function getIntegerInputString(input) {
  if (!input) return '';
  return String(input.value).replace(/,/g, '').trim();
}

function setLoading(btn, loading) {
  if (!btn) return;
  if (loading) { btn.classList.add('is-loading'); btn.disabled = true; }
  else { btn.classList.remove('is-loading'); btn.disabled = false; }
}

function shortAddress(value, prefix = 6, suffix = 6) {
  if (!value || value.length <= prefix + suffix + 3) return value || '';
  return value.slice(0, prefix) + '...' + value.slice(-suffix);
}

function formatAge(isoString) {
  if (!isoString) return '';
  const ms = Date.now() - new Date(isoString).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function formatUsdRoughly(value) {
  if (value == null || !isFinite(value)) return '—';
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  if (value >= 100) return `$${Math.round(value)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}
