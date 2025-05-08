import { Router } from 'express';
import {
    getAllUsers,
    uploadUserAvatar,
    streamUserAvatar,
    deleteUserAvatar,
} from '../controllers/userController';
import { authMiddleware } from '../middlewares/authMiddleware';
import { uploadMiddleware } from '../services/fileService';

const router = Router();

// Маршрут для получения всех пользователей
router.get('/all', authMiddleware, getAllUsers);

// Маршруты для работы с аватарами пользователя
router.post(
    '/:userId/avatar',
    authMiddleware,
    uploadMiddleware.single('avatar'),
    uploadUserAvatar
);

router.get('/:userId/avatar', streamUserAvatar);

router.delete('/:userId/avatar', authMiddleware, deleteUserAvatar);

export default router;