import { prisma } from '../utils/prisma';
import {
  placeImeiOrder,
  placeServerOrder,
  getAccountInfo,
  parseDhruAccountInfo,
  extractProviderHost,
  normalizeProviderCustomFields,
  cleanDhruErrorMessage,
  getDhruApiErrorMessage,
  isActionUnsupported,
  isInvalidImeiError
} from '../utils/dhru-api';
import { getProviderRemoteServiceId } from '../utils/provider-service-id';
import { resolveOrderServiceType } from '../utils/order-response';
import { sendTelegramPhotoNotification } from '../utils/telegramService';

export interface DhruDispatchErrorClassification {
  category: 'credit' | 'out_of_stock' | 'imei' | 'fields' | 'invalid_action' | 'other';
  isCreditError: boolean;
  title: string;
  userFacingMsg: string;
}

export interface DhruCreditDiagnostic {
  providerName?: string;
  providerHost?: string;
  usingEnvFallback?: boolean;
  recordedOrderCost?: number | null;
  liveBalance?: number | null;
  liveCurrency?: string | null;
}

function formatCreditErrorClassification(
  creditDiag?: DhruCreditDiagnostic
): DhruDispatchErrorClassification {
  if (!creditDiag) {
    return {
      category: 'credit',
      isCreditError: true,
      title: 'فشل الإرسال: رصيد المزود غير كاف',
      userFacingMsg:
        'رفض المزود الطلب برسالة (You have not enough credit).'
    };
  }

  const effectiveProviderName = String(creditDiag.providerName || 'المزود').trim() || 'المزود';
  const hostSuffix = creditDiag.providerHost ? ` (${creditDiag.providerHost})` : '';
  const sourceLabel = creditDiag.usingEnvFallback
    ? `${effectiveProviderName}${hostSuffix} [إعدادات .env الافتراضية]`
    : `${effectiveProviderName}${hostSuffix}`;
  const liveBalance =
    typeof creditDiag.liveBalance === 'number' && Number.isFinite(creditDiag.liveBalance)
      ? creditDiag.liveBalance
      : null;
  const recordedCost =
    typeof creditDiag.recordedOrderCost === 'number' && Number.isFinite(creditDiag.recordedOrderCost)
      ? creditDiag.recordedOrderCost
      : null;
  const currency = creditDiag.liveCurrency || 'USD';

  if (liveBalance !== null) {
    const costPart = recordedCost !== null ? `؛ التكلفة المسجلة محلياً: ${recordedCost}` : '';
    return {
      category: 'credit',
      isCreditError: true,
      title: 'فشل الإرسال: المزود رفض الطلب برسالة رصيد غير كافٍ',
      userFacingMsg: `رفض المزود ${sourceLabel} الطلب برسالة (You have not enough credit). الرصيد الظاهر: ${liveBalance} ${currency}${costPart}. تحقق من سعر الخدمة وعملتها وصلاحية الحساب لدى المزود قبل الشحن أو إعادة الإرسال. إذا كانت البيانات صحيحة، اطلب من المزود توضيح سبب الرفض لكود الخدمة.`
    };
  }

  return {
    category: 'credit',
    isCreditError: true,
    title: 'فشل الإرسال: رصيد المزود غير كاف',
    userFacingMsg: `رفض المزود ${sourceLabel} الطلب برسالة (You have not enough credit)، وتعذر قراءة الرصيد الحالي. راجع رصيد الحساب وسعر الخدمة لدى المزود قبل إعادة الإرسال.`
  };
}

export function classifyDhruDispatchError(
  dhruResponse: any,
  rawTarget: string,
  providerName: string,
  dhruId: string,
  creditDiag?: DhruCreditDiagnostic
): DhruDispatchErrorClassification {
  const rawErrMsg = cleanDhruErrorMessage(
    dhruResponse?.Error ||
    dhruResponse?.ERROR?.[0]?.FULL_DESCRIPTION ||
    getDhruApiErrorMessage(dhruResponse) ||
    'رفض المزود الطلب'
  ).replace(/^ValidationError\d*\s*/i, '').trim() || 'رفض المزود الطلب';

  // DHRU may echo order fields alongside the error. Classify the error only.
  const responseStr = `${getDhruApiErrorMessage(dhruResponse) || ''} ${rawErrMsg}`.toLowerCase();
  const isNumericImei = /^\d{14,16}$/.test(String(rawTarget || '').replace(/[\s-]/g, ''));

  const isCreditError =
    responseStr.includes('creditprocesserror') ||
    responseStr.includes('not enough credit') ||
    responseStr.includes('insufficient credit') ||
    responseStr.includes('low credit');

  if (isCreditError) {
    return formatCreditErrorClassification(creditDiag);
  }

  // Provider operational errors often arrive wrapped as "ValidationError123 Out of Stock ...";
  // match stock/availability failures before generic validation checks so admins are not told to edit fields.
  const isOutOfStock =
    responseStr.includes('out of stock') ||
    responseStr.includes('stock empty') ||
    responseStr.includes('no stock') ||
    responseStr.includes('sold out') ||
    responseStr.includes('temporarily unavailable') ||
    responseStr.includes('service unavailable') ||
    responseStr.includes('service disabled') ||
    responseStr.includes('under maintenance');

  if (isOutOfStock) {
    return {
      category: 'out_of_stock',
      isCreditError: false,
      title: 'فشل الإرسال: الخدمة غير متوفرة حالياً لدى المزود',
      userFacingMsg: `الخدمة غير متوفرة حالياً لدى المزود (نفاد الكمية / Out of Stock: ${rawErrMsg}). يرجى المحاولة لاحقاً أو تحويل الطلب لمزود آخر.`
    };
  }

  const isImeiValidationError =
    isInvalidImeiError(dhruResponse) ||
    responseStr.includes('invalid imei') ||
    responseStr.includes('required imei') ||
    responseStr.includes('imei field');

  if (isImeiValidationError) {
    return {
      category: 'imei',
      isCreditError: false,
      title: 'فشل الإرسال: رقم IMEI غير صالح',
      userFacingMsg: !isNumericImei
        ? `رفض المزود (${providerName || 'المزود'}) حقل IMEI. تحقق من نوع الخدمة والحقول المطلوبة لدى المزود قبل تعديل الطلب وإعادة إرساله.`
        : `رقم IMEI غير مطابق لشروط المزود (${rawErrMsg}). يرجى التأكد من كتابة رقم IMEI صحيح للجهاز (15 رقماً) عبر زر التعديل ثم إعادة الإرسال.`
    };
  }

  const isFieldValidationError =
    /validationerror/i.test(String(dhruResponse?.ERROR?.[0]?.MESSAGE || '')) ||
    responseStr.includes('validationerror') ||
    responseStr.includes('is required') ||
    responseStr.includes('required field') ||
    responseStr.includes('missing field') ||
    responseStr.includes('invalid customfield');

  if (isFieldValidationError) {
    return {
      category: 'fields',
      isCreditError: false,
      title: 'فشل الإرسال: بيانات الطلب غير مكتملة',
      userFacingMsg: `رفض المزود الطلب لنقص أو عدم تطابق الحقول المطلوبة (${rawErrMsg}). يرجى الضغط على زر التعديل واستكمال البيانات المطلوبة ثم إعادة الإرسال.`
    };
  }

  if (isActionUnsupported(dhruResponse)) {
    return {
      category: 'invalid_action',
      isCreditError: false,
      title: 'فشل الإرسال: نوع العملية غير مدعوم (Invalid Action)',
      userFacingMsg: `رفض المزود عملية الإرسال لهذه الخدمة. تحقق من نوع الخدمة وربط كودها (${dhruId}) لدى المزود (${providerName || 'المزود'}).`
    };
  }

  return {
    category: 'other',
    isCreditError: false,
    title: 'فشل الإرسال للمزود',
    userFacingMsg: `رفض المزود الطلب: ${rawErrMsg}`
  };
}

export const AUTO_DISPATCH_SETTINGS_KEY = 'auto_dispatch_settings';

export interface AutoDispatchConfig {
  enabled: boolean;
  scheduleMode: 'always' | 'scheduled';
  startTime: string; // HH:MM in Sudan Time (UTC+2)
  endTime: string;   // HH:MM in Sudan Time (UTC+2)
  timezone: string;  // Africa/Khartoum
  includeApiOrders: boolean;
  includeWebOrders: boolean;
  notifyOnFailure: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_AUTO_DISPATCH_CONFIG: AutoDispatchConfig = {
  enabled: false,
  scheduleMode: 'always',
  startTime: '09:00',
  endTime: '23:00',
  timezone: 'Africa/Khartoum',
  includeApiOrders: true,
  includeWebOrders: true,
  notifyOnFailure: true,
  updatedAt: new Date().toISOString()
};

export interface SudanTimeInfo {
  hours: number;
  minutes: number;
  seconds: number;
  timeStr: string;
  dateStr: string;
  currentMinutes: number;
}

export function parseTimeToMinutes(timeStr: string): number {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.trim().split(':');
  const h = parseInt(parts[0] || '0', 10);
  const m = parseInt(parts[1] || '0', 10);
  const validH = Math.min(23, Math.max(0, Number.isNaN(h) ? 0 : h));
  const validM = Math.min(59, Math.max(0, Number.isNaN(m) ? 0 : m));
  return validH * 60 + validM;
}

export function isTimeWithinWindow(currentMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) {
    return true;
  }
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

export function getSudanTime(date: Date = new Date()): SudanTimeInfo {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Khartoum',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const getPart = (t: string) => parts.find(p => p.type === t)?.value || '00';

  const hours = parseInt(getPart('hour'), 10);
  const minutes = parseInt(getPart('minute'), 10);
  const seconds = parseInt(getPart('second'), 10);
  const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  const dateStr = `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
  const currentMinutes = hours * 60 + minutes;

  return { hours, minutes, seconds, timeStr, dateStr, currentMinutes };
}

export async function getAutoDispatchConfig(): Promise<AutoDispatchConfig> {
  try {
    const record = await prisma.setting.findUnique({
      where: { key: AUTO_DISPATCH_SETTINGS_KEY }
    });
    if (record && record.value) {
      const parsed = JSON.parse(record.value);
      return {
        ...DEFAULT_AUTO_DISPATCH_CONFIG,
        ...parsed,
        timezone: 'Africa/Khartoum'
      };
    }
  } catch (err) {
    console.warn('[Auto-Dispatch] Failed to load config from DB, using defaults:', err);
  }
  return { ...DEFAULT_AUTO_DISPATCH_CONFIG };
}

export async function saveAutoDispatchConfig(
  config: Partial<AutoDispatchConfig>,
  updatedBy?: string
): Promise<AutoDispatchConfig> {
  const current = await getAutoDispatchConfig();

  const validated: AutoDispatchConfig = {
    enabled: Boolean(config.enabled),
    scheduleMode: config.scheduleMode === 'scheduled' ? 'scheduled' : 'always',
    startTime: typeof config.startTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(config.startTime.trim())
      ? config.startTime.trim()
      : current.startTime || '09:00',
    endTime: typeof config.endTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(config.endTime.trim())
      ? config.endTime.trim()
      : current.endTime || '23:00',
    timezone: 'Africa/Khartoum',
    includeApiOrders: config.includeApiOrders !== undefined ? Boolean(config.includeApiOrders) : current.includeApiOrders,
    includeWebOrders: config.includeWebOrders !== undefined ? Boolean(config.includeWebOrders) : current.includeWebOrders,
    notifyOnFailure: config.notifyOnFailure !== undefined ? Boolean(config.notifyOnFailure) : current.notifyOnFailure,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || current.updatedBy || 'admin'
  };

  await prisma.setting.upsert({
    where: { key: AUTO_DISPATCH_SETTINGS_KEY },
    update: { value: JSON.stringify(validated) },
    create: { key: AUTO_DISPATCH_SETTINGS_KEY, value: JSON.stringify(validated) }
  });

  return validated;
}

export function isAutoDispatchActive(
  config: AutoDispatchConfig,
  targetDate: Date = new Date()
): { active: boolean; reason: string; sudanTime: string; sudanDate: string } {
  const sudan = getSudanTime(targetDate);

  if (!config.enabled) {
    return {
      active: false,
      reason: 'الإرسال التلقائي معطل حالياً من الإعدادات',
      sudanTime: sudan.timeStr,
      sudanDate: sudan.dateStr
    };
  }

  if (config.scheduleMode === 'always') {
    return {
      active: true,
      reason: 'مفعل ويعمل على مدار 24 ساعة (دائماً)',
      sudanTime: sudan.timeStr,
      sudanDate: sudan.dateStr
    };
  }

  const startMinutes = parseTimeToMinutes(config.startTime);
  const endMinutes = parseTimeToMinutes(config.endTime);
  const inWindow = isTimeWithinWindow(sudan.currentMinutes, startMinutes, endMinutes);

  if (inWindow) {
    return {
      active: true,
      reason: `مفعل ويعمل حالياً ضمن ساعات العمل المحددة (${config.startTime} - ${config.endTime} بتوقيت السودان)`,
      sudanTime: sudan.timeStr,
      sudanDate: sudan.dateStr
    };
  }

  return {
    active: false,
    reason: `متوقف حالياً: خارج ساعات العمل المحددة (${config.startTime} - ${config.endTime} بتوقيت السودان)`,
    sudanTime: sudan.timeStr,
    sudanDate: sudan.dateStr
  };
}

export interface DispatchExecutionResult {
  success: boolean;
  statusCode: number;
  message?: string;
  error?: string;
  userFacingMsg?: string;
  apiOrderId?: string | null;
  order?: any;
}

export async function dispatchOrderToProvider(
  orderId: string,
  options: { isAuto?: boolean; requestedBy?: string } = {}
): Promise<DispatchExecutionResult> {
  const isAuto = Boolean(options.isAuto);

  if (!orderId) {
    return {
      success: false,
      statusCode: 400,
      error: 'معرف الطلب مطلوب'
    };
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: true }
  });

  if (!order) {
    return {
      success: false,
      statusCode: 404,
      error: 'الطلب غير موجود'
    };
  }

  if (order.source === 'foxreload' || String(order.serviceId).startsWith('foxreload:')) {
    return {
      success: false,
      statusCode: 400,
      error: 'هذا طلب FoxReload. اعتمده من صفحة طلبات FoxReload في لوحة الإدارة.'
    };
  }

  // Atomic reservation to prevent double dispatch / concurrency races
  const reservation = await prisma.order.updateMany({
    where: {
      id: orderId,
      status: 'pending',
      apiOrderId: null,
      refundedAt: null
    },
    data: {
      status: 'dispatching'
    }
  });

  if (reservation.count === 0) {
    return {
      success: false,
      statusCode: 400,
      error: 'لا يمكن إرسال الطلب: الطلب قيد الإرسال، أو تم إرساله مسبقاً، أو مسترد، أو ليس في حالة انتظار.'
    };
  }

  // Prefer exact database UUID lookup before falling back to provider service code
  const serviceLookupKey = String(order.serviceId);
  let dhruService = await prisma.dhruService.findUnique({
    where: { id: serviceLookupKey },
    include: { dhruCategory: true, apiProvider: true }
  });
  if (!dhruService) {
    dhruService = await prisma.dhruService.findFirst({
      where: { dhruId: serviceLookupKey },
      include: { dhruCategory: true, apiProvider: true }
    });
  }

  const remoteServiceId = dhruService?.dhruId ? getProviderRemoteServiceId(dhruService.dhruId).trim() : '';
  if (!dhruService || !remoteServiceId) {
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'pending' }
    });
    return {
      success: false,
      statusCode: 400,
      error: 'الخدمة المرتبطة بهذا الطلب لا تحمل كود مزود صالحاً. راجع ربط الخدمة الأصلية بالمزود وكودها قبل إعادة الإرسال (Missing Dhru ID).'
    };
  }

  const providerConfig = dhruService.apiProvider
    ? {
      apiUrl: dhruService.apiProvider.apiUrl,
      username: dhruService.apiProvider.username,
      apiKey: dhruService.apiProvider.apiKey
    }
    : undefined;

  const usingEnvFallback = !dhruService.apiProvider;
  const providerName = dhruService.apiProvider?.name || 'إعدادات المزود الافتراضية (.env)';
  const providerHost = extractProviderHost(dhruService.apiProvider?.apiUrl) || 'غير محدد';
  const dispatchQuantity = Math.max(1, Number(order.quantity) || 1);
  const unitCost = Number(dhruService.credit);
  const recordedOrderCost = Number.isFinite(unitCost)
    ? Number((unitCost * dispatchQuantity).toFixed(4))
    : null;

  let customFields: Record<string, string> = {};
  let rawImei = '';
  let parsedNotes: any = {};
  try {
    if (order.notes) {
      parsedNotes = JSON.parse(order.notes);
      if (parsedNotes.customFields) customFields = parsedNotes.customFields;
      if (parsedNotes.rawImei) rawImei = parsedNotes.rawImei;
    }
  } catch { }

  let dhruResponse: any = null;
  let apiOrderId: string | null = null;
  const providerCustomFields = normalizeProviderCustomFields(customFields, dhruService.requiresCustom);
  if (order.quantity > 0) {
    providerCustomFields['QNT'] = String(order.quantity);
  }

  const serviceType = resolveOrderServiceType(
    dhruService.apiServiceType,
    dhruService.dhruCategory?.name,
    dhruService.groupName
  );

  parsedNotes.dispatchProviderId = dhruService.providerId || null;
  parsedNotes.dispatchServiceId = dhruService.id;
  parsedNotes.dispatchServiceType = serviceType;

  let actualDispatchType = serviceType;
  const storedTarget = String(order.targetInput).trim();
  // The storefront uses targetInput to display a summary when it submits custom
  // fields. Send the fields individually, and only use a separately supplied ID.
  const isFieldSummary = Object.entries(customFields).some(([key, value]) => {
    const field = `${key}: ${value}`;
    return storedTarget === field || storedTarget.startsWith(`${field} | `);
  });
  const providerTarget = String(rawImei || (isFieldSummary ? '' : storedTarget)).trim();
  const isNumericImei = /^\d{14,16}$/.test(providerTarget.replace(/[\s-]/g, ''));

  try {
    if (serviceType === 'imei' && isNumericImei) {
      actualDispatchType = 'imei';
      dhruResponse = await placeImeiOrder(remoteServiceId, providerTarget, providerCustomFields, providerConfig);
    } else {
      actualDispatchType = 'server';
      dhruResponse = await placeServerOrder(
        remoteServiceId,
        dispatchQuantity,
        providerCustomFields,
        providerTarget,
        providerConfig
      );
    }
  } catch (err: any) {
    console.error('[Dispatch Exception]:', err);
    dhruResponse = { ERROR: [{ MESSAGE: err?.message || 'تعذر الاتصال بسيرفر المزود الخارجي' }] };
  }

  if (!dhruResponse || dhruResponse.SUCCESS === false || dhruResponse.ERROR || dhruResponse.Error || dhruResponse.error) {
    const initialClass = classifyDhruDispatchError(
      dhruResponse,
      providerTarget,
      providerName,
      dhruService.dhruId
    );

    const creditDiag: DhruCreditDiagnostic = {
      providerName,
      providerHost,
      usingEnvFallback,
      recordedOrderCost,
      liveBalance: null,
      liveCurrency: dhruService.apiProvider?.currency || 'USD'
    };

    if (initialClass.isCreditError) {
      try {
        const acctRes = await getAccountInfo(providerConfig);
        const parsedAcct = parseDhruAccountInfo(acctRes);
        if (parsedAcct) {
          creditDiag.liveBalance = parsedAcct.balance;
          creditDiag.liveCurrency = parsedAcct.currency;
          if (dhruService.apiProvider?.id) {
            await prisma.apiProvider.update({
              where: { id: dhruService.apiProvider.id },
              data: {
                balance: parsedAcct.balance,
                currency: parsedAcct.currency
              }
            }).catch(() => {});
          }
        }
      } catch { /* The dispatch error still applies when accountinfo is unavailable. */ }
    }

    console.error('[Dispatch Provider Error]:', {
      orderId,
      providerName,
      providerHost,
      usingEnvFallback,
      remoteServiceId,
      quantity: dispatchQuantity,
      recordedOrderCost,
      liveBalance: creditDiag.liveBalance,
      liveCurrency: creditDiag.liveCurrency,
      category: initialClass.category
    });

    const { isCreditError, title: classifiedTitle, userFacingMsg } = initialClass.isCreditError
      ? classifyDhruDispatchError(dhruResponse, providerTarget, providerName, dhruService.dhruId, creditDiag)
      : initialClass;

    const now = new Date();
    const events = Array.isArray(parsedNotes.events) ? parsedNotes.events : [];
    events.push({
      time: now.toISOString(),
      action: isAuto ? 'AUTO_DISPATCH_FAILED' : 'DISPATCH_FAILED',
      title: isAuto && classifiedTitle === 'فشل الإرسال للمزود' ? 'فشل الإرسال التلقائي للمزود' : classifiedTitle,
      desc: userFacingMsg
    });
    parsedNotes.events = events;

    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'pending',
        notes: JSON.stringify(parsedNotes)
      }
    });

    // Alert admin on Telegram if credit error or if auto-dispatch failed
    try {
      const liveBalance =
        typeof creditDiag.liveBalance === 'number' && Number.isFinite(creditDiag.liveBalance)
          ? creditDiag.liveBalance
          : null;
      const alertTitle = isCreditError
        ? 'تنبيه الإدارة: المزود رفض الطلب برسالة رصيد غير كافٍ'
        : (isAuto ? 'تنبيه الإدارة: تعذر الإرسال التلقائي للطلب للمزود' : 'تنبيه الإدارة: فشل إرسال الطلب للمزود');

      const hostBadge = usingEnvFallback ? `${providerHost} [.env]` : providerHost;
      const balanceLine = isCreditError
        ? `- <b>الرصيد الحي لدى المزود:</b> ${
            liveBalance !== null
              ? `${liveBalance} ${creditDiag.liveCurrency || 'USD'}`
              : 'تعذر التحقق'
          } (التكلفة المسجلة: ${recordedOrderCost ?? 'غير محددة'})\n`
        : '';

      void sendTelegramPhotoNotification({
        caption:
          `<b>${alertTitle}</b>\n\n` +
          `- <b>رقم الطلب:</b> #${order.id.slice(-6)}\n` +
          `- <b>اسم الخدمة:</b> ${dhruService.name}\n` +
          `- <b>المزود المربوط:</b> ${providerName} (${hostBadge})\n` +
          balanceLine +
          `- <b>سبب الرفض:</b> <code>${userFacingMsg}</code>\n\n` +
          `<b>الإجراء:</b> الطلب تم تركه في حالة (قيد الانتظار) للمراجعة اليدوية.`
      });
    } catch (tgErr) {
      console.error('[Dispatch Telegram Alert Error]:', tgErr);
    }

    return {
      success: false,
      statusCode: 400,
      error: `فشل الإرسال: ${userFacingMsg}`,
      userFacingMsg
    };
  }

  if (dhruResponse.SUCCESS && Array.isArray(dhruResponse.SUCCESS) && dhruResponse.SUCCESS[0]) {
    apiOrderId = String(
      dhruResponse.SUCCESS[0].REFERENCEID ||
      dhruResponse.SUCCESS[0].ID ||
      dhruResponse.SUCCESS[0].id ||
      dhruResponse.SUCCESS[0].orderid ||
      ""
    ).trim() || null;
  } else if (dhruResponse.REFERENCEID || dhruResponse.ID || dhruResponse.id) {
    apiOrderId = String(dhruResponse.REFERENCEID || dhruResponse.ID || dhruResponse.id).trim() || null;
  }

  parsedNotes.dispatchServiceType = actualDispatchType;

  const now = new Date();
  const events = Array.isArray(parsedNotes.events) ? parsedNotes.events : [];
  events.push({
    time: now.toISOString(),
    action: isAuto ? 'AUTO_DISPATCHED_TO_PROVIDER' : 'DISPATCHED_TO_PROVIDER',
    title: isAuto ? 'تم الإرسال التلقائي للمزود بنجاح' : 'تم الإرسال للمزود بنجاح',
    desc: `تم إرسال الطلب ${isAuto ? 'تلقائياً' : 'آلياً'} إلى سيرفر (${dhruService.apiProvider?.name || 'المزود'}). رقم المرجع الخارجي: #${apiOrderId || 'N/A'}.`
  });
  parsedNotes.events = events;

  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      status: 'processing',
      apiOrderId: apiOrderId || order.apiOrderId,
      notes: JSON.stringify(parsedNotes)
    }
  });

  return {
    success: true,
    statusCode: 200,
    message: `تم إرسال الطلب إلى المزود بنجاح! رقم المرجع: #${apiOrderId || 'تم التسليم'}`,
    order: updatedOrder,
    apiOrderId
  };
}

export async function tryAutoDispatchOrder(
  orderId: string,
  source: 'web' | 'api' = 'web'
): Promise<{ attempted: boolean; success?: boolean; reason?: string; apiOrderId?: string | null; error?: string }> {
  try {
    const config = await getAutoDispatchConfig();
    const status = isAutoDispatchActive(config);

    if (!status.active) {
      return { attempted: false, reason: status.reason };
    }

    if (source === 'web' && !config.includeWebOrders) {
      return { attempted: false, reason: 'الإرسال التلقائي لطلبات المتجر (Web) معطل' };
    }

    if (source === 'api' && !config.includeApiOrders) {
      return { attempted: false, reason: 'الإرسال التلقائي لطلبات الـ API معطل' };
    }

    const result = await dispatchOrderToProvider(orderId, { isAuto: true });

    return {
      attempted: true,
      success: result.success,
      apiOrderId: result.apiOrderId,
      error: result.error
    };
  } catch (err: any) {
    console.error('[Auto-Dispatch Attempt Error]:', err);
    return {
      attempted: false,
      reason: err?.message || 'خطأ غير متوقع أثناء محاولة الإرسال التلقائي'
    };
  }
}
