(() => {
'use strict';

const STORAGE_KEY = 'pricelog_v02_data';
const SETTINGS_KEY = 'pricelog_v02_settings';
const INITIALIZED_KEY = 'pricelog_initialized_v1';
const TEMPLATE_KEY = 'pricelog_custom_template_v1';

const YAHOO_WORKER_URL = 'https://pricelog-yahoo.pricelog-api.workers.dev';

const defaultSettings = {
  standardTax: 10,
  reducedTax: 8,
  defaultPriceType: 'inc',
  yahooClientId: ''
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
let barcodeStream = null;
let barcodeDetector = null;
let barcodeScanTimer = null;
let barcodeScanning = false;
let barcodeLookupData = null;
let productImageDeletePending = false;
let yahooRequestChain = Promise.resolve();
let yahooLastRequestAt = 0;
const YAHOO_MIN_REQUEST_INTERVAL_MS = 1200;
const yahooLookupInflight = new Map();
const yahooLookupCache = new Map();

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
$('btnToggleYahooClientId').addEventListener('click', toggleYahooClientIdVisibility);
$('btnTestYahooApi').addEventListener('click', testYahooShoppingApi);

$('productForm').addEventListener('submit', (e) => {
  e.preventDefault();
  saveProductFromDialog();
});

$('btnDeleteProductImage').addEventListener('click', () => {
  if (!editProductId) return;

  productImageDeletePending = true;
  $('productImageSettingPreview').classList.add('hidden');
  $('btnDeleteProductImage').classList.add('hidden');
  $('productImageDeleteNote').classList.remove('hidden');
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
    defaultPriceType: $('defaultPriceType').value === 'ex' ? 'ex' : 'inc',
    yahooClientId: $('yahooClientId').value.trim()
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  $('settingsDialog').close();
  render();
});

$('btnExport').addEventListener('click', exportBackup);
$('btnImport').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', importBackup);
$('btnCloseHistory').addEventListener('click', () => $('historyDialog').close());

$('btnCloseProductDialog').addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();

  const dialog = $('productDialog');
  if (dialog.open) dialog.close();
});

$('productDialog').addEventListener('cancel', (e) => {
  e.preventDefault();
  $('productDialog').close();
});


$('btnBarcodeAdd').addEventListener('click', openBarcodeDialog);
$('btnCloseBarcode').addEventListener('click', closeBarcodeDialog);
$('btnStartBarcodeCamera').addEventListener('click', startBarcodeCamera);
$('btnLookupBarcode').addEventListener('click', () => {
  const code = $('barcodeManualCode').value.replace(/\D/g, '');
  if (code) lookupBarcodeProduct(code);
});
$('barcodeManualCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const code = $('barcodeManualCode').value.replace(/\D/g, '');
    if (code) lookupBarcodeProduct(code);
  }
});
$('barcodeProductNameEdit').addEventListener('input', syncBarcodeChoiceLabels);
$('barcodeTypeNameEdit').addEventListener('input', syncBarcodeChoiceLabels);
$('btnRegisterBarcodeProduct').addEventListener('click', registerBarcodeProduct);
$('barcodeDialog').addEventListener('close', stopBarcodeCamera);

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
      const imageWrap = node.querySelector('.product-image-wrap');
      const imageEl = node.querySelector('.product-image');
      const imageUrl = safeRemoteImageUrl(product.imageUrl);

      if (imageUrl) {
        imageEl.src = imageUrl;
        imageEl.alt = `${product.name}の商品画像`;
        imageWrap.classList.remove('hidden');
        imageEl.addEventListener('error', () => {
          imageWrap.classList.add('hidden');
          imageEl.removeAttribute('src');
        }, { once: true });
      } else {
        imageWrap.classList.add('hidden');
        imageEl.removeAttribute('src');
      }

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

function openBarcodeDialog() {
  stopBarcodeCamera();
  barcodeLookupData = null;

  $('barcodeResult').classList.add('hidden');
  $('barcodeManualCode').value = '';
  $('barcodeCameraMessage').textContent = 'カメラを起動してね。';
  $('barcodeProductNameEdit').value = '';
  $('barcodeTypeNameEdit').value = '';
  $('barcodeAmount').value = '';
  $('barcodeUnit').value = '';

  if ($('productDialog').open) $('productDialog').close();
  $('barcodeDialog').showModal();
}

function closeBarcodeDialog() {
  stopBarcodeCamera();
  if ($('barcodeDialog').open) $('barcodeDialog').close();
}

async function createBarcodeDetector() {
  if (!('BarcodeDetector' in globalThis)) return null;

  try {
    const supported = await BarcodeDetector.getSupportedFormats();
    const wanted = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
    const formats = wanted.filter(f => supported.includes(f));
    return new BarcodeDetector(formats.length ? { formats } : undefined);
  } catch {
    try {
      return new BarcodeDetector({ formats: ['ean_13', 'ean_8'] });
    } catch {
      return null;
    }
  }
}

async function startBarcodeCamera() {
  stopBarcodeCamera();

  const msg = $('barcodeCameraMessage');
  msg.textContent = 'カメラを起動中…';

  if (!navigator.mediaDevices?.getUserMedia) {
    msg.textContent = 'このブラウザーではカメラを使えないよ。JANコードを直接入力してね。';
    return;
  }

  barcodeDetector = await createBarcodeDetector();
  if (!barcodeDetector) {
    msg.textContent = 'このブラウザーはバーコード自動検出に未対応。JANコードを直接入力してね。';
    return;
  }

  try {
    barcodeStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    const video = $('barcodeVideo');
    video.srcObject = barcodeStream;
    await video.play();

    barcodeScanning = true;
    msg.textContent = 'バーコードを枠の中央に合わせてね。';
    scanBarcodeFrame();
  } catch (err) {
    msg.textContent = 'カメラを起動できなかったよ。権限を確認するか、JANコードを直接入力してね。';
  }
}

async function scanBarcodeFrame() {
  if (!barcodeScanning || !barcodeDetector) return;

  const video = $('barcodeVideo');

  try {
    if (video.readyState >= 2) {
      const codes = await barcodeDetector.detect(video);

      if (codes?.length) {
        const raw = String(codes[0].rawValue || '').replace(/\D/g, '');

        if (raw) {
          barcodeScanning = false;
          $('barcodeManualCode').value = raw;
          $('barcodeCameraMessage').textContent = `読み取り成功: ${raw}`;
          stopBarcodeCamera(false);
          await lookupBarcodeProduct(raw);
          return;
        }
      }
    }
  } catch {}

  barcodeScanTimer = setTimeout(scanBarcodeFrame, 180);
}

function stopBarcodeCamera(clearVideo = true) {
  barcodeScanning = false;

  if (barcodeScanTimer) {
    clearTimeout(barcodeScanTimer);
    barcodeScanTimer = null;
  }

  if (barcodeStream) {
    barcodeStream.getTracks().forEach(track => track.stop());
    barcodeStream = null;
  }

  if (clearVideo) {
    const video = $('barcodeVideo');
    if (video) video.srcObject = null;
  }
}

function findProductByBarcode(code) {
  return products.find(product => String(product.barcode || '') === String(code || ''));
}

async function lookupBarcodeProduct(code) {
  code = String(code || '').replace(/\D/g, '');
  if (!code) return;

  stopBarcodeCamera(false);

  const result = $('barcodeResult');
  const status = $('barcodeLookupStatus');

  result.classList.remove('hidden');
  $('barcodeResultCode').textContent = code;
  status.textContent = '商品情報を検索中…';

  // 1) PriceLog内の登録済みJAN
  const existing = findProductByBarcode(code);
  if (existing) {
    status.textContent = `PriceLog内で「${existing.name}」が見つかったよ。`;
    $('barcodeProductNameEdit').value = existing.name;
    $('barcodeTypeNameEdit').value = '';
    $('barcodeAmount').value = existing.amount || 1;
    $('barcodeUnit').value = existing.unit || '個';
    syncBarcodeChoiceLabels();
    return;
  }

  barcodeLookupData = { code };

  // 2) Yahoo!ショッピング
  const yahooClientId = String(settings.yahooClientId || '').trim();
  const yahooWorkerUrl = YAHOO_WORKER_URL;

  if (yahooClientId) {
    status.textContent = 'Yahoo!ショッピングで検索中…';

    try {
      const yahooHit = await lookupYahooShopping(code, yahooClientId, yahooWorkerUrl);

      if (yahooHit) {
        applyYahooShoppingResult(code, yahooHit);
        status.textContent = 'Yahoo!ショッピングで商品が見つかったよ。登録する名前を選んでね。';
        return;
      }

      status.textContent = 'Yahoo!では未登録だったので、無料データベースも検索中…';
    } catch (err) {
      if (err?.code === 'YAHOO_RATE_LIMIT') {
        status.textContent =
          'Yahoo! APIの利用制限中。自動再試行でも通らなかったので、無料データベースも検索中…';
      } else {
        status.textContent =
          'Yahoo!検索に接続できなかったので、無料データベースも検索中…';
      }
    }
  } else {
    status.textContent = 'Yahoo! Client ID未設定。無料データベースを検索中…';
  }

  // 3) Open Facts
  let firstNetworkError = false;
  let product = null;

  try {
    product = await lookupOpenFacts(code);
  } catch {
    firstNetworkError = true;
  }

  if (product) {
    applyOpenFactsResult(code, product);
    status.textContent = 'Open Factsで商品情報が見つかったよ。登録する名前を選んでね。';
    return;
  }

  status.textContent = firstNetworkError
    ? 'Open Factsに接続できなかったので、別のデータベースを検索中…'
    : 'Open Factsでは未登録だったので、別のデータベースを検索中…';

  // 4) UPCitemdb
  let secondNetworkError = false;
  let item = null;

  try {
    item = await lookupUpcItemDb(code);
  } catch {
    secondNetworkError = true;
  }

  if (item) {
    applyUpcItemDbResult(code, item);
    status.textContent = 'UPCitemdbで商品情報が見つかったよ。登録する名前を選んでね。';
    return;
  }

  // 5) 手入力
  prepareBarcodeManualResult(code);

  if (firstNetworkError && secondNetworkError) {
    status.textContent =
      '無料データベースへ接続できなかったよ。商品名を手入力して登録してね。';
  } else {
    status.textContent =
      '商品情報が見つからなかったよ。商品名と種類を手入力して登録できるよ。';
  }
}

function normalizeWorkerUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeYahooError(message, code = '') {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}

async function runYahooRateLimited(task) {
  const run = yahooRequestChain.then(async () => {
    const elapsed = Date.now() - yahooLastRequestAt;
    const waitMs = Math.max(0, YAHOO_MIN_REQUEST_INTERVAL_MS - elapsed);

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    try {
      return await task();
    } finally {
      yahooLastRequestAt = Date.now();
    }
  });

  // 失敗しても次のリクエストキューは止めない。
  yahooRequestChain = run.catch(() => {});
  return run;
}

async function fetchYahooViaWorker(payload, clientId, workerUrl) {
  clientId = String(clientId || '').trim();
  workerUrl = normalizeWorkerUrl(workerUrl);

  if (!clientId) throw makeYahooError('Yahoo Client ID is missing');
  if (!workerUrl) throw makeYahooError('Yahoo Worker URL is missing');

  return runYahooRateLimited(async () => {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(`${workerUrl}/yahoo`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          cache: 'no-store',
          signal: controller.signal,
          body: JSON.stringify({
            clientId,
            ...payload
          })
        });

        let data = null;
        try {
          data = await response.json();
        } catch {}

        if (response.status === 429) {
          lastError = makeYahooError(
            'Yahoo API rate limit',
            'YAHOO_RATE_LIMIT'
          );

          // 1回だけ自動で待って再試行。
          if (attempt === 0) {
            await sleep(1800);
            continue;
          }

          throw lastError;
        }

        if (!response.ok) {
          const detail =
            data?.detail ||
            data?.error ||
            data?.message ||
            `HTTP ${response.status}`;

          throw makeYahooError(String(detail));
        }

        return data;
      } catch (err) {
        if (err?.name === 'AbortError') {
          lastError = makeYahooError('Yahoo request timeout', 'YAHOO_TIMEOUT');
        } else {
          lastError = err;
        }

        if (attempt === 0 && err?.code === 'YAHOO_RATE_LIMIT') {
          continue;
        }

        throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || makeYahooError('Yahoo request failed');
  });
}

async function lookupYahooShopping(
  code,
  clientId = settings.yahooClientId,
  workerUrl = YAHOO_WORKER_URL
) {
  const jan = String(code || '').replace(/\D/g, '');
  if (!jan) return null;

  // 同じJANを短時間に何度も検索した場合はAPIへ再送しない。
  const cached = yahooLookupCache.get(jan);
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) {
    return cached.hit || null;
  }

  // カメラ読み取りと検索ボタンが重なっても同じJANは1本だけ実行。
  if (yahooLookupInflight.has(jan)) {
    return yahooLookupInflight.get(jan);
  }

  const promise = (async () => {
    // 1回目: Yahoo!公式JAN検索
    let data = await fetchYahooViaWorker(
      { janCode: jan, results: 20 },
      clientId,
      workerUrl
    );

    let hits = Array.isArray(data?.hits) ? data.hits : [];

    // JAN検索で0件ならキーワード検索も試す。
    // fetchYahooViaWorker側で必ず1.2秒以上の間隔を空ける。
    if (!hits.length) {
      data = await fetchYahooViaWorker(
        { query: jan, results: 20 },
        clientId,
        workerUrl
      );
      hits = Array.isArray(data?.hits) ? data.hits : [];
    }

    if (!hits.length) {
      yahooLookupCache.set(jan, { time: Date.now(), hit: null });
      return null;
    }

    const exactJanHits = hits.filter(
      hit => String(hit?.janCode || '').replace(/\D/g, '') === jan
    );

    const candidates = exactJanHits.length ? exactJanHits : hits;
    candidates.sort((a, b) => yahooHitScore(b) - yahooHitScore(a));

    const hit = candidates[0] || null;
    yahooLookupCache.set(jan, { time: Date.now(), hit });
    return hit;
  })();

  yahooLookupInflight.set(jan, promise);

  try {
    return await promise;
  } finally {
    yahooLookupInflight.delete(jan);
  }
}

function yahooHitScore(hit) {
  let score = 0;
  if (hit?.name) score += 5;
  if (hit?.brand?.name) score += 2;
  if (hit?.genreCategory?.name) score += 2;
  if (Array.isArray(hit?.parentGenreCategories)) score += hit.parentGenreCategories.length;
  if (hit?.description) score += 1;
  return score;
}


function normalizeBarcodeNameForCompare(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[【】［］\[\]（）()「」『』"'`・:：\-‐‑‒–—―_,，.。\/\\]/g, '')
    .replace(/\s+/g, '');
}

function cleanBarcodeProductNameCandidate(value) {
  return cleanBarcodeText(
    String(value || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
  )
    .replace(/[【［].*?[】］]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chooseBarcodeProductName(candidates, typeName = '') {
  const unique = [];
  const seen = new Set();

  for (const candidate of candidates || []) {
    const cleaned = cleanBarcodeProductNameCandidate(candidate);
    if (!cleaned) continue;

    const key = normalizeBarcodeNameForCompare(cleaned);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    unique.push(cleaned);
  }

  if (!unique.length) return '';

  const typeKey = normalizeBarcodeNameForCompare(typeName);
  const primary = unique[0];
  const primaryKey = normalizeBarcodeNameForCompare(primary);

  // APIの正式商品名を最優先する。
  // ただし「牛乳」「ガム」など種類名だけだった場合は、
  // 同じAPIレスポンス内にある、より具体的な商品名へ切り替える。
  if (!typeKey || primaryKey !== typeKey) return primary;

  const richer = unique
    .slice(1)
    .filter(name => {
      const key = normalizeBarcodeNameForCompare(name);
      return key && key !== typeKey && name.length <= 120;
    })
    .sort((a, b) => b.length - a.length)[0];

  return richer || primary;
}

function applyResolvedBarcodeFields({ exactName, typeName, quantity }) {
  // 商品名・種類・内容量は完全に独立して反映する。
  // 種類候補が商品名を上書きすることはない。
  $('barcodeProductNameEdit').value = cleanBarcodeProductNameCandidate(exactName);
  $('barcodeTypeNameEdit').value = cleanBarcodeText(typeName);

  if (quantity && Number(quantity.amount) > 0 && quantity.unit) {
    $('barcodeAmount').value = String(quantity.amount);
    setBarcodeUnit(quantity.unit);
  } else {
    $('barcodeAmount').value = '';
    setBarcodeUnit('');
  }

  // 検索結果が変わるたび、必ず「正式商品名」を初期選択に戻す。
  $('barcodeChoiceProduct').checked = true;
  $('barcodeChoiceType').checked = false;
  syncBarcodeChoiceLabels();
}

function applyYahooShoppingResult(code, hit) {
  const exactName = cleanYahooProductName(hit?.name || '');
  const typeName = deriveYahooType(hit, exactName);
  const quantity = parseQuantityFromYahoo(hit);

  barcodeLookupData = {
    code,
    source: 'yahoo',
    yahooHit: hit,
    imageUrl: extractYahooImageUrl(hit),
    product: { product_type: isYahooLikelyFood(hit) ? 'food' : 'other' }
  };

  $('barcodeProductNameEdit').value = exactName;
  $('barcodeTypeNameEdit').value = typeName;

  if (quantity) {
    $('barcodeAmount').value = String(quantity.amount);
    setBarcodeUnit(quantity.unit);
  } else {
    $('barcodeAmount').value = '';
    setBarcodeUnit('');
  }

  $('barcodeChoiceProduct').checked = true;
  syncBarcodeChoiceLabels();
}

function safeRemoteImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function extractYahooImageUrl(hit) {
  const candidates = [
    hit?.image?.medium,
    hit?.image?.small,
    hit?.image?.large,
    hit?.imageUrl,
    hit?.image?.url
  ];

  for (const candidate of candidates) {
    const safe = safeRemoteImageUrl(candidate);
    if (safe) return safe;
  }

  const imageId = String(hit?.imageId || '').trim();
  if (imageId) {
    return `https://item-shopping.c.yimg.jp/i/g/${encodeURIComponent(imageId)}`;
  }

  return '';
}

function extractOpenFactsImageUrl(product) {
  const candidates = [
    product?.image_front_url,
    product?.image_url,
    product?.image_front_small_url,
    product?.image_small_url
  ];

  for (const candidate of candidates) {
    const safe = safeRemoteImageUrl(candidate);
    if (safe) return safe;
  }

  return '';
}

function extractUpcItemImageUrl(item) {
  const candidates = [
    ...(Array.isArray(item?.images) ? item.images : []),
    item?.image,
    item?.thumbnail
  ];

  for (const candidate of candidates) {
    const safe = safeRemoteImageUrl(candidate);
    if (safe) return safe;
  }

  return '';
}

function cleanYahooProductName(value) {
  return cleanBarcodeText(value)
    .replace(/[【［].*?[】］]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function yahooSearchText(hit, exactName = '') {
  return [
    exactName,
    hit?.name || '',
    hit?.description || '',
    hit?.headLine || '',
    hit?.brand?.name || '',
    hit?.genreCategory?.name || '',
    ...(Array.isArray(hit?.parentGenreCategories)
      ? hit.parentGenreCategories.map(x => x?.name || '')
      : [])
  ].join(' ').toLowerCase();
}

function deriveKnownBarcodeTypeFromText(value) {
  const haystack = String(value || '').normalize('NFKC').toLowerCase();

  const rules = [
    [['低脂肪乳'], '低脂肪乳'],
    [['加工乳'], '加工乳'],
    [['牛乳','ミルク'], '牛乳'],
    [['豆乳'], '豆乳'],
    [['ヨーグルト'], 'ヨーグルト'],
    [['インスタントコーヒー','ソリュブルコーヒー'], 'インスタントコーヒー'],
    [['コーヒー'], 'コーヒー'],
    [['紅茶'], '紅茶'],
    [['緑茶'], '緑茶'],
    [['麦茶'], '麦茶'],
    [['炭酸水'], '炭酸水'],
    [['ミネラルウォーター'], '水'],
    [['スポーツドリンク'], 'スポーツドリンク'],
    [['ジュース','果汁飲料'], 'ジュース'],
    [['コーラ'], 'コーラ'],
    [['食パン'], '食パン'],
    [['パン'], 'パン'],
    [['たまご','卵'], '卵'],
    [['納豆'], '納豆'],
    [['豆腐'], '豆腐'],
    [['味噌','みそ'], '味噌'],
    [['醤油','しょうゆ'], '醤油'],
    [['マヨネーズ'], 'マヨネーズ'],
    [['ケチャップ'], 'ケチャップ'],
    [['ウスターソース','中濃ソース','とんかつソース'], 'ソース'],
    [['みりん'], 'みりん'],
    [['料理酒'], '料理酒'],
    [['穀物酢','米酢','りんご酢','酢'], '酢'],
    [['オリーブオイル'], 'オリーブオイル'],
    [['サラダ油','キャノーラ油','食用油'], '食用油'],
    [['砂糖'], '砂糖'],
    [['食塩','塩'], '塩'],
    [['薄力粉'], '薄力粉'],
    [['強力粉'], '強力粉'],
    [['小麦粉'], '小麦粉'],
    [['うどん'], 'うどん'],
    [['ラーメン'], 'ラーメン'],
    [['パスタ','スパゲッティ'], 'パスタ'],
    [['チーズ'], 'チーズ'],
    [['バター'], 'バター'],
    [['粒ガム','板ガム','ボトルガム','チューインガム','chewing gum','ガム','クロレッツ','リカルデント','ブラックブラック','グリーンガム','フィッツ','fits','acuo','アクオ','ポスカ'], 'ガム'],
    [['チョコレート'], 'チョコレート'],
    [['アイスクリーム','アイス'], 'アイス'],
    [['米','こめ'], '米'],
    [['歯磨き粉','歯みがき粉','ハミガキ','歯磨き'], '歯磨き粉'],
    [['歯ブラシ'], '歯ブラシ'],
    [['アルミホイル','アルミ箔'], 'アルミホイル'],
    [['食品ラップ','キッチンラップ','ラップ'], 'ラップ'],
    [['キッチンペーパー'], 'キッチンペーパー'],
    [['トイレットペーパー'], 'トイレットペーパー'],
    [['ボックスティッシュ','箱ティッシュ','ティッシュ'], 'ティッシュ'],
    [['食器用洗剤','台所用洗剤'], '食器用洗剤'],
    [['洗濯洗剤','衣料用洗剤'], '洗濯洗剤'],
    [['柔軟剤'], '柔軟剤'],
    [['シャンプー'], 'シャンプー'],
    [['コンディショナー','リンス'], 'コンディショナー'],
    [['ボディソープ'], 'ボディソープ'],
    [['ハンドソープ'], 'ハンドソープ'],
    [['ゴミ袋','ごみ袋'], 'ゴミ袋'],
    [['乾電池','電池'], '電池']
  ];

  for (const [keywords, label] of rules) {
    if (keywords.some(keyword => haystack.includes(keyword.toLowerCase()))) return label;
  }

  return '';
}

function deriveYahooType(hit, exactName = '') {
  return deriveKnownBarcodeTypeFromText(yahooSearchText(hit, exactName));
}

function normalizeQuantityText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1')
    .replace(/[×xX＊*]/g, 'x')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function parseQuantityFromText(value) {
  const text = normalizeQuantityText(value);

  // 500ml x 2、200g×3袋 などは商品の総内容量として扱う。
  let m = text.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l|m)\s*x\s*(\d+)/i);
  if (m) {
    let amount = Number(m[1]) * Number(m[3]);
    let unit = m[2].toLowerCase();
    if (unit === 'kg') { amount *= 1000; unit = 'g'; }
    if (unit === 'l') { amount *= 1000; unit = 'ml'; }
    if (amount > 0) return { amount, unit };
  }

  m = text.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l|m)(?=\s|$|[^a-z])/i);
  if (m) {
    let amount = Number(m[1]);
    let unit = m[2].toLowerCase();
    if (unit === 'kg') { amount *= 1000; unit = 'g'; }
    if (unit === 'l') { amount *= 1000; unit = 'ml'; }
    if (amount > 0) return { amount, unit };
  }

  // ガム・錠菓・小分け商品など。Yahooの商品名に「14粒」「9枚」のように入るケースを拾う。
  m = text.match(/(\d+(?:\.\d+)?)\s*(粒|枚|個|本|袋|箱)(?:\s*(?:入|入り|セット))?/);
  if (m) return { amount: Number(m[1]), unit: m[2] };

  return null;
}

function parseQuantityFromYahoo(hit) {
  return parseQuantityFromText([
    hit?.name || '',
    hit?.headLine || '',
    hit?.description || ''
  ].join(' '));
}

function isYahooLikelyFood(hit) {
  const text = yahooSearchText(hit);
  const nonFood = [
    '日用品','ティッシュ','トイレットペーパー','洗剤','シャンプー',
    'ボディソープ','歯磨き','化粧品','コスメ','ペット','家電','ファッション'
  ];

  if (nonFood.some(word => text.includes(word))) return false;

  const food = [
    '食品','飲料','牛乳','乳製品','コーヒー','お茶','水','菓子','米',
    '調味料','麺','パン','卵','豆腐','納豆','ヨーグルト'
  ];

  return food.some(word => text.includes(word));
}


async function fetchJsonWithTimeout(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
      cache: 'no-store'
    });

    if (response.status === 404) return { found: false, data: null };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    return { found: true, data: await response.json() };
  } finally {
    clearTimeout(timer);
  }
}

async function lookupOpenFacts(code) {
  const fields = [
    'code','product_name','product_name_ja','generic_name','generic_name_ja',
    'brands','quantity','product_quantity','product_quantity_unit',
    'categories','categories_tags','image_front_url','image_url',
    'image_front_small_url','image_small_url'
  ].join(',');

  const domains = [
    'world.openfoodfacts.org',
    'world.openproductsfacts.org',
    'world.openbeautyfacts.org',
    'world.openpetfoodfacts.org'
  ];

  let gotResponse = false;
  let lastError = null;

  for (const domain of domains) {
    const url =
      `https://${domain}/api/v2/product/${encodeURIComponent(code)}.json` +
      `?cc=jp&lc=ja&fields=${encodeURIComponent(fields)}`;

    try {
      const res = await fetchJsonWithTimeout(url);

      if (!res.found) {
        gotResponse = true;
        continue;
      }

      gotResponse = true;
      const data = res.data;

      if (data?.status === 0 || !data?.product) continue;
      return data.product;
    } catch (err) {
      lastError = err;
    }
  }

  if (!gotResponse && lastError) throw lastError;
  return null;
}

function applyOpenFactsResult(code, product) {
  const exactName = cleanBarcodeText(
    product.product_name_ja || product.product_name || product.brands || ''
  );

  const typeName = deriveBarcodeType(product, exactName);
  const quantity = parseBarcodeQuantity(product);

  barcodeLookupData = {
    code,
    product,
    source: 'openfacts',
    imageUrl: extractOpenFactsImageUrl(product)
  };

  $('barcodeProductNameEdit').value = exactName;
  $('barcodeTypeNameEdit').value = typeName;

  if (quantity) {
    $('barcodeAmount').value = String(quantity.amount);
    setBarcodeUnit(quantity.unit);
  } else {
    $('barcodeAmount').value = '';
    setBarcodeUnit('');
  }

  $('barcodeChoiceProduct').checked = true;
  syncBarcodeChoiceLabels();
}

async function lookupUpcItemDb(code) {
  const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`;
  const res = await fetchJsonWithTimeout(url);

  if (!res.found) return null;

  const data = res.data;
  if (!data || !Array.isArray(data.items) || !data.items.length) return null;

  return data.items[0];
}

function applyUpcItemDbResult(code, item) {
  const exactName = cleanBarcodeText(
    item.title || [item.brand, item.model].filter(Boolean).join(' ') || ''
  );

  const typeName = deriveUpcItemType(item, exactName);
  const quantity = parseQuantityFromUpcItem(item);

  barcodeLookupData = {
    code,
    source: 'upcitemdb',
    upcItem: item,
    imageUrl: extractUpcItemImageUrl(item),
    product: { product_type: 'food' }
  };

  $('barcodeProductNameEdit').value = exactName;
  $('barcodeTypeNameEdit').value = typeName;

  if (quantity) {
    $('barcodeAmount').value = String(quantity.amount);
    setBarcodeUnit(quantity.unit);
  } else {
    $('barcodeAmount').value = '';
    setBarcodeUnit('');
  }

  $('barcodeChoiceProduct').checked = true;
  syncBarcodeChoiceLabels();
}

function deriveUpcItemType(item, exactName = '') {
  const haystack = [
    exactName,
    item?.category || '',
    item?.description || ''
  ].join(' ');

  const known = deriveKnownBarcodeTypeFromText(haystack);
  if (known) return known;

  const lower = haystack.toLowerCase();
  const englishRules = [
    [['low fat milk','low-fat milk'], '低脂肪乳'],
    [['soy milk','soya milk'], '豆乳'],
    [['milk'], '牛乳'],
    [['yogurt','yoghurt'], 'ヨーグルト'],
    [['instant coffee'], 'インスタントコーヒー'],
    [['coffee'], 'コーヒー'],
    [['black tea'], '紅茶'],
    [['green tea'], '緑茶'],
    [['sparkling water'], '炭酸水'],
    [['mineral water'], '水'],
    [['sliced bread','sandwich bread'], '食パン'],
    [['bread'], 'パン'],
    [['egg'], '卵'],
    [['natto'], '納豆'],
    [['tofu'], '豆腐'],
    [['miso'], '味噌'],
    [['soy sauce'], '醤油'],
    [['mayonnaise'], 'マヨネーズ'],
    [['ketchup'], 'ケチャップ'],
    [['udon'], 'うどん'],
    [['ramen'], 'ラーメン'],
    [['pasta'], 'パスタ'],
    [['cheese'], 'チーズ'],
    [['butter'], 'バター'],
    [['juice'], 'ジュース'],
    [['chocolate'], 'チョコレート'],
    [['ice cream'], 'アイス'],
    [['rice'], '米'],
    [['toothpaste'], '歯磨き粉'],
    [['aluminum foil','aluminium foil'], 'アルミホイル'],
    [['toilet paper'], 'トイレットペーパー'],
    [['tissue'], 'ティッシュ']
  ];

  for (const [keywords, label] of englishRules) {
    if (keywords.some(keyword => lower.includes(keyword))) return label;
  }
  return '';
}

function parseQuantityFromUpcItem(item) {
  return parseQuantityFromText([
    item?.title || '',
    item?.description || '',
    item?.size || '',
    item?.weight || ''
  ].join(' '));
}

function prepareBarcodeManualResult(code) {
  barcodeLookupData = { code };
  $('barcodeProductNameEdit').value = '';
  $('barcodeTypeNameEdit').value = '';
  $('barcodeAmount').value = '';
  setBarcodeUnit('');
  $('barcodeChoiceProduct').checked = true;
  syncBarcodeChoiceLabels();
}

function cleanBarcodeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveBarcodeType(product, exactName = '') {
  const generic = cleanBarcodeText(
    product?.generic_name_ja ||
    product?.generic_name ||
    ''
  );

  const text = [
    exactName,
    generic,
    product?.categories || '',
    ...(Array.isArray(product?.categories_tags) ? product.categories_tags : [])
  ].join(' ');

  return deriveKnownBarcodeTypeFromText(text);
}

function simplifyGenericType(value) {
  return deriveKnownBarcodeTypeFromText(cleanBarcodeText(value));
}

function parseBarcodeQuantity(product) {
  let amount = Number(product?.product_quantity);
  let unit = String(product?.product_quantity_unit || '').normalize('NFKC').toLowerCase();

  if (Number.isFinite(amount) && amount > 0 && unit) {
    if (unit === 'kg') { amount *= 1000; unit = 'g'; }
    if (unit === 'l') { amount *= 1000; unit = 'ml'; }
    if (['g','ml','m'].includes(unit)) return { amount, unit };
  }

  return parseQuantityFromText(product?.quantity || '');
}

function setBarcodeUnit(unit) {
  const select = $('barcodeUnit');
  const exists = Array.from(select.options).some(option => option.value === unit);

  if (!exists) {
    const option = document.createElement('option');
    option.value = unit;
    option.textContent = unit;
    select.appendChild(option);
  }

  select.value = unit;
}

function syncBarcodeChoiceLabels() {
  const exact = $('barcodeProductNameEdit').value.trim();
  const type = $('barcodeTypeNameEdit').value.trim();

  $('barcodeProductName').textContent = exact;
  $('barcodeTypeName').textContent = type;

  const typeChoice = $('barcodeChoiceType');
  const typeLabel = typeChoice.closest('.barcode-choice');

  typeChoice.disabled = !type;
  typeLabel.classList.toggle('disabled', !type);

  if (!type && typeChoice.checked) {
    $('barcodeChoiceProduct').checked = true;
  }
}

function barcodeReadingForName(name) {
  const known = findKnownReading(name);
  if (known) return known;

  const map = new Map([
    ['牛乳','ぎゅうにゅう'],
    ['低脂肪乳','ていしぼうにゅう'],
    ['豆乳','とうにゅう'],
    ['ヨーグルト','よーぐると'],
    ['コーヒー','こーひー'],
    ['紅茶','こうちゃ'],
    ['緑茶','りょくちゃ'],
    ['炭酸水','たんさんすい'],
    ['水','みず'],
    ['食パン','しょくぱん'],
    ['パン','ぱん'],
    ['卵','たまご'],
    ['納豆','なっとう'],
    ['豆腐','とうふ'],
    ['味噌','みそ'],
    ['醤油','しょうゆ'],
    ['マヨネーズ','まよねーず'],
    ['ケチャップ','けちゃっぷ'],
    ['うどん','うどん'],
    ['ラーメン','らーめん'],
    ['パスタ','ぱすた'],
    ['チーズ','ちーず'],
    ['バター','ばたー'],
    ['ジュース','じゅーす'],
    ['チョコレート','ちょこれーと'],
    ['アイス','あいす'],
    ['米','こめ']
  ]);

  if (map.has(name)) return map.get(name);

  return makeReadingCandidate(name);
}

function registerBarcodeProduct() {
  const code = String(barcodeLookupData?.code || $('barcodeManualCode').value || '')
    .replace(/\D/g, '');

  if (!code) {
    $('barcodeLookupStatus').textContent = 'バーコードを読み取るか入力してね。';
    return;
  }

  const existing = findProductByBarcode(code);
  if (existing) {
    $('barcodeLookupStatus').textContent = `「${existing.name}」として登録済みだよ。`;
    return;
  }

  const choice = document.querySelector('input[name="barcodeNameChoice"]:checked')?.value || 'product';
  const exactName = $('barcodeProductNameEdit').value.trim();
  const typeName = $('barcodeTypeNameEdit').value.trim();
  const name = choice === 'type' ? typeName : exactName;

  const amount = Number($('barcodeAmount').value);
  const unit = $('barcodeUnit').value;

  if (!name) {
    $('barcodeLookupStatus').textContent = '登録する商品名を入力してね。';
    return;
  }

  if (!(amount > 0) || !unit) {
    $('barcodeLookupStatus').textContent = '内容量と単位を確認してね。';
    return;
  }

  const reading = barcodeReadingForName(name);
  const productType = barcodeLookupData?.product?.product_type || 'food';
  const defaultTax = productType === 'food'
    ? Number(settings.reducedTax)
    : Number(settings.standardTax);

  const product = {
    id: makeId('p'),
    barcode: code,
    imageUrl: safeRemoteImageUrl(barcodeLookupData?.imageUrl),
    name,
    reading,
    amount,
    unit,
    defaultTax,
    history: [],
    stores: []
  };

  products.push(product);
  persistNow();
  openProductId = product.id;
  closeBarcodeDialog();
  render();

  requestAnimationFrame(() => {
    const card = listEl.querySelector(`[data-id="${cssEscape(product.id)}"]`);
    if (card) card.scrollIntoView({behavior:'smooth', block:'center'});
  });
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

  productImageDeletePending = false;
  const imageSetting = $('productImageSetting');
  const imagePreview = $('productImageSettingPreview');
  const deleteImageButton = $('btnDeleteProductImage');
  const deleteImageNote = $('productImageDeleteNote');
  const currentImageUrl = safeRemoteImageUrl(p?.imageUrl);

  imageSetting.classList.toggle('hidden', !p || !currentImageUrl);
  deleteImageButton.classList.remove('hidden');
  deleteImageNote.classList.add('hidden');

  if (p && currentImageUrl) {
    imagePreview.src = currentImageUrl;
    imagePreview.classList.remove('hidden');
    imagePreview.onerror = () => {
      imagePreview.classList.add('hidden');
    };
  } else {
    imagePreview.removeAttribute('src');
    imagePreview.classList.add('hidden');
  }

  const dialog = $('productDialog');
  dialog.showModal();

  requestAnimationFrame(() => {
    // スマホでは商品追加画面を必ず先頭から表示する。
    dialog.scrollTop = 0;
    $('productForm').scrollTop = 0;

    const nameInput = $('productName');

    try {
      // キーボードを開いてもブラウザ側の自動スクロールで
      // ダイアログ中央へ移動しないようにする。
      nameInput.focus({ preventScroll: true });
    } catch {
      nameInput.focus();
    }

    // キーボード表示直後にも先頭位置へ戻す。
    requestAnimationFrame(() => {
      dialog.scrollTop = 0;
      $('productForm').scrollTop = 0;
    });
  });
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
      if (productImageDeletePending) p.imageUrl = '';
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

function toggleYahooClientIdVisibility() {
  const input = $('yahooClientId');
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  $('btnToggleYahooClientId').textContent = visible ? '表示' : '隠す';
}

async function testYahooShoppingApi() {
  const clientId = $('yahooClientId').value.trim();
  const workerUrl = YAHOO_WORKER_URL;
  const status = $('yahooApiStatus');

  if (!clientId) {
    status.textContent = 'Client IDを入力してね。';
    return;
  }

  const btn = $('btnTestYahooApi');
  btn.disabled = true;
  status.textContent = 'PriceLog専用サーバー経由でYahoo!へ接続中…';

  try {
    const data = await fetchYahooViaWorker(
      { query: '牛乳', results: 1 },
      clientId,
      workerUrl
    );

    if (!data || !Array.isArray(data.hits)) {
      throw new Error('Unexpected Yahoo response');
    }

    status.textContent = '接続できたよ。設定を保存すればバーコード検索で使える。';
  } catch (err) {
    status.textContent =
      `接続できなかったよ。Client IDまたは中継サーバーの状態を確認してね。${err?.message ? ` (${err.message})` : ''}`;
  } finally {
    btn.disabled = false;
  }
}


function openSettings() {
  $('standardTax').value = settings.standardTax;
  $('reducedTax').value = settings.reducedTax;
  $('defaultPriceType').value = settings.defaultPriceType;
  $('yahooClientId').value = settings.yahooClientId || '';
  $('yahooClientId').type = 'password';
  $('btnToggleYahooClientId').textContent = '表示';
  $('yahooApiStatus').textContent = '';
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
