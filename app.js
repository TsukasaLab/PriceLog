(() => {
'use strict';

const STORAGE_KEY = 'pricelog_v02_data';
const SETTINGS_KEY = 'pricelog_v02_settings';
const INITIALIZED_KEY = 'pricelog_initialized_v1';
const TEMPLATE_KEY = 'pricelog_custom_template_v1';
const YAHOO_PRODUCT_CACHE_KEY = 'pricelog_yahoo_product_cache_v1';
const SHOPPING_MEMO_KEY = 'pricelog_shopping_memo_v1';
const V051_SETTINGS_MIGRATION_KEY = 'pricelog_v051_settings_migrated';
const APP_VERSION = '0.59';
const DATA_SCHEMA_VERSION = 3;

const YAHOO_WORKER_URL = 'https://pricelog-yahoo.pricelog-api.workers.dev';

const defaultSettings = {
  standardTax: 10,
  reducedTax: 8,
  defaultPriceType: 'ex',
  yahooClientId: '',
  barcodeNameDefault: 'product'
};

function normalizeSettingsData(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};

  return {
    ...defaultSettings,
    ...value,
    standardTax: Number.isFinite(Number(value.standardTax))
      ? Number(value.standardTax)
      : defaultSettings.standardTax,
    reducedTax: Number.isFinite(Number(value.reducedTax))
      ? Number(value.reducedTax)
      : defaultSettings.reducedTax,
    defaultPriceType: value.defaultPriceType === 'inc' ? 'inc' : 'ex',
    yahooClientId: String(value.yahooClientId || ''),
    barcodeNameDefault: value.barcodeNameDefault === 'type' ? 'type' : 'product'
  };
}

let settings = normalizeSettingsData(loadJson(SETTINGS_KEY, defaultSettings));
if (localStorage.getItem(V051_SETTINGS_MIGRATION_KEY) !== '1') {
  settings.defaultPriceType = 'ex';
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  localStorage.setItem(V051_SETTINGS_MIGRATION_KEY, '1');
}
let products = normalizeProductsData(loadJson(STORAGE_KEY, []));
let openProductId = null;
let editProductId = null;
let saveTimer = null;
let productEditDraft = null;
let productEditDirty = false;
let toastTimer = null;
let bulkMode = false;
let bulkSelected = new Set();
let storePurchaseMode = false;
let openStoreName = null;
let shoppingMemoFilters = new Map();
let shoppingMemoChecked = new Set((loadJson(SHOPPING_MEMO_KEY, []) || []).map(String));
let shoppingMemoEditStore = null;
let shoppingMemoEditDraft = null;
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
let barcodeReturnToProductDialog = false;
let productDialogBarcodeDraft = null;
let productDialogStores = [];
let shareSelectedProducts = new Set();
let pendingMergePlan = null;
let barcodeReadingManuallyEdited = false;
let yahooRequestChain = Promise.resolve();
let yahooLastRequestAt = 0;
const YAHOO_MIN_REQUEST_INTERVAL_MS = 1200;
const yahooLookupInflight = new Map();
const yahooLookupCache = new Map();
const YAHOO_PRODUCT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const YAHOO_PRODUCT_CACHE_MAX = 50;

function loadPersistentYahooProductCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(YAHOO_PRODUCT_CACHE_KEY) || '{}');
    const now = Date.now();
    const entries = Object.entries(raw || {})
      .filter(([, item]) =>
        item &&
        item.hit &&
        Number(item.time) > 0 &&
        now - Number(item.time) < YAHOO_PRODUCT_CACHE_TTL_MS
      )
      .sort((a, b) => Number(b[1].time) - Number(a[1].time))
      .slice(0, YAHOO_PRODUCT_CACHE_MAX);

    return new Map(entries);
  } catch {
    return new Map();
  }
}

let persistentYahooProductCache = loadPersistentYahooProductCache();

function savePersistentYahooProduct(jan, hit) {
  if (!jan || !hit) return;

  persistentYahooProductCache.set(jan, {
    time: Date.now(),
    hit
  });

  const entries = Array.from(persistentYahooProductCache.entries())
    .sort((a, b) => Number(b[1]?.time || 0) - Number(a[1]?.time || 0))
    .slice(0, YAHOO_PRODUCT_CACHE_MAX);

  persistentYahooProductCache = new Map(entries);

  try {
    localStorage.setItem(
      YAHOO_PRODUCT_CACHE_KEY,
      JSON.stringify(Object.fromEntries(entries))
    );
  } catch {}
}

function getPersistentYahooProduct(jan) {
  const item = persistentYahooProductCache.get(jan);
  if (!item?.hit) return null;

  if (Date.now() - Number(item.time || 0) >= YAHOO_PRODUCT_CACHE_TTL_MS) {
    persistentYahooProductCache.delete(jan);
    return null;
  }

  return item.hit;
}


let recommendedReadingMap = new Map();

const $ = (id) => document.getElementById(id);
const listEl = $('productList');
const productTemplate = $('productTemplate');
const storeTemplate = $('storeTemplate');

initializeWithoutSamples();
loadRecommendedReadingMap();
render();

$('searchInput').addEventListener('input', render);
$('btnAddProduct').addEventListener('click', () => openProductDialog());
$('btnBulkStore').addEventListener('click', () => setBulkMode(!bulkMode));
$('btnBulkCancel').addEventListener('click', () => setBulkMode(false));
$('btnBulkSelectAll').addEventListener('click', toggleBulkSelectAll);
$('btnBulkAdd').addEventListener('click', bulkAddStore);
$('btnEditTemplate').addEventListener('click', exportCurrentTemplateFile);
$('btnLoadTemplate').addEventListener('click', () => $('templateImportFile').click());
$('templateImportFile').addEventListener('change', importTemplateFile);
$('btnLoadRecommendedTemplate').addEventListener('click', loadRecommendedProductsDirect);
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
$('storePurchaseSearch').addEventListener('input', renderStorePurchaseView);
$('btnDeleteAllProducts').addEventListener('click', deleteAllProducts);
$('btnSettings').addEventListener('click', openSettings);
$('btnToggleYahooClientId').addEventListener('click', toggleYahooClientIdVisibility);
$('btnTestYahooApi').addEventListener('click', testYahooShoppingApi);

$('productForm').addEventListener('submit', (e) => {
  e.preventDefault();
  saveProductFromDialog();
});

$('settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const st = clampNumber($('standardTax').value, 0, 100, 10);
  const rt = clampNumber($('reducedTax').value, 0, 100, 8);

  settings = normalizeSettingsData({
    standardTax: st,
    reducedTax: rt,
    defaultPriceType: $('defaultPriceType').value === 'ex' ? 'ex' : 'inc',
    yahooClientId: $('yahooClientId').value.trim(),
    barcodeNameDefault: $('barcodeNameDefault').value === 'type' ? 'type' : 'product'
  });

  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  $('settingsDialog').close();
  render();
});

$('btnExport').addEventListener('click', exportBackup);
$('btnImport').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', importBackup);
$('btnShareData').addEventListener('click', openShareDialog);
$('btnMergeSharedData').addEventListener('click', () => $('sharedImportFile').click());
$('sharedImportFile').addEventListener('change', importSharedData);
$('btnCloseShare').addEventListener('click', closeShareDialog);
$('shareSearch').addEventListener('input', renderShareProductList);
$('btnShareAll').addEventListener('click', () => setVisibleShareSelection(true));
$('btnShareNone').addEventListener('click', () => setVisibleShareSelection(false));
$('btnCreateShareFile').addEventListener('click', shareSelectedData);
$('btnCloseMerge').addEventListener('click', closeMergeDialog);
$('btnConflictsKeepCurrent').addEventListener('click', () => setAllConflictChoices('current'));
$('btnConflictsUseShared').addEventListener('click', () => setAllConflictChoices('shared'));
$('btnApplyMerge').addEventListener('click', applyPendingMerge);
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
$('btnBarcodeRescan').addEventListener('click', resetBarcodeLookupView);
$('btnStartBarcodeCamera').addEventListener('click', startBarcodeCamera);
$('btnLookupBarcode').addEventListener('click', () => {
  const code = normalizeBarcodeCode($('barcodeManualCode').value);
  if (code) lookupBarcodeProduct(code);
});
$('barcodeManualCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const code = normalizeBarcodeCode($('barcodeManualCode').value);
    if (code) lookupBarcodeProduct(code);
  }
});
$('barcodeProductNameEdit').addEventListener('input', () => {
  syncBarcodeChoiceLabels();
  if ($('barcodeChoiceProduct').checked) {
    syncBarcodeQuantityForChoice();
    if (!barcodeReadingManuallyEdited) updateBarcodeReadingFromChoice();
  }
});
$('barcodeTypeNameEdit').addEventListener('input', () => {
  syncBarcodeChoiceLabels();
  if ($('barcodeChoiceProduct').checked) {
    syncBarcodeQuantityForChoice();
  }
  if ($('barcodeChoiceType').checked && !barcodeReadingManuallyEdited) {
    updateBarcodeReadingFromChoice();
  }
});
$('barcodeChoiceProduct').addEventListener('change', () => {
  if (!$('barcodeChoiceProduct').checked) return;
  barcodeReadingManuallyEdited = false;
  syncBarcodeChoiceLabels();
  syncBarcodeQuantityForChoice();
  updateBarcodeReadingFromChoice();
});
$('barcodeChoiceType').addEventListener('change', () => {
  if (!$('barcodeChoiceType').checked) return;
  barcodeReadingManuallyEdited = false;
  syncBarcodeChoiceLabels();
  syncBarcodeQuantityForChoice();
  updateBarcodeReadingFromChoice();
});
$('barcodeAmount').addEventListener('input', () => {
  if (!barcodeLookupData) return;

  const amount = Number($('barcodeAmount').value);

  // 商品名で登録する場合の「1」は初期値。ユーザーが自由に編集できる。
  if ($('barcodeChoiceProduct').checked) {
    barcodeLookupData.productAmount = amount > 0 ? amount : null;
    return;
  }

  const unit = $('barcodeUnit').value;
  barcodeLookupData.typeQuantity = amount > 0 && unit ? { amount, unit } : null;
});
$('barcodeUnit').addEventListener('change', () => {
  if (!barcodeLookupData) return;

  if ($('barcodeChoiceProduct').checked) {
    barcodeLookupData.productUnit = $('barcodeUnit').value;
    return;
  }

  const amount = Number($('barcodeAmount').value);
  const unit = $('barcodeUnit').value;
  barcodeLookupData.typeQuantity = amount > 0 && unit ? { amount, unit } : null;
});
$('barcodeReading').addEventListener('input', () => {
  barcodeReadingManuallyEdited = true;
});
$('btnRegisterBarcodeProduct').addEventListener('click', registerBarcodeProduct);
$('barcodeDialog').addEventListener('close', stopBarcodeCamera);
$('barcodeDialog').addEventListener('cancel', (e) => { e.preventDefault(); closeBarcodeDialog(); });

$('productKindProduct').addEventListener('change', () => setProductKindChoice('product'));
$('productKindType').addEventListener('change', () => setProductKindChoice('type'));
$('btnAddProductStore').addEventListener('click', () => { productDialogStores.push(makeBlankDialogStore()); renderProductDialogStores(); });
$('productAmount').addEventListener('change', renderProductDialogStores);
$('productUnit').addEventListener('change', renderProductDialogStores);

function bindProductNameReadingEvents(input) {
  input.addEventListener('compositionstart', () => {
    if (input.disabled) return;
    productNameIsComposing = true;
    readingWasManuallyEdited = false;
    compositionReadingCandidate = '';
  });

  input.addEventListener('input', (e) => {
    if (input.disabled) return;
    readingWasManuallyEdited = false;
    const candidate = makeReadingCandidate(input.value);
    if (productNameIsComposing || e.isComposing) {
      if (candidate) {
        compositionReadingCandidate = candidate;
        $('productReading').value = candidate;
      }
      return;
    }
    autoFillProductReading();
  });

  input.addEventListener('compositionend', () => {
    if (input.disabled) return;
    productNameIsComposing = false;
    readingWasManuallyEdited = false;
    const finalCandidate = makeReadingCandidate(input.value);
    if (finalCandidate) $('productReading').value = finalCandidate;
    else if (compositionReadingCandidate) $('productReading').value = compositionReadingCandidate;
    compositionReadingCandidate = '';
  });

  input.addEventListener('blur', () => {
    if (input.disabled) return;
    if (!readingWasManuallyEdited && !productNameIsComposing) {
      const candidate = makeReadingCandidate(input.value);
      if (candidate) $('productReading').value = candidate;
    }
  });
}

bindProductNameReadingEvents($('productName'));
bindProductNameReadingEvents($('productTypeName'));

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

window.addEventListener('beforeunload', (e) => {
  if (!productEditDirty) return;
  e.preventDefault();
  e.returnValue = '';
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js?v=0.59').catch(() => {}));
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

function initializeWithoutSamples() {
  // 新規利用時は商品0件で開始する。サンプル商品は自動登録しない。
  if (localStorage.getItem(INITIALIZED_KEY) !== '1') {
    localStorage.setItem(INITIALIZED_KEY, '1');
  }
}

function normalizeIsoDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function normalizeNameCandidates(raw, kind, fallbackName = '') {
  const value = raw && typeof raw === 'object' ? raw : {};
  const selected = String(fallbackName || '').trim();
  return {
    product: String(value.product || (kind === 'product' ? selected : '')).trim(),
    type: String(value.type || (kind === 'type' ? selected : '')).trim()
  };
}

function normalizeProductsData(list) {
  if (!Array.isArray(list)) return [];

  return list.map(raw => {
    const product = raw && typeof raw === 'object' ? raw : {};
    const kind = product.kind === 'type' ? 'type' : 'product';
    const amount = kind === 'type'
      ? (Number(product.amount) > 0 ? Number(product.amount) : '')
      : (Number(product.amount) > 0 ? Number(product.amount) : 1);
    const unit = String(product.unit || '').trim();
    const stores = Array.isArray(product.stores) ? product.stores : [];

    return {
      ...product,
      id: String(product.id || makeId('p')),
      kind,
      name: String(product.name || '').trim(),
      nameCandidates: normalizeNameCandidates(product.nameCandidates, kind, product.name),
      reading: normalizeReadingInput(product.reading || ''),
      amount,
      unit,
      defaultTax: Number.isFinite(Number(product.defaultTax)) ? Number(product.defaultTax) : settings.reducedTax,
      updatedAt: normalizeIsoDate(product.updatedAt),
      history: Array.isArray(product.history) ? product.history.slice(0, 20) : [],
      stores: stores.map(rawRow => {
        const row = rawRow && typeof rawRow === 'object' ? rawRow : {};
        return {
          ...row,
          id: String(row.id || makeId('s')),
          store: String(row.store || ''),
          price: row.price ?? '',
          priceType: row.priceType === 'inc' ? 'inc' : 'ex',
          tax: Number.isFinite(Number(row.tax)) ? Number(row.tax) : Number(product.defaultTax ?? settings.reducedTax),
          couponType: ['percent','yen'].includes(row.couponType) ? row.couponType : 'none',
          couponValue: row.couponValue ?? '',
          amount: kind === 'type' && row.amount === ''
            ? ''
            : (Number(row.amount) > 0 ? Number(row.amount) : amount),
          unit: String(row.unit || unit).trim() || (kind === 'type' ? '個' : unit),
          updatedAt: normalizeIsoDate(row.updatedAt)
        };
      })
    };
  }).filter(product => product.name);
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

function beginProductEdit(productId) {
  const source = products.find(product => product.id === productId);
  if (!source) {
    productEditDraft = null;
    productEditDirty = false;
    return;
  }
  productEditDraft = structuredCloneSafe(source);
  productEditDirty = false;
}

function confirmDiscardProductEdit() {
  if (!productEditDraft || !productEditDirty) return true;
  return window.confirm('保存していない変更があります。変更を破棄して移動しますか？');
}

function closeProductEdit({discard = false} = {}) {
  if (!discard && !confirmDiscardProductEdit()) return false;
  openProductId = null;
  productEditDraft = null;
  productEditDirty = false;
  render();
  return true;
}

function markProductEditDirty() {
  productEditDirty = true;
}

function showSaveToast(message = '保存しました') {
  const toast = $('saveToast');
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.remove('hidden');
  requestAnimationFrame(() => toast.classList.add('show'));
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 180);
  }, 2000);
}

function saveProductEdit(productId) {
  if (!productEditDraft || productEditDraft.id !== productId) return;
  const index = products.findIndex(product => product.id === productId);
  if (index < 0) return;

  const original = products[index];
  const draft = structuredCloneSafe(productEditDraft);
  const history = Array.isArray(original.history) ? structuredCloneSafe(original.history) : [];
  const originalRows = new Map((original.stores || []).map(row => [row.id, row]));

  const savedAt = new Date().toISOString();
  for (const row of draft.stores || []) {
    const beforeRow = originalRows.get(row.id);
    if (!beforeRow) {
      row.updatedAt = savedAt;
      continue;
    }
    const before = historyPriceValue(beforeRow.price);
    const after = historyPriceValue(row.price);
    if (before !== null && after !== null && !sameHistoryPrice(before, after)) {
      history.unshift({
        id: makeId('h'),
        updatedAt: savedAt,
        store: (row.store || beforeRow.store || '店舗未入力').trim() || '店舗未入力',
        beforePrice: Number(before),
        afterPrice: Number(after)
      });
    }
    if (!sameStoreData(beforeRow, row)) row.updatedAt = savedAt;
  }

  draft.history = history.slice(0, 20);
  if (!sameProductMeta(original, draft) || productEditDirty) draft.updatedAt = savedAt;
  products[index] = draft;
  persistNow();
  openProductId = null;
  productEditDraft = null;
  productEditDirty = false;
  render();
  showSaveToast('保存しました');
}

function deleteProductFromDetail(productId) {
  const product = products.find(item => item.id === productId);
  if (!product) return;
  if (!window.confirm(`「${product.name}」を削除しますか？`)) return;

  products = products.filter(item => item.id !== productId);
  openProductId = null;
  productEditDraft = null;
  productEditDirty = false;
  persistNow();
  render();
  showSaveToast('商品を削除しました');
}

function render() {
  const q = $('searchInput').value.trim().toLowerCase();

  document.body.classList.toggle('focus-mode', !!openProductId && !storePurchaseMode);

  $('storePurchaseView').classList.toggle('hidden', !storePurchaseMode);
  $('productList').classList.toggle('hidden', storePurchaseMode);
  $('searchInput').closest('.searchbar').classList.toggle('hidden', storePurchaseMode);
  $('btnBulkStore').classList.toggle('hidden', storePurchaseMode);
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

    const isOpen = !bulkMode && openProductId === product.id;
    if (isOpen && (!productEditDraft || productEditDraft.id !== product.id)) beginProductEdit(product.id);
    const displayProduct = isOpen && productEditDraft ? productEditDraft : product;
    const bests = getBests(displayProduct);

    node.querySelector('.product-name').textContent = displayProduct.name;
    node.querySelector('.product-size').textContent = displayProduct.kind === 'type'
      ? '種類比較'
      : '';

    const bestWrap = node.querySelector('.best-wrap');
    const bestPrice = node.querySelector('.best-price');
    if (bests.before) {
      const baseCalc = bests.before.calc;
      bestPrice.textContent = `${fmtPrice(baseCalc.grossBefore)}円`;
      bestWrap.classList.remove('no-best');
      node.classList.add('has-best');
    } else {
      bestPrice.textContent = '価格未登録';
      bestWrap.classList.add('no-best');
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

      if (openProductId === product.id) {
        closeProductEdit();
        return;
      }

      if (!confirmDiscardProductEdit()) return;
      openProductId = product.id;
      beginProductEdit(product.id);
      render();
    });

    const detail = node.querySelector('.product-detail');
    detail.classList.toggle('hidden', !isOpen);
    node.classList.toggle('open', isOpen);

    if (isOpen && productEditDraft) {
      const draft = productEditDraft;
      node.querySelector('.btn-edit-product').addEventListener('click', () => openProductDialog(product.id));
      node.querySelector('.btn-history').addEventListener('click', () => openHistoryDialog(product.id));
      node.querySelector('.btn-add-store').addEventListener('click', () => {
        draft.stores.push({
          id: makeId('s'),
          store: '',
          price: '',
          priceType: settings.defaultPriceType,
          tax: draft.defaultTax,
          couponType: 'none',
          couponValue: '',
          amount: draft.kind === 'type'
            ? (Number(draft.amount) > 0 ? Number(draft.amount) : '')
            : (Number(draft.amount) > 0 ? Number(draft.amount) : 1),
          unit: draft.unit || '個',
          updatedAt: ''
        });
        markProductEditDirty();
        render();
        requestAnimationFrame(() => {
          const card = listEl.querySelector(`[data-id="${cssEscape(product.id)}"]`);
          const rows = card?.querySelectorAll('.store-row');
          rows?.[rows.length - 1]?.querySelector('.st-store')?.focus();
        });
      });

      const storeList = node.querySelector('.store-list');
      draft.stores.forEach(row => {
        const flags = {
          before: bests.before?.row.id === row.id,
          after: bests.after?.row.id === row.id
        };
        storeList.appendChild(renderStoreRow(draft, row, flags));
      });

      if (!draft.stores.length) {
        const hint = document.createElement('div');
        hint.className = 'empty';
        hint.textContent = '「＋店舗」で価格を追加';
        storeList.appendChild(hint);
      }

      node.querySelector('.btn-save-product-edit').addEventListener('click', () => saveProductEdit(product.id));
      node.querySelector('.btn-cancel-product-edit').addEventListener('click', () => closeProductEdit({discard:true}));
      node.querySelector('.btn-delete-product-detail').addEventListener('click', () => deleteProductFromDetail(product.id));
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
  const amount = el.querySelector('.st-amount');
  const unitSelect = el.querySelector('.st-unit-select');
  const quantityFields = el.querySelector('.st-quantity-fields');
  const priceResultOut = el.querySelector('.st-price-result');
  const unitOut = el.querySelector('.st-unit');

  store.value = row.store ?? '';
  price.value = row.price ?? '';
  priceType.value = row.priceType === 'inc' ? 'inc' : 'ex';
  tax.innerHTML = taxOptions(row.tax ?? product.defaultTax);
  couponType.value = ['percent','yen'].includes(row.couponType) ? row.couponType : 'none';
  couponValue.value = row.couponValue ?? '';

  const isType = product.kind === 'type';
  quantityFields.classList.toggle('hidden', !isType);
  if (isType) {
    amount.value = Number(row.amount) > 0 ? row.amount : (product.amount || 1);
    setSelectValueWithOption(unitSelect, row.unit || product.unit || '個');
  }

  function updateOutputs() {
    couponValue.disabled = couponType.value === 'none';
    couponValue.placeholder = couponType.value === 'percent' ? '%' : couponType.value === 'yen' ? '円' : '-';
    const calc = calcRow(product, row);
    if (calc) {
      priceResultOut.textContent = `${fmtPrice(calc.grossBefore)}[${fmtPrice(calc.afterTotal)}](${fmtPriceDelta(calc.afterTotal - calc.grossBefore)})`;
      unitOut.textContent = `${fmtUnit(calc.beforeUnit)}[${fmtUnit(calc.afterUnit)}](${fmtUnitDelta(calc.afterUnit - calc.beforeUnit)})`;
    } else {
      priceResultOut.textContent = '-';
      unitOut.textContent = '-';
    }
  }

  function sync() {
    row.store = store.value.trim();
    row.price = numberOrBlank(price.value);
    row.priceType = priceType.value;
    row.tax = Number(tax.value);
    row.couponType = couponType.value;
    row.couponValue = numberOrBlank(couponValue.value);
    if (isType) {
      row.amount = numberOrBlank(amount.value);
      row.unit = unitSelect.value || product.unit || '個';
    }
    markProductEditDirty();
    updateOutputs();
    refreshBestOnly(product.id);
  }

  [store, price, priceType, tax, couponType, couponValue, amount, unitSelect].forEach(ctrl => {
    if (!ctrl) return;
    ctrl.addEventListener('input', sync);
    ctrl.addEventListener('change', sync);
  });

  el.querySelector('.st-delete').addEventListener('click', () => {
    product.stores = product.stores.filter(item => item.id !== row.id);
    productEditDraft = product;
    markProductEditDirty();
    render();
  });

  updateOutputs();
  return el;
}

function setSelectValueWithOption(select, value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    if (Array.from(select.options).some(option => option.value === '')) select.value = '';
    return;
  }
  if (!Array.from(select.options).some(option => option.value === normalized)) {
    const option = document.createElement('option');
    option.value = normalized;
    option.textContent = normalized;
    select.appendChild(option);
  }
  select.value = normalized;
}

function refreshBestOnly(productId) {
  const product = productEditDraft?.id === productId
    ? productEditDraft
    : products.find(p => p.id === productId);
  const card = listEl.querySelector(`[data-id="${cssEscape(productId)}"]`);
  if (!product || !card) return;

  const bests = getBests(product);
  const hasBest = !!bests.before;
  const bestWrap = card.querySelector('.best-wrap');
  const bestPrice = card.querySelector('.best-price');

  if (hasBest) {
    bestPrice.textContent = `${fmtPrice(bests.before.calc.grossBefore)}円`;
    bestWrap?.classList.remove('no-best');
  } else {
    bestPrice.textContent = '価格未登録';
    bestWrap?.classList.add('no-best');
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
  const amount = Number(product.kind === 'type' ? row.amount : product.amount);
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
      before = { row, store: row.store, calc, unit: product.kind === 'type' ? (row.unit || product.unit) : product.unit };
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
      after = { row, store: row.store, calc, unit: product.kind === 'type' ? (row.unit || product.unit) : product.unit };
    }
  });

  return { before, after };
}

function createPriceBadge(kind, compact = false) {
  const badge = document.createElement('span');
  badge.className = `price-badge ${kind === 'special' ? 'badge-special' : 'badge-low'}${compact ? ' mini-badge' : ''}`;
  const icon = document.createElement('span');
  icon.className = 'badge-icon';
  icon.textContent = kind === 'special' ? '◆' : '♛';
  badge.append(icon, document.createTextNode(kind === 'special' ? '特安' : '最安'));
  return badge;
}

function renderBestStoreSummary(container, bests) {
  container.innerHTML = '';
  if (!bests.before) {
    container.textContent = '価格未登録';
    return;
  }

  const add = (kind, store) => {
    const wrap = document.createElement('span');
    wrap.className = 'best-store-item';
    wrap.append(createPriceBadge(kind, true), document.createTextNode(store || '店舗未入力'));
    container.appendChild(wrap);
  };

  add('low', bests.before.store);
  if (bests.after) add('special', bests.after.store);
}

function applyBestFlags(rowEl, markEl, flags) {
  if (!markEl) return;
  markEl.innerHTML = '';
  if (flags.before) markEl.appendChild(createPriceBadge('low', true));
  else if (flags.after) markEl.appendChild(createPriceBadge('special', true));
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
  if (!!enabled && !confirmDiscardProductEdit()) return;
  if (!!enabled && openProductId) {
    openProductId = null;
    productEditDraft = null;
    productEditDirty = false;
  }

  if (!enabled && shoppingMemoEditStore) {
    const ok = window.confirm('買い物メモで保存していない価格・容量の変更があります。破棄して商品一覧へ戻りますか？');
    if (!ok) return;
    shoppingMemoEditStore = null;
    shoppingMemoEditDraft = null;
  }

  storePurchaseMode = !!enabled;

  if (storePurchaseMode) {
    bulkMode = false;
    bulkSelected.clear();
    $('btnStorePurchase').textContent = '商品一覧';
  } else {
    openStoreName = null;
    $('storePurchaseSearch').value = '';
    $('btnStorePurchase').textContent = '買い物メモ';
  }

  render();
}

function persistShoppingMemoChecked() {
  localStorage.setItem(SHOPPING_MEMO_KEY, JSON.stringify(Array.from(shoppingMemoChecked)));
}

function shoppingMemoKey(item) {
  return String(item.row.id);
}

function shoppingMemoGrossPrice(row) {
  const price = Number(row?.price);
  const tax = Number(row?.tax);
  if (!(price >= 0) || row?.price === '' || !(tax >= 0)) return null;
  return row.priceType === 'ex' ? price * (1 + tax / 100) : price;
}

function buildStorePurchaseMap() {
  const map = new Map();

  products.forEach(product => {
    const bests = getBests(product);

    (product.stores || []).forEach(row => {
      const storeName = String(row.store || '').trim() || '店舗未入力';
      if (!map.has(storeName)) map.set(storeName, []);
      map.get(storeName).push({
        product,
        row,
        calc: calcRow(product, row),
        grossPrice: shoppingMemoGrossPrice(row),
        mark: bests.before?.row.id === row.id ? 'low' : ''
      });
    });
  });

  return map;
}

function pruneShoppingMemoChecked(storeMap) {
  const valid = new Set();
  storeMap.forEach(items => items.forEach(item => valid.add(shoppingMemoKey(item))));
  const next = new Set(Array.from(shoppingMemoChecked).filter(key => valid.has(key)));
  if (next.size !== shoppingMemoChecked.size) {
    shoppingMemoChecked = next;
    persistShoppingMemoChecked();
  }
}

function getShoppingMemoDuplicates(storeMap) {
  const selectedByProduct = new Map();

  storeMap.forEach((items, storeName) => {
    items.forEach(item => {
      if (!shoppingMemoChecked.has(shoppingMemoKey(item))) return;
      if (!selectedByProduct.has(item.product.id)) {
        selectedByProduct.set(item.product.id, {product: item.product, stores: []});
      }
      selectedByProduct.get(item.product.id).stores.push(storeName);
    });
  });

  return Array.from(selectedByProduct.values())
    .map(entry => ({
      product: entry.product,
      stores: Array.from(new Set(entry.stores))
    }))
    .filter(entry => entry.stores.length > 1);
}

function updateShoppingMemoDuplicateWarning(storeMap) {
  const duplicates = getShoppingMemoDuplicates(storeMap);
  const warning = $('shoppingMemoDuplicate');
  if (!duplicates.length) {
    warning.classList.add('hidden');
    warning.textContent = '';
    return;
  }

  const lines = duplicates.map(entry => `${entry.product.name}：${entry.stores.join('・')}`);
  warning.textContent = `購入予定が重複しています\n${lines.join('\n')}`;
  warning.classList.remove('hidden');
}

function getShoppingMemoFilter(storeName) {
  return shoppingMemoFilters.get(storeName) || 'all';
}

function shoppingMemoItemVisible(item, storeName) {
  const checked = shoppingMemoChecked.has(shoppingMemoKey(item));
  const filter = getShoppingMemoFilter(storeName);
  if (filter === 'checked') return checked;
  if (filter === 'unchecked') return !checked;
  return true;
}

function startShoppingMemoEdit(storeName, items) {
  shoppingMemoEditStore = storeName;
  shoppingMemoEditDraft = items.map(item => {
    const amount = item.product.kind === 'type' ? item.row.amount : item.product.amount;
    const unit = item.product.kind === 'type' ? item.row.unit : item.product.unit;
    return {
      productId: item.product.id,
      rowId: item.row.id,
      grossPrice: item.grossPrice !== null ? Number(item.grossPrice) : '',
      amount: amount ?? '',
      unit: String(unit || '')
    };
  });
  renderStorePurchaseView();
}

function cancelShoppingMemoEdit() {
  shoppingMemoEditStore = null;
  shoppingMemoEditDraft = null;
  renderStorePurchaseView();
}

function saveShoppingMemoEdit() {
  if (!shoppingMemoEditStore || !Array.isArray(shoppingMemoEditDraft)) return;

  const savedAt = new Date().toISOString();
  shoppingMemoEditDraft.forEach(edit => {
    const product = products.find(item => item.id === edit.productId);
    const row = product?.stores?.find(item => item.id === edit.rowId);
    if (!product || !row) return;

    const beforePrice = historyPriceValue(row.price);
    const grossPrice = edit.grossPrice === '' ? null : Number(edit.grossPrice);

    if (grossPrice !== null && Number.isFinite(grossPrice) && grossPrice >= 0) {
      const taxRate = Number(row.tax) || 0;
      const rawPrice = row.priceType === 'ex'
        ? grossPrice / (1 + taxRate / 100)
        : grossPrice;
      row.price = Math.round(rawPrice * 10000) / 10000;
    } else if (edit.grossPrice === '') {
      row.price = '';
    }

    const amount = Number(edit.amount);
    const unit = String(edit.unit || '').trim();
    if (product.kind === 'type') {
      row.amount = amount > 0 ? amount : '';
      row.unit = unit;
    } else {
      product.amount = amount > 0 ? amount : 1;
      product.unit = unit;
    }

    const afterPrice = historyPriceValue(row.price);
    if (beforePrice !== null && afterPrice !== null && !sameHistoryPrice(beforePrice, afterPrice)) {
      const history = ensureHistory(product);
      history.unshift({
        id: makeId('h'),
        updatedAt: new Date().toISOString(),
        store: (row.store || '店舗未入力').trim() || '店舗未入力',
        beforePrice: Number(beforePrice),
        afterPrice: Number(afterPrice)
      });
      if (history.length > 20) history.length = 20;
    }
    row.updatedAt = savedAt;
    product.updatedAt = savedAt;
  });

  persistNow();
  shoppingMemoEditStore = null;
  shoppingMemoEditDraft = null;
  renderStorePurchaseView();
  showSaveToast('買い物メモの変更を保存しました');
}

function shoppingMemoUnitSelect(value, onChange) {
  const select = document.createElement('select');
  select.className = 'shopping-edit-unit';
  select.setAttribute('aria-label', '単位');
  const units = ['', 'g', 'ml', 'm', '個', '枚', '粒', '本', '袋', '箱', 'パック', '缶', '瓶'];
  const normalized = String(value || '');
  if (normalized && !units.includes(normalized)) units.push(normalized);
  units.forEach(unit => {
    const option = document.createElement('option');
    option.value = unit;
    option.textContent = unit;
    select.appendChild(option);
  });
  select.value = normalized;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function getStoreIllustrationCategory(storeName) {
  const name = String(storeName || '').normalize('NFKC').toLowerCase();
  const has = (...words) => words.some(word => name.includes(word));

  if (has('amazon','アマゾン','楽天','yahoo','ネット','オンライン','通販')) return 'online';
  if (has('ドラッグ','薬局','くすり','クスリ','スギ','ウエルシア','welcia','マツキヨ','マツモトキヨシ','コスモス','サンドラッグ')) return 'drug';
  if (has('ホームセンター','コーナン','カインズ','dcm','アヤハ','ナフコ','コメリ')) return 'home';
  if (has('コンビニ','セブン','ローソン','ファミマ','ファミリーマート','ミニストップ','デイリー')) return 'convenience';
  if (has('スーパー','マート','イオン','西友','平和堂','フレンドマート','バロー','ライフ','業務','マックスバリュ','ラムー','ラ・ムー','イズミヤ','アルプラザ','アル・プラザ')) return 'supermarket';
  return 'shop';
}

function storeIllustrationAccent(storeName) {
  const palette = ['#6f9d63','#c7835a','#d2a343','#6f95a8','#8f806d','#9b7f91'];
  let hash = 0;
  for (const ch of String(storeName || '')) hash = ((hash * 31) + ch.codePointAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function createStoreIllustration(storeName) {
  const category = getStoreIllustrationCategory(storeName);
  const icon = document.createElement('span');
  icon.className = `store-illustration store-illustration-${category}`;
  icon.setAttribute('aria-hidden', 'true');
  icon.style.setProperty('--store-accent', storeIllustrationAccent(storeName));

  const svgs = {
    supermarket: `<svg viewBox="0 0 48 48" focusable="false"><rect x="7" y="19" width="34" height="22" rx="5" fill="#fffaf0"/><path d="M6 18h36l-4-9H10z" fill="var(--store-accent)"/><path d="M10 9h28l1.7 4H8.3z" fill="#f3dfb6"/><path d="M12 18v5M20 18v5M28 18v5M36 18v5" stroke="#fff" stroke-width="3" stroke-linecap="round"/><rect x="13" y="27" width="9" height="14" rx="2" fill="#d9e9d1"/><rect x="26" y="27" width="10" height="7" rx="2" fill="#f1d7a7"/></svg>`,
    drug: `<svg viewBox="0 0 48 48" focusable="false"><rect x="7" y="18" width="34" height="23" rx="5" fill="#fffaf0"/><path d="M6 18h36l-4-8H10z" fill="var(--store-accent)"/><circle cx="24" cy="29" r="8" fill="#eef5e8"/><path d="M24 24v10M19 29h10" stroke="#5d8f59" stroke-width="3.4" stroke-linecap="round"/><rect x="11" y="25" width="6" height="16" rx="2" fill="#f0ddbd"/></svg>`,
    home: `<svg viewBox="0 0 48 48" focusable="false"><path d="M6 21L24 7l18 14v20H6z" fill="#fffaf0"/><path d="M5 21L24 6l19 15-4 4-15-12L9 25z" fill="var(--store-accent)"/><rect x="12" y="27" width="10" height="14" rx="2" fill="#d8e7d0"/><path d="M29 27l7 7M36 27l-7 7" stroke="#b17a56" stroke-width="3" stroke-linecap="round"/></svg>`,
    convenience: `<svg viewBox="0 0 48 48" focusable="false"><rect x="7" y="18" width="34" height="23" rx="5" fill="#fffaf0"/><path d="M6 18h36l-3-8H9z" fill="#f1dfb9"/><path d="M10 10h7v8h-7zM17 10h7v8h-7zM24 10h7v8h-7zM31 10h7v8h-7z" fill="var(--store-accent)"/><rect x="12" y="26" width="9" height="15" rx="2" fill="#dbead3"/><rect x="26" y="26" width="10" height="7" rx="2" fill="#d8e7ef"/></svg>`,
    online: `<svg viewBox="0 0 48 48" focusable="false"><rect x="9" y="12" width="30" height="25" rx="6" fill="#fffaf0" stroke="var(--store-accent)" stroke-width="3"/><path d="M15 20h18M15 26h13" stroke="#c6b18e" stroke-width="3" stroke-linecap="round"/><path d="M29 31l9 4-4 2 2 4-3 1-2-5-3 1z" fill="var(--store-accent)"/></svg>`,
    shop: `<svg viewBox="0 0 48 48" focusable="false"><rect x="7" y="18" width="34" height="23" rx="5" fill="#fffaf0"/><path d="M6 18h36l-4-9H10z" fill="var(--store-accent)"/><path d="M10 18v5M20 18v5M28 18v5M38 18v5" stroke="#fff" stroke-width="3" stroke-linecap="round"/><rect x="12" y="27" width="10" height="14" rx="2" fill="#d9e9d1"/><rect x="27" y="27" width="9" height="8" rx="2" fill="#f0ddbd"/></svg>`
  };
  icon.innerHTML = svgs[category] || svgs.shop;
  return icon;
}

function renderStorePurchaseView() {
  const container = $('storePurchaseList');
  if (!container) return;

  container.innerHTML = '';

  const q = $('storePurchaseSearch').value.trim().toLowerCase();
  const storeMap = buildStorePurchaseMap();
  pruneShoppingMemoChecked(storeMap);
  updateShoppingMemoDuplicateWarning(storeMap);

  const stores = Array.from(storeMap.entries())
    .filter(([storeName]) => !q || storeName.toLowerCase().includes(q))
    .map(([storeName, items]) => [storeName, items.slice().sort((a, b) => compareProducts(a.product, b.product))])
    .sort((a, b) => a[0].localeCompare(b[0], 'ja', { sensitivity: 'base', numeric: true }));

  $('storePurchaseEmpty').classList.toggle('hidden', stores.length !== 0);

  stores.forEach(([storeName, items]) => {
    const card = document.createElement('article');
    card.className = 'store-card';
    const isOpen = openStoreName === storeName;
    const isEditing = shoppingMemoEditStore === storeName;
    if (isOpen) card.classList.add('open');
    if (isEditing) card.classList.add('editing');

    const header = document.createElement('div');
    header.className = 'store-summary';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'store-summary-toggle';

    const name = document.createElement('span');
    name.className = 'store-summary-name';
    name.textContent = storeName;

    const storeCheckedItems = items.filter(item => shoppingMemoChecked.has(shoppingMemoKey(item)));
    const storeTotal = storeCheckedItems.reduce((sum, item) => sum + (item.grossPrice ?? 0), 0);
    const count = document.createElement('span');
    count.className = 'store-summary-count';
    count.textContent = `予定${storeCheckedItems.length}品 / ${fmtPrice(storeTotal)}円（税込）`;

    const chev = document.createElement('span');
    chev.className = 'store-summary-chev';
    chev.textContent = '›';

    const storeIllustration = createStoreIllustration(storeName);
    toggle.append(storeIllustration, name, count, chev);
    toggle.addEventListener('click', () => {
      if (isEditing) return;
      if (shoppingMemoEditStore && shoppingMemoEditStore !== storeName) {
        if (!window.confirm('別の店舗に保存していない変更があります。破棄して移動しますか？')) return;
        shoppingMemoEditStore = null;
        shoppingMemoEditDraft = null;
      }
      openStoreName = openStoreName === storeName ? null : storeName;
      renderStorePurchaseView();
    });

    const actions = document.createElement('div');
    actions.className = 'store-summary-actions';

    if (isEditing) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'ghost mini shopping-store-action';
      cancel.textContent = 'キャンセル';
      cancel.addEventListener('click', cancelShoppingMemoEdit);

      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'primary mini shopping-store-action';
      save.textContent = '保存';
      save.addEventListener('click', saveShoppingMemoEdit);
      actions.append(cancel, save);
    } else {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'ghost mini shopping-store-action';
      edit.textContent = '価格・容量編集';
      edit.addEventListener('click', () => {
        openStoreName = storeName;
        startShoppingMemoEdit(storeName, items);
      });

      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'ghost mini shopping-store-action';
      reset.textContent = 'チェックをリセット';
      reset.dataset.shoppingReset = '1';
      reset.disabled = storeCheckedItems.length === 0;
      reset.addEventListener('click', () => {
        items.forEach(item => shoppingMemoChecked.delete(shoppingMemoKey(item)));
        persistShoppingMemoChecked();
        renderStorePurchaseView();
      });
      actions.append(edit, reset);
    }

    header.append(toggle, actions);
    card.appendChild(header);

    if (isOpen && !isEditing) {
      const filterBar = document.createElement('div');
      filterBar.className = 'shopping-store-filters';
      filterBar.setAttribute('role', 'group');
      filterBar.setAttribute('aria-label', `${storeName}の購入予定フィルター`);
      [
        ['all', 'すべて'],
        ['checked', 'チェック済み'],
        ['unchecked', 'チェックなし']
      ].forEach(([value, label]) => {
        const filterButton = document.createElement('button');
        filterButton.type = 'button';
        filterButton.className = 'shopping-filter';
        if (getShoppingMemoFilter(storeName) === value) filterButton.classList.add('active');
        filterButton.textContent = label;
        filterButton.addEventListener('click', () => {
          shoppingMemoFilters.set(storeName, value);
          renderStorePurchaseView();
        });
        filterBar.appendChild(filterButton);
      });
      card.appendChild(filterBar);
    }

    if (isOpen) {
      const productList = document.createElement('div');
      productList.className = 'store-product-list';

      const visibleItems = isEditing ? items : items.filter(item => shoppingMemoItemVisible(item, storeName));
      visibleItems.forEach(item => {
        const row = document.createElement('div');
        row.className = 'store-product-row';

        const mark = document.createElement('span');
        mark.className = 'store-product-mark';
        if (item.mark === 'low') mark.appendChild(createPriceBadge('low', true));

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'store-product-check';
        checkbox.checked = shoppingMemoChecked.has(shoppingMemoKey(item));
        checkbox.setAttribute('aria-label', `${item.product.name}を購入予定にする`);
        checkbox.addEventListener('change', () => {
          const key = shoppingMemoKey(item);
          if (checkbox.checked) shoppingMemoChecked.add(key);
          else shoppingMemoChecked.delete(key);
          persistShoppingMemoChecked();

          if (getShoppingMemoFilter(storeName) !== 'all' && !isEditing) {
            renderStorePurchaseView();
            return;
          }

          const refreshedMap = buildStorePurchaseMap();
          updateShoppingMemoDuplicateWarning(refreshedMap);
          const refreshedItems = refreshedMap.get(storeName) || [];
          const checkedItems = refreshedItems.filter(entry => shoppingMemoChecked.has(shoppingMemoKey(entry)));
          const checkedTotal = checkedItems.reduce((sum, entry) => sum + (entry.grossPrice ?? 0), 0);
          count.textContent = `予定${checkedItems.length}品 / ${fmtPrice(checkedTotal)}円（税込）`;
          const resetButton = actions.querySelector('[data-shopping-reset]');
          if (resetButton) resetButton.disabled = checkedItems.length === 0;
        });

        const productName = document.createElement('span');
        productName.className = 'store-product-name';
        productName.textContent = item.product.name;
        productName.title = item.product.name;

        if (isEditing) {
          const edit = shoppingMemoEditDraft?.find(d => d.productId === item.product.id && d.rowId === item.row.id);
          if (!edit) return;

          const amountWrap = document.createElement('span');
          amountWrap.className = 'shopping-edit-amount-wrap';
          const amountInput = document.createElement('input');
          amountInput.className = 'shopping-edit-amount';
          amountInput.type = 'text';
          amountInput.inputMode = 'decimal';
          amountInput.value = edit.amount ?? '';
          amountInput.setAttribute('aria-label', `${item.product.name}の容量`);
          amountInput.addEventListener('input', () => { edit.amount = amountInput.value; });
          const unitSelect = shoppingMemoUnitSelect(edit.unit, value => { edit.unit = value; });
          amountWrap.append(amountInput, unitSelect);

          const priceWrap = document.createElement('span');
          priceWrap.className = 'shopping-edit-price-wrap';
          const priceInput = document.createElement('input');
          priceInput.className = 'shopping-edit-price';
          priceInput.type = 'text';
          priceInput.inputMode = 'decimal';
          priceInput.value = edit.grossPrice === '' ? '' : fmtPrice(edit.grossPrice);
          priceInput.setAttribute('aria-label', `${item.product.name}の税込価格`);
          priceInput.addEventListener('input', () => {
            edit.grossPrice = priceInput.value.replace(/,/g, '');
          });
          const yen = document.createElement('span');
          yen.textContent = '円';
          priceWrap.append(priceInput, yen);

          row.append(mark, checkbox, productName, amountWrap, priceWrap);
        } else {
          const itemAmount = item.product.kind === 'type' ? item.row.amount : item.product.amount;
          const itemUnit = item.product.kind === 'type' ? item.row.unit : item.product.unit;

          const amount = document.createElement('span');
          amount.className = 'store-product-amount';
          amount.textContent = itemAmount !== '' && itemAmount !== null && itemAmount !== undefined
            ? `${fmt(itemAmount)}${itemUnit || ''}`
            : '';

          const price = document.createElement('span');
          price.className = 'store-product-price';
          price.textContent = item.grossPrice !== null ? `${fmtPrice(item.grossPrice)}円` : '-';

          row.append(mark, checkbox, productName, amount, price);
        }

        productList.appendChild(row);
      });

      if (!visibleItems.length) {
        const empty = document.createElement('div');
        empty.className = 'shopping-store-empty';
        const activeFilter = getShoppingMemoFilter(storeName);
        empty.textContent = activeFilter === 'checked'
          ? 'チェック済みの商品はありません。'
          : activeFilter === 'unchecked'
            ? 'チェックなしの商品はありません。'
            : '商品はありません。';
        productList.appendChild(empty);
      }

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
  shoppingMemoChecked.clear();
  persistShoppingMemoChecked();

  persistNow();
  localStorage.setItem(INITIALIZED_KEY, '1');

  msg.textContent = '全商品を削除したよ。';
  render();
}

function setBulkMode(enabled) {
  if (enabled && !confirmDiscardProductEdit()) return;
  if (enabled && openProductId) {
    openProductId = null;
    productEditDraft = null;
    productEditDirty = false;
  }
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
  $('btnBulkStore').textContent = bulkMode ? '追加対象選択中' : '店舗一括追加';
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
      couponValue: '',
      amount: product.kind === 'type' ? '' : (Number(product.amount) > 0 ? Number(product.amount) : 1),
      unit: product.unit || '個',
      updatedAt: new Date().toISOString()
    });
    product.updatedAt = new Date().toISOString();

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

async function loadRecommendedProductsDirect() {
  const msg = $('templateMessage');
  const btn = $('btnLoadRecommendedTemplate');
  btn.disabled = true;
  msg.textContent = 'おすすめ商品を読み込み中…';
  try {
    const response = await fetch('./template-products.json?v=1', {cache:'no-store'});
    if (!response.ok) throw new Error('fetch failed');
    const data = await response.json();
    if (!Array.isArray(data.products)) throw new Error('invalid');

    const keys = new Set(products.map(productTemplateKey));
    let added = 0;
    data.products.forEach(item => {
      const product = {
        id: makeId('p'),
        name: String(item.name || '').trim(),
        reading: normalizeReadingInput(item.reading || ''),
        kind: 'product',
        amount: Number(item.amount),
        unit: String(item.unit || '').trim(),
        defaultTax: Number.isFinite(Number(item.defaultTax)) ? Number(item.defaultTax) : settings.reducedTax,
        history: [],
        stores: []
      };
      if (!product.name || !(product.amount > 0) || !product.unit) return;
      const key = productTemplateKey(product);
      if (keys.has(key)) return;
      products.push(product);
      keys.add(key);
      added += 1;
    });
    persistNow();
    render();
    updateTemplateSummary();
    msg.textContent = added ? `おすすめ商品を${added}件追加したよ。` : '追加できるおすすめ商品はなかったよ。';
  } catch {
    msg.textContent = 'おすすめ商品を読み込めなかったよ。';
  } finally {
    btn.disabled = false;
  }
}

function exportCurrentTemplateFile() {
  const msg = $('templateMessage');
  if (!products.length) {
    msg.textContent = 'テンプレートにする商品がまだないよ。';
    return;
  }

  const payload = {
    app: 'PriceLog',
    type: 'current-products-template',
    version: 2,
    createdAt: new Date().toISOString(),
    products: products.map(product => ({
      name: product.name,
      reading: product.reading || '',
      kind: product.kind === 'type' ? 'type' : 'product',
      barcode: product.kind === 'type' ? '' : String(product.barcode || ''),
      amount: Number(product.amount) > 0 ? Number(product.amount) : 1,
      unit: product.unit || '',
      defaultTax: Number(product.defaultTax),
      stores: (product.stores || []).map(row => ({
        name: String(row.store || '').trim(),
        amount: product.kind === 'type'
          ? (Number(row.amount) > 0 ? Number(row.amount) : Number(product.amount) || 1)
          : undefined,
        unit: product.kind === 'type' ? (row.unit || product.unit || '個') : undefined,
        price: '',
        priceType: 'ex',
        tax: Number(product.defaultTax),
        couponType: 'none',
        couponValue: ''
      })).filter(row => row.name)
    }))
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PriceLog-template-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  msg.textContent = `現在の商品${products.length}件をテンプレートに書き出したよ。価格・クーポン・履歴は含めていないよ。`;
}

function importTemplateFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const msg = $('templateMessage');
  const reader = new FileReader();

  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      if (data?.app !== 'PriceLog' || !Array.isArray(data.products)) throw new Error('invalid');

      const productByKey = new Map(products.map(product => [productTemplateKey(product), product]));
      let addedProducts = 0;
      let addedStores = 0;

      data.products.forEach(raw => {
        const kind = raw.kind === 'type' ? 'type' : 'product';
        const amount = Number(raw.amount) > 0 ? Number(raw.amount) : 1;
        const unit = String(raw.unit || (kind === 'type' ? '個' : '')).trim();
        const candidate = {
          id: makeId('p'),
          name: String(raw.name || '').trim(),
          reading: normalizeReadingInput(raw.reading || ''),
          kind,
          barcode: kind === 'product' ? normalizeBarcodeCode(raw.barcode || '') : '',
          amount,
          unit,
          defaultTax: Number.isFinite(Number(raw.defaultTax)) ? Number(raw.defaultTax) : settings.reducedTax,
          history: [],
          stores: []
        };
        if (!candidate.name) return;

        const key = productTemplateKey(candidate);
        let product = productByKey.get(key);
        if (!product) {
          if (candidate.barcode && findProductByBarcode(candidate.barcode)) candidate.barcode = '';
          product = candidate;
          products.push(product);
          productByKey.set(key, product);
          addedProducts += 1;
        }

        const sourceStores = Array.isArray(raw.stores) ? raw.stores : [];
        sourceStores.forEach(storeRaw => {
          const storeName = String(storeRaw?.name ?? storeRaw?.store ?? '').trim();
          if (!storeName) return;
          const exists = product.stores.some(row =>
            String(row.store || '').trim().toLowerCase() === storeName.toLowerCase()
          );
          if (exists) return;

          product.stores.push({
            id: makeId('s'),
            store: storeName,
            price: '',
            priceType: 'ex',
            tax: Number(product.defaultTax),
            couponType: 'none',
            couponValue: '',
            amount: product.kind === 'type'
              ? (Number(storeRaw?.amount) > 0 ? Number(storeRaw.amount) : Number(product.amount) || 1)
              : Number(product.amount) || 1,
            unit: product.kind === 'type'
              ? (String(storeRaw?.unit || product.unit || '個').trim() || '個')
              : product.unit
          });
          addedStores += 1;
        });
      });

      products = normalizeProductsData(products);
      persistNow();
      render();
      msg.textContent = `商品${addedProducts}件、店舗行${addedStores}件を差分追加したよ。価格は空欄・税抜で読み込んだよ。`;
    } catch {
      msg.textContent = 'テンプレートファイルを読み込めなかったよ。';
    } finally {
      e.target.value = '';
    }
  };

  reader.readAsText(file);
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
  const storeCount = products.reduce((sum, product) => sum + (product.stores || []).filter(row => String(row.store || '').trim()).length, 0);
  el.textContent = `現在の商品 ${products.length}件　店舗行 ${storeCount}件`;
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
    kind: 'product',
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
  const kind = product.kind === 'type' ? 'type' : 'product';
  if (kind === 'type') return `${kind}|${name}`;

  const unit = String(product.unit || '').normalize('NFKC').trim().toLowerCase();
  const amount = Number(product.amount);
  return `${kind}|${name}|${Number.isFinite(amount) ? amount : ''}|${unit}`;
}

function openBarcodeDialog() {
  stopBarcodeCamera();
  barcodeLookupData = null;
  barcodeReadingManuallyEdited = false;
  barcodeReturnToProductDialog = $('productDialog').open;

  $('barcodeResult').classList.add('hidden');
  $('barcodeManualCode').value = '';
  $('barcodeCameraMessage').textContent = 'カメラを起動してね。';
  $('barcodeProductNameEdit').value = '';
  $('barcodeTypeNameEdit').value = '';
  $('barcodeReading').value = '';
  $('barcodeAmount').value = '';
  $('barcodeUnit').value = '';

  $('barcodeChoiceProduct').checked = settings.barcodeNameDefault !== 'type';
  $('barcodeChoiceType').checked = settings.barcodeNameDefault === 'type';

  $('barcodeCameraSection').classList.remove('hidden');
  $('barcodeManualSection').classList.remove('hidden');

  if ($('productDialog').open) $('productDialog').close();
  $('barcodeDialog').showModal();
}

function resetBarcodeLookupView() {
  stopBarcodeCamera();
  barcodeLookupData = null;
  barcodeReadingManuallyEdited = false;
  $('barcodeResult').classList.add('hidden');
  $('barcodeCameraSection').classList.remove('hidden');
  $('barcodeManualSection').classList.remove('hidden');
  $('barcodeManualCode').value = '';
  $('barcodeCameraMessage').textContent = 'カメラを起動してね。';
  $('barcodeProductNameEdit').value = '';
  $('barcodeTypeNameEdit').value = '';
  $('barcodeReading').value = '';
  $('barcodeAmount').value = '';
  setBarcodeUnit('');
}

function closeBarcodeDialog({ returnToProduct = true } = {}) {
  stopBarcodeCamera();
  if ($('barcodeDialog').open) $('barcodeDialog').close();
  if (returnToProduct && barcodeReturnToProductDialog && !$('productDialog').open) {
    $('productDialog').showModal();
    requestAnimationFrame(() => $('productDialog').scrollTop = 0);
  }
  if (!returnToProduct) barcodeReturnToProductDialog = false;
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

  if (!window.isSecureContext) {
    msg.textContent = 'カメラはHTTPS接続でのみ使用できます。JANコードを直接入力してください。';
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    msg.textContent = 'このブラウザーではカメラを使用できません。JANコードを直接入力してください。';
    return;
  }

  barcodeDetector = await createBarcodeDetector();
  if (!barcodeDetector) {
    msg.textContent = 'このブラウザーはバーコード自動読み取りに未対応です。Chromeを最新版にするか、JANコードを直接入力してください。';
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
    msg.textContent = 'バーコードを枠の中央に合わせてください。';
    scanBarcodeFrame();
  } catch (err) {
    const name = String(err?.name || '');
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      msg.textContent = 'カメラの使用が許可されていません。ブラウザーのサイト設定でカメラを許可するか、JANコードを直接入力してください。';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      msg.textContent = '使用できるカメラが見つかりません。JANコードを直接入力してください。';
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      msg.textContent = 'カメラを使用できません。他のアプリでカメラを閉じてから、もう一度試してください。';
    } else if (name === 'OverconstrainedError') {
      msg.textContent = 'この端末のカメラ設定では起動できませんでした。JANコードを直接入力してください。';
    } else {
      msg.textContent = 'カメラを起動できませんでした。カメラ権限を確認するか、JANコードを直接入力してください。';
    }
  }
}

async function scanBarcodeFrame() {
  if (!barcodeScanning || !barcodeDetector) return;

  const video = $('barcodeVideo');

  try {
    if (video.readyState >= 2) {
      const codes = await barcodeDetector.detect(video);

      if (codes?.length) {
        const raw = normalizeBarcodeCode(codes[0].rawValue || '');

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

function normalizeBarcodeCode(value) {
  let digits = String(value || '')
    .normalize('NFKC')
    .replace(/\D/g, '');

  // 一部ブラウザがEAN-13をGTIN-14の先頭0付きで返す場合に補正。
  if (digits.length === 14 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return digits;
}


function findProductByBarcode(code) {
  const normalized = normalizeBarcodeCode(code);
  return products.find(
    product => normalizeBarcodeCode(product.barcode || '') === normalized
  );
}

async function lookupBarcodeProduct(code) {
  code = normalizeBarcodeCode(code);
  if (!code) return;

  stopBarcodeCamera(false);

  const result = $('barcodeResult');
  const status = $('barcodeLookupStatus');

  result.classList.remove('hidden');
  $('barcodeCameraSection').classList.add('hidden');
  $('barcodeManualSection').classList.add('hidden');
  $('barcodeResultCode').textContent = code;
  requestAnimationFrame(() => result.scrollIntoView({block:'start'}));
  status.textContent = '商品情報を検索中…';

  // 1) PriceLog内の登録済みJAN
  const existing = findProductByBarcode(code);
  if (existing) {
    const existingTypeName = deriveKnownBarcodeTypeFromText(existing.name || '');
    barcodeLookupData = {
      code,
      source: 'pricelog',
      typeQuantity: Number(existing.amount) > 0 && existing.unit
        ? { amount: Number(existing.amount), unit: existing.unit }
        : null,
      productUnit: ''
    };

    status.textContent = `PriceLog内で「${existing.name}」が見つかったよ。`;
    $('barcodeProductNameEdit').value = existing.name;
    $('barcodeTypeNameEdit').value = existingTypeName;
    applyBarcodeRegisterDefaults();
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
  const jan = normalizeBarcodeCode(code);
  if (!jan) return null;

  // 1) この画面を開いている間の成功キャッシュ
  const cached = yahooLookupCache.get(jan);
  if (cached && cached.hit && Date.now() - cached.time < 5 * 60 * 1000) {
    return cached.hit;
  }

  // 2) 過去30日以内にこの端末で見つけた成功結果
  const persistentHit = getPersistentYahooProduct(jan);
  if (persistentHit) {
    yahooLookupCache.set(jan, { time: Date.now(), hit: persistentHit });
    return persistentHit;
  }

  if (yahooLookupInflight.has(jan)) {
    return yahooLookupInflight.get(jan);
  }

  const promise = (async () => {
    let janHits = [];
    let queryHits = [];

    // 3) Yahoo! JAN検索 1回目
    let janData = await fetchYahooViaWorker(
      { janCode: jan, results: 10 },
      clientId,
      workerUrl
    );
    janHits = Array.isArray(janData?.hits) ? janData.hits : [];

    // JAN検索が0件なら、同じJANでもう1回だけ再検索。
    // fetchYahooViaWorker側で1.2秒以上の間隔を必ず空ける。
    if (!janHits.length) {
      const status = $('barcodeLookupStatus');
      if (status) status.textContent = 'Yahoo!ショッピングでもう一度確認中…';

      janData = await fetchYahooViaWorker(
        { janCode: jan, results: 10 },
        clientId,
        workerUrl
      );
      janHits = Array.isArray(janData?.hits) ? janData.hits : [];
    }

    // 4) 2回とも0件なら、最後にJANコードを検索キーワードとして試す。
    if (!janHits.length) {
      const status = $('barcodeLookupStatus');
      if (status) status.textContent = 'JANコードを別の検索方法でも確認中…';

      const queryData = await fetchYahooViaWorker(
        { query: jan, results: 10 },
        clientId,
        workerUrl
      );
      queryHits = Array.isArray(queryData?.hits) ? queryData.hits : [];
    }

    const hits = janHits.length ? janHits : queryHits;

    // 0件はキャッシュしない。次回は必ず再検索する。
    if (!hits.length) return null;

    const exactJanHits = hits.filter(
      hit => normalizeBarcodeCode(hit?.janCode || '') === jan
    );

    const candidates = exactJanHits.length ? exactJanHits : hits;
    candidates.sort((a, b) => yahooHitScore(b) - yahooHitScore(a));

    const hit = candidates[0] || null;

    if (hit) {
      yahooLookupCache.set(jan, { time: Date.now(), hit });
      savePersistentYahooProduct(jan, hit);
    }

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
  const cleanExactName = cleanBarcodeProductNameCandidate(exactName);
  const cleanTypeName = cleanBarcodeText(typeName);
  $('barcodeProductNameEdit').value = cleanExactName;
  $('barcodeTypeNameEdit').value = cleanTypeName;

  if (barcodeLookupData) {
    barcodeLookupData.typeQuantity = quantity || null;
    barcodeLookupData.productUnit = '';
  }

  // 検索結果が変わるたび、必ず「正式商品名」を初期選択に戻す。
  $('barcodeChoiceProduct').checked = true;
  $('barcodeChoiceType').checked = false;
  syncBarcodeChoiceLabels();
  syncBarcodeQuantityForChoice();
}

function applyYahooShoppingResult(code, hit) {
  const exactName = cleanYahooProductName(hit?.name || '');
  const typeName = deriveYahooType(hit, exactName);
  const quantity = parseQuantityFromYahoo(hit);

  barcodeLookupData = {
    code,
    source: 'yahoo',
    yahooHit: hit,
    product: { product_type: isYahooLikelyFood(hit) ? 'food' : 'other' },
    typeQuantity: quantity || null,
    productUnit: ''
  };

  $('barcodeProductNameEdit').value = exactName;
  $('barcodeTypeNameEdit').value = typeName;

  applyBarcodeRegisterDefaults();
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
    [['粒ガム','板ガム','ボトルガム','チューインガム','chewing gum','ガム','キシリトール','xylitol','クロレッツ','clorets','リカルデント','recaldent','ブラックブラック','black black','グリーンガム','フィッツ','fits','acuo','アクオ','ポスカ','pos-ca','ミンティア','フリスク','frisk'], 'ガム'],
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
  const text = yahooSearchText(hit, exactName);
  const known = deriveKnownBarcodeTypeFromText(text);
  if (known) return known;

  // 「味」「風味」「フレーバー」などは比較カテゴリではないため種類候補にしない。
  const genreCandidates = [
    hit?.genreCategory?.name || '',
    ...(Array.isArray(hit?.parentGenreCategories)
      ? hit.parentGenreCategories.map(x => x?.name || '')
      : [])
  ];
  for (const candidate of genreCandidates) {
    const clean = cleanBarcodeText(candidate);
    if (!clean || /^(?:味|風味|フレーバー|香り|タイプ)$/i.test(clean)) continue;
    const resolved = deriveKnownBarcodeTypeFromText(clean);
    if (resolved) return resolved;
  }
  return '';
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
    'categories','categories_tags'
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
    typeQuantity: quantity || null,
    productUnit: ''
  };

  $('barcodeProductNameEdit').value = exactName;
  $('barcodeTypeNameEdit').value = typeName;

  applyBarcodeRegisterDefaults();
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
    product: { product_type: 'food' },
    typeQuantity: quantity || null,
    productUnit: ''
  };

  $('barcodeProductNameEdit').value = exactName;
  $('barcodeTypeNameEdit').value = typeName;

  applyBarcodeRegisterDefaults();
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
  barcodeLookupData = {
    code,
    typeQuantity: null,
    productUnit: ''
  };

  $('barcodeProductNameEdit').value = '';
  $('barcodeTypeNameEdit').value = '';
  $('barcodeReading').value = '';
  $('barcodeAmount').value = '';
  setBarcodeUnit('');

  applyBarcodeRegisterDefaults();
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

function deriveProductRegistrationUnit(value, typeName = '') {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  const type = String(typeName || '').normalize('NFKC').toLowerCase();
  const all = `${type} ${text}`;

  // 種類として数える量ではなく「その商品1つを何と数えるか」を決める。
  // 例: 食パン6枚切りでも、商品名登録では 1商品として扱う。
  const typeRules = [
    [['食パン','パン'], '袋'],
    [['米','こめ'], '袋'],
    [['牛乳','低脂肪乳','加工乳','豆乳','ジュース','お茶','緑茶','麦茶','炭酸水','水','コーヒー','紅茶','スポーツドリンク'], '本'],
    [['醤油','しょうゆ','みりん','料理酒','酢','オリーブオイル','サラダ油','食用油','ケチャップ','マヨネーズ','ソース'], '本'],
    [['ラップ','アルミホイル'], '本'],
    [['卵','たまご'], 'パック'],
    [['納豆','豆腐','ヨーグルト','チーズ','バター','ガム','チョコレート','アイス','歯磨き粉','歯ブラシ','電池'], '個'],
    [['ティッシュ'], '箱'],
    [['トイレットペーパー','キッチンペーパー','ゴミ袋'], '袋'],
    [['洗濯洗剤','食器用洗剤','柔軟剤','シャンプー','コンディショナー','ボディソープ','ハンドソープ'], '本']
  ];

  for (const [keywords, unit] of typeRules) {
    if (keywords.some(keyword => type.includes(keyword))) return unit;
  }

  // 商品名や説明に包装形態が明記されている場合はそれを使う。
  // 「6枚切り」「14粒」など中身の個数表現はここでは単位判定に使わない。
  const packagingRules = [
    [/(?:パウチ|袋入り|袋詰め|袋詰|バッグ(?:入り)?)/, '袋'],
    [/(?:ボックス|box|箱入り|箱詰め|箱詰)/, '箱'],
    [/(?:パック入り|パック詰め|パック詰)/, 'パック'],
    [/(?:ペットボトル|ボトル)/, '本'],
    [/(?:びん|瓶)/, '瓶'],
    [/(?:缶入り|缶詰|缶タイプ)/, '缶'],
    [/(?:シート|シート状)/, '枚']
  ];

  for (const [pattern, unit] of packagingRules) {
    if (pattern.test(text)) return unit;
  }

  // 種類が取れない商品は、明確な商品形状だけ補助判定する。
  if (/(?:マスク|シートマスク|フェイスマスク|カード|シール|ステッカー)/.test(all)) return '枚';
  if (/(?:袋|パウチ)/.test(text)) return '袋';
  if (/(?:箱|box)/.test(text)) return '箱';
  if (/(?:ボトル|ペットボトル)/.test(text)) return '本';
  if (/(?:缶)/.test(text)) return '缶';
  if (/(?:瓶|びん)/.test(text)) return '瓶';
  if (/(?:パック)/.test(text)) return 'パック';

  return '個';
}

function syncBarcodeQuantityForChoice() {
  const amountInput = $('barcodeAmount');
  const isProduct = $('barcodeChoiceProduct').checked;

  if (isProduct) {
    // 「1」は固定値ではなく初期値。商品ごとの実際の内容量へ変更できる。
    amountInput.readOnly = false;
    amountInput.value = String(barcodeLookupData?.productAmount ?? 1);
    setBarcodeUnit(barcodeLookupData?.productUnit || '');
    return;
  }

  amountInput.readOnly = false;
  const quantity = barcodeLookupData?.typeQuantity;

  if (quantity && Number(quantity.amount) > 0 && quantity.unit) {
    amountInput.value = String(quantity.amount);
    setBarcodeUnit(quantity.unit);
  } else {
    amountInput.value = '';
    setBarcodeUnit('');
  }
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

function updateBarcodeReadingFromChoice() {
  if (barcodeReadingManuallyEdited) return;

  const choice =
    document.querySelector('input[name="barcodeNameChoice"]:checked')?.value ||
    'product';

  const name = choice === 'type'
    ? $('barcodeTypeNameEdit').value.trim()
    : $('barcodeProductNameEdit').value.trim();

  $('barcodeReading').value = barcodeReadingForName(name);
}

function applyBarcodeRegisterDefaults() {
  barcodeReadingManuallyEdited = false;

  const hasProduct = !!$('barcodeProductNameEdit').value.trim();
  const hasType = !!$('barcodeTypeNameEdit').value.trim();
  const preferType = settings.barcodeNameDefault === 'type';

  if (preferType && hasType) {
    $('barcodeChoiceType').checked = true;
    $('barcodeChoiceProduct').checked = false;
  } else {
    $('barcodeChoiceProduct').checked = true;
    $('barcodeChoiceType').checked = false;
  }

  // 商品名がなく、種類だけ取れた場合は種類へフォールバック。
  if (!hasProduct && hasType) {
    $('barcodeChoiceType').checked = true;
    $('barcodeChoiceProduct').checked = false;
  }


  syncBarcodeChoiceLabels();
  syncBarcodeQuantityForChoice();
  updateBarcodeReadingFromChoice();
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

  const productSelected = $('barcodeChoiceProduct').checked;
  $('barcodeProductNameEdit').disabled = !productSelected;
  $('barcodeTypeNameEdit').disabled = productSelected || !type;
  $('barcodeProductNameEdit').closest('label')?.classList.toggle('is-disabled', !productSelected);
  $('barcodeTypeNameEdit').closest('label')?.classList.toggle('is-disabled', productSelected || !type);
}

function barcodeReadingForName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';

  const known = findKnownReading(raw);
  if (known) return known;

  const exactMap = new Map([
    ['牛乳','ぎゅうにゅう'],
    ['低脂肪乳','ていしぼうにゅう'],
    ['加工乳','かこうにゅう'],
    ['豆乳','とうにゅう'],
    ['ヨーグルト','よーぐると'],
    ['インスタントコーヒー','いんすたんとこーひー'],
    ['コーヒー','こーひー'],
    ['紅茶','こうちゃ'],
    ['緑茶','りょくちゃ'],
    ['麦茶','むぎちゃ'],
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
    ['ガム','がむ'],
    ['チョコレート','ちょこれーと'],
    ['アイス','あいす'],
    ['米','こめ'],
    ['歯磨き粉','はみがきこ'],
    ['歯ブラシ','はぶらし'],
    ['アルミホイル','あるみほいる'],
    ['ラップ','らっぷ'],
    ['キッチンペーパー','きっちんぺーぱー'],
    ['トイレットペーパー','といれっとぺーぱー'],
    ['ティッシュ','てぃっしゅ'],
    ['食器用洗剤','しょっきようせんざい'],
    ['洗濯洗剤','せんたくせんざい'],
    ['柔軟剤','じゅうなんざい'],
    ['シャンプー','しゃんぷー'],
    ['コンディショナー','こんでぃしょなー'],
    ['ボディソープ','ぼでぃそーぷ'],
    ['ハンドソープ','はんどそーぷ'],
    ['ゴミ袋','ごみぶくろ'],
    ['電池','でんち']
  ]);

  if (exactMap.has(raw)) return exactMap.get(raw);

  // 漢字を含まない商品名は、カタカナをひらがなへ変換すればそのまま読みとして使える。
  if (!hasKanji(raw)) {
    return katakanaToHiragana(raw).normalize('NFKC').toLowerCase();
  }

  // バーコードの商品名で頻出するブランド名・商品語だけローカル辞書で変換する。
  // 未知の漢字が残る場合は誤読を作らず空欄にして、手修正できるようにする。
  const replacements = [
    ['江崎グリコ','えざきぐりこ'],
    ['雪印メグミルク','ゆきじるしめぐみるく'],
    ['雪印','ゆきじるし'],
    ['森永乳業','もりながにゅうぎょう'],
    ['森永製菓','もりながせいか'],
    ['明治','めいじ'],
    ['味の素','あじのもと'],
    ['日清食品','にっしんしょくひん'],
    ['日清','にっしん'],
    ['東洋水産','とうようすいさん'],
    ['伊藤園','いとうえん'],
    ['山崎製パン','やまざきせいぱん'],
    ['旭化成','あさひかせい'],
    ['大王製紙','だいおうせいし'],
    ['日本製紙','にっぽんせいし'],
    ['王子ネピア','おうじねぴあ'],
    ['牛乳石鹸','ぎゅうにゅうせっけん'],
    ['低脂肪乳','ていしぼうにゅう'],
    ['加工乳','かこうにゅう'],
    ['牛乳','ぎゅうにゅう'],
    ['豆乳','とうにゅう'],
    ['無糖','むとう'],
    ['微糖','びとう'],
    ['加糖','かとう'],
    ['濃厚','のうこう'],
    ['無添加','むてんか'],
    ['国産','こくさん'],
    ['北海道','ほっかいどう'],
    ['食パン','しょくぱん'],
    ['薄力粉','はくりきこ'],
    ['強力粉','きょうりきこ'],
    ['小麦粉','こむぎこ'],
    ['砂糖','さとう'],
    ['食塩','しょくえん'],
    ['料理酒','りょうりしゅ'],
    ['醤油','しょうゆ'],
    ['味噌','みそ'],
    ['緑茶','りょくちゃ'],
    ['麦茶','むぎちゃ'],
    ['紅茶','こうちゃ'],
    ['炭酸水','たんさんすい'],
    ['食器用','しょっきよう'],
    ['洗濯','せんたく'],
    ['衣料用','いりょうよう'],
    ['洗剤','せんざい'],
    ['柔軟剤','じゅうなんざい'],
    ['歯磨き粉','はみがきこ'],
    ['歯磨き','はみがき'],
    ['歯ブラシ','はぶらし'],
    ['箱','はこ'],
    ['袋','ふくろ'],
    ['種','しゅ'],
    ['粒','つぶ'],
    ['枚','まい'],
    ['個','こ'],
    ['本','ほん'],
    ['入','いり']
  ].sort((a, b) => b[0].length - a[0].length);

  let converted = raw.normalize('NFKC');

  for (const [from, to] of replacements) {
    converted = converted.split(from).join(to);
  }

  converted = katakanaToHiragana(converted).toLowerCase();

  // 漢字が残るなら読みを推測しない。
  if (hasKanji(converted)) return '';

  return converted.replace(/\s+/g, ' ').trim();
}

function registerBarcodeProduct() {
  const code = normalizeBarcodeCode(
    barcodeLookupData?.code || $('barcodeManualCode').value || ''
  );

  if (!code) {
    $('barcodeLookupStatus').textContent = 'バーコードを読み取るか入力してね。';
    return;
  }

  const choice =
    document.querySelector('input[name="barcodeNameChoice"]:checked')?.value ||
    'product';

  const barcodeForProduct = choice === 'product' ? code : '';
  if (barcodeForProduct) {
    const existing = findProductByBarcode(barcodeForProduct);
    if (existing) {
      $('barcodeLookupStatus').textContent = `「${existing.name}」として登録済みだよ。`;
      return;
    }
  }

  const exactName = $('barcodeProductNameEdit').value.trim();
  const typeName = $('barcodeTypeNameEdit').value.trim();
  const name = choice === 'type' ? typeName : exactName;
  const amount = Number($('barcodeAmount').value);
  const unit = $('barcodeUnit').value;

  if (!name) {
    $('barcodeLookupStatus').textContent = '登録する名前を確認してね。';
    return;
  }
  if (!(amount > 0) || (choice === 'type' && !unit)) {
    $('barcodeLookupStatus').textContent = '内容量と単位を確認してね。';
    return;
  }

  let reading = normalizeReadingInput($('barcodeReading').value);
  if (!reading) reading = barcodeReadingForName(name);

  const productType = barcodeLookupData?.product?.product_type || 'food';
  const defaultTax = productType === 'food'
    ? Number(settings.reducedTax)
    : Number(settings.standardTax);

  // 商品はここではまだ保存しない。商品追加画面へ戻し、店舗・価格も続けて入力できるようにする。
  $('productName').value = exactName;
  $('productTypeName').value = typeName;
  $('productReading').value = reading;
  $('productAmount').value = choice === 'product' ? String(amount > 0 ? amount : 1) : String(amount || '');
  setSelectValueWithOption($('productUnit'), unit || '');
  $('productTax').innerHTML = taxOptions(defaultTax);
  $('productTax').value = String(defaultTax);
  readingWasManuallyEdited = false;
  productDialogBarcodeDraft = { barcode: code, defaultTax };
  if (productDialogStores.length) {
    productDialogStores.forEach(row => { if (!row.store && row.price === '') row.tax = defaultTax; });
    if (choice === 'type') {
      productDialogStores[0].amount = amount > 0 ? amount : '';
      productDialogStores[0].unit = unit || '個';
    }
  }
  setProductKindChoice(choice, { updateReading: false });
  renderProductDialogStores();

  closeBarcodeDialog({ returnToProduct: true });
  showSaveToast('商品情報を入力しました。店舗・価格も続けて登録できます');
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
  const candidate = makeReadingCandidate(getActiveProductNameValue());

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

function getActiveProductNameValue() {
  const kind = $('productKind').value;
  if (kind === 'type') return $('productTypeName').value.trim();
  if (kind === 'product') return $('productName').value.trim();
  return '';
}

function setProductKindChoice(kind, { updateReading = true } = {}) {
  const normalized = kind === 'type' ? 'type' : kind === 'product' ? 'product' : '';
  $('productKind').value = normalized;
  $('productKindProduct').checked = normalized === 'product';
  $('productKindType').checked = normalized === 'type';

  const productEnabled = normalized === 'product';
  const typeEnabled = normalized === 'type';
  $('productName').disabled = !productEnabled;
  $('productTypeName').disabled = !typeEnabled;
  $('productNameField').classList.toggle('is-disabled', !productEnabled);
  $('productTypeNameField').classList.toggle('is-disabled', !typeEnabled);
  $('productAmountGroup').classList.toggle('hidden', normalized === 'type' || !normalized);

  if (updateReading && normalized && !readingWasManuallyEdited) {
    const candidate = makeReadingCandidate(getActiveProductNameValue());
    $('productReading').value = candidate || '';
  }
  renderProductDialogStores();
}

function syncProductKindFields() {
  setProductKindChoice($('productKind').value, { updateReading: false });
}

function makeBlankDialogStore() {
  return {
    id: makeId('qs'),
    store: '',
    price: '',
    priceType: settings.defaultPriceType,
    tax: Number($('productTax')?.value || settings.reducedTax),
    couponType: 'none',
    couponValue: '',
    amount: '',
    unit: '個',
    updatedAt: ''
  };
}

function hasMeaningfulDialogStore(row) {
  return !!String(row.store || '').trim() || row.price !== '' || row.couponValue !== '' || Number(row.amount) > 0;
}

function renderProductDialogStores() {
  const list = $('productStoreList');
  if (!list) return;
  list.innerHTML = '';
  if (editProductId) return;

  const kind = $('productKind').value;
  const productAmount = Number($('productAmount').value) || 1;
  const productUnit = $('productUnit').value || '個';

  productDialogStores.forEach((row, index) => {
    const card = document.createElement('div');
    card.className = 'product-add-store-card';
    card.innerHTML = `
      <div class="quick-store-main">
        <label>店舗<input class="qs-store" type="text" maxlength="40" placeholder="店舗名"></label>
        <label>価格<input class="qs-price" type="text" inputmode="decimal" placeholder="価格"></label>
        <button class="qs-delete" type="button" aria-label="この店舗を削除">×</button>
      </div>
      <div class="quick-store-options">
        <label>税込/税抜<select class="qs-price-type"><option value="inc">税込</option><option value="ex">税抜</option></select></label>
        <label>税率<select class="qs-tax">${taxOptions(row.tax)}</select></label>
        <label>クーポン<select class="qs-coupon-type"><option value="none">なし</option><option value="percent">%OFF</option><option value="yen">円引</option></select></label>
        <label>値<input class="qs-coupon-value" type="text" inputmode="decimal" placeholder="-"></label>
      </div>
      <div class="quick-store-quantity ${kind === 'type' ? '' : 'hidden'}">
        <label>内容量<input class="qs-amount" type="text" inputmode="decimal" placeholder="内容量"></label>
        <label>単位<select class="qs-unit"><option value="g">g</option><option value="ml">ml</option><option value="m">m</option><option value="個">個</option><option value="枚">枚</option><option value="粒">粒</option><option value="本">本</option><option value="袋">袋</option><option value="箱">箱</option><option value="パック">パック</option><option value="缶">缶</option><option value="瓶">瓶</option></select></label>
      </div>
      <div class="quick-store-result">税込価格・単価：<strong class="qs-result">-</strong></div>`;

    const store = card.querySelector('.qs-store');
    const price = card.querySelector('.qs-price');
    const priceType = card.querySelector('.qs-price-type');
    const tax = card.querySelector('.qs-tax');
    const couponType = card.querySelector('.qs-coupon-type');
    const couponValue = card.querySelector('.qs-coupon-value');
    const amount = card.querySelector('.qs-amount');
    const unit = card.querySelector('.qs-unit');
    const result = card.querySelector('.qs-result');

    store.value = row.store || '';
    price.value = row.price ?? '';
    priceType.value = row.priceType === 'inc' ? 'inc' : 'ex';
    tax.value = String(row.tax ?? settings.reducedTax);
    couponType.value = ['percent','yen'].includes(row.couponType) ? row.couponType : 'none';
    couponValue.value = row.couponValue ?? '';
    amount.value = Number(row.amount) > 0 ? row.amount : '';
    setSelectValueWithOption(unit, row.unit || '個');

    const update = () => {
      row.store = store.value.trim();
      row.price = numberOrBlank(price.value);
      row.priceType = priceType.value;
      row.tax = Number(tax.value);
      row.couponType = couponType.value;
      row.couponValue = numberOrBlank(couponValue.value);
      row.amount = numberOrBlank(amount.value);
      row.unit = unit.value || '個';
      couponValue.disabled = row.couponType === 'none';
      const tempProduct = { kind: kind || 'product', amount: productAmount, unit: productUnit };
      const calc = calcRow(tempProduct, row);
      result.textContent = calc
        ? `${fmtPrice(calc.grossBefore)}円 / ${fmtUnit(calc.beforeUnit)}`
        : '-';
    };

    [store, price, priceType, tax, couponType, couponValue, amount, unit].forEach(control => {
      control.addEventListener('input', update);
      control.addEventListener('change', update);
    });
    card.querySelector('.qs-delete').addEventListener('click', () => {
      productDialogStores.splice(index, 1);
      renderProductDialogStores();
    });
    update();
    list.appendChild(card);
  });

  if (!productDialogStores.length) {
    const empty = document.createElement('div');
    empty.className = 'product-add-store-empty';
    empty.textContent = '店舗情報なしでも商品だけ保存できる。';
    list.appendChild(empty);
  }
}

function openProductDialog(id = null) {
  if (!id && productEditDraft) {
    if (!confirmDiscardProductEdit()) return;
    openProductId = null;
    productEditDraft = null;
    productEditDirty = false;
  }
  editProductId = id;
  const persisted = id ? products.find(x => x.id === id) : null;
  const p = id && productEditDraft?.id === id ? productEditDraft : persisted;

  readingWasManuallyEdited = false;
  productNameIsComposing = false;
  compositionReadingCandidate = '';
  productDialogBarcodeDraft = null;

  $('productDialogTitle').textContent = p ? '商品設定' : '商品追加';
  const candidates = normalizeNameCandidates(p?.nameCandidates, p?.kind === 'type' ? 'type' : 'product', p?.name || '');
  $('productName').value = p ? candidates.product : '';
  $('productTypeName').value = p ? candidates.type : '';
  $('productReading').value = p?.reading ?? '';
  $('productAmount').value = p?.amount ?? 100;
  setSelectValueWithOption($('productUnit'), p?.unit ?? 'g');

  const taxSelect = $('productTax');
  const selectedTax = p?.defaultTax ?? settings.reducedTax;
  taxSelect.innerHTML = taxOptions(selectedTax);
  taxSelect.value = String(selectedTax);

  productDialogStores = p ? [] : [makeBlankDialogStore()];
  $('productStoreSection').classList.toggle('hidden', !!p);
  setProductKindChoice(p ? (p.kind === 'type' ? 'type' : 'product') : '', { updateReading: false });

  const dialog = $('productDialog');
  dialog.showModal();

  requestAnimationFrame(() => {
    dialog.scrollTop = 0;
    $('productForm').scrollTop = 0;
    const focusTarget = p
      ? (p.kind === 'type' ? $('productTypeName') : $('productName'))
      : $('productKindProduct');
    try { focusTarget.focus({ preventScroll: true }); }
    catch { focusTarget.focus(); }
    requestAnimationFrame(() => {
      dialog.scrollTop = 0;
      $('productForm').scrollTop = 0;
    });
  });
}

function saveProductFromDialog() {
  const kind = $('productKind').value;
  if (!['product','type'].includes(kind)) {
    alert('「商品名」か「種類比較」を先に選んでね。');
    return;
  }

  const productNameCandidate = $('productName').value.trim();
  const typeNameCandidate = $('productTypeName').value.trim();
  const name = kind === 'type' ? typeNameCandidate : productNameCandidate;
  if (!name) {
    alert(kind === 'type' ? '種類名を入力してね。' : '商品名を入力してね。');
    return;
  }

  if (!$('productReading').value.trim()) {
    const candidate = makeReadingCandidate(name);
    if (candidate) $('productReading').value = candidate;
  }

  let amount = Number($('productAmount').value);
  let unit = $('productUnit').value || '個';
  if (kind === 'type') {
    const current = editProductId
      ? (productEditDraft?.id === editProductId ? productEditDraft : products.find(x => x.id === editProductId))
      : null;
    amount = current?.kind === 'type' ? (current.amount ?? '') : '';
    unit = current?.kind === 'type' ? (current.unit || '') : '';
  }

  if (kind === 'product' && !(amount > 0)) {
    alert('内容量を入力してね。');
    return;
  }

  const defaultTax = Number($('productTax').value);
  const savedAt = new Date().toISOString();
  const nameCandidates = { product: productNameCandidate, type: typeNameCandidate };

  if (editProductId) {
    const persisted = products.find(x => x.id === editProductId);
    let target = productEditDraft?.id === editProductId ? productEditDraft : (persisted ? structuredCloneSafe(persisted) : null);
    if (target) {
      const previousKind = target.kind === 'type' ? 'type' : 'product';
      target.name = name;
      target.nameCandidates = nameCandidates;
      target.reading = normalizeReadingInput($('productReading').value);
      target.kind = kind;
      target.amount = amount;
      target.unit = unit;
      target.defaultTax = defaultTax;
      target.updatedAt = savedAt;

      if (previousKind !== kind && kind === 'type') {
        target.stores.forEach(row => {
          if (!(Number(row.amount) > 0)) row.amount = Number(target.amount) > 0 ? Number(target.amount) : '';
          if (!row.unit) row.unit = target.unit || '個';
          row.updatedAt = savedAt;
        });
      }

      if (openProductId === editProductId) {
        productEditDraft = target;
        markProductEditDirty();
      } else {
        const index = products.findIndex(x => x.id === editProductId);
        if (index >= 0) products[index] = target;
        persistNow();
      }
    }
  } else {
    const meaningfulRows = productDialogStores.filter(hasMeaningfulDialogStore);
    const invalidStore = meaningfulRows.find(row => !String(row.store || '').trim());
    if (invalidStore) {
      alert('店舗・価格を登録する場合は店舗名を入力してね。');
      return;
    }

    const barcode = kind === 'product'
      ? normalizeBarcodeCode(productDialogBarcodeDraft?.barcode || '')
      : '';
    if (barcode) {
      const existing = findProductByBarcode(barcode);
      if (existing) {
        alert(`このバーコードは「${existing.name}」で登録済みだよ。`);
        return;
      }
    }

    const stores = meaningfulRows.map(row => ({
      id: makeId('s'),
      store: String(row.store || '').trim(),
      price: row.price ?? '',
      priceType: row.priceType === 'inc' ? 'inc' : 'ex',
      tax: Number.isFinite(Number(row.tax)) ? Number(row.tax) : defaultTax,
      couponType: ['percent','yen'].includes(row.couponType) ? row.couponType : 'none',
      couponValue: row.couponValue ?? '',
      amount: kind === 'type' ? (Number(row.amount) > 0 ? Number(row.amount) : '') : amount,
      unit: kind === 'type' ? String(row.unit || '個') : unit,
      updatedAt: savedAt
    }));

    const p = {
      id: makeId('p'),
      barcode,
      name,
      nameCandidates,
      reading: normalizeReadingInput($('productReading').value),
      kind,
      amount,
      unit,
      defaultTax,
      updatedAt: savedAt,
      history: [],
      stores
    };
    products.unshift(p);
    persistNow();
    openProductId = null;
    productEditDraft = null;
    productEditDirty = false;
    showSaveToast(stores.length ? '商品と店舗情報を保存しました' : '商品を保存しました');
  }

  productDialogBarcodeDraft = null;
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
  if (productEditDraft) {
    if (!confirmDiscardProductEdit()) return;
    openProductId = null;
    productEditDraft = null;
    productEditDirty = false;
    render();
  }
  $('standardTax').value = settings.standardTax;
  $('reducedTax').value = settings.reducedTax;
  $('defaultPriceType').value = settings.defaultPriceType;
  $('barcodeNameDefault').value =
    settings.barcodeNameDefault === 'type' ? 'type' : 'product';
  $('yahooClientId').value = settings.yahooClientId || '';
  $('yahooClientId').type = 'password';
  $('btnToggleYahooClientId').textContent = '表示';
  $('yahooApiStatus').textContent = '';
  updateTemplateSummary();
  $('templateMessage').textContent = '';
  $('settingsDialog').showModal();
}

function storeDataSnapshot(row) {
  return {
    store: normalizeMergeText(row?.store),
    price: numberOrBlank(row?.price ?? ''),
    priceType: row?.priceType === 'inc' ? 'inc' : 'ex',
    tax: Number.isFinite(Number(row?.tax)) ? Number(row.tax) : '',
    couponType: ['percent','yen'].includes(row?.couponType) ? row.couponType : 'none',
    couponValue: numberOrBlank(row?.couponValue ?? ''),
    amount: numberOrBlank(row?.amount ?? ''),
    unit: String(row?.unit || '').normalize('NFKC').trim()
  };
}

function sameStoreData(a, b) {
  return JSON.stringify(storeDataSnapshot(a)) === JSON.stringify(storeDataSnapshot(b));
}

function productMetaSnapshot(product) {
  return {
    name: normalizeMergeText(product?.name),
    reading: normalizeReadingInput(product?.reading || ''),
    kind: product?.kind === 'type' ? 'type' : 'product',
    barcode: normalizeBarcodeCode(product?.barcode || ''),
    amount: numberOrBlank(product?.amount ?? ''),
    unit: String(product?.unit || '').normalize('NFKC').trim(),
    defaultTax: Number.isFinite(Number(product?.defaultTax)) ? Number(product.defaultTax) : ''
  };
}

function sameProductMeta(a, b) {
  return JSON.stringify(productMetaSnapshot(a)) === JSON.stringify(productMetaSnapshot(b));
}

function normalizeMergeText(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function productMergeKey(product) {
  const kind = product?.kind === 'type' ? 'type' : 'product';
  const barcode = kind === 'product' ? normalizeBarcodeCode(product?.barcode || '') : '';
  if (barcode) return `jan:${barcode}`;
  return `${kind}:${normalizeMergeText(product?.name)}`;
}

function findMatchingProduct(incoming) {
  const incomingKind = incoming?.kind === 'type' ? 'type' : 'product';
  const incomingBarcode = incomingKind === 'product' ? normalizeBarcodeCode(incoming?.barcode || '') : '';
  if (incomingBarcode) {
    const byBarcode = products.find(product =>
      product.kind !== 'type' && normalizeBarcodeCode(product.barcode || '') === incomingBarcode
    );
    if (byBarcode) return byBarcode;
  }
  const key = productMergeKey(incoming);
  return products.find(product => productMergeKey(product) === key) || null;
}

function formatUpdatedAt(value) {
  const raw = normalizeIsoDate(value);
  if (!raw) return '更新日時不明';
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'
    }).format(new Date(raw));
  } catch {
    return '更新日時不明';
  }
}

function buildBackupPayload({ selectedProducts = null, mode = 'backup' } = {}) {
  const targetProducts = selectedProducts
    ? products.filter(product => selectedProducts.has(product.id))
    : products;
  const data = { products: structuredCloneSafe(targetProducts) };
  if (mode === 'backup') {
    data.settings = settings;
    data.customTemplate = customTemplate;
    data.shoppingMemoChecked = Array.from(shoppingMemoChecked);
  }
  return {
    app: 'PriceLog',
    appVersion: APP_VERSION,
    schemaVersion: DATA_SCHEMA_VERSION,
    mode,
    exportedAt: new Date().toISOString(),
    data
  };
}

function downloadJsonPayload(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportBackup() {
  const payload = buildBackupPayload();
  downloadJsonPayload(payload, `PriceLog-backup-${new Date().toISOString().slice(0,10)}.json`);
}

function migrateBackupPayload(data) {
  if (!data || typeof data !== 'object') throw new Error('invalid');
  if (data.app && data.app !== 'PriceLog') throw new Error('invalid-app');

  const schema = Number(data.schemaVersion ?? data.version ?? 2);
  if (Number.isFinite(schema) && schema > DATA_SCHEMA_VERSION) {
    const error = new Error('future-schema');
    error.code = 'future-schema';
    throw error;
  }

  // schema 3以降はdata配下。旧バックアップはルート直下をそのまま受ける。
  const source = data.data && typeof data.data === 'object' ? data.data : data;
  if (!Array.isArray(source.products)) throw new Error('invalid');

  return {
    ...source,
    app: data.app || 'PriceLog',
    appVersion: data.appVersion || '',
    mode: data.mode || source.mode || 'backup',
    exportedAt: data.exportedAt || source.exportedAt || '',
    schemaVersion: Number.isFinite(schema) ? schema : 2,
    products: normalizeProductsData(source.products),
    settings: normalizeSettingsData(source.settings || settings)
  };
}

function importBackup(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = migrateBackupPayload(JSON.parse(String(reader.result)));
      if (data.mode === 'share') {
        alert('これは家族共有用のファイルだよ。「共有データを追加する」から読み込んでね。');
        return;
      }
      settings = normalizeSettingsData(data.settings || {});
      products = normalizeProductsData(data.products);
      shoppingMemoChecked = new Set(Array.isArray(data.shoppingMemoChecked) ? data.shoppingMemoChecked.map(String) : []);
      persistShoppingMemoChecked();

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
      showSaveToast('バックアップを復元しました');
    } catch (err) {
      if (err?.code === 'future-schema') {
        alert('このバックアップは新しいPriceLogで作成されています。PriceLogを更新してから読み込んでね。');
      } else {
        alert('バックアップファイルを読み込めなかったよ。');
      }
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
}

function openShareDialog() {
  shareSelectedProducts = new Set();
  $('shareSearch').value = '';
  renderShareProductList();
  $('shareDialog').showModal();
}

function closeShareDialog() {
  if ($('shareDialog').open) $('shareDialog').close();
}

function visibleShareProducts() {
  const q = normalizeMergeText($('shareSearch').value);
  return products
    .filter(product => !q || normalizeMergeText(product.name).includes(q) || normalizeMergeText(product.reading).includes(q))
    .slice()
    .sort(compareProducts);
}

function renderShareProductList() {
  const list = $('shareProductList');
  if (!list) return;
  list.innerHTML = '';
  const visible = visibleShareProducts();

  visible.forEach(product => {
    const label = document.createElement('label');
    label.className = 'share-product-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = shareSelectedProducts.has(product.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) shareSelectedProducts.add(product.id);
      else shareSelectedProducts.delete(product.id);
      updateShareSelectionSummary();
    });
    const body = document.createElement('span');
    body.className = 'share-product-body';
    const name = document.createElement('strong');
    name.textContent = product.name;
    const meta = document.createElement('small');
    meta.textContent = `${product.kind === 'type' ? '種類比較' : '商品名'} ・ 店舗${(product.stores || []).filter(row => String(row.store || '').trim()).length}件 ・ ${formatUpdatedAt(product.updatedAt)}`;
    body.append(name, meta);
    label.append(checkbox, body);
    list.appendChild(label);
  });

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '該当する商品がないよ。';
    list.appendChild(empty);
  }
  updateShareSelectionSummary();
}

function updateShareSelectionSummary() {
  $('shareSelectionSummary').textContent = `選択中：${shareSelectedProducts.size}商品`;
  $('btnCreateShareFile').disabled = shareSelectedProducts.size === 0;
}

function setVisibleShareSelection(selected) {
  visibleShareProducts().forEach(product => {
    if (selected) shareSelectedProducts.add(product.id);
    else shareSelectedProducts.delete(product.id);
  });
  renderShareProductList();
}

async function shareSelectedData() {
  if (!shareSelectedProducts.size) return;
  const payload = buildBackupPayload({ selectedProducts: shareSelectedProducts, mode: 'share' });
  const date = new Date().toISOString().slice(0,10);
  const filename = `PriceLog-share-${date}.json`;
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], {type:'application/json'});

  try {
    const file = new File([blob], filename, {type:'application/json'});
    if (navigator.share && (!navigator.canShare || navigator.canShare({files:[file]}))) {
      await navigator.share({
        title: 'PriceLog共有データ',
        text: `PriceLogの商品データ ${shareSelectedProducts.size}件`,
        files: [file]
      });
      closeShareDialog();
      showSaveToast('共有画面を開きました');
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
  }

  downloadJsonPayload(payload, filename);
  closeShareDialog();
  showSaveToast('共有ファイルを書き出しました');
}

function meaningfulShareRows(product) {
  return (product?.stores || []).filter(row => String(row.store || '').trim() || row.price !== '');
}

function buildMergePlan(incomingProducts) {
  const plan = {
    incomingCount: incomingProducts.length,
    newProducts: [],
    newRows: [],
    duplicates: 0,
    conflicts: []
  };

  incomingProducts.forEach(incoming => {
    const current = findMatchingProduct(incoming);
    if (!current) {
      plan.newProducts.push(incoming);
      return;
    }

    if (!sameProductMeta(current, incoming)) {
      plan.conflicts.push({
        id: makeId('c'),
        type: 'product',
        productId: current.id,
        incoming,
        choice: 'current'
      });
    }

    meaningfulShareRows(incoming).forEach(incomingRow => {
      const storeKey = normalizeMergeText(incomingRow.store);
      const currentRow = (current.stores || []).find(row => normalizeMergeText(row.store) === storeKey);
      if (!currentRow) {
        plan.newRows.push({ productId: current.id, incomingRow });
        return;
      }
      if (sameStoreData(currentRow, incomingRow)) {
        plan.duplicates += 1;
        return;
      }
      plan.conflicts.push({
        id: makeId('c'),
        type: 'row',
        productId: current.id,
        rowId: currentRow.id,
        incomingRow,
        choice: 'current'
      });
    });
  });

  return plan;
}

function productMetaSummary(product) {
  const kind = product?.kind === 'type' ? '種類比較' : '商品名';
  const amount = Number(product?.amount) > 0 ? `${fmt(product.amount)}${product.unit || ''}` : '容量未設定';
  return `${kind} / ${amount} / 税率${Number(product?.defaultTax) || 0}%`;
}

function storeDataSummary(row) {
  const price = row?.price === '' ? '価格未設定' : `${fmt(Number(row.price) || 0)}円${row?.priceType === 'inc' ? '(税込)' : '(税抜)'}`;
  const coupon = row?.couponType === 'percent'
    ? ` / ${fmt(Number(row.couponValue) || 0)}%OFF`
    : row?.couponType === 'yen'
      ? ` / ${fmt(Number(row.couponValue) || 0)}円引`
      : '';
  const quantity = Number(row?.amount) > 0 ? ` / ${fmt(row.amount)}${row.unit || ''}` : '';
  return `${price} / 税率${Number(row?.tax) || 0}%${coupon}${quantity}`;
}

function importSharedData(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = migrateBackupPayload(JSON.parse(String(reader.result)));
      pendingMergePlan = buildMergePlan(data.products);
      renderMergeDialog();
      if ($('settingsDialog').open) $('settingsDialog').close();
      $('mergeDialog').showModal();
    } catch (err) {
      if (err?.code === 'future-schema') {
        alert('この共有データは新しいPriceLogで作成されています。PriceLogを更新してから読み込んでね。');
      } else {
        alert('共有データを読み込めなかったよ。');
      }
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
}

function renderMergeDialog() {
  const plan = pendingMergePlan;
  if (!plan) return;
  $('mergeSummary').innerHTML = `
    <strong>${plan.incomingCount}商品を確認</strong>
    <div class="merge-count-grid">
      <span>新規商品 <b>${plan.newProducts.length}</b></span>
      <span>新規店舗情報 <b>${plan.newRows.length}</b></span>
      <span>同一データ <b>${plan.duplicates}</b></span>
      <span>競合 <b>${plan.conflicts.length}</b></span>
    </div>`;

  $('mergeConflictTools').classList.toggle('hidden', plan.conflicts.length === 0);
  const list = $('mergeConflictList');
  list.innerHTML = '';

  plan.conflicts.forEach(conflict => {
    const currentProduct = products.find(product => product.id === conflict.productId);
    if (!currentProduct) return;
    const currentRow = conflict.type === 'row'
      ? currentProduct.stores.find(row => row.id === conflict.rowId)
      : null;
    const incoming = conflict.type === 'row' ? conflict.incomingRow : conflict.incoming;
    const current = conflict.type === 'row' ? currentRow : currentProduct;

    const card = document.createElement('div');
    card.className = 'merge-conflict-card';
    const title = document.createElement('strong');
    title.textContent = conflict.type === 'row'
      ? `${currentProduct.name} / ${currentRow?.store || incoming?.store || '店舗'}`
      : `${currentProduct.name} / 商品情報`;
    card.appendChild(title);

    const choices = document.createElement('div');
    choices.className = 'merge-choice-grid';
    [['current','現在のデータ',current],['shared','共有されたデータ',incoming]].forEach(([value,labelText,data]) => {
      const label = document.createElement('label');
      label.className = 'merge-choice';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `merge_${conflict.id}`;
      radio.value = value;
      radio.checked = conflict.choice === value;
      radio.addEventListener('change', () => { if (radio.checked) conflict.choice = value; });
      const body = document.createElement('span');
      const head = document.createElement('b');
      head.textContent = labelText;
      const desc = document.createElement('span');
      desc.textContent = conflict.type === 'row' ? storeDataSummary(data) : productMetaSummary(data);
      const date = document.createElement('small');
      date.textContent = formatUpdatedAt(data?.updatedAt);
      body.append(head, desc, date);
      label.append(radio, body);
      choices.appendChild(label);
    });
    card.appendChild(choices);
    list.appendChild(card);
  });

  if (!plan.conflicts.length) {
    const message = document.createElement('div');
    message.className = 'merge-no-conflict';
    message.textContent = '競合はないよ。差分だけそのまま追加できる。';
    list.appendChild(message);
  }
}

function setAllConflictChoices(choice) {
  if (!pendingMergePlan) return;
  pendingMergePlan.conflicts.forEach(conflict => conflict.choice = choice);
  renderMergeDialog();
}

function closeMergeDialog() {
  pendingMergePlan = null;
  if ($('mergeDialog').open) $('mergeDialog').close();
}

function cloneIncomingProductForLocal(incoming) {
  const copy = structuredCloneSafe(incoming);
  copy.id = makeId('p');
  copy.stores = meaningfulShareRows(copy).map(row => ({...row, id: makeId('s')}));
  copy.history = Array.isArray(copy.history) ? copy.history.map(item => ({...item, id: makeId('h')})).slice(0,20) : [];
  return copy;
}

function applyIncomingProductMeta(target, incoming) {
  target.name = incoming.name;
  target.nameCandidates = normalizeNameCandidates(incoming.nameCandidates, incoming.kind, incoming.name);
  target.reading = incoming.reading;
  target.kind = incoming.kind === 'type' ? 'type' : 'product';
  target.barcode = target.kind === 'product' ? normalizeBarcodeCode(incoming.barcode || '') : '';
  target.amount = incoming.amount;
  target.unit = incoming.unit;
  target.defaultTax = incoming.defaultTax;
  target.updatedAt = incoming.updatedAt || new Date().toISOString();
}

function applyPendingMerge() {
  const plan = pendingMergePlan;
  if (!plan) return;
  const appliedAt = new Date().toISOString();

  plan.newProducts.forEach(incoming => products.push(cloneIncomingProductForLocal(incoming)));

  plan.newRows.forEach(item => {
    const product = products.find(p => p.id === item.productId);
    if (!product) return;
    const row = structuredCloneSafe(item.incomingRow);
    row.id = makeId('s');
    row.updatedAt = row.updatedAt || appliedAt;
    product.stores.push(row);
    product.updatedAt = appliedAt;
  });

  plan.conflicts.forEach(conflict => {
    if (conflict.choice !== 'shared') return;
    const product = products.find(p => p.id === conflict.productId);
    if (!product) return;
    if (conflict.type === 'product') {
      applyIncomingProductMeta(product, conflict.incoming);
      return;
    }
    const row = product.stores.find(r => r.id === conflict.rowId);
    if (!row) return;
    const incoming = conflict.incomingRow;
    const keepId = row.id;
    Object.assign(row, structuredCloneSafe(incoming), { id: keepId });
    row.updatedAt = incoming.updatedAt || appliedAt;
    product.updatedAt = appliedAt;
  });

  products = normalizeProductsData(products);
  persistNow();
  render();
  const addedCount = plan.newProducts.length + plan.newRows.length;
  const sharedConflictCount = plan.conflicts.filter(conflict => conflict.choice === 'shared').length;
  closeMergeDialog();
  showSaveToast(`差分${addedCount}件・競合反映${sharedConflictCount}件を追加しました`);
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
