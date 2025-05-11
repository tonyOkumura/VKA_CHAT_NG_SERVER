import { Router } from "express";
import { getAllUsers, getUserProfile, getCurrentUserProfile } from "../controllers/userController"; // Исправляем импорт
import { verifyToken } from "../middlewares/authMiddleware";

const router = Router();

// Новый маршрут для получения всех пользователей
router.get('/', verifyToken, getAllUsers);
router.get('/profile/:userId', verifyToken, getUserProfile);
router.get('/me', verifyToken, getCurrentUserProfile);

// Сюда можно будет добавить другие роуты для пользователей в будущем
// Например, для получения информации о конкретном пользователе по ID

export default router; 