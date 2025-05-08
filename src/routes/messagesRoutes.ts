import { Router } from 'express';
import { verifyToken } from '../middlewares/authMiddleware';
import {
    fetchAllMessagesByConversationId,
    editMessage,
    deleteMessage,
    forwardMessages,
    uploadMessageFileAndCreateMessage,
    downloadMessageFile,
    getMessageFileInfo
} from '../controllers/messagesController';
import { uploadMiddleware } from '../services/fileService';

const router = Router();

router.get('/', verifyToken, fetchAllMessagesByConversationId);

router.post('/forward', verifyToken, forwardMessages);

router.patch('/', verifyToken, editMessage);

router.delete('/', verifyToken, deleteMessage);

router.post('/files/upload', verifyToken, uploadMiddleware.single('file'), uploadMessageFileAndCreateMessage);

router.post('/files/download_body', verifyToken, downloadMessageFile);

router.post('/files/info', verifyToken, getMessageFileInfo);

export default router;
