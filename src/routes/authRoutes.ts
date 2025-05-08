import { Router } from 'express';
import { 
  register, 
  login, 
  logout,  
  resetPassword, 
  checkAuth,
  deleteAccount 
} from '../controllers/authController';
import { authMiddleware } from '../middlewares/authMiddleware'; // Предполагаемый middleware

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/logout', authMiddleware, logout); // Выход
router.put('/password/reset', resetPassword); // Сброс пароля
router.get('/auth/check', authMiddleware, checkAuth); // Проверка токена
router.delete('/account', authMiddleware, deleteAccount); // Удаление аккаунта

export default router;