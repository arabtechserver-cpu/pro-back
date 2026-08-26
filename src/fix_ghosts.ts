import { prisma } from './server';

async function fixGhostOrders() {
  const ghostOrders = await prisma.order.findMany({
    where: {
      status: 'processing',
      OR: [
        { apiOrderId: null },
        { apiOrderId: 'undefined' }
      ]
    }
  });

  for (const order of ghostOrders) {
    console.log(`Fixing ghost order ${order.id}...`);
    // Mark as failed
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'failed',
        reply: 'مرفوض - خطأ تقني في مزود الخدمة'
      }
    });

    // Refund user
    if (order.userId) {
      await prisma.user.update({
        where: { id: order.userId },
        data: { balance: { increment: order.price } }
      });
      await prisma.transaction.create({
        data: {
          userId: order.userId,
          type: `استرجاع رصيد (طلب وهمي): ${order.serviceName}`,
          amount: order.price,
          method: 'استرجاع النظام',
          refNo: `REF-#${order.id.slice(-6)}`,
          status: 'completed'
        }
      });
      console.log(`Refunded $${order.price} to user ${order.userId}`);
    }
  }

  console.log("Done.");
  process.exit();
}
fixGhostOrders();
