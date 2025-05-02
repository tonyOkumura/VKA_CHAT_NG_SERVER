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
    deleteTaskAttachment,
    downloadTaskAttachment,
    getTaskLogs,
    generateTaskReport
} from '../controllers/taskController';

const router = Router();

// Middleware для проверки аутентификации будет применяться ко всем роутам задач
router.use(verifyToken);

// --- Задачи (Tasks) ---
router.post('/', createTask);
router.get('/', getTasks);
router.post('/get', getTaskById);
router.put('/update', updateTask);
router.delete('/delete', deleteTask);

// --- Комментарии к задачам (Comments) ---
router.post('/comments/add', addTaskComment);
router.post('/comments/get', getTaskComments);

// --- Вложения к задачам (Attachments) ---
router.post('/attachments/add', uploadTaskAttachment, addTaskAttachment);
router.post('/attachments/get', getTaskAttachments);
router.delete('/attachments/:attachmentId/delete', deleteTaskAttachment);
router.get('/attachments/:attachmentId/download', downloadTaskAttachment);

// --- Логи изменений задач (Logs) ---
router.post('/logs/get', getTaskLogs);

// --- Отчеты (Reports) ---
router.get('/report', generateTaskReport);

export default router; 