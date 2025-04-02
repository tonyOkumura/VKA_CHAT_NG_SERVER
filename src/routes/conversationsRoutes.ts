import { Router, Request, Response } from 'express';
import pool from '../models/db';
import { verifyToken } from '../middlewares/authMiddleware';
import { 
    addParticipantToConversation, 
    createDialog,
    createGroupChat,
    fetchAllConversationsByUserId, 
    fetchAllParticipantsByConversationId 
} from '../controllers/conversationController';

const router = Router();

router.get('/', verifyToken, fetchAllConversationsByUserId);
router.post('/dialog', verifyToken, createDialog);
router.post('/group', verifyToken, createGroupChat);
router.post('/add-participant', verifyToken, addParticipantToConversation);
router.get('/participants', verifyToken, fetchAllParticipantsByConversationId);

export default router;
