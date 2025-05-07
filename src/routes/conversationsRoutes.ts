import { Router, Request, Response } from 'express';
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
    
} from '../controllers/conversationController';

const router = Router();



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

export default router;
