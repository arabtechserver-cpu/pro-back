const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Starting data cleanup...');

  // Delete all orders
  const orders = await prisma.order.deleteMany({});
  console.log(`Deleted ${orders.count} orders.`);

  // Delete all transactions (wallet)
  const transactions = await prisma.transaction.deleteMany({});
  console.log(`Deleted ${transactions.count} wallet transactions.`);
  
  const walletTransactions = await prisma.walletTransaction.deleteMany({});
  console.log(`Deleted ${walletTransactions.count} old wallet transactions.`);

  // Delete all services and categories
  const services = await prisma.dhruService.deleteMany({});
  console.log(`Deleted ${services.count} services.`);
  
  const categories = await prisma.dhruCategory.deleteMany({});
  console.log(`Deleted ${categories.count} service categories.`);

  // Delete all blog posts
  const blogs = await prisma.blogPost.deleteMany({});
  console.log(`Deleted ${blogs.count} blog posts.`);

  // Delete all videos
  const videos = await prisma.videoTutorial.deleteMany({});
  console.log(`Deleted ${videos.count} videos.`);
  
  const series = await prisma.videoSeries.deleteMany({});
  console.log(`Deleted ${series.count} video series.`);

  // Delete all analytics events
  const events = await prisma.analyticsEvent.deleteMany({});
  console.log(`Deleted ${events.count} analytics events.`);

  // Delete all users except admin
  const users = await prisma.user.deleteMany({
    where: {
      email: {
        not: 'admin@admin.com'
      }
    }
  });
  console.log(`Deleted ${users.count} non-admin users.`);

  console.log('Data cleanup finished successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
