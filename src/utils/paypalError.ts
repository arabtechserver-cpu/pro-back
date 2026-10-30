export class PayPalGatewayError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = 'PayPalGatewayError';
  }
}
