import { Router, Request, Response } from 'express';
import pool from '../models/db';
import { verifyToken } from '../middlewares/authMiddleware';
import { addParticipantToConversation, checkOrCreateConversation, fetchAllConversationsByUserId, fetchAllParticipantsByConversationId } from '../controllers/conversationController';

const router = Router();

router.get('/', verifyToken, fetchAllConversationsByUserId);
router.post('/check-or-create', verifyToken, checkOrCreateConversation);
router.post('/add-participant', verifyToken, addParticipantToConversation );
router.get('/participants', verifyToken, fetchAllParticipantsByConversationId );


export default router;
