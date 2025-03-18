import { Router, Request, Response } from 'express';
import pool from '../models/db';
import { verifyToken } from '../middlewares/authMiddleware';
import { checkOrCreateConversation, fetchAllConversationsByUserId } from '../controllers/conversationController';

const router = Router();

router.get('/', verifyToken, fetchAllConversationsByUserId);
router.post('/check-or-create', verifyToken, checkOrCreateConversation);


export default router;
