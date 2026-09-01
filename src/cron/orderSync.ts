import cron from 'node-cron';
import { prisma } from '../server';
import { getImeiOrder, getServerOrder } from '../utils/dhru-api';
import { sendTelegramPhotoNotification } from '../utils/telegramService';

// Run every 1 minute
export function initOrderSyncCron() {
  console.log('[CRON] Initializing Order Sync Cron Job (runs every 1 minute)');

  cron.schedule('* * * * *', async () => {
    try {
      console.log('[CRON] Running order sync...');

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

      console.log(`[CRON] Found ${pendingOrders.length} pending orders to check.`);

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

          let response: any = null;
          if (dhruService && dhruService.dhruCategory?.name === "IMEI Service") {
            response = await getImeiOrder(order.apiOrderId, providerConfig);
          } else {
            response = await getServerOrder(order.apiOrderId, providerConfig);
          }

          if (!response || response.SUCCESS === false || response.ERROR || response.Error) {
            console.error(`[CRON] Error checking order ${order.id}:`, response?.Error || response?.ERROR || "Unknown Error");
            continue;
          }

          const statusData = response.SUCCESS?.[0];
          if (!statusData) continue;

          // STATUS VALUES in Dhru (commonly):
          // 0 = Pending, 1 = In Process, 2 = Rejected, 3 = Rejected, 4 = Success
          const apiStatus = String(statusData.STATUS);

          if (apiStatus === "4") {
            // COMPLETED
            const replyCode = statusData.CODE || "تم بنجاح";

            await prisma.order.update({
              where: { id: order.id },
              data: {
                status: 'completed',
                reply: replyCode
              }
            });

            // Notify User & Admin
            const msg = `✅ تم اكتمال طلبك!\nرقم الطلب: #${order.id.slice(-6)}\nالخدمة: ${order.serviceName}\nالكود/النتيجة: ${replyCode}`;
            sendTelegramPhotoNotification({ caption: msg }).catch(() => { });
            console.log(`[CRON] Order ${order.id} marked as COMPLETED.`);
          }
          else if (apiStatus === "3" || apiStatus === "2") {
            // REJECTED
            await prisma.order.update({
              where: { id: order.id },
              data: {
                status: 'failed',
                reply: 'مرفوض من المزود'
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
                  type: `استرجاع رصيد (طلب مرفوض): ${order.serviceName.slice(0, 30)}`,
                  amount: order.price,
                  method: 'استرجاع تلقائي',
                  refNo: `REF-#${order.id.slice(-6)}`,
                  status: 'completed'
                }
              });
            }

            // Notify User & Admin
            const msg = `❌ تم رفض طلبك وإرجاع الرصيد لمحفظتك.\nرقم الطلب: #${order.id.slice(-6)}\nالخدمة: ${order.serviceName}\nالمبلغ المرتجع: $${order.price.toFixed(2)}`;
            sendTelegramPhotoNotification({ caption: msg }).catch(() => { });
            console.log(`[CRON] Order ${order.id} marked as REJECTED and refunded.`);
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
