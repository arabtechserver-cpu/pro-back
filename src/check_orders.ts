import { prisma } from './server';

async function check() {
  const orders = await prisma.order.findMany({
    where: {
      status: 'processing'
    }
  });
  console.log(orders.map(o => ({
    id: o.id,
    serviceName: o.serviceName,
    apiOrderId: o.apiOrderId,
    status: o.status
  })));
  process.exit();
}
check();
