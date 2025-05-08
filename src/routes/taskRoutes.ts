import { Router } from 'express';
import { authMiddleware } from '../middlewares/authMiddleware';
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
    getTaskLogs,
} from '../controllers/taskController';
import { uploadMiddleware } from '../services/fileService';

const router = Router();

router.use(authMiddleware);

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
router.post('/:taskId/attachments', uploadMiddleware.single('file'), addTaskAttachment);
router.get('/:taskId/attachments', getTaskAttachments);
router.get('/:taskId/attachments/info/:attachmentId', getTaskAttachmentInfo);
router.get('/:taskId/attachments/download/:attachmentId', downloadTaskAttachment);
router.delete('/:taskId/attachments/:attachmentId', deleteTaskAttachment);

// Логи изменений задач (Logs)
router.get('/:taskId/logs', getTaskLogs);

// Отчеты (Reports)
router.get('/report', generateTaskReport);

export default router;