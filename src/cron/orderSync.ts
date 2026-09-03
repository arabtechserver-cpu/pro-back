import cron from 'node-cron';
import { prisma } from "../utils/prisma";
import { getImeiOrder, getServerOrder } from '../utils/dhru-api';
import { sendTelegramPhotoNotification } from '../utils/telegramService';
import { resolveOrderServiceType } from '../utils/order-response';

// Run every 3 minutes to avoid flooding provider APIs and triggering rate-limits
export function initOrderSyncCron() {
  console.log('[CRON] Initializing Order Sync Cron Job (runs every 3 minutes)');

  cron.schedule('*/3 * * * *', async () => {
    try {
      // Find orders that are processing and have an API Order ID
      const pendingOrders = await prisma.order.findMany({
        where: {
          status: 'processing',
          apiOrderId: { not: null }
        },
        include: { user: true }
      });

      if (pendingOrders.length === 0) {
        return;
      }

      console.log(`[CRON] Found ${pendingOrders.length} pending orders to check with providers.`);

      for (const order of pendingOrders) {
        if (!order.apiOrderId) continue;

        try {
          // Check if it's an IMEI service or Server service
          const dhruService = await prisma.dhruService.findFirst({
            where: {
              OR: [
                { id: String(order.serviceId) },
                { dhruId: String(order.serviceId) }
              ]
            },
            include: { dhruCategory: true, apiProvider: true }
          });

          const providerConfig = dhruService?.apiProvider
            ? {
                apiUrl: dhruService.apiProvider.apiUrl,
                username: dhruService.apiProvider.username,
                apiKey: dhruService.apiProvider.apiKey
              }
            : undefined;

          const isImei = dhruService && resolveOrderServiceType(
            dhruService.apiServiceType,
            dhruService.dhruCategory?.name,
            dhruService.groupName
          ) === "imei";

          let response: any = null;

          // Try primary method based on service type
          if (isImei) {
            response = await getImeiOrder(order.apiOrderId, providerConfig);
            // Fallback: If IMEI check failed or returned error, try server check
            if (!response || response.SUCCESS === false || response.ERROR || response.Error) {
              const fallback = await getServerOrder(order.apiOrderId, providerConfig);
              if (fallback && (fallback.SUCCESS || fallback.RESULT)) {
                response = fallback;
              }
            }
          } else {
            response = await getServerOrder(order.apiOrderId, providerConfig);
            // Fallback: If server check failed or returned error, try IMEI check
            if (!response || response.SUCCESS === false || response.ERROR || response.Error) {
              const fallback = await getImeiOrder(order.apiOrderId, providerConfig);
              if (fallback && (fallback.SUCCESS || fallback.RESULT)) {
                response = fallback;
              }
            }
          }

          // Handle temporary API errors / "Order not found" from provider:
          // CRITICAL: NEVER auto-cancel or refund the order! The provider may be processing it or undergoing maintenance.
          if (!response || response.SUCCESS === false || response.ERROR || response.Error) {
            const errorMsg = response?.Error || response?.ERROR || "API check unavailable";
            console.warn(`[CRON] Order #${order.id.slice(-6)} (Provider Ref: #${order.apiOrderId}) status check returned: "${errorMsg}". Keeping in processing status.`);
            continue;
          }

          const statusData = (Array.isArray(response.SUCCESS) ? response.SUCCESS[0] : null)
            || response.RESULT
            || (Array.isArray(response.result) ? response.result[0] : response.result)
            || response;

          if (!statusData) {
            continue;
          }

          const rawStatus = String(statusData.STATUS ?? statusData.status ?? "").trim();
          const statusLower = rawStatus.toLowerCase();
          const statusText = String(statusData.STATUS_TEXT ?? statusData.status_text ?? "").trim().toLowerCase();
          const replyCode = String(statusData.CODE ?? statusData.code ?? statusData.REPLY ?? statusData.reply ?? "").trim();

          // STATUS in Dhru Fusion:
          // 4 = Completed / Success
          // 3 = Rejected / Canceled
          // 0, 1, 2 = Pending / In Process / Verification
          const isCompleted = rawStatus === "4" 
            || statusLower.includes("complet") 
            || statusLower.includes("success") 
            || statusText.includes("complet") 
            || statusText.includes("success");

          const isRejected = rawStatus === "3" 
            || statusLower.includes("reject") 
            || statusLower.includes("cancel") 
            || statusText.includes("reject") 
            || statusText.includes("cancel");

          if (isCompleted) {
            // COMPLETED
            const finalReply = replyCode || "تم بنجاح من المزود";

            await prisma.order.update({
              where: { id: order.id },
              data: {
                status: 'completed',
                reply: finalReply
              }
            });

            // Notify User & Admin
            const msg = `✅ تم اكتمال طلبك بنجاح!\nرقم الطلب: #${order.id.slice(-6)}\nالخدمة: ${order.serviceName}\nالكود/الرد: ${finalReply}`;
            sendTelegramPhotoNotification({ caption: msg }).catch(() => { });
            console.log(`[CRON] Order #${order.id.slice(-6)} marked as COMPLETED.`);
          }
          else if (isRejected) {
            // REJECTED EXPLICITLY BY PROVIDER
            const rejectReason = replyCode || statusData.REASON || statusData.reason || 'مرفوض من المزود';

            await prisma.order.update({
              where: { id: order.id },
              data: {
                status: 'failed',
                reply: `مرفوض: ${rejectReason}`
              }
            });

            // Refund User
            if (order.userId) {
              await prisma.user.update({
                where: { id: order.userId },
                data: { balance: { increment: order.price } }
              });

              await prisma.transaction.create({
                data: {
                  userId: order.userId,
                  type: `استرجاع رصيد (طلب مرفوض من المزود): ${order.serviceName.slice(0, 30)}`,
                  amount: order.price,
                  method: 'استرجاع تلقائي',
                  refNo: `REF-#${order.id.slice(-6)}`,
                  status: 'completed'
                }
              });
            }

            // Notify User & Admin
            const msg = `❌ تم رفض طلبك من المزود وإرجاع الرصيد لمحفظتك.\nرقم الطلب: #${order.id.slice(-6)}\nالخدمة: ${order.serviceName}\nالسبب: ${rejectReason}\nالمبلغ المرتجع: $${order.price.toFixed(2)}`;
            sendTelegramPhotoNotification({ caption: msg }).catch(() => { });
            console.log(`[CRON] Order #${order.id.slice(-6)} marked as REJECTED and refunded.`);
          }
          else {
            // Still processing (status 0, 1, 2, "In Process", "Pending", etc.)
            console.log(`[CRON] Order #${order.id.slice(-6)} (Ref: #${order.apiOrderId}) is still in progress (Provider Status: ${rawStatus || 'In Process'}).`);
          }

        } catch (err) {
          console.error(`[CRON] Error processing order ${order.id}:`, err);
        }
      }

    } catch (error) {
      console.error('[CRON] General error in order sync:', error);
    }
  });
}
