(() => {
'use strict';

const STORAGE_KEY = 'pricelog_v02_data';
const SETTINGS_KEY = 'pricelog_v02_settings';
const INITIALIZED_KEY = 'pricelog_initialized_v1';
const SHOPPING_MEMO_KEY = 'pricelog_shopping_memo_v1';
const V051_SETTINGS_MIGRATION_KEY = 'pricelog_v051_settings_migrated';
const APP_VERSION = '0.90';
const DATA_SCHEMA_VERSION = 3;
const UNIT_OPTIONS = ['g','kg','mg','ml','L','cl','dl','m','cm','mm','個','枚','粒','本','袋','箱','パック','セット','束','缶','瓶','カップ','食','ロール','組','錠','包','ケース','台','冊','足'];
const CUSTOM_UNIT_VALUE = '__custom__';
let bulkAddKind = 'product';
let bulkAddRowsByKind = { product: [], type: [] };
let smartSuggestionState = null;


const defaultSettings = {
  standardTax: 10,
  reducedTax: 8,
  defaultPriceType: 'ex',
  registrationNameDefault: 'product'
};

function normalizeSettingsData(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    standardTax: Number.isFinite(Number(value.standardTax)) ? Number(value.standardTax) : defaultSettings.standardTax,
    reducedTax: Number.isFinite(Number(value.reducedTax)) ? Number(value.reducedTax) : defaultSettings.reducedTax,
    defaultPriceType: value.defaultPriceType === 'inc' ? 'inc' : 'ex',
    registrationNameDefault: value.registrationNameDefault === 'type' ? 'type' : 'product'
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
let shelfCompareMode = false;
let shelfCompareRows = [];
let shelfCompareCommon = { priceType: settings.defaultPriceType, tax: settings.reducedTax };
let shelfCompareSeedKey = '';
let shelfCompareDirty = false;
let openStoreName = null;
let shoppingMemoFilters = new Map();
let shoppingMemoChecked = new Set((loadJson(SHOPPING_MEMO_KEY, []) || []).map(String));
let shoppingMemoEditStore = null;
let shoppingMemoEditDraft = null;
let readingWasManuallyEdited = false;
let productDialogReadings = { product: '', type: '' };
let productDialogReadingManual = { product: false, type: false };
let productNameIsComposing = false;
let compositionReadingCandidate = '';
let productDialogStores = [];
let shareSelectedProducts = new Set();
let pendingMergePlan = null;



const $ = (id) => document.getElementById(id);
const listEl = $('productList');
const productTemplate = $('productTemplate');
const storeTemplate = $('storeTemplate');

initializeWithoutSamples();
render();

$('searchInput').addEventListener('input', render);
$('btnAddProduct').addEventListener('click', () => $('addChoiceDialog').showModal());
$('btnBulkStore').addEventListener('click', () => setBulkMode(!bulkMode));
$('btnBulkCancel').addEventListener('click', () => setBulkMode(false));
$('btnBulkSelectAll').addEventListener('click', toggleBulkSelectAll);
$('btnBulkAdd').addEventListener('click', bulkAddStore);
$('btnProductList').addEventListener('click', () => switchMainView('products'));
$('btnStorePurchase').addEventListener('click', () => switchMainView('shopping'));
$('btnShelfCompare').addEventListener('click', () => switchMainView('shelf'));
$('btnAddShelfCompare').addEventListener('click', addShelfCompareRow);
$('btnClearShelfCompare').addEventListener('click', clearShelfCompare);
$('btnRegisterShelfCompare').addEventListener('click', registerSelectedShelfCompareRows);
$('shelfCompareType').addEventListener('input', () => {
  shelfCompareDirty = true;
  updateShelfCompareSuggestions();
});
$('shelfCompareType').addEventListener('change', () => { syncShelfCompareExistingRows(); renderShelfCompare(); });
$('shelfCompareType').addEventListener('blur', () => { syncShelfCompareExistingRows(); renderShelfCompare(); });
$('shelfCompareStore').addEventListener('input', () => { shelfCompareDirty = true; });
$('shelfCompareStore').addEventListener('change', () => { syncShelfCompareExistingRows(); renderShelfCompare(); });
$('shelfCompareStore').addEventListener('blur', () => { syncShelfCompareExistingRows(); renderShelfCompare(); });
$('btnShelfCompareTypeChoices')?.addEventListener('click', () => openShelfChoiceDialog('type'));
$('btnShelfCompareStoreChoices')?.addEventListener('click', () => openShelfChoiceDialog('store'));
$('btnCloseShelfChoiceDialog')?.addEventListener('click', closeShelfChoiceDialog);
$('shelfChoiceDialog')?.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeShelfChoiceDialog();
});
$('shelfComparePriceType').addEventListener('change', () => { shelfCompareDirty = true; shelfCompareCommon.priceType = $('shelfComparePriceType').value === 'inc' ? 'inc' : 'ex'; renderShelfCompare(); });
$('shelfCompareTax').addEventListener('change', () => { shelfCompareDirty = true; shelfCompareCommon.tax = Number($('shelfCompareTax').value); renderShelfCompare(); });
$('storePurchaseSearch').addEventListener('input', renderStorePurchaseView);
$('btnDeleteAllProducts').addEventListener('click', deleteAllProducts);
$('btnSettings').addEventListener('click', openSettings);

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
    registrationNameDefault: $('registrationNameDefault').value === 'type' ? 'type' : 'product'
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
  hideSmartSuggestions();
  if (dialog.open) dialog.close();
});

$('productDialog').addEventListener('cancel', (e) => {
  e.preventDefault();
  $('productDialog').close();
});


$('productKindProduct').addEventListener('change', () => setProductKindChoice('product'));
$('productKindType').addEventListener('change', () => setProductKindChoice('type'));
$('btnAddProductStore').addEventListener('click', () => { productDialogStores.push(makeBlankDialogStore()); renderProductDialogStores(); });
$('productAmount').addEventListener('input', refreshProductDialogStoreResults);
$('productAmount').addEventListener('change', refreshProductDialogStoreResults);
$('productUnit').addEventListener('change', refreshProductDialogStoreResults);

$('btnCloseAddChoice')?.addEventListener('click', () => $('addChoiceDialog').close());
$('btnAddSingle')?.addEventListener('click', () => { $('addChoiceDialog').close(); openProductDialog(); });
$('btnAddBulkProducts')?.addEventListener('click', () => { $('addChoiceDialog').close(); openBulkAddDialog(); });
$('btnCloseBulkAdd')?.addEventListener('click', () => closeBulkAddDialog());
$('bulkTabProduct')?.addEventListener('click', () => setBulkAddKind('product'));
$('bulkTabType')?.addEventListener('click', () => setBulkAddKind('type'));
$('btnBulkAddRow')?.addEventListener('click', () => { bulkAddRowsByKind[bulkAddKind].push(makeBulkAddRow(bulkAddKind)); renderBulkAddRows(); });
$('btnSaveBulkAdd')?.addEventListener('click', saveBulkAdd);
$('bulkAddStore')?.addEventListener('input', () => showSmartSuggestions($('bulkAddStore'),'store'));

bindSmartSuggestion($('productName'),'product');
bindSmartSuggestion($('productTypeName'),'type');
bindSmartSuggestion($('shelfCompareType'),'type');
bindSmartSuggestion($('shelfCompareStore'),'store');
bindSmartSuggestion($('bulkAddStore'),'store');
bindSmartSuggestion($('bulkStoreName'),'store');
enableCustomUnitSelect($('productUnit'));
setupInputExperience();

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
  const kind = $('productKind').value;
  if (kind === 'product' || kind === 'type') {
    productDialogReadings[kind] = $('productReading').value;
    productDialogReadingManual[kind] = true;
  }
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
  if (!productEditDirty && !shelfCompareDirty && !shoppingMemoEditStore) return;
  e.preventDefault();
  e.returnValue = '';
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`./sw.js?v=${APP_VERSION}`, { updateViaCache: 'none' })
      .then(registration => registration.update())
      .catch(() => {});
  });
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
    const productData = { ...product };
    delete productData[['bar','code'].join('')];
    const kind = product.kind === 'type' ? 'type' : 'product';
    const amount = kind === 'type'
      ? (Number(product.amount) > 0 ? Number(product.amount) : '')
      : (Number(product.amount) > 0 ? Number(product.amount) : 1);
    const unit = String(product.unit || '').trim();
    const stores = Array.isArray(product.stores) ? product.stores : [];

    return {
      ...productData,
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
          productInfo: String(row.productInfo || ''),
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
  try {
    window.dispatchEvent(new CustomEvent('pricelog:data-changed', { detail: { products: structuredCloneSafe(products) } }));
  } catch {}
}

function taxOptions(selected) {
  const values = Array.from(new Set([Number(settings.reducedTax), Number(settings.standardTax), Number(selected)]))
    .filter(v => Number.isFinite(v) && v >= 0);
  return values.map(v => `<option value="${escapeAttr(v)}"${Number(v)===Number(selected)?' selected':''}>${v}%</option>`).join('');
}


function normalizeLooseKey(value) {
  return katakanaToHiragana(String(value || ''))
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .trim()
    .toLowerCase();
}

function getUnitOptionsHtml(selected = '') {
  const current = String(selected || '').trim();
  const values = current && !UNIT_OPTIONS.includes(current) ? [...UNIT_OPTIONS, current] : UNIT_OPTIONS.slice();
  return values.map(value => `<option value="${escapeAttr(value)}"${value===current?' selected':''}>${escapeAttr(value)}</option>`).join('') +
    `<option value="${CUSTOM_UNIT_VALUE}">その他…</option>`;
}

function enableCustomUnitSelect(select, onChanged = null) {
  if (!select) return;
  const current = String(select.value || '').trim();
  select.innerHTML = getUnitOptionsHtml(current || '個');
  if (current) setSelectValueWithOption(select, current);
  select.addEventListener('change', () => {
    if (select.value !== CUSTOM_UNIT_VALUE) {
      onChanged?.();
      return;
    }
    const custom = window.prompt('単位を入力してね。', '');
    if (!custom || !custom.trim()) {
      select.value = current || '個';
      return;
    }
    const value = custom.trim();
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.insertBefore(option, select.querySelector(`option[value="${CUSTOM_UNIT_VALUE}"]`));
    select.value = value;
    onChanged?.();
  });
}

function suggestionValues(type) {
  const values = [];
  if (type === 'product' || type === 'type') {
    products.forEach(product => {
      if ((product.kind === 'type' ? 'type' : 'product') !== type) return;
      const name = String(product.name || '').trim();
      if (name) values.push(name);
    });
  } else if (type === 'store') {
    products.forEach(product => (product.stores || []).forEach(row => {
      const name = String(row.store || '').trim();
      if (name) values.push(name);
    }));
  }
  const seen = new Set();
  return values.filter(value => {
    const key = normalizeLooseKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a,b)=>a.localeCompare(b,'ja',{sensitivity:'base',numeric:true}));
}

function hideSmartSuggestions() {
  const box = $('smartSuggestionBox');
  if (box) {
    try { if (box.matches(':popover-open')) box.hidePopover(); } catch {}
    box.classList.add('hidden');
  }
  smartSuggestionState = null;
}

function showSmartSuggestions(input, type) {
  const box = $('smartSuggestionBox');
  if (!box || !input || document.activeElement !== input) return;
  const query = normalizeLooseKey(input.value);
  if (!query) return hideSmartSuggestions();
  const candidates = suggestionValues(type)
    .filter(value => normalizeLooseKey(value).includes(query))
    .sort((a,b) => {
      const ak = normalizeLooseKey(a), bk = normalizeLooseKey(b);
      const ap = ak.startsWith(query) ? 0 : 1, bp = bk.startsWith(query) ? 0 : 1;
      return ap-bp || ak.length-bk.length || a.localeCompare(b,'ja');
    }).slice(0,8);
  if (!candidates.length) return hideSmartSuggestions();
  box.innerHTML = '';
  candidates.forEach(value => {
    const button = document.createElement('button');
    button.type='button'; button.className='smart-suggestion-item'; button.textContent=value;
    button.addEventListener('mousedown', e => e.preventDefault());
    button.addEventListener('click', () => {
      input.value = value;
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
      hideSmartSuggestions();
      try { input.focus({preventScroll:true}); } catch { input.focus(); }
    });
    box.appendChild(button);
  });
  const hostDialog = input.closest('dialog');
  if (hostDialog && box.parentElement !== hostDialog) hostDialog.appendChild(box);
  else if (!hostDialog && box.parentElement !== document.body) document.body.appendChild(box);
  const rect = input.getBoundingClientRect();
  const boxWidth = Math.min(360, Math.max(220, rect.width));
  const preferredTop = rect.bottom + 4;
  const roomBelow = window.innerHeight - preferredTop;
  const top = roomBelow >= 150 ? preferredTop : Math.max(6, rect.top - 174);
  box.style.left = `${Math.max(6, Math.min(rect.left, window.innerWidth - boxWidth - 6))}px`;
  box.style.top = `${top}px`;
  box.style.width = `${boxWidth}px`;
  box.classList.remove('hidden');
  try {
    if (typeof box.showPopover === 'function' && !box.matches(':popover-open')) box.showPopover();
  } catch {}
  smartSuggestionState = {input,type};
}

function bindSmartSuggestion(input, type) {
  if (!input || input.dataset.smartSuggestBound === '1') return;
  input.dataset.smartSuggestBound='1';
  input.addEventListener('input', () => showSmartSuggestions(input,type));
  input.addEventListener('focus', () => { if (input.value.trim()) showSmartSuggestions(input,type); });
  input.addEventListener('blur', () => setTimeout(() => { if (smartSuggestionState?.input===input) hideSmartSuggestions(); },120));
}

function findExistingProductLoose(kind, name) {
  const key = normalizeLooseKey(name);
  if (!key) return null;
  return products.find(product => (product.kind==='type'?'type':'product')===kind && normalizeLooseKey(product.name)===key) || null;
}

function findStoreRowLoose(product, storeName) {
  const key = normalizeLooseKey(storeName);
  if (!key || !product) return null;
  const rows = (product.stores || []).filter(row => normalizeLooseKey(row.store)===key);
  if (!rows.length) return null;
  return rows.slice().sort((a,b)=>(Date.parse(b.updatedAt||'')||0)-(Date.parse(a.updatedAt||'')||0))[0];
}

function mergeStoreIntoProduct(product, source, {kind='product', amount='', unit='', defaultTax=settings.reducedTax, savedAt=new Date().toISOString()}={}) {
  const storeName = String(source.store || '').trim();
  if (!storeName) return {added:false, overwritten:false};
  let target = findStoreRowLoose(product, storeName);
  const nextPrice = source.price ?? '';
  const oldPrice = target ? Number(target.price) : null;
  if (!target) {
    target = { id:makeId('s'), store:storeName, productInfo:'', price:'', priceType:settings.defaultPriceType, tax:defaultTax,
      couponType:'none', couponValue:'', amount:kind==='type'?'':amount, unit:kind==='type'?'個':unit, updatedAt:savedAt };
    product.stores = Array.isArray(product.stores) ? product.stores : [];
    product.stores.push(target);
  }
  const overwritten = !!findStoreRowLoose(product, storeName) && target.price !== '';
  target.store = storeName;
  target.productInfo = kind==='type' ? String(source.productInfo || '').trim() : '';
  target.price = nextPrice;
  target.priceType = source.priceType === 'inc' ? 'inc' : 'ex';
  target.tax = Number.isFinite(Number(source.tax)) ? Number(source.tax) : Number(defaultTax);
  target.amount = kind==='type' ? (Number(source.amount)>0 ? Number(source.amount) : '') : amount;
  target.unit = kind==='type' ? String(source.unit || '個') : unit;
  target.updatedAt = savedAt;
  if (Number.isFinite(oldPrice) && nextPrice !== '' && Number(oldPrice) !== Number(nextPrice)) {
    product.history = Array.isArray(product.history) ? product.history : [];
    product.history.unshift({id:makeId('h'),updatedAt:savedAt,store:storeName,beforePrice:Number(oldPrice),afterPrice:Number(nextPrice)});
    product.history = product.history.slice(0,20);
  }
  const key = normalizeLooseKey(storeName);
  product.stores = product.stores.filter(row => row===target || normalizeLooseKey(row.store)!==key);
  return {added: oldPrice===null, overwritten: oldPrice!==null};
}

function duplicateStoreNames(rows = []) {
  const counts = new Map();
  rows.forEach(row => {
    const key = normalizeLooseKey(row.store);
    if (!key) return;
    const item = counts.get(key) || {name:String(row.store||'').trim(), count:0};
    item.count += 1; counts.set(key,item);
  });
  return [...counts.values()].filter(item=>item.count>1).map(item=>item.name);
}

function collapseDuplicateStores(rows = []) {
  const map = new Map();
  rows.forEach((row,index) => {
    const key = normalizeLooseKey(row.store) || `__${index}`;
    if (!map.has(key)) map.set(key,row);
    else {
      const prev = map.get(key);
      const prevTime = Date.parse(prev.updatedAt||'') || 0;
      const nextTime = Date.parse(row.updatedAt||'') || 0;
      if (nextTime >= prevTime || row.price !== '') map.set(key,row);
    }
  });
  return [...map.values()];
}

function setupInputExperience() {
  const updateViewport = () => {
    const h = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty('--visual-viewport-height', `${h}px`);
  };
  updateViewport();
  window.visualViewport?.addEventListener('resize', updateViewport);
  window.visualViewport?.addEventListener('scroll', updateViewport);

  document.addEventListener('focusin', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!input.matches('.dialog input, .shelf-compare-view input, .product-detail input')) return;
    if (['checkbox','radio','file','date','datetime-local','time'].includes(input.type)) return;
    const pointerFocused = input.dataset.pointerFocused === '1';
    input.dataset.pointerFocused = '0';
    if (!pointerFocused && input.value) requestAnimationFrame(() => { try { input.select(); } catch {} });
    setTimeout(() => input.scrollIntoView({block:'center',behavior:'smooth'}), 120);
  });
  document.addEventListener('pointerdown', event => {
    const input = event.target;
    if (input instanceof HTMLInputElement && document.activeElement===input) input.dataset.pointerFocused='1';
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const el = event.target;
    if (!(el instanceof HTMLInputElement) || !el.matches('.dialog input')) return;
    if (['checkbox','radio','file'].includes(el.type)) return;
    const scope = el.closest('dialog') || document;
    const focusables = [...scope.querySelectorAll('input:not([disabled]):not([type=hidden]), select:not([disabled]), button:not([disabled])')]
      .filter(node => node.offsetParent !== null && !node.classList.contains('st-delete'));
    const i = focusables.indexOf(el);
    const next = focusables.slice(i+1).find(node => node.tagName==='INPUT' || node.tagName==='SELECT');
    if (next) { event.preventDefault(); next.focus(); }
  });
  document.querySelectorAll('.dialog input:not([type=hidden])').forEach((input,i,all) => input.setAttribute('enterkeyhint', i===all.length-1?'done':'next'));
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
  const duplicateNames = duplicateStoreNames(draft.stores || []);
  if (duplicateNames.length) {
    const ok = window.confirm(`同じ店舗が重複しています。
${duplicateNames.map(name=>`・${name}`).join('\n')}

登録済みの店舗情報を上書きして1件にまとめますか？`);
    if (!ok) return;
    draft.stores = collapseDuplicateStores(draft.stores || []);
  }
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

  updateViewJumpButtons();
  document.body.classList.toggle('focus-mode', !!openProductId && !storePurchaseMode && !shelfCompareMode);

  $('storePurchaseView').classList.toggle('hidden', !storePurchaseMode);
  $('shelfCompareView').classList.toggle('hidden', !shelfCompareMode);
  $('productList').classList.toggle('hidden', storePurchaseMode || shelfCompareMode);
  $('searchInput').closest('.searchbar').classList.toggle('hidden', storePurchaseMode || shelfCompareMode);
  $('btnBulkStore').classList.toggle('hidden', storePurchaseMode || shelfCompareMode);
  const productListHead = $('productListHead');
  if (productListHead) productListHead.classList.toggle('hidden', storePurchaseMode || shelfCompareMode);

  if (storePurchaseMode) {
    $('emptyState').classList.add('hidden');
    $('bulkStoreBar').classList.add('hidden');
    renderStorePurchaseView();
    return;
  }

  if (shelfCompareMode) {
    $('emptyState').classList.add('hidden');
    $('bulkStoreBar').classList.add('hidden');
    renderShelfCompare();
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
    const productListMeta = displayProduct.kind === 'type'
      ? '種類比較'
      : (() => {
          const amount = Number(displayProduct.amount);
          const unit = String(displayProduct.unit || '').trim();
          return amount > 0 && unit ? `${fmt(amount)}${unit}` : '容量未設定';
        })();
    node.querySelector('.product-size').textContent = productListMeta;
    node.querySelector('.product-size').title = productListMeta;

    const bestWrap = node.querySelector('.best-wrap');
    const bestPrice = node.querySelector('.best-price');
    const bestStoreName = node.querySelector('.best-store-name');
    const bestLowSlot = node.querySelector('.best-low-slot');
    if (bests.before) {
      const baseCalc = bests.before.calc;
      bestPrice.textContent = `${fmtCalc(baseCalc.grossBefore)}円`;
      bestStoreName.textContent = String(bests.before.row.store || '').trim() || '店舗未入力';
      bestStoreName.title = bestStoreName.textContent;
      bestWrap.classList.remove('no-best');
      bestLowSlot?.classList.remove('is-hidden');
      node.classList.add('has-best');
    } else {
      bestPrice.textContent = '価格未登録';
      bestStoreName.textContent = '';
      bestStoreName.removeAttribute('title');
      bestWrap.classList.add('no-best');
      bestLowSlot?.classList.add('is-hidden');
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

      const storeTable = node.querySelector('.store-table');
      storeTable?.classList.toggle('is-type', draft.kind === 'type');
      node.querySelector('.store-mobile-head')?.classList.toggle('hidden', !draft.stores.length);

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

function normalizeNumericInputText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/,/g, '')
    .replace(/\s*(?:円|%)\s*$/, '')
    .trim();
}

function bindInputUnitSuffix(input, unitSource) {
  if (!input) return () => {};
  const wrap = input.closest('.unit-input');
  const suffix = wrap?.querySelector('.input-unit-suffix');
  if (suffix) suffix.textContent = '';

  const getUnit = () => {
    const unit = typeof unitSource === 'function' ? unitSource() : unitSource;
    return String(unit || '').trim();
  };
  const showUnit = () => {
    const raw = normalizeNumericInputText(input.value);
    const unit = getUnit();
    input.value = raw && unit && !input.disabled ? `${raw} ${unit}` : raw;
    wrap?.classList.toggle('has-value', !!(raw && unit && !input.disabled));
  };
  const hideUnit = () => {
    input.value = normalizeNumericInputText(input.value);
    wrap?.classList.remove('has-value');
  };
  const refresh = () => {
    if (document.activeElement === input) hideUnit();
    else showUnit();
  };

  input.addEventListener('focus', hideUnit);
  input.addEventListener('input', hideUnit);
  input.addEventListener('blur', showUnit);
  refresh();
  return refresh;
}

function renderStoreRow(product, row, bestFlags = {before:false, after:false}) {
  const el = storeTemplate.content.firstElementChild.cloneNode(true);
  const bestMark = el.querySelector('.best-mark');
  applyBestFlags(el, bestMark, bestFlags);

  const store = el.querySelector('.st-store');
  const productInfo = el.querySelector('.st-product-info');
  const price = el.querySelector('.st-price');
  const priceType = el.querySelector('.st-price-type');
  const tax = el.querySelector('.st-tax');
  const amount = el.querySelector('.st-amount');
  const unitSelect = el.querySelector('.st-unit-select');
  const quantityFields = el.querySelector('.st-quantity-fields');
  const priceResultOut = el.querySelector('.st-price-result');
  const unitOut = el.querySelector('.st-unit');

  store.value = row.store ?? '';
  bindSmartSuggestion(store, 'store');
  productInfo.value = row.productInfo ?? '';
  price.value = row.price ?? '';
  priceType.value = row.priceType === 'inc' ? 'inc' : 'ex';
  tax.innerHTML = taxOptions(row.tax ?? product.defaultTax);
  const refreshPriceUnit = bindInputUnitSuffix(price, '円');

  const isType = product.kind === 'type';
  quantityFields.classList.toggle('hidden', !isType);
  productInfo.classList.toggle('hidden', !isType);
  if (isType) {
    amount.value = Number(row.amount) > 0 ? row.amount : (product.amount || 1);
    setSelectValueWithOption(unitSelect, row.unit || product.unit || '個');
    enableCustomUnitSelect(unitSelect, sync);
  }

  function updateOutputs() {
    refreshPriceUnit();
    const calc = calcRow(product, row);
    if (calc) {
      priceResultOut.textContent = `${fmtCalc(calc.grossBefore)}円`;
      unitOut.textContent = `${fmtCalc(calc.beforeUnit)}円/${(product.kind === 'type' ? (row.unit || product.unit) : product.unit) || '個'}`;
    } else {
      priceResultOut.textContent = '-';
      unitOut.textContent = '-';
    }
  }

  function sync() {
    row.store = store.value.trim();
    row.productInfo = isType ? productInfo.value.trim() : '';
    row.price = numberOrBlank(price.value);
    row.priceType = priceType.value;
    row.tax = Number(tax.value);
    if (isType) {
      row.amount = numberOrBlank(amount.value);
      row.unit = unitSelect.value || product.unit || '個';
    }
    markProductEditDirty();
    updateOutputs();
    refreshBestOnly(product.id);
  }

  [store, productInfo, price, priceType, tax, amount, unitSelect].forEach(ctrl => {
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
  const bestStoreName = card.querySelector('.best-store-name');
  const bestLowSlot = card.querySelector('.best-low-slot');

  if (hasBest) {
    bestPrice.textContent = `${fmtCalc(bests.before.calc.grossBefore)}円`;
    if (bestStoreName) {
      bestStoreName.textContent = String(bests.before.row.store || '').trim() || '店舗未入力';
      bestStoreName.title = bestStoreName.textContent;
    }
    bestLowSlot?.classList.remove('is-hidden');
    bestWrap?.classList.remove('no-best');
  } else {
    bestPrice.textContent = '価格未登録';
    if (bestStoreName) {
      bestStoreName.textContent = '';
      bestStoreName.removeAttribute('title');
    }
    bestLowSlot?.classList.add('is-hidden');
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
        ? `${fmtCalc(calc.grossBefore)}円`
        : '-';
    }
    if (unitOut) {
      unitOut.textContent = calc
        ? `${fmtCalc(calc.beforeUnit)}円/${(product.kind === 'type' ? (row.unit || product.unit) : product.unit) || '個'}`
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
  return {
    grossBefore,
    netBefore,
    afterTotal: grossBefore,
    beforeUnit: grossBefore / amount,
    afterUnit: grossBefore / amount
  };
}

function getBests(product) {
  let before = null;
  product.stores.forEach(row => {
    const calc = calcRow(product, row);
    if (!calc) return;
    if (!before || calc.beforeUnit < before.calc.beforeUnit) {
      before = { row, store: row.store, calc, unit: product.kind === 'type' ? (row.unit || product.unit) : product.unit };
    }
  });
  return { before, after: null };
}

function createPriceBadge(_kind = 'low', compact = false) {
  const badge = document.createElement('span');
  badge.className = `price-badge badge-low${compact ? ' mini-badge' : ''}`;
  const icon = document.createElement('span');
  icon.className = 'badge-icon';
  icon.textContent = '♛';
  badge.append(icon, document.createTextNode('最安'));
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
}

function applyBestFlags(rowEl, markEl, flags) {
  if (!markEl) return;
  markEl.innerHTML = '';
  if (flags.before) markEl.appendChild(createPriceBadge('low', true));
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

function currentMainView() {
  if (shelfCompareMode) return 'shelf';
  if (storePurchaseMode) return 'shopping';
  return 'products';
}

function updateViewJumpButtons() {
  const current = currentMainView();
  const buttons = {
    products: $('btnProductList'),
    shopping: $('btnStorePurchase'),
    shelf: $('btnShelfCompare')
  };
  Object.entries(buttons).forEach(([view, button]) => {
    if (!button) return;
    const active = view === current;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
}

function hasShelfCompareUnsavedInput() {
  return shelfCompareDirty;
}

function discardShelfCompareDraft() {
  shelfCompareRows = [makeShelfCompareRow({ selected:true })];
  shelfCompareCommon = { priceType: settings.defaultPriceType, tax: settings.reducedTax };
  shelfCompareSeedKey = '';
  shelfCompareDirty = false;
  shelfChoiceDialogMode = null;
  const typeInput = $('shelfCompareType');
  const storeInput = $('shelfCompareStore');
  if (typeInput) typeInput.value = '';
  if (storeInput) storeInput.value = '';
  const choiceDialog = $('shelfChoiceDialog');
  if (choiceDialog?.open) choiceDialog.close();
}

function confirmLeaveCurrentView(targetView) {
  if (targetView === currentMainView()) return true;
  if (!confirmDiscardProductEdit()) return false;
  if (storePurchaseMode && shoppingMemoEditStore) {
    const ok = window.confirm('買い物メモで保存していない価格・容量の変更があります。編集内容を破棄して移動しますか？');
    if (!ok) return false;
    shoppingMemoEditStore = null;
    shoppingMemoEditDraft = null;
  }
  if (shelfCompareMode && hasShelfCompareUnsavedInput()) {
    const ok = window.confirm('売り場比較に未反映の編集があります。編集内容を破棄して移動しますか？');
    if (!ok) return false;
    discardShelfCompareDraft();
  }
  return true;
}

function showShelfCompareLoadError(error) {
  console.error('PriceLog shelf compare error:', error);
  const box = $('shelfCompareError');
  if (box) {
    box.textContent = '売り場比較の読み込みで問題が発生しました。入力欄は開いたままにしています。';
    box.classList.remove('hidden');
  }
}

function hideShelfCompareLoadError() {
  const box = $('shelfCompareError');
  if (box) box.classList.add('hidden');
}

function forceShelfCompareVisible() {
  storePurchaseMode = false;
  shelfCompareMode = true;
  $('storePurchaseView')?.classList.add('hidden');
  $('shelfCompareView')?.classList.remove('hidden');
  $('productList')?.classList.add('hidden');
  $('searchInput')?.closest('.searchbar')?.classList.add('hidden');
  $('btnBulkStore')?.classList.add('hidden');
  $('productListHead')?.classList.add('hidden');
  $('emptyState')?.classList.add('hidden');
  $('bulkStoreBar')?.classList.add('hidden');
  updateViewJumpButtons();
}

function switchMainView(targetView) {
  if (!['products','shopping','shelf'].includes(targetView)) return;
  if (!confirmLeaveCurrentView(targetView)) return;

  storePurchaseMode = targetView === 'shopping';
  shelfCompareMode = targetView === 'shelf';
  if (targetView !== 'products') {
    openProductId = null;
    productEditDraft = null;
    productEditDirty = false;
    bulkMode = false;
    bulkSelected.clear();
  }

  if (targetView !== 'shopping') {
    openStoreName = null;
    const search = $('storePurchaseSearch');
    if (search) search.value = '';
  }
  $('bulkStoreBar')?.classList.toggle('hidden', !bulkMode);

  if (targetView === 'shelf') {
    // 先に画面だけ切り替える。候補生成や旧データ読込で例外が出ても遷移を止めない。
    forceShelfCompareVisible();
    hideShelfCompareLoadError();
    try {
      if (!shelfCompareRows.length) addShelfCompareRow(false);
      updateShelfCompareSuggestions();
      syncShelfCompareExistingRows();
      render();
    } catch (error) {
      forceShelfCompareVisible();
      showShelfCompareLoadError(error);
      // 最低限、比較行を1行だけ表示できる状態に戻す。
      try {
        if (!shelfCompareRows.length) shelfCompareRows = [makeShelfCompareRow({ selected:true })];
        renderShelfCompare();
      } catch (secondaryError) {
        console.error('PriceLog shelf compare fallback error:', secondaryError);
      }
    }
    return;
  }

  hideShelfCompareLoadError();
  render();
}
function setShelfCompareMode(enabled) {
  switchMainView(enabled ? 'shelf' : 'products');
}

function makeShelfCompareRow(overrides = {}) {
  return {
    id: makeId('sc'),
    productInfo: '',
    price: '',
    amount: '',
    unit: 'g',
    selected: false,
    existing: false,
    sourceProductId: '',
    sourceStoreRowId: '',
    ...overrides
  };
}

function addShelfCompareRow(shouldRender = true) {
  const hasSelected = shelfCompareRows.some(row => row.selected);
  shelfCompareRows.push(makeShelfCompareRow({ selected: !hasSelected }));
  if (shouldRender) {
    shelfCompareDirty = true;
    renderShelfCompare();
  }
}

function shelfCompareKey(typeName, storeName) {
  return `${normalizeMergeText(typeName)}|${normalizeMergeText(storeName)}`;
}

function findShelfCompareTypeProduct(typeName) {
  const typeKey = normalizeMergeText(typeName);
  if (!typeKey) return null;
  return products.find(p => p.kind === 'type' && (
    normalizeMergeText(p.name) === typeKey ||
    normalizeMergeText(p.nameCandidates?.type) === typeKey
  )) || null;
}

function getShelfCompareTypeChoices() {
  const seen = new Set();
  const names = [];
  for (const product of Array.isArray(products) ? products : []) {
    if (!product || product.kind !== 'type') continue;
    const name = String(product.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b, 'ja'));
}

function getShelfCompareStoreChoices() {
  const seen = new Set();
  const stores = [];
  // 種類に関係なく、全商品に登録されている店舗を候補にする。
  for (const product of Array.isArray(products) ? products : []) {
    const rows = Array.isArray(product?.stores) ? product.stores : [];
    for (const row of rows) {
      const name = String(row?.store || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      stores.push(name);
    }
  }
  return stores.sort((a, b) => a.localeCompare(b, 'ja'));
}

function updateShelfCompareSuggestions() {
  // Ver.0.81では候補を別ウィンドウで表示するため、入力中の再生成は不要。
}

let shelfChoiceDialogMode = null;

function openShelfChoiceDialog(mode) {
  const dialog = $('shelfChoiceDialog');
  const list = $('shelfChoiceDialogList');
  const empty = $('shelfChoiceDialogEmpty');
  const title = $('shelfChoiceDialogTitle');
  if (!dialog || !list || !empty || !title) return;

  shelfChoiceDialogMode = mode === 'store' ? 'store' : 'type';
  const choices = shelfChoiceDialogMode === 'store'
    ? getShelfCompareStoreChoices()
    : getShelfCompareTypeChoices();

  title.textContent = shelfChoiceDialogMode === 'store' ? '店舗を選択' : '比較する種類を選択';
  list.innerHTML = '';
  empty.classList.toggle('hidden', choices.length > 0);
  empty.textContent = shelfChoiceDialogMode === 'store'
    ? '登録済みの店舗はありません。'
    : '登録済みの種類はありません。';

  choices.forEach(value => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'shelf-choice-option';
    button.textContent = value;
    button.addEventListener('click', () => applyShelfChoice(value));
    list.appendChild(button);
  });

  if (!dialog.open) dialog.showModal();
}

function closeShelfChoiceDialog() {
  const dialog = $('shelfChoiceDialog');
  if (dialog?.open) dialog.close();
  shelfChoiceDialogMode = null;
}

function applyShelfChoice(value) {
  const input = shelfChoiceDialogMode === 'store' ? $('shelfCompareStore') : $('shelfCompareType');
  if (!input) return closeShelfChoiceDialog();

  // 既存の入力をいったんクリアしてから、選択した内容で置き換える。
  input.value = '';
  input.value = String(value || '');
  shelfCompareDirty = true;
  shelfCompareSeedKey = '';
  closeShelfChoiceDialog();
  syncShelfCompareExistingRows();
  renderShelfCompare();
  input.focus();
}

function getShelfCompareExistingRows(typeName, storeName) {
  const storeKey = normalizeMergeText(storeName);
  if (!storeKey) return [];

  const product = findShelfCompareTypeProduct(typeName);
  if (!product) return [];

  const matches = (Array.isArray(product.stores) ? product.stores : [])
    .filter(row => normalizeMergeText(row?.store) === storeKey)
    .slice()
    .sort((a, b) => {
      const at = Date.parse(a.updatedAt || '') || 0;
      const bt = Date.parse(b.updatedAt || '') || 0;
      return bt - at;
    });
  const row = matches[0];
  if (!row) return [];

  return [makeShelfCompareRow({
    id: `existing_${row.id}`,
    productInfo: String(row.productInfo || ''),
    price: row.price ?? '',
    amount: row.amount ?? '',
    unit: row.unit || product.unit || '個',
    selected: true,
    existing: true,
    sourceProductId: product.id,
    sourceStoreRowId: row.id,
    sourceUpdatedAt: row.updatedAt || ''
  })];
}

function syncShelfCompareCommonFromExistingRow(existingRow) {
  if (!existingRow) return false;
  const sourceProduct = products.find(p => p.id === existingRow.sourceProductId);
  const sourceRow = (Array.isArray(sourceProduct?.stores) ? sourceProduct.stores : [])
    .find(row => row.id === existingRow.sourceStoreRowId);
  if (!sourceRow) return false;

  // 登録済みの価格条件をそのまま比較欄へ読み込み、未操作のまま反映した際に
  // 税込/税抜・税率だけが意図せず書き換わらないようにする。
  shelfCompareCommon.priceType = sourceRow.priceType === 'inc' ? 'inc' : 'ex';
  const registeredTax = Number(sourceRow.tax);
  shelfCompareCommon.tax = Number.isFinite(registeredTax) ? registeredTax : settings.reducedTax;
  return true;
}

function syncShelfCompareExistingRows() {
  updateShelfCompareSuggestions();
  const typeName = $('shelfCompareType').value.trim();
  const storeName = $('shelfCompareStore').value.trim();
  const key = shelfCompareKey(typeName, storeName);
  if (key === shelfCompareSeedKey) return;

  const manualRows = shelfCompareRows.filter(row => !row.existing);
  const existingRows = getShelfCompareExistingRows(typeName, storeName);
  if (existingRows.length) manualRows.forEach(row => { row.selected = false; });
  else if (manualRows.length && !manualRows.some(row => row.selected)) manualRows[0].selected = true;
  shelfCompareSeedKey = key;

  if (existingRows.length) syncShelfCompareCommonFromExistingRow(existingRows[0]);

  shelfCompareRows = [...existingRows, ...manualRows];
  if (!shelfCompareRows.length) shelfCompareRows = [makeShelfCompareRow({ selected:true })];
}

function clearShelfCompare() {
  if (shelfCompareRows.some(r => r.productInfo || r.price !== '' || r.amount !== '') && !window.confirm('売り場比較の入力内容をクリアしますか？')) return;
  shelfCompareRows = [makeShelfCompareRow({ selected:true })];
  shelfCompareCommon = { priceType: settings.defaultPriceType, tax: settings.reducedTax };
  shelfCompareSeedKey = '';
  $('shelfCompareType').value = '';
  $('shelfCompareStore').value = '';
  shelfCompareDirty = false;
  updateShelfCompareSuggestions();
  renderShelfCompare();
}

function shelfCompareCalc(row) {
  const price = Number(row.price), amount = Number(row.amount), tax = Number(shelfCompareCommon.tax);
  if (!(price >= 0) || row.price === '' || !(amount > 0)) return null;
  const safeTax = Number.isFinite(tax) ? tax : 0;
  const gross = shelfCompareCommon.priceType === 'inc' ? price : price * (1 + safeTax / 100);
  const net = shelfCompareCommon.priceType === 'ex' ? price : price / (1 + safeTax / 100);
  const basisPrice = shelfCompareCommon.priceType === 'inc' ? gross : net;
  return { gross, net, basisPrice, unitPrice: basisPrice / amount };
}

function upsertShelfCompareRow(row, typeName, storeName, now) {
  if (!shelfCompareCalc(row)) return { changed:false, added:false };

  let product = findShelfCompareTypeProduct(typeName);
  if (!product) {
    product = {
      id: makeId('p'), kind:'type', name:typeName,
      nameCandidates:{product:'',type:typeName}, reading:makeReadingCandidate(typeName)||'',
      amount:'', unit:'', defaultTax:Number(shelfCompareCommon.tax), updatedAt:now, history:[], stores:[]
    };
    products.push(product);
  }

  let storeRow = row.sourceStoreRowId ? product.stores.find(item => item.id === row.sourceStoreRowId) : null;
  if (!storeRow) {
    const storeKey = normalizeMergeText(storeName);
    const matches = product.stores
      .filter(item => normalizeMergeText(item.store) === storeKey)
      .slice()
      .sort((a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0));
    storeRow = matches[0] || null;
  }
  const nextPrice = Number(row.price);
  const nextAmount = Number(row.amount);
  const nextUnit = row.unit || '個';
  const nextInfo = String(row.productInfo || '').trim();
  const nextPriceType = shelfCompareCommon.priceType === 'inc' ? 'inc' : 'ex';
  const nextTax = Number(shelfCompareCommon.tax);

  if (storeRow) {
    const storeKey = normalizeMergeText(storeName);
    const duplicateCount = product.stores.filter(item => normalizeMergeText(item.store) === storeKey).length;
    const beforePrice = Number(storeRow.price);
    const changed = String(storeRow.store || '') !== storeName ||
      String(storeRow.productInfo || '') !== nextInfo || Number(storeRow.price) !== nextPrice ||
      Number(storeRow.amount) !== nextAmount || String(storeRow.unit || '') !== nextUnit ||
      storeRow.priceType !== nextPriceType || Number(storeRow.tax) !== nextTax;
    if (!changed && duplicateCount <= 1) return { changed:false, added:false };

    if (changed && Number.isFinite(beforePrice) && beforePrice !== nextPrice) {
      product.history = Array.isArray(product.history) ? product.history : [];
      product.history.unshift({ id:makeId('h'), updatedAt:now, store:storeName, beforePrice, afterPrice:nextPrice });
      product.history = product.history.slice(0,20);
    }
    Object.assign(storeRow, {
      store:storeName, productInfo:nextInfo, price:nextPrice, priceType:nextPriceType,
      tax:nextTax, couponType:'none', couponValue:'', amount:nextAmount, unit:nextUnit, updatedAt:now
    });
    // 種類比較では同じ店舗の登録情報は1件に統一し、最新内容で上書きする。
    product.stores = product.stores.filter(item => item === storeRow || normalizeMergeText(item.store) !== storeKey);
    product.updatedAt = now;
    return { changed:true, added:false };
  }

  // 既存店舗がない場合だけ新規追加する。
  product.stores.push({
    id:makeId('s'), store:storeName, productInfo:nextInfo, price:nextPrice,
    priceType:nextPriceType, tax:nextTax, couponType:'none', couponValue:'',
    amount:nextAmount, unit:nextUnit, updatedAt:now
  });
  product.updatedAt = now;
  return { changed:true, added:true };
}

function registerSelectedShelfCompareRows() {
  const typeName = $('shelfCompareType').value.trim();
  const storeName = $('shelfCompareStore').value.trim();
  if (!typeName) return alert('比較する種類を入力してね。');
  if (!storeName) return alert('店舗を入力してね。');

  const selected = shelfCompareRows.filter(row => row.selected);
  if (!selected.length) return alert('商品一覧に反映する商品を1つ選択してね。');
  if (selected.length > 1) return alert('反映できる商品は1つだけです。');
  const selectedRow = selected[0];
  if (!shelfCompareCalc(selectedRow)) return alert('選択した商品の価格と容量を入力してね。');

  const now = new Date().toISOString();
  const result = upsertShelfCompareRow(selectedRow, typeName, storeName, now);

  products = normalizeProductsData(products);
  persistNow();

  // 選んだ比較候補は登録済みデータへ昇格させ、一覧上も最新の登録内容へ即時更新する。
  const remainingManualRows = shelfCompareRows.filter(row => !row.existing && row.id !== selectedRow.id);
  remainingManualRows.forEach(row => { row.selected = false; });
  shelfCompareRows = remainingManualRows;
  shelfCompareSeedKey = '';
  syncShelfCompareExistingRows();
  shelfCompareDirty = false;
  renderShelfCompare();
  render();
  showSaveToast(result.added ? '商品一覧へ登録しました' : '登録情報を最新内容に更新しました');
}

function renderShelfCompare() {
  const container = $('shelfCompareList');
  if (!container) return;
  syncShelfCompareExistingRows();

  const priceType = $('shelfComparePriceType');
  const tax = $('shelfCompareTax');
  priceType.value = shelfCompareCommon.priceType === 'inc' ? 'inc' : 'ex';
  tax.innerHTML = taxOptions(shelfCompareCommon.tax);
  tax.value = String(shelfCompareCommon.tax);

  container.innerHTML = '';
  if (!shelfCompareRows.length) shelfCompareRows = [makeShelfCompareRow({ selected:true })];
  const valid = shelfCompareRows.map(r => ({r, calc:shelfCompareCalc(r)})).filter(x => x.calc);
  const best = valid.length ? Math.min(...valid.map(x => x.calc.unitPrice)) : null;

  const head = $('shelfUnitPriceHead');
  if (head) head.textContent = shelfCompareCommon.priceType === 'inc' ? '税込単価' : '税抜単価';

  shelfCompareRows.forEach((row, index) => {
    const calc = shelfCompareCalc(row);
    const isBest = !!(calc && best !== null && Math.abs(calc.unitPrice-best) < 1e-9);
    const line = document.createElement('div');
    line.className = 'shelf-compare-row shelf-compare-item' + (isBest ? ' is-best' : '') + (row.existing ? ' is-existing' : '');
    line.dataset.rowId = row.id;
    line.innerHTML = `
      <span class="shelf-select-cell"><input class="sc-select" type="checkbox" aria-label="商品一覧へ反映"></span>
      <span class="shelf-info-cell"><input class="sc-info" type="text" maxlength="80" aria-label="商品情報" placeholder="メーカーなど">${row.existing ? '<small class="shelf-existing-label">登録済み</small>' : ''}</span>
      <span class="shelf-amount-cell"><span class="unit-input shelf-amount-input-wrap"><input class="sc-amount" type="text" inputmode="decimal" aria-label="容量"><span class="input-unit-suffix"></span></span><select class="sc-unit" aria-label="単位"></select></span>
      <span class="unit-input shelf-price-cell"><input class="sc-price" type="text" inputmode="decimal" aria-label="価格"><span class="input-unit-suffix">円</span></span>
      <span class="shelf-unit-price">${calc ? `${isBest ? '<b>最安</b>' : ''}<strong>${fmtCalc(calc.unitPrice)}</strong><small>円/${escapeAttr(row.unit||'個')}</small>` : '-'}</span>
      ${row.existing ? '<span class="shelf-delete-placeholder" aria-hidden="true"></span>' : '<button class="st-delete shelf-delete" type="button" aria-label="比較商品を削除">×</button>'}`;

    const selected = line.querySelector('.sc-select');
    const info = line.querySelector('.sc-info');
    const price = line.querySelector('.sc-price');
    const amount = line.querySelector('.sc-amount');
    const unit = line.querySelector('.sc-unit');
    const del = line.querySelector('.shelf-delete');
    selected.checked = row.selected !== false;
    info.value = row.productInfo || '';
    price.value = row.price ?? '';
    amount.value = row.amount ?? '';
    setSelectValueWithOption(unit, row.unit || 'g');
    enableCustomUnitSelect(unit);
    const refreshAmountUnit = bindInputUnitSuffix(amount, () => unit.value || row.unit || '個');
    bindInputUnitSuffix(price, '円');

    selected.addEventListener('change', () => {
      if (selected.checked) {
        shelfCompareRows.forEach(item => { item.selected = item.id === row.id; });
      } else {
        row.selected = false;
      }
      shelfCompareDirty = true;
      renderShelfCompare();
    });
    if (del) del.addEventListener('click', () => {
      const wasSelected = row.selected;
      shelfCompareRows = shelfCompareRows.filter(item => item.id !== row.id);
      if (!shelfCompareRows.length) {
        shelfCompareRows = [makeShelfCompareRow({ selected:true })];
      } else if (wasSelected && !shelfCompareRows.some(item => item.selected)) {
        shelfCompareRows[0].selected = true;
      }
      shelfCompareDirty = true;
      renderShelfCompare();
    });
    const keepDraft = () => {
      row.productInfo = info.value;
      row.price = numberOrBlank(price.value);
      row.amount = numberOrBlank(amount.value);
      row.unit = unit.value || '個';
      shelfCompareDirty = true;
      refreshShelfCompareResults();
    };
    [info, price, amount].forEach(control => {
      control.addEventListener('input', keepDraft);
      control.addEventListener('change', keepDraft);
    });
    unit.addEventListener('change', () => { refreshAmountUnit(); keepDraft(); });
    container.appendChild(line);
  });
}

function refreshShelfCompareResults() {
  const head = $('shelfUnitPriceHead');
  if (head) head.textContent = shelfCompareCommon.priceType === 'inc' ? '税込単価' : '税抜単価';
  const valid = shelfCompareRows.map(row => ({row,calc:shelfCompareCalc(row)})).filter(item=>item.calc);
  const best = valid.length ? Math.min(...valid.map(item=>item.calc.unitPrice)) : null;
  const container = $('shelfCompareList');
  if (!container) return;
  container.querySelectorAll('.shelf-compare-item').forEach(line => {
    const row = shelfCompareRows.find(item=>item.id===line.dataset.rowId);
    if (!row) return;
    const calc = shelfCompareCalc(row);
    const isBest = !!(calc && best!==null && Math.abs(calc.unitPrice-best)<1e-9);
    line.classList.toggle('is-best',isBest);
    const out = line.querySelector('.shelf-unit-price');
    if (out) out.innerHTML = calc ? `${isBest?'<b>最安</b>':''}<strong>${fmtCalc(calc.unitPrice)}</strong><small>円/${escapeAttr(row.unit||'個')}</small>` : '-';
  });
}

function setStorePurchaseMode(enabled) {
  switchMainView(enabled ? 'shopping' : 'products');
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
  const normalized = String(value || '').trim();
  select.innerHTML = `<option value=""></option>` + getUnitOptionsHtml(normalized);
  if (normalized) setSelectValueWithOption(select, normalized);
  select.addEventListener('change', () => {
    if (select.value === CUSTOM_UNIT_VALUE) {
      const custom = window.prompt('単位を入力してね。', '');
      if (!custom || !custom.trim()) {
        select.value = normalized || '';
        return;
      }
      const unit = custom.trim();
      const option = document.createElement('option');
      option.value = unit;
      option.textContent = unit;
      select.insertBefore(option, select.querySelector(`option[value="${CUSTOM_UNIT_VALUE}"]`));
      select.value = unit;
    }
    onChange(select.value);
  });
  return select;
}

function getStoreIllustrationCategory(storeName) {
  const name = String(storeName || '').normalize('NFKC').toLowerCase();
  const has = (...words) => words.some(word => name.includes(word));

  if (has('amazon','アマゾン','楽天','ネット','オンライン','通販')) return 'online';
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
    count.textContent = `予定${storeCheckedItems.length}品 / ${fmtCalc(storeTotal)}円（税込）`;

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
          count.textContent = `予定${checkedItems.length}品 / ${fmtCalc(checkedTotal)}円（税込）`;
          const resetButton = actions.querySelector('[data-shopping-reset]');
          if (resetButton) resetButton.disabled = checkedItems.length === 0;
        });

        const productName = document.createElement('span');
        productName.className = 'store-product-name';
        productName.textContent = item.product.name;
        productName.title = item.product.name;
        if (item.product.kind === 'type' && String(item.row.productInfo || '').trim()) {
          const info = document.createElement('small');
          info.className = 'store-product-info';
          info.textContent = item.row.productInfo;
          info.title = item.row.productInfo;
          productName.appendChild(info);
        }

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
          priceWrap.className = 'shopping-edit-price-wrap unit-input';
          const priceInput = document.createElement('input');
          priceInput.className = 'shopping-edit-price';
          priceInput.type = 'text';
          priceInput.inputMode = 'decimal';
          priceInput.value = edit.grossPrice === '' ? '' : fmtCalc(edit.grossPrice);
          priceInput.setAttribute('aria-label', `${item.product.name}の税込価格`);
          priceInput.addEventListener('input', () => {
            edit.grossPrice = normalizeNumericInputText(priceInput.value);
          });
          const yen = document.createElement('span');
          yen.className = 'input-unit-suffix';
          yen.textContent = '円';
          priceWrap.append(priceInput, yen);
          bindInputUnitSuffix(priceInput, '円');

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
          price.textContent = item.grossPrice !== null ? `${fmtCalc(item.grossPrice)}円` : '-';

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
      normalizeLooseKey(row.store) === normalizeLooseKey(storeName)
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

function normalizeProductNameKey(value) {
  return normalizeLooseKey(value);
}

function hasKanji(value) {
  return /[\u3400-\u4DBF\u4E00-\u9FFF]/.test(String(value || ''));
}


function findKnownReading(name) {
  const key = normalizeProductNameKey(name);
  if (!key) return '';
  for (const p of products) {
    if (normalizeProductNameKey(p?.name) === key && p?.reading) return normalizeReadingInput(p.reading);
  }
  return '';
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
  const previous = $('productKind').value;
  if (updateReading && (previous === 'product' || previous === 'type')) {
    productDialogReadings[previous] = $('productReading').value;
    productDialogReadingManual[previous] = readingWasManuallyEdited;
  }

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
  // 種類比較では内容量は店舗ごとに持つため、非表示の共通内容量を必須判定から外す。
  // required のままだとブラウザ標準バリデーションが submit 自体を止め、保存ボタンが無反応に見える。
  $('productAmount').required = productEnabled;

  if (updateReading && normalized) {
    const saved = productDialogReadings[normalized] || '';
    if (saved) {
      $('productReading').value = saved;
      readingWasManuallyEdited = !!productDialogReadingManual[normalized];
    } else {
      const candidate = makeReadingCandidate(getActiveProductNameValue());
      $('productReading').value = candidate || '';
      productDialogReadings[normalized] = candidate || '';
      productDialogReadingManual[normalized] = false;
      readingWasManuallyEdited = false;
    }
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
    productInfo: '',
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
  return !!String(row.store || '').trim() || row.price !== '' || Number(row.amount) > 0;
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
        <label>店舗<input class="qs-store" type="text" maxlength="40"></label>
        <label>価格<span class="unit-input"><input class="qs-price" type="text" inputmode="decimal"><span class="input-unit-suffix">円</span></span></label>
        <button class="qs-delete" type="button" aria-label="この店舗を削除">×</button>
      </div>
      <div class="quick-store-options">
        <label>税込/抜<select class="qs-price-type"><option value="inc">税込</option><option value="ex">税抜</option></select></label>
        <label>税率<select class="qs-tax">${taxOptions(row.tax)}</select></label>
      </div>
      <div class="quick-store-product-info ${kind === 'type' ? '' : 'hidden'}"><label>商品情報<input class="qs-product-info" type="text" maxlength="80"></label></div>
      <div class="quick-store-quantity ${kind === 'type' ? '' : 'hidden'}">
        <label>内容量<input class="qs-amount" type="text" inputmode="decimal"></label>
        <label>単位<select class="qs-unit"></select></label>
      </div>
      <div class="quick-store-result">税込価格・単価：<strong class="qs-result">-</strong></div>`;

    const store = card.querySelector('.qs-store');
    const productInfo = card.querySelector('.qs-product-info');
    const price = card.querySelector('.qs-price');
    const priceType = card.querySelector('.qs-price-type');
    const tax = card.querySelector('.qs-tax');
    const amount = card.querySelector('.qs-amount');
    const unit = card.querySelector('.qs-unit');
    const result = card.querySelector('.qs-result');

    store.value = row.store || '';
    bindSmartSuggestion(store, 'store');
    if (productInfo) productInfo.value = row.productInfo || '';
    price.value = row.price ?? '';
    priceType.value = row.priceType === 'inc' ? 'inc' : 'ex';
    tax.value = String(row.tax ?? settings.reducedTax);
    const refreshPriceUnit = bindInputUnitSuffix(price, '円');
    amount.value = Number(row.amount) > 0 ? row.amount : '';
    setSelectValueWithOption(unit, row.unit || '個');

    const update = () => {
      row.store = store.value.trim();
      row.productInfo = kind === 'type' && productInfo ? productInfo.value.trim() : '';
      row.price = numberOrBlank(price.value);
      row.priceType = priceType.value;
      row.tax = Number(tax.value);
      row.amount = numberOrBlank(amount.value);
      row.unit = unit.value || '個';
      refreshPriceUnit();
        const tempProduct = { kind: kind || 'product', amount: productAmount, unit: productUnit };
      const calc = calcRow(tempProduct, row);
      result.textContent = calc
        ? `${fmtCalc(calc.grossBefore)}円 / ${fmtCalc(calc.beforeUnit)}円/${(tempProduct.kind === 'type' ? (row.unit || tempProduct.unit) : tempProduct.unit) || '個'}`
        : '-';
    };

    enableCustomUnitSelect(unit, update);
    [store, productInfo, price, priceType, tax, amount, unit].filter(Boolean).forEach(control => {
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



function refreshProductDialogStoreResults() {
  const list = $('productStoreList');
  if (!list || editProductId) return;
  const kind = $('productKind').value;
  const productAmount = Number($('productAmount').value) || 1;
  const productUnit = $('productUnit').value || '個';
  const cards = [...list.querySelectorAll('.product-add-store-card')];

  cards.forEach((card, index) => {
    const row = productDialogStores[index];
    if (!row) return;
    const result = card.querySelector('.qs-result');
    if (!result) return;
    const tempProduct = { kind: kind || 'product', amount: productAmount, unit: productUnit };
    const calc = calcRow(tempProduct, row);
    result.textContent = calc
      ? `${fmtCalc(calc.grossBefore)}円 / ${fmtCalc(calc.beforeUnit)}円/${(tempProduct.kind === 'type' ? (row.unit || tempProduct.unit) : tempProduct.unit) || '個'}`
      : '-';
  });
}

function makeBulkAddRow(kind = 'product') {
  return { id:makeId('ba'), kind, name:'', productInfo:'', amount:'', unit:kind==='product'?'g':'個', price:'', status:'' };
}

function openBulkAddDialog() {
  // 通常の商品追加と同じ設定を使う。以前はここだけ常に「商品名」固定だったため、
  // 「種類比較」が初期値のユーザーは登録済み候補が出ない状態になっていた。
  const initialKind = settings.registrationNameDefault === 'type' ? 'type' : 'product';
  bulkAddKind=initialKind;
  bulkAddRowsByKind={product:[makeBulkAddRow('product')],type:[makeBulkAddRow('type')]};
  $('bulkAddStore').value='';
  $('bulkAddPriceType').value=settings.defaultPriceType;
  $('bulkAddTax').innerHTML=taxOptions(settings.reducedTax);
  $('bulkAddTax').value=String(settings.reducedTax);
  setBulkAddKind(initialKind);
  $('bulkAddDialog').showModal();
  requestAnimationFrame(()=>$('bulkAddStore').focus());
}

function closeBulkAddDialog() {
  const hasInput = Object.values(bulkAddRowsByKind).flat().some(row=>row.name||row.price!==''||row.amount!=='') || $('bulkAddStore').value.trim();
  if (hasInput && !window.confirm('まとめて追加の入力内容を破棄して閉じますか？')) return;
  $('bulkAddDialog').close();
}

function setBulkAddKind(kind) {
  bulkAddKind = kind==='type'?'type':'product';
  $('bulkTabProduct').classList.toggle('active',bulkAddKind==='product');
  $('bulkTabType').classList.toggle('active',bulkAddKind==='type');
  renderBulkAddRows();
}

function updateBulkRowStatus(row, statusEl) {
  const existing = findExistingProductLoose(row.kind,row.name);
  if (!row.name.trim()) { statusEl.textContent=''; statusEl.className='bulk-row-status'; return; }
  if (!existing) { statusEl.textContent='新規'; statusEl.className='bulk-row-status is-new'; return; }
  const store = $('bulkAddStore').value.trim();
  const sameStore = store ? findStoreRowLoose(existing,store) : null;
  statusEl.textContent = sameStore ? '登録済み・上書き' : '商品登録済み';
  statusEl.className = 'bulk-row-status is-existing';
}

function renderBulkAddRows() {
  const host=$('bulkAddRows'); if(!host) return;
  host.innerHTML='';
  const rows=bulkAddRowsByKind[bulkAddKind];
  rows.forEach((row,index)=>{
    const wrap=document.createElement('div'); wrap.className='bulk-add-row-wrap';
    const line=document.createElement('div'); line.className='bulk-add-row '+(bulkAddKind==='type'?'is-type':'is-product');
    if (bulkAddKind==='product') {
      line.innerHTML=`<label>商品名<input class="ba-name" type="text" maxlength="80"></label><label>容量<input class="ba-amount" type="text" inputmode="decimal"></label><label>単位<select class="ba-unit"></select></label><label>価格<input class="ba-price" type="text" inputmode="decimal"></label><span class="bulk-row-status"></span><button class="st-delete ba-delete" type="button">×</button>`;
    } else {
      line.innerHTML=`<label>種類<input class="ba-name" type="text" maxlength="60"></label><label>商品情報<input class="ba-info" type="text" maxlength="80" placeholder="メーカーなど"></label><label>容量<input class="ba-amount" type="text" inputmode="decimal"></label><label>単位<select class="ba-unit"></select></label><label>価格<input class="ba-price" type="text" inputmode="decimal"></label><span class="bulk-row-status"></span><button class="st-delete ba-delete" type="button">×</button>`;
    }
    const name=line.querySelector('.ba-name'), info=line.querySelector('.ba-info'), amount=line.querySelector('.ba-amount'), unit=line.querySelector('.ba-unit'), price=line.querySelector('.ba-price'), status=line.querySelector('.bulk-row-status');
    name.value=row.name; if(info) info.value=row.productInfo; amount.value=row.amount; price.value=row.price;
    unit.innerHTML=getUnitOptionsHtml(row.unit); setSelectValueWithOption(unit,row.unit||'個'); enableCustomUnitSelect(unit,()=>{row.unit=unit.value;});
    bindSmartSuggestion(name,bulkAddKind);
    const sync=()=>{ row.name=name.value.trim(); row.productInfo=info?info.value.trim():''; row.amount=numberOrBlank(amount.value); row.unit=unit.value||'個'; row.price=numberOrBlank(price.value); updateBulkRowStatus(row,status); };
    [name,info,amount,unit,price].filter(Boolean).forEach(el=>{el.addEventListener('input',sync);el.addEventListener('change',sync);});
    line.querySelector('.ba-delete').addEventListener('click',()=>{ rows.splice(index,1); if(!rows.length)rows.push(makeBulkAddRow(bulkAddKind)); renderBulkAddRows(); });
    wrap.appendChild(line); host.appendChild(wrap); sync();
  });
}

function saveBulkAdd() {
  const storeName=$('bulkAddStore').value.trim();
  if(!storeName) return alert('店舗名を入力してね。');
  const priceType=$('bulkAddPriceType').value==='inc'?'inc':'ex';
  const tax=Number($('bulkAddTax').value);
  const rows=Object.values(bulkAddRowsByKind).flat().filter(row=>row.name.trim());
  if(!rows.length) return alert('商品を1件以上入力してね。');
  const invalid=rows.find(row=>!(Number(row.amount)>0)||row.price==='');
  if(invalid) return alert(`「${invalid.name}」の容量と価格を確認してね。`);
  const overwrites=[];
  rows.forEach(row=>{ const p=findExistingProductLoose(row.kind,row.name); if(p&&findStoreRowLoose(p,storeName)) overwrites.push(`${p.name} / ${storeName}`); });
  if(overwrites.length){
    const ok=window.confirm(`以下の商品はすでに登録があります。上書きしますか？\n\n${overwrites.map(v=>`・${v}`).join('\n')}`);
    if(!ok) return;
  }
  const now=new Date().toISOString(); let added=0, updated=0;
  rows.forEach(row=>{
    let product=findExistingProductLoose(row.kind,row.name);
    if(!product){
      product={id:makeId('p'),name:row.name.trim(),nameCandidates:{product:row.kind==='product'?row.name.trim():'',type:row.kind==='type'?row.name.trim():''},reading:makeReadingCandidate(row.name)||'',kind:row.kind,amount:row.kind==='product'?Number(row.amount):'',unit:row.kind==='product'?row.unit:'',defaultTax:tax,updatedAt:now,history:[],stores:[]};
      products.unshift(product); added++;
    } else { updated++; }
    if(row.kind==='product'){ product.amount=Number(row.amount); product.unit=row.unit; }
    product.defaultTax=tax; product.updatedAt=now;
    mergeStoreIntoProduct(product,{store:storeName,productInfo:row.productInfo,price:row.price,priceType,tax,amount:row.amount,unit:row.unit},{kind:row.kind,amount:Number(row.amount),unit:row.unit,defaultTax:tax,savedAt:now});
  });
  products=normalizeProductsData(products); persistNow(); render(); $('bulkAddDialog').close();
  showSaveToast(`一括保存しました（新規${added}件・更新${updated}件）`);
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
  productDialogReadings = { product: '', type: '' };
  productDialogReadingManual = { product: false, type: false };
  productNameIsComposing = false;
  compositionReadingCandidate = '';

  $('productDialogTitle').textContent = p ? '商品設定' : '商品追加';
  const candidates = normalizeNameCandidates(p?.nameCandidates, p?.kind === 'type' ? 'type' : 'product', p?.name || '');
  $('productName').value = p ? candidates.product : '';
  $('productTypeName').value = p ? candidates.type : '';
  $('productReading').value = p?.reading ?? '';
  if (p) {
    const savedKind = p.kind === 'type' ? 'type' : 'product';
    productDialogReadings[savedKind] = p.reading ?? '';
  }
  $('productAmount').value = p?.amount ?? 100;
  setSelectValueWithOption($('productUnit'), p?.unit ?? 'g');

  const taxSelect = $('productTax');
  const selectedTax = p?.defaultTax ?? settings.reducedTax;
  taxSelect.innerHTML = taxOptions(selectedTax);
  taxSelect.value = String(selectedTax);

  productDialogStores = p ? [] : [makeBlankDialogStore()];
  $('productStoreSection').classList.toggle('hidden', !!p);
  setProductKindChoice(
    p ? (p.kind === 'type' ? 'type' : 'product') : settings.registrationNameDefault,
    { updateReading: false }
  );

  const dialog = $('productDialog');
  dialog.showModal();

  requestAnimationFrame(() => {
    dialog.scrollTop = 0;
    $('productForm').scrollTop = 0;
    const initialKind = p ? (p.kind === 'type' ? 'type' : 'product') : settings.registrationNameDefault;
    const focusTarget = initialKind === 'type' ? $('productTypeName') : $('productName');
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

    const stores = meaningfulRows.map(row => ({
      id: makeId('s'),
      store: String(row.store || '').trim(),
      productInfo: kind === 'type' ? String(row.productInfo || '').trim() : '',
      price: row.price ?? '',
      priceType: row.priceType === 'inc' ? 'inc' : 'ex',
      tax: Number.isFinite(Number(row.tax)) ? Number(row.tax) : defaultTax,
      couponType: 'none', couponValue: '',
      amount: kind === 'type' ? (Number(row.amount) > 0 ? Number(row.amount) : '') : amount,
      unit: kind === 'type' ? String(row.unit || '個') : unit,
      updatedAt: savedAt
    }));

    const existingProduct = findExistingProductLoose(kind, name);
    if (existingProduct) {
      const duplicateStores = stores.filter(row => findStoreRowLoose(existingProduct, row.store)).map(row=>row.store);
      const lines = [`「${existingProduct.name}」はすでに登録されています。`];
      if (duplicateStores.length) lines.push('', '以下の店舗は登録済みです。上書きしますか？', ...duplicateStores.map(store=>`・${store}`));
      else lines.push('', '既存の商品に今回の店舗情報を追加しますか？');
      if (!window.confirm(lines.join('\n'))) return;

      existingProduct.nameCandidates = existingProduct.nameCandidates || {product:'',type:''};
      existingProduct.nameCandidates[kind] = existingProduct.name;
      existingProduct.reading = normalizeReadingInput($('productReading').value) || existingProduct.reading;
      existingProduct.defaultTax = defaultTax;
      if (kind === 'product') { existingProduct.amount = amount; existingProduct.unit = unit; }
      stores.forEach(row => mergeStoreIntoProduct(existingProduct,row,{kind,amount,unit,defaultTax,savedAt}));
      existingProduct.updatedAt = savedAt;
      products = normalizeProductsData(products);
      persistNow();
      openProductId = null; productEditDraft = null; productEditDirty = false;
      showSaveToast(duplicateStores.length ? '登録済みの内容を上書きしました' : '登録済みの商品に追加しました');
    } else {
      const p = {
        id: makeId('p'), name, nameCandidates,
        reading: normalizeReadingInput($('productReading').value), kind, amount, unit, defaultTax,
        updatedAt: savedAt, history: [], stores
      };
      products.unshift(p);
      persistNow();
      openProductId = null; productEditDraft = null; productEditDirty = false;
      showSaveToast(stores.length ? '商品と店舗情報を保存しました' : '商品を保存しました');
    }
  }

  hideSmartSuggestions();
  $('productDialog').close();
  render();
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
  $('registrationNameDefault').value =
    settings.registrationNameDefault === 'type' ? 'type' : 'product';
  $('settingsDialog').showModal();
}

function storeDataSnapshot(row) {
  return {
    store: normalizeMergeText(row?.store),
    price: numberOrBlank(row?.price ?? ''),
    priceType: row?.priceType === 'inc' ? 'inc' : 'ex',
    tax: Number.isFinite(Number(row?.tax)) ? Number(row.tax) : '',
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
  return `${kind}:${normalizeMergeText(product?.name)}`;
}

function findMatchingProduct(incoming) {
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
        alert('これは別の端末とのデータ共有用ファイルだよ。「共有データを追加する」から読み込んでね。');
        return;
      }
      settings = normalizeSettingsData(data.settings || {});
      products = normalizeProductsData(data.products);
      shoppingMemoChecked = new Set(Array.isArray(data.shoppingMemoChecked) ? data.shoppingMemoChecked.map(String) : []);
      persistShoppingMemoChecked();


      persistNow();
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      localStorage.setItem(INITIALIZED_KEY, '1');
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
  const quantity = Number(row?.amount) > 0 ? ` / ${fmt(row.amount)}${row.unit || ''}` : '';
  return `${price} / 税率${Number(row?.tax) || 0}%${quantity}`;
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
  const text = normalizeNumericInputText(v);
  if (text === '') return '';
  const n = Number(text);
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

function fmtCalc(v) {
  return Number(v).toLocaleString('ja-JP', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function fmtCalcDelta(v) {
  const n = Math.abs(Number(v)) < 0.005 ? 0 : Number(v);
  const text = Math.abs(n).toLocaleString('ja-JP', {minimumFractionDigits:2, maximumFractionDigits:2});
  if (n > 0) return `+${text}`;
  if (n < 0) return `-${text}`;
  return '0.00';
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


window.PriceLogApp = {
  getProducts: () => structuredCloneSafe(products),
  replaceProducts: (next, { persist = true } = {}) => {
    products = normalizeProductsData(Array.isArray(next) ? next : []);
    if (persist) persistNow();
    render();
  },
  mergeProducts: (base, incoming) => {
    const original = products;
    products = normalizeProductsData(Array.isArray(base) ? structuredCloneSafe(base) : []);
    const incomingList = normalizeProductsData(Array.isArray(incoming) ? structuredCloneSafe(incoming) : []);
    incomingList.forEach(item => {
      let target = findExistingProductLoose(item.kind==='type'?'type':'product', item.name);
      if (!target) { products.push(item); return; }
      const targetTime = Date.parse(target.updatedAt||'')||0, incomingTime=Date.parse(item.updatedAt||'')||0;
      if (incomingTime>targetTime) {
        target.reading=item.reading||target.reading; target.defaultTax=item.defaultTax; target.updatedAt=item.updatedAt;
        if (item.kind==='product'){target.amount=item.amount;target.unit=item.unit;}
      }
      (item.stores||[]).forEach(row => {
        const existing=findStoreRowLoose(target,row.store);
        if(!existing){target.stores.push(row);return;}
        const a=Date.parse(existing.updatedAt||'')||0,b=Date.parse(row.updatedAt||'')||0;
        if(b>=a) Object.assign(existing,row,{id:existing.id});
      });
      target.stores=collapseDuplicateStores(target.stores||[]);
      const hist=[...(target.history||[]),...(item.history||[])];
      const seen=new Set(); target.history=hist.filter(h=>{const k=`${h.updatedAt}|${h.store}|${h.beforePrice}|${h.afterPrice}`;if(seen.has(k))return false;seen.add(k);return true;}).sort((a,b)=>(Date.parse(b.updatedAt||'')||0)-(Date.parse(a.updatedAt||'')||0)).slice(0,20);
    });
    const merged=normalizeProductsData(products);
    products=original;
    return structuredCloneSafe(merged);
  },
  normalizeLooseKey,
  hasActiveEdits: () => Boolean(
    productEditDirty ||
    shelfCompareDirty ||
    shoppingMemoEditStore ||
    $('productDialog')?.open ||
    $('bulkAddDialog')?.open
  ),
  render
};

})();
