import { Router } from "express";
import { getAllUsers } from "../controllers/userController"; // Исправляем импорт
import { verifyToken } from "../middlewares/authMiddleware";

const router = Router();

// Новый маршрут для получения всех пользователей
router.get('/all', verifyToken, getAllUsers); 

// Сюда можно будет добавить другие роуты для пользователей в будущем
// Например, для получения информации о конкретном пользователе по ID

export default router; 