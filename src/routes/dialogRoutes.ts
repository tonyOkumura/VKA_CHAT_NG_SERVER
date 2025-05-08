import { Router } from 'express';
import {
  fetchAllDialogsByUserId,
  createDialog,
  markDialogReadUnread,
  muteDialog,
  leaveDialog,
} from '../controllers/dialogController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// Логирование запросов
router.use((req, res, next) => {
  console.log(`DIALOG ROUTER: Received ${req.method} request for ${req.originalUrl}`);
  next();
});

router.get('/', authMiddleware, fetchAllDialogsByUserId);

router.post('/', authMiddleware, createDialog);

router.post('/read', authMiddleware, markDialogReadUnread);

router.patch('/mute', authMiddleware, muteDialog);

router.delete('/leave', authMiddleware, leaveDialog);

export default router;