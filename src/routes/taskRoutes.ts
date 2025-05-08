import { Router } from 'express';
import { verifyToken } from '../middlewares/authMiddleware';
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
import { uploadMiddleware } from '../services/fileService';

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
router.post('/:taskId/attachments', uploadMiddleware.single('file'), addTaskAttachment);
router.get('/:taskId/attachments', getTaskAttachments);

// New GET routes for attachment info and download
router.get('/attachments/info/:attachmentId', getTaskAttachmentInfo);
router.get('/attachments/download_body/:attachmentId', downloadTaskAttachment);

// Kept POST route for delete as it modifies data and might be simpler with body params
router.post('/attachments/delete', deleteTaskAttachment);

// Логи изменений задач (Logs)
router.get('/:taskId/logs', getTaskLogs);

// Отчеты (Reports)
router.get('/report', generateTaskReport);

export default router;