(() => {
'use strict';

const STORAGE_KEY = 'pricelog_v02_data';
const SETTINGS_KEY = 'pricelog_v02_settings';
const INITIALIZED_KEY = 'pricelog_initialized_v1';
const TEMPLATE_KEY = 'pricelog_custom_template_v1';

const defaultSettings = {
  standardTax: 10,
  reducedTax: 8,
  defaultPriceType: 'inc'
};

let settings = loadJson(SETTINGS_KEY, defaultSettings);
let products = loadJson(STORAGE_KEY, []);
let openProductId = null;
let editProductId = null;
let saveTimer = null;
let bulkMode = false;
let bulkSelected = new Set();
let storePurchaseMode = false;
let openStoreName = null;
let customTemplate = normalizeTemplateData(loadJson(TEMPLATE_KEY, {version:1, products:[], stores:[]}));
let templateDraft = null;
let readingWasManuallyEdited = false;
let productNameIsComposing = false;
let compositionReadingCandidate = '';
let recommendedReadingMap = new Map();

const $ = (id) => document.getElementById(id);
const listEl = $('productList');
const productTemplate = $('productTemplate');
const storeTemplate = $('storeTemplate');

seedIfEmpty();
loadRecommendedReadingMap();
render();

$('searchInput').addEventListener('input', render);
$('btnAddProduct').addEventListener('click', () => openProductDialog());
$('btnBulkStore').addEventListener('click', () => setBulkMode(!bulkMode));
$('btnBulkCancel').addEventListener('click', () => setBulkMode(false));
$('btnBulkSelectAll').addEventListener('click', toggleBulkSelectAll);
$('btnBulkAdd').addEventListener('click', bulkAddStore);
$('btnEditTemplate').addEventListener('click', openTemplateEditor);
$('btnLoadTemplate').addEventListener('click', loadProductTemplate);
$('btnCloseTemplate').addEventListener('click', () => $('templateDialog').close());
$('btnAddTemplateProduct').addEventListener('click', addTemplateProduct);
$('btnAddTemplateStore').addEventListener('click', addTemplateStore);
$('btnTemplateProductsAll').addEventListener('click', () => setTemplateSelection('products', true));
$('btnTemplateProductsNone').addEventListener('click', () => setTemplateSelection('products', false));
$('btnTemplateStoresAll').addEventListener('click', () => setTemplateSelection('stores', true));
$('btnTemplateStoresNone').addEventListener('click', () => setTemplateSelection('stores', false));
$('btnImportRecommendedProducts').addEventListener('click', importRecommendedProductsToDraft);
$('btnSaveTemplate').addEventListener('click', saveTemplateDraft);
$('btnExportTemplateFile').addEventListener('click', exportTemplateFile);
$('btnStorePurchase').addEventListener('click', () => setStorePurchaseMode(!storePurchaseMode));
$('btnCloseStorePurchase').addEventListener('click', () => setStorePurchaseMode(false));
$('storePurchaseSearch').addEventListener('input', renderStorePurchaseView);
$('btnDeleteAllProducts').addEventListener('click', deleteAllProducts);
$('btnSettings').addEventListener('click', openSettings);

$('productForm').addEventListener('submit', (e) => {
  e.preventDefault();
  saveProductFromDialog();
});

$('btnDeleteProduct').addEventListener('click', () => {
  if (!editProductId) return;
  products = products.filter(p => p.id !== editProductId);
  if (openProductId === editProductId) openProductId = null;
  persistNow();
  $('productDialog').close();
  render();
});

$('settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const st = clampNumber($('standardTax').value, 0, 100, 10);
  const rt = clampNumber($('reducedTax').value, 0, 100, 8);
  settings = {
    standardTax: st,
    reducedTax: rt,
    defaultPriceType: $('defaultPriceType').value === 'ex' ? 'ex' : 'inc'
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  $('settingsDialog').close();
  render();
});

$('btnExport').addEventListener('click', exportBackup);
$('btnImport').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', importBackup);
$('btnCloseHistory').addEventListener('click', () => $('historyDialog').close());

$('productName').addEventListener('compositionstart', () => {
  productNameIsComposing = true;
  readingWasManuallyEdited = false;
  compositionReadingCandidate = '';
});

$('productName').addEventListener('input', (e) => {
  readingWasManuallyEdited = false;

  const candidate = makeReadingCandidate($('productName').value);

  if (productNameIsComposing || e.isComposing) {
    // 変換前のかなを記憶しておく。
    // 変換途中で漢字になっても、よみがな欄は消さない。
    if (candidate) {
      compositionReadingCandidate = candidate;
      $('productReading').value = candidate;
    }
    return;
  }

  autoFillProductReading();
});

$('productName').addEventListener('compositionend', () => {
  productNameIsComposing = false;
  readingWasManuallyEdited = false;

  const finalCandidate = makeReadingCandidate($('productName').value);

  if (finalCandidate) {
    $('productReading').value = finalCandidate;
  } else if (compositionReadingCandidate) {
    $('productReading').value = compositionReadingCandidate;
  }

  compositionReadingCandidate = '';
});

$('productName').addEventListener('blur', () => {
  if (!readingWasManuallyEdited && !productNameIsComposing) {
    const candidate = makeReadingCandidate($('productName').value);
    if (candidate) $('productReading').value = candidate;
  }
});

$('productReading').addEventListener('input', () => {
  readingWasManuallyEdited = true;
});

document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement)) return;
  if (el.type === 'file' || el.disabled || el.readOnly) return;

  const selectable =
    el.type === 'text' ||
    el.type === 'search' ||
    el.inputMode === 'decimal' ||
    el.inputMode === 'numeric';

  if (!selectable) return;

  requestAnimationFrame(() => {
    try {
      el.select();
    } catch {}
  });
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : structuredCloneSafe(fallback);
  } catch {
    return structuredCloneSafe(fallback);
  }
}

function structuredCloneSafe(v) {
  return JSON.parse(JSON.stringify(v));
}

function makeId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function seedIfEmpty() {
  const initialized = localStorage.getItem(INITIALIZED_KEY) === '1';

  // 初回起動時だけサンプル商品を追加する。
  // 一度初期化した後は、商品が0件でも勝手に復活させない。
  if (initialized) return;

  if (!products.length) {
    products = [
      {
        id: makeId('p'),
        name: 'ブレンディ',
        reading: 'ぶれんでぃ',
        amount: 110,
        unit: 'g',
        defaultTax: 8,
        history: [],
        stores: [
          {id:makeId('s'),store:'平和堂',price:598,priceType:'inc',tax:8,couponType:'none',couponValue:0},
          {id:makeId('s'),store:'業務スーパー',price:620,priceType:'inc',tax:8,couponType:'percent',couponValue:20},
          {id:makeId('s'),store:'イオン',price:580,priceType:'inc',tax:8,couponType:'yen',couponValue:50}
        ]
      },
      {
        id: makeId('p'),
        name: '牛乳',
        reading: 'ぎゅうにゅう',
        amount: 1000,
        unit: 'ml',
        defaultTax: 8,
        history: [],
        stores: [
          {id:makeId('s'),store:'平和堂',price:218,priceType:'inc',tax:8,couponType:'none',couponValue:0}
        ]
      }
    ];
    persistNow();
  }

  localStorage.setItem(INITIALIZED_KEY, '1');
}

function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 250);
}

function persistNow() {
  clearTimeout(saveTimer);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(products));
}

function taxOptions(selected) {
  const values = Array.from(new Set([Number(settings.reducedTax), Number(settings.standardTax), Number(selected)]))
    .filter(v => Number.isFinite(v) && v >= 0);
  return values.map(v => `<option value="${escapeAttr(v)}"${Number(v)===Number(selected)?' selected':''}>${v}%</option>`).join('');
}

function render() {
  const q = $('searchInput').value.trim().toLowerCase();

  document.body.classList.toggle('focus-mode', !!openProductId && !storePurchaseMode);

  $('storePurchaseView').classList.toggle('hidden', !storePurchaseMode);
  $('productList').classList.toggle('hidden', storePurchaseMode);
  $('searchInput').closest('.searchbar').classList.toggle('hidden', storePurchaseMode);
  const legend = document.querySelector('.best-legend');
  if (legend) legend.classList.toggle('hidden', storePurchaseMode);

  if (storePurchaseMode) {
    $('emptyState').classList.add('hidden');
    $('bulkStoreBar').classList.add('hidden');
    renderStorePurchaseView();
    return;
  }

  listEl.innerHTML = '';
  listEl.classList.toggle('bulk-mode', bulkMode);

  const visible = products
    .filter(p => !q || p.name.toLowerCase().includes(q) || (p.reading || '').toLowerCase().includes(q))
    .slice()
    .sort(compareProducts);

  $('productCount').textContent = `${visible.length}/${products.length}`;
  $('emptyState').classList.toggle('hidden', visible.length !== 0);

  let lastGroup = null;

  visible.forEach(product => {
    const group = productGroup(product);
    if (group !== lastGroup) {
      const label = document.createElement('div');
      label.className = 'product-group-label';
      label.textContent = group;
      listEl.appendChild(label);
      lastGroup = group;
    }
    const node = productTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = product.id;

    const bests = getBests(product);
    node.querySelector('.product-name').textContent = product.name;
    node.querySelector('.product-size').textContent = `${fmt(product.amount)}${product.unit}`;

    const bestStore = node.querySelector('.best-store');
    const bestPrice = node.querySelector('.best-price');
    const bestUnit = node.querySelector('.best-unit');
    if (bests.before) {
      bestStore.textContent = formatBestStores(bests);

      const baseCalc = bests.before.calc;
      bestPrice.textContent =
        `${fmtPrice(baseCalc.grossBefore)}[${fmtPrice(baseCalc.afterTotal)}](${fmtPriceDelta(baseCalc.afterTotal - baseCalc.grossBefore)})円`;

      bestUnit.textContent =
        `${fmtUnit(baseCalc.beforeUnit)}[${fmtUnit(baseCalc.afterUnit)}](${fmtUnitDelta(baseCalc.afterUnit - baseCalc.beforeUnit)})円/${product.unit}`;

      node.classList.add('has-best');
    } else {
      bestStore.textContent = '価格未登録';
      bestPrice.textContent = '-';
      bestUnit.textContent = '-';
    }

    const bulkWrap = node.querySelector('.bulk-check-wrap');
    const bulkCheck = node.querySelector('.bulk-check');
    bulkWrap.classList.toggle('hidden', !bulkMode);
    bulkCheck.checked = bulkSelected.has(product.id);
    bulkCheck.addEventListener('change', () => {
      if (bulkCheck.checked) bulkSelected.add(product.id);
      else bulkSelected.delete(product.id);
      updateBulkSelectedCount();
    });

    const summary = node.querySelector('.product-summary');
    summary.addEventListener('click', () => {
      if (bulkMode) {
        bulkCheck.checked = !bulkCheck.checked;
        if (bulkCheck.checked) bulkSelected.add(product.id);
        else bulkSelected.delete(product.id);
        updateBulkSelectedCount();
        return;
      }
      openProductId = openProductId === product.id ? null : product.id;
      render();
    });

    const detail = node.querySelector('.product-detail');
    const isOpen = !bulkMode && openProductId === product.id;
    detail.classList.toggle('hidden', !isOpen);
    node.classList.toggle('open', isOpen);

    if (isOpen) {
      node.querySelector('.btn-edit-product').addEventListener('click', () => openProductDialog(product.id));
      node.querySelector('.btn-history').addEventListener('click', () => openHistoryDialog(product.id));
      node.querySelector('.btn-add-store').addEventListener('click', () => {
        product.stores.push({
          id: makeId('s'),
          store: '',
          price: '',
          priceType: settings.defaultPriceType,
          tax: product.defaultTax,
          couponType: 'none',
          couponValue: ''
        });
        persistNow();
        render();
        requestAnimationFrame(() => {
          const card = listEl.querySelector(`[data-id="${cssEscape(product.id)}"]`);
          const rows = card?.querySelectorAll('.store-row');
          rows?.[rows.length - 1]?.querySelector('.st-store')?.focus();
        });
      });

      const storeList = node.querySelector('.store-list');

      product.stores.forEach(row => {
        const flags = {
          before: bests.before?.row.id === row.id,
          after: bests.after?.row.id === row.id
        };
        storeList.appendChild(renderStoreRow(product, row, flags));
      });

      if (!product.stores.length) {
        const hint = document.createElement('div');
        hint.className = 'empty';
        hint.textContent = '「＋店舗」で価格を追加';
        storeList.appendChild(hint);
      }
    }

    listEl.appendChild(node);
  });
}

function renderStoreRow(product, row, bestFlags = {before:false, after:false}) {
  const el = storeTemplate.content.firstElementChild.cloneNode(true);
  const bestMark = el.querySelector('.best-mark');
  applyBestFlags(el, bestMark, bestFlags);

  const store = el.querySelector('.st-store');
  const price = el.querySelector('.st-price');
  const priceType = el.querySelector('.st-price-type');
  const tax = el.querySelector('.st-tax');
  const couponType = el.querySelector('.st-coupon-type');
  const couponValue = el.querySelector('.st-coupon-value');
  const priceResultOut = el.querySelector('.st-price-result');
  const unitOut = el.querySelector('.st-unit');

  store.value = row.store ?? '';
  price.value = row.price ?? '';
  priceType.value = row.priceType === 'ex' ? 'ex' : 'inc';
  tax.innerHTML = taxOptions(row.tax ?? product.defaultTax);
  couponType.value = ['percent','yen'].includes(row.couponType) ? row.couponType : 'none';
  couponValue.value = row.couponValue ?? '';

  let priceEditStart = historyPriceValue(row.price);

  price.addEventListener('focus', () => {
    priceEditStart = historyPriceValue(row.price);
  });

  price.addEventListener('blur', () => {
    const after = historyPriceValue(price.value);
    if (priceEditStart !== null && after !== null && !sameHistoryPrice(priceEditStart, after)) {
      addPriceHistory(product, row.store || store.value.trim(), priceEditStart, after);
    }
    priceEditStart = after;
  });

  function sync() {
    row.store = store.value.trim();
    row.price = numberOrBlank(price.value);
    row.priceType = priceType.value;
    row.tax = Number(tax.value);
    row.couponType = couponType.value;
    row.couponValue = numberOrBlank(couponValue.value);

    couponValue.disabled = row.couponType === 'none';
    couponValue.placeholder = row.couponType === 'percent' ? '%' : row.couponType === 'yen' ? '円' : '-';

    const calc = calcRow(product, row);
    if (calc) {
      priceResultOut.textContent = `${fmtPrice(calc.grossBefore)}[${fmtPrice(calc.afterTotal)}](${fmtPriceDelta(calc.afterTotal - calc.grossBefore)})`;
      unitOut.textContent = `${fmtUnit(calc.beforeUnit)}[${fmtUnit(calc.afterUnit)}](${fmtUnitDelta(calc.afterUnit - calc.beforeUnit)})`;
    } else {
      priceResultOut.textContent = '-';
      unitOut.textContent = '-';
    }

    persistSoon();
    refreshBestOnly(product.id);
  }

  [store, price, priceType, tax, couponType, couponValue].forEach(ctrl => {
    ctrl.addEventListener('input', sync);
    ctrl.addEventListener('change', sync);
  });

  el.querySelector('.st-delete').addEventListener('click', () => {
    product.stores = product.stores.filter(s => s.id !== row.id);
    persistNow();
    render();
  });

  sync();
  return el;
}

function refreshBestOnly(productId) {
  const product = products.find(p => p.id === productId);
  const card = listEl.querySelector(`[data-id="${cssEscape(productId)}"]`);
  if (!product || !card) return;

  const bests = getBests(product);
  const hasBest = !!bests.before;

  card.querySelector('.best-store').textContent = hasBest ? formatBestStores(bests) : '価格未登録';

  const bestPrice = card.querySelector('.best-price');
  const bestUnit = card.querySelector('.best-unit');

  if (hasBest) {
    const baseCalc = bests.before.calc;

    bestPrice.textContent =
      `${fmtPrice(baseCalc.grossBefore)}[${fmtPrice(baseCalc.afterTotal)}](${fmtPriceDelta(baseCalc.afterTotal - baseCalc.grossBefore)})円`;

    bestUnit.textContent =
      `${fmtUnit(baseCalc.beforeUnit)}[${fmtUnit(baseCalc.afterUnit)}](${fmtUnitDelta(baseCalc.afterUnit - baseCalc.beforeUnit)})円/${product.unit}`;
  } else {
    bestPrice.textContent = '-';
    bestUnit.textContent = '-';
  }

  card.classList.toggle('has-best', hasBest);

  const rowEls = card.querySelectorAll('.store-row');
  rowEls.forEach((rowEl, i) => {
    const row = product.stores[i];
    const calc = row ? calcRow(product, row) : null;
    const priceResultOut = rowEl.querySelector('.st-price-result');
    const unitOut = rowEl.querySelector('.st-unit');
    const mark = rowEl.querySelector('.best-mark');

    if (priceResultOut) {
      priceResultOut.textContent = calc
        ? `${fmtPrice(calc.grossBefore)}[${fmtPrice(calc.afterTotal)}](${fmtPriceDelta(calc.afterTotal - calc.grossBefore)})`
        : '-';
    }

    if (unitOut) {
      unitOut.textContent = calc
        ? `${fmtUnit(calc.beforeUnit)}[${fmtUnit(calc.afterUnit)}](${fmtUnitDelta(calc.afterUnit - calc.beforeUnit)})`
        : '-';
    }

    applyBestFlags(rowEl, mark, {
      before: !!bests.before && bests.before.row.id === row?.id,
      after: !!bests.after && bests.after.row.id === row?.id
    });
  });
}

function calcRow(product, row) {
  const price = Number(row.price);
  const amount = Number(product.amount);
  const tax = Number(row.tax);
  if (!(price > 0) || !(amount > 0) || !(tax >= 0)) return null;

  const grossBefore = row.priceType === 'ex' ? price * (1 + tax / 100) : price;
  const netBefore = row.priceType === 'ex' ? price : price / (1 + tax / 100);

  let afterTotal = grossBefore;
  const cv = Math.max(0, Number(row.couponValue) || 0);

  if (row.couponType === 'percent') {
    afterTotal = grossBefore * (1 - Math.min(cv, 100) / 100);
  } else if (row.couponType === 'yen') {
    afterTotal = Math.max(0, grossBefore - cv);
  }

  return {
    grossBefore,
    netBefore,
    afterTotal,
    beforeUnit: grossBefore / amount,
    afterUnit: afterTotal / amount
  };
}

function getBests(product) {
  let before = null;

  // ★ = クーポンを使わない通常時の最安店舗
  product.stores.forEach(row => {
    const calc = calcRow(product, row);
    if (!calc) return;

    if (!before || calc.beforeUnit < before.calc.beforeUnit) {
      before = { row, store: row.store, calc };
    }
  });

  if (!before) return { before: null, after: null };

  // ◆ = ★とは別店舗で、クーポン使用後価格が
  // ★店舗の通常価格・クーポン適用後価格の両方より安い場合だけ表示。
  let after = null;

  product.stores.forEach(row => {
    if (row.id === before.row.id) return;

    const calc = calcRow(product, row);
    if (!calc) return;

    const beatsBaseBefore = calc.afterUnit < before.calc.beforeUnit;
    const beatsBaseAfter = calc.afterUnit < before.calc.afterUnit;

    if (!beatsBaseBefore || !beatsBaseAfter) return;

    if (!after || calc.afterUnit < after.calc.afterUnit) {
      after = { row, store: row.store, calc };
    }
  });

  return { before, after };
}

function formatBestStores(bests) {
  if (!bests.before) return '価格未登録';

  const parts = [`★${bests.before.store || '店舗未入力'}`];

  if (bests.after) {
    parts.push(`◆${bests.after.store || '店舗未入力'}`);
  }

  return parts.join('　');
}

function applyBestFlags(rowEl, markEl, flags) {
  const mark = flags.before ? '★' : (flags.after ? '◆' : '');
  if (markEl) markEl.textContent = mark;
}

function ensureHistory(product) {
  if (!Array.isArray(product.history)) product.history = [];
  if (product.history.length > 20) product.history = product.history.slice(0, 20);
  return product.history;
}

function historyPriceValue(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sameHistoryPrice(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.0001;
}

function addPriceHistory(product, storeName, beforePrice, afterPrice) {
  if (beforePrice === null || afterPrice === null || sameHistoryPrice(beforePrice, afterPrice)) return;

  const history = ensureHistory(product);
  history.unshift({
    id: makeId('h'),
    updatedAt: new Date().toISOString(),
    store: (storeName || '店舗未入力').trim() || '店舗未入力',
    beforePrice: Number(beforePrice),
    afterPrice: Number(afterPrice)
  });

  if (history.length > 20) history.length = 20;
  persistNow();
}

function openHistoryDialog(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;

  const history = ensureHistory(product);
  $('historyProductName').textContent = product.name;
  const list = $('historyList');
  list.innerHTML = '';

  history.forEach(item => {
    const row = document.createElement('div');
    row.className = 'history-grid history-row';

    const date = document.createElement('span');
    date.textContent = formatHistoryDate(item.updatedAt);

    const store = document.createElement('span');
    store.className = 'history-store';
    store.textContent = item.store || '店舗未入力';

    const before = document.createElement('span');
    before.className = 'history-price';
    before.textContent = `${fmtPrice(item.beforePrice)}円`;

    const after = document.createElement('span');
    after.className = 'history-price';
    after.textContent = `${fmtPrice(item.afterPrice)}円`;

    row.append(date, store, before, after);
    list.appendChild(row);
  });

  $('historyTableWrap').classList.toggle('hidden', history.length === 0);
  $('historyEmpty').classList.toggle('hidden', history.length !== 0);
  $('historyDialog').showModal();
}

function formatHistoryDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${h}:${min}`;
}

function setStorePurchaseMode(enabled) {
  storePurchaseMode = !!enabled;

  if (storePurchaseMode) {
    bulkMode = false;
    bulkSelected.clear();
    openProductId = null;
    $('btnBulkStore').textContent = '一括店舗';
    $('btnStorePurchase').textContent = '購入品中';
  } else {
    openStoreName = null;
    $('storePurchaseSearch').value = '';
    $('btnStorePurchase').textContent = '店舗購入品';
  }

  render();
}

function buildStorePurchaseMap() {
  const map = new Map();

  products.forEach(product => {
    const bests = getBests(product);
    if (!bests.before) return;

    const addItem = (entry, mark) => {
      const storeName = String(entry.store || '').trim() || '店舗未入力';
      if (!map.has(storeName)) map.set(storeName, []);
      map.get(storeName).push({
        product,
        row: entry.row,
        calc: entry.calc,
        mark
      });
    };

    addItem(bests.before, '★');
    if (bests.after) addItem(bests.after, '◆');
  });

  return map;
}

function renderStorePurchaseView() {
  const container = $('storePurchaseList');
  if (!container) return;

  container.innerHTML = '';

  const q = $('storePurchaseSearch').value.trim().toLowerCase();
  const storeMap = buildStorePurchaseMap();

  const stores = Array.from(storeMap.entries())
    .filter(([storeName]) => !q || storeName.toLowerCase().includes(q))
    .sort((a, b) => a[0].localeCompare(b[0], 'ja', { sensitivity: 'base', numeric: true }));

  $('storePurchaseEmpty').classList.toggle('hidden', stores.length !== 0);

  stores.forEach(([storeName, items]) => {
    items.sort((a, b) => compareProducts(a.product, b.product));

    const card = document.createElement('article');
    card.className = 'store-card';
    if (openStoreName === storeName) card.classList.add('open');

    const summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'store-summary';

    const name = document.createElement('span');
    name.className = 'store-summary-name';
    name.textContent = storeName;

    const count = document.createElement('span');
    count.className = 'store-summary-count';
    const starCount = items.filter(item => item.mark === '★').length;
    const diamondCount = items.filter(item => item.mark === '◆').length;
    const parts = [];
    if (starCount) parts.push(`★${starCount}`);
    if (diamondCount) parts.push(`◆${diamondCount}`);
    count.textContent = `${parts.join(' / ')}　計${items.length}品`;

    const chev = document.createElement('span');
    chev.className = 'store-summary-chev';
    chev.textContent = '›';

    summary.append(name, count, chev);
    summary.addEventListener('click', () => {
      openStoreName = openStoreName === storeName ? null : storeName;
      renderStorePurchaseView();
    });

    card.appendChild(summary);

    if (openStoreName === storeName) {
      const productList = document.createElement('div');
      productList.className = 'store-product-list';

      items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'store-product-row';

        const mark = document.createElement('span');
        mark.className = 'store-product-mark';
        mark.textContent = item.mark;

        const nameWrap = document.createElement('div');
        nameWrap.className = 'store-product-name-wrap';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'store-product-check';
        checkbox.setAttribute('aria-label', `${item.product.name}を買い物チェック`);

        const productName = document.createElement('span');
        productName.className = 'store-product-name';
        productName.textContent = item.product.name;

        const meta = document.createElement('span');
        meta.className = 'store-product-meta';
        meta.textContent = `${fmt(item.product.amount)}${item.product.unit}`;

        nameWrap.append(checkbox, productName, meta);

        const price = document.createElement('span');
        price.className = 'store-product-price';
        price.textContent =
          `${fmtPrice(item.calc.grossBefore)}[${fmtPrice(item.calc.afterTotal)}](${fmtPriceDelta(item.calc.afterTotal - item.calc.grossBefore)})円`;

        const unit = document.createElement('span');
        unit.className = 'store-product-unit';
        unit.textContent =
          `${fmtUnit(item.calc.beforeUnit)}[${fmtUnit(item.calc.afterUnit)}](${fmtUnitDelta(item.calc.afterUnit - item.calc.beforeUnit)})円/${item.product.unit}`;

        row.append(mark, nameWrap, price, unit);
        productList.appendChild(row);
      });

      card.appendChild(productList);
    }

    container.appendChild(card);
  });
}

function deleteAllProducts() {
  const msg = $('deleteAllMessage');

  if (!products.length) {
    msg.textContent = '削除する商品はないよ。';
    return;
  }

  const ok = window.confirm(
    `登録中の${products.length}商品をすべて削除する？\n店舗価格と変更履歴も消えるよ。`
  );

  if (!ok) return;

  products = [];
  openProductId = null;
  openStoreName = null;
  bulkSelected.clear();

  persistNow();
  localStorage.setItem(INITIALIZED_KEY, '1');

  msg.textContent = '全商品を削除したよ。';
  render();
}

function setBulkMode(enabled) {
  if (enabled) storePurchaseMode = false;
  bulkMode = !!enabled;
  if (!bulkMode) {
    bulkSelected.clear();
    $('bulkStoreName').value = '';
    $('bulkMessage').textContent = '';
  } else {
    openProductId = null;
  }

  $('bulkStoreBar').classList.toggle('hidden', !bulkMode);
  $('btnBulkStore').textContent = bulkMode ? '一括中' : '一括店舗';
  updateBulkSelectedCount();
  render();

  if (bulkMode) {
    requestAnimationFrame(() => $('bulkStoreName').focus());
  }
}

function updateBulkSelectedCount() {
  $('bulkSelectedCount').textContent = `${bulkSelected.size}件選択`;
}

function toggleBulkSelectAll() {
  const q = $('searchInput').value.trim().toLowerCase();
  const visible = products.filter(p =>
    !q ||
    p.name.toLowerCase().includes(q) ||
    (p.reading || '').toLowerCase().includes(q)
  );

  const allSelected = visible.length > 0 && visible.every(p => bulkSelected.has(p.id));

  visible.forEach(p => {
    if (allSelected) bulkSelected.delete(p.id);
    else bulkSelected.add(p.id);
  });

  updateBulkSelectedCount();
  render();
}

function bulkAddStore() {
  const storeName = $('bulkStoreName').value.trim();

  if (!storeName) {
    $('bulkMessage').textContent = '店舗名を入力してね。';
    $('bulkStoreName').focus();
    return;
  }

  if (bulkSelected.size === 0) {
    $('bulkMessage').textContent = '商品を1つ以上選択してね。';
    return;
  }

  let added = 0;
  let skipped = 0;

  products.forEach(product => {
    if (!bulkSelected.has(product.id)) return;

    const duplicate = product.stores.some(row =>
      String(row.store || '').trim().toLowerCase() === storeName.toLowerCase()
    );

    if (duplicate) {
      skipped += 1;
      return;
    }

    product.stores.push({
      id: makeId('s'),
      store: storeName,
      price: '',
      priceType: settings.defaultPriceType,
      tax: product.defaultTax,
      couponType: 'none',
      couponValue: ''
    });

    added += 1;
  });

  persistNow();

  $('bulkMessage').textContent = skipped
    ? `${added}商品に追加。${skipped}商品は同じ店舗があるのでスキップ。`
    : `${added}商品に「${storeName}」を追加したよ。`;

  bulkSelected.clear();
  updateBulkSelectedCount();
  render();
}

function normalizeTemplateData(data) {
  const result = { version: 1, products: [], stores: [] };

  if (data && Array.isArray(data.products)) {
    result.products = data.products
      .map(item => ({
        id: String(item.id || makeId('tp')),
        selected: item.selected !== false,
        name: String(item.name || '').trim(),
        reading: normalizeReadingInput(item.reading || ''),
        amount: Number(item.amount),
        unit: String(item.unit || '').trim(),
        defaultTax: Number.isFinite(Number(item.defaultTax)) ? Number(item.defaultTax) : settings.reducedTax
      }))
      .filter(item => item.name && item.amount > 0 && item.unit);
  }

  if (data && Array.isArray(data.stores)) {
    result.stores = data.stores
      .map(item => ({
        id: String(item.id || makeId('ts')),
        selected: item.selected !== false,
        name: String(item.name || '').trim()
      }))
      .filter(item => item.name);
  }

  return result;
}

function cloneTemplate(data) {
  return JSON.parse(JSON.stringify(normalizeTemplateData(data)));
}

function persistTemplateNow() {
  customTemplate = normalizeTemplateData(customTemplate);
  localStorage.setItem(TEMPLATE_KEY, JSON.stringify(customTemplate));
  updateTemplateSummary();
}

function selectedTemplateProducts(data = customTemplate) {
  return normalizeTemplateData(data).products.filter(item => item.selected);
}

function selectedTemplateStores(data = customTemplate) {
  return normalizeTemplateData(data).stores.filter(item => item.selected);
}

function updateTemplateSummary() {
  const el = $('templateSummary');
  if (!el) return;

  const productsCount = selectedTemplateProducts().length;
  const storesCount = selectedTemplateStores().length;
  const allProducts = customTemplate.products.length;
  const allStores = customTemplate.stores.length;

  el.textContent =
    `商品 ${productsCount}/${allProducts}件選択　店舗 ${storesCount}/${allStores}件選択`;
}

function refreshTemplateTaxOptions() {
  const select = $('tplProductTax');
  if (!select) return;

  const current = select.value;
  const values = Array.from(new Set([Number(settings.reducedTax), Number(settings.standardTax)]))
    .filter(v => Number.isFinite(v) && v >= 0);

  select.innerHTML = '';
  values.forEach(v => {
    const option = document.createElement('option');
    option.value = String(v);
    option.textContent = `${v}%`;
    select.appendChild(option);
  });

  select.value = values.includes(Number(current))
    ? String(current)
    : String(settings.reducedTax);
}

function openTemplateEditor() {
  templateDraft = cloneTemplate(customTemplate);
  refreshTemplateTaxOptions();
  $('templateEditorMessage').textContent = '';
  renderTemplateEditor();
  $('templateDialog').showModal();
}

function renderTemplateEditor() {
  if (!templateDraft) return;

  const productList = $('templateProductList');
  const storeList = $('templateStoreList');

  productList.innerHTML = '';
  storeList.innerHTML = '';

  const sortedProducts = templateDraft.products
    .slice()
    .sort((a, b) => compareProducts(a, b));

  sortedProducts.forEach(item => {
    const row = document.createElement('div');
    row.className = 'template-entry-row template-product-row';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'template-entry-check';
    check.checked = !!item.selected;
    check.addEventListener('change', () => {
      item.selected = check.checked;
    });

    const name = document.createElement('span');
    name.className = 'template-entry-name';
    name.textContent = item.name;

    const reading = document.createElement('span');
    reading.className = 'template-entry-reading';
    reading.textContent = item.reading || '-';

    const amount = document.createElement('span');
    amount.className = 'template-entry-meta';
    amount.textContent = `${fmt(item.amount)}${item.unit}`;

    const tax = document.createElement('span');
    tax.className = 'template-entry-meta';
    tax.textContent = `${item.defaultTax}%`;

    const type = document.createElement('span');
    type.className = 'template-entry-meta';
    type.textContent = '商品';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'template-entry-delete';
    del.textContent = '×';
    del.setAttribute('aria-label', `${item.name}を削除`);
    del.addEventListener('click', () => {
      templateDraft.products = templateDraft.products.filter(x => x.id !== item.id);
      renderTemplateEditor();
    });

    row.append(check, name, reading, amount, tax, type, del);
    productList.appendChild(row);
  });

  templateDraft.stores
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'ja', {sensitivity:'base', numeric:true}))
    .forEach(item => {
      const row = document.createElement('div');
      row.className = 'template-entry-row template-store-row';

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'template-entry-check';
      check.checked = !!item.selected;
      check.addEventListener('change', () => {
        item.selected = check.checked;
      });

      const name = document.createElement('span');
      name.className = 'template-entry-name';
      name.textContent = item.name;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'template-entry-delete';
      del.textContent = '×';
      del.setAttribute('aria-label', `${item.name}を削除`);
      del.addEventListener('click', () => {
        templateDraft.stores = templateDraft.stores.filter(x => x.id !== item.id);
        renderTemplateEditor();
      });

      row.append(check, name, del);
      storeList.appendChild(row);
    });

  $('templateProductEmpty').classList.toggle('hidden', templateDraft.products.length !== 0);
  $('templateStoreEmpty').classList.toggle('hidden', templateDraft.stores.length !== 0);
}

function addTemplateProduct() {
  if (!templateDraft) return;

  const name = $('tplProductName').value.trim();
  const reading = normalizeReadingInput($('tplProductReading').value);
  const amount = Number($('tplProductAmount').value);
  const unit = $('tplProductUnit').value;
  const tax = Number($('tplProductTax').value);

  if (!name || !(amount > 0) || !unit) {
    $('templateEditorMessage').textContent = '商品名・内容量・単位を確認してね。';
    return;
  }

  const candidate = {
    id: makeId('tp'),
    selected: true,
    name,
    reading,
    amount,
    unit,
    defaultTax: Number.isFinite(tax) ? tax : settings.reducedTax
  };

  const key = productTemplateKey(candidate);
  const duplicate = templateDraft.products.some(item => productTemplateKey(item) === key);

  if (duplicate) {
    $('templateEditorMessage').textContent = '同じ商品はすでにテンプレートにあるよ。';
    return;
  }

  templateDraft.products.push(candidate);

  $('tplProductName').value = '';
  $('tplProductReading').value = '';
  $('templateEditorMessage').textContent = `${name}を追加したよ。`;
  renderTemplateEditor();
  $('tplProductName').focus();
}

function addTemplateStore() {
  if (!templateDraft) return;

  const name = $('tplStoreName').value.trim();
  if (!name) {
    $('templateEditorMessage').textContent = '店舗名を入力してね。';
    return;
  }

  const duplicate = templateDraft.stores.some(item =>
    item.name.trim().toLowerCase() === name.toLowerCase()
  );

  if (duplicate) {
    $('templateEditorMessage').textContent = '同じ店舗はすでにテンプレートにあるよ。';
    return;
  }

  templateDraft.stores.push({
    id: makeId('ts'),
    selected: true,
    name
  });

  $('tplStoreName').value = '';
  $('templateEditorMessage').textContent = `${name}を追加したよ。`;
  renderTemplateEditor();
  $('tplStoreName').focus();
}

function setTemplateSelection(type, selected) {
  if (!templateDraft || !Array.isArray(templateDraft[type])) return;
  templateDraft[type].forEach(item => item.selected = !!selected);
  renderTemplateEditor();
}

async function importRecommendedProductsToDraft() {
  if (!templateDraft) return;

  const btn = $('btnImportRecommendedProducts');
  btn.disabled = true;
  $('templateEditorMessage').textContent = 'おすすめ商品を読み込み中…';

  try {
    const response = await fetch('./template-products.json?v=1', { cache: 'no-store' });
    if (!response.ok) throw new Error('recommended template fetch failed');

    const data = await response.json();
    if (!Array.isArray(data.products)) throw new Error('invalid recommended template');

    const keys = new Set(templateDraft.products.map(productTemplateKey));
    let added = 0;

    data.products.forEach(item => {
      const candidate = {
        id: makeId('tp'),
        selected: true,
        name: String(item.name || '').trim(),
        reading: normalizeReadingInput(item.reading || ''),
        amount: Number(item.amount),
        unit: String(item.unit || '').trim(),
        defaultTax: Number.isFinite(Number(item.defaultTax))
          ? Number(item.defaultTax)
          : settings.reducedTax
      };

      if (!candidate.name || !(candidate.amount > 0) || !candidate.unit) return;

      const key = productTemplateKey(candidate);
      if (keys.has(key)) return;

      templateDraft.products.push(candidate);
      keys.add(key);
      added += 1;
    });

    $('templateEditorMessage').textContent =
      added ? `おすすめ商品を${added}件追加したよ。` : '追加できるおすすめ商品はなかったよ。';

    renderTemplateEditor();
  } catch {
    $('templateEditorMessage').textContent = 'おすすめ商品を読み込めなかったよ。';
  } finally {
    btn.disabled = false;
  }
}

function saveTemplateDraft() {
  if (!templateDraft) return;

  customTemplate = normalizeTemplateData(templateDraft);
  persistTemplateNow();

  const p = selectedTemplateProducts().length;
  const st = selectedTemplateStores().length;

  $('templateEditorMessage').textContent =
    `テンプレートを保存したよ。商品${p}件、店舗${st}件が読み込み対象。`;

  updateTemplateSummary();
}

function getSelectedTemplatePayload(source = customTemplate) {
  const normalized = normalizeTemplateData(source);

  return {
    app: 'PriceLog',
    type: 'custom-template',
    version: 1,
    createdAt: new Date().toISOString(),
    products: normalized.products
      .filter(item => item.selected)
      .map(item => ({
        name: item.name,
        reading: item.reading,
        amount: item.amount,
        unit: item.unit,
        defaultTax: item.defaultTax
      })),
    stores: normalized.stores
      .filter(item => item.selected)
      .map(item => ({ name: item.name }))
  };
}

function exportTemplateFile() {
  if (!templateDraft) return;

  const selectedProducts = templateDraft.products.filter(item => item.selected);
  const selectedStores = templateDraft.stores.filter(item => item.selected);

  if (!selectedProducts.length) {
    $('templateEditorMessage').textContent = '商品を1つ以上チェックしてね。';
    return;
  }

  const payload = getSelectedTemplatePayload(templateDraft);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PriceLog-template-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  $('templateEditorMessage').textContent =
    `商品${selectedProducts.length}件・店舗${selectedStores.length}件のテンプレートJSONを書き出したよ。`;
}

function loadProductTemplate() {
  const msg = $('templateMessage');
  const templateProducts = selectedTemplateProducts();
  const templateStores = selectedTemplateStores();

  if (!templateProducts.length) {
    msg.textContent = 'テンプレートの商品を1つ以上選択してね。';
    return;
  }

  const productByKey = new Map(products.map(product => [productTemplateKey(product), product]));
  let addedProducts = 0;
  let addedStoreRows = 0;

  templateProducts.forEach(item => {
    const key = productTemplateKey(item);
    let product = productByKey.get(key);

    if (!product) {
      product = {
        id: makeId('p'),
        name: item.name,
        reading: item.reading,
        amount: item.amount,
        unit: item.unit,
        defaultTax: item.defaultTax,
        history: [],
        stores: []
      };

      products.push(product);
      productByKey.set(key, product);
      addedProducts += 1;
    }

    templateStores.forEach(storeItem => {
      const storeName = storeItem.name.trim();
      if (!storeName) return;

      const exists = product.stores.some(row =>
        String(row.store || '').trim().toLowerCase() === storeName.toLowerCase()
      );

      if (exists) return;

      product.stores.push({
        id: makeId('s'),
        store: storeName,
        price: '',
        priceType: settings.defaultPriceType,
        tax: product.defaultTax,
        couponType: 'none',
        couponValue: ''
      });

      addedStoreRows += 1;
    });
  });

  persistNow();
  render();

  msg.textContent =
    `商品${addedProducts}件、店舗行${addedStoreRows}件を差分追加したよ。既存データはそのまま。`;
}


function productTemplateKey(product) {
  const name = katakanaToHiragana(String(product.name || ''))
    .normalize('NFKC')
    .trim()
    .toLowerCase();

  const unit = String(product.unit || '').normalize('NFKC').trim().toLowerCase();
  const amount = Number(product.amount);

  return `${name}|${Number.isFinite(amount) ? amount : ''}|${unit}`;
}

function normalizeProductNameKey(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function hasKanji(value) {
  return /[\u3400-\u4DBF\u4E00-\u9FFF]/.test(String(value || ''));
}

async function loadRecommendedReadingMap() {
  try {
    const response = await fetch('./template-products.json?v=1', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (!Array.isArray(data.products)) return;
    const map = new Map();
    data.products.forEach(item => {
      const key = normalizeProductNameKey(item?.name);
      const reading = normalizeReadingInput(item?.reading || '');
      if (key && reading) map.set(key, reading);
    });
    recommendedReadingMap = map;
    if ($('productDialog')?.open && !readingWasManuallyEdited && !$('productReading').value.trim()) autoFillProductReading();
  } catch {}
}

function findKnownReading(name) {
  const key = normalizeProductNameKey(name);
  if (!key) return '';
  for (const p of products) {
    if (normalizeProductNameKey(p?.name) === key && p?.reading) return normalizeReadingInput(p.reading);
  }
  if (customTemplate?.products) {
    for (const p of customTemplate.products) {
      if (normalizeProductNameKey(p?.name) === key && p?.reading) return normalizeReadingInput(p.reading);
    }
  }
  if (templateDraft?.products) {
    for (const p of templateDraft.products) {
      if (normalizeProductNameKey(p?.name) === key && p?.reading) return normalizeReadingInput(p.reading);
    }
  }
  return recommendedReadingMap.get(key) || '';
}

function makeReadingCandidate(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const known = findKnownReading(raw);
  if (known) return known;
  if (!hasKanji(raw)) return katakanaToHiragana(raw).normalize('NFKC').toLowerCase();
  return '';
}

function autoFillProductReading() {
  const candidate = makeReadingCandidate($('productName').value);

  // 読みを作れる時だけ更新。
  // IMEで漢字へ変換した場合は compositionend で
  // 変換前のかな読みを残す。
  if (candidate) $('productReading').value = candidate;
}

function normalizeReadingInput(value) {
  return String(value || '').trim();
}

function katakanaToHiragana(value) {
  return String(value || '').replace(/[\u30A1-\u30F6]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

function normalizeSortText(product) {
  const raw = (product.reading || product.name || '').trim();
  return katakanaToHiragana(raw)
    .normalize('NFKC')
    .toLowerCase();
}

function productGroup(product) {
  const text = normalizeSortText(product);
  if (!text) return 'その他';

  const ch = text[0];

  if (/[a-z]/.test(ch)) return ch.toUpperCase();

  const rows = [
    ['あ', /^[ぁあぃいうぅえぇお]/],
    ['か', /^[かがきぎくぐけげこご]/],
    ['さ', /^[さざしじすずせぜそぞ]/],
    ['た', /^[ただちぢっつづてでとど]/],
    ['な', /^[なにぬねの]/],
    ['は', /^[はばぱひびぴふぶぷへべぺほぼぽ]/],
    ['ま', /^[まみむめも]/],
    ['や', /^[ゃやゅゆょよ]/],
    ['ら', /^[らりるれろ]/],
    ['わ', /^[ゎわをん]/]
  ];

  for (const [label, pattern] of rows) {
    if (pattern.test(ch)) return label;
  }

  if (/[0-9]/.test(ch)) return '0-9';

  return 'その他';
}

function groupRank(group) {
  const jp = ['あ','か','さ','た','な','は','ま','や','ら','わ'];
  const jpIndex = jp.indexOf(group);
  if (jpIndex >= 0) return jpIndex;

  if (/^[A-Z]$/.test(group)) return 100 + group.charCodeAt(0) - 65;
  if (group === '0-9') return 200;
  return 300;
}

function compareProducts(a, b) {
  const ga = productGroup(a);
  const gb = productGroup(b);

  const groupDiff = groupRank(ga) - groupRank(gb);
  if (groupDiff !== 0) return groupDiff;

  const sa = normalizeSortText(a);
  const sb = normalizeSortText(b);

  const byReading = sa.localeCompare(sb, 'ja', {
    sensitivity: 'base',
    numeric: true
  });
  if (byReading !== 0) return byReading;

  return String(a.name || '').localeCompare(String(b.name || ''), 'ja', {
    sensitivity: 'base',
    numeric: true
  });
}

function openProductDialog(id = null) {
  editProductId = id;
  const p = id ? products.find(x => x.id === id) : null;

  // 商品名を触るまでは既存の読みをそのまま表示。
  // 商品名を入力し始めたら、自動読みを強制更新する。
  // その後、よみがな欄を手修正した時だけ自動更新を停止する。
  readingWasManuallyEdited = false;
  productNameIsComposing = false;
  compositionReadingCandidate = '';

  $('productDialogTitle').textContent = p ? '商品設定' : '商品追加';
  $('productName').value = p?.name ?? '';
  $('productReading').value = p?.reading ?? '';
  $('productAmount').value = p?.amount ?? 100;
  $('productUnit').value = p?.unit ?? 'g';

  const taxSelect = $('productTax');
  const selectedTax = p?.defaultTax ?? settings.reducedTax;
  taxSelect.innerHTML = taxOptions(selectedTax);
  taxSelect.value = String(selectedTax);

  $('btnDeleteProduct').classList.toggle('hidden', !p);
  $('productDialog').showModal();
  requestAnimationFrame(() => $('productName').focus());
}

function saveProductFromDialog() {
  const name = $('productName').value.trim();

  if (!$('productReading').value.trim()) {
    const candidate = makeReadingCandidate(name);
    if (candidate) $('productReading').value = candidate;
  }

  const amount = Number($('productAmount').value);
  if (!name || !(amount > 0)) return;

  if (editProductId) {
    const p = products.find(x => x.id === editProductId);
    if (p) {
      p.name = name;
      p.reading = normalizeReadingInput($('productReading').value);
      p.amount = amount;
      p.unit = $('productUnit').value;
      p.defaultTax = Number($('productTax').value);
    }
  } else {
    const p = {
      id: makeId('p'),
      name,
      reading: normalizeReadingInput($('productReading').value),
      amount,
      unit: $('productUnit').value,
      defaultTax: Number($('productTax').value),
      history: [],
      stores: [{
        id: makeId('s'),
        store: '',
        price: '',
        priceType: settings.defaultPriceType,
        tax: Number($('productTax').value),
        couponType: 'none',
        couponValue: ''
      }]
    };
    products.unshift(p);
    openProductId = p.id;
  }

  persistNow();
  $('productDialog').close();
  render();
}

function openSettings() {
  $('standardTax').value = settings.standardTax;
  $('reducedTax').value = settings.reducedTax;
  $('defaultPriceType').value = settings.defaultPriceType;
  updateTemplateSummary();
  $('templateMessage').textContent = '';
  $('settingsDialog').showModal();
}

function exportBackup() {
  const payload = {
    app: 'PriceLog',
    version: 2,
    exportedAt: new Date().toISOString(),
    settings,
    products,
    customTemplate
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PriceLog-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importBackup(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      if (!Array.isArray(data.products)) throw new Error('invalid');
      products = data.products;
      settings = {...defaultSettings, ...(data.settings || {})};

      if (data.customTemplate) {
        customTemplate = normalizeTemplateData(data.customTemplate);
        localStorage.setItem(TEMPLATE_KEY, JSON.stringify(customTemplate));
      }

      persistNow();
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      localStorage.setItem(INITIALIZED_KEY, '1');
      updateTemplateSummary();
      $('settingsDialog').close();
      render();
    } catch {
      alert('バックアップファイルを読み込めなかったよ。');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
}

function numberOrBlank(v) {
  if (v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function fmt(v) {
  return Number(v).toLocaleString('ja-JP', {maximumFractionDigits:2});
}

function fmtUnit(v) {
  return Number(v).toLocaleString('ja-JP', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function fmtPrice(v) {
  return Number(v).toLocaleString('ja-JP', {maximumFractionDigits:1});
}

function fmtPriceDelta(v) {
  const n = Math.abs(Number(v)) < 0.05 ? 0 : Number(v);
  if (n === 0) return '0';
  return (n > 0 ? '+' : '') + n.toLocaleString('ja-JP', {maximumFractionDigits:1});
}

function fmtUnitDelta(v) {
  const n = Math.abs(Number(v)) < 0.005 ? 0 : Number(v);
  if (n === 0) return '0';
  return (n > 0 ? '+' : '') + n.toLocaleString('ja-JP', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function fmtYen(v) {
  return Number(v).toLocaleString('ja-JP', {maximumFractionDigits:1}) + '円';
}

function escapeAttr(v) {
  return String(v).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function cssEscape(v) {
  return window.CSS?.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&');
}
})();
