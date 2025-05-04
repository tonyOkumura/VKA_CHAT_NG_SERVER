import { Router } from "express";
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { uploadAvatar, getAvatar, deleteAvatar, streamAvatar } from "../controllers/avatarController";
import { verifyToken } from "../middlewares/authMiddleware";

const router = Router();

// --- Multer Configuration ---
// Ensure the uploads/avatars directory exists
const avatarUploadsDir = path.join(__dirname, '..', '..', 'uploads', 'avatars');
if (!fs.existsSync(avatarUploadsDir)) {
    fs.mkdirSync(avatarUploadsDir, { recursive: true });
    console.log('Папка uploads/avatars создана');
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, avatarUploadsDir); // Use the absolute path
    },
    filename: function (req: any, file, cb) {
        // Use user ID from token and a timestamp to ensure uniqueness
        const userId = req.user.id; // Assumes verifyToken adds user to req
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = path.extname(file.originalname);
        cb(null, `avatar-${userId}-${uniqueSuffix}${extension}`);
    }
});

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Not an image! Please upload only images.') as any, false); // Correct way to pass error
    }
};

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 1024 * 1024 * 50 // 5MB limit
    },
    fileFilter: fileFilter
});

// --- Routes ---

// POST /api/avatars/upload - Upload/Update avatar for the logged-in user
// Uses verifyToken to get user ID, upload.single('avatar') to handle the file
router.post('/upload', verifyToken, upload.single('avatar'), uploadAvatar);

// GET /api/avatars/:userId - Get avatar URL/info for a specific user
router.get('/:userId', getAvatar); // No token needed? Or should it be protected?
// Decided to leave it public for now, can add verifyToken if needed

// --- NEW --- GET /api/avatars/stream/:userId - Get avatar image bytes
router.get('/stream/:userId', streamAvatar); // Returns image file directly

// DELETE /api/avatars/delete - Delete avatar for the logged-in user
router.delete('/delete', verifyToken, deleteAvatar);

// Note: Updating an avatar is handled by the POST /upload route (it replaces the old one).

export default router; 