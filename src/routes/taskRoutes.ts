import { Router } from 'express';
import { verifyToken } from '../middlewares/authMiddleware';
import uploadTaskAttachment from '../middlewares/uploadMiddleware';
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
    getTaskAttachmentInfo,
    generateTaskReport,
    getTaskLogs
} from '../controllers/taskController';

const router = Router();

router.use(verifyToken);

// Задачи (Tasks)
router.post('/', createTask);
router.get('/', getTasks);
router.get('/:taskId', getTaskById);
router.put('/:taskId', updateTask);
router.delete('/:taskId', deleteTask);

// Комментарии к задачам (Comments)
router.post('/:taskId/comments', addTaskComment);
router.get('/:taskId/comments', getTaskComments);

// Вложения к задачам (Attachments)
router.post('/:taskId/attachments', uploadTaskAttachment, addTaskAttachment);
router.get('/:taskId/attachments', getTaskAttachments);
router.post('/attachments/info', getTaskAttachmentInfo); // Новый маршрут
router.post('/attachments/download', downloadTaskAttachment); // Новый маршрут
router.post('/attachments/delete', deleteTaskAttachment); // Новый маршрут

// Логи изменений задач (Logs)
router.get('/:taskId/logs', getTaskLogs);

// Отчеты (Reports)
router.get('/report', generateTaskReport);

export default router;