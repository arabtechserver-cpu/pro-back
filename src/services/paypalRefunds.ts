import { PrismaClient } from '@prisma/client';

export class PayPalRefundError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function identifier(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : '';
}

export function parsePayPalRefund(event: any) {
  const isReversal = event?.event_type === 'PAYMENT.CAPTURE.REVERSED';
  if (!isReversal && event?.event_type !== 'PAYMENT.CAPTURE.REFUNDED') {
    throw new PayPalRefundError('Unsupported refund event');
  }
  const resource = event?.resource;
  const eventId = identifier(event?.id);
  const resourceId = identifier(resource?.id);
  let captureId = isReversal ? resourceId : identifier(resource?.supplementary_data?.related_ids?.capture_id);

  // Refund resources have their own ID. The "up" link identifies the capture;
  // it is parsed locally, never fetched (no webhook-controlled outbound URL).
  if (!isReversal && Array.isArray(resource?.links)) {
    for (const link of resource.links) {
      if (link?.rel !== 'up' || typeof link.href !== 'string') continue;
      try {
        const url = new URL(link.href);
        const hosts = ['api.paypal.com', 'api-m.paypal.com', 'api.sandbox.paypal.com', 'api-m.sandbox.paypal.com'];
        const match = url.pathname.match(/^\/v2\/payments\/captures\/([A-Za-z0-9_-]+)\/?$/);
        if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port || url.username || url.password || !match) continue;
        if (captureId && captureId !== match[1]) throw new PayPalRefundError('Conflicting capture identifiers');
        captureId = identifier(match[1]);
      } catch (error) {
        if (error instanceof PayPalRefundError) throw error;
      }
    }
  }

  const value = resource?.amount?.value;
  const currency = resource?.amount?.currency_code;
  const amount = typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value) ? Number(value) : NaN;
  const cents = Math.round(amount * 100);
  if (!eventId || !resourceId || !captureId) throw new PayPalRefundError('Missing refund, event, or capture identifier');
  if (!Number.isSafeInteger(cents) || cents <= 0 || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new PayPalRefundError('Invalid refund amount or currency');
  }
  return { eventId, resourceId: `${isReversal ? 'reversal' : 'refund'}:${resourceId}`, captureId, cents, currency, isReversal };
}

/** Call only after verifying the webhook signature with PayPal. */
export async function applyPayPalRefund(db: PrismaClient, event: any) {
  const refund = parsePayPalRefund(event);
  return db.$transaction(async tx => {
    // Lock the payment, not the Node process: workers and duplicate webhook
    // deliveries serialize here, including distinct partial refunds.
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "PaymentIntent"
      WHERE "provider" = 'paypal' AND "captureId" = ${refund.captureId}
      FOR UPDATE`;
    if (!rows.length) throw new PayPalRefundError('Capture not recorded yet; retry webhook', 503);
    const intent = await tx.paymentIntent.findUniqueOrThrow({ where: { id: rows[0].id } });

    const previous = await tx.paymentRefund.findFirst({
      where: { OR: [{ resourceId: refund.resourceId }, { eventId: refund.eventId }] }
    });
    if (previous) {
      if (previous.paymentIntentId !== intent.id) throw new PayPalRefundError('Refund identifier conflict', 409);
      return { duplicate: true };
    }
    if (refund.currency !== intent.currency) throw new PayPalRefundError('Refund currency mismatch');
    if (!['completed', 'partially_refunded', 'refunded'].includes(intent.status)) {
      throw new PayPalRefundError('Capture credit not recorded yet; retry webhook', 503);
    }

    const totalCents = Math.round(intent.amount * 100);
    const refundedCents = Math.round(intent.refundedAmount * 100);
    const remaining = totalCents - refundedCents;
    if (!Number.isSafeInteger(totalCents) || !Number.isSafeInteger(refundedCents) || refundedCents < 0 || remaining < 0) {
      throw new PayPalRefundError('Invalid stored refund balance', 409);
    }
    if (refund.cents > totalCents || (!refund.isReversal && refund.cents > remaining)) {
      throw new PayPalRefundError('Refund exceeds the remaining captured amount');
    }
    // A full reversal after a partial refund may report the original total.
    // Never debit funds already removed by an earlier refund.
    const debitCents = refund.isReversal ? Math.min(refund.cents, remaining) : refund.cents;
    const amount = debitCents / 100;
    await tx.paymentRefund.create({ data: {
      paymentIntentId: intent.id, resourceId: refund.resourceId,
      eventId: refund.eventId, amount, currency: refund.currency
    } });
    if (debitCents === 0) return { duplicate: true };

    await tx.paymentIntent.update({ where: { id: intent.id }, data: {
      refundedAmount: (refundedCents + debitCents) / 100,
      status: debitCents === remaining ? 'refunded' : 'partially_refunded'
    } });
    await tx.transaction.create({ data: {
      userId: intent.userId, type: 'عكس عملية شحن (PayPal Refund/Reversal)',
      amount, method: 'PayPal Reversal', status: 'completed',
      refNo: `PAYPAL_REVERSAL_${refund.captureId}_${refund.resourceId}`
    } });
    await tx.user.update({ where: { id: intent.userId }, data: { balance: { decrement: amount } } });
    return { duplicate: false, amount };
  });
}
