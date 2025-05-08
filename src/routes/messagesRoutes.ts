import { Router } from 'express';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    fetchAllMessages,
    editMessage,
    deleteMessage,
    forwardMessages,
    uploadMessageFileAndCreateMessage,
    downloadMessageFile,
    getMessageFileInfo,
} from '../controllers/messagesController';
import { uploadMiddleware } from '../services/fileService';

const router = Router();

// Fetch messages for a dialog or group
router.post('/fetch', authMiddleware, fetchAllMessages);

// Forward messages to dialogs or groups
router.post('/forward', authMiddleware, forwardMessages);

// Edit a message
router.patch('/', authMiddleware, editMessage);

// Delete a message
router.delete('/', authMiddleware, deleteMessage);

// Upload a file and create a message
router.post('/files/upload', authMiddleware, uploadMiddleware.single('file'), uploadMessageFileAndCreateMessage);

// Download a message file
router.post('/files/download_body', authMiddleware, downloadMessageFile);

// Get message file info
router.post('/files/info', authMiddleware, getMessageFileInfo);

export default router;