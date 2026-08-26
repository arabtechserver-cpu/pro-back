"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initOrderSyncCron = initOrderSyncCron;
const node_cron_1 = __importDefault(require("node-cron"));
const server_1 = require("../server");
const dhru_api_1 = require("../utils/dhru-api");
const telegramService_1 = require("../utils/telegramService");
// Run every 1 minute
function initOrderSyncCron() {
    console.log('[CRON] Initializing Order Sync Cron Job (runs every 1 minute)');
    node_cron_1.default.schedule('* * * * *', async () => {
        try {
            console.log('[CRON] Running order sync...');
            // Find orders that are processing and have an API Order ID
            const pendingOrders = await server_1.prisma.order.findMany({
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
                if (!order.apiOrderId)
                    continue;
                try {
                    // Check status from Dhru API
                    const response = await (0, dhru_api_1.getImeiOrder)(order.apiOrderId);
                    if (!response || response.ERROR) {
                        console.error(`[CRON] Error checking order ${order.id}:`, response?.ERROR);
                        continue;
                    }
                    const statusData = response.SUCCESS?.[0];
                    if (!statusData)
                        continue;
                    // STATUS VALUES in Dhru (commonly):
                    // 0 = Pending, 1 = In Process, 2 = Rejected, 3 = Rejected, 4 = Success
                    const apiStatus = String(statusData.STATUS);
                    if (apiStatus === "4") {
                        // COMPLETED
                        const replyCode = statusData.CODE || "تم بنجاح";
                        await server_1.prisma.order.update({
                            where: { id: order.id },
                            data: {
                                status: 'completed',
                                reply: replyCode
                            }
                        });
                        // Notify User & Admin
                        const msg = `✅ تم اكتمال طلبك!\nرقم الطلب: #${order.id.slice(-6)}\nالخدمة: ${order.serviceName}\nالكود/النتيجة: ${replyCode}`;
                        (0, telegramService_1.sendTelegramMessage)(order.user?.email || "", msg).catch(() => { });
                        console.log(`[CRON] Order ${order.id} marked as COMPLETED.`);
                    }
                    else if (apiStatus === "3") {
                        // REJECTED
                        await server_1.prisma.order.update({
                            where: { id: order.id },
                            data: {
                                status: 'failed',
                                reply: 'مرفوض من المزود'
                            }
                        });
                        // Refund User
                        if (order.userId) {
                            await server_1.prisma.user.update({
                                where: { id: order.userId },
                                data: { balance: { increment: order.price } }
                            });
                            await server_1.prisma.transaction.create({
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
                        (0, telegramService_1.sendTelegramMessage)(order.user?.email || "", msg).catch(() => { });
                        console.log(`[CRON] Order ${order.id} marked as REJECTED and refunded.`);
                    }
                }
                catch (err) {
                    console.error(`[CRON] Error processing order ${order.id}:`, err);
                }
            }
        }
        catch (error) {
            console.error('[CRON] General error in order sync:', error);
        }
    });
}
