import { prisma } from '../server';

/**
 * Automatically checks and upgrades a user's membership tier
 * based on their total deposits, current wallet balance, or single deposit amount.
 */
export async function checkAndAutoUpgradeMembership(userId: string, depositAmount?: number) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { membershipTier: true }
    });
    if (!user) return null;

    // Calculate total completed deposits in database
    const totalDepositsResult = await prisma.transaction.aggregate({
      where: {
        userId,
        status: 'completed',
        OR: [
          { type: { contains: 'شحن' } },
          { type: { contains: 'deposit' } },
          { type: { contains: 'PayPal' } },
          { type: { contains: 'إيداع' } }
        ]
      },
      _sum: {
        amount: true
      }
    });

    const totalDeposited = (totalDepositsResult._sum.amount || 0);
    // The qualifying threshold is the highest of: total lifetime deposits, current wallet balance, or the current deposit amount
    const qualifyingAmount = Math.max(
      totalDeposited,
      user.balance,
      depositAmount ? Number(depositAmount) : 0
    );

    // Fetch all membership tiers ordered by minDeposit DESC
    const tiers = await prisma.membershipTier.findMany({
      orderBy: { minDeposit: 'desc' }
    });

    if (!tiers || tiers.length === 0) return user;

    // Find the highest tier that matches the user's qualifying amount
    const eligibleTier = tiers.find(t => qualifyingAmount >= t.minDeposit);

    if (eligibleTier) {
      const currentTierDiscount = user.membershipTier?.discountPercentage || 0;
      const currentTierMinDeposit = user.membershipTier?.minDeposit || 0;

      // Upgrade if user has no tier, or eligible tier is higher in deposit or discount
      if (
        !user.membershipTierId ||
        eligibleTier.discountPercentage > currentTierDiscount ||
        eligibleTier.minDeposit > currentTierMinDeposit
      ) {
        const updated = await prisma.user.update({
          where: { id: userId },
          data: {
            membershipTierId: eligibleTier.id
          },
          include: {
            membershipTier: true
          }
        });
        console.log(`[Auto VIP Upgrade] User @${user.username} (${user.email}) successfully upgraded to ${eligibleTier.nameAr || eligibleTier.name} (Min: $${eligibleTier.minDeposit}, Discount: ${eligibleTier.discountPercentage}%)!`);
        return updated;
      }
    }

    return user;
  } catch (error) {
    console.error('Error in checkAndAutoUpgradeMembership:', error);
    return null;
  }
}
