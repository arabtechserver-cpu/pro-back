import https from 'https';
import { prisma } from '../utils/prisma';
import { withinDeadline, RequestDeadlineError } from '../utils/request-deadline';
import { invalidateCatalogRevision } from '../utils/catalog-revision';
import { BoundedCache } from '../utils/bounded-cache';
import { AsyncGate } from '../utils/async-gate';
import { createHash } from 'crypto';
import { providerCatalogSnapshotPath, loadProviderCatalogSnapshot, saveProviderCatalogSnapshot } from '../utils/provider-catalog-snapshot';
const providerReads = new AsyncGate(12, 64, 22000);
const providerWrites = new AsyncGate(2, 12, 3000);

export interface FoxreloadSettings {
  apiKey: string;
  isEnabled: boolean;
  defaultProfitMarginPercent: number;
  autoFulfill: boolean;
  hiddenItems: string[];
  customPrices: Record<string, number>;
  customMargins: Record<string, number>;
}

const SETTINGS_KEY = 'foxreload_settings';

function getEnvApiKey(): string {
  return (process.env.FOXRELOAD_API_KEY || '').trim();
}

const DEFAULT_SETTINGS: FoxreloadSettings = {
  apiKey: '',
  isEnabled: true,
  defaultProfitMarginPercent: 10,
  autoFulfill: false,
  hiddenItems: [],
  customPrices: {},
  customMargins: {},
};

export async function getFoxreloadSettings(): Promise<FoxreloadSettings> {
  const envKey = getEnvApiKey();
  try {
    const record = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
    if (!record?.value) {
      return { ...DEFAULT_SETTINGS, apiKey: envKey };
    }
    const parsed = JSON.parse(record.value);
    const parsedMargin = Number(parsed.defaultProfitMarginPercent);
    const defaultProfitMarginPercent =
      !isNaN(parsedMargin) && parsed.defaultProfitMarginPercent !== null && parsed.defaultProfitMarginPercent !== undefined
        ? Math.max(0, parsedMargin)
        : 10;
    return {
      apiKey: parsed.apiKey || envKey,
      isEnabled: parsed.isEnabled !== false,
      defaultProfitMarginPercent,
      autoFulfill: Boolean(parsed.autoFulfill),
      hiddenItems: Array.isArray(parsed.hiddenItems) ? parsed.hiddenItems : [],
      customPrices: parsed.customPrices && typeof parsed.customPrices === 'object' ? parsed.customPrices : {},
      customMargins: parsed.customMargins && typeof parsed.customMargins === 'object' ? parsed.customMargins : {},
    };
  } catch {
    return { ...DEFAULT_SETTINGS, apiKey: envKey };
  }
}

export async function updateFoxreloadSettings(updates: Partial<FoxreloadSettings>): Promise<FoxreloadSettings> {
  const current = await getFoxreloadSettings();
  const updated: FoxreloadSettings = {
    apiKey: updates.apiKey !== undefined ? updates.apiKey.trim() : current.apiKey,
    isEnabled: updates.isEnabled !== undefined ? Boolean(updates.isEnabled) : current.isEnabled,
    defaultProfitMarginPercent:
      updates.defaultProfitMarginPercent !== undefined && updates.defaultProfitMarginPercent !== null
        ? Math.max(0, Number(updates.defaultProfitMarginPercent))
        : current.defaultProfitMarginPercent,
    autoFulfill: updates.autoFulfill !== undefined ? Boolean(updates.autoFulfill) : current.autoFulfill,
    hiddenItems: Array.isArray(updates.hiddenItems) ? updates.hiddenItems : current.hiddenItems,
    customPrices: updates.customPrices !== undefined ? updates.customPrices : current.customPrices,
    customMargins: updates.customMargins !== undefined ? updates.customMargins : current.customMargins,
  };

  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    create: {
      key: SETTINGS_KEY,
      value: JSON.stringify(updated),
    },
    update: {
      value: JSON.stringify(updated),
    },
  });

  clearCatalogCache();
  return updated;
}

export async function callFoxreloadApi(
  endpointPath: string,
  method: 'GET' | 'POST' = 'GET',
  bodyPayload?: any,
  lang: string = 'en',
  currency: string = 'usd',
  customApiKey?: string,
  readTimeoutMs?: number
): Promise<{ ok: boolean; status: number; data: any; raw: string }> {
  const readDeadline = readTimeoutMs === undefined ? Infinity : Date.now() + readTimeoutMs;
  return (method === 'GET' ? providerReads : providerWrites).run(() => {
    if (method === 'GET' && Date.now() >= readDeadline) throw new RequestDeadlineError();
    return requestFoxreloadApi(endpointPath, method, bodyPayload, lang, currency, customApiKey, readTimeoutMs === undefined ? 5000 : Math.max(1, readDeadline - Date.now()));
  });
}

async function requestFoxreloadApi(
  endpointPath: string,
  method: 'GET' | 'POST' = 'GET',
  bodyPayload?: any,
  lang: string = 'en',
  currency: string = 'usd',
  customApiKey?: string,
  readTimeoutMs = 5000
): Promise<{ ok: boolean; status: number; data: any; raw: string }> {
  const apiKey = (customApiKey || (await getFoxreloadSettings()).apiKey || getEnvApiKey()).trim();

  if (!apiKey) {
    return {
      ok: false,
      status: 401,
      data: { error: 'لم يتم تعيين مفتاح الربط الخاص بـ FoxReload (FOXRELOAD_API_KEY) في الخادم أو الإعدادات' },
      raw: 'Missing API Key in Environment',
    };
  }

  const payloadString = bodyPayload ? JSON.stringify(bodyPayload) : '';

  return new Promise((resolve) => {
    const headers: Record<string, string | number> = {
      'X-API-Key': apiKey,
      'X-Language': lang,
      'X-Currency': currency.toLowerCase(),
      'Accept': 'application/json',
    };

    if (bodyPayload && method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payloadString);
    }

    const options = {
      hostname: 'public-api.foxreload.com',
      port: 443,
      path: endpointPath,
      method,
      headers,
      timeout: method === 'GET' ? readTimeoutMs : 15000,
    };

    const req = https.request({ ...options, signal: AbortSignal.timeout(options.timeout) }, (res) => {
      let data = '';
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024) { req.destroy(new Error('Provider response is too large')); return; }
        data += chunk;
      });
      res.on('end', () => {
        let parsed: any = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = null;
        }

        const isOk = Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300);
        if (!isOk) {
          console.warn(`[FoxReload API Error] ${method} ${endpointPath} - Status: ${res.statusCode} - Response:`, data);
        }

        resolve({
          ok: isOk,
          status: res.statusCode || 500,
          data: parsed,
          raw: data,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      console.warn(`[FoxReload API Timeout] ${method} ${endpointPath}`);
      resolve({
        ok: false,
        status: 504,
        data: { error: 'FoxReload API request timed out' },
        raw: 'Gateway Timeout',
      });
    });

    req.on('error', (err) => {
      console.error(`[FoxReload API Exception] ${method} ${endpointPath}:`, err.message);
      resolve({
        ok: false,
        status: 500,
        data: { error: err.message },
        raw: err.message,
      });
    });

    if (bodyPayload && method === 'POST') {
      req.write(payloadString);
    }
    req.end();
  });
}

export async function getFoxreloadLiveBalance(customApiKey?: string): Promise<{
  success: boolean;
  email?: string;
  balances: Array<{ currency: string; amount: number }>;
  isActive?: boolean;
  error?: string;
  details?: any;
}> {
  try {
    const settings = await getFoxreloadSettings();
    const effectiveKey = (customApiKey || settings.apiKey || getEnvApiKey()).trim();
    if (!effectiveKey) {
      return {
        success: false,
        balances: [],
        error: 'لم يتم العثور على مفتاح FoxReload API. يرجى إدخال المفتاح وحفظه أولاً في الإعدادات أو ملف البيئة (FOXRELOAD_API_KEY).',
      };
    }

    const [accountRes, balancesRes] = await Promise.all([
      callFoxreloadApi('/api/access/me', 'GET', undefined, 'en', 'usd', effectiveKey),
      callFoxreloadApi('/api/access/me/balances/', 'GET', undefined, 'en', 'usd', effectiveKey),
    ]);

    if (!accountRes.ok && !balancesRes.ok) {
      const errorMsg =
        accountRes.data?.error ||
        accountRes.data?.detail ||
        accountRes.data?.message ||
        balancesRes.data?.error ||
        balancesRes.data?.detail ||
        balancesRes.data?.message ||
        (accountRes.status === 401 ? 'مفتاح الربط (API Key) غير صالح أو منتهي الصلاحية لدى FoxReload (401)' : `فشل الاتصال بـ FoxReload (كود الخطأ: ${accountRes.status || balancesRes.status})`);

      return {
        success: false,
        balances: [],
        error: errorMsg,
        details: {
          accountStatus: accountRes.status,
          balancesStatus: balancesRes.status,
          accountData: accountRes.data,
          balancesData: balancesRes.data,
        },
      };
    }

    const balancesList: Array<{ currency: string; amount: number }> = [];
    if (Array.isArray(balancesRes.data)) {
      for (const item of balancesRes.data) {
        balancesList.push({
          currency: String(item.currency || 'USD').toUpperCase(),
          amount: Number(item.amount ?? item.balance ?? 0),
        });
      }
    }

    if (balancesList.length === 0) {
      balancesList.push({ currency: 'USD', amount: 0 });
      balancesList.push({ currency: 'RUB', amount: 0 });
    }

    return {
      success: true,
      email: accountRes.data?.email || '',
      isActive: accountRes.data?.isActive ?? true,
      balances: balancesList,
    };
  } catch (err: any) {
    return {
      success: false,
      balances: [],
      error: err.message || 'خطأ غير متوقع أثناء فحص الرصيد',
    };
  }
}

export function computeClientPrice(
  originalPrice: number,
  productId: string,
  settings: FoxreloadSettings
): { finalPrice: number; marginAmount: number; marginPercent: number } {
  const cost = Number(originalPrice) || 0;
  if (settings.customPrices && typeof settings.customPrices[productId] === 'number') {
    const finalPrice = Math.max(0, settings.customPrices[productId]);
    const marginAmount = Number((finalPrice - cost).toFixed(2));
    const marginPercent = cost > 0 ? Number(((marginAmount / cost) * 100).toFixed(1)) : 0;
    return { finalPrice, marginAmount, marginPercent };
  }

  let marginPercent =
    typeof settings.defaultProfitMarginPercent === 'number'
      ? settings.defaultProfitMarginPercent
      : 10;
  if (settings.customMargins && typeof settings.customMargins[productId] === 'number') {
    marginPercent = settings.customMargins[productId];
  }

  const marginAmount = Number(((cost * marginPercent) / 100).toFixed(2));
  const finalPrice = Number((cost + marginAmount).toFixed(2));
  return { finalPrice, marginAmount, marginPercent };
}

export interface FoxreloadRegion {
  id: string;
  slug: string;
  name: string;
  inStockCount: number;
  hasProducts: boolean;
  bestOfferPrice?: string | null;
}

export interface FoxreloadBundle {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  inStockCount: number;
  imagePath?: string | null;
  thumbnailPath?: string | null;
  bestOfferPrice?: string | null;
  sectionId: string;
  regions: FoxreloadRegion[];
  isHidden: boolean;
}

export interface FoxreloadProduct {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  categoryId: string;
  categorySlug: string;
  costPrice: number;
  price: number;
  marginAmount: number;
  marginPercent: number;
  currency: string;
  stock: number;
  minQty: number;
  maxQty?: number | null;
  deliveryType: string;
  isService: boolean;
  requiredNoteFields: string[];
  noteFieldOptions: Record<string, any>;
  noteFieldTypes: Record<string, string>;
  attributes: Record<string, any>;
  userGuide?: string | null;
  imagePath?: string | null;
  thumbnailPath?: string | null;
  isHidden: boolean;
}

let catalogCache: { timestamp: number; data: any } | null = null;
let catalogInFlight: Promise<any> | null = null;
const productsInFlight = new Map<string, Promise<FoxreloadProduct[]>>();
const categoryProductsCache = new BoundedCache<string, { timestamp: number; data: FoxreloadProduct[] }>(1000, 16 * 1024 * 1024, 30 * 60 * 1000);
const treeCache = new BoundedCache<string, { timestamp: number; data: FoxreloadBundle[] }>(10, 2 * 1024 * 1024, 30 * 60 * 1000);
let allProductsInFlight: Promise<FoxreloadProduct[]> | null = null;
let foxCatalogRevision = 0;
// Retain exactly one complete snapshot; a cache budget must not discard the catalog.
let lastProductsSnapshot: { timestamp: number; data: FoxreloadProduct[] } | null = null;
let snapshotRestore: Promise<void> | null = null;
let snapshotRestoreAttempted = false;
let snapshotWrite: Promise<void> | null = null;
let snapshotWriteRequested = false;
let nextCatalogRefreshAt = 0;
export type ProductWalkState = { products: Map<string, any>; cursors: Set<string>; cursor: string; offset: number };
let resumableProductWalk: { revision: number; state: ProductWalkState } | null = null;
let esimSnapshot: { timestamp: number; data: FoxreloadProduct[]; catalog: any } | null = null;
let esimInFlight: Promise<FoxreloadProduct[]> | null = null;
let esimWalk: { revision: number; state: ProductWalkState } | null = null;
let nextEsimRefreshAt = 0;
let productsView: { all: FoxreloadProduct[]; esim: FoxreloadProduct[]; data: FoxreloadProduct[] } | null = null;

function newProductWalk(): ProductWalkState { return { products: new Map(), cursors: new Set(), cursor: '', offset: 0 }; }

class ProductPageUnavailable extends Error {}

function settingsFingerprint(settings: FoxreloadSettings): string {
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}

// Serialize and coalesce publications so an older file cannot replace a newer snapshot.
function persistAvailableSnapshot(): Promise<void> {
  snapshotWriteRequested = true;
  if (!snapshotWrite) {
    const pending = (async () => {
      while (snapshotWriteRequested) {
        snapshotWriteRequested = false;
        const revision = foxCatalogRevision;
        const settings = await getFoxreloadSettings();
        const snapshot = lastProductsSnapshot;
        if (!snapshot || revision !== foxCatalogRevision) continue;
        await saveProviderCatalogSnapshot(providerCatalogSnapshotPath(), settingsFingerprint(settings), snapshot.data, catalogCache?.data || { sections: {} }, snapshot.timestamp)
          .catch(() => { console.warn('[Catalog Snapshot] Unable to persist snapshot; current complete in-memory catalog remains available.'); });
      }
    })().finally(() => { if (snapshotWrite === pending) snapshotWrite = null; });
    snapshotWrite = pending;
  }
  return snapshotWrite;
}

const CACHE_TTL_MS = 15 * 60 * 1000;

export function clearCatalogCache() {
  foxCatalogRevision++;
  invalidateCatalogRevision();
  catalogCache = null;
  catalogInFlight = null;
  productsInFlight.clear();
  categoryProductsCache.clear();
  treeCache.clear();
  allProductsInFlight = null;
  lastProductsSnapshot = null;
  snapshotRestore = null;
  snapshotRestoreAttempted = false;
  nextCatalogRefreshAt = 0;
  resumableProductWalk = null;
  esimSnapshot = null;
  esimInFlight = null;
  esimWalk = null;
  nextEsimRefreshAt = 0;
  productsView = null;
}

// Follow the documented offset/cursor pagination; publish only complete snapshots.
export async function readFoxreloadProductPages(
  fetchPage: (path: string, remainingMs: number) => Promise<{ ok: boolean; data: any }>,
  categoryId?: string,
  budgetMs = 22000,
  state: ProductWalkState = newProductWalk(),
  includeDescendants = false
): Promise<any[]> {
  const started = Date.now();
  const { products, cursors } = state;
  const useCursor = !categoryId || includeDescendants;
  while (true) {
    if (Date.now() - started >= budgetMs) throw new RequestDeadlineError();
    const query = new URLSearchParams({ withStockOnly: 'true', limit: '200' });
    if (categoryId) query.set('categoryId', categoryId);
    if (useCursor) { query.set('includeDescendants', 'true'); if (state.cursor) query.set('cursor', state.cursor); }
    else query.set('offset', String(state.offset));
    const response = await fetchPage(`/api/products/?${query}`, Math.min(10000, budgetMs - (Date.now() - started)));
    if (!response.ok || !Array.isArray(response.data?.items)) {
      throw new ProductPageUnavailable('FoxReload product catalog is temporarily unavailable; incomplete catalog was not published');
    }
    const page = response.data;
    const previousSize = products.size;
    for (const product of page.items) {
      if (!product?.id) throw new Error('FoxReload returned a product without an ID');
      products.set(String(product.id), product);
    }
    const next = typeof page.nextCursor === 'string' ? page.nextCursor : '';
    const total = Number(page.total);
    const limit = Number(page.limit) || 200;
    if (useCursor) {
      if (!next) {
        if (Number.isFinite(total) && total > products.size) throw new Error('FoxReload returned an incomplete catalog without a next cursor');
        break;
      }
      if (cursors.has(next) || products.size === previousSize) throw new Error('FoxReload catalog cursor did not advance');
      cursors.add(next); state.cursor = next;
    } else {
      state.offset += page.items.length;
      if (Number.isFinite(total) ? state.offset >= total : page.items.length < limit) break;
      if (!page.items.length || products.size === previousSize) throw new Error('FoxReload catalog page did not advance');
    }
  }
  return Array.from(products.values());
}

export async function getFoxreloadAllProducts(forceRefresh = false, waitMs = 22000): Promise<FoxreloadProduct[]> {
  const cached = lastProductsSnapshot;
  if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;
  if (!allProductsInFlight) {
    const revision = foxCatalogRevision;
    const work = (async () => {
      const settings = await getFoxreloadSettings();
      if (!settings.isEnabled || !settings.apiKey) return [];
      const hidden = new Set(settings.hiddenItems);
      if (!resumableProductWalk || resumableProductWalk.revision !== revision) resumableProductWalk = { revision, state: newProductWalk() };
      const walk = resumableProductWalk;
      const deadline = Date.now() + 15 * 60 * 1000;
      const items = await readFoxreloadProductPages(async (path, budget) => {
        if (revision !== foxCatalogRevision) throw new Error('FoxReload catalog settings changed during refresh');
        let response = await callFoxreloadApi(path, 'GET', undefined, 'en', 'usd', settings.apiKey, budget);
        // Retry only a failed read page. Never replay order writes.
        if (!response.ok && (response.status >= 500 || response.status === 429)) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new RequestDeadlineError();
          response = await callFoxreloadApi(path, 'GET', undefined, 'en', 'usd', settings.apiKey, Math.min(10000, remaining));
        }
        return response;
      }, undefined, 15 * 60 * 1000, walk.state);
      const data = items.map(p => mapProductItem(p, settings, hidden, p.categoryId)).filter(isValidProduct);
      walk.state.products.clear();
      items.length = 0;
      if (resumableProductWalk === walk) resumableProductWalk = null;
      if (revision === foxCatalogRevision) {
        lastProductsSnapshot = { timestamp: Date.now(), data };
        productsView = null;
        invalidateCatalogRevision();
        await persistAvailableSnapshot();
      }
      return data;
    })();
    const pending = work.catch(error => {
      if (revision === foxCatalogRevision) {
        if (!(error instanceof ProductPageUnavailable) && !(error instanceof RequestDeadlineError)) resumableProductWalk = null;
        nextCatalogRefreshAt = Date.now() + 30000;
      }
      throw error;
    }).finally(() => {
      if (allProductsInFlight === pending) allProductsInFlight = null;
    });
    allProductsInFlight = pending;
  }
  if (!forceRefresh && cached) { allProductsInFlight.catch(() => {}); return cached.data; }
  // A timed-out HTTP reader does not restart or abandon the shared catalog refresh.
  return withinDeadline(allProductsInFlight, waitMs);
}

export interface AvailableFoxreloadCatalog {
  catalog: any;
  products: FoxreloadProduct[];
  complete: boolean;
  refreshing: boolean;
  completeSections?: string[];
}

// eSIM plans are named by allowance/duration and country, so searching for the
// word "esim" misses them. Load the actual category subtree, independently of
// the much larger global product walk, and publish only its complete snapshot.
export async function getFoxreloadEsimProducts(forceRefresh = false, waitMs = 22000): Promise<FoxreloadProduct[]> {
  const cached = esimSnapshot;
  if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;
  if (!esimInFlight) {
    const revision = foxCatalogRevision;
    const work = (async () => {
      const settings = await getFoxreloadSettings();
      if (!settings.isEnabled || !settings.apiKey) return [];
      const hidden = new Set(settings.hiddenItems);
      if (!esimWalk || esimWalk.revision !== revision) esimWalk = { revision, state: newProductWalk() };
      const walk = esimWalk;
      const deadline = Date.now() + 15 * 60 * 1000;
      const [treeResult, productsResult] = await Promise.allSettled([
        fetchParentTree('esim', 'esim', settings, hidden, revision),
        readFoxreloadProductPages(async (endpoint, budget) => {
          if (revision !== foxCatalogRevision) throw new Error('FoxReload catalog settings changed during refresh');
          let response = await callFoxreloadApi(endpoint, 'GET', undefined, 'en', 'usd', settings.apiKey, budget);
          if (!response.ok && (response.status >= 500 || response.status === 429)) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new RequestDeadlineError();
            response = await callFoxreloadApi(endpoint, 'GET', undefined, 'en', 'usd', settings.apiKey, Math.min(10000, remaining));
          }
          return response;
        }, 'esim', 15 * 60 * 1000, walk.state, true)
      ]);
      // Keep the shared refresh alive until both readers settle, even when one
      // fails early; a new caller must not start a second pagination walk.
      if (productsResult.status === 'rejected') throw productsResult.reason;
      if (treeResult.status === 'rejected') throw new ProductPageUnavailable('FoxReload eSIM category tree is temporarily unavailable');
      const bundles = treeResult.value, items = productsResult.value;
      if (revision !== foxCatalogRevision) throw new Error('FoxReload catalog settings changed during refresh');
      const data = items.map(item => mapProductItem(item, settings, hidden, 'esim')).filter(isValidProduct);
      walk.state.products.clear(); items.length = 0;
      if (esimWalk === walk) esimWalk = null;
      const catalog = { sections: { esim: { id: 'esim', nameAr: 'شرائح الإنترنت eSIM', nameEn: 'eSIM', bundles } } };
      esimSnapshot = { timestamp: Date.now(), data, catalog };
      productsView = null;
      invalidateCatalogRevision();
      await saveProviderCatalogSnapshot(providerCatalogSnapshotPath('esim'), settingsFingerprint(settings), data, catalog, esimSnapshot.timestamp)
        .catch(() => console.warn('[Catalog Snapshot] Unable to persist eSIM snapshot; complete in-memory plans remain available.'));
      return data;
    })();
    const pending = work.catch(error => {
      if (revision === foxCatalogRevision) {
        if (!(error instanceof ProductPageUnavailable) && !(error instanceof RequestDeadlineError)) esimWalk = null;
        nextEsimRefreshAt = Date.now() + 30000;
      }
      throw error;
    }).finally(() => { if (esimInFlight === pending) esimInFlight = null; });
    esimInFlight = pending;
  }
  if (!forceRefresh && cached) { esimInFlight.catch(() => {}); return cached.data; }
  return withinDeadline(esimInFlight, waitMs);
}

export async function getAvailableFoxreloadCatalog(): Promise<AvailableFoxreloadCatalog> {
  const settings = await getFoxreloadSettings();
  if (!settings.isEnabled || !settings.apiKey) {
    return { catalog: { sections: {} }, products: [], complete: true, refreshing: false };
  }
  if (!lastProductsSnapshot && !snapshotRestoreAttempted) {
    snapshotRestoreAttempted = true;
    const revision = foxCatalogRevision;
    snapshotRestore = loadProviderCatalogSnapshot(providerCatalogSnapshotPath(), settingsFingerprint(settings)).then(async snapshot => {
      if (snapshot && revision === foxCatalogRevision && !lastProductsSnapshot) {
        lastProductsSnapshot = { timestamp: snapshot.timestamp, data: snapshot.products };
        productsView = null;
        if (!catalogCache && Object.keys(snapshot.catalog?.sections || {}).length) catalogCache = { timestamp: snapshot.timestamp, data: snapshot.catalog };
        invalidateCatalogRevision();
      }
      const esim = await loadProviderCatalogSnapshot(providerCatalogSnapshotPath('esim'), settingsFingerprint(settings));
      if (esim?.catalog?.sections?.esim && revision === foxCatalogRevision && !esimSnapshot) {
        esimSnapshot = { timestamp: esim.timestamp, data: esim.products, catalog: esim.catalog };
        productsView = null;
        invalidateCatalogRevision();
      }
    });
  }
  if (snapshotRestore) await withinDeadline(snapshotRestore, 1000).catch(() => {});
  if (Date.now() >= nextEsimRefreshAt) getFoxreloadEsimProducts(false, 15 * 60 * 1000).catch(() => {});
  // HTTP catalog readers never wait for the external provider. A shared background
  // job fills the complete snapshot; an old complete snapshot stays usable.
  if (Date.now() >= nextCatalogRefreshAt) {
    getFoxreloadFullCatalog(false).catch(() => {});
    getFoxreloadAllProducts(false, 15 * 60 * 1000).catch(() => {});
  }
  const catalog = catalogCache?.data || { sections: {} };
  let products = lastProductsSnapshot?.data || esimSnapshot?.data || [];
  if (lastProductsSnapshot && esimSnapshot && esimSnapshot.timestamp > lastProductsSnapshot.timestamp) {
    if (!productsView || productsView.all !== lastProductsSnapshot.data || productsView.esim !== esimSnapshot.data) {
      const unique = new Map(lastProductsSnapshot.data.map(product => [product.id, product]));
      for (const product of esimSnapshot.data) unique.set(product.id, product);
      productsView = { all: lastProductsSnapshot.data, esim: esimSnapshot.data, data: Array.from(unique.values()) };
    }
    products = productsView.data;
  }
  return {
    catalog: esimSnapshot && (!catalog.sections.esim || esimSnapshot.timestamp > (catalogCache?.timestamp || 0))
      ? { ...catalog, sections: { ...catalog.sections, esim: esimSnapshot.catalog.sections.esim } } : catalog,
    products,
    complete: lastProductsSnapshot !== null,
    refreshing: allProductsInFlight !== null || esimInFlight !== null,
    completeSections: esimSnapshot ? ['esim'] : []
  };
}

let catalogWarmupTimer: ReturnType<typeof setInterval> | undefined;
export function startFoxreloadCatalogWarmup(): void {
  if (catalogWarmupTimer) return;
  const warm = () => {
    getAvailableFoxreloadCatalog().catch(() => {});
  };
  warm();
  catalogWarmupTimer = setInterval(warm, 10 * 60 * 1000);
  catalogWarmupTimer.unref();
}

async function fetchParentTree(
  parentSlug: string,
  sectionId: string,
  settings: FoxreloadSettings,
  hiddenSet: Set<string>,
  revision: number
): Promise<FoxreloadBundle[]> {
  const cached = treeCache.get(parentSlug);
  const now = Date.now();
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const res = await callFoxreloadApi(
    `/api/categories/tree?parentId=${encodeURIComponent(parentSlug)}&depth=2&withStockOnly=true`,
    'GET',
    undefined,
    'en',
    'usd',
    settings.apiKey
  );

  const rawList = res.data?.items || (Array.isArray(res.data) ? res.data : []);
  if (!res.ok) {
    if (cached) return cached.data;
    throw new Error('FoxReload category tree is temporarily unavailable');
  }
  const bundles: FoxreloadBundle[] = rawList
    .map((c: any) => {
      const rawChildren = Array.isArray(c.children) ? c.children : [];
      const regions: FoxreloadRegion[] = rawChildren.map((ch: any) => ({
        id: ch.id,
        slug: ch.slug,
        name: ch.name || 'Global',
        inStockCount: typeof ch.inStockCount === 'number' ? ch.inStockCount : 0,
        hasProducts: Boolean(ch.hasProducts),
        bestOfferPrice: ch.bestOfferPrice || null,
      }));

      if (regions.length === 0 && (c.hasProducts || c.inStockCount > 0)) {
        regions.push({
          id: c.id,
          slug: c.slug,
          name: 'Global',
          inStockCount: c.inStockCount || 1,
          hasProducts: true,
          bestOfferPrice: c.bestOfferPrice || null,
        });
      }

      return {
        id: c.id,
        slug: c.slug,
        name: c.name,
        parentId: c.parentId || null,
        inStockCount: typeof c.inStockCount === 'number' ? c.inStockCount : 0,
        imagePath: c.imagePath || null,
        thumbnailPath: c.thumbnailPath || null,
        bestOfferPrice: c.bestOfferPrice || null,
        sectionId,
        regions,
        isHidden: hiddenSet.has(c.id) || hiddenSet.has(c.slug),
      };
    })
    .filter((b: FoxreloadBundle) => b.inStockCount > 0 || b.regions.length > 0);

  if (revision === foxCatalogRevision) treeCache.set(parentSlug, { timestamp: now, data: bundles });
  return bundles;
}

export async function getFoxreloadCategoryProducts(
  categoryId: string,
  forceRefresh: boolean = false
): Promise<FoxreloadProduct[]> {
  const cached = categoryProductsCache.get(categoryId);
  if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;
  const pending = productsInFlight.get(categoryId);
  if (pending) return pending;
  const work = loadFoxreloadCategoryProducts(categoryId, forceRefresh);
  productsInFlight.set(categoryId, work);
  try { return await work; }
  finally { if (productsInFlight.get(categoryId) === work) productsInFlight.delete(categoryId); }
}

async function loadFoxreloadCategoryProducts(
  categoryId: string,
  forceRefresh: boolean = false
): Promise<FoxreloadProduct[]> {
  const now = Date.now();
  const revision = foxCatalogRevision;
  if (!forceRefresh) {
    const cached = categoryProductsCache.get(categoryId);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const settings = await getFoxreloadSettings();
  const hiddenSet = new Set(settings.hiddenItems);

  let items: any[];
  try {
    items = await readFoxreloadProductPages((path, budget) => callFoxreloadApi(path, 'GET', undefined, 'en', 'usd', settings.apiKey, budget), categoryId);
  } catch (error) {
    const cached = categoryProductsCache.get(categoryId);
    if (cached) return cached.data;
    throw error;
  }
  const mapped = items
    .map((p: any) => mapProductItem(p, settings, hiddenSet, categoryId))
    .filter(isValidProduct);

  if (revision !== foxCatalogRevision) throw new Error('FoxReload catalog settings changed during refresh');
  categoryProductsCache.set(categoryId, { timestamp: now, data: mapped });
  return mapped;
}

export async function searchFoxreloadProducts(query: string): Promise<FoxreloadProduct[]> {
  if (!query || !query.trim()) return [];
  const settings = await getFoxreloadSettings();
  const hiddenSet = new Set(settings.hiddenItems);

  const res = await callFoxreloadApi(
    `/api/products/search?query=${encodeURIComponent(query.trim())}&withStockOnly=true&limit=50`,
    'GET',
    undefined,
    'en',
    'usd'
  );

  const items = Array.isArray(res.data) ? res.data : [];
  return items
    .map((p: any) => mapProductItem(p, settings, hiddenSet, 'search'))
    .filter(isValidProduct);
}

export async function getFoxreloadFullCatalog(forceRefresh: boolean = false): Promise<any> {
  if (!forceRefresh && catalogCache && Date.now() - catalogCache.timestamp < CACHE_TTL_MS) return catalogCache.data;
  if (!catalogInFlight) {
    const pending = loadFoxreloadFullCatalog(forceRefresh)
      .finally(() => { if (catalogInFlight === pending) catalogInFlight = null; });
    catalogInFlight = pending;
  }
  // Serve the last successful snapshot while one shared refresh runs.
  if (!forceRefresh && catalogCache) {
    catalogInFlight.catch(() => {});
    return catalogCache.data;
  }
  return withinDeadline(catalogInFlight, 12000);
}

async function loadFoxreloadFullCatalog(forceRefresh: boolean = false): Promise<any> {
  const now = Date.now();
  const revision = foxCatalogRevision;
  if (!forceRefresh && catalogCache && now - catalogCache.timestamp < CACHE_TTL_MS) {
    return catalogCache.data;
  }

  const settings = await getFoxreloadSettings();
  if (!settings.isEnabled || !settings.apiKey) return { sections: {}, isEnabled: false, totalBundlesCount: 0 };
  const hiddenSet = new Set(settings.hiddenItems);

  const [
    topupsBundles,
    appStoresBundles,
    gameCurrencyBundles,
    subscriptionsBundles,
    esimBundles,
    rewarbleBundles,
    popularLegacyItems,
  ] = await Promise.all([
    fetchParentTree('topups', 'topups', settings, hiddenSet, revision),
    fetchParentTree('app-stores', 'app-stores', settings, hiddenSet, revision),
    fetchParentTree('game-currency', 'game-currency', settings, hiddenSet, revision),
    fetchParentTree('subscriptions', 'subscriptions', settings, hiddenSet, revision),
    fetchParentTree('esim', 'esim', settings, hiddenSet, revision),
    fetchParentTree('rewarble', 'rewarble', settings, hiddenSet, revision),
    fetchPopularCatalogItems(settings, hiddenSet).catch(() => []),
  ]);

  const popularKeywords = [
    'free fire',
    'pubg',
    'mobile legends',
    'roblox',
    'valorant',
    'call of duty',
    'brawl stars',
    'apple',
    'google play',
    'steam',
    'telegram',
  ];

  const allAvailableBundles = [
    ...topupsBundles,
    ...appStoresBundles,
    ...gameCurrencyBundles,
    ...subscriptionsBundles,
  ];

  const popularBundles = allAvailableBundles.filter((b) => {
    const n = b.name.toLowerCase();
    return popularKeywords.some((k) => n.includes(k));
  });

  const catalog = {
    isEnabled: settings.isEnabled,
    defaultMargin: settings.defaultProfitMarginPercent,
    popularBundles,
    sections: {
      popular: {
        id: 'popular',
        nameAr: 'الأكثر شعبية',
        nameEn: 'Most Popular',
        bundles: popularBundles,
        items: popularLegacyItems,
      },
      topups: {
        id: 'topups',
        nameAr: 'شحن الألعاب المباشر',
        nameEn: 'In-Game Top-Ups',
        icon: 'sports_esports',
        bundles: topupsBundles,
        items: popularLegacyItems.slice(0, 10),
      },
      appStores: {
        id: 'app-stores',
        nameAr: 'متاجر التطبيقات',
        nameEn: 'App Stores',
        icon: 'store',
        bundles: appStoresBundles,
        items: [],
      },
      gameCurrency: {
        id: 'game-currency',
        nameAr: 'أكواد وبطاقات الألعاب',
        nameEn: 'Game Codes & Vouchers',
        icon: 'vpn_key',
        bundles: gameCurrencyBundles,
        items: [],
      },
      subscriptions: {
        id: 'subscriptions',
        nameAr: 'الاشتراكات والترفيه',
        nameEn: 'Subscriptions',
        icon: 'subscriptions',
        bundles: subscriptionsBundles,
        items: [],
      },
      esim: {
        id: 'esim',
        nameAr: 'شرائح الإنترنت eSIM',
        nameEn: 'eSIM',
        icon: 'sim_card',
        bundles: esimBundles,
        items: [],
      },
      rewarble: {
        id: 'rewarble',
        nameAr: 'Rewarble',
        nameEn: 'Rewarble',
        icon: 'wallet',
        bundles: rewarbleBundles,
        items: [],
      },
    },
    totalBundlesCount:
      topupsBundles.length +
      appStoresBundles.length +
      gameCurrencyBundles.length +
      subscriptionsBundles.length +
      esimBundles.length +
      rewarbleBundles.length,
    updatedAt: new Date().toISOString(),
  };

  if (revision !== foxCatalogRevision) throw new Error('FoxReload catalog settings changed during refresh');
  catalogCache = { timestamp: now, data: catalog };
  invalidateCatalogRevision();
  if (lastProductsSnapshot) await persistAvailableSnapshot();
  return catalog;
}

function mapProductItem(p: any, settings: FoxreloadSettings, hiddenSet: Set<string>, categorySlug: string) {
  const cost = typeof p.price === 'number' ? p.price
    : (typeof p.price === 'string' && p.price.trim() ? Number(p.price) : NaN);
  const { finalPrice, marginAmount, marginPercent } = computeClientPrice(cost, p.id, settings);
  const stock = typeof p.quantity === 'number' ? p.quantity : 999;

  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    categoryId: p.categoryId,
    categorySlug,
    costPrice: cost,
    price: finalPrice,
    marginAmount,
    marginPercent,
    currency: 'USD',
    stock,
    minQty: p.orderMinQuantity || 1,
    maxQty: p.orderMaxQuantity || null,
    deliveryType: p.deliveryType || (p.isService ? 'topup' : 'code'),
    isService: Boolean(p.isService),
    requiredNoteFields: Array.isArray(p.requiredNoteFields) ? p.requiredNoteFields : [],
    noteFieldOptions: p.noteFieldOptions || {},
    noteFieldTypes: p.noteFieldTypes || {},
    attributes: p.attributes || {},
    userGuide: p.userGuide || null,
    imagePath: p.imagePath || p.image || p.imageUrl || null,
    thumbnailPath: p.thumbnailPath || p.thumbnail || null,
    isHidden: hiddenSet.has(p.id) || hiddenSet.has(p.slug) || hiddenSet.has(p.categoryId) || hiddenSet.has(categorySlug),
  };
}

function isValidProduct(item: any): boolean {
  return (
    Boolean(item) &&
    Number.isFinite(item.costPrice) &&
    item.costPrice >= 0 &&
    Number.isFinite(item.price) &&
    item.price >= 0 &&
    typeof item.stock === 'number' &&
    item.stock > 0 &&
    !item.isHidden
  );
}

async function fetchSearchBatch(query: string, limit: number = 25): Promise<any[]> {
  const res = await callFoxreloadApi(`/api/products/search?query=${encodeURIComponent(query)}&limit=${limit}`);
  return Array.isArray(res.data) ? res.data : [];
}

async function fetchCategoryBatch(categoryId: string, limit: number = 50): Promise<any[]> {
  const res = await callFoxreloadApi(`/api/products/?categoryId=${categoryId}&limit=${limit}`);
  return Array.isArray(res.data?.items) ? res.data.items : [];
}

async function fetchTelegramCatalogItems(settings: FoxreloadSettings, hiddenSet: Set<string>) {
  const raw = await fetchSearchBatch('telegram', 30);
  return raw
    .map((p) => mapProductItem(p, settings, hiddenSet, 'telegram'))
    .filter(isValidProduct);
}

async function fetchSteamCatalogItems(settings: FoxreloadSettings, hiddenSet: Set<string>) {
  const raw = await fetchSearchBatch('steam', 30);
  return raw
    .map((p) => mapProductItem(p, settings, hiddenSet, 'steam'))
    .filter(isValidProduct);
}

async function fetchRewarbleCatalogItems(settings: FoxreloadSettings, hiddenSet: Set<string>) {
  const searchItems = await fetchSearchBatch('rewarble', 30);
  if (searchItems.length > 0) {
    return searchItems
      .map((p) => mapProductItem(p, settings, hiddenSet, 'rewarble'))
      .filter(isValidProduct);
  }
  const categoryItems = await fetchCategoryBatch('019e111c-aefa-7680-9944-a8449cb42886', 30);
  return categoryItems
    .map((p) => mapProductItem(p, settings, hiddenSet, 'rewarble'))
    .filter(isValidProduct);
}

async function fetchEsimCatalogItems(settings: FoxreloadSettings, hiddenSet: Set<string>) {
  const [categoryItems, searchItems] = await Promise.all([
    fetchCategoryBatch('019d1fd6-08bb-76b2-bdc0-7eda9b480555', 30),
    fetchSearchBatch('esim', 20)
  ]);
  const combined = [...categoryItems, ...searchItems];
  const seen = new Set<string>();
  const unique = combined.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    const title = String(item.name || '').toLowerCase();
    const isRealEsim = title.includes('esim') || item.categoryId === '019d1fd6-08bb-76b2-bdc0-7eda9b480555';
    return isRealEsim;
  });

  return unique
    .map((p) => mapProductItem(p, settings, hiddenSet, 'esim'))
    .filter(isValidProduct);
}

async function fetchGamesCatalogItems(settings: FoxreloadSettings, hiddenSet: Set<string>) {
  const [pubg, freefire, roblox, valorant, ml, playstation, xbox] = await Promise.all([
    fetchSearchBatch('pubg', 15),
    fetchSearchBatch('free fire', 15),
    fetchSearchBatch('roblox', 12),
    fetchSearchBatch('valorant', 10),
    fetchSearchBatch('mobile legends', 12),
    fetchSearchBatch('playstation', 12),
    fetchSearchBatch('xbox', 10),
  ]);

  const all = [...pubg, ...freefire, ...roblox, ...valorant, ...ml, ...playstation, ...xbox];
  const seen = new Set<string>();
  const unique = all.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  return unique
    .map((p) => mapProductItem(p, settings, hiddenSet, 'games'))
    .filter(isValidProduct);
}

async function fetchServicesCatalogItems(settings: FoxreloadSettings, hiddenSet: Set<string>) {
  const [googleplay, itunes, apple, spotify, razer] = await Promise.all([
    fetchSearchBatch('google play', 15),
    fetchSearchBatch('itunes', 12),
    fetchSearchBatch('apple', 12),
    fetchSearchBatch('spotify', 10),
    fetchSearchBatch('razer', 10),
  ]);

  const all = [...googleplay, ...itunes, ...apple, ...spotify, ...razer];
  const seen = new Set<string>();
  const unique = all.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  return unique
    .map((p) => mapProductItem(p, settings, hiddenSet, 'services'))
    .filter(isValidProduct);
}

async function fetchPopularCatalogItems(settings: FoxreloadSettings, hiddenSet: Set<string>) {
  const [telegram, games, services, steam] = await Promise.all([
    fetchTelegramCatalogItems(settings, hiddenSet),
    fetchGamesCatalogItems(settings, hiddenSet),
    fetchServicesCatalogItems(settings, hiddenSet),
    fetchSteamCatalogItems(settings, hiddenSet),
  ]);

  const popularCandidates = [
    ...(telegram.slice(0, 4)),
    ...(games.slice(0, 8)),
    ...(services.slice(0, 4)),
    ...(steam.slice(0, 4)),
  ];

  const seen = new Set<string>();
  const unique = popularCandidates.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  return unique;
}

export async function createAndDispatchFoxreloadOrder(params: {
  productId: string;
  quantity: number;
  notes?: Record<string, any>;
}): Promise<{
  success: boolean;
  orderId?: string;
  status?: string;
  codes?: string[];
  externalData?: any;
  error?: string;
}> {
  const createPayload = {
    items: [
      {
        itemId: params.productId,
        quantity: Math.max(1, params.quantity || 1),
        ...(params.notes && Object.keys(params.notes).length > 0 ? { notes: params.notes } : {}),
      },
    ],
  };

  const createRes = await callFoxreloadApi('/api/orders/', 'POST', createPayload);
  if (!createRes.ok || !createRes.data?.id) {
    const errorMsg = createRes.data?.detail || createRes.data?.message || createRes.raw || 'فشل إنشاء الطلب لدى FoxReload';
    return {
      success: false,
      error: typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg),
    };
  }

  const orderId = createRes.data.id;

  const payRes = await callFoxreloadApi(`/api/orders/${orderId}/pay`, 'POST', { paymentProvider: null });
  if (!payRes.ok) {
    const payError = payRes.data?.detail || payRes.data?.message || payRes.raw || 'تم إنشاء الطلب ولكن فشل خصم الرصيد في FoxReload';
    return {
      success: false,
      orderId,
      status: 'created_unpaid',
      error: typeof payError === 'string' ? payError : JSON.stringify(payError),
    };
  }

  let finalStatus = payRes.data?.status || 'processing';
  let codes: string[] = [];
  let externalData: any = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    const checkRes = await callFoxreloadApi(`/api/orders/${orderId}`, 'GET');
    if (checkRes.ok && checkRes.data) {
      finalStatus = checkRes.data.status || finalStatus;
      const items = checkRes.data.items || [];
      for (const item of items) {
        if (item.externalData) {
          externalData = item.externalData;
          if (typeof item.externalData === 'string') {
            codes.push(item.externalData);
          } else if (item.externalData.code) {
            codes.push(item.externalData.code);
          } else if (item.externalData.pin) {
            codes.push(item.externalData.pin);
          } else if (Array.isArray(item.externalData.codes)) {
            codes.push(...item.externalData.codes);
          }
        }
      }
      if (finalStatus === 'completed' || finalStatus === 'finished') {
        break;
      }
    }
  }

  return {
    success: true,
    orderId,
    status: finalStatus,
    codes,
    externalData,
  };
}

export async function getFoxreloadOrderDetails(orderId: string | number): Promise<{
  success: boolean;
  status: 'completed' | 'rejected' | 'processing' | 'unknown';
  codes: string[];
  reply?: string;
  error?: string;
  raw?: any;
}> {
  try {
    const checkRes = await callFoxreloadApi(`/api/orders/${orderId}`, 'GET');
    if (!checkRes.ok || !checkRes.data) {
      const errorMsg =
        checkRes.data?.detail ||
        checkRes.data?.error ||
        checkRes.data?.message ||
        checkRes.raw ||
        'Failed to fetch order from FoxReload';
      return {
        success: false,
        status: 'unknown',
        codes: [],
        error: typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg),
      };
    }

    const rawStatus = String(checkRes.data.status || 'processing').toLowerCase();
    const codes: string[] = [];
    const items = Array.isArray(checkRes.data.items) ? checkRes.data.items : [];

    for (const item of items) {
      if (item.externalData) {
        if (typeof item.externalData === 'string') {
          codes.push(item.externalData);
        } else if (item.externalData.code) {
          codes.push(item.externalData.code);
        } else if (item.externalData.pin) {
          codes.push(item.externalData.pin);
        } else if (Array.isArray(item.externalData.codes)) {
          codes.push(...item.externalData.codes);
        }
      }
    }

    let status: 'completed' | 'rejected' | 'processing' | 'unknown' = 'processing';
    if (['completed', 'finished', 'success', 'delivered'].includes(rawStatus)) {
      status = 'completed';
    } else if (['canceled', 'cancelled', 'failed', 'rejected', 'refunded'].includes(rawStatus)) {
      status = 'rejected';
    } else if (['pending', 'processing', 'in_process', 'submitted'].includes(rawStatus)) {
      status = 'processing';
    }

    const reply = codes.length > 0 ? codes.join('\n') : (status === 'completed' ? 'تم التفعيل والشحن بنجاح' : undefined);

    return {
      success: true,
      status,
      codes,
      reply,
      raw: checkRes.data,
    };
  } catch (err: any) {
    return {
      success: false,
      status: 'unknown',
      codes: [],
      error: err.message || 'Exception while checking FoxReload order',
    };
  }
}
