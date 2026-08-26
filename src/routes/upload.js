"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const router = (0, express_1.Router)();
const UPLOAD_DIR = path_1.default.join(__dirname, '../../public/uploads');
function ensureUploadDirExists() {
    if (!fs_1.default.existsSync(UPLOAD_DIR)) {
        fs_1.default.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
}
router.post('/', (req, res) => {
    try {
        const { image, filename } = req.body;
        if (!image) {
            return res.status(400).json({ error: 'لم يتم توفير صورة للرفع' });
        }
        ensureUploadDirExists();
        // Remove Base64 prefix e.g., "data:image/png;base64,"
        const matches = image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        let base64Data = image;
        let ext = 'png';
        if (matches && matches.length === 3) {
            ext = matches[1].split('/')[1] || 'png';
            base64Data = matches[2];
        }
        const cleanFilename = (filename || 'uploaded_image').replace(/[^a-zA-Z0-9_.-]/g, '_');
        const uniqueFilename = `${Date.now()}_${cleanFilename}`;
        const filePath = path_1.default.join(UPLOAD_DIR, uniqueFilename);
        const buffer = Buffer.from(base64Data, 'base64');
        fs_1.default.writeFileSync(filePath, buffer);
        const imageUrl = `https://api.arabtechproserver.tech/uploads/${uniqueFilename}`;
        return res.json({ success: true, url: imageUrl, filename: uniqueFilename });
    }
    catch (error) {
        console.error('Error uploading image:', error);
        return res.status(500).json({ error: 'فشل رفع الصورة على السيرفر' });
    }
});
exports.default = router;
