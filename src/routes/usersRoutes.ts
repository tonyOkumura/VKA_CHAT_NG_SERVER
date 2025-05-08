import { Router } from "express";
import {
    getAllUsers,
    uploadUserAvatar,
    streamUserAvatar,
    deleteUserAvatar
} from "../controllers/userController";
import { verifyToken } from "../middlewares/authMiddleware";
import { uploadMiddleware } from "../services/fileService";

const router = Router();

// Новый маршрут для получения всех пользователей
router.get('/all', verifyToken, getAllUsers);

// Avatar routes for a specific user
router.post(
    '/:userId/avatar',
    verifyToken,
    uploadMiddleware.single('avatar'),
    uploadUserAvatar
);

router.get(
    '/:userId/avatar',
    streamUserAvatar
);

router.delete(
    '/:userId/avatar',
    verifyToken,
    deleteUserAvatar
);

// Сюда можно будет добавить другие роуты для пользователей в будущем
// Например, для получения информации о конкретном пользователе по ID

export default router; 