"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPayPalAccessToken = getPayPalAccessToken;
exports.createPayPalOrder = createPayPalOrder;
exports.capturePayPalOrder = capturePayPalOrder;
const axios_1 = __importDefault(require("axios"));
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || 'BAA8Rt-IgLlxgkq8MZ8oiOOqDhFqy92HBS9sxJzeYASwt8YU9Lz7GXrMAiACDFotqS5LlCxBsRISofo6n8';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || 'EI7vlBchAPD196F0XJTUpI52QenvTcWY76Rfpxu7NVQVJ5q81FfL-I2xGy9fArnjb03P0AVtuY2865Qf';
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'live';
const BASE_URL = PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
// 1. Generate OAuth2 Access Token from PayPal
async function getPayPalAccessToken() {
    try {
        const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
        const response = await (0, axios_1.default)({
            url: `${BASE_URL}/v1/oauth2/token`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: `Basic ${auth}`
            },
            data: 'grant_type=client_credentials'
        });
        return response.data.access_token;
    }
    catch (error) {
        console.error('[PayPal Token Error]:', error?.response?.data || error?.message);
        throw new Error('فشل الحصول على رمز الوصول من PayPal');
    }
}
// 2. Create PayPal Order v2
async function createPayPalOrder(amountUSD, returnUrl, cancelUrl) {
    try {
        const accessToken = await getPayPalAccessToken();
        const formattedAmount = Number(amountUSD).toFixed(2);
        const response = await (0, axios_1.default)({
            url: `${BASE_URL}/v2/checkout/orders`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`
            },
            data: {
                intent: 'CAPTURE',
                purchase_units: [
                    {
                        amount: {
                            currency_code: 'USD',
                            value: formattedAmount
                        },
                        description: 'شحن محفظة - GSM Team Store'
                    }
                ],
                application_context: {
                    brand_name: 'GSM Team Store',
                    locale: 'ar-EG',
                    user_action: 'PAY_NOW',
                    return_url: returnUrl,
                    cancel_url: cancelUrl
                }
            }
        });
        const orderData = response.data;
        const approvalLink = orderData.links?.find((link) => link.rel === 'approve');
        return {
            orderId: orderData.id,
            approvalUrl: approvalLink ? approvalLink.href : null,
            raw: orderData
        };
    }
    catch (error) {
        console.error('[PayPal Create Order Error]:', error?.response?.data || error?.message);
        throw new Error('فشل إنشاء طلب الدفع عبر PayPal');
    }
}
// 3. Capture PayPal Order v2
async function capturePayPalOrder(orderId) {
    try {
        const accessToken = await getPayPalAccessToken();
        const response = await (0, axios_1.default)({
            url: `${BASE_URL}/v2/checkout/orders/${orderId}/capture`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`
            }
        });
        return response.data;
    }
    catch (error) {
        console.error('[PayPal Capture Order Error]:', error?.response?.data || error?.message);
        // If order was already captured or not found
        if (error?.response?.data?.name === 'UNPROCESSABLE_ENTITY') {
            return { status: 'ALREADY_CAPTURED', raw: error?.response?.data };
        }
        throw new Error('فشل تأكيد عملية الدفع من PayPal');
    }
}
