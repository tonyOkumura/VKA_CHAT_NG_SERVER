import { Router } from 'express';
import {
  fetchAllGroupsByUserId,
  createGroup,
  addParticipantToGroup,
  removeParticipantFromGroup,
  updateGroupName,
  fetchAllParticipantsByGroupId,
  markGroupReadUnread,
  muteGroup,
  leaveGroup,
} from '../controllers/groupController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// Логирование запросов
router.use((req, res, next) => {
  console.log(`GROUP ROUTER: Received ${req.method} request for ${req.originalUrl}`);
  next();
});

router.get('/', authMiddleware, fetchAllGroupsByUserId);

router.post('/', authMiddleware, createGroup);

router.post('/participants/add', authMiddleware, addParticipantToGroup);

router.delete('/participants/remove', authMiddleware, removeParticipantFromGroup);

router.patch('/details', authMiddleware, updateGroupName);

router.get('/participants', authMiddleware, fetchAllParticipantsByGroupId);

router.post('/read', authMiddleware, markGroupReadUnread);

router.patch('/mute', authMiddleware, muteGroup);

router.delete('/leave', authMiddleware, leaveGroup);

export default router;