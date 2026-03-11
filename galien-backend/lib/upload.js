const multer = require('multer');
const sharp = require('sharp');
const { v2: cloudinary } = require('cloudinary');
const fs = require('fs');
const path = require('path');

const isServerlessRuntime = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const uploadsDir = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : ((process.env.RENDER || isServerlessRuntime)
        ? path.join('/tmp', 'galien-uploads')
        : path.join(__dirname, '..', 'uploads'));

const hasCloudinary = Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

if (hasCloudinary) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
}

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype || !file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed'));
        }
        cb(null, true);
    }
});

async function processProfilePhotoBuffer(inputBuffer) {
    return sharp(inputBuffer)
        .rotate()
        .resize(320, 320, { fit: 'cover' })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
}

async function saveProfilePhoto(buffer, userId) {
    const processed = await processProfilePhotoBuffer(buffer);

    if (hasCloudinary) {
        const folder = process.env.CLOUDINARY_FOLDER || 'galien/profile';
        const uploadResult = await cloudinary.uploader.upload(
            `data:image/jpeg;base64,${processed.toString('base64')}`,
            {
                folder,
                public_id: `u${userId}_${Date.now()}`,
                resource_type: 'image',
                overwrite: false
            }
        );
        return uploadResult.secure_url || uploadResult.url;
    }

    const fileName = `u${userId}_${Date.now()}.jpg`;
    const outPath = path.join(uploadsDir, fileName);
    fs.writeFileSync(outPath, processed);
    return `/uploads/${fileName}`;
}

function sanitizeProfilePhotoForResponse(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value;
    if (!value.startsWith('/uploads/')) return value;

    // If Cloudinary is enabled, legacy local upload paths are considered stale.
    if (hasCloudinary) return null;

    const relative = value.replace(/^\/+uploads\/+/, '');
    const fullPath = path.join(uploadsDir, relative);
    return fs.existsSync(fullPath) ? value : null;
}

module.exports = {
    upload,
    uploadsDir,
    processProfilePhotoBuffer,
    saveProfilePhoto,
    sanitizeProfilePhotoForResponse
};
