import { prisma } from '../utils/prisma';
import {
  placeImeiOrder,
  placeServerOrder,
  normalizeProviderCustomFields
} from '../utils/dhru-api';
import { getProviderRemoteServiceId } from '../utils/provider-service-id';
import { resolveOrderServiceType } from '../utils/order-response';
import { sendTelegramPhotoNotification } from '../utils/telegramService';

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

  // Look up DhruService & Provider
  const dhruService = await prisma.dhruService.findFirst({
    where: {
      OR: [{ id: String(order.serviceId) }, { dhruId: String(order.serviceId) }]
    },
    include: { dhruCategory: true, apiProvider: true }
  });

  if (!dhruService || !dhruService.dhruId) {
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'pending' }
    });
    return {
      success: false,
      statusCode: 400,
      error: 'عذراً، هذه الخدمة غير مربوطة بكود خدمة صحيح لدى المزود (Missing Dhru ID)'
    };
  }

  const providerConfig = dhruService.apiProvider
    ? {
      apiUrl: dhruService.apiProvider.apiUrl,
      username: dhruService.apiProvider.username,
      apiKey: dhruService.apiProvider.apiKey
    }
    : undefined;

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

  try {
    if (serviceType === 'imei') {
      const imeiToSend = rawImei ? String(rawImei).trim() : String(order.targetInput).trim();
      dhruResponse = await placeImeiOrder(
        getProviderRemoteServiceId(dhruService.dhruId),
        imeiToSend,
        providerCustomFields,
        providerConfig
      );
    } else {
      const inputToSend = String(order.targetInput).trim();
      dhruResponse = await placeServerOrder(
        getProviderRemoteServiceId(dhruService.dhruId),
        order.quantity,
        providerCustomFields,
        inputToSend,
        providerConfig
      );
    }
  } catch (err: any) {
    console.error('[Dispatch Exception]:', err);
    dhruResponse = { ERROR: [{ MESSAGE: err?.message || 'تعذر الاتصال بسيرفر المزود الخارجي' }] };
  }

  if (!dhruResponse || dhruResponse.SUCCESS === false || dhruResponse.ERROR || dhruResponse.Error) {
    console.error('[Dispatch Provider Error]:', dhruResponse);
    const rawErrMsg =
      dhruResponse?.Error ||
      dhruResponse?.ERROR?.[0]?.MESSAGE ||
      dhruResponse?.ERROR?.[0]?.FULL_DESCRIPTION ||
      'رفض المزود الطلب';

    const responseStr = JSON.stringify(dhruResponse || {}).toLowerCase();
    const isCreditError =
      responseStr.includes('creditprocesserror') ||
      responseStr.includes('not enough credit') ||
      responseStr.includes('insufficient credit') ||
      responseStr.includes('low credit');

    const isInvalidAction =
      responseStr.includes('invalid action') ||
      responseStr.includes('command not found') ||
      responseStr.includes('action not found');

    const userFacingMsg = isCreditError
      ? 'رصيد حسابك لدى المزود الخارجي غير كافٍ لتنفيذ الطلب (You have not enough credit). يُرجى شحن حساب المزود أولاً ثم إعادة الإرسال.'
      : isInvalidAction
        ? `رفض المزود الطلب (نوع العملية غير مدعوم لهذه الخدمة لدى المزود - Invalid Action). يُرجى التحقق من ربط كود الخدمة (Dhru Service ID: ${dhruService.dhruId}) لدى المزود (${dhruService.apiProvider?.name || 'المزود'}).`
        : `رفض المزود الطلب: ${rawErrMsg}`;

    const now = new Date();
    const events = Array.isArray(parsedNotes.events) ? parsedNotes.events : [];
    events.push({
      time: now.toISOString(),
      action: isAuto ? 'AUTO_DISPATCH_FAILED' : 'DISPATCH_FAILED',
      title: isCreditError
        ? 'فشل الإرسال: رصيد المزود غير كاف'
        : isInvalidAction
          ? 'فشل الإرسال: نوع العملية غير مدعوم (Invalid Action)'
          : (isAuto ? 'فشل الإرسال التلقائي للمزود' : 'فشل الإرسال للمزود'),
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
      const providerName = dhruService.apiProvider?.name || 'سيرفر المزود';
      const alertTitle = isCreditError
        ? 'تنبيه عاجل للإدارة: نفاد رصيد المزود الخارجي'
        : (isAuto ? 'تنبيه الإدارة: تعذر الإرسال التلقائي للطلب للمزود' : 'تنبيه الإدارة: فشل إرسال الطلب للمزود');

      void sendTelegramPhotoNotification({
        caption:
          `<b>${alertTitle}</b>\n\n` +
          `- <b>رقم الطلب:</b> #${order.id.slice(-6)}\n` +
          `- <b>اسم الخدمة:</b> ${dhruService.name}\n` +
          `- <b>المزود المربوط:</b> ${providerName}\n` +
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

  if (dhruResponse.SUCCESS && dhruResponse.SUCCESS[0] && dhruResponse.SUCCESS[0].REFERENCEID) {
    apiOrderId = String(dhruResponse.SUCCESS[0].REFERENCEID);
  }

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
