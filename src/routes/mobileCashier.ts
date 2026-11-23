import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Prisma, type CashierDevice, type CashierLicense, type CashierRepairTrack, type CashierSupportSession } from '@prisma/client';
import { Router, type Request, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticateToken, isAdmin, type AuthRequest } from '../middleware/auth';
import { BoundedRateLimitStore } from '../utils/bounded-rate-limit-store';
import { prisma } from '../utils/prisma';
import { roundCurrency } from '../utils/currency';
import { resolvePrimaryFrontendUrl } from '../utils/telegram-config';

const router = Router();
const day = 86_400_000;
const technician = 'عرب تيك';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = z.uuid();
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const shopName = z.string().trim().min(2).max(120);
const message = z.object({ body: z.string().trim().min(1).max(1500) });
const openStates = ['REQUESTED', 'ACCEPTED', 'ACTIVE'];
const controlConfigured = process.env.MOBILE_CASHIER_APP_CONTROL === 'true';
const controlProvider = controlConfigured ? 'CASHIER_WINDOW' : 'UNCONFIGURED';
const enrollment = z.object({
  machine: hex,
  proof: hex,
  shopName,
  email,
  key: z.string().trim().toUpperCase().regex(/^MC-[A-F0-9]{48}$/).optional(),
});

type Device = CashierDevice & { activeKey: CashierLicense | null };

class CashierError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function fail(status: number, code: string, message: string): never {
  throw new CashierError(status, code, message);
}

function route(fn: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'راجع البيانات المطلوبة وحاول تاني.', code: 'INVALID_INPUT' });
      } else if (err instanceof CashierError) {
        res.status(err.status).json({ code: err.code, error: err.message });
      } else {
        next(err);
      }
    }
  };
}

const licenseLimiter = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: 600_000,
  limit: 25,
  message: { error: 'محاولات تفعيل كثيرة. حاول بعد دقائق.', code: 'TRY_LATER' },
  validate: { xForwardedForHeader: false },
});

function planPrice(plan: { amountMinor: number; discountUntil: Date | null; promoAmountMinor: number | null; discountPercent: number }, now: Date) {
  const offerActive = plan.discountUntil !== null && plan.discountUntil > now;
  return {
    offerActive,
    amountMinor: offerActive ? plan.promoAmountMinor ?? Math.round(plan.amountMinor * (100 - plan.discountPercent) / 100) : plan.amountMinor,
  };
}

function entitlement(device: Device) {
  if (device.activeKey) {
    const until = device.activeKey.expiresAt;
    const status = device.activeKey.revokedAt ? 'REVOKED' : until && until.getTime() > Date.now() ? 'ACTIVE' : 'EXPIRED';
    return { status, until, shopName: device.shopName, email: device.email };
  }
  const until = device.trialEndsAt;
  return { status: until && until.getTime() > Date.now() ? 'TRIAL' : 'EXPIRED', until, shopName: device.shopName, email: device.email };
}

async function authenticate(req: Request): Promise<Device> {
  const match = /^Bearer Cashier\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(req.get('authorization') ?? '');
  if (!match) fail(401, 'DEVICE_REQUIRED', 'التطبيق يحتاج إلى التسجيل على هذا الجهاز.');
  const device = await prisma.cashierDevice.findFirst({
    where: { machineHash: sha256(match[1]), proofHash: sha256(match[2]) },
    include: { activeKey: true },
  });
  if (!device) fail(401, 'DEVICE_REQUIRED', 'التطبيق يحتاج إلى التسجيل على هذا الجهاز.');
  return device;
}

async function licensed(req: Request) {
  const device = await authenticate(req);
  const { status } = entitlement(device);
  if (status !== 'TRIAL' && status !== 'ACTIVE') fail(403, status, 'الترخيص غير ساري.');
  return device;
}

async function enroll(input: z.infer<typeof enrollment>) {
  const machineHash = sha256(input.machine);
  const proofHash = sha256(input.proof);
  // Retry transactions that contend on an enrollment, without consuming a second key.
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        let device = await tx.cashierDevice.findUnique({ where: { machineHash }, include: { activeKey: true } });
        if (device && (device.proofHash !== proofHash || device.email !== input.email)) {
          fail(409, 'DEVICE_REGISTERED', 'الجهاز مسجل بالفعل. تواصل مع عرب تيك لاستعادة التفعيل.');
        }
        const key = input.key ? await tx.cashierLicense.findUnique({ where: { keyHash: sha256(input.key) } }) : null;
        if (input.key && (!key || key.revokedAt || key.customerEmail !== input.email || (key.deviceId && key.deviceId !== device?.id))) {
          fail(403, 'INVALID_KEY', 'المفتاح غير صالح لهذا البريد أو تم استخدامه على جهاز آخر.');
        }
        if (!device) {
          device = await tx.cashierDevice.create({
            data: { machineHash, proofHash, email: input.email, shopName: input.shopName, trialEndsAt: key ? null : new Date(Date.now() + 3 * day) },
            include: { activeKey: true },
          });
        }
        if (!key || key.deviceId) return device;
        const now = Date.now();
        const current = device.activeKey;
        const renewalStart = current && !current.revokedAt ? Math.max(now, current.expiresAt?.getTime() ?? now) : now;
        await tx.cashierLicense.update({
          where: { id: key.id },
          data: { deviceId: device.id, expiresAt: new Date(renewalStart + key.durationDays * day) },
        });
        return tx.cashierDevice.update({
          where: { id: device.id },
          data: { activeKeyId: key.id, lastSeenAt: new Date(now) },
          include: { activeKey: true },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (err) {
      if (attempt < 2 && err instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(err.code)) continue;
      throw err;
    }
  }
}

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function resolveLocalInstaller(): { filePath: string; fileName: string } | null {
  const configuredPath = process.env.MOBILE_CASHIER_INSTALLER_PATH?.trim();
  if (configuredPath) {
    const resolved = path.resolve(configuredPath);
    if (
      resolved.toLowerCase().endsWith('.exe') &&
      fs.existsSync(resolved) &&
      fs.statSync(resolved).isFile()
    ) {
      return { filePath: resolved, fileName: path.basename(resolved) };
    }
    return null;
  }

  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  const releaseRoot = path.resolve(__dirname, '../../../Mobile Cashier/apps/desktop/release');
  if (!fs.existsSync(releaseRoot)) {
    return null;
  }

  const candidates: Array<{ filePath: string; fileName: string; mtimeMs: number }> = [];
  const collectExeFiles = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /^ar-pro-Setup-.+\.exe$/i.test(entry.name)) {
        const filePath = path.join(dir, entry.name);
        candidates.push({ filePath, fileName: entry.name, mtimeMs: fs.statSync(filePath).mtimeMs });
      }
    }
  };

  collectExeFiles(releaseRoot);
  for (const entry of fs.readdirSync(releaseRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && /^ar-pro-/i.test(entry.name)) {
      collectExeFiles(path.join(releaseRoot, entry.name));
    }
  }

  if (!candidates.length) {
    return null;
  }

  candidates.sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.fileName.localeCompare(a.fileName));
  return { filePath: candidates[0].filePath, fileName: candidates[0].fileName };
}

router.get('/product', route(async (_req, res) => {
  const plans = await prisma.cashierPlan.findMany({ where: { active: true }, orderBy: { amountMinor: 'asc' } });
  const now = new Date();
  const configuredUrl = process.env.MOBILE_CASHIER_DOWNLOAD_URL?.trim();
  const downloadUrl = configuredUrl?.startsWith('https://')
    ? configuredUrl
    : resolveLocalInstaller()
      ? '/api/mobile-cashier/download'
      : null;
  res.json({
    trialDays: 3,
    technician,
    downloadUrl,
    plans: plans.map(({ id, name, description, amountMinor, currency, durationDays, discountUntil, discountPercent, promoAmountMinor }) => {
      const { offerActive, amountMinor: offerAmountMinor } = planPrice({ amountMinor, discountUntil, promoAmountMinor, discountPercent }, now);
      return {
        id, name, description, amountMinor, currency, durationDays, offerAmountMinor,
        discountUntil: offerActive && (promoAmountMinor !== null || discountPercent > 0) ? discountUntil : null,
        discountPercent: offerActive ? discountPercent : 0,
      };
    }),
  });
}));

router.get('/download', route(async (_req, res) => {
  const installer = resolveLocalInstaller();
  if (!installer) {
    fail(404, 'INSTALLER_UNAVAILABLE', 'ملف التثبيت غير متوفر حالياً.');
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.download(installer.filePath, installer.fileName);
}));

const checkoutInput = z.object({ planId: uuid, customerEmail: email, requestId: uuid, priceMinor: z.number().int().nonnegative() });
const purchaseDetails = { license: true, transaction: { select: { refNo: true } } } satisfies Prisma.CashierPurchaseInclude;
type PurchaseWithDetails = Prisma.CashierPurchaseGetPayload<{ include: typeof purchaseDetails }>;

function walletMinor(balance: number) {
  return Math.floor(roundCurrency(balance * 100, 2));
}

function purchaseReceipt(purchase: PurchaseWithDetails) {
  const { id, planName, amountMinor, createdAt, license, transaction } = purchase;
  return {
    id, planName, amountMinor, createdAt, refNo: transaction.refNo, durationDays: license.durationDays,
    customerEmail: license.customerEmail, used: license.deviceId !== null, revoked: license.revokedAt !== null, expiresAt: license.expiresAt,
  };
}

function purchaseKey(licenseId: string) {
  const secret = process.env.CASHIER_PURCHASE_KEY_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < 32) fail(503, 'KEY_UNAVAILABLE', 'إصدار أكواد التفعيل غير متاح مؤقتًا.');
  // Keep only a hash in the database, while allowing the buyer to recover their code.
  return 'MC-' + createHmac('sha256', secret).update(`ar-pro-wallet-license:v1:${licenseId}`).digest('hex').slice(0, 48).toUpperCase();
}

function recoverPurchaseKey(purchase: PurchaseWithDetails) {
  if (purchase.license.revokedAt) fail(403, 'KEY_REVOKED', 'كود التفعيل موقوف.');
  const key = purchaseKey(purchase.licenseId);
  if (sha256(key) !== purchase.license.keyHash) fail(503, 'KEY_UNAVAILABLE', 'استرجاع كود التفعيل غير متاح مؤقتًا.');
  return key;
}

router.get('/checkout', authenticateToken, route(async (req, res) => {
  const buyer = (req as AuthRequest).user;
  const planId = req.query.planId === undefined ? null : uuid.parse(req.query.planId);
  const [plan, purchases] = await Promise.all([
    planId ? prisma.cashierPlan.findFirst({ where: { id: planId, active: true, currency: 'USD' } }) : null,
    prisma.cashierPurchase.findMany({ where: { buyerId: buyer.id }, orderBy: { createdAt: 'desc' }, take: 50, include: purchaseDetails }),
  ]);
  res.json({
    email: buyer.email,
    balanceMinor: walletMinor(buyer.balance),
    plan: plan ? { id: plan.id, name: plan.name, durationDays: plan.durationDays, priceMinor: planPrice(plan, new Date()).amountMinor } : null,
    purchases: purchases.map(purchaseReceipt),
  });
}));

router.post('/checkout', authenticateToken, route(async (req, res) => {
  const buyerId: string = (req as AuthRequest).user.id;
  const input = checkoutInput.parse(req.body);
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.cashierPurchase.findUnique({
          where: { buyerId_requestId: { buyerId, requestId: input.requestId } }, include: purchaseDetails,
        });
        if (existing) {
          if (existing.license.planId !== input.planId || existing.license.customerEmail !== input.customerEmail) {
            fail(409, 'REQUEST_MISMATCH', 'الطلب ده اتسجل ببيانات مختلفة. راجع مشترياتك.');
          }
          const buyer = await tx.user.findUniqueOrThrow({ where: { id: buyerId }, select: { balance: true } });
          return { purchase: existing, key: recoverPurchaseKey(existing), balanceMinor: walletMinor(buyer.balance), replay: true };
        }

        const plan = await tx.cashierPlan.findFirst({ where: { id: input.planId, active: true, currency: 'USD' } });
        if (!plan) fail(404, 'PLAN_NOT_FOUND', 'الباقة غير متاحة للشراء حاليًا.');
        const amountMinor = planPrice(plan, new Date()).amountMinor;
        if (input.priceMinor !== amountMinor) fail(409, 'PRICE_CHANGED', 'سعر الباقة اتغيّر. راجع السعر الجديد قبل التأكيد.');

        const licenseId = randomUUID();
        const key = purchaseKey(licenseId);
        const amount = amountMinor / 100;
        const update = await tx.user.updateMany({
          where: { id: buyerId, deletedAt: null, status: { not: 'suspended' }, balance: { gte: amount } },
          data: { balance: { decrement: amount } },
        });
        if (!update.count) fail(402, 'INSUFFICIENT_BALANCE', 'رصيد المحفظة غير كافي. اشحن محفظتك وحاول تاني.');
        const buyer = await tx.user.findUniqueOrThrow({ where: { id: buyerId }, select: { balance: true } });
        const balance = roundCurrency(buyer.balance, 4);
        if (balance !== buyer.balance) await tx.user.update({ where: { id: buyerId }, data: { balance } });

        const id = randomUUID();
        const debit = await tx.transaction.create({ data: {
          userId: buyerId, type: `خصم اشتراك ar-pro - ${plan.name}`, amount, method: 'رصيد المحفظة', status: 'completed',
          refNo: 'ARPRO-' + id.replaceAll('-', '').slice(0, 16).toUpperCase(),
        } });
        await tx.cashierLicense.create({ data: {
          id: licenseId, keyHash: sha256(key), suffix: key.slice(-6), customerEmail: input.customerEmail,
          planId: plan.id, durationDays: plan.durationDays, issuedBy: buyerId,
        } });
        const purchase = await tx.cashierPurchase.create({
          data: { id, buyerId, requestId: input.requestId, planName: plan.name, amountMinor, licenseId, transactionId: debit.id },
          include: purchaseDetails,
        });
        return { purchase, key, balanceMinor: walletMinor(balance), replay: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      res.status(result.replay ? 200 : 201).json({ purchase: purchaseReceipt(result.purchase), key: result.key, balanceMinor: result.balanceMinor });
      return;
    } catch (err) {
      if (attempt < 3 && err instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(err.code)) continue;
      throw err;
    }
  }
}));

router.get('/checkout/:id/key', authenticateToken, route(async (req, res) => {
  const purchase = await prisma.cashierPurchase.findFirst({
    where: { id: uuid.parse(req.params.id), buyerId: (req as AuthRequest).user.id }, include: purchaseDetails,
  });
  if (!purchase) fail(404, 'PURCHASE_NOT_FOUND', 'الطلب غير موجود.');
  res.json({ key: recoverPurchaseKey(purchase) });
}));

router.post('/enroll', licenseLimiter, route(async (req, res) => {
  res.json(entitlement(await enroll(enrollment.parse(req.body))));
}));

router.get('/entitlement', route(async (req, res) => {
  const device = await authenticate(req);
  if (Date.now() - device.lastSeenAt.getTime() > 300_000) {
    await prisma.cashierDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  }
  res.json(entitlement(device));
}));

const planInput = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).default(''),
  amountMinor: z.number().int().min(0).max(100_000_000),
  currency: z.enum(['EGP', 'USD', 'EUR', 'SAR', 'AED']),
  durationDays: z.number().int().min(1).max(3660),
  active: z.boolean().default(true),
  discountPercent: z.number().int().min(0).max(100).default(0),
  promoAmountMinor: z.number().int().min(0).max(100_000_000).nullable().optional(),
  discountDays: z.number().int().min(1).max(366).nullable().default(null),
});

function operator(req: Request): string {
  const user = req as Request & { user?: { id?: string } };
  return String(user.user?.id ?? '') || fail(403, 'ADMIN_REQUIRED', 'يلزم تسجيل الدخول كمسؤول.');
}

function planData(body: unknown, previous?: { discountUntil: Date | null; promoAmountMinor: number | null }) {
  const { discountDays, promoAmountMinor, ...data } = planInput.parse(body);
  const fixedPrice = promoAmountMinor === undefined && data.discountPercent === 0
    ? previous?.promoAmountMinor ?? null
    : promoAmountMinor ?? null;
  if (fixedPrice !== null && (fixedPrice >= data.amountMinor || data.discountPercent > 0)) {
    fail(400, 'INVALID_PROMO_PRICE', 'السعر خلال العرض لازم يكون أقل من السعر الأساسي. اختار سعر عرض أو نسبة خصم.');
  }
  const hasOffer = fixedPrice !== null || data.discountPercent > 0;
  const discountUntil = hasOffer
    ? discountDays ? new Date(Date.now() + discountDays * day) : previous?.discountUntil ?? null
    : null;
  if (hasOffer && !discountUntil) fail(400, 'DISCOUNT_DURATION', 'حدد مدة العرض بالأيام.');
  return { ...data, promoAmountMinor: fixedPrice, discountUntil };
}

router.use('/admin', (req, _res, next) => {
  req.headers['x-admin-request'] = 'true';
  next();
}, isAdmin);
router.get('/admin/plans', route(async (_req, res) => {
  res.json(await prisma.cashierPlan.findMany({ orderBy: { createdAt: 'desc' } }));
}));
router.post('/admin/plans', route(async (req, res) => {
  res.status(201).json(await prisma.cashierPlan.create({ data: planData(req.body) }));
}));
router.put('/admin/plans/:id', route(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const previous = await prisma.cashierPlan.findUnique({ where: { id } });
  if (!previous) fail(404, 'PLAN_NOT_FOUND', 'الباقة غير موجودة.');
  res.json(await prisma.cashierPlan.update({ where: { id }, data: planData(req.body, previous) }));
}));
router.get('/admin/licenses', route(async (_req, res) => {
  res.json(await prisma.cashierLicense.findMany({
    take: 200,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, suffix: true, customerEmail: true, durationDays: true, expiresAt: true, revokedAt: true, createdAt: true,
      plan: { select: { name: true } }, device: { select: { shopName: true } },
      purchase: { select: { amountMinor: true, transaction: { select: { refNo: true } } } },
    },
  }));
}));
router.post('/admin/licenses', route(async (req, res) => {
  const { planId, customerEmail } = z.object({ planId: uuid, customerEmail: email }).parse(req.body);
  const plan = await prisma.cashierPlan.findFirst({ where: { id: planId, active: true } });
  if (!plan) fail(404, 'PLAN_NOT_FOUND', 'الباقة غير موجودة أو غير مفعلة.');
  const key = 'MC-' + randomBytes(24).toString('hex').toUpperCase();
  await prisma.cashierLicense.create({
    data: { keyHash: sha256(key), suffix: key.slice(-6), customerEmail, planId, durationDays: plan.durationDays, issuedBy: operator(req) },
  });
  res.status(201).json({ key });
}));
router.post('/admin/licenses/:id/revoke', route(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { count } = await prisma.cashierLicense.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
  res.json({ revoked: count > 0 });
}));
router.get('/admin/customers', route(async (_req, res) => {
  const devices = await prisma.cashierDevice.findMany({ include: { activeKey: true }, orderBy: { lastSeenAt: 'desc' }, take: 200 });
  res.json(devices.map((device) => ({ id: device.id, lastSeenAt: device.lastSeenAt, ...entitlement(device) })));
}));

// Only the latest frame is retained in process memory and served to the assigned operator.
const frames = new Map<string, { bytes: Buffer; expires: number }>();
const frameRetentionMs = 7_000;
const standardKeys = z.enum(['Backspace', 'Delete', 'Enter', 'Tab', 'Left', 'Right', 'Up', 'Down', 'Home', 'End']);
const inputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(32).regex(/^[^\x00-\x1f\x7f]+$/u) }),
  z.object({ type: z.literal('key'), key: standardKeys }),
]);
type ControlInput = z.infer<typeof inputSchema>;
const inputQueue = new Map<string, Array<{ input: ControlInput; expires: number }>>();

setInterval(() => {
  const now = Date.now();
  for (const [id, frame] of frames) if (frame.expires <= now) frames.delete(id);
  for (const [id, commands] of inputQueue) if (commands.every((command) => command.expires <= now)) inputQueue.delete(id);
}, frameRetentionMs).unref();

function allowsFrame(session: CashierSupportSession) {
  return session.mode === 'VIEW_ONLY' || (session.mode === 'CONTROL' && controlConfigured);
}

function sessionStatus(session: CashierSupportSession) {
  return openStates.includes(session.status) && session.expiresAt.getTime() <= Date.now()
    ? { ...session, status: 'EXPIRED' }
    : session;
}

function supportDto(session: CashierSupportSession) {
  const { id, code, mode, status, notes, consentAt, expiresAt, endedAt, endedBy } = sessionStatus(session);
  return { id, code, mode, status, notes, consentAt, expiresAt, endedAt, endedBy, controlProvider };
}

async function getSession(id: string, owner: { deviceId?: string; operatorId?: string } = {}) {
  const session = await prisma.cashierSupportSession.findFirst({ where: { id: uuid.parse(id), ...owner } });
  if (!session) fail(404, 'SESSION_NOT_FOUND', 'جلسة الدعم غير موجودة.');
  return sessionStatus(session);
}

async function endSession(id: string, owner: { deviceId?: string; operatorId?: string }, endedBy: string) {
  const session = await getSession(id, owner);
  await prisma.cashierSupportSession.updateMany({
    where: { id: session.id, ...owner, status: { in: openStates }, expiresAt: { gt: new Date() } },
    data: { status: 'ENDED', endedAt: new Date(), endedBy },
  });
  frames.delete(session.id);
  inputQueue.delete(session.id);
  return { ok: true };
}

router.get('/support', route(async (req, res) => {
  const device = await licensed(req);
  const sessions = await prisma.cashierSupportSession.findMany({ where: { deviceId: device.id }, orderBy: { consentAt: 'desc' }, take: 35 });
  res.json({ technician, provider: controlProvider, sessions: sessions.map(supportDto) });
}));
router.post('/support', route(async (req, res) => {
  const device = await licensed(req);
  const { mode, notes } = z.object({
    mode: z.enum(['VIEW_ONLY', 'CONTROL']),
    consent: z.literal(true),
    notes: z.string().trim().max(700).default(''),
  }).parse(req.body);
  try {
    const session = await prisma.$transaction(async (tx) => {
      const open = await tx.cashierSupportSession.findFirst({ where: { deviceId: device.id, status: { in: openStates }, expiresAt: { gt: new Date() } } });
      if (open) fail(409, 'SESSION_OPEN', 'أنهِ جلسة الدعم الحالية قبل فتح جلسة جديدة.');
      return tx.cashierSupportSession.create({
        data: { deviceId: device.id, code: randomBytes(6).toString('hex').toUpperCase(), mode, notes, expiresAt: new Date(Date.now() + 1_800_000) },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    res.status(201).json(supportDto(session));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      fail(409, 'SESSION_OPEN', 'يوجد طلب دعم على هذا الجهاز بالفعل.');
    }
    throw err;
  }
}));
router.post('/support/:id/end', route(async (req, res) => {
  const device = await authenticate(req);
  res.json(await endSession(String(req.params.id), { deviceId: device.id }, 'CUSTOMER'));
}));
router.get('/admin/support', route(async (req, res) => {
  const operatorId = operator(req);
  const sessions = await prisma.cashierSupportSession.findMany({
    include: { device: { select: { shopName: true, email: true } } },
    orderBy: { consentAt: 'desc' }, take: 100,
  });
  res.json(sessions.map((session) => ({ ...supportDto(session), ...session.device, assignedToMe: operatorId === session.operatorId })));
}));
router.post('/admin/support/:id/accept', route(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const result = await prisma.cashierSupportSession.updateMany({
    where: { id, status: 'REQUESTED', operatorId: null, expiresAt: { gt: new Date() } },
    data: { status: 'ACCEPTED', operatorId: operator(req), acceptedAt: new Date() },
  });
  if (!result.count) fail(409, 'SESSION_UNAVAILABLE', 'الطلب غير متاح أو تم قبوله.');
  res.json({ ok: true });
}));
router.post('/admin/support/:id/end', route(async (req, res) => {
  res.json(await endSession(String(req.params.id), { operatorId: operator(req) }, 'TECHNICIAN'));
}));

async function supportMessages(session: CashierSupportSession) {
  return (await prisma.cashierSupportMessage.findMany({
    where: { sessionId: session.id }, orderBy: { createdAt: 'desc' }, take: 100,
  })).reverse();
}

async function writeMessage(session: CashierSupportSession, body: unknown, author: 'CUSTOMER' | 'TECHNICIAN') {
  const input = message.parse(body);
  if (!openStates.includes(session.status)) fail(409, 'SESSION_CLOSED', 'انتهت جلسة الدعم.');
  return prisma.cashierSupportMessage.create({ data: { sessionId: session.id, author, body: input.body } });
}

router.get('/support/:id/messages', route(async (req, res) => {
  const device = await licensed(req);
  res.json(await supportMessages(await getSession(String(req.params.id), { deviceId: device.id })));
}));
router.post('/support/:id/messages', route(async (req, res) => {
  const device = await licensed(req);
  res.status(201).json(await writeMessage(await getSession(String(req.params.id), { deviceId: device.id }), req.body, 'CUSTOMER'));
}));
router.get('/admin/support/:id/messages', route(async (req, res) => {
  res.json(await supportMessages(await getSession(String(req.params.id))));
}));
router.post('/admin/support/:id/messages', route(async (req, res) => {
  res.status(201).json(await writeMessage(await getSession(String(req.params.id), { operatorId: operator(req) }), req.body, 'TECHNICIAN'));
}));
router.post('/support/:id/frame', route(async (req, res) => {
  const device = await licensed(req);
  const session = await getSession(String(req.params.id), { deviceId: device.id });
  if (!allowsFrame(session) || !['ACCEPTED', 'ACTIVE'].includes(session.status)) {
    fail(409, 'VIEW_UNAVAILABLE', 'المشاهدة غير متاحة لهذه الجلسة.');
  }
  const { jpeg } = z.object({ jpeg: z.base64().max(260_000) }).parse(req.body);
  const bytes = Buffer.from(jpeg, 'base64');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    fail(400, 'INVALID_FRAME', 'صورة الجلسة غير صالحة.');
  }
  const now = Date.now();
  for (const [id, frame] of frames) if (frame.expires <= now) frames.delete(id);
  if (frames.size >= 40 && !frames.has(session.id)) fail(503, 'VIEW_BUSY', 'خدمة المشاهدة مشغولة حالياً.');
  if (session.status === 'ACCEPTED') {
    const started = await prisma.cashierSupportSession.updateMany({
      where: { id: session.id, status: 'ACCEPTED', expiresAt: { gt: new Date() } }, data: { status: 'ACTIVE' },
    });
    if (!started.count) fail(409, 'SESSION_CLOSED', 'انتهت جلسة الدعم.');
  }
  frames.set(session.id, { bytes, expires: now + frameRetentionMs });
  res.status(204).end();
}));
router.get('/admin/support/:id/frame', route(async (req, res) => {
  const session = await getSession(String(req.params.id), { operatorId: operator(req) });
  const frame = frames.get(session.id);
  if (!allowsFrame(session) || session.status !== 'ACTIVE' || !frame || frame.expires <= Date.now()) {
    frames.delete(session.id);
    res.status(204).end();
    return;
  }
  res.type('jpeg').send(frame.bytes);
}));

function requireControl(session: CashierSupportSession) {
  if (!controlConfigured || session.mode !== 'CONTROL' || session.status !== 'ACTIVE') {
    fail(409, 'CONTROL_UNAVAILABLE', 'التحكم غير متاح لهذه الجلسة.');
  }
}

router.post('/admin/support/:id/input', route(async (req, res) => {
  const session = await getSession(String(req.params.id), { operatorId: operator(req) });
  requireControl(session);
  const frame = frames.get(session.id);
  const now = Date.now();
  if (!frame || frame.expires <= now) fail(409, 'VIEW_UNAVAILABLE', 'اتصال نافذة العميل غير متاح.');
  const input = inputSchema.parse(req.body);
  const waiting = (inputQueue.get(session.id) ?? []).filter((item) => item.expires > now);
  if (waiting.length >= 12) fail(429, 'CONTROL_BUSY', 'انتظر تنفيذ الأوامر الحالية.');
  waiting.push({ input, expires: now + 3500 });
  inputQueue.set(session.id, waiting);
  res.status(204).end();
}));

router.post('/support/:id/input', route(async (req, res) => {
  const device = await licensed(req);
  const session = await getSession(String(req.params.id), { deviceId: device.id });
  requireControl(session);
  const commands = inputQueue.get(session.id) ?? [];
  inputQueue.delete(session.id);
  const now = Date.now();
  res.json(commands.filter((item) => item.expires > now).map((item) => item.input));
}));

const trackingLimiter = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: 60_000,
  limit: 60,
  message: { error: 'محاولات كثيرة. حاول بعد دقيقة.', code: 'TRY_LATER' },
  validate: { xForwardedForHeader: false },
});

const timelineStepSchema = z.object({
  toStatus: z.string().trim().min(1).max(60),
  createdAt: z.string().trim().min(1).max(60),
});

const publishTrackingSchema = z.object({
  localRepairId: z.string().trim().min(1).max(120),
  orderNumber: z.string().trim().min(1).max(80),
  shopName: z.string().trim().min(1).max(120),
  shopPhone: z.string().trim().max(40).nullable().optional(),
  deviceType: z.string().trim().min(1).max(40).default('PHONE'),
  brand: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  status: z.string().trim().min(1).max(40),
  quoteApprovalStatus: z.enum(['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED']).default('NOT_REQUIRED'),
  estimatedPrice: z.number().min(0).max(100_000_000),
  paidAmount: z.number().min(0).max(100_000_000).default(0),
  remainingAmount: z.number().min(0).max(100_000_000).default(0),
  currency: z.string().trim().min(2).max(8).default('EGP'),
  warrantyDays: z.number().int().min(0).max(1095).default(30),
  dueAt: z.string().trim().max(60).nullable().optional(),
  deliveredAt: z.string().trim().max(60).nullable().optional(),
  orderCreatedAt: z.string().trim().min(1).max(60),
  timeline: z.array(timelineStepSchema).max(50).default([]),
  rotateToken: z.boolean().default(false),
});

const quoteResponseSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  note: z.string().trim().max(300).optional(),
});

function parseOptionalDate(val: string | null | undefined): Date | null {
  if (!val) return null;
  const ts = Date.parse(val);
  return Number.isNaN(ts) ? null : new Date(ts);
}

function publicTrackingBaseUrl(): string {
  return resolvePrimaryFrontendUrl(null, process.env.FRONTEND_URL, process.env.NEXT_PUBLIC_SITE_URL) || 'https://arabproserver.com';
}

function parseTimeline(raw: string): Array<{ toStatus: string; createdAt: string }> {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function publicTrackDto(track: CashierRepairTrack) {
  return {
    shopName: track.shopName,
    shopPhone: track.shopPhone,
    orderNumber: track.orderNumber,
    deviceType: track.deviceType,
    brand: track.brand,
    model: track.model,
    status: track.status,
    quoteApprovalStatus: track.quoteApprovalStatus,
    quoteNote: track.quoteNote,
    quoteRespondedAt: track.quoteRespondedAt,
    estimatedPrice: track.estimatedPrice,
    paidAmount: track.paidAmount,
    remainingAmount: track.remainingAmount,
    currency: track.currency,
    warrantyDays: track.warrantyDays,
    dueAt: track.dueAt,
    deliveredAt: track.deliveredAt,
    createdAt: track.orderCreatedAt,
    updatedAt: track.updatedAt,
    timeline: parseTimeline(track.timelineJson),
  };
}

router.post('/tracking/publish', route(async (req, res) => {
  const device = await licensed(req);
  const input = publishTrackingSchema.parse(req.body);
  const existing = await prisma.cashierRepairTrack.findUnique({
    where: { deviceId_localRepairId: { deviceId: device.id, localRepairId: input.localRepairId } },
  });

  const preserveDecision = existing &&
    ['APPROVED', 'REJECTED'].includes(existing.quoteApprovalStatus) &&
    input.quoteApprovalStatus === 'PENDING';

  const nextQuoteStatus = preserveDecision ? existing.quoteApprovalStatus : input.quoteApprovalStatus;
  const nextQuoteNote = preserveDecision ? existing.quoteNote : (existing?.quoteApprovalStatus === input.quoteApprovalStatus ? existing.quoteNote : null);
  const nextQuoteRespondedAt = preserveDecision ? existing.quoteRespondedAt : (existing?.quoteApprovalStatus === input.quoteApprovalStatus ? existing.quoteRespondedAt : null);

  let nextTimeline = input.timeline;
  if (preserveDecision) {
    const existingTimeline = parseTimeline(existing.timelineJson);
    const customerSteps = existingTimeline.filter((s) => s.toStatus === 'QUOTE_APPROVED' || s.toStatus === 'QUOTE_REJECTED');
    if (customerSteps.length) {
      const seen = new Set(nextTimeline.map((s) => `${s.toStatus}:${s.createdAt}`));
      nextTimeline = [
        ...nextTimeline,
        ...customerSteps.filter((s) => !seen.has(`${s.toStatus}:${s.createdAt}`)),
      ];
    }
  }

  const orderCreatedAt = parseOptionalDate(input.orderCreatedAt) ?? new Date();
  const baseData = {
    shopName: input.shopName,
    shopPhone: input.shopPhone ?? null,
    orderNumber: input.orderNumber,
    deviceType: input.deviceType,
    brand: input.brand,
    model: input.model,
    status: input.status,
    quoteApprovalStatus: nextQuoteStatus,
    quoteNote: nextQuoteNote,
    quoteRespondedAt: nextQuoteRespondedAt,
    estimatedPrice: input.estimatedPrice,
    paidAmount: input.paidAmount,
    remainingAmount: input.remainingAmount,
    currency: input.currency,
    warrantyDays: input.warrantyDays,
    dueAt: parseOptionalDate(input.dueAt),
    deliveredAt: parseOptionalDate(input.deliveredAt),
    orderCreatedAt,
    timelineJson: JSON.stringify(nextTimeline),
  };

  if (existing && !existing.revokedAt && !input.rotateToken) {
    const updated = await prisma.cashierRepairTrack.update({
      where: { id: existing.id },
      data: baseData,
    });
    return res.json({
      synced: true,
      quoteApprovalStatus: updated.quoteApprovalStatus,
      quoteNote: updated.quoteNote,
      quoteRespondedAt: updated.quoteRespondedAt,
    });
  }

  const token = randomBytes(24).toString('base64url');
  const tokenHash = sha256(token);
  const saved = await prisma.cashierRepairTrack.upsert({
    where: { deviceId_localRepairId: { deviceId: device.id, localRepairId: input.localRepairId } },
    update: {
      ...baseData,
      tokenHash,
      revokedAt: null,
    },
    create: {
      deviceId: device.id,
      localRepairId: input.localRepairId,
      tokenHash,
      ...baseData,
    },
  });

  res.json({
    synced: true,
    token,
    trackingUrl: `${publicTrackingBaseUrl()}/ar/track/${token}`,
    quoteApprovalStatus: saved.quoteApprovalStatus,
    quoteNote: saved.quoteNote,
    quoteRespondedAt: saved.quoteRespondedAt,
  });
}));

router.post('/tracking/revoke', route(async (req, res) => {
  const device = await licensed(req);
  const { localRepairId } = z.object({ localRepairId: z.string().trim().min(1).max(120) }).parse(req.body);
  const { count } = await prisma.cashierRepairTrack.updateMany({
    where: { deviceId: device.id, localRepairId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  res.json({ revoked: count > 0 });
}));

router.get('/public/track/:token', trackingLimiter, route(async (req, res) => {
  const token = String(req.params.token ?? '').trim();
  if (!token || token.length < 16 || token.length > 128) {
    fail(404, 'TRACKING_NOT_FOUND', 'رابط التتبع غير صالح أو تم إلغاؤه.');
  }
  const track = await prisma.cashierRepairTrack.findFirst({
    where: { tokenHash: sha256(token), revokedAt: null },
  });
  if (!track) {
    fail(404, 'TRACKING_NOT_FOUND', 'رابط التتبع غير صالح أو تم إلغاؤه.');
  }
  res.json(publicTrackDto(track));
}));

router.post('/public/track/:token/quote-response', trackingLimiter, route(async (req, res) => {
  const token = String(req.params.token ?? '').trim();
  if (!token || token.length < 16 || token.length > 128) {
    fail(404, 'TRACKING_NOT_FOUND', 'رابط التتبع غير صالح أو تم إلغاؤه.');
  }
  const { decision, note } = quoteResponseSchema.parse(req.body);
  const track = await prisma.cashierRepairTrack.findFirst({
    where: { tokenHash: sha256(token), revokedAt: null },
  });
  if (!track) {
    fail(404, 'TRACKING_NOT_FOUND', 'رابط التتبع غير صالح أو تم إلغاؤه.');
  }
  if (track.status === 'DELIVERED' || track.status === 'CANCELLED') {
    fail(400, 'ORDER_CLOSED', 'الطلب مغلق بالفعل ولا يمكن تعديل عرض السعر.');
  }
  if (track.quoteApprovalStatus !== 'PENDING') {
    fail(409, 'QUOTE_ALREADY_DECIDED', 'تم تسجيل رد عرض السعر مسبقاً.');
  }

  const now = new Date();
  const timeline = parseTimeline(track.timelineJson);
  timeline.push({
    toStatus: decision === 'APPROVED' ? 'QUOTE_APPROVED' : 'QUOTE_REJECTED',
    createdAt: now.toISOString(),
  });

  const updated = await prisma.cashierRepairTrack.update({
    where: { id: track.id },
    data: {
      quoteApprovalStatus: decision,
      quoteNote: note || null,
      quoteRespondedAt: now,
      timelineJson: JSON.stringify(timeline),
    },
  });
  res.json(publicTrackDto(updated));
}));

export default router;
