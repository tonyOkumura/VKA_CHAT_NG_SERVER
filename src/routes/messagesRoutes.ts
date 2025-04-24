import { Router } from 'express';
import { verifyToken } from '../middlewares/authMiddleware';
import {
    fetchAllMessagesByConversationId,
    editMessage,
    deleteMessage
} from '../controllers/messagesController';

const router = Router();

router.get('/:conversation_id', verifyToken, fetchAllMessagesByConversationId);

router.patch('/', verifyToken, editMessage);

router.delete('/', verifyToken, deleteMessage);

export default router;
