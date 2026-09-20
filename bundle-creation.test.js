const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runTest() {
  console.log('--- STARTING BUNDLE & SERVICE CREATION TEST ---');
  let createdCategoryId = null;
  let createdServiceIds = [];
  let testOrderId = null;

  try {
    // Ensure Order table has required columns if needed
    await prisma.$executeRawUnsafe('ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "couponCode" TEXT;').catch(() => {});
    await prisma.$executeRawUnsafe('ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "discount" DOUBLE PRECISION DEFAULT 0.0;').catch(() => {});
    await prisma.$executeRawUnsafe('ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "source" TEXT DEFAULT \'web\';').catch(() => {});
    await prisma.$executeRawUnsafe('ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "apiClientOrderId" TEXT;').catch(() => {});

    // 1. Check or create test category
    const catName = 'قسم باقات الاختبار - Test Bundles Category';
    let category = await prisma.dhruCategory.findFirst({ where: { name: catName } });
    if (!category) {
      category = await prisma.dhruCategory.create({ data: { name: catName } });
      console.log('Created test category:', category.id);
    } else {
      console.log('Found existing test category:', category.id);
    }
    createdCategoryId = category.id;

    // 2. Define a test bundle with 2 services, each with custom fields
    const bundleName = 'باقة شحن وتفعيل الاختبار';
    const testServices = [
      {
        name: 'خدمة شحن فري فاير 1000 جوهرة',
        credit: 7.5,
        margin: 2.0,
        time: 'فوري (1-5 دقائق)',
        info: 'يرجى إدخال معرف اللاعب بدقة لتصلك الجواهر فوراً',
        isActive: true,
        fields: [
          {
            label: 'معرف اللاعب (Player ID)',
            fieldname: 'player_id',
            fieldtype: 'text',
            required: true
          },
          {
            label: 'سيرفر الحساب (Server)',
            fieldname: 'account_server',
            fieldtype: 'select',
            required: true,
            options: ['الشرق الأوسط (MENA)', 'أوروبا (EU)', 'أمريكا (NA)']
          }
        ]
      },
      {
        name: 'خدمة تفعيل وتخطي حساب شاومي',
        credit: 15.0,
        margin: 4.5,
        time: '1-24 ساعة',
        info: 'تخطي حساب Mi Cloud برقم الكود',
        isActive: true,
        fields: [
          {
            label: 'رمز القفل (Lock Code)',
            fieldname: 'lock_code',
            fieldtype: 'text',
            required: true
          },
          {
            label: 'رابط صورة القفل (Lock Screen Link)',
            fieldname: 'proof_link',
            fieldtype: 'text',
            required: false
          }
        ]
      }
    ];

    // 3. Save services to DB
    for (let i = 0; i < testServices.length; i++) {
      const s = testServices[i];
      const uniqueDhruId = `pkg_test_${Date.now()}_${i}`;
      
      const fieldsObj = {};
      s.fields.forEach((f) => {
        fieldsObj[f.fieldname] = {
          label: f.label,
          fieldname: f.fieldname,
          fieldtype: f.fieldtype,
          required: f.required,
          options: f.options || []
        };
      });

      const svc = await prisma.dhruService.create({
        data: {
          dhruId: uniqueDhruId,
          name: s.name,
          originalName: s.name,
          groupName: bundleName,
          credit: s.credit,
          margin: s.margin,
          time: s.time,
          info: s.info,
          isActive: s.isActive,
          categoryId: category.id,
          requiresCustom: JSON.stringify(fieldsObj)
        }
      });

      createdServiceIds.push(svc.id);
      console.log(`Saved service ${i + 1}:`, svc.id, svc.name, 'Price:', svc.credit + svc.margin);
    }

    // 4. Verify in DB
    const savedServices = await prisma.dhruService.findMany({
      where: { id: { in: createdServiceIds } },
      include: { dhruCategory: true }
    });

    if (savedServices.length !== 2) {
      throw new Error(`Expected 2 services saved, found ${savedServices.length}`);
    }
    console.log('SUCCESS: Both services verified in database.');

    // 5. Verify custom fields parsing
    for (const svc of savedServices) {
      const parsed = JSON.parse(svc.requiresCustom);
      console.log(`Service "${svc.name}" custom fields keys:`, Object.keys(parsed));
      if (Object.keys(parsed).length === 0) {
        throw new Error('Custom fields were not saved properly!');
      }
    }

    // 6. Test order placement with custom fields for this service
    const targetService = savedServices[0];
    const testUser = await prisma.user.findFirst();
    if (testUser) {
      const orderCustomFields = {
        player_id: '1234567890',
        account_server: 'الشرق الأوسط (MENA)'
      };

      const testOrder = await prisma.order.create({
        data: {
          userId: testUser.id,
          serviceId: targetService.id,
          serviceName: targetService.name,
          targetInput: '1234567890',
          price: targetService.credit + targetService.margin,
          status: 'pending',
          notes: JSON.stringify({
            customFields: orderCustomFields,
            userNote: 'طلب تجريبي لاختبار حفظ الباقة والحقول',
            events: []
          })
        }
      });
      testOrderId = testOrder.id;
      console.log('SUCCESS: Test order created in database with custom fields:', testOrder.id);

      // Verify reading back order notes and fields
      const readOrder = await prisma.order.findUnique({ where: { id: testOrderId } });
      const readNotes = JSON.parse(readOrder.notes);
      if (readNotes.customFields.player_id !== '1234567890') {
        throw new Error('Order custom fields mismatch');
      }
      console.log('SUCCESS: Order custom fields verified:', readNotes.customFields);

      // 7. Verify serialization for client pricing and admin views
      const { serializePricingServiceCategories, serializeAdminServiceCategories } = require('./dist/utils/admin-service-response.js');
      const { buildOrderFieldDetails } = require('./dist/utils/order-response.js');

      const mockCat = [{
        id: category.id,
        name: category.name,
        dhruServices: savedServices
      }];

      const pricingCats = serializePricingServiceCategories(mockCat, (n) => n);
      console.log('Verified pricing serialized count:', pricingCats[0].services.length);
      if (pricingCats[0].services[0].groupName !== bundleName) {
        throw new Error('Pricing groupName does not match bundleName');
      }

      const adminCats = serializeAdminServiceCategories(mockCat, (n) => n);
      console.log('Verified admin serialized count:', adminCats[0].services.length);
      if (adminCats[0].services[0].requiresCustom === null) {
        throw new Error('Admin requiresCustom was not serialized');
      }

      // 8. Verify order field details
      const fieldDetails = buildOrderFieldDetails(targetService.requiresCustom, orderCustomFields);
      console.log('Verified fieldDetails length:', fieldDetails.length);
      if (fieldDetails.length < 2) {
        throw new Error('Expected at least 2 field details');
      }
      const pIdField = fieldDetails.find(f => f.id === 'player_id');
      if (!pIdField || pIdField.value !== '1234567890') {
        throw new Error('Field player_id not found in fieldDetails');
      }
      console.log('SUCCESS: Field details verified for admin order inspector:', pIdField);
    }

    console.log('--- ALL BUNDLE TESTS PASSED SUCCESSFULLY ---');
  } catch (error) {
    console.error('Test failed with error:', error);
    process.exitCode = 1;
  } finally {
    // Clean up test data
    console.log('Cleaning up test data...');
    if (testOrderId) {
      await prisma.order.delete({ where: { id: testOrderId } }).catch(() => {});
    }
    if (createdServiceIds.length > 0) {
      await prisma.dhruService.deleteMany({ where: { id: { in: createdServiceIds } } }).catch(() => {});
    }
    if (createdCategoryId) {
      await prisma.dhruCategory.delete({ where: { id: createdCategoryId } }).catch(() => {});
    }
    await prisma.$disconnect();
    console.log('Cleanup completed.');
  }
}

runTest();
