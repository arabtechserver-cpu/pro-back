"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processBase64Images = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const processBase64Images = (htmlContent, baseUrl) => {
    if (!htmlContent)
        return '';
    return htmlContent.replace(/src="data:image\/(.*?);base64,([^"]+)"/g, (match, ext, data) => {
        try {
            const filename = `image_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
            const uploadDir = path_1.default.join(__dirname, '../../public/uploads');
            if (!fs_1.default.existsSync(uploadDir)) {
                fs_1.default.mkdirSync(uploadDir, { recursive: true });
            }
            const filepath = path_1.default.join(uploadDir, filename);
            fs_1.default.writeFileSync(filepath, Buffer.from(data, 'base64'));
            return `src="${baseUrl}/uploads/${filename}"`;
        }
        catch (error) {
            console.error("Failed to process base64 image", error);
            // Fallback to original match if something goes wrong
            return match;
        }
    });
};
exports.processBase64Images = processBase64Images;
