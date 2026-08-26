"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const client_1 = require("@prisma/client");
exports.prisma = new client_1.PrismaClient();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5000;
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '200mb' }));
app.use(express_1.default.urlencoded({ limit: '200mb', extended: true }));
const path_1 = __importDefault(require("path"));
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
// Routes
const auth_1 = __importDefault(require("./routes/auth"));
const orders_1 = __importDefault(require("./routes/orders"));
const wallet_1 = __importDefault(require("./routes/wallet"));
const blog_1 = __importDefault(require("./routes/blog"));
const dhru_1 = __importDefault(require("./routes/dhru"));
const video_1 = __importDefault(require("./routes/video"));
const homepage_1 = __importDefault(require("./routes/homepage"));
const upload_1 = __importDefault(require("./routes/upload"));
const users_1 = __importDefault(require("./routes/users"));
const transactions_1 = __importDefault(require("./routes/transactions"));
const paypal_1 = __importDefault(require("./routes/paypal"));
app.use('/api/auth', auth_1.default);
app.use('/api/orders', orders_1.default);
app.use('/api/wallet/paypal', paypal_1.default);
app.use('/api/wallet', wallet_1.default);
app.use('/api/blog', blog_1.default);
app.use('/api/dhru', dhru_1.default);
app.use('/api/videos', video_1.default);
app.use('/api/homepage', homepage_1.default);
app.use('/api/upload', upload_1.default);
app.use('/api/users', users_1.default);
app.use('/api/transactions', transactions_1.default);
// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Backend is running' });
});
const orderSync_1 = require("./cron/orderSync");
app.listen(PORT, () => {
    console.log(`Backend server is running on http://localhost:${PORT}`);
    (0, orderSync_1.initOrderSyncCron)();
});
