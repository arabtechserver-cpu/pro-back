import { Request, Response, NextFunction } from 'express';
import { ZodType } from 'zod';

export function validateBody(schema: ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.slice(0, 20).map(err => ({
        field: err.path.join('.'),
        message: err.message
      }));
      console.warn(`[Validation Error] ${req.method} ${req.originalUrl || req.path}:`, errors);
      return res.status(400).json({
        success: false,
        error: 'بيانات الطلب غير صالحة',
        details: errors
      });
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema: ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const errors = result.error.issues.slice(0, 20).map(err => ({
        field: err.path.join('.'),
        message: err.message
      }));
      return res.status(400).json({
        success: false,
        error: 'معاملات البحث غير صالحة',
        details: errors
      });
    }
    req.query = result.data as any;
    next();
  };
}
