import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import pool from '../models/db';
import { verifyToken } from '../middlewares/authMiddleware';
import { 
    addParticipantToConversation, 
    createDialog,
    createGroupChat,
    fetchAllConversationsByUserId, 
    fetchAllParticipantsByConversationId, 
    removeParticipantFromConversation,
    updateConversationName,
    markConversationReadUnread,
    muteConversation,
    leaveOrDeleteConversation,
    togglePinMessage,
    uploadGroupAvatar,
    deleteGroupAvatar
} from '../controllers/conversationController';

const router = Router();

// --- Multer Configuration for Group Avatars ---
// Ensure the uploads/group_avatars directory exists (though index.ts should handle it)
const groupAvatarUploadsDir = path.join(__dirname, '..', '..', 'uploads', 'group_avatars');
fs.mkdirSync(groupAvatarUploadsDir, { recursive: true });

const groupAvatarStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, groupAvatarUploadsDir);
    },
    filename: function (req: any, file, cb) {
        // Use conversation ID from params and a timestamp
        const conversationId = req.params.conversationId; 
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = path.extname(file.originalname);
        cb(null, `group-${conversationId}-${uniqueSuffix}${extension}`);
    }
});

const groupAvatarFileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Not an image! Please upload only images.') as any, false);
    }
};

const groupAvatarUpload = multer({
    storage: groupAvatarStorage,
    limits: { fileSize: 1024 * 1024 * 2 }, // 2MB limit for group avatars
    fileFilter: groupAvatarFileFilter
});
// ---

// Добавляем логгер для всех запросов к этому роутеру
router.use((req, res, next) => {
    console.log(`CONVERSATIONS ROUTER: Received ${req.method} request for ${req.originalUrl}`);
    next(); // Передаем управление следующему обработчику
});

router.get('/', verifyToken, fetchAllConversationsByUserId);
router.post('/dialog', verifyToken, createDialog);
router.post('/group', verifyToken, createGroupChat);
router.post('/participants/add', verifyToken, addParticipantToConversation);
router.delete('/participants/remove', verifyToken, removeParticipantFromConversation);
router.patch('/details', verifyToken, updateConversationName);
router.get('/participants', verifyToken, fetchAllParticipantsByConversationId);

router.post('/pin/toggle', verifyToken, togglePinMessage);
router.post('/read', verifyToken, markConversationReadUnread);
router.patch('/mute', verifyToken, muteConversation);
router.delete('/leave', verifyToken, leaveOrDeleteConversation);
router.delete('/delete', verifyToken, leaveOrDeleteConversation);

// --- Group Avatar Routes ---
router.post(
    '/:conversationId/avatar', 
    verifyToken, 
    groupAvatarUpload.single('avatar'), // Use multer middleware
    uploadGroupAvatar
);
router.delete(
    '/:conversationId/avatar', 
    verifyToken, 
    deleteGroupAvatar
);

export default router;
