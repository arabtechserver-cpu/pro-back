import { z } from 'zod';

export const registerSchema = z.object({
  fullName: z.string().trim().min(2, 'الاسم يجب أن يحتوي على حرفين على الأقل').max(100),
  email: z.string().trim().toLowerCase().email('البريد الإلكتروني غير صالح').max(254),
  username: z.string().trim().toLowerCase().min(3, 'اسم المستخدم يجب ألا يقل عن 3 أحرف').max(50).regex(/^[a-zA-Z0-9_.-]+$/, 'اسم المستخدم يجب أن يحتوي على أحرف وأرقام ورموز مسموحة فقط'),
  password: z.string().min(8, 'كلمة المرور يجب ألا تقل عن 8 أحرف').max(128),
  phone: z.string().trim().max(30).optional().nullable(),
  country: z.string().trim().max(10).optional().default('EG')
});

export const loginSchema = z.object({
  email: z.string().trim().min(1, 'البريد الإلكتروني أو اسم المستخدم مطلوب').max(254),
  password: z.string().min(1, 'كلمة المرور مطلوبة').max(128),
  deviceToken: z.string().max(255).optional(),
  localIp: z.string().max(100).optional()
});

export const updateCredentialsSchema = z.object({
  currentPassword: z.string().min(1, 'كلمة المرور الحالية مطلوبة للتأكيد'),
  fullName: z.string().trim().min(2).max(100).optional(),
  username: z.string().trim().min(3).max(50).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  phone: z.string().trim().max(30).optional().nullable(),
  newPassword: z.string().min(8).max(128).optional()
});
