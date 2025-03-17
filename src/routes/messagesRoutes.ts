import { Router } from 'express';
import { verifyToken } from '../middlewares/authMiddleware';
import { fetchAllMessagesByConversationId, saveMessage } from '../controllers/messagesController';

const router = Router();

router.get('/:conversationId', verifyToken, fetchAllMessagesByConversationId);
// router.post('/', verifyToken, saveMessage);

export default router;
