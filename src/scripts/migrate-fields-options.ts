/**
 * migrate-fields-options.ts
 * يقرأ البيانات من backup JSON ويُحدّث requiresCustom
 * في Prisma للخدمات التي لديها حقول select بـ options
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const BACKUP_PATH = path.join(__dirname, '../../../../full-database-2026-08-23T22-51-59-524Z.json');

interface BackupField {
  id: string;
  name: string;
  api_name: string;
  field_id: string;
  label: string;
  placeholder: string;
  type: string;
  options: string[];
  required: boolean;
  regexpr: string;
  adminonly: boolean;
}

async function migrateFieldsOptions() {
  console.log('🔄 بدء تحديث حقول الـ options في قاعدة البيانات...\n');

  // قراءة الـ backup
  if (!fs.existsSync(BACKUP_PATH)) {
    console.error('❌ ملف الـ backup غير موجود:', BACKUP_PATH);
    process.exit(1);
  }

  const raw = fs.readFileSync(BACKUP_PATH, 'utf-8');
  const backup = JSON.parse(raw);
  const services: any[] = backup.tables?.services || [];

  console.log(`📦 إجمالي الخدمات في الـ backup: ${services.length}`);

  // فلتر الخدمات التي لديها select fields مع options
  const servicesWithSelectOptions = services.filter(svc => {
    if (!svc.fields || svc.fields === '[]' || svc.fields === '') return false;
    try {
      const fields: BackupField[] = JSON.parse(svc.fields);
      return fields.some(f => f.type === 'select' && f.options?.length > 0);
    } catch { return false; }
  });

  console.log(`🎯 خدمات لديها select+options: ${servicesWithSelectOptions.length}`);
  for (const s of servicesWithSelectOptions) {
    const fields: BackupField[] = JSON.parse(s.fields);
    const selectFields = fields.filter(f => f.type === 'select' && f.options?.length > 0);
    console.log(`   - ${s.name}:`);
    for (const f of selectFields) {
      console.log(`     ${f.label}: [${f.options.join(', ')}]`);
    }
  }
  console.log('');

  let updatedCount = 0;
  let notFoundCount = 0;

  for (const backupSvc of servicesWithSelectOptions) {
    let fields: BackupField[] = [];
    try { fields = JSON.parse(backupSvc.fields); } catch { continue; }

    // ابحث عن الخدمة في Prisma بالاسم
    const candidates = await prisma.dhruService.findMany({
      where: {
        OR: [
          { name: { contains: backupSvc.name } },
          { originalName: { contains: backupSvc.name } },
        ]
      }
    });

    if (candidates.length === 0) {
      // جرب بجزء من الاسم
      const shortName = backupSvc.name.split(' ').slice(0, 2).join(' ');
      const fallback = await prisma.dhruService.findMany({
        where: { name: { contains: shortName } }
      });
      
      if (fallback.length === 0) {
        console.log(`⚠️  لم يُوجد في Prisma: "${backupSvc.name}"`);
        notFoundCount++;
        continue;
      }
      candidates.push(...fallback);
    }

    // بناء requiresCustom الجديد بالـ format القديم + options من الـ backup
    for (const service of candidates) {
      // parse الـ requiresCustom الحالي أو ابدأ بـ {}
      let currentCustom: Record<string, any> = {};
      if (service.requiresCustom) {
        try { currentCustom = JSON.parse(service.requiresCustom); } catch {}
      }

      // تحديث أو إضافة الحقول من الـ backup
      for (const field of fields) {
        if (field.adminonly) continue;
        const key = field.api_name || field.field_id || field.label;
        
        // إذا كان الحقل select بـ options — حدّث fieldoptions
        if (field.type === 'select' && field.options?.length > 0) {
          currentCustom[key] = {
            reqid: field.field_id || key,
            fieldname: field.name || `custom_${key}`,
            fieldtype: 'select',
            required: field.required ? '1' : '0',
            description: '',
            fieldoptions: field.options.join('\n'),   // الـ format المتوقع: options مفصولة بـ \n
            label: field.label || key,
          };
          console.log(`   ✅ تحديث "${key}" → options: [${field.options.join(', ')}]`);
        } else if (!currentCustom[key]) {
          // أضف حقل text لو مش موجود
          currentCustom[key] = {
            reqid: field.field_id || key,
            fieldname: field.name || `custom_${key}`,
            fieldtype: field.type || 'text',
            required: field.required ? '1' : '0',
            description: '',
            fieldoptions: '',
            label: field.label || key,
          };
        }
      }

      // احفظ في Prisma
      await prisma.dhruService.update({
        where: { id: service.id },
        data: { requiresCustom: JSON.stringify(currentCustom) }
      });

      console.log(`✅ تم تحديث: "${service.name}" (${service.id.slice(-6)})`);
      updatedCount++;
    }
  }

  console.log(`\n🎉 انتهى! تم تحديث ${updatedCount} خدمة, لم يُوجد ${notFoundCount} خدمة.`);
  await prisma.$disconnect();
}

migrateFieldsOptions().catch(e => {
  console.error('❌ خطأ:', e);
  process.exit(1);
});
