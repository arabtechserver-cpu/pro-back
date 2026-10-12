import { z } from 'zod';

export const createOrderSchema = z.object({
  serviceId: z.union([z.string(), z.number()]).transform(v => String(v).trim()),
  serviceName: z.string().min(1, 'اسم الخدمة مطلوب').max(255),
  targetInput: z.string().max(10000).nullable().optional(),
  rawImei: z.string().max(10000).nullable().optional(),
  quantity: z.union([z.number(), z.string()])
    .nullable()
    .optional()
    .transform(val => {
      if (val === undefined || val === null || val === '') return 1;
      const num = parseInt(String(val), 10);
      return isNaN(num) || num < 1 ? 1 : num;
    }),
  notes: z.string().max(2000).nullable().optional(),
  couponCode: z.string().max(50).nullable().optional(),
  customFields: z.union([z.record(z.any()), z.string()])
    .nullable()
    .optional()
    .transform(val => {
      if (!val) return null;
      if (typeof val === 'string') {
        try {
          const parsed = JSON.parse(val);
          return typeof parsed === 'object' && parsed !== null ? parsed : null;
        } catch {
          return null;
        }
      }
      return val;
    })
}).passthrough();
