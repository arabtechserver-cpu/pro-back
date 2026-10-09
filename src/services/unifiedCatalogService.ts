import { prisma } from '../utils/prisma';
import {
  getFoxreloadFullCatalog,
  getFoxreloadCategoryProducts,
  getFoxreloadAllProducts,
  getAvailableFoxreloadCatalog,
  AvailableFoxreloadCatalog,
  getFoxreloadSettings,
  computeClientPrice,
  callFoxreloadApi,
  FoxreloadProduct
} from './foxreloadService';
import { resolveOrderServiceType } from '../utils/order-response';
import { createHash } from 'crypto';
import { mapWithinDeadline } from '../utils/request-deadline';
import { BoundedCache } from '../utils/bounded-cache';
import { AsyncGate } from '../utils/async-gate';
import { getCatalogRevision } from '../utils/catalog-revision';
import { getCatalogSection } from '../utils/catalog-section';
import { foxreloadCustomFields } from '../utils/foxreload-contract';
const mergedBuilds = new AsyncGate(1, 64, 22000);

function dhruGroupId(name: string): string {
  return `dhru-group-${createHash('sha256').update(name).digest('hex')}`;
}

export interface UnifiedSection {
  id: string;
  nameAr: string;
  nameEn: string;
  icon: string;
  type: 'foxreload' | 'dhru';
  totalServices: number;
}

export interface UnifiedServiceSummary {
  id: string;
  slug: string;
  name: string;
  sectionId: string;
  sectionNameAr: string;
  icon?: string | null;
  imagePath?: string | null;
  thumbnailPath?: string | null;
  inStockCount: number;
  regions: {
    id: string;
    slug: string;
    name: string;
    inStockCount: number;
    hasProducts: boolean;
    bestOfferPrice?: string | null;
  }[];
}

export interface UnifiedPackage {
  id: string;
  slug?: string;
  name: string;
  description?: string | null;
  serviceId: string;
  serviceName: string;
  sectionId: string;
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
  requiredFields: string[];
  noteFieldTypes?: Record<string, string>;
  noteFieldOptions?: Record<string, any>;
  userGuide?: string | null;
}

const SECTION_METADATA: Record<string, { nameAr: string; nameEn: string; icon: string }> = {
  popular: { nameAr: 'الأكثر شعبية', nameEn: 'Most Popular', icon: 'local_fire_department' },
  topups: { nameAr: 'شحن الألعاب المباشر', nameEn: 'In-Game Top-Ups', icon: 'sports_esports' },
  appStores: { nameAr: 'متاجر التطبيقات', nameEn: 'App Stores', icon: 'store' },
  'app-stores': { nameAr: 'متاجر التطبيقات', nameEn: 'App Stores', icon: 'store' },
  gameCurrency: { nameAr: 'أكواد وبطاقات الألعاب', nameEn: 'Game Codes & Vouchers', icon: 'vpn_key' },
  'game-currency': { nameAr: 'أكواد وبطاقات الألعاب', nameEn: 'Game Codes & Vouchers', icon: 'vpn_key' },
  subscriptions: { nameAr: 'الاشتراكات والترفيه', nameEn: 'Subscriptions', icon: 'subscriptions' },
  esim: { nameAr: 'شرائح الإنترنت eSIM', nameEn: 'eSIM', icon: 'sim_card' },
  rewarble: { nameAr: 'قسائم Rewarble', nameEn: 'Rewarble', icon: 'account_balance_wallet' },
  'dhru-server': { nameAr: 'خدمات السيرفر DHRU', nameEn: 'Server Services', icon: 'dns' },
  'dhru-imei': { nameAr: 'خدمات IMEI الرسمية', nameEn: 'IMEI Services', icon: 'smartphone' },
  'dhru-remote': { nameAr: 'خدمات التحكم والريموت', nameEn: 'Remote Services', icon: 'settings_remote' }
};

let sectionsCache: { timestamp: number; revision: number; data: UnifiedSection[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getUnifiedSections(): Promise<UnifiedSection[]> {
  const now = Date.now();
  const revision = getCatalogRevision();
  if (sectionsCache && sectionsCache.revision === revision && now - sectionsCache.timestamp < CACHE_TTL_MS) {
    return sectionsCache.data;
  }

  const [foxCatalog, dhruCounts] = await Promise.all([
    getFoxreloadFullCatalog(false),
    prisma.dhruCategory.findMany({
      select: {
        id: true,
        name: true,
        _count: {
          select: {
            dhruServices: {
              where: { isActive: true, OR: [{ apiProvider: { isActive: true } }, { providerId: null }] }
            }
          }
        }
      }
    })
  ]);

  const sections: UnifiedSection[] = [];

  if (foxCatalog?.sections) {
    const s = foxCatalog.sections;
    if (s.popular) {
      sections.push({
        id: 'popular',
        nameAr: SECTION_METADATA.popular.nameAr,
        nameEn: SECTION_METADATA.popular.nameEn,
        icon: SECTION_METADATA.popular.icon,
        type: 'foxreload',
        totalServices: s.popular.bundles?.length || 0
      });
    }
    if (s.topups) {
      sections.push({
        id: 'topups',
        nameAr: SECTION_METADATA.topups.nameAr,
        nameEn: SECTION_METADATA.topups.nameEn,
        icon: SECTION_METADATA.topups.icon,
        type: 'foxreload',
        totalServices: s.topups.bundles?.length || 0
      });
    }
    if (s.appStores) {
      sections.push({
        id: 'app-stores',
        nameAr: SECTION_METADATA.appStores.nameAr,
        nameEn: SECTION_METADATA.appStores.nameEn,
        icon: SECTION_METADATA.appStores.icon,
        type: 'foxreload',
        totalServices: s.appStores.bundles?.length || 0
      });
    }
    if (s.gameCurrency) {
      sections.push({
        id: 'game-currency',
        nameAr: SECTION_METADATA.gameCurrency.nameAr,
        nameEn: SECTION_METADATA.gameCurrency.nameEn,
        icon: SECTION_METADATA.gameCurrency.icon,
        type: 'foxreload',
        totalServices: s.gameCurrency.bundles?.length || 0
      });
    }
    if (s.subscriptions) {
      sections.push({
        id: 'subscriptions',
        nameAr: SECTION_METADATA.subscriptions.nameAr,
        nameEn: SECTION_METADATA.subscriptions.nameEn,
        icon: SECTION_METADATA.subscriptions.icon,
        type: 'foxreload',
        totalServices: s.subscriptions.bundles?.length || 0
      });
    }
    if (s.esim) {
      sections.push({
        id: 'esim',
        nameAr: SECTION_METADATA.esim.nameAr,
        nameEn: SECTION_METADATA.esim.nameEn,
        icon: SECTION_METADATA.esim.icon,
        type: 'foxreload',
        totalServices: s.esim.bundles?.length || 0
      });
    }
    if (s.rewarble) {
      sections.push({
        id: 'rewarble',
        nameAr: SECTION_METADATA.rewarble.nameAr,
        nameEn: SECTION_METADATA.rewarble.nameEn,
        icon: SECTION_METADATA.rewarble.icon,
        type: 'foxreload',
        totalServices: s.rewarble.bundles?.length || 0
      });
    }
  }

  for (const cat of dhruCounts) {
    const lower = cat.name.toLowerCase();
    let secId = 'dhru-server';
    let meta = SECTION_METADATA['dhru-server'];

    if (lower.includes('imei')) {
      secId = 'dhru-imei';
      meta = SECTION_METADATA['dhru-imei'];
    } else if (lower.includes('remote')) {
      secId = 'dhru-remote';
      meta = SECTION_METADATA['dhru-remote'];
    }

    sections.push({
      id: secId,
      nameAr: meta.nameAr,
      nameEn: meta.nameEn,
      icon: meta.icon,
      type: 'dhru',
      totalServices: cat._count.dhruServices
    });
  }

  const uniqueSections = new Map<string, UnifiedSection>();
  for (const section of sections) {
    const existing = uniqueSections.get(section.id);
    if (existing) existing.totalServices += section.totalServices;
    else uniqueSections.set(section.id, { ...section });
  }
  const data = Array.from(uniqueSections.values());
  sectionsCache = { timestamp: now, revision, data };
  return data;
}

export async function getUnifiedServices(sectionId?: string): Promise<UnifiedServiceSummary[]> {
  const normalizedSec = (sectionId || '').trim().toLowerCase();
  const foxCatalog = normalizedSec.startsWith('dhru-') || ['server', 'imei', 'remote'].includes(normalizedSec)
    ? null : await getFoxreloadFullCatalog(false);
  const results: UnifiedServiceSummary[] = [];

  const mapFoxBundles = (bundles: any[], secKey: string, nameAr: string) => {
    for (const b of bundles || []) {
      results.push({
        id: b.id,
        slug: b.slug,
        name: b.name,
        sectionId: secKey,
        sectionNameAr: nameAr,
        icon: SECTION_METADATA[secKey]?.icon,
        imagePath: b.imagePath,
        thumbnailPath: b.thumbnailPath,
        inStockCount: b.inStockCount || 0,
        regions: (b.regions || []).map((r: any) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          inStockCount: r.inStockCount || 0,
          hasProducts: Boolean(r.hasProducts),
          bestOfferPrice: r.bestOfferPrice || null
        }))
      });
    }
  };

  if (foxCatalog?.sections) {
    const s = foxCatalog.sections;
    if (!normalizedSec || normalizedSec === 'popular') {
      mapFoxBundles(s.popular?.bundles, 'popular', SECTION_METADATA.popular.nameAr);
    }
    if (!normalizedSec || normalizedSec === 'topups') {
      mapFoxBundles(s.topups?.bundles, 'topups', SECTION_METADATA.topups.nameAr);
    }
    if (!normalizedSec || normalizedSec === 'app-stores' || normalizedSec === 'appstores') {
      mapFoxBundles(s.appStores?.bundles, 'app-stores', SECTION_METADATA.appStores.nameAr);
    }
    if (!normalizedSec || normalizedSec === 'game-currency' || normalizedSec === 'gamecurrency') {
      mapFoxBundles(s.gameCurrency?.bundles, 'game-currency', SECTION_METADATA.gameCurrency.nameAr);
    }
    if (!normalizedSec || normalizedSec === 'subscriptions') {
      mapFoxBundles(s.subscriptions?.bundles, 'subscriptions', SECTION_METADATA.subscriptions.nameAr);
    }
    if (!normalizedSec || normalizedSec === 'esim') {
      mapFoxBundles(s.esim?.bundles, 'esim', SECTION_METADATA.esim.nameAr);
    }
    if (!normalizedSec || normalizedSec === 'rewarble') {
      mapFoxBundles(s.rewarble?.bundles, 'rewarble', SECTION_METADATA.rewarble.nameAr);
    }
  }

  if (!normalizedSec || normalizedSec.startsWith('dhru-') || ['server', 'imei', 'remote'].includes(normalizedSec)) {
    const dhruWhere: any = { isActive: true };
    if (normalizedSec === 'dhru-imei' || normalizedSec === 'imei') {
      dhruWhere.dhruCategory = { name: { contains: 'imei', mode: 'insensitive' } };
    } else if (normalizedSec === 'dhru-remote' || normalizedSec === 'remote') {
      dhruWhere.dhruCategory = { name: { contains: 'remote', mode: 'insensitive' } };
    } else if (normalizedSec === 'dhru-server' || normalizedSec === 'server') {
      dhruWhere.dhruCategory = { name: { contains: 'server', mode: 'insensitive' } };
    }

    const dhruServices = await prisma.dhruService.findMany({
      where: dhruWhere,
      select: {
        id: true,
        dhruId: true,
        name: true,
        groupName: true,
        dhruCategory: { select: { id: true, name: true } }
      },
      orderBy: [{ groupName: 'asc' }, { name: 'asc' }],
    });

    const groupsMap = new Map<string, { id: string; name: string; count: number; catName: string }>();
    for (const ds of dhruServices) {
      const gName = ds.groupName || ds.dhruCategory?.name || 'سيرفر عام';
      const existing = groupsMap.get(gName);
      if (existing) {
        existing.count++;
      } else {
        groupsMap.set(gName, {
          id: dhruGroupId(gName),
          name: gName,
          count: 1,
          catName: ds.dhruCategory?.name || 'Server Service'
        });
      }
    }

    for (const [, grp] of groupsMap.entries()) {
      const isImei = grp.catName.toLowerCase().includes('imei');
      const secKey = isImei ? 'dhru-imei' : (grp.catName.toLowerCase().includes('remote') ? 'dhru-remote' : 'dhru-server');
      results.push({
        id: grp.id,
        slug: grp.id,
        name: grp.name,
        sectionId: secKey,
        sectionNameAr: SECTION_METADATA[secKey]?.nameAr || grp.catName,
        icon: SECTION_METADATA[secKey]?.icon,
        inStockCount: grp.count,
        regions: [
          {
            id: grp.id,
            slug: 'global',
            name: 'Global',
            inStockCount: grp.count,
            hasProducts: true
          }
        ]
      });
    }
  }

  return results;
}

export async function getUnifiedPackages(
  serviceId: string,
  userMarginPercent: number = 8.0
): Promise<{ serviceName: string; sectionId: string; packages: UnifiedPackage[] }> {
  const margin = Math.max(0, userMarginPercent);
  const targetId = serviceId.trim();

  const isDhruGroup = targetId.startsWith('dhru-group-');
  const dhruServices = await prisma.dhruService.findMany({
    where: {
      isActive: true,
      ...(isDhruGroup ? {} : { OR: [
        { id: targetId },
        { dhruId: targetId },
        { groupName: targetId }
      ] })
    },
    include: { dhruCategory: true }
  }).then((services) => isDhruGroup ? services.filter((srv) => {
    const name = srv.groupName || srv.dhruCategory?.name || 'سيرفر عام';
    const resolved = resolveOrderServiceType(srv.apiServiceType, srv.dhruCategory?.name, srv.groupName);
    const type = resolved === 'unknown' ? 'server' : resolved;
    const section = getCatalogSection(type, srv.dhruCategory?.name, name);
    return dhruGroupId(JSON.stringify([type, section, name])) === targetId || dhruGroupId(name) === targetId || `dhru-group-${Buffer.from(name).toString('hex').slice(0, 16)}` === targetId;
  }) : services);
  if (isDhruGroup && dhruServices.length === 0) {
    const merged = await getDhruCompatibleMergedCatalog(margin);
    const group = merged.groupsObject[targetId];
    if (group?.bundle_id) {
      return { serviceName: group.GROUPNAME, sectionId: group.section_id,
        packages: Object.values(group.SERVICES).map((s: any) => {
          const price = Number(s.CREDIT);
          const costPrice = Number((price / (1 + margin / 100)).toFixed(4));
          return { id: s.SERVICEID, slug: s.slug, name: s.product_name, description: s.description,
            serviceId: group.GROUPID, serviceName: group.GROUPNAME, sectionId: group.section_id,
            costPrice, price, marginAmount: price - costPrice, marginPercent: margin, currency: s.currency,
            stock: s.stock, minQty: s.orderMinQuantity, maxQty: s.orderMaxQuantity, deliveryType: s.deliveryType,
            isService: s.isService, requiredFields: s.requiredNoteFields, noteFieldTypes: s.noteFieldTypes,
            noteFieldOptions: s.noteFieldOptions, userGuide: s.userGuide, attributes: s.attributes,
            bundle_id: s.bundle_id, bundle_name: s.bundle_name, region_id: s.region_id, region_name: s.region_name };
        }) };
    }
  }
  const foxCatalog = (isDhruGroup || dhruServices.length > 0) ? null : await getFoxreloadFullCatalog(false);
  let foundBundle: any = null;
  let sectionKey = 'topups';

  if (foxCatalog?.sections) {
    for (const [key, sec] of Object.entries(foxCatalog.sections)) {
      const bundles = (sec as any).bundles || [];
      const match = bundles.find((b: any) => b.id === targetId || b.slug === targetId);
      if (match) {
        foundBundle = match;
        sectionKey = key;
        break;
      }
    }
  }

  const categoryIdsToFetch: string[] = [];
  if (foundBundle) {
    if (foundBundle.regions && foundBundle.regions.length > 0) {
      for (const r of foundBundle.regions) {
        if (r.id) categoryIdsToFetch.push(r.id);
      }
    } else {
      categoryIdsToFetch.push(foundBundle.id);
    }
  } else if (!isDhruGroup && dhruServices.length === 0) {
    categoryIdsToFetch.push(targetId);
  }

  const productBatches = await mapWithinDeadline(categoryIdsToFetch, catId => getFoxreloadCategoryProducts(catId, false), 12, 12000);

  const rawProducts = productBatches.flat();
  const seenIds = new Set<string>();
  const uniqueProducts = rawProducts.filter((p) => {
    if (!p?.id || seenIds.has(p.id)) return false;
    seenIds.add(p.id);
    return true;
  });

  if (uniqueProducts.length > 0) {
    const sName = foundBundle?.name || uniqueProducts[0]?.name || 'خدمة رقمية';
    const packages: UnifiedPackage[] = uniqueProducts.map((p) => {
      const baseCost = Math.max(0, p.costPrice || 0);
      const finalPrice = Number((baseCost * (1 + margin / 100)).toFixed(4));
      const marginAmount = Number((finalPrice - baseCost).toFixed(4));

      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        description: p.description,
        serviceId: foundBundle?.id || p.categoryId,
        serviceName: sName,
        sectionId: sectionKey,
        costPrice: baseCost,
        price: finalPrice,
        marginAmount,
        marginPercent: margin,
        currency: 'USD',
        stock: p.stock ?? 0,
        minQty: p.minQty || 1,
        maxQty: p.maxQty,
        deliveryType: p.deliveryType || 'code',
        isService: Boolean(p.isService),
        requiredFields: Array.isArray(p.requiredNoteFields) ? p.requiredNoteFields : [],
        noteFieldTypes: p.noteFieldTypes,
        noteFieldOptions: p.noteFieldOptions,
        userGuide: p.userGuide,
        attributes: p.attributes,
        categoryId: p.categoryId,
        bundle_id: foundBundle?.id || p.categoryId,
        bundle_name: foundBundle?.name || sName,
        region_id: foundBundle?.regions?.find((region: any) => region.id === p.categoryId)?.id || null,
        region_name: foundBundle?.regions?.find((region: any) => region.id === p.categoryId)?.name || null
      };
    });

    return {
      serviceName: sName,
      sectionId: sectionKey,
      packages
    };
  }



  if (dhruServices.length > 0) {
    const first = dhruServices[0];
    const sName = first.groupName || first.name;
    const isImei = (first.dhruCategory?.name || '').toLowerCase().includes('imei');
    const secKey = isImei ? 'dhru-imei' : ((first.dhruCategory?.name || '').toLowerCase().includes('remote') ? 'dhru-remote' : 'dhru-server');

    const packages: UnifiedPackage[] = dhruServices.map((srv) => {
      const baseCost = Math.max(0, srv.credit || 0);
      const finalPrice = Number((baseCost * (1 + margin / 100)).toFixed(4));
      const marginAmount = Number((finalPrice - baseCost).toFixed(4));

      let customReq: any[] = [];
      if (srv.requiresCustom) {
        try {
          const parsed = typeof srv.requiresCustom === 'string' ? JSON.parse(srv.requiresCustom) : srv.requiresCustom;
          if (Array.isArray(parsed)) customReq = parsed;
          else if (typeof parsed === 'object' && parsed !== null) customReq = Object.values(parsed);
        } catch {}
      }

      const reqFields: string[] = [];
      if (isImei) reqFields.push('IMEI');
      for (const f of customReq) {
        const fname = f.name || f.fieldname || f.label;
        if (fname && !reqFields.includes(fname)) reqFields.push(String(fname));
      }

      return {
        id: srv.id,
        name: srv.name,
        serviceId: srv.groupName || srv.id,
        serviceName: srv.groupName || srv.name,
        sectionId: secKey,
        costPrice: baseCost,
        price: finalPrice,
        marginAmount,
        marginPercent: margin,
        currency: 'USD',
        stock: 999999,
        minQty: srv.minQty || 1,
        maxQty: srv.maxQty || null,
        deliveryType: isImei ? 'imei' : 'server',
        isService: true,
        requiredFields: reqFields,
        userGuide: srv.info
      };
    });

    return {
      serviceName: sName,
      sectionId: secKey,
      packages
    };
  }

  return {
    serviceName: 'غير معروف',
    sectionId: 'unknown',
    packages: []
  };
}

let catalogTreeCache: { timestamp: number; margin: number; revision: number; data: any } | null = null;

export async function getUnifiedCatalogTree(userMarginPercent: number = 8.0): Promise<any> {
  const margin = Math.max(0, userMarginPercent);
  const now = Date.now();

  const revision = getCatalogRevision();
  if (catalogTreeCache && catalogTreeCache.revision === revision && catalogTreeCache.margin === margin && now - catalogTreeCache.timestamp < CACHE_TTL_MS) {
    return catalogTreeCache.data;
  }

  const [sections, foxCatalog] = await Promise.all([
    getUnifiedSections(),
    getFoxreloadFullCatalog(false)
  ]);

  const treeSections = await Promise.all(sections.map(async (sec) => {
    let bundles: any[] = [];
    if (foxCatalog?.sections) {
      if (sec.id === 'popular') bundles = foxCatalog.sections.popular?.bundles || [];
      else if (sec.id === 'topups') bundles = foxCatalog.sections.topups?.bundles || [];
      else if (sec.id === 'app-stores') bundles = foxCatalog.sections.appStores?.bundles || [];
      else if (sec.id === 'game-currency') bundles = foxCatalog.sections.gameCurrency?.bundles || [];
      else if (sec.id === 'subscriptions') bundles = foxCatalog.sections.subscriptions?.bundles || [];
      else if (sec.id === 'esim') bundles = foxCatalog.sections.esim?.bundles || [];
      else if (sec.id === 'rewarble') bundles = foxCatalog.sections.rewarble?.bundles || [];
    }

    if (sec.type === 'dhru') bundles = await getUnifiedServices(sec.id);

    return {
      id: sec.id,
      nameAr: sec.nameAr,
      nameEn: sec.nameEn,
      icon: sec.icon,
      type: sec.type,
      totalServices: sec.totalServices,
      services: bundles.map((b) => ({
        id: b.id,
        slug: b.slug,
        name: b.name,
        inStockCount: b.inStockCount || 0,
        regions: b.regions || [],
        fetchPackagesUrl: `/api/v1/provider/service/${b.id}/packages`
      }))
    };
  }));

  const response = {
    success: true,
    marginPercent: margin,
    totalSections: treeSections.length,
    sections: treeSections,
    updatedAt: new Date().toISOString()
  };

  catalogTreeCache = { timestamp: now, margin, revision, data: response };
  return response;
}

const dhruMergedCaches = new BoundedCache<string, { timestamp: number; data: any }>(2, 24 * 1024 * 1024, 30 * 60 * 1000);
const mergedInFlight = new Map<string, Promise<any>>();

export async function getDhruCompatibleMergedCatalog(
  userMarginPercent: number = 8.0,
  filterType: 'imei' | 'server' | 'remote' | 'all' = 'all',
  sectionFilter?: string
): Promise<{ groupsList: any[]; groupsObject: Record<string, any>; totalServices: number; catalogComplete: boolean; refreshingSources: string[] }> {
  // Local protocols need no upstream calls; other views reuse the available shared snapshot.
  const localOnly = ['imei', 'remote'].includes(filterType) || ['imei', 'remote', 'dhru-imei', 'dhru-remote'].includes((sectionFilter || '').trim().toLowerCase());
  const available = localOnly
    ? { catalog: { sections: {} }, products: [], complete: true, refreshing: false }
    : await getAvailableFoxreloadCatalog();
  const revision = getCatalogRevision();
  const key = `${revision}_${Math.max(0, userMarginPercent)}_${localOnly ? 'local' : 'merged'}_${available.complete}`;
  const cached = dhruMergedCaches.get(key);
  const select = (data: any) => {
    const section = (sectionFilter || '').trim().toLowerCase();
    const groupsList = data.groupsList.filter((group: any) =>
      (filterType === 'all' || group.service_type === filterType) &&
      (!section || section === 'all' || group.section_id === section || group.service_type === section)
    );
    return {
      groupsList,
      groupsObject: Object.fromEntries(groupsList.map((group: any) => [group.GROUPID, { ...group, SERVICES: group.services_map }])),
      totalServices: groupsList.reduce((total: number, group: any) => total + group.SERVICES.length, 0),
      catalogComplete: data.catalogComplete || (data.completeSections || []).includes(section),
      refreshingSources: data.catalogComplete || (data.completeSections || []).includes(section) ? [] : ['foxreload']
    };
  };
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return select(cached.data);
  let work = mergedInFlight.get(key);
  if (!work) {
    work = mergedBuilds.run(() => buildDhruCompatibleMergedCatalog(userMarginPercent, available))
      .then(data => {
        // A background publication must not fail an otherwise usable DB response.
        if (revision === getCatalogRevision()) dhruMergedCaches.set(key, { timestamp: Date.now(), data });
        return data;
      })
      .finally(() => { mergedInFlight.delete(key); });
    mergedInFlight.set(key, work);
  }
  if (cached) { work.catch(() => {}); return select(cached.data); }
  return select(await work);
}

async function buildDhruCompatibleMergedCatalog(
  userMarginPercent: number = 8.0,
  available: AvailableFoxreloadCatalog
): Promise<{ groupsList: any[]; groupsObject: Record<string, any>; totalServices: number; catalogComplete: boolean }> {
  const margin = Math.max(0, userMarginPercent);

  const groupsMap = new Map<string, any>();
  const groupsObject: Record<string, any> = {};
  let totalServicesCount = 0;

  const ensureGroup = (groupName: string, categoryName: string, type: string, sectionId: string, sourceIdentity?: string[]) => {
    const groupId = dhruGroupId(JSON.stringify([type, sectionId, ...(sourceIdentity || [groupName])]));
    if (!groupsMap.has(groupId)) {
      const g = {
        GROUPID: groupId,
        GROUPTYPE: type.toUpperCase(),
        service_type: type,
        section_id: sectionId,
        sectionId,
        category_key: sectionId,
        GROUPNAME: groupName,
        group_name: groupName,
        GroupName: groupName,
        name: groupName,
        package_name: groupName,
        package: groupName,
        category: categoryName,
        SERVICES: [] as any[],
        services: [] as any[],
        services_map: Object.create(null) as Record<string, any>
      };
      groupsMap.set(groupId, g);
      groupsObject[groupId] = g;
    }
    return groupsMap.get(groupId);
  };

  {
    const foxCatalog = available.catalog;
    const foxProducts = available.products;
    if (foxCatalog?.sections) {
      const sectionConfigs = [
        { sec: foxCatalog.sections.topups, name: SECTION_METADATA.topups.nameAr, key: 'topups' },
        { sec: foxCatalog.sections.appStores, name: SECTION_METADATA.appStores.nameAr, key: 'app-stores' },
        { sec: foxCatalog.sections.gameCurrency, name: SECTION_METADATA.gameCurrency.nameAr, key: 'game-currency' },
        { sec: foxCatalog.sections.subscriptions, name: SECTION_METADATA.subscriptions.nameAr, key: 'subscriptions' },
        { sec: foxCatalog.sections.esim, name: SECTION_METADATA.esim.nameAr, key: 'esim' },
        { sec: foxCatalog.sections.rewarble, name: SECTION_METADATA.rewarble.nameAr, key: 'rewarble' },
        { sec: foxCatalog.sections.popular, name: SECTION_METADATA.popular.nameAr, key: 'popular' }
      ];

      const categoryGroups = new Map<string, { bundle: any; region?: any; secName: string; sectionId: string }>();

      for (const config of sectionConfigs) {
        if (!config.sec?.bundles) continue;
        for (const b of config.sec.bundles) {
          if (!categoryGroups.has(b.id)) categoryGroups.set(b.id, { bundle: b, secName: config.name, sectionId: config.key });
          for (const region of b.regions || []) {
            if (!categoryGroups.has(region.id)) categoryGroups.set(region.id, { bundle: b, region, secName: config.name, sectionId: config.key });
          }
        }
      }

      for (const p of foxProducts) {
        const fallbackSection = p.categorySlug === 'esim' ? 'esim' : 'dhru-server';
        const { bundle, region, secName, sectionId } = categoryGroups.get(p.categoryId) || {
          bundle: { name: p.categoryId || 'Other Services' }, secName: SECTION_METADATA[fallbackSection].nameAr, sectionId: fallbackSection
        };
        if (p.isHidden || bundle.isHidden) continue;
        const pathName = [bundle.name, region?.name].filter(Boolean).join(' / ');
        const groupName = `[${secName}] ${pathName}`;
        const targetGroup = ensureGroup(groupName, secName, 'server', sectionId, ['foxreload', bundle.id || p.categoryId, region?.id || p.categoryId]);
        const hierarchy = { bundle_id: bundle.id || p.categoryId, bundle_name: bundle.name,
          region_id: region?.id || null, region_name: region?.name || null, categoryId: p.categoryId };
        Object.assign(targetGroup, hierarchy);

        if (targetGroup.services_map[p.id]) continue;
        const baseCost = Math.max(0, p.costPrice || 0);
        const finalPrice = Number((baseCost * (1 + margin / 100)).toFixed(4));
        const reqFields = Array.isArray(p.requiredNoteFields) ? p.requiredNoteFields : [];
        const customFields = foxreloadCustomFields(p);
        const instructions = Array.from(new Set([p.description, p.userGuide].filter(Boolean))).join('\n\n');

        const srvItem = {
          ...hierarchy,
          product_name: p.name,
          slug: p.slug,
          description: p.description,
          userGuide: p.userGuide,
          attributes: p.attributes,
          deliveryType: p.deliveryType,
          isService: p.isService,
          stock: p.stock,
          quantity: p.stock,
          currency: 'USD',
          requiredNoteFields: reqFields,
          noteFieldTypes: p.noteFieldTypes || {},
          noteFieldOptions: p.noteFieldOptions || {},
          orderMinQuantity: p.minQty || 1,
          orderMaxQuantity: p.maxQty ?? null,
          SERVICETYPE: 'SERVER',
          service_type: 'server',
          api_service_type: 'server',
          section_id: sectionId,
          sectionId,
          category_key: sectionId,
          SERVICEID: p.id,
          service_id: p.id,
          ID: p.id,
          id: p.id,
          SERVICENAME: `${pathName} - ${p.name}`,
          service_name: `${pathName} - ${p.name}`,
          name: `${pathName} - ${p.name}`,
          CREDIT: finalPrice.toFixed(4).replace(/00$/, ''),
          credit: finalPrice.toFixed(4).replace(/00$/, ''),
          PRICE: finalPrice.toFixed(4).replace(/00$/, ''),
          price: finalPrice.toFixed(4).replace(/00$/, ''),
          TIME: '',
          time: '',
          INFO: instructions,
          info: instructions,
          GROUPNAME: groupName,
          group_name: groupName,
          GroupName: groupName,
          group: groupName,
          package: groupName,
          PACKAGE: groupName,
          category: secName,
          Requires: reqFields.join(','),
          RequiresCustom: customFields,
          CUSTOM: customFields,
          SupportsQty: true,
          supports_quantity: true,
          MIN_QNT: p.minQty || 1,
          MAX_QNT: p.maxQty || 0,
          QNT: 1,
          MINQNT: p.minQty || 1,
          MAXQNT: p.maxQty || 0
        };
        (srvItem as any)['Requires.Custom'] = srvItem.CUSTOM;

        targetGroup.SERVICES.push(srvItem);
        targetGroup.services.push(srvItem);
        targetGroup.services_map[srvItem.SERVICEID] = srvItem;
        totalServicesCount++;
      }
    }
  }

  const dhruServices = await prisma.dhruService.findMany({
    where: {
      isActive: true,
      OR: [
        { apiProvider: { isActive: true } },
        { providerId: null }
      ]
    },
    include: {
      dhruCategory: { select: { id: true, name: true } },
      apiProvider: { select: { id: true, name: true, isActive: true } }
    },
    orderBy: [{ groupName: 'asc' }, { name: 'asc' }]
  });

  for (const srv of dhruServices) {
    const resolvedType = resolveOrderServiceType(srv.apiServiceType, srv.dhruCategory?.name, srv.groupName);
    const srvType = resolvedType === 'unknown' ? 'server' : resolvedType;
    const rawGroupName = (srv.groupName && srv.groupName.trim() !== ''
      ? srv.groupName
      : (srv.dhruCategory?.name || `${srvType.toUpperCase()} Services`)).trim();
    const groupName = rawGroupName;
    const catName = srv.dhruCategory?.name || `${srvType.toUpperCase()} Services`;

    const sectionId = getCatalogSection(srvType, catName, groupName);
    const targetGroup = ensureGroup(groupName, catName, srvType, sectionId);

    const baseCost = Math.max(0, srv.credit || 0);
    const finalPrice = Number((baseCost * (1 + margin / 100)).toFixed(4));

    let customReq: any[] = [];
    if (srv.requiresCustom) {
      try {
        const parsed = typeof srv.requiresCustom === 'string' ? JSON.parse(srv.requiresCustom) : srv.requiresCustom;
        if (Array.isArray(parsed)) customReq = parsed;
        else if (typeof parsed === 'object' && parsed !== null) customReq = Object.values(parsed);
      } catch {}
    }

    const requiresFields: string[] = [];
    if (srvType === 'imei' && customReq.length === 0) {
      requiresFields.push('IMEI');
    }

    for (const f of customReq) {
      const fname = f.name || f.fieldname || f.label || f.field_id;
      if (fname && !requiresFields.some((existing) => existing.toLowerCase() === String(fname).toLowerCase())) {
        requiresFields.push(String(fname));
      }
    }

    const srvItem = {
      SERVICETYPE: srvType.toUpperCase(),
      service_type: srvType,
      api_service_type: srvType,
      section_id: sectionId,
      sectionId,
      category_key: sectionId,
      SERVICEID: srv.dhruId || srv.id,
      service_id: srv.dhruId || srv.id,
      ID: srv.dhruId || srv.id,
      id: srv.dhruId || srv.id,
      SERVICENAME: srv.name,
      service_name: srv.name,
      name: srv.name,
      CREDIT: finalPrice.toFixed(2),
      credit: finalPrice.toFixed(2),
      PRICE: finalPrice.toFixed(2),
      price: finalPrice.toFixed(2),
      TIME: srv.time || "1-24 Hours",
      time: srv.time || "1-24 Hours",
      INFO: srv.info || "",
      info: srv.info || "",
      GROUPNAME: groupName,
      group_name: groupName,
      GroupName: groupName,
      group: groupName,
      package: groupName,
      PACKAGE: groupName,
      category: catName,
      Requires: requiresFields.join(','),
      RequiresCustom: customReq.length > 0 ? customReq : undefined,
      CUSTOM: customReq.length > 0 ? customReq : undefined,
      SupportsQty: srv.supportsQty,
      supports_quantity: srv.supportsQty,
      MIN_QNT: srv.minQty || 1,
      MAX_QNT: srv.maxQty || 0,
      QNT: srv.supportsQty ? 1 : 0,
      MINQNT: srv.minQty || 1,
      MAXQNT: srv.maxQty || 0,
      'Requires.Custom': customReq
    };

    targetGroup.SERVICES.push(srvItem);
    targetGroup.services.push(srvItem);
    targetGroup.services_map[srvItem.SERVICEID] = srvItem;
    totalServicesCount++;
  }

  const groupsList = Array.from(groupsMap.values());
  const formattedGroupsObject: Record<string, any> = {};
  for (const [key, grp] of Object.entries(groupsObject)) {
    formattedGroupsObject[key] = {
      ...grp,
      SERVICES: grp.services_map
    };
  }

  const finalPayload = {
    groupsList,
    groupsObject: formattedGroupsObject,
    totalServices: totalServicesCount,
    catalogComplete: available.complete,
    completeSections: available.completeSections || []
  };

  return finalPayload;
}
