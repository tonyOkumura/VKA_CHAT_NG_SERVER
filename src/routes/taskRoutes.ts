import { Router } from 'express';
import { verifyToken } from '../middlewares/authMiddleware';
import uploadTaskAttachment from '../middlewares/uploadMiddleware'; // Импортируем middleware
// Импортируем контроллеры
import {
    createTask,
    getTasks,
    getTaskById,
    updateTask,
    deleteTask,
    addTaskComment,
    getTaskComments,
    addTaskAttachment,
    getTaskAttachments,
    getTaskLogs // Добавляем getTaskLogs
} from '../controllers/taskController';

const router = Router();

// Middleware для проверки аутентификации будет применяться ко всем роутам задач
router.use(verifyToken);

// --- Задачи ---
router.post('/', createTask);
router.get('/', getTasks);
router.get('/:id', getTaskById);
router.put('/:id', updateTask);
router.delete('/:id', deleteTask);

// --- Комментарии к задачам ---
router.post('/:id/comments', addTaskComment); // Роут для добавления комментария
router.get('/:id/comments', getTaskComments);  // Роут для получения комментариев

// --- Вложения к задачам ---
// Применяем middleware uploadTaskAttachment только к роуту POST /:id/attachments
router.post('/:id/attachments', uploadTaskAttachment, addTaskAttachment);
router.get('/:id/attachments', getTaskAttachments);

// --- Логи изменений задач ---
router.get('/:id/logs', getTaskLogs); // Роут для получения логов


export default router; 